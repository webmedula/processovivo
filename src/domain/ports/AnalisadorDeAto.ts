import type { RespostaDoModelo } from '../entities/vocabularioDaAnalise.js';

/**
 * Porta do modelo de linguagem que lê UM ato. O texto que chega aqui já foi
 * redigido (sem nomes, documentos e contatos) e truncado: o adaptador não decide
 * o que enviar, só como enviar — e se não houver como enviar com retenção zero,
 * não envia.
 */
export interface PedidoDeAnalise {
  readonly sistema: string;
  readonly usuario: string;
  /** Aborta a chamada em curso (a pessoa cancelou ou o tempo acabou). */
  readonly sinal?: AbortSignal;
  /** Chamado a cada repetição automática da chamada (painel de IA, v0.58.0). Só conta; nunca recebe texto. */
  readonly aoRepetir?: () => void;
}

export interface RespostaDoAnalisador {
  /** Já dentro do esquema fechado; a verificação das citações vem depois. */
  readonly resposta: RespostaDoModelo;
  /** O modelo que a resposta diz ter servido. */
  readonly modelo: string;
  /** O provedor que atendeu. */
  readonly provedor: string;
  readonly tokensEntrada?: number;
  readonly tokensSaida?: number;
  readonly custoUsd?: number;
}

export interface AnalisadorDeAto {
  readonly nome: string;
  /**
   * Lança SOMENTE erros de domínio: `ProviderIndisponivelError` (rede, tempo,
   * ZDR indisponível, provedor fora do conjunto permitido) ou `RespostaInvalidaError`.
   */
  analisar(pedido: PedidoDeAnalise): Promise<RespostaDoAnalisador>;
  /** Nunca lança: modelo/lista ZDR inalcançáveis devolvem `false`. */
  healthCheck(): Promise<boolean>;
}
