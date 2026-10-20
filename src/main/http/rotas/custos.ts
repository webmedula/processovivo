import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  CategoriaParaTela,
  EventoParaTela,
  ServicoCustos,
} from '../../../application/services/ServicoCustos.js';
import type { ServicoCustosPorCliente } from '../../../application/services/ServicoCustosPorCliente.js';
import type { ServicoAssinaturas } from '../../../application/services/ServicoAssinaturas.js';
import {
  GRUPOS_DE_CUSTO,
  codigoAtualDaCategoria,
  ehGrupoDeDeposito,
  grupoDeCusto,
} from '../../../domain/entities/CatalogoDeCustos.js';
import type {
  CategoriaDeCusto,
  Custo,
  SubtotalDaCategoria,
  TotaisDeCusto,
} from '../../../domain/entities/Custo.js';
import {
  LIMITE_CATEGORIAS_PROPRIAS,
  LIMITE_DESCRICAO,
  LIMITE_LANCAMENTOS_POR_PROCESSO,
  LIMITE_MOTIVO,
  LIMITE_NOME_DA_CATEGORIA,
  VALOR_MAXIMO_CENTAVOS,
  codigoDaCategoriaPropria,
} from '../../../domain/entities/Custo.js';
import {
  LIMITE_OBSERVACAO_DO_RECEBIMENTO,
  LIMITE_RECEBIMENTOS_POR_PROCESSO,
} from '../../../domain/entities/Recebimento.js';
import type { Recebimento } from '../../../domain/entities/Recebimento.js';
import {
  LIMITE_COMPROVANTES_POR_LANCAMENTO,
  TAMANHO_MAXIMO_DO_COMPROVANTE,
} from '../../../domain/entities/Comprovante.js';
import type { Comprovante } from '../../../domain/entities/Comprovante.js';
import type {
  FiltroPorCliente,
  ClienteResumido,
  DetalheDoCliente,
  ProcessoDoCliente,
} from '../../../application/services/ServicoCustosPorCliente.js';
import {
  CustoInvalidoError,
  OperacaoNaoSuportadaError,
  WorkspaceNaoResolvidoError,
} from '../../../domain/errors/index.js';

/** Escritas por minuto, por conta/chave. Folgado para uso humano; barra script em laço. */
export const LIMITE_ESCRITAS_DE_CUSTOS_POR_MINUTO = 90;
/** O PDF custa CPU e memória: poucas por minuto bastam para quem envia ao cliente. */
export const LIMITE_PRESTACOES_POR_MINUTO = 10;
/** Uploads de comprovante por minuto, por conta/chave: cada um é um arquivo de até 5 MB indo ao Google. */
export const LIMITE_COMPROVANTES_POR_MINUTO = 20;
/** Exportações em CSV por minuto. */
export const LIMITE_EXPORTACOES_POR_MINUTO = 20;

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

const dataLocal = z.string().max(10);
const pagoPor = z.enum(['escritorio', 'cliente']);
const motivo = z.string().max(2000);

const corpoCriar = z
  .object({
    data: dataLocal,
    descricao: z.string().max(2000),
    categoria: z.string().min(1).max(80),
    valorCentavos: z.number().finite(),
    reembolsavel: z.boolean().default(false),
    pagoPor: pagoPor.default('escritorio'),
  })
  .strict();

const corpoAlterar = z
  .object({
    data: dataLocal.optional(),
    descricao: z.string().max(2000).optional(),
    categoria: z.string().min(1).max(80).optional(),
    valorCentavos: z.number().finite().optional(),
    reembolsavel: z.boolean().optional(),
    pagoPor: pagoPor.optional(),
  })
  .strict();

const corpoRecebimento = z
  .object({
    data: dataLocal,
    valorCentavos: z.number().finite(),
    observacao: z.string().max(2000).optional(),
  })
  .strict();

const corpoAlterarRecebimento = z
  .object({
    data: dataLocal.optional(),
    valorCentavos: z.number().finite().optional(),
    observacao: z.string().max(2000).nullable().optional(),
  })
  .strict();

