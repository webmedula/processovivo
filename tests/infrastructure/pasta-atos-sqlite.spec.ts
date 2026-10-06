import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDaPastaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDaPastaSqlite.js';
import type { ListagemDaPasta } from '../../src/domain/entities/PastaDigital.js';

const listagem = (atos?: ListagemDaPasta['atos']): ListagemDaPasta => ({
  numeroProcesso: '99999019620268090999',
  tribunal: 'TJGO',
  listadaEm: new Date(Date.UTC(2026, 0, 2)),
  processoSigiloso: false,
  pecas: [],
  ...(atos ? { atos } : {}),
});

describe('pasta_listagens.atos', () => {
  it('guarda e devolve os atos (inclusive sem identificador e com vínculo incerto) por workspace', async () => {
    const repo = new RepositorioDaPastaSqlite(abrirBanco(':memory:'));
    await repo.guardarListagem(
      'ws-a',
      listagem([
        {
          posicao: 1,
          data: new Date(Date.UTC(2025, 0, 1)),
          descricao: 'Ato sintético 1',
        },
        {
          posicao: 2,
          data: new Date(Date.UTC(2025, 0, 2)),
          descricao: 'Ato sintético 2',
          complemento: 'complemento sintético',
          identificador: 77,
          vinculoIncerto: true,
        },
      ]),
    );
    const a = await repo.obterListagem('ws-a', '99999019620268090999');
    expect(a?.atos).toEqual([
      { posicao: 1, data: new Date(Date.UTC(2025, 0, 1)), descricao: 'Ato sintético 1' },
      {
        posicao: 2,
        data: new Date(Date.UTC(2025, 0, 2)),
        descricao: 'Ato sintético 2',
        complemento: 'complemento sintético',
        identificador: 77,
        vinculoIncerto: true,
      },
    ]);
    // Isolamento A × B na tabela.
    expect(await repo.obterListagem('ws-b', '99999019620268090999')).toBeUndefined();
  });

  it('listagem gravada antes da 0.36.0 (sem a coluna preenchida) volta sem `atos`, sem erro', async () => {
    const db = abrirBanco(':memory:');
    const repo = new RepositorioDaPastaSqlite(db);
    await repo.guardarListagem('ws-a', listagem());
    expect(
      (await repo.obterListagem('ws-a', '99999019620268090999'))?.atos,
    ).toBeUndefined();
  });

  it('a migração acrescenta a coluna num banco que já tinha a tabela, sem perder a linha', async () => {
    const pasta = mkdtempSync(join(tmpdir(), 'pv-atos-'));
    try {
      const caminho = join(pasta, 'banco.db');
      const velho = new DatabaseSync(caminho);
      velho.exec(`CREATE TABLE pasta_listagens (
        workspace TEXT NOT NULL, numero TEXT NOT NULL, tribunal TEXT NOT NULL,
        listada_em TEXT NOT NULL, processo_sigiloso INTEGER NOT NULL, pecas TEXT NOT NULL,
        PRIMARY KEY (workspace, numero))`);
      velho
        .prepare(
          `INSERT INTO pasta_listagens VALUES ('ws','99999019620268090999','TJGO','2025-01-01T00:00:00.000Z',0,'[]')`,
        )
        .run();
      velho.close();
      const db = abrirBanco(caminho);
      const l = await new RepositorioDaPastaSqlite(db).obterListagem(
        'ws',
        '99999019620268090999',
      );
      expect(l?.tribunal).toBe('TJGO');
      expect(l?.atos).toBeUndefined();
      db.close();
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});
