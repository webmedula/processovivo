import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServicoAnaliseDoAto } from '../../../application/services/ServicoAnaliseDoAto.js';
import { WorkspaceNaoResolvidoError } from '../../../domain/errors/index.js';

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

/**
 * O corpo carrega SÓ a chave do ato: o texto é lido do retrato da conta, no servidor.
 * Campo a mais é ignorado — nunca há caminho para o cliente mandar texto de ato.
 */
const corpoDaAnalise = z.object({ chaveDoAto: z.string().min(1).max(600) });

/** Sem texto livre: três valores, e só. */
const corpoDaAvaliacao = z.object({ avaliacao: z.enum(['util', 'errado', 'perigoso']) });

/**
 * Análise de ato por IA (v0.38.0). Sem try/catch: o `errorHandler` traduz os erros de
 * domínio (403 sem plano/segredo, 422 sem texto, 429 limite, 404 análise de outra conta).
 *
 * Com a IA desligada (`servico` indefinido) só existe a rota de disponibilidade, que diz
 * isso à tela para ela nem desenhar o botão; as outras duas não são registradas (404).
 */
export function rotasDaAnaliseIA(
  servico: ServicoAnaliseDoAto | undefined,
): FastifyPluginAsync {
  return async (servidor) => {
    servidor.get('/v1/analises/disponibilidade', async () => ({
      habilitada: servico !== undefined,
    }));
    if (!servico) return;

    servidor.post<{ Params: { numero: string } }>(
      '/v1/acompanhamentos/:numero/analise',
      async (req, reply) => {
        const { chaveDoAto } = corpoDaAnalise.parse(req.body);
        // A pessoa cancelou (ou fechou a aba): aborta a chamada ao modelo em curso.
        const cancelamento = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) cancelamento.abort();
        });
        const resultado = await servico.analisar({
          workspace: workspaceDe(req),
          numero: req.params.numero,
          chaveDoAto,
          sinal: cancelamento.signal,
        });
        if (resultado.estado === 'erro') return { estado: 'erro' };
        const { criadaEm, ...resto } = resultado;
        return { ...resto, criadaEm: criadaEm.toISOString() };
      },
    );

    servidor.post<{ Params: { id: string } }>(
      '/v1/analises/:id/avaliacao',
      async (req) => {
        const { avaliacao } = corpoDaAvaliacao.parse(req.body);
        await servico.avaliar(workspaceDe(req), req.params.id, avaliacao);
        return { id: req.params.id, avaliacao };
      },
    );
  };
}
