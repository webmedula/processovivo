import type { PontoDeAtencao } from './vocabularioDaAnalise.js';

/**
 * Vocabulário FECHADO do resumo de processo por IA (v0.40.0, Etapa 2 da "IA como secretária").
 *
 * Mora no domínio porque é o contrato entre o modelo, a verificação e a tela — e não importa
 * nada além do vocabulário da análise de ato. O esquema Zod que o impõe ao modelo mora em
 * `infrastructure/adapters/modelo/`.
 */

export const LIMITES_DO_RESUMO = Object.freeze({
  situacao: 4,
  pendencias: 5,
  texto: 280,
  pontosDeAtencao: 2,
});

/** Um item como o modelo o entrega: `ato` é o identificador curto (A1, A2…) que NÓS demos. */
export interface ItemBrutoDoResumo {
  readonly texto: string;
  readonly ato: string;
  readonly trecho: string;
}

/** Ponto de atenção com o ato que o motivou (prompt `resumo-1.1.0`); `resumo-1.0.0` devolvia só o código. */
export interface PontoBrutoDoResumo {
  readonly codigo: PontoDeAtencao;
  readonly ato: string;
}

/** O que o modelo devolve, dentro do esquema e ANTES da verificação. É dado de fonte externa. */
export interface RespostaDoModeloResumo {
  readonly situacao: readonly ItemBrutoDoResumo[];
  readonly pendencias: readonly ItemBrutoDoResumo[];
  readonly pontos_de_atencao: readonly (PontoDeAtencao | PontoBrutoDoResumo)[];
}

/** Um item que passou pela verificação: `ato` já é a `chaveDaMovimentacao` do retrato. */
export interface ItemDoResumo {
  readonly texto: string;
  readonly chaveDoAto: string;
  readonly trecho: string;
}

/** Um ponto de atenção verificado; `chaveDoAto` ausente = o modelo não apontou ato válido. */
export interface PontoDoResumo {
  readonly codigo: PontoDeAtencao;
  readonly chaveDoAto?: string;
}
