import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EstadoDeConexaoRecusado,
  EstadosDeConexao,
  VALIDADE_DO_ESTADO_MS,
} from '../../src/application/politicas/estadosDeConexao.js';
import type { Clock } from '../../src/domain/ports/Clock.js';

class Relogio implements Clock {
  constructor(private t = new Date('2026-10-14T12:00:00.000Z').getTime()) {}
  agora(): Date {
    return new Date(this.t);
  }
  monotonico(): number {
    return this.t;
  }
  avancar(ms: number): void {
    this.t += ms;
  }
}

const SEGREDO = Buffer.from('segredo-sintetico-de-teste-com-32-bytes!!');

function montar(): { estados: EstadosDeConexao; relogio: Relogio } {
  const relogio = new Relogio();
  return { estados: new EstadosDeConexao({ segredo: SEGREDO, clock: relogio }), relogio };
}

function recusa(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof EstadoDeConexaoRecusado ? e.motivo : 'outro erro';
  }
}

describe('state do OAuth do Drive', () => {
  it('um state válido é aceito UMA vez e devolve o verificador PKCE que bate com o desafio', () => {
    const { estados } = montar();
    const { estado, desafio } = estados.emitir('ws-a');
    const { verificador } = estados.consumir(estado, 'ws-a');
    expect(createHash('sha256').update(verificador).digest('base64url')).toBe(desafio);
  });

  it('state reutilizado é recusado', () => {
    const { estados } = montar();
    const { estado } = estados.emitir('ws-a');
    estados.consumir(estado, 'ws-a');
    expect(recusa(() => estados.consumir(estado, 'ws-a'))).toBe('usado');
  });

  it('state expirado é recusado — e gasto', () => {
    const { estados, relogio } = montar();
    const { estado } = estados.emitir('ws-a');
    relogio.avancar(VALIDADE_DO_ESTADO_MS + 1);
    expect(recusa(() => estados.consumir(estado, 'ws-a'))).toBe('expirado');
    expect(recusa(() => estados.consumir(estado, 'ws-a'))).toBe('usado');
  });

  it('state de outro workspace é recusado, e NÃO é gasto (não dá para sabotar a conexão alheia)', () => {
    const { estados } = montar();
    const { estado } = estados.emitir('ws-a');
    expect(recusa(() => estados.consumir(estado, 'ws-b'))).toBe('de_outra_conta');
    expect(() => estados.consumir(estado, 'ws-a')).not.toThrow();
  });

  it('state adulterado ou fabricado é recusado: a assinatura não confere', () => {
    const { estados } = montar();
    const { estado } = estados.emitir('ws-a');
    const [corpo] = estado.split('.');
    expect(recusa(() => estados.consumir(`${corpo}.assinatura-falsa`, 'ws-a'))).toBe(
      'invalido',
    );
    expect(recusa(() => estados.consumir('lixo', 'ws-a'))).toBe('invalido');
    expect(recusa(() => estados.consumir('', 'ws-a'))).toBe('invalido');

    // Fabricado com OUTRO segredo, no formato certo.
    const outro = new EstadosDeConexao({
      segredo: Buffer.from('outro-segredo-sintetico-com-32-bytes!!!!'),
      clock: new Relogio(),
    });
    const falso = outro.emitir('ws-a').estado;
    expect(recusa(() => estados.consumir(falso, 'ws-a'))).toBe('invalido');
  });

  it('o state carrega nonce, workspace e validade — e nenhum segredo nem verificador', () => {
    const { estados } = montar();
    const { estado } = estados.emitir('ws-a');
    const corpo = Buffer.from(estado.split('.')[0] as string, 'base64url').toString(
      'utf8',
    );
    expect(Object.keys(JSON.parse(corpo) as object).sort()).toEqual(['e', 'n', 'w']);
    expect(corpo).not.toContain(SEGREDO.toString());
  });

  it('abandono não acumula: poda os vencidos e limita as pendentes por workspace', () => {
    const { estados, relogio } = montar();
    for (let i = 0; i < 12; i += 1) estados.emitir('ws-a');
    expect(estados.quantidadePendente).toBeLessThanOrEqual(5);
    relogio.avancar(VALIDADE_DO_ESTADO_MS + 1);
    estados.emitir('ws-b');
    expect(estados.quantidadePendente).toBe(1);
  });

  it('o mais antigo é o que sai quando passa do limite', () => {
    const { estados, relogio } = montar();
    const primeiro = estados.emitir('ws-a').estado;
    for (let i = 0; i < 5; i += 1) {
      relogio.avancar(1);
      estados.emitir('ws-a');
    }
    expect(recusa(() => estados.consumir(primeiro, 'ws-a'))).toBe('usado');
  });

  it('segredo curto demais é recusado na construção', () => {
    expect(
      () => new EstadosDeConexao({ segredo: Buffer.from('curto'), clock: new Relogio() }),
    ).toThrow();
  });
});
