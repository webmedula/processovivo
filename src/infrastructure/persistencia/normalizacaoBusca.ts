/**
 * Forma normalizada de um texto para BUSCA — maiúsculas e sem acento.
 *
 * Existe num módulo próprio porque duas partes do sistema precisam concordar
 * exatamente: a gravação da coluna `partes_texto` e a montagem do `LIKE` que a
 * consulta. Se divergirem, o filtro passa a achar uns nomes e não outros, sem
 * erro nenhum — o pior tipo de defeito, porque parece funcionar.
 *
 * **Por que não usar o `upper()` do SQLite:** ele é ASCII-only. `upper('José')`
 * devolve `JOSé`, com o "é" intacto. Medido, não suposto. Uma retrocarga feita
 * em SQL gravaria `JOSé` e as sincronizações seguintes gravariam `JOSÉ`, e o
 * advogado que digitasse "josé" acharia metade dos processos.
 *
 * **Por que dobrar o acento também:** ninguém digita acento numa busca. Quem
 * procura o cliente "José Antônio" escreve "jose antonio" — e um filtro que
 * exige o acento correto parece dizer que o cliente não tem processo. Dobrando
 * as duas pontas, "jose" acha "JOSÉ" e "JOSÉ" acha "jose".
 *
 * O que NÃO fazemos: remover pontuação, `LTDA`, `S/A` ou palavras de ligação.
 * Seria adivinhar o que o usuário quis, e razão social tem pontuação
 * significativa — `LIKE %termo%` já tolera o que importa.
 */
export function paraBusca(texto: string): string {
  return texto
    .normalize('NFD')
    // Remove os diacríticos separados pelo NFD, mantendo a letra base.
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim();
}