const corpoCancelar = z.object({ motivo: motivo.optional() }).strict();
const corpoCategoria = z
  .object({ nome: z.string().max(400), grupo: z.string().max(8).optional() })
  .strict();
const corpoAlterarCategoria = z
  .object({ arquivada: z.boolean().optional(), grupo: z.string().max(8).optional() })
  .strict()
  .refine((c) => c.arquivada !== undefined || c.grupo !== undefined, {
    message: 'Informe o que mudar.',
  });

const consultaLista = z
  .object({ cancelados: z.enum(['true', 'false']).optional() })
  .strict();

const consultaCsv = z
  .object({
    de: dataLocal.optional(),
    ate: dataLocal.optional(),
    cliente: z.string().max(300).optional(),
    incluirCancelados: z.enum(['true', 'false']).optional(),
  })
  .strict();

const consultaClientes = z
  .object({
    de: dataLocal.optional(),
    ate: dataLocal.optional(),
    cliente: z.string().max(300).optional(),
    somenteComSaldo: z.enum(['true', 'false']).optional(),
  })
  .strict();

const consultaPrestacao = z
  .object({
    de: dataLocal.optional(),
    ate: dataLocal.optional(),
    somenteACobrar: z.enum(['true', 'false']).optional(),
  })
  .strict();

/**
 * Centro de custos do processo (v0.47.0).
 *
 * Todas as rotas exigem o recurso `custosDoProcesso` do plano (mesma regra das demais: 402 com a
 * assinatura vencida além da carência, 403 com o plano sem o recurso, e passagem livre para o
 * workspace sem assinatura — a conta de chave de API) e passam o `workspace` ao serviço, que o
 * repassa a toda consulta: lançamento de outra conta é 404, igual a "não existe".
 *
 * Sem `try/catch`: o `errorHandler` traduz os erros de domínio. Nada de valor, descrição ou nome
 * de categoria vai a log — nem aqui, nem no log de acesso (que guarda só o caminho).
 */
