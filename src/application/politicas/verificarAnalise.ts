import {
  LIMITES_DA_ANALISE,
  PONTOS_DE_ATENCAO,
  type AcaoPossivel,
  type ParecePedir,
  type PontoDeAtencao,
  type RespostaDoModelo,
} from '../../domain/entities/vocabularioDaAnalise.js';
import { normalizarParaComparar } from './normalizacaoDeTexto.js';

/**
 * Verificação determinística da resposta do modelo (spec ia-analise-do-ato
 * v1.0.0, seção 6). Não confia no modelo em nada: cada afirmação precisa ter
 * citação que exista no texto QUE FOI ENVIADO (o redigido).
 *
 * O que se descarta e em que nível:
 *   - `trecho_chave` sem citação válida → resultado "não verificado", sem resumo;
 *   - ação sem citação válida, ou com número que o texto não tem → só a ação;
 *   - resumo com número que o texto não tem → só o resumo;
 *   - expressão proibida em resumo ou ação → o resultado inteiro.
 *
 * Versão da lista de proibições: mude `VERSAO_DAS_REGRAS_DE_VERIFICACAO` junto
 * com qualquer alteração aqui, para a avaliação do Autran saber a que regras
 * cada resposta foi submetida.
 */
export const VERSAO_DAS_REGRAS_DE_VERIFICACAO = '1.0.0';

/**
 * Expressões que transformam apoio à leitura em orientação jurídica. Lista
 * pequena de propósito; comparada sobre o texto normalizado (sem acento), por
 * palavra inteira.
 */
export const EXPRESSOES_PROIBIDAS: readonly string[] = Object.freeze([
  'prazo fatal',
  'recorra',
  'recorrer',
  'apele',
  'apelar',
  'perdera o direito',
  'perdera seu direito',
  'perda do direito',
  'tese',
  'teses',
  'jurisprudencia',
  'precedente',
  'precedentes',
  'sumula',
  'recomendo',
  'recomendamos',
  'recomenda-se',
  'aconselho',
  'sugiro',
  'voce deve',
  'e obrigatorio',
  'certamente',
  'com certeza',
]);

export interface DescartesDaVerificacao {
  /** Citações (trecho_chave ou de ação) que não existem no texto enviado. */
  readonly citacao: number;
  /** Números/datas no resumo ou na ação que o texto enviado não contém. */
  readonly numeroInventado: number;
  /** Resultado descartado por expressão proibida (0 ou 1). */
  readonly expressaoProibida: number;
  /** Itens fora do vocabulário, do tamanho ou do limite de quantidade. */
  readonly forma: number;
}

/**
 * Quantas citações o modelo emitiu e quantas existem no texto enviado. Calculado
 * SEMPRE, também quando o resultado é descartado por outro motivo — é a base da
 * métrica "citações verificadas" da sonda.
 */
export interface ContagemDeCitacoes {
  readonly emitidas: number;
  readonly validas: number;
}

export interface AnaliseVerificada {
  readonly estado: 'verificada';
  readonly parecePedir: ParecePedir;
  /** Ausente quando descartado (número inventado) ou quando indeterminado sem citação. */
  readonly resumo?: string;
  readonly trechoChave?: string;
  readonly acoesPossiveis: readonly AcaoPossivel[];
  readonly pontosDeAtencao: readonly PontoDeAtencao[];
  readonly descartes: DescartesDaVerificacao;
  readonly citacoes: ContagemDeCitacoes;
}

export interface AnaliseNaoVerificada {
  readonly estado: 'nao_verificada';
  readonly motivo: 'sem_citacao_valida' | 'expressao_proibida';
  readonly descartes: DescartesDaVerificacao;
  readonly citacoes: ContagemDeCitacoes;
}

export type ResultadoDaVerificacao = AnaliseVerificada | AnaliseNaoVerificada;

// --- citação ---------------------------------------------------------------

