import { createGateway, generateText, NoObjectGeneratedError, Output } from 'ai';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
  ZdrIndisponivelError,
} from '../../../domain/errors/index.js';
import { esquemaDaResposta } from './esquemaDaAnalise.js';

export const NOME_DO_TRANSPORTE_GATEWAY = 'ia-gateway';

/**
 * Transporte até o modelo de linguagem (porta de infraestrutura, injetável).
 *
 * Hoje há UMA implementação — o AI Gateway da Vercel, com retenção zero de dados
 * (ZDR). Um transporte direto (chave do provedor do modelo) cabe atrás desta
 * mesma interface, mas só será escrito quando existir uma razão para ele: código
 * sem uso é código sem teste.
 */
export interface PedidoAoModelo {
  readonly modelo: string;
  readonly sistema: string;
  readonly usuario: string;
}

export interface RoteamentoObservado {
  /** Quem de fato atendeu, quando o gateway informa. */
  readonly provedorFinal?: string;
  /** O objeto `routing` como o gateway devolveu (nomes de provedor e tempos; sem conteúdo). */
  readonly bruto?: unknown;
  readonly idDaGeracao?: string;
}

export interface RespostaDoTransporte {
  /** Saída estruturada do modelo, ainda como dado externo (`unknown`). */
  readonly objeto: unknown;
  readonly tokensEntrada?: number;
  readonly tokensSaida?: number;
  /** Custo em USD informado pelo gateway, quando informa. */
  readonly custoUsd?: number;
  readonly roteamento: RoteamentoObservado;
}

export interface TransporteDeModelo {
  readonly nome: string;
  gerar(pedido: PedidoAoModelo): Promise<RespostaDoTransporte>;
}

/** O que vai ao SDK. Existe como tipo próprio para o teste enxergar CADA chamada. */
export interface ChamadaAoSdk {
  readonly modelo: string;
  readonly sistema: string;
  readonly usuario: string;
  readonly temperatura: 0;
  readonly tentativasAutomaticas: 0;
  readonly timeoutMs: number;
  readonly providerOptions: { readonly gateway: { readonly zeroDataRetention: true } };
}

export interface ResultadoBrutoDoSdk {
  readonly objeto: unknown;
  readonly tokensEntrada?: number | undefined;
  readonly tokensSaida?: number | undefined;
  readonly metadadosDoGateway?: unknown;
}

export type ExecutorDoSdk = (chamada: ChamadaAoSdk) => Promise<ResultadoBrutoDoSdk>;

export interface OpcoesDoTransporteGateway {
  readonly chave: string;
  readonly timeoutMs?: number;
  /** Para teste. Em produção, o SDK. */
  readonly executar?: ExecutorDoSdk;
  /** Para teste de fio: intercepta o HTTP do SDK (o que de fato sai da máquina). */
  readonly fetch?: typeof fetch;
}

const TIMEOUT_PADRAO_MS = 60_000;

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function numero(valor: unknown): number | undefined {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : undefined;
}

/** O custo pode vir como número ou como texto numérico ("0.0003"); o formato real não foi observado. */
function numeroOuTexto(valor: unknown): number | undefined {
  if (typeof valor === 'string' && valor.trim() !== '') return numero(Number(valor));
  return numero(valor);
}

