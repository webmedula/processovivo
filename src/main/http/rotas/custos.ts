import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  CategoriaParaTela,
  ServicoCustos,
} from '../../../application/services/ServicoCustos.js';
import type { ServicoAssinaturas } from '../../../application/services/ServicoAssinaturas.js';
import type { Custo, TotaisDeCusto } from '../../../domain/entities/Custo.js';
import {
  LIMITE_CATEGORIAS_PROPRIAS,
  LIMITE_DESCRICAO,
  LIMITE_LANCAMENTOS_POR_PROCESSO,
  LIMITE_NOME_DA_CATEGORIA,
  VALOR_MAXIMO_CENTAVOS,
} from '../../../domain/entities/Custo.js';
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

const corpoCriar = z
  .object({
    data: dataLocal,
    descricao: z.string().max(2000),
    categoria: z.string().min(1).max(80),
    valorCentavos: z.number().finite(),
    reembolsavel: z.boolean().default(false),
    // Só o "Desfazer" da exclusão manda isto: recria o lançamento como ele era.
    ressarcidoEm: dataLocal.optional(),
  })
  .strict();

const corpoAlterar = z
  .object({
    data: dataLocal.optional(),
    descricao: z.string().max(2000).optional(),
    categoria: z.string().min(1).max(80).optional(),
    valorCentavos: z.number().finite().optional(),
    reembolsavel: z.boolean().optional(),
    ressarcidoEm: dataLocal.nullable().optional(),
  })
  .strict();

const corpoRessarcir = z.object({ em: dataLocal.optional() }).strict();
const corpoCategoria = z.object({ nome: z.string().max(400) }).strict();
const corpoArquivar = z.object({ arquivada: z.boolean() }).strict();

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
        const r = await custos.listar(ws, req.params.numero);
        void resposta.header('Cache-Control', 'no-store');
        return {
          numeroProcesso: r.numeroProcesso,
          lancamentos: r.lancamentos.map(paraJson),
          totais: totaisParaJson(r.totais, r.categorias),
          categorias: r.categorias,
          limites: limites(),
        };
      },
    );

    servidor.get<{ Params: { numero: string } }>(
      '/v1/processos/:numero/custos/totais',
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const categorias = await custos.listarCategorias(ws);
        void resposta.header('Cache-Control', 'no-store');
        return totaisParaJson(await custos.totais(ws, req.params.numero), categorias);
      },
    );

    servidor.post<{ Params: { numero: string } }>(
      '/v1/processos/:numero/custos',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const c = corpoCriar.parse(req.body ?? {});
        const custo = await custos.criar(ws, req.params.numero, {
          data: c.data,
          descricao: c.descricao,
          categoria: c.categoria,
          valorCentavos: c.valorCentavos,
          reembolsavel: c.reembolsavel,
          ...(c.ressarcidoEm !== undefined ? { ressarcidoEm: c.ressarcidoEm } : {}),
        });
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
          ...(c.ressarcidoEm !== undefined ? { ressarcidoEm: c.ressarcidoEm } : {}),
        });
        void resposta.header('Cache-Control', 'no-store');
        return paraJson(custo);
      },
    );

    // Definitivo: não há lixeira. O "Desfazer" da tela recria o lançamento com um POST.
    servidor.delete<{ Params: { id: string } }>(
      '/v1/custos/:id',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        await custos.excluir(ws, req.params.id);
        return resposta.code(204).send();
      },
    );

    servidor.put<{ Params: { id: string } }>(
      '/v1/custos/:id/ressarcimento',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const c = corpoRessarcir.parse(req.body ?? {});
        void resposta.header('Cache-Control', 'no-store');
        return paraJson(await custos.ressarcir(ws, req.params.id, c.em));
      },
    );

    servidor.delete<{ Params: { id: string } }>(
      '/v1/custos/:id/ressarcimento',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        void resposta.header('Cache-Control', 'no-store');
        return paraJson(await custos.desfazerRessarcimento(ws, req.params.id));
      },
    );

    servidor.get('/v1/custos/categorias', async (req, resposta) => {
      const { ws, custos } = await preparar(req);
      void resposta.header('Cache-Control', 'no-store');
      return { categorias: await custos.listarCategorias(ws), limites: limites() };
    });

    servidor.post('/v1/custos/categorias', escrita, async (req, resposta) => {
      const { ws, custos } = await preparar(req);
      const c = corpoCategoria.parse(req.body ?? {});
      const nova = await custos.criarCategoria(ws, c.nome);
      void resposta.header('Cache-Control', 'no-store');
      return resposta.code(201).send({
        codigo: `c-${nova.id}`,
        nome: nova.nome,
        base: false,
        arquivada: nova.arquivada,
      });
    });

    servidor.patch<{ Params: { id: string } }>(
      '/v1/custos/categorias/:id',
      escrita,
      async (req, resposta) => {
        const { ws, custos } = await preparar(req);
        const c = corpoArquivar.parse(req.body ?? {});
        const cat = await custos.arquivarCategoria(ws, req.params.id, c.arquivada);
        void resposta.header('Cache-Control', 'no-store');
        return {
          codigo: `c-${cat.id}`,
          nome: cat.nome,
          base: false,
          arquivada: cat.arquivada,
        };
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
    categoriasProprias: LIMITE_CATEGORIAS_PROPRIAS,
    descricao: LIMITE_DESCRICAO,
    nomeDaCategoria: LIMITE_NOME_DA_CATEGORIA,
    valorMaximoCentavos: VALOR_MAXIMO_CENTAVOS,
  };
}

function paraJson(c: Custo): Record<string, unknown> {
  return {
    id: c.id,
    numeroProcesso: c.numeroProcesso,
    data: c.data,
    descricao: c.descricao,
    categoria: c.categoria,
    valorCentavos: c.valorCentavos,
    reembolsavel: c.reembolsavel,
    ressarcidoEm: c.ressarcidoEm ?? null,
    criadoEm: c.criadoEm.toISOString(),
    atualizadoEm: c.atualizadoEm.toISOString(),
  };
}

function totaisParaJson(
  t: TotaisDeCusto,
  categorias: readonly CategoriaParaTela[],
): Record<string, unknown> {
  const nomes = new Map(categorias.map((c) => [c.codigo, c.nome]));
  return {
    quantidade: t.quantidade,
    totalGastoCentavos: t.totalGastoCentavos,
    totalReembolsavelCentavos: t.totalReembolsavelCentavos,
    totalRessarcidoCentavos: t.totalRessarcidoCentavos,
    saldoACobrarCentavos: t.saldoACobrarCentavos,
    porCategoria: t.porCategoria.map((s) => ({
      categoria: s.categoria,
      nome: nomes.get(s.categoria) ?? 'Outros',
      totalCentavos: s.totalCentavos,
      quantidade: s.quantidade,
    })),
  };
}
