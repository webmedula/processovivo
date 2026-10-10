import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpClient,
  HttpTimeoutError,
} from '../../src/infrastructure/http/HttpClient.js';

/**
 * Testa a política de timeout e retry contra um `fetch` dublado — sem rede.
 */

const fetchOriginal = globalThis.fetch;

function responder(status: number): Response {
  return new Response('{}', { status });
}

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.restoreAllMocks();
});

describe('HttpClient — opções por requisição', () => {
  let chamadas: number;

  beforeEach(() => {
    chamadas = 0;
  });

  it('respeita o número de tentativas do cliente por padrão', async () => {
    globalThis.fetch = vi.fn(async () => {
      chamadas++;
      return responder(503);
    }) as typeof fetch;

    const cliente = new HttpClient({ tentativas: 3, backoffInicialMs: 1 });
    await cliente.postJson('https://exemplo.test/x', {});

    expect(chamadas).toBe(3);
  });

  it('uma tentativa por requisição sobrepõe o padrão do cliente', async () => {
    // É disso que o health check depende: falhar rápido em vez de insistir.
    globalThis.fetch = vi.fn(async () => {
      chamadas++;
      return responder(503);
    }) as typeof fetch;

    const cliente = new HttpClient({ tentativas: 3, backoffInicialMs: 1 });
    await cliente.postJson('https://exemplo.test/x', {}, {}, { tentativas: 1 });

    expect(chamadas).toBe(1);
  });

  it('timeout por requisição sobrepõe o do cliente e é reportado no erro', async () => {
    globalThis.fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // Nunca resolve: só o AbortController encerra.
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    ) as typeof fetch;

    const cliente = new HttpClient({ timeoutMs: 60_000, tentativas: 1 });
    const erro = await cliente
      .postJson('https://exemplo.test/x', {}, {}, { timeoutMs: 30 })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(HttpTimeoutError);
    expect((erro as HttpTimeoutError).timeoutMs).toBe(30);
  });

  it('não retenta 4xx — retentar erro do cliente só queima cota', async () => {
    globalThis.fetch = vi.fn(async () => {
      chamadas++;
      return responder(400);
    }) as typeof fetch;

    const cliente = new HttpClient({ tentativas: 3, backoffInicialMs: 1 });
    const r = await cliente.postJson('https://exemplo.test/x', {});

    expect(chamadas).toBe(1);
    expect(r.status).toBe(400);
  });

  it('retenta 429, que é transitório', async () => {
    globalThis.fetch = vi.fn(async () => {
      chamadas++;
      return responder(chamadas < 2 ? 429 : 200);
    }) as typeof fetch;

    const cliente = new HttpClient({ tentativas: 3, backoffInicialMs: 1 });
    const r = await cliente.postJson('https://exemplo.test/x', {});

    expect(chamadas).toBe(2);
    expect(r.ok).toBe(true);
  });
});
