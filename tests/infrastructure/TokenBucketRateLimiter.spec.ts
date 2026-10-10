import { describe, expect, it } from 'vitest';
import { TokenBucketRateLimiter } from '../../src/infrastructure/ratelimit/TokenBucketRateLimiter.js';
import type { Clock } from '../../src/domain/ports/Clock.js';

class ClockFalso implements Clock {
  private ms = 0;

  agora(): Date {
    return new Date(this.ms);
  }

  monotonico(): number {
    return this.ms;
  }

  avancarMs(ms: number): void {
    this.ms += ms;
  }
}

describe('TokenBucketRateLimiter', () => {
  it('começa cheio e permite até a capacidade sem esperar', () => {
    const limitador = new TokenBucketRateLimiter({
      capacidade: 3,
      clock: new ClockFalso(),
    });

    expect(limitador.tentarAdquirir()).toBe(true);
    expect(limitador.tentarAdquirir()).toBe(true);
    expect(limitador.tentarAdquirir()).toBe(true);
    expect(limitador.tentarAdquirir()).toBe(false);
  });

  it('repõe tokens continuamente, e não em bloco no fim da janela', () => {
    const clock = new ClockFalso();
    const limitador = new TokenBucketRateLimiter({
      capacidade: 60,
      janelaMs: 60_000,
      clock,
    });

    for (let i = 0; i < 60; i++) limitador.tentarAdquirir();
    expect(limitador.tentarAdquirir()).toBe(false);

    // Meia janela → metade dos tokens de volta, não zero e não todos.
    clock.avancarMs(30_000);
    expect(limitador.disponiveis).toBe(30);
  });

  it('nunca acumula acima da capacidade, por mais que o tempo passe', () => {
    const clock = new ClockFalso();
    const limitador = new TokenBucketRateLimiter({
      capacidade: 10,
      janelaMs: 1000,
      clock,
    });

    clock.avancarMs(3_600_000);
    expect(limitador.disponiveis).toBe(10);
  });

  it('adquirir espera até haver token disponível', async () => {
    // Janela curtíssima com relógio real: o await precisa efetivamente resolver.
    const limitador = new TokenBucketRateLimiter({ capacidade: 2, janelaMs: 60 });

    await limitador.adquirir();
    await limitador.adquirir();

    const inicio = Date.now();
    await limitador.adquirir();
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(5);
  });

  it('recusa capacidade não positiva na construção', () => {
    expect(() => new TokenBucketRateLimiter({ capacidade: 0 })).toThrow(/maior que zero/);
  });
});
