import type { RespostaDoModeloDaSintese } from '../entities/AnaliseDoProcesso.js';

/**
 * Porta do modelo que CRUZA as análises de peça de um processo (v0.66.0). Recebe só itens curtos já
 * verificados da etapa 1, com marcadores — nunca texto de peça. O adaptador devolve a resposta dentro do
 * esquema fechado (Zod); a verificação é da aplicação. Toda a proteção do texto (ZDR falhando fechado,
 * `provider.only`, conferência do par modelo + provedor) mora no adaptador, na mesma peça comum das
 * outras funções de IA.
 *
 * Fora do esquema: UMA repetição e, se continuar, `RespostaInvalidaError` (sem texto na mensagem).
 */
export interface PedidoDeSintese {
  readonly sistema: string;
  readonly usuario: string;
  readonly sinal?: AbortSignal;
  /** Chamado a cada repetição automática. Só conta; nunca recebe texto. */
  readonly aoRepetir?: () => void;
}

export interface RespostaDoSintetizador {
  readonly resposta: RespostaDoModeloDaSintese;
  readonly modelo: string;
  readonly provedor: string;
  readonly tokensEntrada?: number;
  readonly tokensSaida?: number;
  readonly custoUsd?: number;
}

export interface SintetizadorDoProcesso {
  readonly nome: string;
  sintetizar(pedido: PedidoDeSintese): Promise<RespostaDoSintetizador>;
}
