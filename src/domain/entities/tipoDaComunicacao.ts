/**
 * O que o DJEN chama de "tipo da comunicação": intimação, citação, edital…
 *
 * É o único campo da fonte que diz, sem interpretar texto, que o ato foi
 * ENDEREÇADO a alguém — e é por isso que ele existe separado do `tipoDocumento`
 * ("Ato ordinatório", "Decisão"): o documento intimado pode ter qualquer
 * rótulo, e "Ato ordinatório" nunca foi reconhecido como pedido de providência.
 *
 * Só duas respostas importam para o produto. Todo o resto (edital, lista de
 * distribuição, valor ausente ou desconhecido) é `outro`: não vira providência
 * por palpite.
 */
export type TipoDaComunicacao = 'intimacao' | 'citacao' | 'outro';

/** Minúsculas, sem acento e sem espaço nas pontas: "Intimação " e "INTIMAÇÃO" são o mesmo valor. */
function normalizar(valor: string): string {
  return valor.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Classifica o tipo de comunicação como veio do DJEN.
 *
 * Casa pelo COMEÇO da palavra e não por "contém": "Intimação eletrônica" é
 * intimação, mas "Edital de citação" não é citação — é edital, outro ato, com
 * outro significado, e tratá-lo como citação marcaria providência por uma
 * palavra solta.
 */
export function tipoDaComunicacao(tipo: string | null | undefined): TipoDaComunicacao {
  if (!tipo) return 'outro';
  const t = normalizar(tipo);
  if (/^intimacao\b/.test(t)) return 'intimacao';
  if (/^citacao\b/.test(t)) return 'citacao';
  return 'outro';
}