export function citacaoExisteNoTexto(trecho: string, textoNormalizado: string): boolean {
  const alvo = normalizarParaComparar(trecho);
  // Uma citação vazia ou de uma palavra só não sustenta afirmação nenhuma.
  if (alvo.length < 8) return false;
  return textoNormalizado.includes(alvo);
}

// --- números ---------------------------------------------------------------

const MESES = [
  'janeiro',
  'fevereiro',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

const NUMEROS_POR_EXTENSO = [
  'um',
  'uma',
  'dois',
  'duas',
  'tres',
  'quatro',
  'cinco',
  'seis',
  'sete',
  'oito',
  'nove',
  'dez',
  'onze',
  'doze',
  'treze',
  'quatorze',
  'catorze',
  'quinze',
  'dezesseis',
  'dezessete',
  'dezoito',
  'dezenove',
  'vinte',
  'trinta',
  'quarenta',
  'cinquenta',
  'sessenta',
  'setenta',
  'oitenta',
  'noventa',
  'cem',
];

const UNIDADES_DE_TEMPO = '(?:dias?|horas?|meses|mes|semanas?|anos?|minutos?)';

/** Grupos de dígitos, com separador de data/hora/milhar quando houver: 10/10/2026, 14:30, 1.234. */
const NUMERO_COM_SEPARADOR = /\d+(?:[./:-]\d+)*/g;

const NUMERO_POR_EXTENSO_COM_UNIDADE = new RegExp(
  `\\b(${NUMEROS_POR_EXTENSO.join('|')})\\s+(?:\\(\\s*\\d+\\s*\\)\\s*)?(?:${UNIDADES_DE_TEMPO})\\b`,
  'g',
);

function palavraNoTexto(palavra: string, textoNormalizado: string): boolean {
  return new RegExp(`(?<![a-z0-9])${palavra}(?![a-z0-9])`).test(textoNormalizado);
}

function numeroNoTexto(token: string, textoNormalizado: string): boolean {
  const literal = new RegExp(
    `(?<![\\d])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`,
  );
  if (literal.test(textoNormalizado)) return true;

  // Data numérica (10/11/2026) escrita por extenso no texto ("10 de novembro de 2026").
  const data = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(token);
  if (data) {
    const dia = Number(data[1]);
    const mes = Number(data[2]);
    const ano = data[3] ?? '';
    const nomeDoMes = MESES[mes - 1];
    if (nomeDoMes && dia >= 1 && dia <= 31) {
      const porExtenso = new RegExp(
        `(?<!\\d)0?${dia}\\s*(?:o|º)?\\s+de\\s+${nomeDoMes}\\s+de\\s+${ano}(?!\\d)`,
      );
      return porExtenso.test(textoNormalizado);
    }
  }
  return false;
}

/** Números e quantidades de tempo de `texto` que NÃO aparecem em `textoNormalizado`. */
export function numerosForaDoTexto(texto: string, textoNormalizado: string): string[] {
  const normalizado = normalizarParaComparar(texto);
  const ausentes: string[] = [];
  for (const m of normalizado.matchAll(NUMERO_COM_SEPARADOR)) {
    if (!numeroNoTexto(m[0], textoNormalizado)) ausentes.push(m[0]);
  }
  for (const m of normalizado.matchAll(NUMERO_POR_EXTENSO_COM_UNIDADE)) {
    const palavra = m[1];
    if (palavra && !palavraNoTexto(palavra, textoNormalizado)) ausentes.push(palavra);
  }
  return ausentes;
}

// --- expressões proibidas ----------------------------------------------------

export function expressaoProibidaEm(texto: string): string | undefined {
  const normalizado = normalizarParaComparar(texto);
  return EXPRESSOES_PROIBIDAS.find((e) =>
    new RegExp(
      `(?<![a-z0-9])${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`,
    ).test(normalizado),
  );
}

// --- a verificação -----------------------------------------------------------

/**
 * @param resposta  o que o modelo devolveu, já dentro do esquema
 * @param textoEnviado  EXATAMENTE o texto que foi ao modelo (redigido e truncado)
 */
export function verificarAnalise(
  resposta: RespostaDoModelo,
  textoEnviado: string,
): ResultadoDaVerificacao {
  const texto = normalizarParaComparar(textoEnviado);
  let citacao = 0;
  let numeroInventado = 0;
  let forma = 0;

  const trechoChaveValido = citacaoExisteNoTexto(resposta.trecho_chave, texto);
  const acoesComCitacao = resposta.acoes_possiveis.map((a) =>
    citacaoExisteNoTexto(a.trecho, texto),
  );
  const chaveEmitida = resposta.trecho_chave.trim() !== '';
  const citacoes: ContagemDeCitacoes = {
    emitidas: (chaveEmitida ? 1 : 0) + acoesComCitacao.length,
    validas: (trechoChaveValido ? 1 : 0) + acoesComCitacao.filter(Boolean).length,
  };

  const proibidaNoResumo = expressaoProibidaEm(resposta.resumo);
  const proibidaEmAcao = resposta.acoes_possiveis.some(
    (a) => expressaoProibidaEm(a.acao) !== undefined,
  );
  if (proibidaNoResumo !== undefined || proibidaEmAcao) {
    return {
      estado: 'nao_verificada',
      motivo: 'expressao_proibida',
      descartes: { citacao, numeroInventado, forma, expressaoProibida: 1 },
      citacoes,
    };
  }

  // "Indeterminado" é resposta legítima (princípio 4): sem citação, ele é
  // mostrado como tal, mas sem resumo — não há afirmação a sustentar.
  const indeterminadoSemCitacao =
    resposta.parece_pedir === 'indeterminado' && resposta.trecho_chave.trim() === '';

  if (!trechoChaveValido && !indeterminadoSemCitacao) {
    return {
      estado: 'nao_verificada',
      motivo: 'sem_citacao_valida',
      descartes: { citacao: citacao + 1, numeroInventado, forma, expressaoProibida: 0 },
      citacoes,
    };
  }

  let resumo: string | undefined;
  if (trechoChaveValido) {
    if (resposta.resumo.length > LIMITES_DA_ANALISE.resumo) {
      forma += 1;
    } else if (numerosForaDoTexto(resposta.resumo, texto).length > 0) {
      numeroInventado += 1;
    } else if (resposta.resumo.trim() !== '') {
      resumo = resposta.resumo.trim();
    }
  }

  const acoes: AcaoPossivel[] = [];
  resposta.acoes_possiveis.forEach((a, i) => {
    if (i >= LIMITES_DA_ANALISE.acoes) {
      forma += 1;
      return;
    }
    if (a.acao.length > LIMITES_DA_ANALISE.acao || a.acao.trim() === '') {
      forma += 1;
    } else if (!acoesComCitacao[i]) {
      citacao += 1;
    } else if (numerosForaDoTexto(a.acao, texto).length > 0) {
      numeroInventado += 1;
    } else {
      acoes.push({ acao: a.acao.trim(), trecho: a.trecho.trim() });
    }
  });

  const pontos: PontoDeAtencao[] = [];
  for (const p of resposta.pontos_de_atencao) {
    const conhecido = (PONTOS_DE_ATENCAO as readonly string[]).includes(p);
    if (!conhecido || pontos.length >= LIMITES_DA_ANALISE.pontosDeAtencao) {
      forma += 1;
    } else if (!pontos.includes(p)) {
      pontos.push(p);
    }
  }

  return {
    estado: 'verificada',
    parecePedir: resposta.parece_pedir,
    ...(resumo !== undefined ? { resumo } : {}),
    ...(trechoChaveValido ? { trechoChave: resposta.trecho_chave.trim() } : {}),
    acoesPossiveis: acoes,
    pontosDeAtencao: pontos,
    descartes: { citacao, numeroInventado, forma, expressaoProibida: 0 },
    citacoes,
  };
}
