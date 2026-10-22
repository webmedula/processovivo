import { z } from 'zod';
import type { Movimentacao } from '../../domain/entities/Movimentacao.js';

/**
 * Casos SINTÉTICOS do comparador do RESUMO de processo (v0.54.0): processos inventados (CNJ de
 * 2099, nomes de mentira) para comparar `resumo-1.0.0` × `resumo-1.1.0`. Caso real NUNCA entra aqui
 * nem em `tests/fixtures`. As quatro categorias são as que quebravam o resumo:
 *  - `cabecalho_longo`: ato recente com o bloco institucional repetido e providência;
 *  - `muitos_so_titulo`: um ato com texto e dezenas só com título;
 *  - `despacho_e_decisao_mesmo_dia`: o mesmo despacho do DataJud (só título) e do DJEN (com texto);
 *  - `ato_recente_sem_texto`: o ato mais recente sem texto lido, atos antigos com texto.
 */
export const CATEGORIAS_DE_RESUMO = [
  'cabecalho_longo',
  'muitos_so_titulo',
  'despacho_e_decisao_mesmo_dia',
  'ato_recente_sem_texto',
] as const;
export type CategoriaDeResumo = (typeof CATEGORIAS_DE_RESUMO)[number];

const esquemaDoAto = z
  .object({
    data: z.string().datetime(),
    titulo: z.string().min(1),
    id_externo: z.string().optional(),
    fonte: z.string().optional(),
    conteudo: z.string().optional(),
    teor_indisponivel: z.boolean().optional(),
    tipo_comunicacao: z.string().optional(),
  })
  .strict();

const esquemaDoCaso = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,40}$/),
    categoria: z.enum(CATEGORIAS_DE_RESUMO),
    classe: z.string().optional(),
    atos: z.array(esquemaDoAto).min(1).max(80),
    /** Cada ponto é uma lista de ALTERNATIVAS (sem acento e caixa): basta uma aparecer. */
    pontos_obrigatorios: z.array(z.array(z.string().min(2)).min(1)),
    /** O que NÃO pode aparecer no texto que o modelo escreve (sem acento e caixa). */
    proibicoes: z.array(z.string().min(2)),
  })
  .strict();

export type CasoDeResumo = z.infer<typeof esquemaDoCaso>;

export class CasosDeResumoInvalidosError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'CasosDeResumoInvalidosError';
  }
}

export function lerCasosDeResumo(json: string): CasoDeResumo[] {
  let bruto: unknown;
  try {
    bruto = JSON.parse(json);
  } catch {
    throw new CasosDeResumoInvalidosError('o conjunto de resumos não é JSON válido');
  }
  if (!Array.isArray(bruto))
    throw new CasosDeResumoInvalidosError('conjunto de resumos: esperado array');
  const ids = new Set<string>();
  return bruto.map((item: unknown, i) => {
    const r = esquemaDoCaso.safeParse(item);
    if (!r.success) {
      throw new CasosDeResumoInvalidosError(
        `caso ${i + 1}: fora do formato (${r.error.issues[0]?.path.join('.') ?? '?'})`,
      );
    }
    if (ids.has(r.data.id))
      throw new CasosDeResumoInvalidosError(`caso ${i + 1}: id repetido`);
    ids.add(r.data.id);
    return r.data;
  });
}

export function movimentacoesDoCaso(c: CasoDeResumo): Movimentacao[] {
  return c.atos.map((a) => ({
    data: new Date(a.data),
    titulo: a.titulo,
    ...(a.id_externo ? { idExterno: a.id_externo } : {}),
    ...(a.fonte ? { fonte: a.fonte } : {}),
    ...(a.conteudo !== undefined ? { conteudo: a.conteudo } : {}),
    ...(a.teor_indisponivel ? { teorIndisponivel: true } : {}),
    ...(a.tipo_comunicacao ? { tipoComunicacao: a.tipo_comunicacao } : {}),
  }));
}
