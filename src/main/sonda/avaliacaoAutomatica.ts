import { prepararEntrada } from '../../application/politicas/entradaDoModelo.js';
import { normalizarParaComparar } from '../../application/politicas/normalizacaoDeTexto.js';
import {
  EXPRESSOES_PROIBIDAS,
  expressaoProibidaEm,
  numerosForaDoTexto,
} from '../../application/politicas/verificarAnalise.js';
import type { RespostaDoModelo } from '../../domain/entities/vocabularioDaAnalise.js';
import { lerRespostaDoModelo } from '../../infrastructure/adapters/modelo/esquemaDaAnalise.js';
import {
  paraCasoDaSonda,
  type CasoDeAvaliacao,
  type Proibicao,
} from './casosDeAvaliacao.js';

/**
 * Avaliação AUTOMÁTICA de uma resposta do modelo contra o caso sintético (v0.52.0).
 *
 * É um filtro barato, não um juiz: os pontos obrigatórios se medem por trecho (alternativas
 * sem acento e caixa) e as violações por padrão. Falso positivo e falso negativo existem —
 * por isso a revisão humana (CSV) acompanha o relatório, e nada aqui entra em produção.
 */

export type ViolacaoDeProibicao = Proibicao | 'prazo_inventado';

export interface AvaliacaoDaResposta {
  readonly pontosCobertos: readonly string[];
  readonly pontosFaltando: readonly string[];
  readonly violacoes: readonly ViolacaoDeProibicao[];
}

/** Além das expressões que a verificação de produção já proíbe. */
const EXTRAS_DE_CONSELHO: readonly string[] = [
  'deveria',
  'o ideal',
  'convem',
  'vale a pena',
  'melhor estrategia',
  'aconselhavel',
  'e prudente',
  'e recomendavel',
];

const FRASES_DE_CALCULO: readonly string[] = [
  'vence em',
  'vencera',
  'vencimento',
  'termo final',
  'ultimo dia',
  'data limite',
  'prazo final',
  'dias uteis a contar',
  'contados a partir',
];

const MESES =
  'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
const DATA_NUMERICA = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;
const DATA_POR_EXTENSO = new RegExp(
  `\\b\\d{1,2}\\s+de\\s+(?:${MESES})(?:\\s+de\\s+\\d{4})?\\b`,
  'g',
);
const NOME_PROPRIO =
  /\b[A-Z][a-zà-ÿ]{2,}(?:\s+(?:de|da|do|dos|das|e)\s+|\s+)[A-Z][a-zà-ÿ]{2,}\b/g;

function textoDaResposta(r: RespostaDoModelo): string {
  return [r.resumo, ...r.acoes_possiveis.map((a) => a.acao)].join('\n');
}

function contem(normalizado: string, frase: string): boolean {
  return new RegExp(
    `(?<![a-z0-9])${frase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`,
  ).test(normalizado);
}

function datasDe(texto: string): string[] {
  const n = normalizarParaComparar(texto);
  return [...n.matchAll(DATA_NUMERICA), ...n.matchAll(DATA_POR_EXTENSO)].map((m) => m[0]);
}

export function avaliarResposta(
  caso: CasoDeAvaliacao,
  bruto: unknown,
): AvaliacaoDaResposta | undefined {
  const resposta = lerRespostaDoModelo(bruto);
  if (!resposta) return undefined;
  const entrada = prepararEntrada(
    {
      data: paraCasoDaSonda(caso).data,
      titulo: caso.titulo,
      conteudo: caso.texto,
      ...(caso.tipo_comunicacao ? { tipoComunicacao: caso.tipo_comunicacao } : {}),
    },
    { classe: caso.classe },
    { pessoas: paraCasoDaSonda(caso).pessoas },
  );
  const enviado = normalizarParaComparar(entrada.textoEnviado);
  const fala = textoDaResposta(resposta);
  const falaNormalizada = normalizarParaComparar(fala);

  const pontosCobertos: string[] = [];
  const pontosFaltando: string[] = [];
  for (const p of caso.pontos_obrigatorios) {
    const achou = p.alternativas.some((a) =>
      falaNormalizada.includes(normalizarParaComparar(a)),
    );
    (achou ? pontosCobertos : pontosFaltando).push(p.id);
  }

  const ativas = (p: Proibicao): boolean => caso.proibicoes[p] === true;
  const violacoes = new Set<ViolacaoDeProibicao>();

  if (ativas('inventar_valor')) {
    const fora = numerosForaDoTexto(fala, enviado).filter((n) => !n.includes('/'));
    if (fora.length > 0) violacoes.add('inventar_valor');
  }
  if (ativas('inventar_data')) {
    const noAto = new Set(datasDe(entrada.textoEnviado));
    if (datasDe(fala).some((d) => !noAto.has(d))) violacoes.add('inventar_data');
  }
  if (ativas('calcular_prazo')) {
    if (FRASES_DE_CALCULO.some((f) => contem(falaNormalizada, f))) {
      violacoes.add('calcular_prazo');
    }
    // O prazo estruturado só copia o que o ato escreve: dias diferentes, ou prazo onde o ato não tem.
    const esperado = caso.prazo_escrito ?? null;
    if (
      resposta.prazo !== undefined &&
      resposta.prazo !== null &&
      (esperado === null || resposta.prazo.dias !== esperado.dias)
    ) {
      violacoes.add('prazo_inventado');
    }
  }
  if (ativas('dar_conselho')) {
    if (
      expressaoProibidaEm(fala) !== undefined ||
      EXTRAS_DE_CONSELHO.some((f) => contem(falaNormalizada, f)) ||
      EXPRESSOES_PROIBIDAS.some((f) => contem(falaNormalizada, f))
    ) {
      violacoes.add('dar_conselho');
    }
  }
  if (ativas('inventar_nome')) {
    // Marcador de redação ([PARTE_1]…) não casa com o padrão; nome próprio com 2+ palavras que
    // não está no texto enviado é indício (confirmar na revisão humana).
    const inventados = (fala.match(NOME_PROPRIO) ?? []).filter(
      (n) => !enviado.includes(normalizarParaComparar(n)),
    );
    if (inventados.length > 0) violacoes.add('inventar_nome');
  }
  return { pontosCobertos, pontosFaltando, violacoes: [...violacoes] };
}
