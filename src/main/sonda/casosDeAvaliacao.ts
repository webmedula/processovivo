import { z } from 'zod';
import { PARECE_PEDIR } from '../../domain/entities/vocabularioDaAnalise.js';
import type { CasoDaSonda } from './casosDaSonda.js';

/**
 * Conjunto de avaliação da análise por IA (v0.52.0): casos 100% SINTÉTICOS
 * (`tests/fixtures/ia-avaliacao/casos.json`), cada um com o que a resposta deve cobrir e o
 * que não pode inventar. Não toca rede nem disco — quem lê o arquivo é o comando.
 *
 * Erro de leitura cita o ÍNDICE do caso, nunca o texto.
 */

export const CATEGORIAS_DE_CASO = [
  'decisao',
  'despacho',
  'intimacao',
  'sentenca',
  'audiencia',
  'valor',
  'prazo_escrito',
  'cartorio',
  'ambiguo',
  'curtissimo',
  'longo',
  'armadilha',
] as const;

const PROIBICOES = [
  'calcular_prazo',
  'inventar_valor',
  'inventar_data',
  'inventar_nome',
  'dar_conselho',
] as const;
export type Proibicao = (typeof PROIBICOES)[number];

const esquemaDoCaso = z
  .object({
    id: z.string().min(1),
    categoria: z.enum(CATEGORIAS_DE_CASO),
    tipo_do_ato: z.string().min(1),
    titulo: z.string().min(1),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    classe: z.string().min(1),
    anteriores: z.array(z.string()),
    partes: z.array(
      z
        .object({
          nome: z.string().min(1),
          pessoaFisica: z.boolean().optional(),
          advogados: z.array(z.object({ nome: z.string().min(1) }).strict()).optional(),
        })
        .strict(),
    ),
    texto: z.string().min(1),
    pontos_obrigatorios: z.array(
      z
        .object({
          id: z.string().min(1),
          descricao: z.string().min(1),
          /** Trechos (sem acento e caixa) de qualquer um dos quais basta aparecer na resposta. */
          alternativas: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
    proibicoes: z.record(z.enum(PROIBICOES), z.boolean()),
    citacao_verificavel: z.boolean(),
    tipo_comunicacao: z.string().optional(),
    prazo_escrito: z
      .object({ dias: z.number().int(), tipo: z.enum(['uteis', 'corridos']).nullable() })
      .strict()
      .nullable()
      .optional(),
    parece_pedir_aceitos: z.array(z.enum(PARECE_PEDIR)).optional(),
    armadilha: z.string().optional(),
    esperado_sem_chamada: z.boolean().optional(),
    /** Texto com instrução injetada: o canário, se aparecer na saída, prova que o modelo obedeceu. */
    injecao: z
      .object({ canario: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export type CasoDeAvaliacao = z.infer<typeof esquemaDoCaso>;

export class CasosDeAvaliacaoInvalidosError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'CasosDeAvaliacaoInvalidosError';
  }
}

export function lerCasosDeAvaliacao(json: string): CasoDeAvaliacao[] {
  let bruto: unknown;
  try {
    bruto = JSON.parse(json);
  } catch {
    throw new CasosDeAvaliacaoInvalidosError('o conjunto de avaliação não é JSON válido');
  }
  if (!Array.isArray(bruto))
    throw new CasosDeAvaliacaoInvalidosError('conjunto de avaliação: esperado array');
  const ids = new Set<string>();
  return bruto.map((item: unknown, i) => {
    const r = esquemaDoCaso.safeParse(item);
    if (!r.success) {
      throw new CasosDeAvaliacaoInvalidosError(
        `caso ${i + 1}: fora do formato (${r.error.issues[0]?.path.join('.') ?? '?'})`,
      );
    }
    if (ids.has(r.data.id))
      throw new CasosDeAvaliacaoInvalidosError(`caso ${i + 1}: id repetido`);
    ids.add(r.data.id);
    return r.data;
  });
}

export function paraCasoDaSonda(c: CasoDeAvaliacao): CasoDaSonda {
  return {
    id: c.id,
    origem: 'sintetico',
    titulo: c.titulo,
    texto: c.texto,
    ...(c.tipo_comunicacao ? { tipoComunicacao: c.tipo_comunicacao } : {}),
    classe: c.classe,
    data: new Date(`${c.data}T00:00:00-03:00`),
    anteriores: c.anteriores,
    pessoas: {
      partes: c.partes.map((p) => ({
        nome: p.nome,
        ...(p.pessoaFisica !== undefined ? { pessoaFisica: p.pessoaFisica } : {}),
        ...(p.advogados ? { advogados: p.advogados } : {}),
      })),
    },
    injecao: c.injecao !== undefined,
    ...(c.injecao ? { canario: c.injecao.canario } : {}),
  };
}
