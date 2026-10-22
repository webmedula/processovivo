import { MINIMO_DE_CARACTERES_DO_TEXTO } from './entradaDoModelo.js';

/**
 * Limpeza MÍNIMA do cabeçalho institucional repetido no começo do texto de um ato (v0.54.0).
 *
 * Publicação do Diário e despacho copiado do sistema do tribunal abrem com o mesmo bloco —
 * "PODER JUDICIÁRIO / Tribunal de Justiça… / Comarca de… / 2ª Vara… / endereço e CEP /
 * Autos nº… / Natureza… / Polo Ativo… / Polo Passivo…" — que gasta o limite de caracteres do
 * ato e empurra o conteúdo para o corte. A regra é CONSERVADORA de propósito: na dúvida, o
 * texto fica como veio.
 *
 *  - só as primeiras linhas, e só enquanto CADA linha (curta) casar com um padrão de cabeçalho;
 *    a primeira linha que não casa encerra a limpeza, e o que vem depois nunca é tocado;
 *  - exige ao menos duas linhas de cabeçalho (uma só é indício, não bloco);
 *  - o que sobra tem de continuar com texto utilizável (≥ 80 caracteres); senão, o original;
 *  - nunca mexe no meio nem no fim do texto.
 *
 * O texto enviado ao modelo é o texto VERIFICADO: a limpeza vale antes da redação e da
 * verificação, então citação e número são conferidos contra o que de fato foi enviado.
 */
const LINHAS_LIDAS = 14;
const LINHA_MAXIMA = 140;
const MINIMO_DE_LINHAS = 2;

const PADROES_DE_CABECALHO: readonly RegExp[] = [
  /^(poder judici[aá]rio|rep[uú]blica federativa do brasil)\b/i,
  /^(estado d[eo]a?s?\s+\S.*|tribunal\s+(de|regional)\s+\S.*|justi[cç]a\s+(federal|do trabalho|estadual|eleitoral)\b.*)$/i,
  /^(comarca|foro|f[oó]rum)\s+(central\s+)?(de|do|da|dos|das)\s+\S.*$/i,
  /^((\d+\s*[ªaº°]?\s*)?(vara|juizado|turma|secretaria|cart[oó]rio)\b|vara\b).*$/i,
  /^(autos?|processo)\s*(n[º°o.]*|n[uú]mero)?\s*:?\s*[\d.\-/]{7,}\s*$/i,
  /^natureza\s*:.*$/i,
  /^p[oó]lo\s+(ativo|passivo)\s*:.*$/i,
  /^.*\bcep\b\s*:?\s*\d{5}-?\d{3}.*$/i,
  /^(telefone|fone|tel\.?)\s*:.*$/i,
];

export function removerCabecalhoInstitucional(texto: string): string {
  const linhas = texto.split('\n');
  let fim = 0; // índice da primeira linha que NÃO é cabeçalho
  let removidas = 0;
  for (let i = 0; i < linhas.length && i < LINHAS_LIDAS; i++) {
    const linha = (linhas[i] ?? '').trim();
    if (linha === '') {
      fim = i + 1;
      continue;
    }
    if (linha.length > LINHA_MAXIMA || !PADROES_DE_CABECALHO.some((p) => p.test(linha))) {
      break;
    }
    fim = i + 1;
    removidas++;
  }
  if (removidas < MINIMO_DE_LINHAS) return texto;
  const resto = linhas.slice(fim).join('\n').trim();
  if (resto.replace(/\s+/g, ' ').length < MINIMO_DE_CARACTERES_DO_TEXTO) return texto;
  return resto;
}
