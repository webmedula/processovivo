/**
 * Vocabulário FECHADO da análise de um ato por IA (spec ia-analise-do-ato v1.0.0,
 * seção 6).
 *
 * Mora no domínio porque é o contrato entre o modelo, a verificação e a tela — e
 * não importa nada. O esquema Zod que o impõe ao modelo mora em
 * `infrastructure/adapters/modelo/` (Zod nunca no domínio).
 */

export const PARECE_PEDIR = [
  'manifestar',
  'cumprir_determinacao',
  'comparecer_audiencia_ou_pericia',
  'apenas_ciencia',
  'sem_providencia_aparente',
  'indeterminado',
] as const;
export type ParecePedir = (typeof PARECE_PEDIR)[number];

/** Códigos que o app traduz em frase; o modelo nunca escreve o aviso por conta própria. */
export const PONTOS_DE_ATENCAO = [
  'conferir_prazo_no_processo',
  'ato_depende_de_outro_documento',
  'texto_incompleto',
  'possivel_outro_destinatario',
] as const;
export type PontoDeAtencao = (typeof PONTOS_DE_ATENCAO)[number];

export const LIMITES_DA_ANALISE = Object.freeze({
  resumo: 280,
  acao: 160,
  acoes: 3,
  pontosDeAtencao: 2,
});

export interface AcaoPossivel {
  readonly acao: string;
  readonly trecho: string;
}

/**
 * O que o modelo devolve, já dentro do esquema e ANTES da verificação. É dado
 * de fonte externa: nada daqui chega à tela sem passar por `verificarAnalise`.
 */
export interface RespostaDoModelo {
  readonly parece_pedir: ParecePedir;
  readonly resumo: string;
  readonly trecho_chave: string;
  readonly acoes_possiveis: readonly AcaoPossivel[];
  readonly pontos_de_atencao: readonly PontoDeAtencao[];
}
