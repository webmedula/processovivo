import { z } from 'zod';
import { FUNCOES_DE_IA } from '../../domain/entities/ControleDaIa.js';
import {
  criarCatalogo,
  type CatalogoDeModelos,
  type ItemDoCatalogo,
} from '../../domain/entities/ModelosDeIa.js';
import { ehApelidoOuVariante } from '../adapters/modelo/endpointsZdr.js';

/**
 * A LISTA PERMITIDA de modelos de IA (v0.60.0, Fase B do painel). Mora no CÓDIGO — nunca no banco nem na
 * tela — e o painel do /admin só escolhe entre estes itens. Incluir um modelo ou um provedor aqui é uma
 * mudança de código, por PR, e exige o dono revisar a Política de Privacidade ANTES (a tela diz isso).
 *
 * Para entrar como CANDIDATO (aparecer no seletor, ser testado e publicado) o item precisa ser
 * `confirmada`: ZDR conferido na lista oficial do provedor (data e fonte) e preço de lista em US$ por
 * milhão de tokens. Item `pendente` é o modelo que JÁ roda em produção e ainda não teve a confirmação
 * registrada: continua valendo como o modelo atual (o ambiente manda), mas nunca é oferecido como troca.
 * Como confirmar um modelo novo: `node scripts/sonda-ia-ato.mjs --listar-modelos-zdr=<nome>` no Console
 * (lê a lista de endpoints ZDR do OpenRouter, sem enviar texto), anote a data e a fonte aqui.
 * Nunca escreva um número que não tenha sido lido da fonte.
 */
const ITENS_BRUTOS: readonly unknown[] = [
  {
    // O modelo de produção (PROCESSOVIVO_IA_MODELO, padrão do código). Janela de contexto da pesquisa de
    // 22/10/2026 (docs/ia-pecas-fase0-resultado-v1.0.0.md, item 2.5). O ZDR dele é exercido em toda chamada
    // de produção pela lista oficial (falha fechada), mas a CONFIRMAÇÃO formal (data, fonte e preço de lista)
    // ainda não foi registrada: o dono a lê no Console e completa este item.
    id: 'deepseek/deepseek-v4-flash',
    provedor: 'DeepSeek (via OpenRouter)',
    apelido: 'DeepSeek V4 Flash',
    confirmacao: 'pendente',
    zdrConfirmadoEm: null,
    zdrFonte: null,
    precoEntradaPorMTokens: null,
    precoSaidaPorMTokens: null,
    janelaContexto: 1_048_576,
    funcoesPermitidas: [...FUNCOES_DE_IA],
    status: 'ativo',
  },
  {
    // Candidato (v0.65.0, escolha do dono: o Claude "intermediário"). ZDR lido no Console de produção com
    // `node scripts/sonda-ia-ato.mjs --listar-modelos-zdr=claude` em 29/10/2026 (13 modelos Claude com
    // endpoint ZDR, este entre eles). Preço e janela lidos no mesmo dia em
    // `GET https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints` (público): US$ 0,000002
    // por token de entrada e US$ 0,00001 de saída nos endpoints globais, 1.000.000 de tokens de contexto.
    // Quais provedores servem com ZDR quem decide é a lista oficial, a cada chamada (falha fechada).
    id: 'anthropic/claude-sonnet-5.5',
    provedor: 'Anthropic (via OpenRouter)',
    apelido: 'Claude Sonnet 5.5',
    confirmacao: 'confirmada',
    zdrConfirmadoEm: '2026-10-29',
    zdrFonte: 'OpenRouter /endpoints/zdr via sonda-ia-ato --listar-modelos-zdr',
    precoEntradaPorMTokens: 2,
    precoSaidaPorMTokens: 10,
    janelaContexto: 1_000_000,
    funcoesPermitidas: [...FUNCOES_DE_IA],
    status: 'ativo',
  },
];

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idDoModelo = z
  .string()
  .min(3)
  .max(120)
  .regex(
    /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i,
    'id de modelo no formato fabricante/modelo',
  )
  .refine(
    (v) => !ehApelidoOuVariante(v),
    'apelido (~) e variante (:) não são modelos reais',
  );

const base = {
  id: idDoModelo,
  provedor: z.string().trim().min(1).max(80),
  apelido: z.string().trim().min(1).max(60),
  funcoesPermitidas: z.array(z.enum(FUNCOES_DE_IA)).min(1),
  status: z.enum(['ativo', 'descontinuado']),
};

const esquemaDoItem = z.discriminatedUnion('confirmacao', [
  z
    .object({
      ...base,
      confirmacao: z.literal('confirmada'),
      zdrConfirmadoEm: dia,
      zdrFonte: z.string().trim().min(3).max(200),
      precoEntradaPorMTokens: z.number().positive().finite(),
      precoSaidaPorMTokens: z.number().positive().finite(),
      janelaContexto: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...base,
      confirmacao: z.literal('pendente'),
      zdrConfirmadoEm: z.null(),
      zdrFonte: z.null(),
      precoEntradaPorMTokens: z.null(),
      precoSaidaPorMTokens: z.null(),
      janelaContexto: z.number().int().positive().nullable(),
    })
    .strict(),
]);

/** Valida a lista (Zod, no arranque). Lança com o que está errado; ids repetidos também. */
export function validarCatalogo(brutos: readonly unknown[]): ItemDoCatalogo[] {
  const itens = z.array(esquemaDoItem).min(1).parse(brutos) as ItemDoCatalogo[];
  const vistos = new Set<string>();
  for (const i of itens) {
    if (vistos.has(i.id)) throw new Error('lista de modelos permitidos: id repetido');
    vistos.add(i.id);
  }
  return itens;
}

export const MODELOS_PERMITIDOS: readonly ItemDoCatalogo[] = Object.freeze(
  validarCatalogo(ITENS_BRUTOS),
);

export const CATALOGO_DE_MODELOS: CatalogoDeModelos = criarCatalogo(MODELOS_PERMITIDOS);

export const AVISO_DE_NOVO_MODELO =
  'Para incluir um modelo novo na lista é preciso uma alteração de código e revisão da Política de Privacidade.';
