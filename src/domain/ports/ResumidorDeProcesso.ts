import type { RespostaDoModeloResumo } from '../entities/vocabularioDoResumo.js';

/**
 * Porta do modelo de linguagem que resume UM processo (v0.40.0). Irmã de `AnalisadorDeAto`: o
 * texto que chega já foi redigido (sem nomes, documentos e contatos) e limitado a um
 * orçamento; o adaptador não decide o que enviar, só como — e se não houver como enviar com
 * retenção zero, não envia.
 */
export interface PedidoDeResumo {
  readonly sistema: string;
  readonly usuario: string;
  /** Aborta a chamada em curso (a pessoa cancelou ou o tempo acabou). */
  readonly sinal?: AbortSignal;
}

export interface RespostaDoResumidor {
  /** Já dentro do esquema fechado; a verificação item a item vem depois. */
  readonly resposta: RespostaDoModeloResumo;
  /** O modelo que a resposta diz ter servido. */
  readonly modelo: string;
  /** O provedor que atendeu. */
  readonly provedor: string;
  readonly tokensEntrada?: number;
  readonly tokensSaida?: number;
  readonly custoUsd?: number;
}

export interface ResumidorDeProcesso {
  readonly nome: string;
  /**
   * Lança SOMENTE erros de domínio: `ProviderIndisponivelError` (rede, tempo, ZDR indisponível,
   * provedor fora do conjunto permitido) ou `RespostaInvalidaError`.
   */
  resumir(pedido: PedidoDeResumo): Promise<RespostaDoResumidor>;
  /** Nunca lança: modelo/lista ZDR inalcançáveis devolvem `false`. */
  healthCheck(): Promise<boolean>;
}