export function rotasDeCustos(
  servico: ServicoCustos | undefined,
  assinaturas: ServicoAssinaturas | undefined,
  porCliente?: ServicoCustosPorCliente,
): FastifyPluginAsync {
  return async (servidor) => {
    async function preparar(
      req: FastifyRequest,
    ): Promise<{ ws: string; custos: ServicoCustos }> {
      const ws = workspaceDe(req);
      await assinaturas?.exigir(ws, 'custosDoProcesso');
      if (!servico) {
        throw new OperacaoNaoSuportadaError(
          'custosDoProcesso',
          'custos',
          'o centro de custos não está montado',
        );
      }
      return { ws, custos: servico };
    }

    const escrita = {
      config: {
        rateLimit: { max: LIMITE_ESCRITAS_DE_CUSTOS_POR_MINUTO, timeWindow: 60_000 },
      },
    };

    servidor.get<{ Params: { numero: string } }>(
      '/v1/processos/:numero/custos',
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const q = consultaLista.parse(req.query ?? {});
        const r = await custos.listar(ws, req.params.numero, q.cancelados === 'true');
        const grupoDe = new Map(r.categorias.map((c) => [c.codigo, c]));
        void resposta.header('Cache-Control', 'no-store');
        return {
          numeroProcesso: r.numeroProcesso,
          lancamentos: r.lancamentos.map((c) =>
            paraJson(c, grupoDe, r.comprovantes.get(c.id)),
          ),
          recebimentos: r.recebimentos.map(recebimentoParaJson),
          canceladosEscondidos: r.canceladosEscondidos,
          totais: totaisParaJson(r.totais, r.categorias),
          categorias: r.categorias,
          grupos: GRUPOS_DE_CUSTO,
          limites: limites(),
        };
      },
    );

    servidor.get<{ Params: { numero: string } }>(
      '/v1/processos/:numero/custos/totais',
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const r = await custos.listar(ws, req.params.numero);
        void resposta.header('Cache-Control', 'no-store');
        return totaisParaJson(r.totais, r.categorias);
      },
    );

    servidor.post<{ Params: { numero: string } }>(
      '/v1/processos/:numero/custos',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const c = corpoCriar.parse(req.body ?? {});
        const custo = await custos.criar(ws, req.params.numero, c);
        void resposta.header('Cache-Control', 'no-store');
        return resposta.code(201).send(paraJson(custo));
      },
    );

    servidor.patch<{ Params: { id: string } }>(
      '/v1/custos/:id',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const c = corpoAlterar.parse(req.body ?? {});
        const custo = await custos.alterar(ws, req.params.id, {
          ...(c.data !== undefined ? { data: c.data } : {}),
          ...(c.descricao !== undefined ? { descricao: c.descricao } : {}),
          ...(c.categoria !== undefined ? { categoria: c.categoria } : {}),
          ...(c.valorCentavos !== undefined ? { valorCentavos: c.valorCentavos } : {}),
          ...(c.reembolsavel !== undefined ? { reembolsavel: c.reembolsavel } : {}),
          ...(c.pagoPor !== undefined ? { pagoPor: c.pagoPor } : {}),
        });
        void resposta.header('Cache-Control', 'no-store');
        return paraJson(custo);
      },
    );

    // Não há DELETE de lançamento: cancelar guarda o registro (fora dos totais) e reativar o devolve.
    servidor.post<{ Params: { id: string } }>(
      '/v1/custos/:id/cancelamento',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const c = corpoCancelar.parse(req.body ?? {});
        void resposta.header('Cache-Control', 'no-store');
        return paraJson(await custos.cancelar(ws, req.params.id, c.motivo));
      },
    );

    servidor.delete<{ Params: { id: string } }>(
      '/v1/custos/:id/cancelamento',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        void resposta.header('Cache-Control', 'no-store');
        return paraJson(await custos.reativar(ws, req.params.id));
      },
    );

    servidor.get<{ Params: { id: string } }>(
      '/v1/custos/:id/historico',
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        void resposta.header('Cache-Control', 'no-store');
        return {
          eventos: (await custos.historico(ws, 'lancamento', req.params.id)).map(
            eventoParaJson,
          ),
        };
      },
    );

    servidor.post<{ Params: { numero: string } }>(
      '/v1/processos/:numero/recebimentos',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const c = corpoRecebimento.parse(req.body ?? {});
        const r = await custos.registrarRecebimento(ws, req.params.numero, c);
        void resposta.header('Cache-Control', 'no-store');
        return resposta.code(201).send(recebimentoParaJson(r));
      },
    );

    servidor.patch<{ Params: { id: string } }>(
      '/v1/recebimentos/:id',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const c = corpoAlterarRecebimento.parse(req.body ?? {});
        void resposta.header('Cache-Control', 'no-store');
        return recebimentoParaJson(
          await custos.alterarRecebimento(ws, req.params.id, {
            ...(c.data !== undefined ? { data: c.data } : {}),
            ...(c.valorCentavos !== undefined ? { valorCentavos: c.valorCentavos } : {}),
            ...(c.observacao !== undefined ? { observacao: c.observacao } : {}),
          }),
        );
      },
    );

    servidor.post<{ Params: { id: string } }>(
      '/v1/recebimentos/:id/cancelamento',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const c = corpoCancelar.parse(req.body ?? {});
        void resposta.header('Cache-Control', 'no-store');
        return recebimentoParaJson(
          await custos.cancelarRecebimento(ws, req.params.id, c.motivo),
        );
      },
    );

    servidor.delete<{ Params: { id: string } }>(
      '/v1/recebimentos/:id/cancelamento',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        void resposta.header('Cache-Control', 'no-store');
        return recebimentoParaJson(await custos.reativarRecebimento(ws, req.params.id));
      },
    );

    servidor.get<{ Params: { id: string } }>(
      '/v1/recebimentos/:id/historico',
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        void resposta.header('Cache-Control', 'no-store');
        return {
          eventos: (await custos.historico(ws, 'recebimento', req.params.id)).map(
            eventoParaJson,
          ),
        };
      },
    );

    servidor.get('/v1/custos/categorias', async (req, resposta) => {
      const { ws, custos } = await preparar(req);
      void resposta.header('Cache-Control', 'no-store');
      return {
        categorias: await custos.listarCategorias(ws),
        grupos: GRUPOS_DE_CUSTO,
        limites: limites(),
      };
    });

    servidor.post('/v1/custos/categorias', escrita, async (req, resposta) => {
      const { ws, custos } = await preparar(req);
      const c = corpoCategoria.parse(req.body ?? {});
      const nova = await custos.criarCategoria(ws, c.nome, c.grupo);
      void resposta.header('Cache-Control', 'no-store');
      return resposta.code(201).send(categoriaParaJson(nova));
    });

    servidor.patch<{ Params: { id: string } }>(
      '/v1/custos/categorias/:id',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const c = corpoAlterarCategoria.parse(req.body ?? {});
        const cat = await custos.alterarCategoria(ws, req.params.id, {
          ...(c.arquivada !== undefined ? { arquivada: c.arquivada } : {}),
          ...(c.grupo !== undefined ? { grupo: c.grupo } : {}),
        });
        void resposta.header('Cache-Control', 'no-store');
        return categoriaParaJson(cat);
      },
    );

    // ----- Comprovantes (v0.49.0). O arquivo vai da MEMÓRIA ao Drive do advogado: nada em disco. -----
    // Corpo binário (PDF, JPEG ou PNG) e o nome no cabeçalho `x-nome-do-arquivo`, em encodeURIComponent.
    // Sub-plugin à parte: o parser de binário vale só para esta rota e o teto de 5 MB também (o resto
    // da API segue com o limite global pequeno). O tipo REAL sai dos primeiros bytes, no domínio.
    void servidor.register(async (envio) => {
      envio.addContentTypeParser(
        '*',
        { parseAs: 'buffer', bodyLimit: TAMANHO_MAXIMO_DO_COMPROVANTE + 64 * 1024 },
        (_req, corpo, pronto) => pronto(null, corpo),
      );
      envio.post<{ Params: { id: string } }>(
        '/v1/custos/:id/comprovantes',
        {
          bodyLimit: TAMANHO_MAXIMO_DO_COMPROVANTE + 64 * 1024,
          config: {
            rateLimit: { max: LIMITE_COMPROVANTES_POR_MINUTO, timeWindow: 60_000 },
          },
        },
        async (req, resposta) => {
          const { ws, custos } = await preparar(req);
          const corpo: unknown = req.body;
          const conteudo = Buffer.isBuffer(corpo)
            ? new Uint8Array(corpo.buffer, corpo.byteOffset, corpo.length)
            : undefined;
          const c = await custos.anexarComprovante(ws, req.params.id, {
            conteudo,
            nome: nomeDoCabecalho(req.headers['x-nome-do-arquivo']),
            tipoDeclarado: req.headers['content-type'],
          });
          void resposta.header('Cache-Control', 'no-store');
          return resposta.code(201).send(comprovanteParaJson(c));
        },
      );
    });

    // Remove SÓ o vínculo. O arquivo continua no Google Drive do advogado (o sistema nunca apaga lá).
    servidor.delete<{ Params: { id: string; comprovanteId: string } }>(
      '/v1/custos/:id/comprovantes/:comprovanteId',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        await custos.removerComprovante(ws, req.params.id, req.params.comprovanteId);
        void resposta.header('Cache-Control', 'no-store');
        return { removido: true, arquivoContinuaNoDrive: true };
      },
    );

    // ----- Custos por cliente, PDF consolidado e CSV (v0.49.0) -----
    function aCliente(): ServicoCustosPorCliente {
      if (!porCliente) {
        throw new OperacaoNaoSuportadaError(
          'custosDoProcesso',
          'custos',
          'a visão por cliente não está montada',
        );
      }
      return porCliente;
    }
    const filtroDe = (q: z.infer<typeof consultaClientes>): FiltroPorCliente => ({
      ...(q.de ? { de: q.de } : {}),
      ...(q.ate ? { ate: q.ate } : {}),
      ...(q.cliente ? { cliente: q.cliente } : {}),
      somenteComSaldo: q.somenteComSaldo === 'true',
    });

    servidor.get('/v1/custos/clientes', async (req, resposta) => {
      const { ws } = await preparar(req);
      const q = consultaClientes.parse(req.query ?? {});
      const r = await aCliente().listar(ws, filtroDe(q));
      void resposta.header('Cache-Control', 'no-store');
      return {
        clientes: r.clientes.map(clienteParaJson),
        totalDeClientes: r.totalDeClientes,
        totalDeProcessos: r.totalDeProcessos,
        processosSemCliente: r.processosSemCliente,
      };
    });

    servidor.get('/v1/custos/clientes/detalhe', async (req, resposta) => {
      const { ws } = await preparar(req);
      const q = consultaClientes.parse(req.query ?? {});
      if (!q.cliente) throw new CustoInvalidoError('Informe o cliente.');
      const r = await aCliente().detalhar(ws, q.cliente, filtroDe(q));
      void resposta.header('Cache-Control', 'no-store');
      return detalheParaJson(r);
    });

    servidor.get(
      '/v1/custos/clientes/prestacao.pdf',
      {
        config: { rateLimit: { max: LIMITE_PRESTACOES_POR_MINUTO, timeWindow: 60_000 } },
      },
      async (req, resposta) => {
        const { ws } = await preparar(req);
        const q = consultaClientes.parse(req.query ?? {});
        if (!q.cliente) throw new CustoInvalidoError('Informe o cliente.');
        const u = req.usuario;
        const { pdf, nomeDoArquivo } = await aCliente().gerarPrestacaoDoCliente(
          ws,
          q.cliente,
          filtroDe(q),
          u
            ? {
                nome: u.nome,
                ...(u.oab ? { oab: u.ufOab ? `${u.oab}/${u.ufOab}` : u.oab } : {}),
              }
            : undefined,
        );
        return resposta
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `attachment; filename="${nomeDoArquivo}"`)
          .header('Cache-Control', 'no-store')
          .send(Buffer.from(pdf));
      },
    );

    const limiteDoCsv = {
      config: {
        rateLimit: { max: LIMITE_EXPORTACOES_POR_MINUTO, timeWindow: 60_000 },
      },
    };
    const enviarCsv = (
      resposta: FastifyReply,
      r: { readonly csv: string; readonly nomeDoArquivo: string },
    ): FastifyReply =>
      resposta
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${r.nomeDoArquivo}"`)
        .header('Cache-Control', 'no-store')
        .send(r.csv);

    servidor.get('/v1/custos/lancamentos.csv', limiteDoCsv, async (req, resposta) => {
      const { ws } = await preparar(req);
      const q = consultaCsv.parse(req.query ?? {});
      return enviarCsv(
        resposta,
        await aCliente().gerarCsv(ws, {
          ...(q.de ? { de: q.de } : {}),
          ...(q.ate ? { ate: q.ate } : {}),
          ...(q.cliente ? { cliente: q.cliente } : {}),
          incluirCancelados: q.incluirCancelados === 'true',
        }),
      );
    });

    servidor.get<{ Params: { numero: string } }>(
      '/v1/processos/:numero/custos/lancamentos.csv',
      limiteDoCsv,
      async (req, resposta) => {
        const { ws } = await preparar(req);
        const q = consultaCsv.omit({ cliente: true }).parse(req.query ?? {});
        return enviarCsv(
          resposta,
          await aCliente().gerarCsv(ws, {
            numero: req.params.numero,
            ...(q.de ? { de: q.de } : {}),
            ...(q.ate ? { ate: q.ate } : {}),
            incluirCancelados: q.incluirCancelados === 'true',
          }),
        );
      },
    );

    // GET e não POST: é uma leitura (nada é criado nem gravado), e o navegador baixa o arquivo
    // por um link. O PDF sai na resposta, não vai a disco e não é guardado.
    servidor.get<{ Params: { numero: string } }>(
      '/v1/processos/:numero/custos/prestacao.pdf',
      {
        config: { rateLimit: { max: LIMITE_PRESTACOES_POR_MINUTO, timeWindow: 60_000 } },
      },
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const q = consultaPrestacao.parse(req.query ?? {});
        const u = req.usuario;
        const { pdf, nomeDoArquivo } = await custos.gerarPrestacao(
          ws,
          req.params.numero,
          {
            ...(q.de ? { de: q.de } : {}),
            ...(q.ate ? { ate: q.ate } : {}),
            somenteACobrar: q.somenteACobrar === 'true',
          },
          u
            ? {
                nome: u.nome,
                ...(u.oab ? { oab: u.ufOab ? `${u.oab}/${u.ufOab}` : u.oab } : {}),
              }
            : undefined,
        );
        return resposta
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `attachment; filename="${nomeDoArquivo}"`)
          .header('Cache-Control', 'no-store')
          .send(Buffer.from(pdf));
      },
    );
  };
}

