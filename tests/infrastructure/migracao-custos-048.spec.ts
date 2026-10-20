import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARCA_CUSTOS_048,
  abrirBanco,
  migrarCustosPara048,
} from '../../src/infrastructure/persistencia/sqlite/banco.js';

/*
 * Migração dos custos para a 0.48.0. O banco é montado com o ESQUEMA EXATO da 0.47.0 (sem pago_por,
 * cancelado_*, grupo, recebimentos nem histórico) e dados sintéticos. Cada caso explica o que prova.
 */
const ESQUEMA_047 = [
  `CREATE TABLE custos_processo (
     workspace TEXT NOT NULL, id TEXT NOT NULL, numero TEXT NOT NULL, data TEXT NOT NULL,
     descricao TEXT NOT NULL, categoria TEXT NOT NULL,
     valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
     reembolsavel INTEGER NOT NULL DEFAULT 0, ressarcido_em TEXT,
     criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL, PRIMARY KEY (workspace, id))`,
  `CREATE TABLE categorias_custo (
     workspace TEXT NOT NULL, id TEXT NOT NULL, nome TEXT NOT NULL, nome_chave TEXT NOT NULL,
     arquivada INTEGER NOT NULL DEFAULT 0, criada_em TEXT NOT NULL,
     PRIMARY KEY (workspace, id), UNIQUE (workspace, nome_chave))`,
];

const NUM = '12345674720238260100';
let pasta: string;
let caminho: string;

beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), 'pv-mig-custos-'));
  caminho = join(pasta, 'processovivo.db');
});
afterEach(() => rmSync(pasta, { recursive: true, force: true }));

