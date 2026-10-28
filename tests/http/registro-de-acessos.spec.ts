import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RegistroDeAcessosSqlite } from '../../src/infrastructure/persistencia/sqlite/RegistroDeAcessosSqlite.js';
import type {
  Acesso,
  RegistroDeAcessos,
} from '../../src/domain/ports/RegistroDeAcessos.js';
import { GUARDA_DOS_REGISTROS_DE_ACESSO_DIAS } from '../../src/domain/ports/RegistroDeAcessos.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';

const CHAVE = 'chave-de-teste-1234567890';
const DESDE = new Date('2000-01-01T00:00:00Z');
const ATE = new Date('2100-01-01T00:00:00Z');

/** Guarda o que o servidor mandou gravar, sem banco no meio. */
class RegistroEspiao implements RegistroDeAcessos {
  readonly acessos: Acesso[] = [];
  registrar(acesso: Acesso): void {
    this.acessos.push(acesso);
  }
  async listar(): Promise<Acesso[]> {
    return [...this.acessos];
  }
  async apagarAnterioresA(): Promise<number> {
    return 0;
  }
}

function montar(
  registro: RegistroDeAcessos,
  env: Record<string, string> = {},
): FastifyInstance {
  const config = carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: CHAVE,
    CACHE_ENABLED: 'false',
    ...env,
  } as NodeJS.ProcessEnv);
  const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    registroDeAcessos: registro,
  });
  return construirServidor(app, config);
}

describe('registro de acessos do Marco Civil', () => {
  let servidor: FastifyInstance | undefined;
  afterEach(async () => {
    await servidor?.close();
    servidor = undefined;
  });

  it('grava instante, IP e a conta de quem usou a API', async () => {
    const registro = new RegistroEspiao();
    servidor = montar(registro);
    const antes = Date.now();

    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos',
      headers: { 'x-api-key': CHAVE },
    });

    expect(r.statusCode).toBe(200);
    expect(registro.acessos).toHaveLength(1);
    const [acesso] = registro.acessos;
    expect(acesso?.ip).toBe('127.0.0.1');
    expect(acesso?.workspace).toBe(workspaceDaChave(CHAVE));
    expect(acesso?.instante.getTime()).toBeGreaterThanOrEqual(antes);
    // Só os quatro campos: nada de rota, cabeçalho ou corpo.
    for (const campo of Object.keys(acesso ?? {})) {
      expect(['instante', 'ip', 'porta', 'workspace']).toContain(campo);
    }
  });

  it('grava também o acesso recusado, sem conta', async () => {
    const registro = new RegistroEspiao();
    servidor = montar(registro);

    const r = await servidor.inject({ method: 'GET', url: '/v1/acompanhamentos' });

    expect(r.statusCode).toBe(401);
    expect(registro.acessos).toHaveLength(1);
    expect(registro.acessos[0]?.ip).toBe('127.0.0.1');
    expect(registro.acessos[0]?.workspace).toBeUndefined();
  });

  it('não grava as verificações de saúde', async () => {
    const registro = new RegistroEspiao();
    servidor = montar(registro);

    await servidor.inject({ method: 'GET', url: '/health' });
    await servidor.inject({ method: 'GET', url: '/ready' });

    expect(registro.acessos).toHaveLength(0);
  });

  it('atrás do proxy grava o IP do cliente e omite a porta, que seria a do proxy', async () => {
    const registro = new RegistroEspiao();
    servidor = montar(registro, { HTTP_TRUST_PROXY: 'true' });

    await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos',
      headers: { 'x-api-key': CHAVE, 'x-forwarded-for': '203.0.113.9' },
    });

    expect(registro.acessos[0]?.ip).toBe('203.0.113.9');
    expect(registro.acessos[0]?.porta).toBeUndefined();
  });

  it('uma falha ao gravar não derruba a resposta', async () => {
    const db = abrirBanco(':memory:');
    const registro = new RegistroDeAcessosSqlite(db, loggerSilencioso);
    db.close();
    servidor = montar(registro);

    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos',
      headers: { 'x-api-key': CHAVE },
    });

    expect(r.statusCode).toBe(200);
  });
});

