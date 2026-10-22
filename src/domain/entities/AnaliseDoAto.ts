import type {
  AcaoPossivel,
  ParecePedir,
  PontoDeAtencao,
  PrazoDoAto,
} from './vocabularioDaAnalise.js';

/**
 * Análise por IA de UM ato (spec ia-analise-do-ato, Errata v1.1.0).
 *
 * O que fica gravado é o resultado COM MARCADORES (`[PARTE A]`, `[PROCESSO]`…), nunca o
 * texto do ato nem os valores originais: quem lê o banco não reconstrói o ato, e o
 * valor original só volta na resposta, trocado a partir do retrato da própria conta.
 * Apoio à leitura — nada aqui decide providência, ordem, contagem ou calendário.
 */

export type EstadoDaAnalise = 'verificada' | 'nao_verificada';

export type AvaliacaoDaAnalise = 'util' | 'errado' | 'perigoso';
export const AVALIACOES_DA_ANALISE: readonly AvaliacaoDaAnalise[] = [
  'util',
  'errado',
  'perigoso',
];

/**
 * Motivo OPCIONAL de uma avaliação "errado" ou "perigoso" (v0.52.0). Lista FECHADA, sem texto
 * livre: texto livre receberia dado pessoal. Só serve para medir onde o modelo erra.
 */
export type MotivoDaAvaliacao =
  | 'erro_de_fato'
  | 'citacao_inventada'
  | 'concluiu_prazo'
  | 'deixou_de_fora'
  | 'outro';
export const MOTIVOS_DA_AVALIACAO: readonly MotivoDaAvaliacao[] = [
  'erro_de_fato',
  'citacao_inventada',
  'concluiu_prazo',
  'deixou_de_fora',
  'outro',
];

/** O resultado já verificado (citações presentes no texto enviado), ainda com marcadores. */
export type ResultadoDaAnalise =
  | {
      readonly estado: 'verificada';
      readonly parecePedir: ParecePedir;
      readonly resumo?: string;
      readonly trechoChave?: string;
      readonly acoesPossiveis: readonly AcaoPossivel[];
      readonly pontosDeAtencao: readonly PontoDeAtencao[];
      /** v0.39.0: prazo em dias escrito no ato (número conferido contra o texto enviado). */
      readonly prazo?: PrazoDoAto;
    }
  | {
      readonly estado: 'nao_verificada';
      readonly motivo:
        'sem_citacao_valida' | 'expressao_proibida' | 'acao_copiada_do_trecho';
    };

/** De onde veio e como foi gerada: tudo que a tela e a medição precisam, sem texto. */
export interface ProcedenciaDaAnalise {
  /** O modelo que a RESPOSTA diz ter servido (não o pedido). */
  readonly modelo: string;
  readonly versaoPrompt: string;
  /** O provedor que atendeu, como a resposta informa. */
  readonly provedor: string;
  readonly criadaEm: Date;
}

export interface MedidasDaAnalise {
  readonly tokensEntrada?: number;
  readonly tokensSaida?: number;
  readonly custoUsd?: number;
  readonly latenciaMs: number;
}

export interface AnaliseDoAto {
  readonly id: string;
  readonly workspace: string;
  /** Número CNJ, 20 dígitos. */
  readonly numero: string;
  /** `chaveDaMovimentacao` do ato analisado. */
  readonly chaveDoAto: string;
  readonly resultado: ResultadoDaAnalise;
  readonly procedencia: ProcedenciaDaAnalise;
  readonly medidas: MedidasDaAnalise;
  readonly avaliacao?: AvaliacaoDaAnalise;
}