function limites(): Record<string, number> {
  return {
    lancamentosPorProcesso: LIMITE_LANCAMENTOS_POR_PROCESSO,
    recebimentosPorProcesso: LIMITE_RECEBIMENTOS_POR_PROCESSO,
    categoriasProprias: LIMITE_CATEGORIAS_PROPRIAS,
    descricao: LIMITE_DESCRICAO,
    observacao: LIMITE_OBSERVACAO_DO_RECEBIMENTO,
    motivo: LIMITE_MOTIVO,
    comprovantesPorLancamento: LIMITE_COMPROVANTES_POR_LANCAMENTO,
    tamanhoMaximoDoComprovante: TAMANHO_MAXIMO_DO_COMPROVANTE,
    nomeDaCategoria: LIMITE_NOME_DA_CATEGORIA,
    valorMaximoCentavos: VALOR_MAXIMO_CENTAVOS,
  };
}

function categoriaParaJson(c: CategoriaDeCusto): Record<string, unknown> {
  return {
    codigo: codigoDaCategoriaPropria(c.id),
    nome: c.nome,
    grupo: c.grupo,
    nomeDoGrupo: grupoDeCusto(c.grupo)?.nome ?? c.grupo,
    base: false,
    arquivada: c.arquivada,
    deposito: ehGrupoDeDeposito(c.grupo),
  };
}

