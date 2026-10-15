import { z } from 'zod';
import { PONTOS_DE_ATENCAO } from '../../../domain/entities/vocabularioDaAnalise.js';
import type { RespostaDoModeloResumo } from '../../../domain/entities/vocabularioDoResumo.js';

/**
 * Esquema FECHADO da resposta do modelo para o resumo de processo (v0.40.0).
 *
 * `.strict()` em tudo: campo a mais é resposta fora do esquema, não "ignorável". Sem limites
 * de tamanho aqui (a saída é pedida em texto, e `verificarResumo` conta como descarte de
 * "forma" o que passar dos limites, visível em vez de escondido num erro de esquema).
 */
const item = z
  .object({ texto: z.string(), ato: z.string(), trecho: z.string() })
  .strict();

export const esquemaDoResumo = z
  .object({
    situacao: z.array(item),
    pendencias: z.array(item),
    pontos_de_atencao: z.array(z.enum(PONTOS_DE_ATENCAO)),
  })
  .strict();

/** Valida dado externo (`unknown`) e devolve a resposta tipada, ou `undefined`. */
export function lerRespostaDoResumo(bruto: unknown): RespostaDoModeloResumo | undefined {
  const lido = esquemaDoResumo.safeParse(bruto);
  return lido.success ? lido.data : undefined;
}

/** Acrescentada ao sistema porque a saída é pedida em texto (sem esquema estrito no provedor). */
export const INSTRUCAO_DE_FORMATO_DO_RESUMO =
  'FORMATO DA RESPOSTA: responda SOMENTE com um objeto JSON, sem texto antes ou depois e sem cercas de código, com exatamente as chaves situacao (lista de objetos {texto, ato, trecho}), pendencias (lista de objetos {texto, ato, trecho}) e pontos_de_atencao (lista de códigos).';
