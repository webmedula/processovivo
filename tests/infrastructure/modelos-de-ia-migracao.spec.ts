import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDeModelosDeIaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositoriosDeModelosDeIaSqlite.js';
import { RepositorioDeConfigDeIaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';

/*
 * Migração ADITIVA da Fase B (v0.60.0): colunas novas em tabelas da Fase A que já existem em produção,
 * uma tabela nova, nada removido nem renomeado, e a versão anterior do app continua lendo o banco novo.
 */

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

function bancoDaVersaoAnterior(): string {
  const pasta = mkdtempSync(join(tmpdir(), 'pv-modelos-'));
  pastas.push(pasta);
  const arquivo = join(pasta, 'p.db');
  const db = new DatabaseSync(arquivo);
  // Exatamente o esquema da v0.58.0/0.59.0: sem as colunas da Fase B.
  db.exec(`CREATE TABLE ia_config (
     chave TEXT PRIMARY KEY, ligada INTEGER, teto_dia_conta INTEGER, teto_dia_global INTEGER,
     alerta_custo_dia_usd REAL, atualizado_em TEXT NOT NULL)`);
  db.exec(`CREATE TABLE ia_alteracoes (
     id INTEGER PRIMARY KEY AUTOINCREMENT, em TEXT NOT NULL, autor TEXT NOT NULL, funcao TEXT NOT NULL,
     tipo TEXT NOT NULL, valor_anterior TEXT NOT NULL, valor_novo TEXT NOT NULL)`);
  db.prepare(
    "INSERT INTO ia_config VALUES ('ato', 0, 50, NULL, NULL, '2026-10-01T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO ia_alteracoes (em, autor, funcao, tipo, valor_anterior, valor_novo) VALUES ('2026-10-01T00:00:00.000Z','ab12cd34','ato','ligada','ligada','desligada')",
  ).run();
  db.close();
  return arquivo;
}

const colunas = (db: DatabaseSync, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );

describe('banco da versão anterior', () => {
  it('só acrescenta: colunas novas, tabela nova, e os dados da Fase A ficam como estavam', () => {
    const arquivo = bancoDaVersaoAnterior();
    const db = abrirBanco(arquivo);
    expect(colunas(db, 'ia_config')).toEqual(
      expect.arrayContaining([
        'chave',
        'ligada',
        'teto_dia_conta',
        'modelo',
        'modelo_anterior',
        'modelo_desde',
      ]),
    );
    expect(colunas(db, 'ia_alteracoes')).toEqual(
      expect.arrayContaining(['valor_anterior', 'teste_id', 'aprovacao']),
    );
    expect(colunas(db, 'ia_testes_modelo')).toContain('metricas_candidato');
    const cfg = new RepositorioDeConfigDeIaSqlite(db).ler();
    expect(cfg.funcoes.ato).toEqual({ ligada: false, tetoPorConta: 50 });
    expect(new RepositorioDeModelosDeIaSqlite(db).ler().ato).toEqual({
      modelo: null,
      anterior: null,
      desde: null,
    });
    expect(new RepositorioDeConfigDeIaSqlite(db).alteracoes(5)).toHaveLength(1);
    db.close();
  });

  it('rodar duas vezes não falha nem duplica nada', () => {
    const arquivo = bancoDaVersaoAnterior();
    abrirBanco(arquivo).close();
    const db = abrirBanco(arquivo);
    const nomes = colunas(db, 'ia_config');
    expect(new Set(nomes).size).toBe(nomes.length);
    db.close();
  });

  it('a versão anterior do app, contra o banco novo, continua funcionando (rollback do deploy)', () => {
    const arquivo = bancoDaVersaoAnterior();
    const db = abrirBanco(arquivo);
    new RepositorioDeModelosDeIaSqlite(db).publicar(
      'ato',
      'fab/novo',
      'fab/antigo',
      new Date('2026-10-26T12:00:00.000Z'),
      {
        em: new Date(),
        autor: 'x',
        funcao: 'ato',
        tipo: 'modelo_publicado',
        anterior: 'a',
        novo: 'b',
      },
    );
    db.close();
    // O SQL da v0.58.0, ao pé da letra:
    const velho = new DatabaseSync(arquivo);
    expect(
      velho
        .prepare(
          'SELECT chave, ligada, teto_dia_conta, teto_dia_global, alerta_custo_dia_usd FROM ia_config',
        )
        .all(),
    ).toHaveLength(1);
    velho
      .prepare(
        `INSERT INTO ia_config (chave, ligada, teto_dia_conta, teto_dia_global, alerta_custo_dia_usd, atualizado_em)
         VALUES ('resumo', 1, NULL, NULL, NULL, 'x')
         ON CONFLICT(chave) DO UPDATE SET ligada = excluded.ligada, atualizado_em = excluded.atualizado_em`,
      )
      .run();
    velho
      .prepare(
        'INSERT INTO ia_alteracoes (em, autor, funcao, tipo, valor_anterior, valor_novo) VALUES (?,?,?,?,?,?)',
      )
      .run('x', 'y', 'ato', 'ligada', 'a', 'b');
    velho.close();
  });

  it('a Fase A grava ligado/tetos sem apagar o modelo, e a Fase B grava o modelo sem apagar os tetos', () => {
    const db = abrirBanco(':memory:');
    const modelos = new RepositorioDeModelosDeIaSqlite(db);
    const agora = new Date('2026-10-26T12:00:00.000Z');
    modelos.publicar('ato', 'fab/novo', 'fab/antigo', agora, {
      em: agora,
      autor: 'x',
      funcao: 'ato',
      tipo: 'modelo_publicado',
      anterior: 'fab/antigo',
      novo: 'fab/novo',
      testeId: 't1',
    });
    const a = new RepositorioDeConfigDeIaSqlite(db);
    const cfg = a.ler();
    a.gravar(
      { ...cfg, funcoes: { ...cfg.funcoes, ato: { ligada: false, tetoPorConta: 7 } } },
      {
        em: agora,
        autor: 'x',
        funcao: 'ato',
        tipo: 'ligada',
        anterior: 'ligada',
        novo: 'desligada',
      },
      agora,
    );
    expect(modelos.ler().ato).toEqual({
      modelo: 'fab/novo',
      anterior: 'fab/antigo',
      desde: agora,
    });
    modelos.publicar('ato', null, null, agora, {
      em: agora,
      autor: 'x',
      funcao: 'ato',
      tipo: 'modelo_revertido',
      anterior: 'fab/novo',
      novo: 'fab/antigo',
    });
    expect(a.ler().funcoes.ato).toEqual({ ligada: false, tetoPorConta: 7 });
    db.close();
  });

  it('o registro de mudanças guarda o id do teste e a aprovação, e só acrescenta', () => {
    const db = abrirBanco(':memory:');
    const modelos = new RepositorioDeModelosDeIaSqlite(db);
    const agora = new Date('2026-10-26T12:00:00.000Z');
    modelos.publicar('peca', 'fab/novo', 'fab/antigo', agora, {
      em: agora,
      autor: 'ab12cd34',
      funcao: 'peca',
      tipo: 'modelo_publicado',
      anterior: 'fab/antigo',
      novo: 'fab/novo',
      testeId: 'teste-1',
      aprovacao: 'custo_aceitavel: ok',
    });
    expect(new RepositorioDeConfigDeIaSqlite(db).alteracoes(5)[0]).toMatchObject({
      tipo: 'modelo_publicado',
      funcao: 'peca',
      testeId: 'teste-1',
      aprovacao: 'custo_aceitavel: ok',
    });
    db.close();
  });
});
