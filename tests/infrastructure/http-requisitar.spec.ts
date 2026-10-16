import { afterEach, describe, expect, it, vi } from 'vitest';
import { DestinoIndisponivelError } from '../../src/domain/errors/index.js';
import { TransporteComHttpClient } from '../../src/infrastructure/adapters/drive/TransporteDoDrive.js';
import { HttpClient } from '../../src/infrastructure/http/HttpClient.js';

/** `HttpClient.requisitar` e o transporte do Drive, contra um `fetch` dublado — sem rede. */

const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.restoreAllMocks();
});

describe('HttpClient.requisitar', () => {
  it('devolve status, cabeçalhos (em minúsculas) e o corpo em BYTES', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0, 255, 10]), {
          status: 308,
          headers: { Range: 'bytes=0-9', Location: 'https://exemplo.test/s' },
        }),
    ) as typeof fetch;
    const r = await new HttpClient().requisitar({
      metodo: 'PUT',
      url: 'https://exemplo.test/x',
    });
    expect(r.status).toBe(308);
    expect(r.ok).toBe(false);
    expect(r.headers['range']).toBe('bytes=0-9');
    expect(r.headers['location']).toBe('https://exemplo.test/s');
    expect([...r.bytes]).toEqual([0, 255, 10]);
  });

  it('manda método, cabeçalhos e corpo como pedidos — e NÃO segue redirecionamento', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = f as unknown as typeof fetch;
    await new HttpClient({ headersPadrao: { 'x-padrao': '1' } }).requisitar({
      metodo: 'PATCH',
      url: 'https://exemplo.test/x',
      headers: { authorization: 'Bearer t' },
      corpo: new Uint8Array([1, 2, 3]),
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://exemplo.test/x');
    expect(init.method).toBe('PATCH');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({ authorization: 'Bearer t', 'x-padrao': '1' });
    expect(init.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('com `tentativas: 1` não repete 429 nem 5xx (a política é do chamador)', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return new Response('{}', { status: 429, headers: { 'Retry-After': '9' } });
    }) as typeof fetch;
    const r = await new HttpClient({ backoffInicialMs: 1 }).requisitar(
      { metodo: 'POST', url: 'https://exemplo.test/x' },
      { tentativas: 1 },
    );
    expect(n).toBe(1);
    expect(r.headers['retry-after']).toBe('9');
  });
});

describe('TransporteComHttpClient', () => {
  it('queda de rede vira DestinoIndisponivelError SEM a mensagem original (que carrega a URL)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET https://upload.exemplo.test/sessao-secreta-123');
    }) as typeof fetch;
    const t = new TransporteComHttpClient(new HttpClient({ backoffInicialMs: 1 }));
    const erro = await t
      .requisitar({
        metodo: 'GET',
        url: 'https://upload.exemplo.test/sessao-secreta-123',
      })
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(DestinoIndisponivelError);
    expect(JSON.stringify(erro, Object.getOwnPropertyNames(erro))).not.toContain(
      'sessao-secreta',
    );
  });

  it('não repete sozinho: uma chamada, uma tentativa', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return new Response('{}', { status: 503 });
    }) as typeof fetch;
    const t = new TransporteComHttpClient(
      new HttpClient({ tentativas: 5, backoffInicialMs: 1 }),
    );
    const r = await t.requisitar({ metodo: 'GET', url: 'https://exemplo.test/x' });
    expect(r.status).toBe(503);
    expect(n).toBe(1);
  });
});
