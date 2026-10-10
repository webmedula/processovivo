import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { APICallError, generateText, NoObjectGeneratedError, Output } from 'ai';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
  ZdrIndisponivelError,
} from '../../../domain/errors/index.js';
import { esquemaDaResposta } from './esquemaDaAnalise.js';
import { NOME_DO_OPENROUTER } from './endpointsZdr.js';

/**
 * Transporte até o modelo de linguagem (infraestrutura, injetável): o OpenRouter, com
 * retenção zero de dados (ZDR) em TODA chamada.
 *
 * Um transporte direto (chave do provedor do modelo) caberia atrás da mesma interface,
 * mas só será escrito quando houver uma razão: código sem uso é código sem teste.
 */
export interface PedidoAoModelo {
  readonly modelo: string;
  readonly sistema: string;
  readonly usuario: string;
}

export interface RespostaDoTransporte {
  /** Saída estruturada do modelo, ainda como dado externo (`unknown`). */
  readonly objeto: unknown;
  /** Quem de fato serviu a chamada, como a resposta informa. Vazio/ausente = desconhecido. */
  readonly provedor?: string;
  readonly tokensEntrada?: number;
  readonly tokensSaida?: number;
  /** `usage.cost` da resposta (créditos do OpenRouter = USD), quando vem. */
  readonly custoUsd?: number;
}

export interface TransporteDeModelo {
  readonly nome: string;
  gerar(pedido: PedidoAoModelo): Promise<RespostaDoTransporte>;
}

/**
 * As preferências de roteamento, FIXAS. `zdr` restringe o roteamento a endpoints com
 * retenção zero; `data_collection: 'deny'` exclui quem guarda dado para treino;
 * `require_parameters` só admite endpoint que cumpra a saída estruturada (sem isso o
 * esquema fechado poderia ser ignorado em silêncio); `allow_fallbacks: false` porque a
 * documentação consultada não afirma que os provedores de reserva respeitem a ZDR.
 */
export interface PreferenciasDeProvedor {
  readonly zdr: true;
  readonly data_collection: 'deny';
  readonly allow_fallbacks: false;
  readonly require_parameters: true;
}

export const PREFERENCIAS_DE_PROVEDOR: PreferenciasDeProvedor = Object.freeze({
  zdr: true,
  data_collection: 'deny',
  allow_fallbacks: false,
  require_parameters: true,
});

/** O que vai ao SDK. Tipo próprio para o teste enxergar CADA chamada. */
export interface ChamadaAoSdk {
  readonly modelo: string;
  readonly sistema: string;
  readonly usuario: string;
  readonly temperatura: 0;
  readonly tentativasAutomaticas: 0;
  readonly timeoutMs: number;
  readonly provider: PreferenciasDeProvedor;
}

export interface ResultadoBrutoDoSdk {
  readonly objeto: unknown;
  readonly provedor?: string | undefined;
  readonly tokensEntrada?: number | undefined;
  readonly tokensSaida?: number | undefined;
  readonly custoUsd?: number | undefined;
}

export type ExecutorDoSdk = (chamada: ChamadaAoSdk) => Promise<ResultadoBrutoDoSdk>;

/** Status e corpo do erro do OpenRouter. SÓ para o teste de falha fechada, com texto sintético. */
export interface DetalheDeErro {
  readonly status?: number;
  readonly corpo?: string;
}

export interface OpcoesDoTransporteOpenRouter {
  readonly chave: string;
  readonly timeoutMs?: number;
  /** Para teste. Em produção, o SDK. */
  readonly executar?: ExecutorDoSdk;
  /** Para teste de fio: intercepta o HTTP do SDK (o que de fato sai da máquina). */
  readonly fetch?: typeof fetch;
  /** Esperas antes da 2ª e da 3ª tentativas (só 429/5xx/rede). Padrão 1 s e 3 s. */
  readonly esperasEntreTentativasMs?: readonly [number, number];
  readonly dormir?: (ms: number) => Promise<void>;
  /** Recebe status e corpo de cada erro. Nunca ligado numa rodada com caso real. */
  readonly aoFalhar?: (detalhe: DetalheDeErro) => void;
}

