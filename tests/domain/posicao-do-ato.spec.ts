import { describe, expect, it } from 'vitest';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { calcularPosicoesDosAtos } from '../../src/domain/entities/posicaoDoAto.js';

const ato = (id: number | undefined, data: string): Movimentacao => ({
  data: new Date(data),
  titulo: 'Ato sintético',
  fonte: 'mni',
  ...(id !== undefined ? { idExterno: `mni:${id}` } : {}),
});

describe('posição do ato (ordem cronológica do MNI, 1-based)', () => {
  it('ordena por data mesmo com os atos fora de ordem na resposta', () => {
    const r = calcularPosicoesDosAtos([
      ato(900000003, '2026-09-09T10:00:00Z'),
      ato(900000001, '2026-09-01T10:00:00Z'),
      ato(900000002, '2026-09-05T10:00:00Z'),
    ]);
    expect(r.total).toBe(3);
    expect([...r.porIdentificador]).toEqual([
      [900000001, 1],
      [900000002, 2],
      [900000003, 3],
    ]);
  });

  it('desempata dataHora igual pelo identificador, e a ordem de chegada não interfere', () => {
    const mesma = '2026-09-01T10:00:00Z';
    const um = calcularPosicoesDosAtos([ato(20, mesma), ato(10, mesma), ato(30, mesma)]);
    const outro = calcularPosicoesDosAtos([
      ato(30, mesma),
      ato(10, mesma),
      ato(20, mesma),
    ]);
    expect(um.porIdentificador.get(10)).toBe(1);
    expect(um.porIdentificador.get(20)).toBe(2);
    expect(um.porIdentificador.get(30)).toBe(3);
    expect([...outro.porIdentificador]).toEqual([...um.porIdentificador]);
  });

  it('ato sem identificador conta na posição dos outros, mas não ganha posição própria', () => {
    const r = calcularPosicoesDosAtos([
      ato(2, '2026-09-02T10:00:00Z'),
      ato(undefined, '2026-09-01T10:00:00Z'),
    ]);
    expect(r.total).toBe(2);
    expect(r.porIdentificador.get(2)).toBe(2);
  });

  it('identificador repetido não recebe posição (vínculo ambíguo), mas conta no total', () => {
    const r = calcularPosicoesDosAtos([
      ato(1, '2026-09-01T10:00:00Z'),
      ato(1, '2026-09-02T10:00:00Z'),
      ato(2, '2026-09-03T10:00:00Z'),
    ]);
    expect(r.total).toBe(3);
    expect(r.porIdentificador.has(1)).toBe(false);
    expect(r.porIdentificador.get(2)).toBe(3);
  });

  it('sem atos, total zero', () => {
    expect(calcularPosicoesDosAtos([])).toEqual({
      total: 0,
      porIdentificador: new Map(),
      datas: [],
    });
  });
});
