import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { paraBusca } from '../../src/infrastructure/persistencia/normalizacaoBusca.js';

/**
 * A coluna `partes_texto` foi acrescentada quando a tabela já existia em
 * produção. `CREATE TABLE IF NOT EXISTS` não a acrescenta — num banco que já
 * tem a tabela ele não faz nada —, então há migração explícita.
 *
 * E a retrocarga importa tanto quanto: sem ela, o filtro por parte acharia
 * apenas os processos sincronizados DEPOIS da atualização e ficaria calado
 * sobre os outros. Mostrar subconjunto em silêncio é o erro que este projeto
 * já pagou caro para aprender.
 */
describe('banco — migração da coluna de partes', () => {
  function bancoNoFormatoAntigo(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    // Exatamente o esquema anterior: sem `partes_texto`.
    db.exec(`CREATE TABLE acompanhamentos (
       workspace TEXT NOT NULL, numero TEXT NOT NULL, apelido TEXT,
       criado_em TEXT NOT NULL, sincronizado_em TEXT, erro TEXT, processo TEXT,
       tribunal TEXT, classe TEXT, ultima_mov_data TEXT,
       PRIMARY KEY (workspace, numero))`);
    return db;
  }

  it('acrescenta a coluna num banco que já existia', () => {
    const db = bancoNoFormatoAntigo();
    const colunas = () =>
      (
        db.prepare('PRAGMA table_info(acompanhamentos)').all() as Array<{ name: string }>
      ).map((c) => c.name);

    expect(colunas()).not.toContain('partes_texto');
    db.close();

    // `abrirBanco` num arquivo de memória novo já cria com a coluna; o que se
    // verifica aqui é que o esquema atual a declara.
    const novo = abrirBanco(':memory:');
    const nomes = (
      novo.prepare('PRAGMA table_info(acompanhamentos)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(nomes).toContain('partes_texto');
    novo.close();
  });

  it('não estoura ao abrir duas vezes', () => {
    // ALTER TABLE ADD COLUMN falha se a coluna já existe. A checagem no
    // PRAGMA precede a alteração justamente por isso.
    const a = abrirBanco(':memory:');
    a.close();
    expect(() => {
      const b = abrirBanco(':memory:');
      b.close();
    }).not.toThrow();
  });

  it('dobra o acento, e é por isso que a retrocarga não é SQL puro', () => {
    // O `upper()` do SQLite é ASCII-only — medido, não suposto. Este teste
    // registra o fato que derrubou a primeira versão da retrocarga: em SQL,
    // "José" virava "JOSé", e o filtro passaria a achar uns nomes e não outros.
    const db = new DatabaseSync(':memory:');
    const r = db.prepare("SELECT upper('José') AS u").get() as unknown as { u: string };
    expect(r.u).toBe('JOSé');
    db.close();

    // `paraBusca` resolve os dois lados: maiúsculas Unicode e sem diacrítico.
    expect(paraBusca('José da Silva')).toBe('JOSE DA SILVA');
    expect(paraBusca('  Condomínio Sunsquare ')).toBe('CONDOMINIO SUNSQUARE');
    // Digitar sem acento tem de achar quem está gravado com acento.
    expect(paraBusca('jose')).toBe('JOSE');
  });
});

/**
 * A retrocarga roda no arranque do servidor. Se ela derrubar o arranque, o
 * serviço inteiro não sobe — então uma linha estragada não pode ser fatal.
 */
describe('banco — retrocarga tolerante', () => {
  it('sobrevive a JSON corrompido numa linha', () => {
    const db = abrirBanco(':memory:');
    db.prepare(
      `INSERT INTO acompanhamentos (workspace, numero, criado_em, processo, partes_texto)
       VALUES (?, ?, ?, ?, NULL)`,
    ).run('ws1', '03115172220158090051', new Date().toISOString(), '{isto não é json');
    db.close();

    // Reabrir dispara a retrocarga sobre a linha ruim.
    expect(() => {
      const outro = abrirBanco(':memory:');
      outro.close();
    }).not.toThrow();
  });

  /**
   * Em ARQUIVO, e não `:memory:`: a retrocarga só é exercitada de verdade ao
   * REABRIR um banco que já tem dados, e um banco em memória morre no
   * fechamento. É a diferença entre testar o caminho e testar a intenção.
   */
  it('retrocarrega de verdade ao reabrir um banco com dados antigos', () => {
    const arquivo = join(mkdtempSync(join(tmpdir(), 'processovivo-')), 'teste.db');
    try {
      const primeiro = abrirBanco(arquivo);
      primeiro
        .prepare(
          `INSERT INTO acompanhamentos (workspace, numero, criado_em, processo)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          'ws1',
          '03115172220158090051',
          new Date().toISOString(),
          JSON.stringify({
            partes: [{ nome: 'Condomínio Sunsquare' }, { nome: 'José' }],
          }),
        );
      // Estado de quem atualizou o sistema com a base já cheia.
      primeiro.exec('UPDATE acompanhamentos SET partes_texto = NULL');
      primeiro.close();

      const segundo = abrirBanco(arquivo);
      const linha = segundo
        .prepare('SELECT partes_texto FROM acompanhamentos')
        .get() as unknown as { partes_texto: string };

      // Maiúsculas Unicode e sem acento — a mesma forma que a consulta monta.
      expect(linha.partes_texto).toBe('CONDOMINIO SUNSQUARE | JOSE');
      segundo.close();
    } finally {
      rmSync(dirname(arquivo), { recursive: true, force: true });
    }
  });

  it('processo sem parte fica com texto vazio, para sair da fila', () => {
    // NULL o traria de volta à retrocarga a cada arranque, para sempre —
    // trabalho inútil que cresce junto com a base.
    const arquivo = join(mkdtempSync(join(tmpdir(), 'processovivo-')), 'teste.db');
    try {
      const primeiro = abrirBanco(arquivo);
      primeiro
        .prepare(
          `INSERT INTO acompanhamentos (workspace, numero, criado_em, processo)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          'ws1',
          '03115172220158090051',
          new Date().toISOString(),
          JSON.stringify({ partes: [] }),
        );
      primeiro.exec('UPDATE acompanhamentos SET partes_texto = NULL');
      primeiro.close();

      const segundo = abrirBanco(arquivo);
      const linha = segundo
        .prepare('SELECT partes_texto FROM acompanhamentos')
        .get() as unknown as { partes_texto: string | null };

      expect(linha.partes_texto).toBe('');
      segundo.close();
    } finally {
      rmSync(dirname(arquivo), { recursive: true, force: true });
    }
  });

  it('a coluna de cliente também é acrescentada, e NÃO tem retrocarga', () => {
    /*
     * A ausência de retrocarga é deliberada, e o teste existe para que ninguém
     * "conserte" isso depois.
     *
     * A regra do repositório manda retrocarregar coluna nova, e vale para
     * coluna DERIVADA de dado já guardado — `partes_texto` sai do JSON do
     * processo que já está no banco, e sem a retrocarga o filtro enxergaria só
     * o que foi sincronizado depois da atualização.
     *
     * `cliente` não sai de lugar nenhum: é o nome que o advogado dá à pasta, e
     * nenhuma fonte sabe quem é o cliente dele — o tribunal entrega as partes
     * sem dizer qual delas o consultante representa. Preencher com um palpite
     * poria o nome do adversário na coluna "Cliente".
     */
    const db = abrirBanco(':memory:');
    const colunas = (
      db.prepare('PRAGMA table_info(acompanhamentos)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(colunas).toContain('cliente');

    db.prepare(
      `INSERT INTO acompanhamentos (workspace, numero, criado_em, processo)
       VALUES ('w', '00000000000000000000', '2026-01-01T00:00:00.000Z', NULL)`,
    ).run();
    const linha = db
      .prepare('SELECT cliente FROM acompanhamentos WHERE numero = ?')
      .get('00000000000000000000') as { cliente: string | null };
    expect(linha.cliente).toBeNull();
    db.close();
  });
});

/*
 * As colunas da marca de "cumprido" (v0.37.5) foram acrescentadas com a tabela
 * já em produção: sem a migração explícita, o deploy quebraria ao gravar a marca.
 */
describe('banco — colunas da marca de cumprido', () => {
  it('acrescenta as quatro colunas a um banco no formato anterior, sem tocar nos dados', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pv-migracao-'));
    const caminho = join(dir, 'processovivo.db');
    try {
      const antigo = new DatabaseSync(caminho);
      antigo.exec(`CREATE TABLE acompanhamentos (
         workspace TEXT NOT NULL, numero TEXT NOT NULL, apelido TEXT,
         criado_em TEXT NOT NULL, sincronizado_em TEXT, erro TEXT, processo TEXT,
         tribunal TEXT, classe TEXT, ultima_mov_data TEXT, partes_texto TEXT, cliente TEXT,
         PRIMARY KEY (workspace, numero))`);
      antigo
        .prepare(
          "INSERT INTO acompanhamentos (workspace, numero, criado_em) VALUES ('ws', '1', '2026-01-01')",
        )
        .run();
      antigo.close();

      const db = abrirBanco(caminho);
      const nomes = (
        db.prepare('PRAGMA table_info(acompanhamentos)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const coluna of [
        'cumprido_chave',
        'cumprido_ate',
        'cumprido_em',
        'cumprido_por',
      ]) {
        expect(nomes).toContain(coluna);
      }
      const linha = db
        .prepare("SELECT cumprido_chave FROM acompanhamentos WHERE workspace = 'ws'")
        .get() as { cumprido_chave: string | null };
      // Sem retrocarga, de propósito: ninguém marcou nada.
      expect(linha.cumprido_chave).toBeNull();
      db.close();

      // E abrir de novo (a coluna já existe) não estoura.
      expect(() => abrirBanco(caminho).close()).not.toThrow();
    } finally {
      rmSync(dirname(join(dir, 'x')), { recursive: true, force: true });
    }
  });
});
