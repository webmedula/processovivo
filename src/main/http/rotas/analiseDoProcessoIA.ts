import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { corpoDaAvaliacao } from './avaliacaoDeIa.js';
import type { ServicoAnaliseDoProcesso } from '../../../application/services/ServicoAnaliseDoProcesso.js';
import { WorkspaceNaoResolvidoError } from '../../../domain/errors/index.js';

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

/** Só os ids das peças, da listagem DESTA conta; o serviço confere quantidade e existência. */
const corpoDaSelecao = z
  .object({ pecas: z.array(z.string().min(1).max(200)).min(1).max(40) })
  .strict();

/**
 * Análise do PROCESSO pelas peças (v0.66.0). Sem try/catch: o `errorHandler` traduz os erros de domínio
 * (404 indisponível/não encontrada, 403 sem plano/sigilo, 400 seleção, 409 listagem ausente, 422 tribunal,
 * 429 em andamento/freio, 503 desligada). Os pedidos levam só ids de peça: texto vindo de fora nunca é
 * aceito, e o texto das peças nunca sai na resposta (só o resultado verificado, com citações curtas).
 *
 * `GET …/disponibilidade` está SEMPRE registrada: sem o serviço, ou para conta fora da lista, diz
 * `liberado: false` e a tela não desenha o botão. As demais rotas só existem com o serviço montado.
 */
export function rotasDaAnaliseDoProcessoIA(
  servico: ServicoAnaliseDoProcesso | undefined,
): FastifyPluginAsync {
  return async (servidor) => {
    servidor.get('/v1/analises-do-processo/disponibilidade', async (req) => ({
      liberado: servico !== undefined && req.workspace !== undefined && servico.liberado(req.workspace),
    }));
    if (!servico) return;

    servidor.post<{ Params: { numero: string } }>(
      '/v1/processos/:numero/analise-do-processo/estimativa',
      async (req) => {
        const { pecas } = corpoDaSelecao.parse(req.body);
        return servico.estimar(workspaceDe(req), req.params.numero, pecas);
      },
    );

    servidor.post<{ Params: { numero: string } }>(
      '/v1/processos/:numero/analise-do-processo',
      async (req, reply) => {
        const { pecas } = corpoDaSelecao.parse(req.body);
        const visao = await servico.iniciar(workspaceDe(req), req.params.numero, pecas);
        return reply.code(202).send(visao);
      },
    );

    servidor.get<{ Params: { id: string } }>('/v1/analises-do-processo/:id', async (req) =>
      servico.consultar(workspaceDe(req), req.params.id),
    );

    servidor.delete<{ Params: { id: string } }>('/v1/analises-do-processo/:id', async (req) =>
      servico.cancelar(workspaceDe(req), req.params.id),
    );

    servidor.post<{ Params: { id: string } }>(
      '/v1/sinteses-do-processo/:id/avaliacao',
      async (req) => {
        const { avaliacao, motivo } = corpoDaAvaliacao.parse(req.body);
        await servico.avaliar(workspaceDe(req), req.params.id, avaliacao, motivo);
        return { id: req.params.id, avaliacao, ...(motivo ? { motivo } : {}) };
      },
    );
  };
}
