import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import { GatewayFalso } from '../../src/infrastructure/adapters/pagamento/GatewayFalso.js';
import { CHAVE_DE_API, json } from '../helpers/pagamentos.js';

/*
 * `GET /v1/planos` (v0.45.0): a vitrine pública do site de vendas. Servidor real, SQLite em memória,
 * nenhuma rede. Tudo sintético.
 */
const SITE = 'https://www.site-exemplo.test';

let servidor: FastifyInstance;
afterEach(async () => {
  await servidor?.close();
});

function montar(opcoes: { pagamento?: boolean; site?: string; limite?: string } = {}): {
  servidor: FastifyInstance;
  app: ReturnType<typeof aplicacaoDeTeste>;
} {
  const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    ...(opcoes.pagamento ? { pagamentos: { gateway: new GatewayFalso() } } : {}),
  });
  const config = carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: CHAVE_DE_API,
    CACHE_ENABLED: 'false',
    COOKIE_SECURE: 'false',
    RATE_LIMIT_MAX: opcoes.limite ?? '100000',
    ...(opcoes.site ? { PROCESSOVIVO_SITE_URL: opcoes.site } : {}),
  } as NodeJS.ProcessEnv);
  servidor = construirServidor(app, config);
  return { servidor, app };
}

describe('GET /v1/planos — a vitrine pública', () => {
  it('é pública (sem cookie e sem chave) e devolve só os planos À VENDA', async () => {
    const { servidor: s } = montar();
    const r = await s.inject({ method: 'GET', url: '/v1/planos' });
    expect(r.statusCode).toBe(200);
    const slugs = (json(r)['planos'] as Array<{ slug: string }>).map((p) => p.slug);
    // `ia` está fora de venda (a análise por IA não é vendável); os outros dois nascem à venda.
    expect(slugs).toEqual(['acompanhamento', 'pecas']);
  });

  it('plano pausado some da vitrine; plano sem preço aparece SEM preço e como não assinável', async () => {
    const { servidor: s, app } = montar({ pagamento: true });
    await app.planos.atualizar('pecas', { precoMensalCentavos: 4990 });
    await app.planos.atualizar('acompanhamento', { disponivelParaContratacao: false });
    let r = await s.inject({ method: 'GET', url: '/v1/planos' });
    let planos = json(r)['planos'] as Array<Record<string, unknown>>;
    expect(planos.map((p) => p['slug'])).toEqual(['pecas']);
    expect(planos[0]).toMatchObject({
      slug: 'pecas',
      nome: 'Peças',
      preco: { valorCentavos: 4990, ciclo: 'mensal' },
      assinavel: true,
    });

    await app.planos.atualizar('acompanhamento', { disponivelParaContratacao: true });
    await app.planos.atualizar('pecas', { precoMensalCentavos: null });
    r = await s.inject({ method: 'GET', url: '/v1/planos' });
    planos = json(r)['planos'] as Array<Record<string, unknown>>;
    for (const p of planos) {
      expect(p['preco']).toBeNull();
      expect(p['assinavel']).toBe(false);
    }
  });

  it('ciclo ainda não vendável mostra o preço mas não é assinável (a MESMA regra do checkout)', async () => {
    const { servidor: s, app } = montar({ pagamento: true });
    await app.planos.atualizar('pecas', { precoMensalCentavos: 1000, ciclo: 'anual' });
    const r = await s.inject({ method: 'GET', url: '/v1/planos' });
    const pecas = (json(r)['planos'] as Array<Record<string, unknown>>).find(
      (p) => p['slug'] === 'pecas',
    )!;
    expect(pecas['preco']).toEqual({ valorCentavos: 12000, ciclo: 'anual' });
    expect(pecas['assinavel']).toBe(false);
  });

  it('não expõe NENHUM campo interno: só slug, nome, resumo, recursos, preço e assinável', async () => {
    const { servidor: s, app } = montar({ pagamento: true });
    await app.planos.atualizar('pecas', { precoMensalCentavos: 4990 });
    const r = await s.inject({ method: 'GET', url: '/v1/planos' });
    const corpo = json(r);
    expect(Object.keys(corpo).sort()).toEqual(['pagamentoDisponivel', 'planos']);
    for (const p of corpo['planos'] as Array<Record<string, unknown>>) {
      expect(Object.keys(p).sort()).toEqual([
        'assinavel',
        'nome',
        'preco',
        'recursos',
        'resumo',
        'slug',
      ]);
      // Nomes legíveis dos recursos, nunca os códigos internos.
      expect(p['recursos']).not.toContain('analiseIa');
    }
    const texto = r.body;
    expect(texto).not.toMatch(
      /codigo|ordem|disponivelParaContratacao|precoMensalCentavos|workspace|id"/,
    );
    expect(
      (corpo['planos'] as Array<{ recursos: string[] }>).find((p) =>
        p.recursos.includes('Peças do processo'),
      ),
    ).toBeDefined();
  });

  it('`pagamentoDisponivel` segue PROCESSOVIVO_PAGAMENTO_HABILITADO', async () => {
    const ligado = montar({ pagamento: true });
    expect(
      json(await ligado.servidor.inject({ method: 'GET', url: '/v1/planos' }))[
        'pagamentoDisponivel'
      ],
    ).toBe(true);
    await ligado.servidor.close();
    const desligado = montar({ pagamento: false });
    expect(
      json(await desligado.servidor.inject({ method: 'GET', url: '/v1/planos' }))[
        'pagamentoDisponivel'
      ],
    ).toBe(false);
  });

  it('cache curto e Vary: Origin sempre; nenhum cookie é gravado', async () => {
    const { servidor: s } = montar({ site: SITE });
    for (const origin of [undefined, SITE, 'https://outro.test']) {
      const r = await s.inject({
        method: 'GET',
        url: '/v1/planos',
        headers: origin ? { origin } : {},
      });
      expect(r.headers['cache-control']).toBe('public, max-age=60');
      expect(r.headers['vary']).toMatch(/Origin/i);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });
});

describe('GET /v1/planos — CORS', () => {
  it('libera SÓ a origem configurada: só GET, sem credenciais, sem curinga', async () => {
    const { servidor: s } = montar({ site: SITE });
    const r = await s.inject({
      method: 'GET',
      url: '/v1/planos',
      headers: { origin: SITE },
    });
    expect(r.headers['access-control-allow-origin']).toBe(SITE);
    expect(r.headers['access-control-allow-methods']).toBe('GET');
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    expect(r.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('outra origem, origem parecida e sem Origin não recebem cabeçalho CORS', async () => {
    const { servidor: s } = montar({ site: SITE });
    for (const origin of [
      'https://outro.test',
      `${SITE}.mal.test`,
      'http://www.site-exemplo.test',
      'null',
    ]) {
      const r = await s.inject({ method: 'GET', url: '/v1/planos', headers: { origin } });
      expect(r.statusCode).toBe(200);
      expect(r.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
    const sem = await s.inject({ method: 'GET', url: '/v1/planos' });
    expect(sem.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sem PROCESSOVIVO_SITE_URL (padrão) não há CORS nenhum, nem para o site', async () => {
    const { servidor: s } = montar();
    const r = await s.inject({
      method: 'GET',
      url: '/v1/planos',
      headers: { origin: SITE },
    });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['access-control-allow-methods']).toBeUndefined();
  });

  it('o CORS é só desta rota: o resto da API não ganha cabeçalho CORS', async () => {
    const { servidor: s } = montar({ site: SITE });
    const r = await s.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: SITE },
    });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const protegida = await s.inject({
      method: 'GET',
      url: '/v1/assinatura',
      headers: { origin: SITE },
    });
    expect(protegida.statusCode).toBe(401);
    expect(protegida.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('só GET: POST na rota não existe', async () => {
    const { servidor: s } = montar({ site: SITE });
    const r = await s.inject({ method: 'POST', url: '/v1/planos', payload: {} });
    expect([401, 404]).toContain(r.statusCode);
  });
});

describe('GET /v1/planos — limite de taxa', () => {
  it('tem balde PRÓPRIO por IP: estoura em 120/min sem gastar a cota global', async () => {
    const { servidor: s } = montar({ limite: '5' });
    // O limite global (5) não vale aqui: a rota tem o dela.
    for (let i = 0; i < 20; i++) {
      expect((await s.inject({ method: 'GET', url: '/v1/planos' })).statusCode).toBe(200);
    }
    let ultimo = 200;
    for (let i = 0; i < 110; i++) {
      ultimo = (await s.inject({ method: 'GET', url: '/v1/planos' })).statusCode;
    }
    expect(ultimo).toBe(429);
    // Outro IP continua atendido.
    const outro = await s.inject({
      method: 'GET',
      url: '/v1/planos',
      remoteAddress: '10.9.9.9',
    });
    expect(outro.statusCode).toBe(200);
  });
});
