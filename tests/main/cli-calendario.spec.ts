import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventoDeCalendario } from '../../src/domain/entities/EventoDeCalendario.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDeEventosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeEventosSqlite.js';
import { RepositorioUsuariosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioUsuariosSqlite.js';
import { executar } from '../../src/main/cli.js';

/* `calendario resumo-previa` (v0.51.0), em processo, contra um banco temporário. Sem rede, sem e-mail. */
let pasta: string;
let ambiente: NodeJS.ProcessEnv;
beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), 'pv-cli-cal-'));
  ambiente = {
    PATH: process.env['PATH'] ?? '',
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    PROCESSOVIVO_DB_PATH: join(pasta, 'pv.db'),
    PROCESSOVIVO_API_KEYS: 'chave-do-cli-1234567890-abcdef',
    LOG_LEVEL: 'silent',
    CACHE_ENABLED: 'false',
    SMTP_HOST: 'smtp.exemplo.invalid',
    SMTP_FROM: 'avisos@exemplo.invalid',
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
    const codigo = await executar(['calendario', ...args], ambiente);
    return { codigo, saida: saida.join('\n'), erro: erro.join('\n') };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe('CLI — calendario resumo-previa', () => {
  it('ação desconhecida mostra o uso', async () => {
    const r = await cli('qualquer-coisa');
    expect(r.codigo).toBe(1);
    expect(r.erro).toMatch(/Uso: calendario resumo-previa/);
  });

  it('sem SMTP de verdade, diz o que falta e falha', async () => {
    delete ambiente['SMTP_HOST'];
    delete ambiente['SMTP_FROM'];
    const r = await cli('resumo-previa');
    expect(r.codigo).toBe(1);
    expect(r.erro).toMatch(/SMTP_HOST e SMTP_FROM/);
  });

  it('conta contas e itens, diz se a chave está ligada e não mostra e-mail nem número', async () => {
    const db = abrirBanco(ambiente['PROCESSOVIVO_DB_PATH'] as string);
    const usuarios = new RepositorioUsuariosSqlite(db);
    const ana = await usuarios.criar({
      email: 'ana@exemplo.test',
      nome: 'Ana',
      senhaGuardada: 'x',
    });
    const eventos = new RepositorioDeEventosSqlite(db);
    const futuro = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    for (const [id, mov] of [
      ['e1', 'm1'],
      ['e2', 'm2'],
    ] as const) {
      await eventos.inserirSeNovo(
        EventoDeCalendario.sugerido({
          id,
          workspace: ana.workspace,
          numeroProcesso: '12345674720238260100',
          tribunal: 'TJSP',
          segredoJustica: false,
          sugestao: {
            tipo: 'audiencia',
            titulo: 'Audiência',
            dataLocal: futuro,
            horaLocal: '14:30',
            procedencia: {
              movimentacaoId: mov,
              dataDoAndamento: new Date(),
              trecho: 't',
            },
          },
          agora: new Date(),
        }),
      );
    }
    db.close();

    const r = await cli('resumo-previa');
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain(
      'Chave PROCESSOVIVO_CALENDARIO_RESUMO_HABILITADO: desligada',
    );
    expect(r.saida).toContain('Contas que receberiam o resumo agora: 1');
    expect(r.saida).toContain('Itens (eventos a confirmar ou rever): 2');
    expect(r.saida + r.erro).not.toMatch(/ana@exemplo|12345674720238260100|1234567-47/);
    expect(r.erro).toContain('Nada foi enviado');

    ambiente = { ...ambiente, PROCESSOVIVO_CALENDARIO_RESUMO_HABILITADO: 'true' };
    expect((await cli('resumo-previa')).saida).toContain('LIGADA');
  });
});