function banco047(): void {
  const db = new DatabaseSync(caminho);
  for (const ddl of ESQUEMA_047) db.exec(ddl);
  const ins = db.prepare(
    `INSERT INTO custos_processo (workspace, id, numero, data, descricao, categoria,
       valor_centavos, reembolsavel, ressarcido_em, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  );
  // Uma de cada categoria antiga; duas ressarcidas, uma com a coluna preenchida mas não reembolsável.
  ins.run('ws-a', 'l1', NUM, '2026-09-01', 'a', 'custas', 10_000, 1, '2026-09-10');
  ins.run('ws-a', 'l2', NUM, '2026-09-02', 'b', 'pericia', 20_000, 1, null);
  ins.run('ws-a', 'l3', NUM, '2026-09-03', 'c', 'diligencia', 30_000, 1, '2026-09-11');
  ins.run('ws-a', 'l4', NUM, '2026-09-04', 'd', 'deslocamento', 40_000, 0, null);
  ins.run('ws-a', 'l5', NUM, '2026-09-05', 'e', 'copias', 50_000, 0, '2026-09-12');
  ins.run('ws-a', 'l6', NUM, '2026-09-06', 'f', 'publicacoes', 60_000, 0, null);
  ins.run('ws-a', 'l7', NUM, '2026-09-07', 'g', 'outros', 70_000, 0, null);
  ins.run('ws-a', 'l8', NUM, '2026-09-08', 'h', 'c-propria1', 80_000, 0, null);
  ins.run('ws-b', 'l9', NUM, '2026-09-09', 'i', 'custas', 90_000, 1, '2026-09-13');
  db.prepare(
    `INSERT INTO categorias_custo (workspace, id, nome, nome_chave, arquivada, criada_em)
     VALUES ('ws-a', 'propria1', 'Cartório X', 'cartorio x', 0, '2026-10-01T00:00:00.000Z')`,
  ).run();
  db.close();
}

describe('migração dos custos da 0.47.0 para a 0.48.0', () => {
  it('reclassifica as categorias, cria UM recebimento por lançamento ressarcido e não apaga nada', () => {
    banco047();
    const db = abrirBanco(caminho);

    const cat = (id: string): string =>
      (
        db.prepare('SELECT categoria AS c FROM custos_processo WHERE id = ?').get(id) as {
          c: string;
        }
      ).c;
    expect([
      cat('l1'),
      cat('l2'),
      cat('l3'),
      cat('l4'),
      cat('l5'),
      cat('l6'),
      cat('l7'),
    ]).toEqual([
      'CUS-020',
      'PER-001',
      'DIL-001',
      'ADM-001',
      'ADM-004',
      'DIL-010',
      'OUT-001',
    ]);
    // Categoria própria não é tocada: o lançamento continua apontando para o mesmo código.
    expect(cat('l8')).toBe('c-propria1');

    // l1 e l3 (reembolsáveis ressarcidos) e l9 de OUTRA conta viram recebimento; l5 tem a data mas
    // NÃO é reembolsável — a regra da 0.47.0 já a considerava inexistente.
    const rec = db
      .prepare(
        `SELECT workspace, id, data, valor_centavos AS v, observacao FROM recebimentos_processo ORDER BY id`,
      )
      .all();
    expect(rec).toEqual([
      {
        workspace: 'ws-a',
        id: 'mig-l1',
        data: '2026-09-10',
        v: 10_000,
        observacao: 'Migrado da versão anterior',
      },
      {
        workspace: 'ws-a',
        id: 'mig-l3',
        data: '2026-09-11',
        v: 30_000,
        observacao: 'Migrado da versão anterior',
      },
      {
        workspace: 'ws-b',
        id: 'mig-l9',
        data: '2026-09-13',
        v: 90_000,
        observacao: 'Migrado da versão anterior',
      },
    ]);
    // O histórico mostra a criação de cada recebimento migrado.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM historico_custos WHERE entidade = 'recebimento'",
        )
        .get(),
    ).toMatchObject({ n: 3 });

    // Nada foi apagado: os 9 lançamentos e a coluna antiga seguem lá, intactos.
    expect(db.prepare('SELECT COUNT(*) AS n FROM custos_processo').get()).toMatchObject({
      n: 9,
    });
    expect(
      db.prepare('SELECT ressarcido_em AS r FROM custos_processo WHERE id = ?').get('l1'),
    ).toMatchObject({ r: '2026-09-10' });
    // Defaults seguros nas colunas novas.
    expect(
      db
        .prepare(
          'SELECT pago_por AS p, cancelado_em AS c FROM custos_processo WHERE id = ?',
        )
        .get('l1'),
    ).toMatchObject({ p: 'escritorio', c: null });
    // A subcategoria própria ficou no Grupo 12, com a chave única já prefixada pelo grupo.
    expect(
      db
        .prepare(
          "SELECT grupo, nome_chave AS k FROM categorias_custo WHERE id = 'propria1'",
        )
        .get(),
    ).toMatchObject({ grupo: '12', k: '12:cartorio x' });
    expect(
      db.prepare('SELECT 1 FROM estado WHERE chave = ?').get(MARCA_CUSTOS_048),
    ).toBeDefined();
    db.close();
  });

  it('é idempotente: abrir de novo, ou rodar sem a marca, não duplica recebimentos', () => {
    banco047();
    abrirBanco(caminho).close();

    const db = abrirBanco(caminho);
    expect(migrarCustosPara048(db)).toMatchObject({
      jaFeita: true,
      recebimentosCriados: 0,
    });
    // Marca perdida (restore parcial, por exemplo): a chave derivada do lançamento segura a duplicata.
    db.prepare('DELETE FROM estado WHERE chave = ?').run(MARCA_CUSTOS_048);
    const de_novo = migrarCustosPara048(db);
    expect(de_novo).toMatchObject({
      jaFeita: false,
      recebimentosCriados: 0,
      lancamentosReclassificados: 0,
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM recebimentos_processo').get(),
    ).toMatchObject({ n: 3 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM historico_custos WHERE entidade = 'recebimento'",
        )
        .get(),
    ).toMatchObject({ n: 3 });
    // A chave de unicidade não ganha o prefixo duas vezes.
    expect(
      db
        .prepare("SELECT nome_chave AS k FROM categorias_custo WHERE id = 'propria1'")
        .get(),
    ).toMatchObject({ k: '12:cartorio x' });
    db.close();
  });

  it('relata o que migrou (o número que o relatório da entrega cita)', () => {
    banco047();
    const db = new DatabaseSync(caminho);
    // Cria só o esquema novo por cima, sem migrar, para ler o resultado da função.
    db.close();
    const aberto = abrirBanco(caminho);
    aberto.prepare('DELETE FROM estado WHERE chave = ?').run(MARCA_CUSTOS_048);
    aberto.exec('DELETE FROM recebimentos_processo; DELETE FROM historico_custos;');
    aberto.exec(
      `UPDATE custos_processo SET categoria = CASE id WHEN 'l1' THEN 'custas' WHEN 'l2' THEN 'pericia' ELSE categoria END`,
    );
    const r = migrarCustosPara048(aberto);
    expect(r.recebimentosCriados).toBe(3);
    expect(r.lancamentosReclassificados).toBe(2);
    aberto.close();
  });

  it('banco novo (sem custos) abre migrado e vazio', () => {
    const db = abrirBanco(':memory:');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM recebimentos_processo').get(),
    ).toMatchObject({ n: 0 });
    expect(
      db.prepare('SELECT 1 FROM estado WHERE chave = ?').get(MARCA_CUSTOS_048),
    ).toBeDefined();
    db.close();
  });
});
