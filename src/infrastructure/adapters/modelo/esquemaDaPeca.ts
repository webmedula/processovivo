import { z } from 'zod';
import {
  LIMITES_DA_ANALISE_DE_PECA as L,
  PONTOS_DE_ATENCAO_DE_PECA,
  TIPOS_DE_PECA,
  type RespostaDoModeloDePeca,
} from '../../../domain/entities/AnaliseDePeca.js';

/**
 * Esquema FECHADO da análise de uma peça (v0.55.0, Fase 1). `.strict()` em tudo: campo a mais ou
 * item acima do limite é resposta FORA do esquema (uma repetição, depois erro), como na análise do
 * ato. Listas ausentes valem vazias. Os limites são os de produção (concisos): o esquema da Fase 0,
 * maior, continua só no comparador.
 */
const pagina = z.number().int().min(1);

const itemComTrecho = z
  .object({
    texto: z.string().min(1).max(L.texto),
    trecho: z.string().min(1).max(L.trecho),
    pagina,
  })
  .strict();

const documentoCitado = z
  .object({ nome_como_escrito: z.string().min(1).max(L.nomeDoDocumento), pagina })
  .strict();

const valorCitado = z
  .object({
    valor_literal: z.string().min(1).max(L.valorLiteral),
    contexto_curto: z.string().max(L.contexto),
    trecho: z.string().min(1).max(L.trecho),
    pagina,
  })
  .strict();

export const esquemaDaAnaliseDePeca = z
  .object({
    tipo_da_peca: z.enum(TIPOS_DE_PECA),
    em_uma_frase: z.string().min(1).max(L.umaFrase),
    pedidos: z.array(itemComTrecho).max(L.pedidos).default([]),
    alegacoes_principais: z.array(itemComTrecho).max(L.alegacoes).default([]),
    preliminares_ou_defesas_formais: z.array(itemComTrecho).max(L.preliminares).default([]),
    documentos_citados: z.array(documentoCitado).max(L.documentos).default([]),
    valores_citados: z.array(valorCitado).max(L.valores).default([]),
    pontos_de_atencao: z
      .array(z.enum(PONTOS_DE_ATENCAO_DE_PECA))
      .max(L.pontosDeAtencao)
      .default([]),
  })
  .strict();

/** Valida dado externo (`unknown`) e devolve a resposta tipada, ou `undefined`. */
export function lerRespostaDaAnaliseDePeca(
  bruto: unknown,
): RespostaDoModeloDePeca | undefined {
  const r = esquemaDaAnaliseDePeca.safeParse(bruto);
  return r.success ? r.data : undefined;
}
