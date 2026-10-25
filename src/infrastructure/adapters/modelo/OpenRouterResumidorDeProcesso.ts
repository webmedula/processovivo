import { RespostaInvalidaError } from '../../../domain/errors/index.js';
import type {
  PedidoDeResumo,
  RespostaDoResumidor,
  ResumidorDeProcesso,
} from '../../../domain/ports/ResumidorDeProcesso.js';
import { NOME_DO_OPENROUTER } from './endpointsZdr.js';
import {
  INSTRUCAO_DE_FORMATO_DO_RESUMO,
  lerRespostaDoResumo,
} from './esquemaDoResumo.js';
import type { ExecutorDeModelo } from './ModeloComZdr.js';

export interface OpcoesDoResumidorOpenRouter {
  /** A MESMA peça comum do analisador de ato: uma lista ZDR e as mesmas travas para os dois. */
  readonly modeloZdr: ExecutorDeModelo;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

/**
 * Resumidor de processo sobre o OpenRouter. Toda a proteção do texto (modelo real, lista ZDR
 * que falha fechada, `provider.only`, conferência do par modelo + provedor) está em
 * `ModeloComZdr`; aqui só se pede o formato do resumo e se aplica o esquema fechado.
 */
export class OpenRouterResumidorDeProcesso implements ResumidorDeProcesso {
  readonly nome = NOME_DO_OPENROUTER;

  constructor(private readonly o: OpcoesDoResumidorOpenRouter) {}

  async resumir(pedido: PedidoDeResumo): Promise<RespostaDoResumidor> {
    const r = await this.o.modeloZdr.executar({
      sistema: pedido.sistema,
      usuario: pedido.usuario,
      ...(pedido.sinal ? { sinal: pedido.sinal } : {}),
      ...(pedido.aoRepetir ? { aoRepetir: pedido.aoRepetir } : {}),
      instrucaoDeFormato: INSTRUCAO_DE_FORMATO_DO_RESUMO,
      maxTokens: this.o.maxTokens,
      timeoutMs: this.o.timeoutMs,
    });
    const lida = lerRespostaDoResumo(r.objeto);
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

  healthCheck(): Promise<boolean> {
    return this.o.modeloZdr.healthCheck();
  }
}
