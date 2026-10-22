import { z } from 'zod';
import { MOTIVOS_DA_AVALIACAO } from '../../../domain/entities/AnaliseDoAto.js';
import type {
  AvaliacaoDaAnalise,
  MotivoDaAvaliacao,
} from '../../../domain/entities/AnaliseDoAto.js';

/**
 * Corpo da avaliação da análise, do resumo e da peça (v0.52.0): três valores e, OPCIONAL, um motivo de lista
 * fechada — só com "errado" ou "perigoso". `.strict()` e nenhum campo de texto: texto livre receberia dado
 * pessoal, e este corpo é a única entrada da avaliação.
 *
 * Desde a v0.56.0 a tela só tem polegares: para baixo grava "errado", e o motivo "pode causar prejuízo" é o que
 * antes era "perigoso". Por isso esse motivo FORÇA o valor "perigoso" aqui, no servidor — a tabela, o relatório
 * e o critério "zero perigoso" da avaliação de modelos continuam falando a mesma língua, e nenhum cliente
 * (antigo ou novo) consegue gravar o motivo com outro valor.
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
  })
  .transform((c) =>
    c.motivo === 'pode_causar_prejuizo' ? { ...c, avaliacao: 'perigoso' as const } : c,
  );

export type CorpoDaAvaliacao = {
  readonly avaliacao: AvaliacaoDaAnalise;
  readonly motivo?: MotivoDaAvaliacao | undefined;
};
