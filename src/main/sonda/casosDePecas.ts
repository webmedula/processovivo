import { z } from 'zod';
import { TIPOS_DE_PECA } from './esquemaDePeca.js';
import type { CasoDaSonda } from './casosDaSonda.js';
import type { PecaParaMontar } from './promptDePeca.js';

/**
 * Conjunto de avaliação de PEÇAS (v0.53.0, Fase 0): casos 100% SINTÉTICOS em
 * `tests/fixtures/ia-pecas/casos.json`, com o texto por página, o gabarito (pontos obrigatórios,
 * com a página) e as proibições. Não toca rede nem disco; erro de leitura cita o ÍNDICE do caso,
 * nunca o texto.
 */

export const PROIBICOES_DE_PECA = [
  'calcular_prazo',
  'inventar_valor',
  'avaliar_merito',
  'dar_conselho',
] as const;
export type ProibicaoDePeca = (typeof PROIBICOES_DE_PECA)[number];

export const TIPOS_DE_PONTO = [
  'pedido',
  'alegacao',
  'preliminar',
  'documento',
  'valor',
] as const;
export type TipoDePonto = (typeof TIPOS_DE_PONTO)[number];

const esquemaDoCaso = z
  .object({
    id: z.string().min(1),
    categoria: z.string().min(1),
    tipo_esperado: z.enum(TIPOS_DE_PECA),
    titulo: z.string().min(1),
    paginas: z.array(z.string().min(1)).min(1).max(60),
    partes: z.array(
      z
        .object({
          nome: z.string().min(1),
          pessoaFisica: z.boolean().optional(),
          advogados: z.array(z.object({ nome: z.string().min(1) }).strict()).optional(),
        })
        .strict(),
    ),
    pontos_obrigatorios: z.array(
      z
        .object({
          id: z.string().min(1),
          tipo: z.enum(TIPOS_DE_PONTO),
          descricao: z.string().min(1),
          /** Trechos (sem acento e caixa) de qualquer um dos quais basta aparecer no item. */
          alternativas: z.array(z.string().min(1)).min(1),
          /** A página (1-based) em que a peça escreve isso. */
          pagina: z.number().int().min(1),
        })
        .strict(),
    ),
    /** Pedidos que um leitor não pode deixar de achar (o gabarito do critério "pedidos principais"). */
    pedidos_principais: z.array(z.string()).optional(),
    proibicoes: z.record(z.enum(PROIBICOES_DE_PECA), z.boolean()),
    injecao: z
      .object({ canario: z.string().min(1) })
      .strict()
      .optional(),
    /** A peça não tem pedido nem alegação: inventar um é violação. */
    sem_pedidos: z.boolean().optional(),
    /** Traz dados pessoais FICTÍCIOS (formato óbvio) para exercitar a redação. */
    redacao: z.boolean().optional(),
    pontos_de_atencao_aceitos: z.array(z.string()).optional(),
    observacao: z.string().optional(),
  })
  .strict();

export type CasoDePeca = z.infer<typeof esquemaDoCaso>;

export class CasosDePecasInvalidosError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'CasosDePecasInvalidosError';
  }
}

export function lerCasosDePecas(json: string): CasoDePeca[] {
  let bruto: unknown;
  try {
    bruto = JSON.parse(json);
  } catch {
    throw new CasosDePecasInvalidosError('o conjunto de peças não é JSON válido');
  }
  if (!Array.isArray(bruto))
    throw new CasosDePecasInvalidosError('conjunto de peças: esperado array');
  const ids = new Set<string>();
  return bruto.map((item: unknown, i) => {
    const r = esquemaDoCaso.safeParse(item);
    if (!r.success) {
      throw new CasosDePecasInvalidosError(
        `caso ${i + 1}: fora do formato (${r.error.issues[0]?.path.join('.') ?? '?'})`,
      );
    }
    const c = r.data;
    if (ids.has(c.id)) throw new CasosDePecasInvalidosError(`caso ${i + 1}: id repetido`);
    ids.add(c.id);
    const pontos = new Set(c.pontos_obrigatorios.map((p) => p.id));
    if (pontos.size !== c.pontos_obrigatorios.length)
      throw new CasosDePecasInvalidosError(`caso ${i + 1}: ponto repetido`);
    for (const id of c.pedidos_principais ?? []) {
      if (!pontos.has(id))
        throw new CasosDePecasInvalidosError(`caso ${i + 1}: pedido principal sem ponto`);
    }
    for (const p of c.pontos_obrigatorios) {
      if (p.pagina > c.paginas.length)
        throw new CasosDePecasInvalidosError(
          `caso ${i + 1}: página do ponto fora da peça`,
        );
    }
    return c;
  });
}

export function pecaParaMontar(c: CasoDePeca): PecaParaMontar {
  return {
    titulo: c.titulo,
    paginas: c.paginas,
    pessoas: {
      partes: c.partes.map((p) => ({
        nome: p.nome,
        ...(p.pessoaFisica !== undefined ? { pessoaFisica: p.pessoaFisica } : {}),
        ...(p.advogados ? { advogados: p.advogados } : {}),
      })),
    },
  };
}

/** O caso no formato que `executarSonda` entende (o texto da peça só serve de rótulo ali). */
export function paraCasoDaSondaDePeca(c: CasoDePeca): CasoDaSonda {
  return {
    id: c.id,
    origem: 'sintetico',
    titulo: c.titulo,
    texto: c.paginas.join('\n'),
    data: new Date('2026-10-06T00:00:00-03:00'),
    anteriores: [],
    pessoas: {},
    injecao: c.injecao !== undefined,
    ...(c.injecao ? { canario: c.injecao.canario } : {}),
  };
}
