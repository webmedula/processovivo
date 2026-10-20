import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARCA_CUSTOS_NOS_PLANOS,
  abrirBanco,
} from '../../src/infrastructure/persistencia/sqlite/banco.js';

/* O centro de custos entra em TODOS os planos já gravados (v0.47.0) — uma vez, como o calendário. */
describe('retrocarga do centro de custos nos planos já gravados', () => {
  let pasta: string;
  beforeEach(() => {
    pasta = mkdtempSync(join(tmpdir(), 'pv-custos-planos-'));
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

  /** Um banco da v0.46: planos SEM o recurso e sem a marca. */
  function bancoAntigo(caminho: string): void {
    const db = abrirBanco(caminho);
    for (const [codigo, recursos] of Object.entries(recursosDos(db))) {
      db.prepare('UPDATE planos SET recursos = ? WHERE codigo = ?').run(
        JSON.stringify(recursos.filter((r) => r !== 'custosDoProcesso')),
        codigo,
      );
    }
    db.prepare('DELETE FROM estado WHERE chave = ?').run(MARCA_CUSTOS_NOS_PLANOS);
    db.close();
  }

  it('todos os planos gravados ganham o recurso — inclusive um criado pelo painel', () => {
    const caminho = join(pasta, 'a.db');
    bancoAntigo(caminho);
    const meio = abrirBanco(caminho);
    meio.prepare('DELETE FROM estado WHERE chave = ?').run(MARCA_CUSTOS_NOS_PLANOS);
    meio
      .prepare(
        `INSERT INTO planos (codigo, nome, resumo, recursos, disponivel, preco_mensal_centavos, ordem)
         VALUES ('pecas-anual', 'Peças anual', 'x', ?, 1, NULL, 25)`,
      )
      .run(JSON.stringify(['consulta', 'pecas']));
    meio.close();
    const db = abrirBanco(caminho);
    const r = recursosDos(db);
    for (const codigo of ['acompanhamento', 'pecas', 'ia', 'pecas-anual']) {
      expect(r[codigo], codigo).toContain('custosDoProcesso');
    }
    // O que o plano já tinha continua lá, na mesma ordem.
    expect(r['pecas-anual']).toEqual(['consulta', 'pecas', 'custosDoProcesso']);
    db.close();
  });

  it('roda UMA vez: não duplica e não desfaz a decisão do operador que o tirou de um plano depois', () => {
    const caminho = join(pasta, 'b.db');
    bancoAntigo(caminho);
    abrirBanco(caminho).close();
    const meio = abrirBanco(caminho);
    meio
      .prepare('UPDATE planos SET recursos = ? WHERE codigo = ?')
      .run(JSON.stringify(['consulta', 'acompanhamento']), 'acompanhamento');
    meio.close();
    const db = abrirBanco(caminho);
    const r = recursosDos(db);
    expect(r['acompanhamento']).not.toContain('custosDoProcesso');
    expect(r['pecas']?.filter((x) => x === 'custosDoProcesso')).toHaveLength(1);
    db.close();
  });

  it('banco novo: a semente já traz o recurso e a marca fica gravada', () => {
    const db = abrirBanco(join(pasta, 'c.db'));
    for (const lista of Object.values(recursosDos(db)))
      expect(lista).toContain('custosDoProcesso');
    expect(
      db.prepare('SELECT 1 FROM estado WHERE chave = ?').get(MARCA_CUSTOS_NOS_PLANOS),
    ).toBeTruthy();
    db.close();
  });

  it('as tabelas de custos são novas e aditivas: um banco anterior abre com elas vazias', () => {
    const caminho = join(pasta, 'd.db');
    const db = abrirBanco(caminho);
    db.exec('DROP TABLE custos_processo; DROP TABLE categorias_custo;');
    db.close();
    const reaberto = abrirBanco(caminho);
    for (const t of ['custos_processo', 'categorias_custo']) {
      expect(
        (reaberto.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      ).toBe(0);
    }
    reaberto.close();
  });
});