const TIMEOUT_PADRAO_MS = 60_000;
const ESPERAS_PADRAO_MS = [1_000, 3_000] as const;

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function numero(valor: unknown): number | undefined {
  const n = typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : valor;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function executorPadrao(chave: string, fetchImpl?: typeof fetch): ExecutorDoSdk {
  const openrouter = createOpenRouter({
    apiKey: chave,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return async (chamada) => {
    const resultado = await generateText({
      model: openrouter.chat(chamada.modelo, { provider: { ...chamada.provider } }),
      system: chamada.sistema,
      prompt: chamada.usuario,
      output: Output.object({ schema: esquemaDaResposta }),
      temperature: chamada.temperatura,
      // Nenhuma repetição escondida no SDK: cada tentativa é decisão nossa e passa
      // por `montarChamada`, sempre com a ZDR.
      maxRetries: chamada.tentativasAutomaticas,
      timeout: chamada.timeoutMs,
    });
    const meta = ehObjeto(resultado.providerMetadata)
      ? resultado.providerMetadata['openrouter']
      : undefined;
    const provedor =
      ehObjeto(meta) && typeof meta['provider'] === 'string'
        ? meta['provider']
        : undefined;
    const uso = ehObjeto(meta) ? meta['usage'] : undefined;
    return {
      objeto: resultado.output,
      provedor,
      tokensEntrada: resultado.usage?.inputTokens,
      tokensSaida: resultado.usage?.outputTokens,
      custoUsd: ehObjeto(uso) ? numero(uso['cost']) : undefined,
    };
  };
}

/**
 * "Sem provedor que atenda" — o texto exato do OpenRouter NÃO está na documentação
 * consultada; a classificação é por status (400/404) E por frase, e a falha de
 * classificação é segura: o erro cai em "indisponível", que também NÃO repete.
 */
const SEM_PROVEDOR =
  /no endpoints found|no allowed providers|no provider|zero.?data.?retention|\bzdr\b|data.?polic|provider.?routing|requirements/i;

export function indicaSemProvedorZdr(status: number | undefined, corpo: string): boolean {
  return (status === 404 || status === 400) && SEM_PROVEDOR.test(corpo);
}

function statusDe(erro: unknown): number | undefined {
  if (APICallError.isInstance(erro)) return erro.statusCode;
  return ehObjeto(erro) ? numero(erro['statusCode']) : undefined;
}

function corpoDe(erro: unknown): string {
  if (APICallError.isInstance(erro)) return erro.responseBody ?? '';
  return ehObjeto(erro) && typeof erro['responseBody'] === 'string'
    ? erro['responseBody']
    : '';
}

/** Erro que vale NOVA tentativa (com a mesma ZDR): limite de taxa, 5xx, rede, tempo. */
function ehTransitorio(erro: unknown): boolean {
  const status = statusDe(erro);
  if (status !== undefined) return status === 429 || status >= 500;
  // Sem status: rede ou tempo esgotado. Esquema inválido NÃO é transitório.
  return !NoObjectGeneratedError.isInstance(erro);
}

/**
 * Traduz o erro do SDK para erro de domínio. NUNCA copia a mensagem nem o corpo
 * originais: o erro de um roteador pode ecoar trecho do pedido, e o pedido leva texto de ato.
 */
function traduzirErro(erro: unknown, modelo: string): Error {
  if (NoObjectGeneratedError.isInstance(erro)) {
    return new RespostaInvalidaError(
      NOME_DO_OPENROUTER,
      'a resposta do modelo não cumpriu o esquema fechado',
    );
  }
  const status = statusDe(erro);
  if (indicaSemProvedorZdr(status, corpoDe(erro))) {
    return new ZdrIndisponivelError(NOME_DO_OPENROUTER, modelo);
  }
  if (
    erro instanceof Error &&
    (erro.name === 'TimeoutError' || erro.name === 'AbortError')
  ) {
    return new ProviderIndisponivelError(NOME_DO_OPENROUTER, 'tempo esgotado');
  }
  const motivo =
    status === 401 || status === 403
      ? `chave recusada (HTTP ${status})`
      : status === 402
        ? 'sem créditos ou limite de gasto da chave atingido (HTTP 402)'
        : status === 429
          ? 'limite de requisições (HTTP 429)'
          : status !== undefined
            ? `o OpenRouter respondeu HTTP ${status}`
            : 'falha de rede ao chamar o OpenRouter';
  return new ProviderIndisponivelError(NOME_DO_OPENROUTER, motivo);
}

export class TransporteOpenRouter implements TransporteDeModelo {
  readonly nome = NOME_DO_OPENROUTER;
  private readonly executar: ExecutorDoSdk;
  private readonly timeoutMs: number;
  private readonly esperas: readonly [number, number];
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly aoFalhar: ((d: DetalheDeErro) => void) | undefined;

  constructor(opcoes: OpcoesDoTransporteOpenRouter) {
    this.executar = opcoes.executar ?? executorPadrao(opcoes.chave, opcoes.fetch);
    this.timeoutMs = opcoes.timeoutMs ?? TIMEOUT_PADRAO_MS;
    this.esperas = opcoes.esperasEntreTentativasMs ?? ESPERAS_PADRAO_MS;
    this.dormir = opcoes.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.aoFalhar = opcoes.aoFalhar;
  }

  async gerar(pedido: PedidoAoModelo): Promise<RespostaDoTransporte> {
    let ultimo: unknown;
    // 1 tentativa + no máximo 2 repetições, todas com a MESMA chamada, portanto com a ZDR.
    for (let tentativa = 0; tentativa <= this.esperas.length; tentativa++) {
      const chamada = this.montarChamada(pedido);
      exigirZdr(chamada);
      try {
        const bruto = await this.executar(chamada);
        return {
          objeto: bruto.objeto,
          ...(bruto.provedor !== undefined ? { provedor: bruto.provedor } : {}),
          ...(bruto.tokensEntrada !== undefined
            ? { tokensEntrada: bruto.tokensEntrada }
            : {}),
          ...(bruto.tokensSaida !== undefined ? { tokensSaida: bruto.tokensSaida } : {}),
          ...(bruto.custoUsd !== undefined ? { custoUsd: bruto.custoUsd } : {}),
        };
      } catch (erro) {
        ultimo = erro;
        const status = statusDe(erro);
        this.aoFalhar?.({
          ...(status !== undefined ? { status } : {}),
          corpo: corpoDe(erro),
        });
        const traduzido = traduzirErro(erro, pedido.modelo);
        const podeRepetir =
          ehTransitorio(erro) &&
          !(traduzido instanceof ZdrIndisponivelError) &&
          tentativa < this.esperas.length;
        if (!podeRepetir) throw traduzido;
        await this.dormir(this.esperas[tentativa] ?? 0);
      }
    }
    throw traduzirErro(ultimo, pedido.modelo);
  }

  private montarChamada(pedido: PedidoAoModelo): ChamadaAoSdk {
    return {
      modelo: pedido.modelo,
      sistema: pedido.sistema,
      usuario: pedido.usuario,
      temperatura: 0,
      tentativasAutomaticas: 0,
      timeoutMs: this.timeoutMs,
      provider: PREFERENCIAS_DE_PROVEDOR,
    };
  }
}

/**
 * Cinto e suspensório: o tipo já impede, e esta checagem impede também um `as` futuro.
 * Sem `provider.zdr === true` (e `data_collection: 'deny'`), nada sai — a exceção é
 * lançada ANTES de qualquer rede.
 */
export function exigirZdr(chamada: ChamadaAoSdk): void {
  const p = chamada.provider as unknown;
  if (!ehObjeto(p) || p['zdr'] !== true || p['data_collection'] !== 'deny') {
    throw new ProviderIndisponivelError(
      NOME_DO_OPENROUTER,
      'chamada recusada: a retenção zero (provider.zdr) não está ativa neste pedido',
    );
  }
}
