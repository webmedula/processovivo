import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { criarCusto } from '../../src/domain/entities/Custo.js';
import { gerarBackup } from '../../src/infrastructure/persistencia/backup.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDeCustosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeCustosSqlite.js';

/* v0.47.0: os custos entram no backup do banco como os demais dados. Valores sintéticos. */
describe('backup do banco com o centro de custos', () => {
  let pasta: string;
  beforeEach(() => {
    pasta = mkdtempSync(join(tmpdir(), 'pv-backup-custos-'));
  });
  afterEach(() => rmSync(pasta, { recursive: true, force: true }));

  it('lançamentos e categorias próprias voltam do arquivo de backup', async () => {
    const caminho = join(pasta, 'processovivo.db');
    const db = abrirBanco(caminho);
    const repo = new RepositorioDeCustosSqlite(db);
    await repo.inserir(
      criarCusto(
        {
          id: 'c1',
          workspace: 'ws-a',
          numeroProcesso: '12345674720238260100',
          criadoEm: new Date('2026-10-20T12:00:00Z'),
        },
        {
          data: '2026-10-01',
          descricao: 'Guia de custas',
          categoria: 'custas',
          valorCentavos: 12_345,
          reembolsavel: true,
        },
        '2026-10-20',
      ),
    );
    await repo.inserirCategoria({
      id: 'k1',
      workspace: 'ws-a',
      nome: 'Cartório',
      arquivada: false,
      criadaEm: new Date('2026-10-20T12:00:00Z'),
    });

    const r = gerarBackup({
      caminhoBanco: caminho,
      destino: join(pasta, 'backups'),
      manter: 3,
    });
    db.close();
    expect(r.integro).toBe(true);

    const copia = new DatabaseSync(r.caminho, { readOnly: true });
    expect(
      copia
        .prepare('SELECT valor_centavos AS v FROM custos_processo WHERE workspace = ?')
        .get('ws-a'),
    ).toMatchObject({ v: 12_345 });
    expect(
      copia.prepare('SELECT nome FROM categorias_custo WHERE workspace = ?').get('ws-a'),
    ).toMatchObject({ nome: 'Cartório' });
    copia.close();
  });
});
