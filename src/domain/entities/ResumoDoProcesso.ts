import type { PontoDeAtencao } from './vocabularioDaAnalise.js';
import type { ItemDoResumo } from './vocabularioDoResumo.js';
import type {
  AvaliacaoDaAnalise,
  MedidasDaAnalise,
  ProcedenciaDaAnalise,
} from './AnaliseDoAto.js';

/**
 * Resumo de UM processo por IA (v0.40.0). Como a análise de ato, o que fica gravado é o
 * resultado COM MARCADORES (`[PARTE A]`, `[PROCESSO]`…): nunca o texto dos atos nem os valores
 * originais. Apoio à leitura — nada aqui decide providência, ordem, contagem ou calendário.
 */

/** Contagens do pedido: só números, nunca texto. */
export interface ContagensDoResumo {
  readonly atosNoProcesso: number;
  /** Atos enviados COM texto. */
  readonly atosComTexto: number;
  /** Atos enviados só com título e data (linha do tempo). */
  readonly atosSoTitulo: number;
  /** Atos que ficaram de fora do que foi enviado (a tela diz quantos). */
  readonly foraDoResumo: number;
  /** Itens que o modelo devolveu e a verificação descartou (a tela diz quantos). */
  readonly itensDescartados: number;
  /** Atos que o sistema marca como pedem providência em aberto. */
  readonly providenciasDoSistema: number;
  /** Desses, quantos a IA não citou em nenhum item verificado. */
  readonly providenciasNaoCitadas: number;
}

export type ResultadoDoResumo =
  | {
      readonly estado: 'verificado';
      readonly situacao: readonly ItemDoResumo[];
      readonly pendencias: readonly ItemDoResumo[];
      readonly pontosDeAtencao: readonly PontoDeAtencao[];
    }
  | {
      readonly estado: 'nao_verificado';
      readonly motivo: 'sem_item_verificado' | 'expressao_proibida';
    };

/** Quais atos foram enviados: chave e data, jamais título ou texto. */
export interface AtoEnviadoAoResumo {
  readonly chaveDoAto: string;
  readonly data: Date;
  readonly comTexto: boolean;
}

export interface ResumoDoProcesso {
  readonly id: string;
  readonly workspace: string;
  /** Número CNJ, 20 dígitos. */
  readonly numero: string;
  readonly resultado: ResultadoDoResumo;
  readonly atosEnviados: readonly AtoEnviadoAoResumo[];
  readonly contagens: ContagensDoResumo;
  readonly procedencia: ProcedenciaDaAnalise;
  readonly medidas: MedidasDaAnalise;
  readonly avaliacao?: AvaliacaoDaAnalise;
}
