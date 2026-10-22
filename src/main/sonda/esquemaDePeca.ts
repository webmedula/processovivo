import { z } from 'zod';

/**
 * Esquema FECHADO da leitura de uma peça por IA (especificação ia-analise-de-pecas v1.0.0,
 * seção 5). Vive em `main/sonda/` de propósito: é do comparador (Fase 0) e não tem rota nem uso
 * em produção. A Fase 1 decide onde ele mora de verdade.
 *
 * Os limites de tamanho são do esquema: fora deles a resposta é "fora do esquema" (uma repetição
 * e depois erro), como na análise do ato.
 */

export const TIPOS_DE_PECA = [
  'peticao_inicial',
  'contestacao',
  'replica',
  'embargos',
  'recurso',
  'laudo_pericial',
  'manifestacao',
  'outro',
  'indeterminado',
] as const;
export type TipoDePeca = (typeof TIPOS_DE_PECA)[number];

export const PONTOS_DE_ATENCAO_DE_PECA = [
  'peca_longa_demais_para_leitura_completa',
  'texto_incompleto_ou_ilegivel',
  'peca_cita_documentos_nao_anexados',
  'conferir_peca_inteira',
] as const;
export type PontoDeAtencaoDePeca = (typeof PONTOS_DE_ATENCAO_DE_PECA)[number];

export const LIMITES_DA_PECA = Object.freeze({
  texto: 200,
  trecho: 400,
  pedidos: 8,
  alegacoes: 6,
  preliminares: 5,
  documentos: 10,
  valores: 6,
  pontosDeAtencao: 3,
});

const pagina = z.number().int().min(1);

const itemComTrecho = z
  .object({
    texto: z.string().min(1).max(LIMITES_DA_PECA.texto),
    trecho: z.string().min(1).max(LIMITES_DA_PECA.trecho),
    pagina,
  })
  .strict();

const documentoCitado = z
  .object({
    nome_como_escrito: z.string().min(1).max(LIMITES_DA_PECA.texto),
    pagina,
  })
  .strict();

const valorCitado = z
  .object({
    valor_literal: z.string().min(1).max(60),
    contexto_curto: z.string().max(LIMITES_DA_PECA.texto),
    trecho: z.string().min(1).max(LIMITES_DA_PECA.trecho),
    pagina,
  })
  .strict();

export const esquemaDaRespostaDePeca = z
  .object({
    tipo_da_peca: z.enum(TIPOS_DE_PECA),
    pedidos: z.array(itemComTrecho).max(LIMITES_DA_PECA.pedidos).default([]),
    alegacoes_principais: z
      .array(itemComTrecho)
      .max(LIMITES_DA_PECA.alegacoes)
      .default([]),
    preliminares_ou_defesas_formais: z
      .array(itemComTrecho)
      .max(LIMITES_DA_PECA.preliminares)
      .default([]),
    documentos_citados: z
      .array(documentoCitado)
      .max(LIMITES_DA_PECA.documentos)
      .default([]),
    valores_citados: z.array(valorCitado).max(LIMITES_DA_PECA.valores).default([]),
    pontos_de_atencao: z
      .array(z.enum(PONTOS_DE_ATENCAO_DE_PECA))
      .max(LIMITES_DA_PECA.pontosDeAtencao)
      .default([]),
  })
  .strict();

export type RespostaDePeca = z.infer<typeof esquemaDaRespostaDePeca>;
export type ItemComTrecho = z.infer<typeof itemComTrecho>;
export type DocumentoCitado = z.infer<typeof documentoCitado>;
export type ValorCitado = z.infer<typeof valorCitado>;

/** `undefined` = fora do esquema (a repetição única e o erro são do executor). */
export function lerRespostaDePeca(bruto: unknown): RespostaDePeca | undefined {
  const r = esquemaDaRespostaDePeca.safeParse(bruto);
  return r.success ? r.data : undefined;
}