function paraJson(
  c: Custo,
  categorias?: ReadonlyMap<string, CategoriaParaTela>,
  comprovantes?: readonly Comprovante[],
): Record<string, unknown> {
  const cat = categorias?.get(codigoAtualDaCategoria(c.categoria));
  return {
    id: c.id,
    numeroProcesso: c.numeroProcesso,
    data: c.data,
    descricao: c.descricao,
    categoria: codigoAtualDaCategoria(c.categoria),
    grupo: cat?.grupo ?? null,
    deposito: cat?.deposito ?? false,
    valorCentavos: c.valorCentavos,
    reembolsavel: c.reembolsavel,
    pagoPor: c.pagoPor,
    cancelado: c.canceladoEm !== undefined,
    canceladoEm: c.canceladoEm?.toISOString() ?? null,
    motivoDoCancelamento: c.motivoDoCancelamento ?? null,
    comprovantes: (comprovantes ?? []).map(comprovanteParaJson),
    criadoEm: c.criadoEm.toISOString(),
    atualizadoEm: c.atualizadoEm.toISOString(),
  };
}

function recebimentoParaJson(r: Recebimento): Record<string, unknown> {
  return {
    id: r.id,
    numeroProcesso: r.numeroProcesso,
    data: r.data,
    valorCentavos: r.valorCentavos,
    observacao: r.observacao ?? null,
    cancelado: r.canceladoEm !== undefined,
    canceladoEm: r.canceladoEm?.toISOString() ?? null,
    motivoDoCancelamento: r.motivoDoCancelamento ?? null,
    criadoEm: r.criadoEm.toISOString(),
    atualizadoEm: r.atualizadoEm.toISOString(),
  };
}

