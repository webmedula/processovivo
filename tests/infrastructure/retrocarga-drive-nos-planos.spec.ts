import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARCA_DRIVE_NOS_PLANOS,
  abrirBanco,
} from '../../src/infrastructure/persistencia/sqlite/banco.js';

describe('retrocarga do "Salvar no Drive" nos planos Peças e IA já gravados', () => {
  let pasta: string;
  beforeEach(() => {
    pasta = mkdtempSync(join(tmpdir(), 'pv-drive-planos-'));
  });
  afterEach(() => rmSync(pasta, { recursive: true, force: true }));

  const recursosDos = (db: ReturnType<typeof abrirBanco>): Record<string, string[]> =>
    Object.fromEntries(
      (
        db.prepare('SELECT codigo, recursos FROM planos').all() as Array<{
          codigo: string;
          recursos: string;
        }>
      ).map((l) => [l.codigo, JSON.parse(l.recursos) as string[]]),
    );

  /** Um banco da v0.41: planos SEM o recurso e sem a marca. */
  function bancoAntigo(caminho: string): void {
    const db = abrirBanco(caminho);
    for (const [codigo, recursos] of Object.entries(recursosDos(db))) {
      db.prepare('UPDATE planos SET recursos = ? WHERE codigo = ?').run(
        JSON.stringify(recursos.filter((r) => r !== 'salvarNoDrive')),
        codigo,
      );
    }
    db.prepare('DELETE FROM estado WHERE chave = ?').run(MARCA_DRIVE_NOS_PLANOS);
    db.close();
  }

  it('Peças e IA ganham o recurso; o Acompanhamento não', () => {
    const caminho = join(pasta, 'a.db');
    bancoAntigo(caminho);
    const db = abrirBanco(caminho);
    const r = recursosDos(db);
    expect(r['pecas']).toContain('salvarNoDrive');
    expect(r['ia']).toContain('salvarNoDrive');
    expect(r['acompanhamento']).not.toContain('salvarNoDrive');
    db.close();
  });

  it('só para os dois códigos nomeados: plano criado pelo painel, mesmo com peças, fica como está', () => {
    const caminho = join(pasta, 'b.db');
    bancoAntigo(caminho);
    const antes = abrirBanco(caminho);
    antes.prepare('DELETE FROM estado WHERE chave = ?').run(MARCA_DRIVE_NOS_PLANOS);
    antes
      .prepare(
        `INSERT INTO planos (codigo, nome, resumo, recursos, disponivel, preco_mensal_centavos, ordem)
         VALUES ('pecas-anual', 'Peças anual', 'x', ?, 1, NULL, 25)`,
      )
      .run(JSON.stringify(['consulta', 'pecas']));
    antes.close();
    const db = abrirBanco(caminho);
    expect(recursosDos(db)['pecas-anual']).toEqual(['consulta', 'pecas']);
    db.close();
  });

  it('roda UMA vez: não duplica e não desfaz a decisão do operador que o tirou depois', () => {
    const caminho = join(pasta, 'c.db');
    bancoAntigo(caminho);
    abrirBanco(caminho).close();
    const meio = abrirBanco(caminho);
    meio
      .prepare('UPDATE planos SET recursos = ? WHERE codigo = ?')
      .run(JSON.stringify(['consulta', 'acompanhamento', 'pecas']), 'pecas');
    meio.close();
    const db = abrirBanco(caminho);
    const r = recursosDos(db);
    expect(r['pecas']).not.toContain('salvarNoDrive');
    expect(r['ia']?.filter((x) => x === 'salvarNoDrive')).toHaveLength(1);
    db.close();
  });

  it('banco novo: a semente já traz o recurso e a marca fica gravada', () => {
    const db = abrirBanco(join(pasta, 'd.db'));
    expect(recursosDos(db)['pecas']).toContain('salvarNoDrive');
    expect(
      db.prepare('SELECT 1 FROM estado WHERE chave = ?').get(MARCA_DRIVE_NOS_PLANOS),
    ).toBeTruthy();
    db.close();
  });
});
