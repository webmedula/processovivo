import { describe, expect, it } from 'vitest';
import type { LimitesDoPainel } from '../../src/domain/entities/ControleDaIa.js';
import {
  LimiteDeAnalises,
  TetoDiario,
} from '../../src/application/politicas/limiteDeAnalises.js';
import type { Clock } from '../../src/domain/ports/Clock.js';

/* O teto técnico com o painel de IA (v0.58.0): o painel só REDUZ; nada disto toca a rede ou o relógio real. */

class Relogio implements Clock {
  ms = new Date('2026-10-05T15:00:00.000Z').getTime();
  agora(): Date {
    return new Date(this.ms);
  }
  monotonico(): number {
    return this.ms;
  }
}

const SEM: LimitesDoPainel = {
  porFuncao: { ato: undefined, resumo: undefined, peca: undefined },
  global: undefined,
};

describe('TetoDiario com o painel', () => {
  it('sem painel é o de sempre: só o ambiente', () => {
    const t = new TetoDiario(3, new Relogio());
    for (let i = 0; i < 3; i++) {
      expect(t.cabe('ws')).toBe(true);
      t.registrar('ws');
    }
    expect(t.cabe('ws')).toBe(false);
  });

  it('o teto da função no painel reduz só aquela função; o ambiente segue valendo para o total', () => {
    let limites: LimitesDoPainel = {
      ...SEM,
      porFuncao: { ato: 2, resumo: undefined, peca: undefined },
    };
    const t = new TetoDiario(10, new Relogio(), { limites: () => limites });
    t.registrar('ws', 1, 'ato');
    t.registrar('ws', 1, 'ato');
    expect(t.cabe('ws', 1, 'ato')).toBe(false);
    expect(t.cabe('ws', 1, 'resumo')).toBe(true);
    // Subir o teto do painel acima do ambiente não passa de 10 no total.
    limites = { ...SEM, porFuncao: { ato: 999, resumo: undefined, peca: undefined } };
    expect(t.cabe('ws', 1, 'ato')).toBe(true);
    for (let i = 0; i < 8; i++) t.registrar('ws', 1, 'resumo');
    expect(t.cabe('ws', 1, 'ato')).toBe(false);
  });

  it('o teto efetivo é o MENOR entre o ambiente e o painel', () => {
    const t = new TetoDiario(2, new Relogio(), {
      limites: () => ({
        ...SEM,
        porFuncao: { ato: 50, resumo: undefined, peca: undefined },
      }),
    });
    t.registrar('ws', 1, 'ato');
    t.registrar('ws', 1, 'ato');
    expect(t.cabe('ws', 1, 'ato')).toBe(false);
  });

  it('o peso da peça (5) conta no teto da função do painel', () => {
    const t = new TetoDiario(100, new Relogio(), {
      limites: () => ({
        ...SEM,
        porFuncao: { ato: undefined, resumo: undefined, peca: 10 },
      }),
    });
    t.registrar('ws', 5, 'peca');
    expect(t.cabe('ws', 5, 'peca')).toBe(true);
    t.registrar('ws', 5, 'peca');
    expect(t.cabe('ws', 5, 'peca')).toBe(false);
  });

  it('o teto global soma todas as contas e funções do dia', () => {
    const t = new TetoDiario(100, new Relogio(), {
      limites: () => ({ ...SEM, global: 3 }),
    });
    t.registrar('a', 1, 'ato');
    t.registrar('b', 1, 'resumo');
    t.registrar('c', 1, 'ato');
    expect(t.cabe('d', 1, 'ato')).toBe(false);
  });

  it('o dia vira em São Paulo (03:00 UTC) e zera função e global', () => {
    const r = new Relogio();
    r.ms = new Date('2026-10-06T02:59:00.000Z').getTime();
    const t = new TetoDiario(100, r, {
      limites: () => ({
        porFuncao: { ato: 1, resumo: undefined, peca: undefined },
        global: 1,
      }),
    });
    t.registrar('ws', 1, 'ato');
    expect(t.cabe('ws', 1, 'ato')).toBe(false);
    r.ms = new Date('2026-10-06T03:00:00.000Z').getTime();
    expect(t.cabe('ws', 1, 'ato')).toBe(true);
  });

  it('painel que lança não derruba o freio: vale só o ambiente', () => {
    const t = new TetoDiario(2, new Relogio(), {
      limites: () => {
        throw new Error('quebrou');
      },
    });
    expect(t.cabe('ws', 1, 'ato')).toBe(true);
    t.registrar('ws', 1, 'ato');
    t.registrar('ws', 1, 'ato');
    expect(t.cabe('ws', 1, 'ato')).toBe(false);
  });
});

describe('LimiteDeAnalises por função', () => {
  it('negada pelo teto do painel é "dia" e NÃO consome nada', () => {
    const r = new Relogio();
    const teto = new TetoDiario(100, r, {
      limites: () => ({
        ...SEM,
        porFuncao: { ato: 1, resumo: undefined, peca: undefined },
      }),
    });
    const limite = new LimiteDeAnalises({
      porHora: 100,
      simultaneasNoTotal: 10,
      teto,
      funcao: 'ato',
      clock: r,
    });
    const primeira = limite.reservar('ws');
    expect(primeira).toHaveProperty('liberar');
    if ('liberar' in primeira) primeira.liberar();
    expect(limite.reservar('ws')).toEqual({ negada: 'dia' });
    // O resumo (outra função) segue livre na mesma conta.
    const doResumo = new LimiteDeAnalises({
      porHora: 100,
      simultaneasNoTotal: 10,
      teto,
      funcao: 'resumo',
      clock: r,
    });
    expect(doResumo.reservar('ws')).toHaveProperty('liberar');
  });
});
