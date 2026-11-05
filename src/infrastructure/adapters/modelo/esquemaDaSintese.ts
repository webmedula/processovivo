import { z } from 'zod';
import {
  LIMITES_DA_SINTESE as L,
  type RespostaDoModeloDaSintese,
} from '../../../domain/entities/AnaliseDoProcesso.js';

/**
 * Esquema FECHADO da síntese do processo (v0.66.0). `.strict()` em tudo, como na análise de peça: campo a
 * mais ou lista acima do limite é resposta FORA do esquema (uma repetição, depois erro). As referências são
 * texto curto; quem decide se existem é a verificação.
 */
const refs = z.array(z.string().min(1).max(24)).min(1).max(L.refsPorItem);

const item = z
  .object({ texto: z.string().min(1).max(L.texto), refs })
  .strict();

const pedido = z
  .object({
    texto: z.string().min(1).max(L.texto),
    refs,
    defesa: item.nullable().default(null),
    decisao: item.nullable().default(null),
  })
  .strict();

export const esquemaDaSintese = z
  .object({
    objeto: z.object({ texto: z.string().min(1).max(L.objeto), refs }).strict(),
    pedidos: z.array(pedido).max(L.pedidos).default([]),
    linha_do_tempo: z.array(item).max(L.linhaDoTempo).default([]),
    pontos_controvertidos: z.array(item).max(L.controvertidos).default([]),
  })
  .strict();

/** Valida dado externo (`unknown`) e devolve a resposta tipada, ou `undefined`. */
export function lerRespostaDaSintese(bruto: unknown): RespostaDoModeloDaSintese | undefined {
  const r = esquemaDaSintese.safeParse(bruto);
  return r.success ? r.data : undefined;
}
