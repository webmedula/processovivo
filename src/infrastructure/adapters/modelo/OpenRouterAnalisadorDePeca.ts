import { RespostaInvalidaError } from '../../../domain/errors/index.js';
import type {
  AnalisadorDePeca,
  PedidoDeAnaliseDePeca,
  RespostaDoAnalisadorDePeca,
} from '../../../domain/ports/AnalisadorDePeca.js';
import { INSTRUCAO_DE_FORMATO_DA_PECA } from '../../../application/politicas/entradaDaPeca.js';
import { NOME_DO_OPENROUTER } from './endpointsZdr.js';
import { lerRespostaDaAnaliseDePeca } from './esquemaDaPeca.js';
import type { ModeloComZdr } from './ModeloComZdr.js';

export interface OpcoesDoAnalisadorDePecaOpenRouter {
  /**
   * A peça comum com ZDR, montada com o modelo das PEÇAS (`PROCESSOVIVO_IA_PECAS_MODELO`, ou o de
   * produção se vazio). Tudo o que protege o texto mora nela: modelo real (sem `~`/`:`), lista ZDR de
   * 24 h que falha fechada, `provider.only`, conferência do par modelo + provedor.
   */
  readonly modeloZdr: ModeloComZdr;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

/**
 * Analisador de peça sobre o OpenRouter. Aqui só se pede o formato e se aplica o esquema fechado.
 * Fora do esquema: UMA repetição (a saída de um modelo varia) e, se continuar, `RespostaInvalidaError`
 * sem texto de peça. A repetição NUNCA sai sem ZDR: passa de novo pela mesma `ModeloComZdr`.
 */
export class OpenRouterAnalisadorDePeca implements AnalisadorDePeca {
  readonly nome = NOME_DO_OPENROUTER;

  constructor(private readonly o: OpcoesDoAnalisadorDePecaOpenRouter) {}

  async analisar(pedido: PedidoDeAnaliseDePeca): Promise<RespostaDoAnalisadorDePeca> {
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      const r = await this.o.modeloZdr.executar({
        sistema: pedido.sistema,
        usuario: pedido.usuario,
        ...(pedido.sinal ? { sinal: pedido.sinal } : {}),
        ...(pedido.aoRepetir ? { aoRepetir: pedido.aoRepetir } : {}),
        instrucaoDeFormato: INSTRUCAO_DE_FORMATO_DA_PECA,
        maxTokens: this.o.maxTokens,
        timeoutMs: this.o.timeoutMs,
      });
      const lida = lerRespostaDaAnaliseDePeca(r.objeto);
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

  healthCheck(): Promise<boolean> {
    return this.o.modeloZdr.healthCheck();
  }
}
