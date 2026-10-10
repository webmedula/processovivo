/**
 * Normalização usada para COMPARAR texto (nunca para exibir): minúsculas, sem
 * acento, espaços colapsados. É a comparação da spec ia-analise-do-ato, seção 6.
 *
 * `semAcentoMantendoTamanho` preserva o comprimento da string original, para que
 * um índice achado no texto normalizado valha no original — a redação precisa
 * disso para cortar o trecho certo.
 */

export function semAcentoMantendoTamanho(texto: string): string {
  let saida = '';
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charAt(i);
    const base = c.normalize('NFD').charAt(0);
    saida += base.toLowerCase();
  }
  return saida;
}

/** Minúsculas, sem acento, aspas/travessões unificados e espaços colapsados. */
export function normalizarParaComparar(texto: string): string {
  return semAcentoMantendoTamanho(texto)
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}