function eventoParaJson(e: EventoParaTela): Record<string, unknown> {
  return {
    id: e.id,
    quando: e.quando.toISOString(),
    operacao: e.operacao,
    motivo: e.motivo ?? null,
    campos: e.campos,
  };
}

function totaisParaJson(
  t: TotaisDeCusto,
  categorias: readonly CategoriaParaTela[],
): Record<string, unknown> {
  const nomes = new Map(categorias.map((c) => [c.codigo, c.nomeCompleto]));
  const sub = (s: SubtotalDaCategoria): Record<string, unknown> => ({
    categoria: s.categoria,
    nome: nomes.get(s.categoria) ?? 'Categoria não identificada',
    totalCentavos: s.totalCentavos,
    quantidade: s.quantidade,
  });
  return {
    quantidade: t.quantidade,
    totalDespesasCentavos: t.totalDespesasCentavos,
    pagoPeloEscritorioCentavos: t.pagoPeloEscritorioCentavos,
    pagoPeloClienteCentavos: t.pagoPeloClienteCentavos,
    totalReembolsavelCentavos: t.totalReembolsavelCentavos,
    reembolsavelDeDepositosCentavos: t.reembolsavelDeDepositosCentavos,
    totalRecebidoCentavos: t.totalRecebidoCentavos,
    saldoACobrarCentavos: t.saldoACobrarCentavos,
    creditoDoClienteCentavos: t.creditoDoClienteCentavos,
    porCategoria: t.porCategoria.map(sub),
    depositos: {
      quantidade: t.depositos.quantidade,
      totalCentavos: t.depositos.totalCentavos,
      pagoPeloEscritorioCentavos: t.depositos.pagoPeloEscritorioCentavos,
      pagoPeloClienteCentavos: t.depositos.pagoPeloClienteCentavos,
      porCategoria: t.depositos.porCategoria.map(sub),
    },
  };
}

