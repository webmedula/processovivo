import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirServidor } from '../../src/main/http/servidor.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { MockCrawlerAdapter } from '../../src/infrastructure/adapters/crawler/MockCrawlerAdapter.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import type { BuscaPorOabComPeriodo } from '../../src/application/services/ServicoVigilanciaOab.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';

const CHAVE_A = 'chave-workspace-a-1234567890';
const CHAVE_B = 'chave-workspace-b-1234567890';

const buscaComUmProcesso: BuscaPorOabComPeriodo = {
  buscarPorOabNoPeriodo: async () => [
    new Processo({
      numero: NumeroCNJ.criar(NUMERO_TJSP_A),
      tribunal: 'TJSP',
      movimentacoes: [{ data: new Date('2026-09-04T00:00:00-03:00'), titulo: 'Decisão' }],
      procedencia: {
        provider: 'djen',
        consultadoEm: new Date('2026-09-05T12:00:00Z'),
        deCache: false,
      },
    }),
  ],
};

function montar(comVigilancia: boolean): FastifyInstance {
  const config = carregarConfig({
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
    PROCESSOVIVO_DB_PATH: ':memory:',
  } as NodeJS.ProcessEnv);
  return construirServidor(
    aplicacaoDeTeste(
      [new MockCrawlerAdapter({ latenciaMs: 0 })],
      comVigilancia ? { buscaOab: buscaComUmProcesso } : {},
    ),
    config,
  );
}

describe('rotas de vigilância por OAB', () => {
  let s: FastifyInstance;
  const a = { 'x-api-key': CHAVE_A };
  const b = { 'x-api-key': CHAVE_B };

  beforeEach(() => {
    s = montar(true);
  });
  afterEach(async () => {
    await s.close();
  });

  it('cadastra uma inscrição', async () => {
    const r = await s.inject({
      method: 'POST',
      url: '/v1/vigilancias',
      headers: a,
      payload: { oab: '47383', uf: 'GO', apelido: 'Dr. João' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().identificacao).toBe('47383/GO');
    expect(r.json().ativa).toBe(true);
  });

  it('duas chaves são dois espaços isolados', async () => {
    // Vazar aqui misturaria a carteira de dois assinantes.
    await s.inject({
      method: 'POST',
      url: '/v1/vigilancias',
      headers: a,
      payload: { oab: '47383', uf: 'GO' },
    });
    expect(
      (await s.inject({ method: 'GET', url: '/v1/vigilancias', headers: a })).json()
        .total,
    ).toBe(1);
    expect(
      (await s.inject({ method: 'GET', url: '/v1/vigilancias', headers: b })).json()
        .total,
    ).toBe(0);
  });

  it('400 com UF fora do formato', async () => {
    const r = await s.inject({
      method: 'POST',
      url: '/v1/vigilancias',
      headers: a,
      payload: { oab: '47383', uf: 'GOI' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('remove a vigilância', async () => {
    await s.inject({
      method: 'POST',
      url: '/v1/vigilancias',
      headers: a,
      payload: { oab: '47383', uf: 'GO' },
    });
    const r = await s.inject({
      method: 'DELETE',
      url: '/v1/vigilancias/GO/47383',
      headers: a,
    });
    expect(r.statusCode).toBe(200);
  });

  it('404 ao remover inscrição que não estava vigiada', async () => {
    const r = await s.inject({
      method: 'DELETE',
      url: '/v1/vigilancias/GO/99999',
      headers: a,
    });
    expect(r.statusCode).toBe(404);
  });

  it('a varredura manual responde 202 sem segurar a conexão', async () => {
    const r = await s.inject({
      method: 'POST',
      url: '/v1/vigilancias/varrer',
      headers: a,
    });
    expect(r.statusCode).toBe(202);
  });

  it('todas as rotas novas exigem autenticação', async () => {
    for (const url of ['/v1/vigilancias', '/v1/notificacao']) {
      expect((await s.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });
});

describe('preferência de aviso', () => {
  let s: FastifyInstance;
  const a = { 'x-api-key': CHAVE_A };

  beforeEach(() => {
    s = montar(true);
  });
  afterEach(async () => {
    await s.close();
  });

  it('começa desligada', async () => {
    const r = await s.inject({ method: 'GET', url: '/v1/notificacao', headers: a });
    expect(r.json()).toEqual({ email: null, ativa: false, ultimoEnvioEm: null });
  });

  it('guarda o endereço e liga', async () => {
    const r = await s.inject({
      method: 'PUT',
      url: '/v1/notificacao',
      headers: a,
      payload: { email: 'joao@exemplo.com', ativa: true },
    });
    expect(r.json()).toEqual({ email: 'joao@exemplo.com', ativa: true });
  });

  it('ligar sem endereço não liga', async () => {
    // Aviso ativo sem destino é configuração que passa sensação de proteção e
    // nunca avisa ninguém.
    const r = await s.inject({
      method: 'PUT',
      url: '/v1/notificacao',
      headers: a,
      payload: { ativa: true },
    });
    expect(r.json().ativa).toBe(false);
  });

  it('recusa endereço malformado', async () => {
    const r = await s.inject({
      method: 'PUT',
      url: '/v1/notificacao',
      headers: a,
      payload: { email: 'isso-nao-e-email', ativa: true },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('cadeia sem fonte que busca por OAB', () => {
  let s: FastifyInstance;

  beforeEach(() => {
    s = montar(false);
  });
  afterEach(async () => {
    await s.close();
  });

  it('responde 501 dizendo o que configurar, em vez de nunca achar nada', async () => {
    // Existir e devolver zero seria pior: o usuário cadastraria a inscrição,
    // veria "0 processos" e concluiria que não tem processo — quando o que
    // falta é o DJEN na cadeia.
    const r = await s.inject({
      method: 'POST',
      url: '/v1/vigilancias',
      headers: { 'x-api-key': CHAVE_A },
      payload: { oab: '47383', uf: 'GO' },
    });
    expect(r.statusCode).toBe(501);
    expect(r.body).toContain('djen');
  });
});

describe('console com a aba de vigilância', () => {
  let s: FastifyInstance;

  beforeEach(() => {
    s = montar(true);
  });
  afterEach(async () => {
    await s.close();
  });

  it('a navegação traz a aba nova', async () => {
    const r = await s.inject({ method: 'GET', url: '/' });
    expect(r.body).toContain('nav-vigilancia');
  });

  it('o topo do processo passa a responder "o que preciso fazer"', async () => {
    // A mudança de layout da v0.10.0. Desde a v0.37.7 o bloco "Pede providência" não
    // existe na tela do processo: a pergunta é respondida pela marca no ato da linha do
    // tempo (e pelo filtro), e pela aba Atualizações.
    const r = await s.inject({ method: 'GET', url: '/' });
    expect(r.body).toContain('Pede providência'); // o filtro da linha do tempo e o de Atualizações
    expect(r.body).toContain('ler o ato inteiro');
    expect(r.body).toContain('Com inteiro teor');
  });

  it('a triagem é sempre apresentada como heurística, nunca como certeza', async () => {
    // Dizer ao advogado que o prazo está calculado é o pior que este produto
    // pode fazer.
    const r = await s.inject({ method: 'GET', url: '/' });
    expect(r.body).toContain('Confira no ato completo');
  });
});
