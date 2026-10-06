/**
 * Trecho curto do texto de um ato, para a lista "Últimas atualizações" (v0.35.1).
 *
 * A função é pura e AUTOCONTIDA de propósito: o console é JavaScript dentro de
 * uma string (`atualizacoes.ts`), então o navegador recebe `trechoDeTexto.toString()`
 * e o teste exercita exatamente a mesma função. Por isso ela não pode usar nada
 * de fora do próprio corpo (nem helper, nem constante de módulo).
 *
 * Só a EXIBIÇÃO encurta: o dado guardado e o da API continuam inteiros, e o texto
 * completo está no processo.
 */
export interface TrechoDeTexto {
  readonly texto: string;
  readonly cortado: boolean;
}

export function trechoDeTexto(entrada: unknown, limite?: number): TrechoDeTexto {
  const max = typeof limite === 'number' && limite > 0 ? Math.floor(limite) : 220;
  if (typeof entrada !== 'string') return { texto: '', cortado: false };
  // Quebras e espaços repetidos viram um espaço só: a lista não é lugar de parágrafo.
  const limpo = entrada.normalize('NFC').replace(/\s+/g, ' ').trim();
  // Array.from conta pontos de código: emoji e acento decomposto não são cortados ao meio.
  const letras = Array.from(limpo);
  if (letras.length <= max) return { texto: limpo, cortado: false };

  let fim = max;
  // Cortou no meio de uma palavra: recua até o último espaço (se houver algum).
  if (letras[fim] !== ' ') {
    const espaco = letras.lastIndexOf(' ', fim);
    if (espaco > 0) fim = espaco;
  }
  // Nunca deixa a emenda de um emoji composto ou de um acento solto para trás.
  const emenda = /^(?:‍|️|\p{M})$/u;
  while (fim > 1 && (emenda.test(letras[fim] ?? '') || letras[fim - 1] === '‍')) fim--;

  const texto = letras
    .slice(0, fim)
    .join('')
    // Pontuação e abertura de parêntese que ficaram pendurando antes das reticências.
    .replace(/[\s,;:\-–—([/]+$/, '');
  return { texto, cortado: true };
}
