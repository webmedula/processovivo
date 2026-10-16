import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { montarAplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { executar } from '../../src/main/cli.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';

/*
 * `assinatura liberar|ver --workspace <id>` (v0.42.1). Chama o CLI EM PROCESSO (`executar`)
 * contra um banco temporário: sem rede, sem relógio real, sem `.env`, sem ordem entre testes (cada
 * um tem o próprio banco). Um `tsx` filho por chamada gastava ~1 s de transpilação cada e estourava
 * o timeout no CI; só UM teste sobe o processo de verdade, para provar que o ponto de entrada
 * continua ligado. O timeout folgado vale só para este arquivo (`describe`).
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

async function cli(
  ...args: string[]
): Promise<{ codigo: number; saida: string; erro: string }> {
  const saida: string[] = [];
  const erro: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    saida.push(a.join(' '));
  });
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    erro.push(a.join(' '));
  });
  try {
    const codigo = await executar(['assinatura', ...args], ambiente);
    return { codigo, saida: saida.join('\n'), erro: erro.join('\n') };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

async function assinaturaDe(ws: string) {
  const app = montarAplicacao(carregarConfig(ambiente));
  return app.repositorioAssinaturas.porWorkspace(ws);
}

describe('CLI — assinatura por --workspace', { timeout: 30_000 }, () => {
  it('libera e consulta o workspace de uma chave; o Drive só abre depois', async () => {
    expect(await assinaturaDe(WS)).toBeUndefined();

    const antes = await cli('ver', '--workspace', WS);
    expect(antes.codigo).toBe(0);
    expect(antes.saida).toContain('não tem assinatura');

    const lib = await cli(
      'liberar',
      '--workspace',
      WS,
      'pecas',
      '60',
      '--obs',
      'chave do operador',
    );
    expect(lib.codigo).toBe(0);
    expect(lib.saida).toContain(`workspace ${WS}`);
    expect(lib.saida).toContain('NÃO recebe aviso de vencimento');
    expect((await assinaturaDe(WS))?.plano).toBe('pecas');

    const depois = await cli('ver', '--workspace', WS);
    expect(depois.codigo).toBe(0);
    expect(depois.saida).toContain('chave de API, sem e-mail');
    expect(depois.saida).toContain(WS);

    const app = montarAplicacao(carregarConfig(ambiente));
    expect(await app.assinaturas.temRecursoSemExcecao(WS, 'salvarNoDrive')).toBe(true);
  });

  it('o ponto de entrada continua ligado: o processo de verdade responde (um único spawn)', () => {
    const r = spawnSync(
      join(process.cwd(), 'node_modules/.bin/tsx'),
      ['src/main/cli.ts', 'assinatura', 'ver', '--workspace', WS],
      { env: ambiente, encoding: 'utf8', timeout: 25_000 },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('não tem assinatura');
  });

  it('e-mail e --workspace juntos: erro claro, nada gravado', async () => {
    const r = await cli(
      'liberar',
      'ana@escritorio.com.br',
      'pecas',
      '12',
      '--workspace',
      WS,
    );
    expect(r.codigo).toBe(1);
    expect(r.erro).toContain('não os dois');
    const v = await cli('ver', 'ana@escritorio.com.br', '--workspace', WS);
    expect(v.codigo).toBe(1);
    expect(v.erro).toContain('não os dois');
    expect(await assinaturaDe(WS)).toBeUndefined();
  });

  it('nenhum dos dois: erro de uso, nada gravado', async () => {
    const r = await cli('liberar', 'pecas', '12');
    expect(r.codigo).toBe(1);
    expect(r.erro).toContain('--workspace');
    expect(await assinaturaDe(WS)).toBeUndefined();
  });

  it('id malformado ou inexistente: erro, nada gravado', async () => {
    const mal = await cli('liberar', '--workspace', 'nao-e-hex', 'pecas', '12');
    expect(mal.codigo).toBe(2);
    expect(mal.erro).toContain('malformado');
    const fantasma = 'abcdef0123456789';
    const inex = await cli('liberar', '--workspace', fantasma, 'pecas', '12');
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
    const lib = await cli('liberar', 'ana@escritorio.com.br', 'pecas', '12');
    expect(lib.codigo).toBe(0);
    expect(lib.saida).toContain('ana@escritorio.com.br: plano');
    const ver = await cli('ver', 'ana@escritorio.com.br');
    expect(ver.codigo).toBe(0);
    expect(ver.saida).toContain('ana@escritorio.com.br');
    const semConta = await cli('liberar', 'ninguem@nada.com.br', 'pecas', '12');
    expect(semConta.codigo).toBe(2);
  });
});
