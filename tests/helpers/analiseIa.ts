import type {
  AnalisadorDeAto,
  PedidoDeAnalise,
  RespostaDoAnalisador,
} from '../../src/domain/ports/AnalisadorDeAto.js';
import type { Logger } from '../../src/domain/ports/Logger.js';
import type { RespostaDoModelo } from '../../src/domain/entities/vocabularioDaAnalise.js';

/** Texto de ato SINTÉTICO (nomes e números inventados), com mais de 80 caracteres úteis. */
export const NOME_DA_PARTE = 'Mariana Teixeira Albuquerque';
export const TEXTO_DO_ATO = `Intime-se a parte autora, ${NOME_DA_PARTE}, para que se manifeste sobre o laudo pericial juntado aos autos, sob pena de preclusão. Telefone para contato: (62) 98765-4321.`;
export const TRECHO_NO_ATO = 'se manifeste sobre o laudo pericial';

/** Resposta do modelo ESCRITA À MÃO (nenhuma gravada de servidor). */
export function respostaValida(
  sobrescrever: Partial<RespostaDoModelo> = {},
): RespostaDoModelo {
  return {
    parece_pedir: 'manifestar',
    resumo: '[PARTE A] deve se manifestar sobre o laudo pericial.',
    trecho_chave: TRECHO_NO_ATO,
    acoes_possiveis: [
      { acao: 'Manifestar-se sobre o laudo pericial', trecho: TRECHO_NO_ATO },
    ],
    pontos_de_atencao: ['conferir_prazo_no_processo'],
    ...sobrescrever,
  };
}

/** Dublê do analisador: registra cada pedido e devolve (ou lança) o que o teste mandar. */
export class AnalisadorFalso implements AnalisadorDeAto {
  readonly nome = 'falso';
  readonly pedidos: PedidoDeAnalise[] = [];
  resposta: () => Promise<RespostaDoAnalisador> = async () => ({
    resposta: respostaValida(),
    modelo: 'modelo/teste',
    provedor: 'provedor-teste',
    tokensEntrada: 400,
    tokensSaida: 90,
    custoUsd: 0.0002,
  });

  async analisar(pedido: PedidoDeAnalise): Promise<RespostaDoAnalisador> {
    this.pedidos.push(pedido);
    return this.resposta();
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  get chamadas(): number {
    return this.pedidos.length;
  }
}

/** Logger que guarda tudo, para provar que nenhum texto de ato chega ao log. */
export class LoggerColetor implements Logger {
  readonly linhas: string[] = [];
  private registrar(nivel: string, m: string, c?: Record<string, unknown>): void {
    this.linhas.push(`${nivel} ${m} ${JSON.stringify(c ?? {})}`);
  }
  debug(m: string, c?: Record<string, unknown>): void {
    this.registrar('debug', m, c);
  }
  info(m: string, c?: Record<string, unknown>): void {
    this.registrar('info', m, c);
  }
  warn(m: string, c?: Record<string, unknown>): void {
    this.registrar('warn', m, c);
  }
  error(m: string, c?: Record<string, unknown>): void {
    this.registrar('error', m, c);
  }
  child(): Logger {
    return this;
  }
}