describe('RegistroDeAcessosSqlite', () => {
  it('lista por período, IP e conta, mais recentes primeiro', async () => {
    const registro = new RegistroDeAcessosSqlite(
      abrirBanco(':memory:'),
      loggerSilencioso,
    );
    registro.registrar({
      instante: new Date('2026-10-01T10:00:00Z'),
      ip: '198.51.100.1',
      porta: 51000,
      workspace: 'a'.repeat(16),
    });
    registro.registrar({
      instante: new Date('2026-10-02T10:00:00Z'),
      ip: '198.51.100.2',
      workspace: 'b'.repeat(16),
    });
    registro.registrar({
      instante: new Date('2026-10-03T10:00:00Z'),
      ip: '198.51.100.1',
    });

    const doIp = await registro.listar({ desde: DESDE, ate: ATE, ip: '198.51.100.1' });
    expect(doIp.map((a) => a.instante.toISOString())).toEqual([
      '2026-10-03T10:00:00.000Z',
      '2026-10-01T10:00:00.000Z',
    ]);
    expect(doIp[1]).toEqual({
      instante: new Date('2026-10-01T10:00:00Z'),
      ip: '198.51.100.1',
      porta: 51000,
      workspace: 'a'.repeat(16),
    });

    const daConta = await registro.listar({
      desde: DESDE,
      ate: ATE,
      workspace: 'b'.repeat(16),
    });
    expect(daConta).toHaveLength(1);
    expect(daConta[0]?.ip).toBe('198.51.100.2');
  });

  it('apaga só o que passou do prazo de 6 meses', async () => {
    const registro = new RegistroDeAcessosSqlite(
      abrirBanco(':memory:'),
      loggerSilencioso,
    );
    const agora = new Date('2026-10-27T12:00:00Z');
    const limite = new Date(
      agora.getTime() - GUARDA_DOS_REGISTROS_DE_ACESSO_DIAS * 86_400_000,
    );
    registro.registrar({
      instante: new Date(limite.getTime() - 1000),
      ip: '198.51.100.1',
    });
    registro.registrar({
      instante: new Date(limite.getTime() + 1000),
      ip: '198.51.100.2',
    });

    expect(await registro.apagarAnterioresA(limite)).toBe(1);
    const restam = await registro.listar({ desde: DESDE, ate: ATE });
    expect(restam.map((a) => a.ip)).toEqual(['198.51.100.2']);
  });

  it('o prazo nunca é menor que seis meses de calendário', () => {
    // Julho a dezembro é o maior trecho de seis meses: 184 dias.
    const seisMeses = (Date.UTC(2027, 0, 1) - Date.UTC(2026, 6, 1)) / 86_400_000;
    expect(GUARDA_DOS_REGISTROS_DE_ACESSO_DIAS).toBeGreaterThanOrEqual(seisMeses);
  });

  it('abrir o banco de novo não recria nem apaga os registros', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'pv-acessos-'));
    try {
      const caminho = join(pasta, 'processovivo.db');
      const db1 = abrirBanco(caminho);
      new RegistroDeAcessosSqlite(db1, loggerSilencioso).registrar({
        instante: new Date('2026-10-27T12:00:00Z'),
        ip: '198.51.100.1',
      });
      db1.close();
      const db2 = abrirBanco(caminho);
      const n = db2
        .prepare('SELECT COUNT(*) AS n FROM registros_de_acesso')
        .get() as unknown as {
        n: number;
      };
      expect(Number(n.n)).toBe(1);
      db2.close();
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });

  it('com o banco fechado, registrar não lança', () => {
    const db = abrirBanco(':memory:');
    db.close();
    const registro = new RegistroDeAcessosSqlite(db, loggerSilencioso);
    expect(() =>
      registro.registrar({ instante: new Date(), ip: '198.51.100.1' }),
    ).not.toThrow();
  });
});
