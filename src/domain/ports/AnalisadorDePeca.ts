import type { RespostaDoModeloDePeca } from '../entities/AnaliseDePeca.js';

/**
 * Porta do modelo que lê UMA peça (v0.55.0). O adaptador devolve a resposta já dentro do esquema
 * fechado (Zod); a verificação determinística é da aplicação. Toda a proteção do texto (ZDR falhando
 * fechado, `provider.only`, conferência do par modelo + provedor) mora no adaptador — a aplicação
 * não tem como chamar o modelo sem ela.
 *
 * Fora do esquema: o adaptador repete UMA vez e, se continuar, lança `RespostaInvalidaError`
 * (sem texto de peça na mensagem).
 */
export interface PedidoDeAnaliseDePeca {
  readonly sistema: string;
  readonly usuario: string;
  readonly sinal?: AbortSignal;
  /** Chamado a cada repetição automática da chamada (painel de IA, v0.58.0). Só conta; nunca recebe texto. */
  readonly aoRepetir?: () => void;
}

export interface RespostaDoAnalisadorDePeca {
  readonly resposta: RespostaDoModeloDePeca;
  readonly modelo: string;
  readonly provedor: string;
  readonly tokensEntrada?: number;
  readonly tokensSaida?: number;
  readonly custoUsd?: number;
}

export interface AnalisadorDePeca {
  readonly nome: string;
  analisar(pedido: PedidoDeAnaliseDePeca): Promise<RespostaDoAnalisadorDePeca>;
  healthCheck(): Promise<boolean>;
}
