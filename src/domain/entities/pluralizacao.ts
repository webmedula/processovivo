/**
 * Concordância de número em UM lugar (v0.56.0). Os textos das telas de IA com contagem
 * ("1 ato tem só o título", "2 atos têm só o título", "nenhum ato") nasciam de `n === 1 ? … : …`
 * escritos à mão em cada tela, e um deles saiu com o verbo no plural ("1 ato como pedem providência").
 *
 * Funções PURAS e AUTOCONTIDAS (nenhuma chama a outra): vão ao console por `toString()`, como
 * `descricaoDoAto`, então o navegador, o servidor e os testes exercitam a MESMA função.
 * Português: 1 é singular; 0 e 2 ou mais são plural; a forma de 0 pode ser trocada por uma frase
 * própria ("nenhum ato").
 */

/** Só a palavra concordada com `n`: `pluralizar(1, 'pede', 'pedem')` → "pede". */
export function pluralizar(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

/**
 * O número junto da palavra: `contar(2, 'ato', 'atos')` → "2 atos". Com `zero`, o zero vira a
 * frase pronta: `contar(0, 'ato', 'atos', 'nenhum ato')` → "nenhum ato".
 */
export function contar(
  n: number,
  singular: string,
  plural: string,
  zero?: string,
): string {
  if (n === 0 && zero !== undefined) return zero;
  return String(n) + ' ' + (n === 1 ? singular : plural);
}
