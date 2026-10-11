import { z } from 'zod';
import {
  PARECE_PEDIR,
  PONTOS_DE_ATENCAO,
  type RespostaDoModelo,
} from '../../../domain/entities/vocabularioDaAnalise.js';

/**
 * Esquema FECHADO da resposta do modelo (spec ia-analise-do-ato v1.0.0, seção 6).
 *
 * Duas coisas deliberadas:
 *
 * - `.strict()`: campo a mais é resposta fora do esquema, não "ignorável". Um
 *   texto de ato com instrução injetada que convença o modelo a acrescentar
 *   campo (ou a mudar um valor para fora do vocabulário) falha aqui.
 * - SEM limites de tamanho no esquema enviado ao provedor: alguns provedores
 *   recusam `maxLength` em saída estruturada, e recusa por isso derrubaria o
 *   modelo inteiro da comparação. Os limites (280/160 caracteres, 3 ações, 2
 *   pontos) são aplicados por `verificarAnalise`, que os conta como descarte
 *   de "forma" — visíveis na sonda, em vez de escondidos num erro de esquema.
 */
export const esquemaDaResposta = z
  .object({
    parece_pedir: z.enum(PARECE_PEDIR),
    resumo: z.string(),
    trecho_chave: z.string(),
    acoes_possiveis: z.array(z.object({ acao: z.string(), trecho: z.string() }).strict()),
    pontos_de_atencao: z.array(z.enum(PONTOS_DE_ATENCAO)),
  })
  .strict();

/** Valida dado externo (`unknown`) e devolve a resposta tipada, ou `undefined`. */
export function lerRespostaDoModelo(bruto: unknown): RespostaDoModelo | undefined {
  const lido = esquemaDaResposta.safeParse(bruto);
  return lido.success ? lido.data : undefined;
}
