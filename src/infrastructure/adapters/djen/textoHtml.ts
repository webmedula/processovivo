/**
 * Limpeza do campo `texto` do DJEN.
 *
 * O DJEN devolve o inteiro teor do ato como HTML *escapado*: entidades nomeadas
 * (`&Aacute;`, `&ccedil;`, `&nbsp;`, `&ordm;`, `&sect;`), entidades numéricas
 * (`&#233;`, `&#xE9;`) e, em parte dos registros, marcação de verdade (`<p>`,
 * `<br>`, tabelas inteiras). Ver `tests/fixtures/djen-comunica-real.json`.
 *
 * Por que um decodificador próprio em vez de uma biblioteca: `domain/` não pode
 * ganhar dependência de I/O, e trazer um parser de HTML inteiro para resolver
 * ~40 entidades numa string é peso morto no contêiner. O conjunto abaixo cobre
 * o que a Justiça brasileira efetivamente emite — acentuação latina, ordinais,
 * símbolo de parágrafo e aspas. O que não estiver aqui cai no caminho numérico
 * ou permanece literal, que é melhor do que quebrar a publicação inteira.
 */

const ENTIDADES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ordm: 'º',
  ordf: 'ª',
  sect: '§',
  deg: '°',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  aacute: 'á',
  Aacute: 'Á',
  agrave: 'à',
  Agrave: 'À',
  atilde: 'ã',
  Atilde: 'Ã',
  acirc: 'â',
  Acirc: 'Â',
  eacute: 'é',
  Eacute: 'É',
  ecirc: 'ê',
  Ecirc: 'Ê',
  iacute: 'í',
  Iacute: 'Í',
  oacute: 'ó',
  Oacute: 'Ó',
  otilde: 'õ',
  Otilde: 'Õ',
  ocirc: 'ô',
  Ocirc: 'Ô',
  uacute: 'ú',
  Uacute: 'Ú',
  uuml: 'ü',
  Uuml: 'Ü',
  ccedil: 'ç',
  Ccedil: 'Ç',
};

const REFERENCIA = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;

/** Converte entidades HTML para os caracteres correspondentes. */
export function decodificarEntidades(texto: string): string {
  return texto.replace(REFERENCIA, (original, corpo: string) => {
    if (corpo.startsWith('#x') || corpo.startsWith('#X')) {
      const codigo = Number.parseInt(corpo.slice(2), 16);
      return Number.isFinite(codigo) ? String.fromCodePoint(codigo) : original;
    }
    if (corpo.startsWith('#')) {
      const codigo = Number.parseInt(corpo.slice(1), 10);
      return Number.isFinite(codigo) ? String.fromCodePoint(codigo) : original;
    }
    // Entidade nomeada: o casamento é sensível a maiúsculas de propósito.
    // `&Aacute;` e `&aacute;` são letras diferentes, e normalizar aqui
    // transformaria "JUDICIÁRIO" em "JUDICIáRIO".
    return ENTIDADES[corpo] ?? original;
  });
}

const BLOCOS = /<\/?(p|div|br|tr|li|h[1-6]|table)\b[^>]*>/gi;
const TAGS = /<[^>]+>/g;
const ESPACOS_HORIZONTAIS = /[^\S\n]+/g;
const LINHAS_VAZIAS = /\n{3,}/g;

/**
 * Devolve o ato como texto corrido legível: marcação removida, entidades
 * resolvidas, espaços normalizados.
 *
 * A ORDEM É O PONTO DELICADO, e eu errei nela primeiro. Decodificar antes de
 * remover as tags transforma `&lt;prazo&gt;` — escrito de propósito dentro do
 * despacho — em `<prazo>`, que o passo seguinte apaga como se fosse marcação.
 * O texto perde um trecho do ato em silêncio. Removendo as tags REAIS primeiro
 * e só então decodificando, a tag de verdade some e a citada sobrevive.
 *
 * Textos com marcação existem de fato: as notificações do TRT10 na amostra real
 * vêm com `<p>`, `<br>` e tabelas.
 *
 * Nada é truncado. Um despacho cortado no meio é pior do que um despacho longo:
 * o advogado lê metade de uma decisão e conclui o oposto do que ela diz.
 */
export function limparTextoDoAto(texto: string): string {
  return decodificarEntidades(
    texto.replace(BLOCOS, '\n').replace(TAGS, ''),
  )
    .replace(/\r\n?/g, '\n')
    .replace(ESPACOS_HORIZONTAIS, ' ')
    .split('\n')
    .map((linha) => linha.trim())
    .join('\n')
    .replace(LINHAS_VAZIAS, '\n\n')
    .trim();
}

/**
 * Primeira linha com conteúdo — serve de título quando o DJEN não classifica o
 * documento. Limitada porque vai para uma lista, não para leitura.
 */
export function primeiraLinhaSignificativa(texto: string, limite = 120): string {
  const linha = limparTextoDoAto(texto)
    .split('\n')
    .find((l) => l.length > 0);
  if (!linha) return '';
  return linha.length <= limite ? linha : `${linha.slice(0, limite - 1)}…`;
}
