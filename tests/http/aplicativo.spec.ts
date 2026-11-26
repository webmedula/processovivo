import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Linter } from 'eslint';
import globals from 'globals';
import { construirServidor } from '../../src/main/http/servidor.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { montarAplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import {
  PAGINA_SEM_INTERNET,
  ROTAS_DO_APLICATIVO,
  serviceWorker,
} from '../../src/main/http/ui/aplicativo.js';
import { VERSAO } from '../../src/infrastructure/config/versao.js';

const CHAVE = 'chave-de-teste-1234567890';

function montar(): FastifyInstance {
  const config = carregarConfig({
    PROCESSOVIVO_DB_PATH: ':memory:',
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    MOCK_CRAWLER_LATENCY_MS: '0',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: CHAVE,
  } as NodeJS.ProcessEnv);
  return construirServidor(montarAplicacao(config), config);
}

/** Lê largura, altura e se há transparência (chunk tRNS ou canal alfa) de um PNG. */
function lerPng(bytes: Buffer): {
  largura: number;
  altura: number;
  transparente: boolean;
} {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  const tipoDeCor = bytes[25];
  return {
    largura: bytes.readUInt32BE(16),
    altura: bytes.readUInt32BE(20),
    transparente:
      tipoDeCor === 4 || tipoDeCor === 6 || bytes.includes(Buffer.from('tRNS')),
  };
}

describe('aplicativo instalável (PWA)', () => {
  let servidor: FastifyInstance;

  beforeEach(() => {
    servidor = montar();
  });
  afterEach(async () => {
    await servidor.close();
  });

  it('o console aponta o manifesto e registra o worker, sem nada de fora', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/' });
    expect(r.body).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(r.body).toContain("navigator.serviceWorker.register('/sw.js',{scope:'/'})");
    expect(r.body).not.toMatch(/<script[^>]+src=/i);
  });

  it('serve o manifesto sem pedir autenticação, com tela cheia e os ícones exigidos', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/manifest+json');
    const m = JSON.parse(r.body) as {
      name: string;
      start_url: string;
      scope: string;
      display: string;
      icons: { src: string; sizes: string; purpose: string }[];
    };
    expect(m.name).toBe('Processo Vivo');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.display).toBe('standalone');
    const tamanhos = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(tamanhos).toEqual(['192x192:any', '512x512:any', '512x512:maskable']);
    // Todo ícone do manifesto existe, sem chave, e tem o tamanho que o manifesto declara.
    for (const icone of m.icons) {
      const png = await servidor.inject({ method: 'GET', url: icone.src });
      expect(png.statusCode).toBe(200);
      expect(png.headers['content-type']).toBe('image/png');
      const { largura, altura, transparente } = lerPng(png.rawPayload);
      expect(`${largura}x${altura}`).toBe(icone.sizes);
      // O recortável é pintado de ponta a ponta: o Android recorta, e canto transparente vira preto.
      if (icone.purpose === 'maskable') expect(transparente).toBe(false);
    }
  });

  it('serve o worker sem cache e sem pedir autenticação', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/sw.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.body).toContain(VERSAO);
  });

  it('nenhum arquivo do aplicativo responde com dado de conta, mesmo com chave', async () => {
    for (const url of ROTAS_DO_APLICATIVO) {
      const sem = await servidor.inject({ method: 'GET', url });
      const com = await servidor.inject({
        method: 'GET',
        url,
        headers: { 'x-api-key': CHAVE },
      });
      expect(sem.statusCode).toBe(200);
      expect(com.rawPayload.equals(sem.rawPayload)).toBe(true);
      expect(sem.headers['set-cookie']).toBeUndefined();
    }
  });
});

describe('o service worker', () => {
  const codigo = serviceWorker('0.0.0-teste');

  it('é JavaScript válido para um worker, sem nome indefinido', () => {
    const erros = new Linter().verify(codigo, {
      languageOptions: {
        ecmaVersion: 2020,
        sourceType: 'script',
        globals: { ...globals.serviceworker },
      },
      rules: { 'no-undef': 'error', 'no-unused-expressions': 'error' },
    });
    expect(erros).toEqual([]);
  });

  it('não guarda nada no aparelho: sem Cache Storage, IndexedDB nem armazenamento', () => {
    expect(codigo).not.toMatch(
      /caches\.|indexedDB|localStorage|sessionStorage|cache\.put/,
    );
  });

  it('só intercepta a navegação para o console, nunca a API, o /admin ou os retornos', () => {
    expect(codigo).toContain("r.mode !== 'navigate'");
    expect(codigo).toContain("u.pathname !== '/'");
  });

  it('a página sem internet é autocontida e não traz dado', () => {
    expect(PAGINA_SEM_INTERNET).toContain('Sem conexão com a internet');
    expect(PAGINA_SEM_INTERNET).not.toMatch(/https?:\/\/|<link|src=/i);
  });
});
