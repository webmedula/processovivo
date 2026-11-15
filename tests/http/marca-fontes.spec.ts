import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirServidor } from '../../src/main/http/servidor.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { montarAplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { ESTILOS } from '../../src/main/http/ui/estilos.js';
import { FAVICON_DATA_URI, LOGO_FUNDO_ESCURO } from '../../src/main/http/ui/marca.js';
import { readFileSync } from 'node:fs';

const paginaAdmin = readFileSync('src/main/http/ui/paginaAdmin.ts', 'utf8');

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

describe('fontes servidas pelo próprio servidor', () => {
  let servidor: FastifyInstance;

  beforeEach(() => {
    servidor = montar();
  });
  afterEach(async () => {
    await servidor.close();
  });

  it.each([
    'plus-jakarta-sans.woff2',
    'jetbrains-mono-500.woff2',
    'jetbrains-mono-600.woff2',
  ])('serve %s sem pedir autenticação, como woff2 de verdade', async (arquivo) => {
    const r = await servidor.inject({ method: 'GET', url: `/ui/fontes/${arquivo}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('font/woff2');
    // Assinatura do formato: todo WOFF2 começa com "wOF2".
    expect(r.rawPayload.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(r.headers['cache-control']).toContain('max-age=');
  });

  it('nome fora da lista não vira caminho de arquivo', async () => {
    for (const url of [
      '/ui/fontes/package.json',
      '/ui/fontes/..%2F..%2Fpackage.json',
      '/ui/fontes/%2E%2E%2Fetc%2Fpasswd',
    ]) {
      const r = await servidor.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(404);
    }
  });

  it('o CSS aponta as fontes para o próprio servidor, nunca para fora', () => {
    const urls = [...ESTILOS.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThanOrEqual(3);
    for (const u of urls) expect(u.startsWith('/ui/fontes/')).toBe(true);
    expect(ESTILOS).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@import/);
  });
});

describe('marca no console', () => {
  let servidor: FastifyInstance;

  beforeEach(() => {
    servidor = montar();
  });
  afterEach(async () => {
    await servidor.close();
  });

  it('a página traz o logo inline e o ícone da aba, sem nada externo', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/' });
    expect(r.body).toContain('aria-label="Processo Vivo"');
    expect(r.body).toContain('rel="icon"');
    expect(r.body).toContain('href="data:image/svg+xml,');
    expect(r.body).not.toMatch(/<link[^>]+href="https?:/i);
  });

  it('o logo não depende de fonte instalada: as letras são desenho', () => {
    // O arquivo original do CorelDRAW trazia <text> em Verdana — em Linux e em
    // parte dos celulares, "PROCESSO VIVO" aparecia em outra fonte.
    expect(LOGO_FUNDO_ESCURO).not.toMatch(/<text|font-family|<font/);
    expect(LOGO_FUNDO_ESCURO.startsWith('<svg')).toBe(true);
  });

  it('serve o .ico e o ícone do iPhone sem pedir autenticação, nos formatos de verdade', async () => {
    const ico = await servidor.inject({ method: 'GET', url: '/favicon.ico' });
    expect(ico.statusCode).toBe(200);
    expect(ico.headers['content-type']).toBe('image/x-icon');
    // Cabeçalho ICO: reservado 0, tipo 1 (ícone) e as três imagens (16, 32 e 48 px).
    expect([...ico.rawPayload.subarray(0, 6)]).toEqual([0, 0, 1, 0, 3, 0]);
    const lados = [0, 1, 2]
      .map((i) => ico.rawPayload[6 + i * 16])
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(lados).toEqual([16, 32, 48]);

    const png = await servidor.inject({ method: 'GET', url: '/apple-touch-icon.png' });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.rawPayload.subarray(1, 4).toString('latin1')).toBe('PNG');
    // Largura e altura no IHDR: 180 × 180, e cor sem canal alfa (tipo 2), porque o iPhone pinta
    // de preto o canto transparente.
    expect(png.rawPayload.readUInt32BE(16)).toBe(180);
    expect(png.rawPayload.readUInt32BE(20)).toBe(180);
    expect(png.rawPayload[25]).toBe(2);
  });

  it('o console e o /admin apontam os ícones para o próprio servidor', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/' });
    expect(r.body).toContain('<link rel="icon" href="/favicon.ico" sizes="48x48">');
    expect(r.body).toContain(
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    );
    expect(paginaAdmin).toContain('href="/favicon.ico"');
    expect(paginaAdmin).toContain('href="/apple-touch-icon.png"');
  });

  it('o ícone da aba não pode quebrar o atributo href', () => {
    expect(FAVICON_DATA_URI).not.toContain('"');
    expect(FAVICON_DATA_URI).not.toMatch(/\s{2}/);
  });
});
