import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  CategoriaParaTela,
  EventoParaTela,
  ServicoCustos,
} from '../../../application/services/ServicoCustos.js';
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
  OperacaoNaoSuportadaError,
  WorkspaceNaoResolvidoError,
} from '../../../domain/errors/index.js';

/** Escritas por minuto, por conta/chave. Folgado para uso humano; barra script em laço. */
export const LIMITE_ESCRITAS_DE_CUSTOS_POR_MINUTO = 90;
/** O PDF custa CPU e memória: poucas por minuto bastam para quem envia ao cliente. */
export const LIMITE_PRESTACOES_POR_MINUTO = 10;

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
          lancamentos: r.lancamentos.map((c) => paraJson(c, grupoDe)),
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