function comprovanteParaJson(c: Comprovante): Record<string, unknown> {
  return {
    id: c.id,
    nome: c.nome,
    tipo: c.tipo,
    tamanho: c.tamanho,
    link: c.link,
    anexadoEm: c.anexadoEm.toISOString(),
  };
}

/** O nome do arquivo vem em `encodeURIComponent` (cabeçalho só leva ASCII); qualquer defeito vira vazio. */
function nomeDoCabecalho(valor: string | string[] | undefined): string {
  const bruto = Array.isArray(valor) ? valor[0] : valor;
  if (!bruto || bruto.length > 600) return '';
  try {
    return decodeURIComponent(bruto);
  } catch {
    return '';
  }
}

function totaisDoCliente(
  t: Omit<ClienteResumido, 'chave' | 'nome' | 'semCliente'> | ProcessoDoCliente['totais'],
): Record<string, number> {
  return {
    totalDespesasCentavos: t.totalDespesasCentavos,
    pagoPeloEscritorioCentavos: t.pagoPeloEscritorioCentavos,
    pagoPeloClienteCentavos: t.pagoPeloClienteCentavos,
    totalReembolsavelCentavos: t.totalReembolsavelCentavos,
    reembolsavelDeDepositosCentavos: t.reembolsavelDeDepositosCentavos,
    depositosCentavos: t.depositosCentavos,
    totalRecebidoCentavos: t.totalRecebidoCentavos,
    saldoACobrarCentavos: t.saldoACobrarCentavos,
    creditoDoClienteCentavos: t.creditoDoClienteCentavos,
  };
}

function clienteParaJson(c: ClienteResumido): Record<string, unknown> {
  return {
    chave: c.chave,
    nome: c.nome,
    semCliente: c.semCliente,
    processos: c.processos,
    ...totaisDoCliente(c),
  };
}

function detalheParaJson(d: DetalheDoCliente): Record<string, unknown> {
  return {
    chave: d.chave,
    nome: d.nome,
    semCliente: d.semCliente,
    totalDeProcessos: d.totalDeProcessos,
    totais: { processos: d.totais.processos, ...totaisDoCliente(d.totais) },
    processos: d.processos.map((p) => ({
      numeroProcesso: p.numeroProcesso,
      formatado: p.formatado,
      tribunal: p.tribunal,
      lancamentos: p.lancamentos,
      recebimentos: p.recebimentos,
      ...totaisDoCliente(p.totais),
    })),
  };
}
