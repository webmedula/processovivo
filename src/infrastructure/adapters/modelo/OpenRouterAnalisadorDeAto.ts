import { RespostaInvalidaError } from '../../../domain/errors/index.js';
import type {
  AnalisadorDeAto,
  PedidoDeAnalise,
  RespostaDoAnalisador,
} from '../../../domain/ports/AnalisadorDeAto.js';
import { lerRespostaDoModelo } from './esquemaDaAnalise.js';
import { NOME_DO_OPENROUTER } from './endpointsZdr.js';
import {
  ModeloComZdr,
  TTL_DA_LISTA_ZDR_MS,
  type ExecutorDeModelo,
  type OpcoesDoModeloComZdr,
} from './ModeloComZdr.js';

export { TTL_DA_LISTA_ZDR_MS };

/**
 * Ou as opções para montar a peça comum, ou a peça comum já montada (v0.40.0): o composition
 * root passa a MESMA instância ao resumidor de processo, para os dois dividirem uma lista ZDR
 * só.
 */
export type OpcoesDoAnalisadorOpenRouter =
  OpcoesDoModeloComZdr | { readonly modeloZdr: ExecutorDeModelo };

/**
 * Adaptador de análise de ato sobre o OpenRouter. A ZDR falha FECHADA e não tem chave
 * de desligar: sem lista, sem provedor permitido ou com resposta de provedor fora do
 * conjunto, o texto não é enviado — ou a resposta é descartada. Tudo isso mora em
 * `ModeloComZdr`; aqui só se aplica o esquema fechado do ato.
 */
export class OpenRouterAnalisadorDeAto implements AnalisadorDeAto {
  readonly nome = NOME_DO_OPENROUTER;
  private readonly modelo: ExecutorDeModelo;

  constructor(o: OpcoesDoAnalisadorOpenRouter) {
    this.modelo = 'modeloZdr' in o ? o.modeloZdr : new ModeloComZdr(o);
  }

  async analisar(pedido: PedidoDeAnalise): Promise<RespostaDoAnalisador> {
    const r = await this.modelo.executar({
      sistema: pedido.sistema,
      usuario: pedido.usuario,
      ...(pedido.sinal ? { sinal: pedido.sinal } : {}),
      ...(pedido.aoRepetir ? { aoRepetir: pedido.aoRepetir } : {}),
    });
    const lida = lerRespostaDoModelo(r.objeto);
    if (!lida) {
      throw new RespostaInvalidaError(
        NOME_DO_OPENROUTER,
        'a resposta do modelo não cumpriu o esquema fechado',
      );
    }
    return {
      resposta: lida,
      modelo: r.modelo,
      provedor: r.provedor,
      ...(r.tokensEntrada !== undefined ? { tokensEntrada: r.tokensEntrada } : {}),
      ...(r.tokensSaida !== undefined ? { tokensSaida: r.tokensSaida } : {}),
      ...(r.custoUsd !== undefined ? { custoUsd: r.custoUsd } : {}),
    };
  }

  /** Nunca lança. Verdadeiro = a lista ZDR é alcançável e o modelo tem provedor permitido. */
  healthCheck(): Promise<boolean> {
    return this.modelo.healthCheck();
  }
}
