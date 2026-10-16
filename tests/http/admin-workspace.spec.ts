import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';

/* Assinatura de um workspace de CHAVE de API pelo ID (v0.42.1). Sem rede. */

const CHAVE_DO_ENV = 'chave-do-env-1234567890-abcdef';
const ADMIN_USUARIO = 'joao';
const ADMIN_SENHA = 'uma-senha-administrativa-bem-forte';
const auth = {
  authorization: 'Basic ' + Buffer.from(`${ADMIN_USUARIO}:${ADMIN_SENHA}`).toString('base64'),
};

let servidor: FastifyInstance;
let app: Aplicacao;

beforeEach(() => {
  app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    admin: { usuario: ADMIN_USUARIO, senha: ADMIN_SENHA },
    comAssinaturas: true,
  });
  servidor = construirServidor(
    app,
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      PROCESSOVIVO_API_KEYS: CHAVE_DO_ENV,
      CACHE_ENABLED: 'false',
      COOKIE_SECURE: 'false',
    } as NodeJS.ProcessEnv),
  );
});
afterEach(async () => {
  await servidor.close();
});

async function emitirChave(): Promise<string> {
  const r = await servidor.inject({
    method: 'POST',
    url: '/admin/api/chaves',
    headers: auth,
    payload: { rotulo: 'integração do operador' },
  });
  expect(r.statusCode).toBe(201);
  return (r.json() as { workspace: string }).workspace;
}

const liberar = (ws: string, corpo: Record<string, unknown> = { plano: 'pecas', meses: 12 }) =>
  servidor.inject({
    method: 'POST',
    url: `/admin/api/workspaces/${ws}/assinatura/liberar`,
    headers: auth,
    payload: corpo,
  });

describe('Admin — assinatura por workspace', () => {
  it('o /admin mostra o workspace de cada chave emitida (é o id que se usa aqui)', async () => {
    const ws = await emitirChave();
    const r = await servidor.inject({ url: '/admin/api/chaves', headers: auth });
    expect((r.json() as { chaves: { workspace: string }[] }).chaves[0]?.workspace).toBe(ws);
    expect(ws).toMatch(/^[0-9a-f]{16}$/);
  });

  it('liberar e ver por workspace: o Drive só fica liberado DEPOIS da liberação', async () => {
    const ws = await emitirChave();
    // Antes: chave sem assinatura passa livre nos outros recursos, mas NÃO no Drive.
    expect(await app.assinaturas.temRecursoSemExcecao(ws, 'salvarNoDrive')).toBe(false);
    const antes = await servidor.inject({
      url: `/admin/api/workspaces/${ws}/assinatura`,
      headers: auth,
    });
    expect(antes.statusCode).toBe(200);
    expect(antes.json()).toMatchObject({ workspace: ws, assinatura: null });

    const lib = await liberar(ws);
    expect(lib.statusCode).toBe(201);
    expect(lib.json()).toMatchObject({ workspace: ws, plano: 'pecas' });

    const depois = await servidor.inject({
      url: `/admin/api/workspaces/${ws}/assinatura`,
      headers: auth,
    });
    expect(depois.json().assinatura).toMatchObject({ plano: 'pecas' });
    expect(await app.assinaturas.temRecursoSemExcecao(ws, 'salvarNoDrive')).toBe(true);
    expect(await app.assinaturas.temRecursoSemExcecao(ws, 'pecas')).toBe(true);
    // A regra é a mesma: um plano SEM o recurso continua sem ele.
    await liberar(ws, { plano: 'acompanhamento', meses: 1 });
    expect(await app.assinaturas.temRecursoSemExcecao(ws, 'salvarNoDrive')).toBe(false);
  });

  it('aceita o workspace de uma chave do .env', async () => {
    const ws = workspaceDaChave(CHAVE_DO_ENV);
    expect((await liberar(ws)).statusCode).toBe(201);
    expect(await app.assinaturas.temRecursoSemExcecao(ws, 'salvarNoDrive')).toBe(true);
  });

  it('id malformado: 400, nada gravado', async () => {
    for (const ruim of ['xyz', '123', 'g'.repeat(16), '0'.repeat(17)]) {
      const r = await liberar(ruim);
      expect(r.statusCode, ruim).toBe(400);
      expect(r.json().erro).toBe('WORKSPACE_INVALIDO');
      expect(await app.repositorioAssinaturas.porWorkspace(ruim)).toBeUndefined();
    }
    const ver = await servidor.inject({
      url: '/admin/api/workspaces/xyz/assinatura',
      headers: auth,
    });
    expect(ver.statusCode).toBe(400);
  });

  it('id bem formado que não é de conta nem de chave: 404, nada gravado', async () => {
    const fantasma = 'abcdef0123456789';
    const r = await liberar(fantasma);
    expect(r.statusCode).toBe(404);
    expect(r.json().erro).toBe('WORKSPACE_INVALIDO');
    expect(r.body).not.toContain(fantasma);
    expect(await app.repositorioAssinaturas.porWorkspace(fantasma)).toBeUndefined();
    expect(
      (
        await servidor.inject({
          url: `/admin/api/workspaces/${fantasma}/assinatura`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('chave revogada não serve', async () => {
    const r = await servidor.inject({
      method: 'POST',
      url: '/admin/api/chaves',
      headers: auth,
      payload: { rotulo: 'velha' },
    });
    const { workspace, identificador } = r.json() as {
      workspace: string;
      identificador: string;
    };
    await servidor.inject({
      method: 'POST',
      url: `/admin/api/chaves/${identificador}/revogar`,
      headers: auth,
    });
    expect((await liberar(workspace)).statusCode).toBe(404);
  });

  it('também aceita o workspace de uma conta (32 hex), e exige a autenticação administrativa', async () => {
    const c = await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: { nome: 'Ana', email: 'ana@escritorio.com.br', senha: 'uma-senha-boa-o-bastante' },
    });
    expect(c.statusCode).toBe(201);
    const ws = (await app.usuarios.porEmail('ana@escritorio.com.br'))?.usuario.workspace as string;
    expect(ws).toMatch(/^[0-9a-f]{32}$/);
    expect((await liberar(ws)).statusCode).toBe(201);
    const semAuth = await servidor.inject({
      method: 'POST',
      url: `/admin/api/workspaces/${ws}/assinatura/liberar`,
      payload: { plano: 'pecas', meses: 1 },
    });
    expect(semAuth.statusCode).toBe(401);
  });

  it('regressão: liberar por e-mail continua igual', async () => {
    await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: { nome: 'Bia', email: 'bia@escritorio.com.br', senha: 'uma-senha-boa-o-bastante' },
    });
    const r = await servidor.inject({
      method: 'POST',
      url: '/admin/api/assinaturas/bia@escritorio.com.br/liberar',
      headers: auth,
      payload: { plano: 'pecas', meses: 3 },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ email: 'bia@escritorio.com.br', plano: 'pecas' });
  });
});
