/**
 * Estatística mínima, sem dependência. UMA implementação para o comparador de modelos, o relatório
 * `scripts/ia-avaliacoes.mjs` e o painel de IA do /admin (v0.58.0): percentil em dois lugares é
 * percentil que um dia diverge.
 */

/** Percentil por posição (método do "próximo posto"): p50 de [1,2,3,4] é 2. Vazio = `undefined`. */
export function percentil(valores: readonly number[], p: number): number | undefined {
  if (valores.length === 0) return undefined;
  const ordenados = [...valores].sort((a, b) => a - b);
  const posicao = Math.min(
    ordenados.length - 1,
    Math.max(0, Math.ceil(p * ordenados.length) - 1),
  );
  return ordenados[posicao];
}

export function media(valores: readonly number[]): number | undefined {
  return valores.length === 0
    ? undefined
    : valores.reduce((a, b) => a + b, 0) / valores.length;
}
