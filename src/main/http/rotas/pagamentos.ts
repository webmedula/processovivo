import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServicoPagamentos } from '../../../application/services/ServicoPagamentos.js';
import { ROTA_DO_WEBHOOK_MERCADO_PAGO } from '../../../application/services/ServicoPagamentos.js';
import {
  GatewayDePagamentoRecusouError,
  WorkspaceNaoResolvidoError,
} from '../../../domain/errors/index.js';
import type { Logger } from '../../../domain/ports/Logger.js';

/** Pública para o plugin de autenticação: quem autentica é a assinatura do aviso. Ver `rotasDePagamentos`. */
export const ROTA_WEBHOOK_DE_PAGAMENTO = ROTA_DO_WEBHOOK_MERCADO_PAGO;
export const ROTA_CHECKOUT = '/v1/assinatura/checkout';
export const ROTA_CANCELAR_RECORRENCIA = '/v1/assinatura/recorrencia';

/** O gateway manda rajadas (parcelas e tentativas); o limite é folgado, mas existe. */
const LIMITE_DO_WEBHOOK_POR_MINUTO = 300;
/** Checkout cria coisa no gateway: poucas por minuto por conta. */
const LIMITE_DO_CHECKOUT_POR_MINUTO = 6;
const LIMITE_DO_CANCELAMENTO_POR_MINUTO = 6;

/**
 * O gateway espera 200/201 em até 22 s. Processar leva uma ou duas consultas e algumas escritas; com
 * este teto o aviso responde ANTES do gateway desistir mesmo que a consulta demore, e o resto termina
 * em segundo plano (idempotente: se falhar, o aviso volta em 15 minutos).
 */
const PRAZO_PARA_RESPONDER_MS = 15_000;

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

/** `.strict()`: nada além do código do plano. Preço, valor e e-mail NUNCA vêm do cliente. */
const corpoDoCheckout = z.object({ plano: z.string().trim().min(1).max(30) }).strict();

const texto = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined;

/**
 * As rotas da cobrança recorrente. **Com o recurso desligado (`pagamentos` indefinido) NENHUMA delas
 * existe**: o servidor responde o 404 comum de rota inexistente, inclusive no webhook.
 *
 * - `POST /v1/assinatura/checkout`: cria a recorrência e devolve a URL hospedada. Só conta com
 *   e-mail (chave de API é recusada com `conta_sem_email`, 403).
 * - `DELETE /v1/assinatura/recorrencia`: encerra a RENOVAÇÃO; o plano segue até o fim do período pago.
 * - `POST /v1/pagamentos/webhook/mercadopago`: PÚBLICA (sem cookie e sem chave). A autenticação é a
 *   assinatura do aviso (`x-signature`); inválida = 401 e nada é gravado. O corpo NÃO é fonte de
 *   nada: só o id serve, e o estado vem da consulta ao gateway.
 */
export function rotasDePagamentos(
  pagamentos: ServicoPagamentos | undefined,
  logger: Logger,
): FastifyPluginAsync {
  return async (servidor) => {
    if (!pagamentos) {
      // Desligada: o webhook responde o MESMO 404 de rota inexistente. A rota é registrada só para
      // isso: o plugin de autenticação a lista como pública, e uma rota que não existe cairia no 401.
      servidor.post(ROTA_WEBHOOK_DE_PAGAMENTO, async (req, resposta) =>
        resposta.code(404).send({
          erro: 'ROTA_NAO_ENCONTRADA',
          mensagem: `Nenhuma rota para ${req.method} ${req.url.split('?')[0] ?? ''}.`,
        }),
      );
      return;
    }

    servidor.post(
      ROTA_CHECKOUT,
      {
        config: {
          rateLimit: {
            max: LIMITE_DO_CHECKOUT_POR_MINUTO,
            timeWindow: 60_000,
            keyGenerator: (req: FastifyRequest) => `checkout:${req.workspace ?? req.ip}`,
          },
        },
      },
      async (req) => {
        const { plano } = corpoDoCheckout.parse(req.body);
        return pagamentos.iniciarCheckout({ workspace: workspaceDe(req), plano });
      },
    );

    servidor.delete(
      ROTA_CANCELAR_RECORRENCIA,
      {
        config: {
          rateLimit: {
            max: LIMITE_DO_CANCELAMENTO_POR_MINUTO,
            timeWindow: 60_000,
            keyGenerator: (req: FastifyRequest) => `cancelar:${req.workspace ?? req.ip}`,
          },
        },
      },
      async (req) => ({ pagamento: await pagamentos.cancelarRecorrencia(workspaceDe(req)) }),
    );

    servidor.post<{ Querystring: Record<string, unknown>; Body: unknown }>(
      ROTA_WEBHOOK_DE_PAGAMENTO,
      {
        config: {
          rateLimit: {
            max: LIMITE_DO_WEBHOOK_POR_MINUTO,
            timeWindow: 60_000,
            // Por IP, sempre: o webhook não é de ninguém logado.
            keyGenerator: (req: FastifyRequest) => `webhook:${req.ip}`,
          },
        },
      },
      async (req, resposta) => {
        const corpo = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as {
          type?: unknown;
          topic?: unknown;
          data?: { id?: unknown };
        };
        // `data.id` da QUERY, como o gateway o assina; o corpo só entra se a query não o trouxe
        // (e, não sendo o que foi assinado, a conferência falha — nunca vira brecha).
        const idDoRecurso = texto(req.query['data.id']) ?? texto(corpo.data?.id);
        const evento = pagamentos.validarAviso({
          assinatura: texto(req.headers['x-signature']),
          idDaRequisicao: texto(req.headers['x-request-id']),
          idDoRecurso,
          topico: texto(req.query['type']) ?? texto(req.query['topic']) ?? texto(corpo.type) ?? texto(corpo.topic),
        });

        const trabalho = pagamentos.processarAviso(evento);
        const prazo = new Promise<'tempo'>((resolver) =>
          setTimeout(() => resolver('tempo'), PRAZO_PARA_RESPONDER_MS).unref(),
        );
        try {
          const quem = await Promise.race([trabalho.then(() => 'feito' as const), prazo]);
          if (quem === 'tempo') {
            // Segue em segundo plano; falha aqui só vai ao log (o gateway repete o aviso).
            trabalho.catch((erro: unknown) =>
              logger.warn('tratamento de aviso de pagamento falhou em segundo plano', {
                causa: erro instanceof Error ? erro.name : 'erro',
              }),
            );
          }
        } catch (erro) {
          // O gateway RECUSOU a consulta (id que não existe, aviso de teste): repetir não adianta, e
          // devolver erro faria o gateway insistir de 15 em 15 minutos. Indisponibilidade e erro nosso
          // sobem e viram 5xx — aí a repetição do gateway é exatamente o que queremos.
          if (erro instanceof GatewayDePagamentoRecusouError) {
            logger.warn('aviso de pagamento recusado na consulta: ignorado', {
              status: erro.status,
            });
            return resposta.code(200).send({ recebido: true, ignorado: true });
          }
          throw erro;
        }
        return resposta.code(200).send({ recebido: true });
      },
    );
  };
}
