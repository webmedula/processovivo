import { z } from 'zod';
import { MOTIVOS_DA_AVALIACAO } from '../../../domain/entities/AnaliseDoAto.js';
import type {
  AvaliacaoDaAnalise,
  MotivoDaAvaliacao,
} from '../../../domain/entities/AnaliseDoAto.js';

/**
 * Corpo da avaliação da análise e do resumo (v0.52.0): três valores e, OPCIONAL, um motivo de lista
 * fechada — só com "errado" ou "perigoso". `.strict()` e nenhum campo de texto: texto livre receberia dado
 * pessoal, e este corpo é a única entrada da avaliação.
 */
export const corpoDaAvaliacao = z
  .object({
    avaliacao: z.enum(['util', 'errado', 'perigoso']),
    motivo: z
      .enum(MOTIVOS_DA_AVALIACAO as [MotivoDaAvaliacao, ...MotivoDaAvaliacao[]])
      .optional(),
  })
  .strict()
  .refine((c) => c.motivo === undefined || c.avaliacao !== 'util', {
    message: 'O motivo só vale com "errado" ou "perigoso".',
    path: ['motivo'],
  });

export type CorpoDaAvaliacao = {
  readonly avaliacao: AvaliacaoDaAnalise;
  readonly motivo?: MotivoDaAvaliacao | undefined;
};