function executorPadrao(chave: string, fetchImpl?: typeof fetch): ExecutorDoSdk {
  const gateway = createGateway({
    apiKey: chave,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return async (chamada) => {
    const resultado = await generateText({
      model: gateway(chamada.modelo),
      system: chamada.sistema,
      prompt: chamada.usuario,
      output: Output.object({ schema: esquemaDaResposta }),
      temperature: chamada.temperatura,
      // Nenhuma repetição escondida no SDK: cada tentativa é decisão nossa e
      // sempre passa por aqui, com a ZDR.
      maxRetries: chamada.tentativasAutomaticas,
      timeout: chamada.timeoutMs,
      providerOptions: chamada.providerOptions,
    });
    return {
      objeto: resultado.output,
      tokensEntrada: resultado.usage?.inputTokens,
      tokensSaida: resultado.usage?.outputTokens,
      metadadosDoGateway: resultado.providerMetadata?.['gateway'],
    };
  };
}

/** `no_providers_available` não tem classe própria no SDK: lê-se o texto, sem copiá-lo. */
function indicaSemProvedorComZdr(erro: unknown): boolean {
  const partes: string[] = [];
  let atual: unknown = erro;
  for (let i = 0; i < 4 && atual !== undefined && atual !== null; i++) {
    if (atual instanceof Error) partes.push(atual.message);
    if (ehObjeto(atual)) {
      for (const campo of ['type', 'code', 'data', 'responseBody']) {
        const v = atual[campo];
        if (typeof v === 'string') partes.push(v);
        else if (v !== undefined) {
          try {
            partes.push(JSON.stringify(v));
          } catch {
            /* valor não serializável: ignora */
          }
        }
      }
    }
    atual = ehObjeto(atual) ? atual['cause'] : undefined;
  }
  return /no_providers_available|zero.?data.?retention/i.test(partes.join(' '));
}

function statusDe(erro: unknown): number | undefined {
  return ehObjeto(erro) ? numero(erro['statusCode']) : undefined;
}

/**
 * Traduz o erro do SDK para erro de domínio. NUNCA copia a mensagem original: o
 * erro de um gateway pode ecoar trecho do pedido, e o pedido leva texto de ato.
 */
function traduzirErro(erro: unknown, modelo: string): Error {
  if (NoObjectGeneratedError.isInstance(erro)) {
    return new RespostaInvalidaError(
      NOME_DO_TRANSPORTE_GATEWAY,
      'a resposta do modelo não cumpriu o esquema fechado',
    );
  }
  const status = statusDe(erro);
  if (status === 400 && indicaSemProvedorComZdr(erro)) {
    return new ZdrIndisponivelError(NOME_DO_TRANSPORTE_GATEWAY, modelo);
  }
  if (
    erro instanceof Error &&
    (erro.name === 'TimeoutError' || erro.name === 'AbortError')
  ) {
    return new ProviderIndisponivelError(NOME_DO_TRANSPORTE_GATEWAY, 'tempo esgotado');
  }
  const motivo =
    status === 401 || status === 403
      ? `chave do gateway recusada (HTTP ${status})`
      : status === 429
        ? 'limite de requisições do gateway (HTTP 429)'
        : status !== undefined
          ? `o gateway respondeu HTTP ${status}`
          : 'falha de rede ao chamar o gateway';
  return new ProviderIndisponivelError(NOME_DO_TRANSPORTE_GATEWAY, motivo);
}

function roteamentoDe(metadados: unknown): RoteamentoObservado {
  if (!ehObjeto(metadados)) return {};
  const routing = metadados['routing'];
  const provedorFinal =
    ehObjeto(routing) && typeof routing['finalProvider'] === 'string'
      ? routing['finalProvider']
      : undefined;
  const idDaGeracao =
    typeof metadados['generationId'] === 'string' ? metadados['generationId'] : undefined;
  return {
    ...(provedorFinal !== undefined ? { provedorFinal } : {}),
    ...(routing !== undefined ? { bruto: routing } : {}),
    ...(idDaGeracao !== undefined ? { idDaGeracao } : {}),
  };
}

/**
 * AI Gateway da Vercel com ZDR POR REQUISIÇÃO.
 *
 * `zeroDataRetention: true` é fixo em `montarChamada` e não há parâmetro, flag nem
 * variável que o desligue — esta classe não sabe fazer chamada sem ZDR. Se a ZDR
 * não puder ser cumprida o gateway devolve `no_providers_available` (HTTP 400),
 * que vira `ZdrIndisponivelError` e NÃO é repetido: a política é falhar fechado.
 */
export class TransporteGateway implements TransporteDeModelo {
  readonly nome = NOME_DO_TRANSPORTE_GATEWAY;
  private readonly executar: ExecutorDoSdk;
  private readonly timeoutMs: number;

  constructor(opcoes: OpcoesDoTransporteGateway) {
    this.executar = opcoes.executar ?? executorPadrao(opcoes.chave, opcoes.fetch);
    this.timeoutMs = opcoes.timeoutMs ?? TIMEOUT_PADRAO_MS;
  }

  async gerar(pedido: PedidoAoModelo): Promise<RespostaDoTransporte> {
    const chamada = this.montarChamada(pedido);
    exigirZdr(chamada);
    let bruto: ResultadoBrutoDoSdk;
    try {
      bruto = await this.executar(chamada);
    } catch (erro) {
      throw traduzirErro(erro, pedido.modelo);
    }
    const metadados = bruto.metadadosDoGateway;
    const custoUsd = ehObjeto(metadados) ? numeroOuTexto(metadados['cost']) : undefined;
    return {
      objeto: bruto.objeto,
      ...(bruto.tokensEntrada !== undefined
        ? { tokensEntrada: bruto.tokensEntrada }
        : {}),
      ...(bruto.tokensSaida !== undefined ? { tokensSaida: bruto.tokensSaida } : {}),
      ...(custoUsd !== undefined ? { custoUsd } : {}),
      roteamento: roteamentoDe(metadados),
    };
  }

  private montarChamada(pedido: PedidoAoModelo): ChamadaAoSdk {
    return {
      modelo: pedido.modelo,
      sistema: pedido.sistema,
      usuario: pedido.usuario,
      temperatura: 0,
      tentativasAutomaticas: 0,
      timeoutMs: this.timeoutMs,
      providerOptions: { gateway: { zeroDataRetention: true } },
    };
  }
}

/**
 * Cinto e suspensório: o tipo já impede, e esta checagem impede também um
 * `as` futuro. Sem ZDR confirmada, nada sai.
 */
export function exigirZdr(chamada: ChamadaAoSdk): void {
  if ((chamada.providerOptions?.gateway?.zeroDataRetention as unknown) !== true) {
    throw new ProviderIndisponivelError(
      NOME_DO_TRANSPORTE_GATEWAY,
      'chamada recusada: a retenção zero (ZDR) não está ativa neste pedido',
    );
  }
}
