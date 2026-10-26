import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDeInstrucoesDeIaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeInstrucoesDeIaSqlite.js';
import {
  RepositorioDeModelosDeIaSqlite,
  RepositorioDeTestesDeModeloSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDeModelosDeIaSqlite.js';
import { RepositorioDeConfigDeIaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';

/*
 * Migração ADITIVA da Fase C (v0.61.0): uma tabela nova (`ia_instrucoes`) e colunas novas em tabelas da Fase
 * A/B que já existem em produção. Nada removido nem renomeado; a versão anterior do app continua lendo o banco
 * novo; rodar duas vezes não muda nada; ler a tabela ausente cai no padrão.
 */

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

function bancoDaVersaoAnterior(): string {
  const pasta = mkdtempSync(join(tmpdir(), 'pv-instrucoes-'));
  pastas.push(pasta);
  const arquivo = join(pasta, 'p.db');
  const db = new DatabaseSync(arquivo);
  // O esquema da v0.60.0: sem `instrucoes_*` em ia_config nem `tipo`/`instrucao_versao` em ia_testes_modelo.
  db.exec(`CREATE TABLE ia_config (
     chave TEXT PRIMARY KEY, ligada INTEGER, teto_dia_conta INTEGER, teto_dia_global INTEGER,
     alerta_custo_dia_usd REAL, atualizado_em TEXT NOT NULL,
     modelo TEXT, modelo_anterior TEXT, modelo_desde TEXT)`);
  db.exec(`CREATE TABLE ia_alteracoes (
     id INTEGER PRIMARY KEY AUTOINCREMENT, em TEXT NOT NULL, autor TEXT NOT NULL, funcao TEXT NOT NULL,
     tipo TEXT NOT NULL, valor_anterior TEXT NOT NULL, valor_novo TEXT NOT NULL,
     teste_id TEXT, aprovacao TEXT)`);
  db.exec(`CREATE TABLE ia_testes_modelo (
     id TEXT PRIMARY KEY, funcao TEXT NOT NULL, candidato TEXT NOT NULL, referencia TEXT NOT NULL,
     estado TEXT NOT NULL, autor TEXT NOT NULL, criado_em TEXT NOT NULL, iniciado_em TEXT, terminado_em TEXT,
     chamadas_previstas INTEGER NOT NULL DEFAULT 0, chamadas_feitas INTEGER NOT NULL DEFAULT 0,
     estimativa_usd REAL, gasto_usd REAL, metricas_candidato TEXT, metricas_referencia TEXT, veredito TEXT,
     bloqueios TEXT NOT NULL DEFAULT '[]', ressalvas TEXT NOT NULL DEFAULT '[]', falha TEXT)`);
  db.prepare(
    "INSERT INTO ia_config (chave, ligada, teto_dia_conta, atualizado_em, modelo) VALUES ('ato', 0, 50, '2026-10-01T00:00:00.000Z', 'fab/novo')",
  ).run();
  db.prepare(
    `INSERT INTO ia_testes_modelo (id, funcao, candidato, referencia, estado, autor, criado_em)
     VALUES ('t-antigo', 'ato', 'fab/novo', 'fab/antigo', 'concluido', 'ab12cd34', '2026-10-20T00:00:00.000Z')`,
  ).run();
  db.close();
  return arquivo;
}

const colunas = (db: DatabaseSync, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );

describe('banco da versão anterior (v0.60.0)', () => {
  it('só acrescenta: tabela e colunas novas; a Fase A e a Fase B ficam como estavam', () => {
    const db = abrirBanco(bancoDaVersaoAnterior());
    expect(colunas(db, 'ia_instrucoes')).toEqual([
      'funcao',
      'versao',
      'texto',
      'autor',
      'criado_em',
      'estado',
      'observacao',
      'publicado_em',
      'publicado_por',
    ]);
    expect(colunas(db, 'ia_config')).toEqual(
      expect.arrayContaining(['modelo', 'instrucoes_versao', 'instrucoes_anterior']),
    );
    expect(colunas(db, 'ia_testes_modelo')).toEqual(
      expect.arrayContaining(['metricas_candidato', 'tipo', 'instrucao_versao']),
    );
    expect(new RepositorioDeConfigDeIaSqlite(db).ler().funcoes.ato).toEqual({
      ligada: false,
      tetoPorConta: 50,
    });
    expect(new RepositorioDeModelosDeIaSqlite(db).ler().ato.modelo).toBe('fab/novo');
    // O teste antigo continua sendo um teste de MODELO (tipo ausente = modelo) e o único.
    const t = new RepositorioDeTestesDeModeloSqlite(db).ultimoDaFuncao('ato');
    expect(t?.id).toBe('t-antigo');
    expect(t?.tipo).toBe('modelo');
    expect(
      new RepositorioDeTestesDeModeloSqlite(db).ultimoDeInstrucoes('ato'),
    ).toBeUndefined();
    // Sem retrocarga: nenhuma instrução publicada.
    expect(new RepositorioDeInstrucoesDeIaSqlite(db).emProducao('ato')).toEqual({
      versao: 0,
      texto: '',
      anterior: 0,
    });
    db.close();
  });

  it('rodar duas vezes não falha nem duplica nada', () => {
    const arquivo = bancoDaVersaoAnterior();
    abrirBanco(arquivo).close();
    const db = abrirBanco(arquivo);
    for (const t of ['ia_config', 'ia_testes_modelo', 'ia_instrucoes']) {
      const nomes = colunas(db, t);
      expect(new Set(nomes).size).toBe(nomes.length);
    }
    db.close();
  });

  it('a versão anterior do app, contra o banco novo, continua funcionando (rollback do deploy)', () => {
    const arquivo = bancoDaVersaoAnterior();
    const db = abrirBanco(arquivo);
    const agora = new Date('2026-10-26T12:00:00.000Z');
    const r = new RepositorioDeInstrucoesDeIaSqlite(db);
    const g = r.salvarRascunho('ato', 'Destaque o prazo.', '', 'ab12cd34', agora);
    r.publicar('ato', g.versao, 'ab12cd34', agora, {
      em: agora,
      autor: 'ab12cd34',
      funcao: 'ato',
      tipo: 'instrucoes_publicadas',
      anterior: 'e0',
      novo: 'e1',
    });
    db.close();
    // O SQL da v0.60.0, ao pé da letra: nada dele toca nas colunas novas.
    const velho = new DatabaseSync(arquivo);
    expect(
      velho
        .prepare(
          'SELECT chave, ligada, teto_dia_conta, modelo, modelo_anterior FROM ia_config',
        )
        .all(),
    ).toHaveLength(1);
    velho
      .prepare(
        `INSERT INTO ia_config (chave, modelo, modelo_anterior, modelo_desde, atualizado_em)
         VALUES ('resumo', 'a', 'b', 'x', 'x')
         ON CONFLICT(chave) DO UPDATE SET modelo = excluded.modelo, atualizado_em = excluded.atualizado_em`,
      )
      .run();
    velho
      .prepare(
        `INSERT INTO ia_testes_modelo (id, funcao, candidato, referencia, estado, autor, criado_em, chamadas_previstas, chamadas_feitas, estimativa_usd, bloqueios, ressalvas)
         VALUES ('t2','ato','a','b','na_fila','x','x',1,0,NULL,'[]','[]')`,
      )
      .run();
    velho.close();
  });

  it('a Fase C não mexe no modelo nem nos tetos, e a Fase A/B não apagam a instrução publicada', () => {
    const db = abrirBanco(':memory:');
    const agora = new Date('2026-10-26T12:00:00.000Z');
    const modelos = new RepositorioDeModelosDeIaSqlite(db);
    modelos.publicar('ato', 'fab/novo', 'fab/antigo', agora, {
      em: agora,
      autor: 'x',
      funcao: 'ato',
      tipo: 'modelo_publicado',
      anterior: 'a',
      novo: 'b',
    });
    const r = new RepositorioDeInstrucoesDeIaSqlite(db);
    const g = r.salvarRascunho('ato', 'Texto', '', 'x', agora);
    r.publicar('ato', g.versao, 'x', agora, {
      em: agora,
      autor: 'x',
      funcao: 'ato',
      tipo: 'instrucoes_publicadas',
      anterior: 'e0',
      novo: 'e1',
    });
    expect(modelos.ler().ato.modelo).toBe('fab/novo');
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
    modelos.publicar('ato', null, null, agora, {
      em: agora,
      autor: 'x',
      funcao: 'ato',
      tipo: 'modelo_revertido',
      anterior: 'b',
      novo: 'a',
    });
    expect(r.emProducao('ato')).toMatchObject({ versao: 1, texto: 'Texto' });
    expect(a.ler().funcoes.ato).toEqual({ ligada: false, tetoPorConta: 7 });
    db.close();
  });

  it('o registro de mudanças guarda a edição de antes e de depois, e o TEXTO fica só em ia_instrucoes', () => {
    const db = abrirBanco(':memory:');
    const agora = new Date('2026-10-26T12:00:00.000Z');
    const r = new RepositorioDeInstrucoesDeIaSqlite(db);
    const g = r.salvarRascunho(
      'resumo',
      'Instrução sintética de estilo.',
      'obs',
      'ab12cd34',
      agora,
    );
    r.publicar('resumo', g.versao, 'ab12cd34', agora, {
      em: agora,
      autor: 'ab12cd34',
      funcao: 'resumo',
      tipo: 'instrucoes_publicadas',
      anterior: 'e0',
      novo: 'e1',
    });
    const reg = new RepositorioDeConfigDeIaSqlite(db).alteracoes(5)[0];
    expect(reg).toMatchObject({
      tipo: 'instrucoes_publicadas',
      funcao: 'resumo',
      anterior: 'e0',
      novo: 'e1',
    });
    expect(JSON.stringify(db.prepare('SELECT * FROM ia_alteracoes').all())).not.toContain(
      'Instrução sintética',
    );
    db.close();
  });
});
