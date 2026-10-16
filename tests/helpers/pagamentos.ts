import type { FastifyInstance } from 'fastify';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Config } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { GatewayFalso } from '../../src/infrastructure/adapters/pagamento/GatewayFalso.js';
import { aplicacaoDeTeste, NotificadorEspiao } from './aplicacao.js';
import type { OpcoesAplicacaoDeTeste } from './aplicacao.js';
import { ProviderFalso } from './fabricas.js';

/** Tudo sintético: nenhum e-mail, token ou id de pagamento aqui é real. */
export const SENHA = 'uma-senha-boa-o-bastante';
export const CHAVE_DE_API = 'chave-de-api-sintetica-1234567890';
export const URL_BASE = 'https://app.exemplo.test';

export function configDePagamento(extra: Record<string, string> = {}): Config {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: CHAVE_DE_API,
    CACHE_ENABLED: 'false',
    COOKIE_SECURE: 'false',
    RATE_LIMIT_MAX: '100000',
    ...extra,
  } as NodeJS.ProcessEnv);
}

export interface CenarioDePagamento {
  readonly servidor: FastifyInstance;
  readonly app: Aplicacao;
  readonly gateway: GatewayFalso;
  readonly notificador: NotificadorEspiao;
  /** Hora "agora" do teste; mexa em `relogio.agora` para andar no tempo. */
  readonly relogio: { agora: Date };
}

export function montarCenarioDePagamento(
  opcoes: Partial<OpcoesAplicacaoDeTeste> & {
    comPagamento?: boolean;
    gerarReferencia?: () => string;
    emailDoOperador?: string;
  } = {},
): CenarioDePagamento {
  const relogio = { agora: new Date('2026-10-20T12:00:00.000Z') };
  const gateway = new GatewayFalso({
    clock: { agora: () => relogio.agora, monotonico: () => 0 },
  });
  const notificador = new NotificadorEspiao();
  const { comPagamento = true, gerarReferencia, emailDoOperador, ...resto } = opcoes;
  let n = 0;
  const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    notificador,
    agora: () => relogio.agora,
    ...(comPagamento
      ? {
          pagamentos: {
            gateway,
            urlBase: URL_BASE,
            gerarReferencia: gerarReferencia ?? ((): string => `ref-sintetica-${++n}`),
            ...(emailDoOperador ? { emailDoOperador } : {}),
          },
        }
      : {}),
    ...resto,
  });
  const servidor = construirServidor(app, configDePagamento());
  return { servidor, app, gateway, notificador, relogio };
}

export function cookieDe(resposta: { headers: Record<string, unknown> }): string {
  const bruto = resposta.headers['set-cookie'];
  const linha = Array.isArray(bruto) ? bruto[0] : bruto;
  return String(linha ?? '').split(';')[0] ?? '';
}

/** Cria uma conta com e-mail (sintético) e devolve o cookie dela e o workspace. */
export async function cadastrar(
  c: CenarioDePagamento,
  email: string,
): Promise<{ cookie: string; workspace: string }> {
  const r = await c.servidor.inject({
    method: 'POST',
    url: '/v1/contas',
    payload: { nome: 'Pessoa Sintética', email, senha: SENHA },
  });
  const usuario = await c.app.usuarios.porEmail(email);
  return { cookie: cookieDe(r), workspace: usuario!.usuario.workspace };
}

/** Define preço (em centavos) e põe o plano à venda — pelo serviço, como o /admin faria. */
export async function precificar(
  c: CenarioDePagamento,
  codigo: string,
  precoMensalCentavos: number | null,
  aVenda = true,
): Promise<void> {
  await c.app.planos.atualizar(codigo, {
    precoMensalCentavos,
    disponivelParaContratacao: aVenda,
  });
}

/** O POST do aviso, como o gateway o faria: assinado, `data.id` na query, `type` na query. */
export function avisar(
  c: CenarioDePagamento,
  opcoes: {
    topico: 'subscription_preapproval' | 'subscription_authorized_payment' | 'payment';
    id: string;
    idDaRequisicao?: string;
    assinatura?: string | null;
    ts?: number;
  },
): Promise<{ statusCode: number; json(): unknown }> {
  const idDaRequisicao = opcoes.idDaRequisicao ?? 'req-sintetico-1';
  const assinatura =
    opcoes.assinatura === undefined
      ? c.gateway.assinarAviso({
          idDoRecurso: opcoes.id,
          idDaRequisicao,
          ...(opcoes.ts !== undefined ? { ts: opcoes.ts } : {}),
        })
      : opcoes.assinatura;
  return c.servidor.inject({
    method: 'POST',
    url: `/v1/pagamentos/webhook/mercadopago?data.id=${encodeURIComponent(opcoes.id)}&type=${opcoes.topico}`,
    headers: {
      ...(assinatura !== null ? { 'x-signature': assinatura } : {}),
      'x-request-id': idDaRequisicao,
    },
    payload: { type: opcoes.topico, data: { id: opcoes.id } },
  });
}

/**
 * O JSON de uma resposta, para o teste navegar nele (`json(r)['pagamento'].recorrencia.estado`). É a ÚNICA
 * exceção ao "sem `any`" nestes testes e fica aqui, num lugar só: o que se confere é o formato de saída
 * da API, que o teste afirma campo a campo logo em seguida — o contrário do dado externo que entra no
 * sistema, esse sim validado com Zod.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Dados = any;
export const json = (r: { json(): unknown }): Dados => r.json() as Dados;
