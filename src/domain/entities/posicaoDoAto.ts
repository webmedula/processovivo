import type { Movimentacao } from './Movimentacao.js';
import { numeroDoMovimento } from './linhaDoTempo.js';

/**
 * A posição de cada ato na ordem cronológica crescente da resposta do MNI
 * (1-based) — o número que a Pasta mostra como "mov. N" (v0.34.0).
 *
 * É CÁLCULO nosso, não afirmação do tribunal: o Projudi numera em sequência
 * todos os atos, inclusive os bloqueados ("Movimentação Bloqueada") que o MNI
 * não entrega. Por isso a posição só iguala o número do Projudi até o primeiro
 * ato bloqueado; depois dele ela fica abaixo. A tela diz isso — ver CLAUDE.md.
 *
 * Desempate estável: `dataHora`, depois `identificadorMovimento` (atos sem
 * identificador vão depois dos que têm), depois a ordem em que vieram. Sem o
 * terceiro critério o resultado dependeria do algoritmo de ordenação.
 */
export interface PosicoesDosAtos {
  /** Quantos atos o MNI entregou (e o mapper aceitou) nesta resposta. */
  readonly total: number;
  /** `identificadorMovimento` → posição. Identificador repetido não entra. */
  readonly porIdentificador: ReadonlyMap<number, number>;
}

export function calcularPosicoesDosAtos(
  movimentos: readonly Movimentacao[],
): PosicoesDosAtos {
  const itens = movimentos.map((m, indice) => ({
    indice,
    instante: m.data.getTime(),
    id: numeroDoMovimento(m),
  }));
  itens.sort((a, b) => {
    if (a.instante !== b.instante) return a.instante - b.instante;
    if (a.id !== b.id) {
      if (a.id === undefined) return 1;
      if (b.id === undefined) return -1;
      return a.id - b.id;
    }
    return a.indice - b.indice;
  });

  const porIdentificador = new Map<number, number>();
  const repetidos = new Set<number>();
  itens.forEach((item, i) => {
    if (item.id === undefined) return;
    if (porIdentificador.has(item.id)) {
      repetidos.add(item.id);
      return;
    }
    porIdentificador.set(item.id, i + 1);
  });
  // Identificador repetido é vínculo ambíguo: sem posição, como já era sem ato.
  for (const id of repetidos) porIdentificador.delete(id);
  return { total: itens.length, porIdentificador };
}
