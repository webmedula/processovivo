import type { PontoDeAtencao } from './vocabularioDaAnalise.js';
import type { ItemDoResumo, PontoDoResumo } from './vocabularioDoResumo.js';
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
  /**
   * v0.54.0 (aditivos: resumos gravados antes não os têm). Atos só-título absorvidos por um
   * ato com texto do mesmo dia e tipo.
   */
  readonly atosMesclados?: number;
  /** Providências do sistema cujo texto o resumo NÃO leu (sem texto, indisponível, curto ou fora do limite). */
  readonly providenciasNaoLidas?: number;
  /** O texto do ato mais recente foi lido? */
  readonly maisRecenteLido?: boolean;
}

export type ResultadoDoResumo =
  | {
      readonly estado: 'verificado';
      readonly situacao: readonly ItemDoResumo[];
      readonly pendencias: readonly ItemDoResumo[];
      readonly pontosDeAtencao: readonly PontoDeAtencao[];
      /** v0.54.0: os mesmos pontos com a chave do ato apontado (resumos antigos não têm). */
      readonly pontosDoAto?: readonly PontoDoResumo[];
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
