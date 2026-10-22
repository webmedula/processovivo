import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { corpoDaAvaliacao } from './avaliacaoDeIa.js';
import type { ServicoAnaliseDePeca } from '../../../application/services/ServicoAnaliseDePeca.js';
import type { ServicoPasta } from '../../../application/services/ServicoPasta.js';
import type { ResultadoDaAnaliseDePeca } from '../../../domain/entities/AnaliseDePeca.js';
import {
  AnaliseDePecaRecusadaError,
  PecaDaPastaNaoEncontradaError,
  WorkspaceNaoResolvidoError,
} from '../../../domain/errors/index.js';

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

function resultadoJson(r: ResultadoDaAnaliseDePeca): Record<string, unknown> {
  if (r.estado === 'nao_verificada') return { estado: r.estado, motivo: r.motivo };
  return {
    estado: r.estado,
    tipo: r.tipo,
    emUmaFrase: r.emUmaFrase,
    pedidos: r.pedidos,
    alegacoes: r.alegacoes,
    preliminares: r.preliminares,
    documentos: r.documentos.map((d) => ({ nome: d.nome_como_escrito, pagina: d.pagina })),
    valores: r.valores.map((v) => ({
      valor: v.valor_literal,
      contexto: v.contexto_curto,
      trecho: v.trecho,
      pagina: v.pagina,
    })),
    pontosDeAtencao: r.pontosDeAtencao,
  };
}

/**
 * Análise de PEÇA por IA (v0.55.0). Sem try/catch: o `errorHandler` traduz os erros de domínio
 * (404 indisponível, 403 sem plano/sigilo, 409 peça não baixada, 422 sem texto/limites, 429 freio
 * e teto). O pedido não leva corpo: a peça é lida da guarda do servidor, e texto vindo de fora nunca
 * é aceito.
 *
 * `GET …/disponibilidade` está SEMPRE registrada: com o recurso desligado, ou para uma conta que
 * nenhuma das duas chaves libera, diz `liberado: false` e a tela nem desenha o botão. As demais
 * rotas só existem com o serviço montado.
 */
export function rotasDaAnaliseDePecaIA(
  servico: ServicoAnaliseDePeca | undefined,
  pasta: ServicoPasta | undefined,
): FastifyPluginAsync {
  return async (servidor) => {
    servidor.get('/v1/analises-de-peca/disponibilidade', async (req) => {
      const modo = servico && req.workspace ? servico.modoDa(req.workspace) : undefined;
      return modo ? { liberado: true, modo } : { liberado: false };
    });
    if (!servico) return;

    // O estado da peça na guarda (só banco, nunca o tribunal): a tela baixa a peça pelo pedido que já
    // existe (`POST …/pasta/pecas/:pecaId`) e acompanha por aqui até ela ficar disponível.
    servidor.get<{ Params: { numero: string; pecaId: string } }>(
      '/v1/processos/:numero/pasta/pecas/:pecaId/estado',
      async (req) => {
        const ws = workspaceDe(req);
        if (!servico.modoDa(ws)) {
          throw new AnaliseDePecaRecusadaError(
            'indisponivel',
            'A análise de peça por IA não está disponível para esta conta.',
          );
        }
        const e = await pasta?.estadoDaPeca(ws, req.params.numero, req.params.pecaId);
        if (!e) throw new PecaDaPastaNaoEncontradaError(req.params.pecaId);
        return {
          estado: e.estado,
          motivo: e.motivo ?? null,
          retomarEm: e.retomarEm ? e.retomarEm.toISOString() : null,
        };
      },
    );

    servidor.post<{ Params: { numero: string; pecaId: string } }>(
      '/v1/processos/:numero/pecas/:pecaId/analise',
      async (req, reply) => {
        // A pessoa cancelou (ou fechou a aba): aborta a chamada ao modelo em curso.
        const cancelamento = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) cancelamento.abort();
        });
        const r = await servico.analisar({
          workspace: workspaceDe(req),
          numero: req.params.numero,
          pecaId: req.params.pecaId,
          sinal: cancelamento.signal,
        });
        if (r.estado === 'erro') return { estado: 'erro' };
        return {
          estado: r.estado,
          id: r.id,
          modo: r.modo,
          resultado: resultadoJson(r.resultado),
          contagens: r.contagens,
          reaproveitada: r.reaproveitada,
          conversao: r.conversao,
          modelo: r.modelo,
          versaoPrompt: r.versaoPrompt,
          provedor: r.provedor,
          criadaEm: r.criadaEm.toISOString(),
          expiraEm: r.expiraEm.toISOString(),
          avaliacao: r.avaliacao,
        };
      },
    );

    servidor.post<{ Params: { id: string } }>(
      '/v1/analises-de-peca/:id/avaliacao',
      async (req) => {
        const { avaliacao, motivo } = corpoDaAvaliacao.parse(req.body);
        await servico.avaliar(workspaceDe(req), req.params.id, avaliacao, motivo);
        return { id: req.params.id, avaliacao, ...(motivo ? { motivo } : {}) };
      },
    );
  };
}
