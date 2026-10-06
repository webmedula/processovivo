import { describe, expect, it } from 'vitest';
import {
  atosSemPeca,
  intercalarLinhas,
  lacunasDeNumeracao,
} from '../../src/domain/entities/linhasDaPasta.js';
import type { AtoListado, PecaListada } from '../../src/domain/entities/PastaDigital.js';

const ato = (posicao: number, extra: Partial<AtoListado> = {}): AtoListado => ({
  posicao,
  data: new Date(Date.UTC(2025, 0, posicao)),
  descricao: `Ato sintético ${posicao}`,
  identificador: 1000 + posicao,
  ...extra,
});
const peca = (pecaId: string, ordem: number, posicao?: number): PecaListada => ({
  pecaId,
  ordem,
  rotulo: `Peça ${pecaId}`,
  sigilosa: false,
  ...(posicao !== undefined
    ? {
        movimento: 1000 + posicao,
        movimentacao: {
          numero: 1000 + posicao,
          posicao,
          data: new Date(Date.UTC(2025, 0, posicao)),
          descricao: `Ato sintético ${posicao}`,
        },
      }
    : {}),
});

describe('atos sem peça', () => {
  it('separa o ato com 0, 1 e 3 peças: só o de 0 peça vira linha própria', () => {
    const atos = [ato(1), ato(2), ato(3)];
    const pecas = [peca('a', 0, 3), peca('b', 1, 3), peca('c', 2, 3), peca('d', 3, 2)];
    expect(atosSemPeca(atos, pecas).map((a) => a.posicao)).toEqual([1]);
  });

  it('ato sem identificador não pode ter peça: é sem peça', () => {
    const { identificador: _i, ...semId } = ato(5);
    expect(atosSemPeca([semId], [peca('a', 0, 5)]).map((a) => a.posicao)).toEqual([5]);
  });

  it('identificador repetido continua na lista, marcado como vínculo incerto', () => {
    const r = atosSemPeca(
      [
        ato(1, { vinculoIncerto: true }),
        ato(2, { vinculoIncerto: true, identificador: 1001 }),
      ],
      [peca('a', 0)],
    );
    expect(r.every((a) => a.vinculoIncerto)).toBe(true);
    expect(r).toHaveLength(2);
  });

  it('vem do mais recente para o mais antigo', () => {
    expect(atosSemPeca([ato(1), ato(9), ato(4)], []).map((a) => a.posicao)).toEqual([
      9, 4, 1,
    ]);
  });
});

describe('intercalar atos e peças', () => {
  it('põe cada ato sem peça na posição cronológica; peças do mesmo ato ficam juntas e em ordem', () => {
    const pecas = [
      peca('x', 0, 6),
      peca('y1', 1, 4),
      peca('y2', 2, 4),
      peca('y3', 3, 4),
      peca('z', 4, 1),
    ];
    const linhas = intercalarLinhas(pecas, [ato(7), ato(5), ato(3), ato(2)], []);
    expect(
      linhas.map((l) =>
        l.tipo === 'peca' ? l.pecaId : `ato${(l as { posicao: number }).posicao}`,
      ),
    ).toEqual(['ato7', 'x', 'ato5', 'y1', 'y2', 'y3', 'ato3', 'ato2', 'z']);
  });

  it('acompanha a lista quando as peças vêm em ordem crescente', () => {
    const pecas = [peca('z', 0, 1), peca('y', 1, 4), peca('x', 2, 6)];
    const linhas = intercalarLinhas(pecas, [ato(7), ato(3)], []);
    expect(
      linhas.map((l) =>
        l.tipo === 'peca' ? l.pecaId : `ato${(l as { posicao: number }).posicao}`,
      ),
    ).toEqual(['z', 'ato3', 'y', 'x', 'ato7']);
  });

  it('sem nenhuma peça, a lista é só de atos, do mais recente ao mais antigo', () => {
    const linhas = intercalarLinhas([], [ato(3), ato(2)], []);
    expect(linhas).toEqual([
      { tipo: 'ato', posicao: 3 },
      { tipo: 'ato', posicao: 2 },
    ]);
  });

  it('a lacuna fica entre os dois atos vizinhos', () => {
    const linhas = intercalarLinhas(
      [peca('a', 0, 5), peca('b', 1, 3)],
      [ato(4)],
      [{ depoisDaPosicao: 3, de: 9, ate: 9 }],
    );
    expect(linhas.map((l) => l.tipo)).toEqual(['peca', 'ato', 'lacuna', 'peca']);
  });
});

describe('lacuna de numeração', () => {
  it('só com número EXATO dos dois lados: o bloqueado 368 entre 367 e 369', () => {
    const ancoras = [
      { posicao: 367, numeroProjudi: 367 },
      { posicao: 368, numeroProjudi: 369 },
      { posicao: 385, numeroProjudi: 386 },
    ];
    expect(lacunasDeNumeracao(ancoras, 385)).toEqual([
      { depoisDaPosicao: 367, de: 368, ate: 368 },
    ]);
  });

  it('vários números ausentes viram uma lacuna só', () => {
    const r = lacunasDeNumeracao(
      [
        { posicao: 5, numeroProjudi: 5 },
        { posicao: 6, numeroProjudi: 9 },
      ],
      6,
    );
    expect(r).toEqual([{ depoisDaPosicao: 5, de: 6, ate: 8 }]);
  });

  it('faixa, estimado e posição nunca geram lacuna', () => {
    // Sem âncora: só posição.
    expect(lacunasDeNumeracao([], 50)).toEqual([]);
    // Âncora única no meio: antes dela é faixa, depois é estimado — nenhum par exato vizinho.
    expect(lacunasDeNumeracao([{ posicao: 25, numeroProjudi: 30 }], 50)).toEqual([]);
  });

  it('âncoras de mesmo deslocamento não deixam lacuna', () => {
    const r = lacunasDeNumeracao(
      [
        { posicao: 3, numeroProjudi: 4 },
        { posicao: 9, numeroProjudi: 10 },
      ],
      12,
    );
    expect(r).toEqual([]);
  });
});
