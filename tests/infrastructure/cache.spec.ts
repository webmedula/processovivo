import { describe, expect, it } from 'vitest';
import { InMemoryCache } from '../../src/infrastructure/cache/InMemoryCache.js';
import { CachedProcessoProvider } from '../../src/infrastructure/cache/CachedProcessoProvider.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import { NUMERO_TJSP_A, ProviderFalso, umProcesso } from '../helpers/fabricas.js';

/** Relógio controlado: TTL testado sem esperar tempo real. */
class ClockFalso implements Clock {
  private ms = new Date('2026-01-01T00:00:00.000Z').getTime();

  agora(): Date {
    return new Date(this.ms);
  }

  monotonico(): number {
    return this.ms;
  }

  avancarSegundos(segundos: number): void {
    this.ms += segundos * 1000;
  }
}

describe('InMemoryCache', () => {
  it('guarda e devolve o valor', async () => {
    const cache = new InMemoryCache();
    await cache.set('a', { x: 1 });
    await expect(cache.get('a')).resolves.toEqual({ x: 1 });
  });

  it('devolve undefined para chave inexistente', async () => {
    await expect(new InMemoryCache().get('nada')).resolves.toBeUndefined();
  });

  it('expira a entrada após o TTL', async () => {
    const clock = new ClockFalso();
    const cache = new InMemoryCache({ ttlPadraoSegundos: 60, clock });

    await cache.set('a', 1);
    clock.avancarSegundos(59);
    await expect(cache.get('a')).resolves.toBe(1);

    clock.avancarSegundos(2);
    await expect(cache.get('a')).resolves.toBeUndefined();
  });

  it('respeita TTL específico da chamada', async () => {
    const clock = new ClockFalso();
    const cache = new InMemoryCache({ ttlPadraoSegundos: 3600, clock });

    await cache.set('curto', 1, 10);
    clock.avancarSegundos(11);
    await expect(cache.get('curto')).resolves.toBeUndefined();
  });

  it('despeja a entrada menos usada recentemente ao atingir o limite', async () => {
    const cache = new InMemoryCache({ maxEntradas: 2 });

    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.get('a'); // "a" passa a ser a mais recente
    await cache.set('c', 3); // deve despejar "b"

    await expect(cache.get('a')).resolves.toBe(1);
    await expect(cache.get('b')).resolves.toBeUndefined();
    await expect(cache.get('c')).resolves.toBe(3);
  });

  it('contabiliza acertos e erros', async () => {
    const cache = new InMemoryCache();
    await cache.set('a', 1);
    await cache.get('a');
    await cache.get('b');

    expect(cache.estatisticas).toMatchObject({ acertos: 1, erros: 1, tamanho: 1 });
  });
});

describe('CachedProcessoProvider', () => {
  it('consulta a fonte uma vez e serve as chamadas seguintes do cache', async () => {
    const origem = new ProviderFalso({ nome: 'origem' });
    const provider = new CachedProcessoProvider({
      provider: origem,
      cache: new InMemoryCache(),
    });

    await provider.buscarPorNumero(NUMERO_TJSP_A);
    await provider.buscarPorNumero(NUMERO_TJSP_A);

    expect(origem.chamadas.porNumero).toBe(1);
  });

  it('trata número com e sem máscara como a mesma chave', async () => {
    const origem = new ProviderFalso({ nome: 'origem' });
    const provider = new CachedProcessoProvider({
      provider: origem,
      cache: new InMemoryCache(),
    });

    await provider.buscarPorNumero(NUMERO_TJSP_A);
    await provider.buscarPorNumero('12345674720238260100');

    expect(origem.chamadas.porNumero).toBe(1);
  });

  it('marca a resposta servida do cache na procedência', async () => {
    const provider = new CachedProcessoProvider({
      provider: new ProviderFalso({ nome: 'origem' }),
      cache: new InMemoryCache(),
    });

    const fresco = await provider.buscarPorNumero(NUMERO_TJSP_A);
    const doCache = await provider.buscarPorNumero(NUMERO_TJSP_A);

    expect(fresco.procedencia.deCache).toBe(false);
    expect(doCache.procedencia.deCache).toBe(true);
    expect(doCache.procedencia.provider).toBe(fresco.procedencia.provider);
  });

  it('reidrata datas como Date, e não como string', async () => {
    const provider = new CachedProcessoProvider({
      provider: new ProviderFalso({ nome: 'origem' }),
      cache: new InMemoryCache(),
    });

    await provider.buscarPorNumero(NUMERO_TJSP_A);
    const doCache = await provider.buscarPorNumero(NUMERO_TJSP_A);

    expect(doCache.dataDistribuicao).toBeInstanceOf(Date);
    expect(doCache.ultimaMovimentacao?.data).toBeInstanceOf(Date);
    expect(doCache.numero.formatado).toBe(NUMERO_TJSP_A);
  });

  it('cacheia a busca por OAB com TTL próprio, mais curto', async () => {
    const clock = new ClockFalso();
    const origem = new ProviderFalso({
      nome: 'origem',
      porOab: async () => [umProcesso()],
    });
    const provider = new CachedProcessoProvider({
      provider: origem,
      cache: new InMemoryCache({ clock }),
      ttlNumeroSegundos: 900,
      ttlOabSegundos: 60,
    });

    await provider.buscarPorOab('234567', 'SP');
    await provider.buscarPorOab('234567', 'SP');
    expect(origem.chamadas.porOab).toBe(1);

    clock.avancarSegundos(61);
    await provider.buscarPorOab('234567', 'SP');
    expect(origem.chamadas.porOab).toBe(2);
  });

  it('nunca cacheia healthCheck', async () => {
    const origem = new ProviderFalso({ nome: 'origem' });
    const provider = new CachedProcessoProvider({
      provider: origem,
      cache: new InMemoryCache(),
    });

    await provider.healthCheck();
    await provider.healthCheck();

    expect(origem.chamadas.health).toBe(2);
  });

  it('invalidar força nova consulta à fonte', async () => {
    const origem = new ProviderFalso({ nome: 'origem' });
    const provider = new CachedProcessoProvider({
      provider: origem,
      cache: new InMemoryCache(),
    });

    await provider.buscarPorNumero(NUMERO_TJSP_A);
    await provider.invalidar(NUMERO_TJSP_A);
    await provider.buscarPorNumero(NUMERO_TJSP_A);

    expect(origem.chamadas.porNumero).toBe(2);
  });

  it('herda nome e capacidades do provider decorado', () => {
    const origem = new ProviderFalso({
      nome: 'origem',
      capacidades: { buscarPorOab: false },
    });
    const provider = new CachedProcessoProvider({
      provider: origem,
      cache: new InMemoryCache(),
    });

    expect(provider.nome).toBe('origem');
    expect(provider.capacidades.buscarPorOab).toBe(false);
  });
});
