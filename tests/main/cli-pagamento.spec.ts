import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executar } from '../../src/main/cli.js';

/* `pagamento reconciliar` (v0.44.0), em processo, contra um banco temporário. Sem rede. */
let pasta: string;
let ambiente: NodeJS.ProcessEnv;
beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), 'pv-cli-pag-'));
  ambiente = {
    PATH: process.env['PATH'] ?? '',
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    PROCESSOVIVO_DB_PATH: join(pasta, 'pv.db'),
    PROCESSOVIVO_API_KEYS: 'chave-do-cli-1234567890-abcdef',
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
  const log = vi
    .spyOn(console, 'log')
    .mockImplementation((...a: unknown[]) => void saida.push(a.join(' ')));
  const err = vi
    .spyOn(console, 'error')
    .mockImplementation((...a: unknown[]) => void erro.push(a.join(' ')));
  try {
    const codigo = await executar(['pagamento', ...args], ambiente);
    return { codigo, saida: saida.join('\n'), erro: erro.join('\n') };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe('CLI — pagamento reconciliar', () => {
  it('com a cobrança desligada, diz como ligar e falha', async () => {
    const r = await cli('reconciliar');
    expect(r.codigo).toBe(1);
    expect(r.erro).toMatch(/PROCESSOVIVO_PAGAMENTO_HABILITADO/);
  });

  it('ação desconhecida mostra o uso', async () => {
    const r = await cli('qualquer-coisa');
    expect(r.codigo).toBe(1);
    expect(r.erro).toMatch(/Uso: pagamento reconciliar/);
  });

  it('ligada (gateway falso, sem contas): roda e imprime só contagens', async () => {
    ambiente = {
      ...ambiente,
      PROCESSOVIVO_PAGAMENTO_HABILITADO: 'true',
      PROCESSOVIVO_PAGAMENTO_GATEWAY: 'falso',
      PROCESSOVIVO_PAGAMENTO_AMBIENTE: 'teste',
      PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test',
      PROCESSOVIVO_TERMOS_VERSAO: '1.1',
    };
    const r = await cli('reconciliar');
    expect(r.codigo).toBe(0);
    expect(r.saida).toBe(
      'Verificadas: 0 · corrigidas: 0 · pagamentos novos: 0 · falhas: 0.',
    );
  });
});
