import type { AtoListado, PecaListada } from './PastaDigital.js';
import { numeroDoProjudi, type AncoraDeNumeracao } from './numeracaoDoProjudi.js';

/**
 * Juntar atos e peças na lista da Pasta (v0.36.0). Funções puras: sem I/O e sem
 * consulta ao tribunal — tudo sai da listagem já gravada.
 */

/** Um número que o Projudi tem e o MNI não entregou, provado pelas âncoras. */
export interface LacunaDeNumeracao {
  /** A lacuna fica entre o ato nesta posição e o seguinte (posição + 1). */
  readonly depoisDaPosicao: number;
  /** Primeiro e último número ausentes (iguais quando falta um só). */
  readonly de: number;
  readonly ate: number;
}

/**
 * Onde o salto de numeração é PROVADO: dois atos vizinhos com número EXATO e
 * diferença maior que 1. Faixa, estimado e posição nunca geram lacuna — numa
 * lista sem prova a ausência de ato não se afirma. Quem a produz são as
 * âncoras: dentro de um trecho de deslocamento igual os números são seguidos.
 */
export function lacunasDeNumeracao(
  ancoras: readonly AncoraDeNumeracao[],
  totalRecebido: number,
): LacunaDeNumeracao[] {
  const lacunas: LacunaDeNumeracao[] = [];
  if (ancoras.length === 0) return lacunas;
  let anterior = numeroDoProjudi(1, ancoras, totalRecebido);
  for (let p = 1; p < totalRecebido; p++) {
    const seguinte = numeroDoProjudi(p + 1, ancoras, totalRecebido);
    if (
      anterior.tipo === 'exato' &&
      seguinte.tipo === 'exato' &&
      seguinte.n - anterior.n > 1
    ) {
      lacunas.push({ depoisDaPosicao: p, de: anterior.n + 1, ate: seguinte.n - 1 });
    }
    anterior = seguinte;
  }
  return lacunas;
}

/** Os atos que NÃO têm peça: o que a lista acrescenta às linhas de peça. */
export function atosSemPeca(
  atos: readonly AtoListado[],
  pecas: readonly PecaListada[],
): AtoListado[] {
  const comPeca = new Set<number>();
  for (const p of pecas) if (p.movimento !== undefined) comPeca.add(p.movimento);
  return atos
    .filter(
      (a) =>
        a.vinculoIncerto ||
        a.identificador === undefined ||
        !comPeca.has(a.identificador),
    )
    .sort((a, b) => b.posicao - a.posicao);
}

export type LinhaDaPasta =
  | { readonly tipo: 'peca'; readonly pecaId: string }
  | { readonly tipo: 'ato'; readonly posicao: number }
  | { readonly tipo: 'lacuna'; readonly depoisDaPosicao: number };

/**
 * A ordem da lista: a das peças (a dos autos), com cada ato sem peça — e cada
 * lacuna — no lugar que a posição cronológica dele manda. A lista é "mais
 * recente primeiro" na prática; se as peças vierem em ordem crescente de
 * posição, a intercalação acompanha. Peça sem posição não move ninguém: segue
 * onde estava. O que sobrar vai ao fim, na direção da lista.
 */
export function intercalarLinhas(
  pecas: readonly PecaListada[],
  semPeca: readonly AtoListado[],
  lacunas: readonly LacunaDeNumeracao[],
): LinhaDaPasta[] {
  const ordenadas = [...pecas].sort((a, b) => a.ordem - b.ordem);
  const posicoes = ordenadas
    .map((p) => p.movimentacao?.posicao)
    .filter((n): n is number => n !== undefined);
  const crescente =
    posicoes.length > 1 &&
    (posicoes[0] as number) < (posicoes[posicoes.length - 1] as number);
  const pendentes: Array<{ chave: number; linha: LinhaDaPasta }> = [
    ...semPeca.map((a) => ({
      chave: a.posicao,
      linha: { tipo: 'ato', posicao: a.posicao } as const,
    })),
    // A lacuna mora entre dois atos: chave fracionária, depois do ato de baixo.
    ...lacunas.map((l) => ({
      chave: l.depoisDaPosicao + 0.5,
      linha: { tipo: 'lacuna', depoisDaPosicao: l.depoisDaPosicao } as const,
    })),
  ].sort((a, b) => (crescente ? a.chave - b.chave : b.chave - a.chave));

  const saida: LinhaDaPasta[] = [];
  let i = 0;
  const antes = (chave: number, posicao: number): boolean =>
    crescente ? chave < posicao : chave > posicao;
  for (const p of ordenadas) {
    const posicao = p.movimentacao?.posicao;
    if (posicao !== undefined) {
      while (
        i < pendentes.length &&
        antes((pendentes[i] as { chave: number }).chave, posicao)
      ) {
        saida.push((pendentes[i] as { linha: LinhaDaPasta }).linha);
        i++;
      }
    }
    saida.push({ tipo: 'peca', pecaId: p.pecaId });
  }
  for (; i < pendentes.length; i++)
    saida.push((pendentes[i] as { linha: LinhaDaPasta }).linha);
  return saida;
}
