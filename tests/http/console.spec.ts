import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirServidor } from '../../src/main/http/servidor.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { MockCrawlerAdapter } from '../../src/infrastructure/adapters/crawler/MockCrawlerAdapter.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';

const CHAVE_A = 'chave-workspace-a-1234567890';
const CHAVE_B = 'chave-workspace-b-1234567890';

function montar(): FastifyInstance {
  const config = carregarConfig({
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
    PROCESSOVIVO_DB_PATH: ':memory:',
  } as NodeJS.ProcessEnv);
  return construirServidor(
    aplicacaoDeTeste([new MockCrawlerAdapter({ latenciaMs: 0 })]),
    config,
  );
}

describe('rotas de acompanhamento', () => {
  let s: FastifyInstance;
  const a = { 'x-api-key': CHAVE_A };
  const b = { 'x-api-key': CHAVE_B };

  beforeEach(() => {
    s = montar();
  });
  afterEach(async () => {
    await s.close();
  });

  async function acompanhar(headers: Record<string, string>, numero = NUMERO_TJSP_A) {
    return s.inject({
      method: 'POST',
      url: '/v1/acompanhamentos',
      headers,
      payload: { numero },
    });
  }

  it('acompanha e já devolve o processo preenchido', async () => {
    const r = await acompanhar(a);
    expect(r.statusCode).toBe(201);
    expect(r.json().processo.tribunal).toBe('TJSP');
    expect(r.json().sincronizadoEm).not.toBeNull();
  });

  it('lista o que foi acompanhado', async () => {
    await acompanhar(a);
    const r = await s.inject({ method: 'GET', url: '/v1/acompanhamentos', headers: a });

    expect(r.json().total).toBe(1);
    expect(r.json().acompanhamentos[0].numero).toBe(NUMERO_TJSP_A);
    expect(r.json().acompanhamentos[0].novidadesNaoVistas).toBe(0);
  });

  it('duas chaves são dois espaços isolados', async () => {
    // É o que sustenta "a chave de API é o usuário". Vazar aqui misturaria a
    // carteira de dois assinantes.
    await acompanhar(a);

    expect(
      (await s.inject({ method: 'GET', url: '/v1/acompanhamentos', headers: a })).json()
        .total,
    ).toBe(1);
    expect(
      (await s.inject({ method: 'GET', url: '/v1/acompanhamentos', headers: b })).json()
        .total,
    ).toBe(0);
  });

  it('não deixa pedir a carteira de outro workspace pela query', async () => {
    // O workspace vem SEMPRE da chave; parâmetro nenhum pode sobrepor.
    await acompanhar(a);
    const r = await s.inject({
      method: 'GET',
      url: '/v1/acompanhamentos?workspace=' + encodeURIComponent('qualquer'),
      headers: b,
    });
    expect(r.json().total).toBe(0);
  });

  it('deixa de acompanhar', async () => {
    await acompanhar(a);
    const r = await s.inject({
      method: 'DELETE',
      url: `/v1/acompanhamentos/${NUMERO_TJSP_A}`,
      headers: a,
    });
    expect(r.statusCode).toBe(200);
    expect(
      (await s.inject({ method: 'GET', url: '/v1/acompanhamentos', headers: a })).json()
        .total,
    ).toBe(0);
  });

  it('404 ao detalhar processo não acompanhado', async () => {
    const r = await s.inject({
      method: 'GET',
      url: `/v1/acompanhamentos/${NUMERO_TJSP_A}`,
      headers: a,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().erro).toBe('NAO_ACOMPANHADO');
  });

  it('400 sem número no corpo', async () => {
    const r = await s.inject({
      method: 'POST',
      url: '/v1/acompanhamentos',
      headers: a,
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it('as facetas alimentam os filtros da tela', async () => {
    await acompanhar(a);
    const r = await s.inject({ method: 'GET', url: '/v1/facetas', headers: a });
    expect(r.json().tribunais).toContain('TJSP');
  });

  it('o feed começa vazio e responde ao filtro de não lidas', async () => {
    await acompanhar(a);
    const r = await s.inject({
      method: 'GET',
      url: '/v1/novidades?naoVistas=true',
      headers: a,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().naoVistas).toBe(0);
  });

  it('a sincronização manual responde 202 sem segurar a conexão', async () => {
    // Uma varredura pode levar meia hora; esperar por ela na requisição faria
    // o proxy cortar antes do fim.
    await acompanhar(a);
    const r = await s.inject({ method: 'POST', url: '/v1/sincronizar', headers: a });
    expect(r.statusCode).toBe(202);
    expect(r.json().iniciada).toBe(true);
  });

  it('todas as rotas novas exigem autenticação', async () => {
    for (const url of [
      '/v1/acompanhamentos',
      '/v1/novidades',
      '/v1/facetas',
      '/v1/sincronizacao',
    ]) {
      const r = await s.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
    }
  });
});

describe('console do SaaS', () => {
  let s: FastifyInstance;

  beforeEach(() => {
    s = montar();
  });
  afterEach(async () => {
    await s.close();
  });

  it('a raiz abre sem chave e traz a navegação', async () => {
    const r = await s.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('nav-novidades');
    expect(r.body).toContain('nav-processos');
    expect(r.body).toContain('nav-buscar');
  });

  it('não embute chave nenhuma no HTML', async () => {
    const r = await s.inject({ method: 'GET', url: '/' });
    expect(r.body).not.toContain(CHAVE_A);
    expect(r.body).not.toContain(CHAVE_B);
  });

  it('não carrega nada de fora — funciona sem internet', async () => {
    const r = await s.inject({ method: 'GET', url: '/' });
    expect(r.body).not.toMatch(/<script[^>]+src=/i);
    expect(r.body).not.toMatch(/<link[^>]+href="https?:/i);
  });

  it('oferece acompanhar em lote o resultado da busca por OAB', async () => {
    // É o fluxo que fecha o produto: digitar a própria inscrição uma vez e sair
    // com a carteira inteira sob vigilância.
    const r = await s.inject({ method: 'GET', url: '/' });
    expect(r.body).toContain('bt-lote');
    expect(r.body).toContain('Acompanhar todos');
  });

  it('não afirma mais que busca por OAB exige crawler', async () => {
    // A tela dizia isso quando era verdade. Passou a ser mentira quando o DJEN
    // entrou, e mensagem desatualizada manda o usuário procurar defeito onde
    // não há.
    const r = await s.inject({ method: 'GET', url: '/' });
    expect(r.body).not.toContain('Consulta por OAB exige crawler');
    expect(r.body).not.toContain('dependem do crawler do tribunal');
  });
});
