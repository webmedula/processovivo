import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  ItemDoResumoParaATela,
  ServicoResumoDoProcesso,
} from '../../../application/services/ServicoResumoDoProcesso.js';
import { WorkspaceNaoResolvidoError } from '../../../domain/errors/index.js';

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

/** Sem texto livre: três valores, e só. */
const corpoDaAvaliacao = z.object({ avaliacao: z.enum(['util', 'errado', 'perigoso']) });

function itemJson(i: ItemDoResumoParaATela): Record<string, unknown> {
  return {
    texto: i.texto,
    trecho: i.trecho,
    ato: {
      chaveDoAto: i.ato.chaveDoAto,
      data: i.ato.data.toISOString(),
      rotulo: i.ato.rotulo,
      tipoDaComunicacao: i.ato.tipoDaComunicacao,
    },
  };
}

/**
 * Resumo de processo por IA (v0.40.0). Sem try/catch: o `errorHandler` traduz os erros de
 * domínio (403 sem plano/segredo, 422 sem texto, 429 limite, 404 processo não acompanhado ou
 * resumo de outra conta). O pedido não leva corpo: o texto é lido do retrato da conta, no
 * servidor, e texto vindo de fora nunca é aceito.
 *
 * Com a IA desligada (`servico` indefinido) as rotas não são registradas (404); a tela sabe
 * por `GET /v1/analises/disponibilidade`.
 */
export function rotasDoResumoIA(
  servico: ServicoResumoDoProcesso | undefined,
): FastifyPluginAsync {
  return async (servidor) => {
    if (!servico) return;

    servidor.post<{ Params: { numero: string } }>(
      '/v1/acompanhamentos/:numero/resumo',
      async (req, reply) => {
        // A pessoa cancelou (ou fechou a aba): aborta a chamada ao modelo em curso.
        const cancelamento = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) cancelamento.abort();
        });
        const r = await servico.resumir({
          workspace: workspaceDe(req),
          numero: req.params.numero,
          sinal: cancelamento.signal,
        });
        if (r.estado === 'erro') return { estado: 'erro' };
        return {
          estado: r.estado,
          id: r.id,
          situacao: r.situacao.map(itemJson),
          pendencias: r.pendencias.map(itemJson),
          pontosDeAtencao: r.pontosDeAtencao,
          contagens: r.contagens,
          modelo: r.modelo,
          versaoPrompt: r.versaoPrompt,
          provedor: r.provedor,
          criadaEm: r.criadaEm.toISOString(),
          avaliacao: r.avaliacao,
        };
      },
    );

    servidor.post<{ Params: { id: string } }>(
      '/v1/resumos/:id/avaliacao',
      async (req) => {
        const { avaliacao } = corpoDaAvaliacao.parse(req.body);
        await servico.avaliar(workspaceDe(req), req.params.id, avaliacao);
        return { id: req.params.id, avaliacao };
      },
    );
  };
}
