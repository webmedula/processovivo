import { z } from 'zod';
import { TIPOS_DE_PECA } from '../../domain/entities/AnaliseDePeca.js';
import type { PecaParaSintese } from '../../application/politicas/entradaDaSintese.js';

/**
 * Casos SINTÉTICOS do comparador da SÍNTESE do processo (v0.66.0): processos inventados, já na forma em que a
 * síntese os recebe — os resultados VERIFICADOS da análise de cada peça, com marcadores ([PARTE A]) no lugar
 * de nome. Caso real NUNCA entra aqui nem em `tests/fixtures`. As categorias:
 *  - `inicial_e_contestacao`: pedido de um lado, defesa do outro (o cruzamento básico);
 *  - `com_decisao`: o juízo decidiu ou determinou algo (decisão por pedido, prazo escrito);
 *  - `com_recurso`: a discussão continua depois da sentença;
 *  - `injecao`: um item traz instrução dirigida ao modelo (esperado: nada dela na saída).
 */
export const CATEGORIAS_DE_PROCESSO = [
  'inicial_e_contestacao',
  'com_decisao',
  'com_recurso',
  'injecao',
] as const;
export type CategoriaDeProcesso = (typeof CATEGORIAS_DE_PROCESSO)[number];

const item = z
  .object({
    texto: z.string().min(1),
    trecho: z.string().min(1),
    pagina: z.number().int().min(1),
  })
  .strict();
const resultado = z
  .object({
    emUmaFrase: z.string(),
    pedidos: z.array(item),
    alegacoes: z.array(item),
    preliminares: z.array(item),
    documentos: z.array(
      z
        .object({ nome_como_escrito: z.string().min(1), pagina: z.number().int().min(1) })
        .strict(),
    ),
    valores: z.array(
      z
        .object({
          valor_literal: z.string().min(1),
          contexto_curto: z.string().min(1),
          trecho: z.string().min(1),
          pagina: z.number().int().min(1),
        })
        .strict(),
    ),
    pontosDeAtencao: z.array(
      z.enum(['peca_cita_documentos_nao_anexados', 'conferir_peca_inteira']),
    ),
    determinacoes: z
      .array(
        z
          .object({
            quem: z.string().min(1),
            texto: z.string().min(1),
            prazo_escrito: z.string().nullable(),
            trecho: z.string().min(1),
            pagina: z.number().int().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const esquemaDoCaso = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,40}$/),
    categoria: z.enum(CATEGORIAS_DE_PROCESSO),
    pecas: z
      .array(
        z
          .object({ tipo: z.enum(TIPOS_DE_PECA), data: z.string().datetime(), resultado })
          .strict(),
      )
      .min(2)
      .max(20),
    /** Cada ponto é uma lista de ALTERNATIVAS (sem acento e caixa): basta uma aparecer. */
    pontos_obrigatorios: z.array(z.array(z.string().min(2)).min(1)),
    /** O que NÃO pode aparecer no texto que o modelo escreve (sem acento e caixa). */
    proibicoes: z.array(z.string().min(2)),
  })
  .strict();

export type CasoDeProcesso = z.infer<typeof esquemaDoCaso>;

export class CasosDeProcessoInvalidosError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'CasosDeProcessoInvalidosError';
  }
}

export function lerCasosDeProcesso(json: string): CasoDeProcesso[] {
  let bruto: unknown;
  try {
    bruto = JSON.parse(json);
  } catch {
    throw new CasosDeProcessoInvalidosError('o conjunto de processos não é JSON válido');
  }
  if (!Array.isArray(bruto))
    throw new CasosDeProcessoInvalidosError('conjunto de processos: esperado array');
  const ids = new Set<string>();
  return bruto.map((x: unknown, i) => {
    const r = esquemaDoCaso.safeParse(x);
    if (!r.success) {
      throw new CasosDeProcessoInvalidosError(
        `caso ${i + 1}: fora do formato (${r.error.issues[0]?.path.join('.') ?? '?'})`,
      );
    }
    if (ids.has(r.data.id))
      throw new CasosDeProcessoInvalidosError(`caso ${i + 1}: id repetido`);
    ids.add(r.data.id);
    return r.data;
  });
}

/** As peças do caso como a produção as entrega à síntese (P1 = a mais antiga). */
export function pecasDoCaso(c: CasoDeProcesso): PecaParaSintese[] {
  return [...c.pecas]
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((p) => {
      const { determinacoes, ...resto } = p.resultado;
      return {
        tipo: p.tipo,
        data: new Date(p.data),
        resultado: {
          estado: 'verificada' as const,
          ...resto,
          tipo: p.tipo,
          ...(determinacoes ? { determinacoes } : {}),
        },
      };
    });
}
