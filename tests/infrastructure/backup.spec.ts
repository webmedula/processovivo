import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupFalhouError,
  gerarBackup,
  listarBackups,
} from '../../src/infrastructure/persistencia/backup.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';

describe('backup', () => {
  let pasta: string;
  let banco: string;

  beforeEach(() => {
    pasta = mkdtempSync(join(tmpdir(), 'processovivo-backup-'));
    banco = join(pasta, 'processovivo.db');
    const db = abrirBanco(banco);
    db.prepare(
      `INSERT INTO usuarios (id, email, nome, senha, workspace, criado_em)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('u1', 'ana@a.com.br', 'Ana', 'scrypt$x', 'ws1', new Date().toISOString());
    db.prepare(
      `INSERT INTO acompanhamentos (workspace, numero, criado_em)
       VALUES (?, ?, ?)`,
    ).run('ws1', '03115172220158090051', new Date().toISOString());
    db.close();
  });

  afterEach(() => {
    rmSync(pasta, { recursive: true, force: true });
  });

  it('gera uma cópia que abre e tem os dados', () => {
    const r = gerarBackup({ caminhoBanco: banco });

    expect(r.integro).toBe(true);
    expect(r.bytes).toBeGreaterThan(0);

    // O que importa não é o arquivo existir: é ele ABRIR e ter o conteúdo.
    // Backup que ninguém abriu é suposição, não cópia.
    const copia = new DatabaseSync(r.caminho, { readOnly: true });
    const contas = copia
      .prepare('SELECT COUNT(*) AS n FROM usuarios')
      .get() as unknown as {
      n: number;
    };
    const processos = copia.prepare('SELECT numero FROM acompanhamentos').all() as Array<{
      numero: string;
    }>;

    expect(contas.n).toBe(1);
    expect(processos[0]?.numero).toBe('03115172220158090051');
    copia.close();
  });

  it('copia o que só existe no WAL, e não apenas o arquivo .db', () => {
    // O ponto do VACUUM INTO. Em WAL, uma escrita recente vive no arquivo
    // `-wal` até o checkpoint: copiar o `.db` cru devolveria um arquivo que
    // abre, parece íntegro e está desatualizado — o pior tipo de backup.
    const db = abrirBanco(banco);
    db.prepare(
      `INSERT INTO acompanhamentos (workspace, numero, criado_em)
       VALUES (?, ?, ?)`,
    ).run('ws1', '58189220420268090011', new Date().toISOString());

    // Com o banco AINDA ABERTO e sem checkpoint, tira o backup.
    const r = gerarBackup({ caminhoBanco: banco });
    db.close();

    const copia = new DatabaseSync(r.caminho, { readOnly: true });
    const n = copia
      .prepare('SELECT COUNT(*) AS n FROM acompanhamentos')
      .get() as unknown as {
      n: number;
    };
    expect(n.n).toBe(2);
    copia.close();
  });

  it('mantém apenas as N últimas cópias', () => {
    const base = new Date('2026-09-01T03:00:00.000Z');
    for (let dia = 0; dia < 5; dia++) {
      gerarBackup({
        caminhoBanco: banco,
        manter: 3,
        agora: () => new Date(base.getTime() + dia * 86_400_000),
      });
    }

    const copias = listarBackups(join(pasta, 'backups'));
    expect(copias).toHaveLength(3);
    // A mais nova primeiro: é o que a restauração quer achar sem procurar.
    expect(copias[0]?.arquivo).toContain('2026-09-05');
  });

  it('o nome ordena por texto na mesma ordem do tempo', () => {
    // É o que faz a poda ser um recorte de lista em vez de comparação de datas.
    const a = gerarBackup({
      caminhoBanco: banco,
      agora: () => new Date('2026-09-09T23:00:00.000Z'),
    });
    const b = gerarBackup({
      caminhoBanco: banco,
      agora: () => new Date('2026-09-10T01:00:00.000Z'),
    });
    expect(a.caminho < b.caminho).toBe(true);
  });

  it('recusa e DESCARTA uma cópia que não presta', () => {
    // Simula disco cheio / arquivo truncado: o destino já existe com lixo, e o
    // VACUUM INTO do SQLite recusa sobrescrever.
    const destino = join(pasta, 'backups');
    const r1 = gerarBackup({ caminhoBanco: banco, destino });
    writeFileSync(r1.caminho, 'isto não é um banco');

    // Mesma marca de tempo: tenta escrever no arquivo já existente.
    expect(() =>
      gerarBackup({
        caminhoBanco: banco,
        destino,
        agora: () => new Date(statSync(r1.caminho).mtime),
      }),
    ).toThrow(BackupFalhouError);
  });

  it('NÃO apaga cópia que a poda não criou', () => {
    // Achado de revisão: o filtro era "começa com processovivo- e termina em .db", e
    // isso alcançava o arquivo que o operador guardou à mão antes de uma
    // migração — que ordena antes das automáticas e é justamente o que ele
    // achou importante salvar.
    const destino = join(pasta, 'backups');
    gerarBackup({ caminhoBanco: banco, destino });
    const manual = join(destino, 'processovivo-antes-da-migracao.db');
    copyFileSync(banco, manual);

    for (let dia = 0; dia < 4; dia++) {
      gerarBackup({
        caminhoBanco: banco,
        destino,
        manter: 1,
        agora: () => new Date(Date.UTC(2026, 8, 1 + dia, 3)),
      });
    }

    expect(existsSync(manual)).toBe(true);
    // E ele também não entra na contagem das cópias automáticas.
    expect(listarBackups(destino)).toHaveLength(1);
  });

  it('poda também as cópias com o nome antigo do produto', () => {
    /*
     * O produto se chamava LexFlow até a v0.18.0, e o volume de quem já rodava
     * está cheio de `lexflow-<data>.db`. Se a poda só reconhecesse o nome novo,
     * a pasta passaria a guardar as sete cópias novas MAIS todas as antigas,
     * para sempre — enchendo justamente o volume onde mora o banco.
     */
    const destino = join(pasta, 'backups');
    mkdirSync(destino, { recursive: true });
    for (const dia of ['01', '02', '03']) {
      copyFileSync(banco, join(destino, `lexflow-2026-09-${dia}T03-00-00Z.db`));
    }

    const nova = gerarBackup({
      caminhoBanco: banco,
      destino,
      manter: 2,
      agora: () => new Date('2026-09-10T03:00:00.000Z'),
    });

    // Sobraram a cópia nova e a mais recente das antigas.
    expect(nova.apagados).toEqual([
      'lexflow-2026-09-01T03-00-00Z.db',
      'lexflow-2026-09-02T03-00-00Z.db',
    ]);
    expect(listarBackups(destino).map((c) => c.arquivo)).toEqual([
      basename(nova.caminho),
      'lexflow-2026-09-03T03-00-00Z.db',
    ]);
  });

  it('diz no log QUAIS cópias apagou, não só quantas', () => {
    const destino = join(pasta, 'backups');
    const velha = gerarBackup({
      caminhoBanco: banco,
      destino,
      agora: () => new Date('2026-09-01T03:00:00.000Z'),
    });
    const nova = gerarBackup({
      caminhoBanco: banco,
      destino,
      manter: 1,
      agora: () => new Date('2026-09-02T03:00:00.000Z'),
    });

    // "apagados: 1" não deixa ninguém descobrir DEPOIS qual cópia sumiu — e é
    // na restauração que a pergunta aparece.
    expect(nova.apagados).toEqual([basename(velha.caminho)]);
  });

  it('a cópia não é legível por qualquer um', () => {
    // O arquivo é o banco inteiro: hashes de senha, hashes de token de sessão e
    // o e-mail de todos os assinantes. O `VACUUM INTO` cria com a umask do
    // processo, que em contêiner costuma dar 0644.
    const destino = join(pasta, 'backups');
    const r = gerarBackup({ caminhoBanco: banco, destino });

    expect(statSync(r.caminho).mode & 0o777).toBe(0o600);
    expect(statSync(destino).mode & 0o777).toBe(0o700);
  });

  it('não tenta copiar banco em memória', () => {
    expect(() => gerarBackup({ caminhoBanco: ':memory:' })).toThrow(BackupFalhouError);
  });

  it('listar devolve vazio quando ainda não há backup nenhum', () => {
    expect(listarBackups(join(pasta, 'nao-existe'))).toEqual([]);
  });

  /**
   * O teste que justifica todos os outros.
   *
   * Backup não é o arquivo: é a RESTAURAÇÃO. Todo o resto aqui verifica que a
   * cópia foi feita — só este verifica que ela serve para voltar a operar. Um
   * procedimento de restauração que ninguém executou é um palpite, e a hora de
   * descobrir que ele não funciona não pode ser a hora em que o banco sumiu.
   *
   * O roteiro executado aqui é exatamente o que está escrito no runbook:
   * parar o serviço, apagar o banco e os arquivos `-wal`/`-shm`, copiar a
   * cópia por cima com o nome do banco, subir de novo.
   */
  it('restaurar por cima do banco perdido devolve o sistema funcionando', () => {
    // Uma escrita que ainda está no WAL na hora do backup: se a restauração
    // perdesse isto, o advogado voltaria a operar sem o último processo que
    // mandou acompanhar — e sem nada indicando a falta.
    const vivo = abrirBanco(banco);
    vivo
      .prepare(
        `INSERT INTO acompanhamentos (workspace, numero, criado_em)
       VALUES (?, ?, ?)`,
      )
      .run('ws1', '00008323520184013202', new Date().toISOString());

    const copia = gerarBackup({ caminhoBanco: banco });
    vivo.close();

    // O desastre: o volume se foi, e com ele o banco e os arquivos do WAL.
    for (const sufixo of ['', '-wal', '-shm']) {
      rmSync(banco + sufixo, { force: true });
    }

    // A restauração, como está no runbook: a cópia vira o banco.
    copyFileSync(copia.caminho, banco);

    // E o sistema sobe pelo MESMO caminho de produção — `abrirBanco`, com as
    // migrações e a retrocarga. Abrir com `DatabaseSync` cru provaria que o
    // arquivo tem dados, não que o Processo Vivo torna a funcionar em cima dele.
    const restaurado = abrirBanco(banco);
    const contas = restaurado
      .prepare('SELECT email, workspace FROM usuarios')
      .all() as Array<{ email: string; workspace: string }>;
    const processos = restaurado
      .prepare('SELECT numero FROM acompanhamentos ORDER BY numero')
      .all() as Array<{ numero: string }>;

    expect(contas).toHaveLength(1);
    expect(contas[0]?.email).toBe('ana@a.com.br');
    // O workspace precisa vir IGUAL: ele é o que amarra a conta à carteira
    // dela. Restaurar com workspace diferente devolveria um advogado que
    // entra e encontra o ambiente vazio, com os dados dele intactos ao lado,
    // invisíveis.
    expect(contas[0]?.workspace).toBe('ws1');
    expect(processos.map((p) => p.numero)).toEqual([
      '00008323520184013202',
      '03115172220158090051',
    ]);

    // E aceita escrita nova: um banco restaurado somente legível seria um
    // sistema no ar que recusa cada acompanhamento sem ninguém entender.
    restaurado
      .prepare(
        `INSERT INTO acompanhamentos (workspace, numero, criado_em)
         VALUES (?, ?, ?)`,
      )
      .run('ws1', '00000010720228260100', new Date().toISOString());
    restaurado.close();
  });
});
