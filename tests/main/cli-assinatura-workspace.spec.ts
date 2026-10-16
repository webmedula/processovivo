import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { montarAplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';

/*
 * `assinatura liberar|ver --workspace <id>` (v0.42.1). Roda o CLI de verdade (tsx) contra um
 * banco temporário: sem rede, sem `.env`. O chaveiro do ambiente é sintético.
 */

const CHAVE = 'chave-do-cli-1234567890-abcdef';
const WS = workspaceDaChave(CHAVE);

let pasta: string;
let ambiente: NodeJS.ProcessEnv;

beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), 'pv-cli-'));
  ambiente = {
    PATH: process.env['PATH'] ?? '',
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    PROCESSOVIVO_DB_PATH: join(pasta, 'pv.db'),
    PROCESSOVIVO_API_KEYS: CHAVE,
    LOG_LEVEL: 'silent',
    CACHE_ENABLED: 'false',
  };
});
afterEach(() => rmSync(pasta, { recursive: true, force: true }));

function cli(...args: string[]): { codigo: number; saida: string; erro: string } {
  const r = spawnSync(
    join(process.cwd(), 'node_modules/.bin/tsx'),
    ['src/main/cli.ts', 'assinatura', ...args],
    { env: ambiente, encoding: 'utf8', timeout: 60_000 },
  );
  return { codigo: r.status ?? -1, saida: r.stdout, erro: r.stderr };
}

async function assinaturaDe(ws: string) {
  const app = montarAplicacao(carregarConfig(ambiente));
  return app.repositorioAssinaturas.porWorkspace(ws);
}

describe('CLI — assinatura por --workspace', () => {
  it('libera e consulta o workspace de uma chave; o Drive só abre depois', async () => {
    expect(await assinaturaDe(WS)).toBeUndefined();

    const antes = cli('ver', '--workspace', WS);
    expect(antes.codigo).toBe(0);
    expect(antes.saida).toContain('não tem assinatura');

    const lib = cli('liberar', '--workspace', WS, 'pecas', '60', '--obs', 'chave do operador');
    expect(lib.codigo).toBe(0);
    expect(lib.saida).toContain(`workspace ${WS}`);
    expect(lib.saida).toContain('NÃO recebe aviso de vencimento');
    expect((await assinaturaDe(WS))?.plano).toBe('pecas');

    const depois = cli('ver', '--workspace', WS);
    expect(depois.codigo).toBe(0);
    expect(depois.saida).toContain('chave de API, sem e-mail');
    expect(depois.saida).toContain(WS);

    const app = montarAplicacao(carregarConfig(ambiente));
    expect(await app.assinaturas.temRecursoSemExcecao(WS, 'salvarNoDrive')).toBe(true);
  });

  it('e-mail e --workspace juntos: erro claro, nada gravado', async () => {
    const r = cli('liberar', 'ana@escritorio.com.br', 'pecas', '12', '--workspace', WS);
    expect(r.codigo).toBe(1);
    expect(r.erro).toContain('não os dois');
    const v = cli('ver', 'ana@escritorio.com.br', '--workspace', WS);
    expect(v.codigo).toBe(1);
    expect(v.erro).toContain('não os dois');
    expect(await assinaturaDe(WS)).toBeUndefined();
  });

  it('nenhum dos dois: erro de uso, nada gravado', async () => {
    const r = cli('liberar', 'pecas', '12');
    expect(r.codigo).toBe(1);
    expect(r.erro).toContain('--workspace');
    expect(await assinaturaDe(WS)).toBeUndefined();
  });

  it('id malformado ou inexistente: erro, nada gravado', async () => {
    const mal = cli('liberar', '--workspace', 'nao-e-hex', 'pecas', '12');
    expect(mal.codigo).toBe(2);
    expect(mal.erro).toContain('malformado');
    const fantasma = 'abcdef0123456789';
    const inex = cli('liberar', '--workspace', fantasma, 'pecas', '12');
    expect(inex.codigo).toBe(2);
    expect(inex.erro).toContain('Nenhuma conta nem chave');
    expect(await assinaturaDe(fantasma)).toBeUndefined();
    expect(await assinaturaDe(WS)).toBeUndefined();
  });

  it('regressão: liberar e ver por e-mail continuam iguais', async () => {
    const app = montarAplicacao(carregarConfig(ambiente));
    await app.contas.cadastrar({
      nome: 'Ana Souza',
      email: 'ana@escritorio.com.br',
      senha: 'uma-senha-boa-o-bastante',
    });
    const lib = cli('liberar', 'ana@escritorio.com.br', 'pecas', '12');
    expect(lib.codigo).toBe(0);
    expect(lib.saida).toContain('ana@escritorio.com.br: plano');
    const ver = cli('ver', 'ana@escritorio.com.br');
    expect(ver.codigo).toBe(0);
    expect(ver.saida).toContain('ana@escritorio.com.br');
    const semConta = cli('liberar', 'ninguem@nada.com.br', 'pecas', '12');
    expect(semConta.codigo).toBe(2);
  });
});
