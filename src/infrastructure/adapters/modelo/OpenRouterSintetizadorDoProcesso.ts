import { RespostaInvalidaError } from '../../../domain/errors/index.js';
import type {
  PedidoDeSintese,
  RespostaDoSintetizador,
  SintetizadorDoProcesso,
} from '../../../domain/ports/SintetizadorDoProcesso.js';
import { INSTRUCAO_DE_FORMATO_DA_SINTESE } from '../../../application/politicas/entradaDaSintese.js';
import { NOME_DO_OPENROUTER } from './endpointsZdr.js';
import { lerRespostaDaSintese } from './esquemaDaSintese.js';
import type { ExecutorDeModelo } from './ModeloComZdr.js';

export interface OpcoesDoSintetizadorOpenRouter {
  /**
   * A peça comum com ZDR, do MESMO modelo da análise de peça (a síntese segue a função `peca` no painel
   * na versão 1). Tudo o que protege o texto mora nela.
   */
  readonly modeloZdr: ExecutorDeModelo;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

/**
 * Sintetizador do processo sobre o OpenRouter. Só pede o formato e aplica o esquema fechado. Fora do
 * esquema: UMA repetição, sempre pela mesma `ModeloComZdr`, e então `RespostaInvalidaError` sem texto.
 */
export class OpenRouterSintetizadorDoProcesso implements SintetizadorDoProcesso {
  readonly nome = NOME_DO_OPENROUTER;

  constructor(private readonly o: OpcoesDoSintetizadorOpenRouter) {}

  async sintetizar(pedido: PedidoDeSintese): Promise<RespostaDoSintetizador> {
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      const r = await this.o.modeloZdr.executar({
        sistema: pedido.sistema,
        usuario: pedido.usuario,
        ...(pedido.sinal ? { sinal: pedido.sinal } : {}),
        ...(pedido.aoRepetir ? { aoRepetir: pedido.aoRepetir } : {}),
        instrucaoDeFormato: INSTRUCAO_DE_FORMATO_DA_SINTESE,
        maxTokens: this.o.maxTokens,
        timeoutMs: this.o.timeoutMs,
      });
      const lida = lerRespostaDaSintese(r.objeto);
      if (!lida && tentativa === 1) pedido.aoRepetir?.();
      if (lida) {
        return {
          resposta: lida,
          modelo: r.modelo,
          provedor: r.provedor,
          ...(r.tokensEntrada !== undefined ? { tokensEntrada: r.tokensEntrada } : {}),
          ...(r.tokensSaida !== undefined ? { tokensSaida: r.tokensSaida } : {}),
          ...(r.custoUsd !== undefined ? { custoUsd: r.custoUsd } : {}),
        };
      }
    }
    throw new RespostaInvalidaError(
      NOME_DO_OPENROUTER,
      'a resposta do modelo não cumpriu o esquema fechado',
    );
  }
}
