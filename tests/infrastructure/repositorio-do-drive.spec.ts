import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDoDriveSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDoDriveSqlite.js';
import { Cofre } from '../../src/infrastructure/seguranca/cofre.js';
import type { AutorizacaoDoDestino } from '../../src/domain/entities/DestinoDePecas.js';
import type { Logger } from '../../src/domain/ports/Logger.js';
import { TOKEN_DE_ACESSO, TOKEN_DE_RENOVACAO } from '../helpers/transporteDoDrive.js';

const AGORA = new Date('2026-10-14T12:00:00.000Z');
const AUTORIZACAO: AutorizacaoDoDestino = {
  tokenDeAcesso: TOKEN_DE_ACESSO,
  tokenDeRenovacao: TOKEN_DE_RENOVACAO,
  expiraEm: new Date('2026-10-14T13:00:00.000Z'),
};
const RAIZ = { id: 'raiz-1', link: 'https://drive.google.com/drive/folders/raiz-1' };

function montar(cofre = Cofre.comChaveBase64(Cofre.gerarChaveBase64()), logger?: Logger) {
  const db = abrirBanco(':memory:');
  return { db, cofre, repo: new RepositorioDoDriveSqlite(db, cofre, logger) };
}

describe('RepositorioDoDriveSqlite', () => {
  it('guarda os tokens CIFRADOS: nenhuma coluna do banco contém o token em claro', async () => {
    const { db, repo } = montar();
    await repo.conectar('ws-a', RAIZ, AUTORIZACAO, AGORA);
    const linhas = db.prepare('SELECT * FROM conexoes_drive').all();
    expect(JSON.stringify(linhas)).not.toContain(TOKEN_DE_ACESSO);
    expect(JSON.stringify(linhas)).not.toContain(TOKEN_DE_RENOVACAO);
    expect(
      (linhas[0] as { tokens_cifrados: string }).tokens_cifrados.startsWith('v1.'),
    ).toBe(true);
    expect(await repo.autorizacao('ws-a')).toEqual(AUTORIZACAO);
  });

  it('não há coluna de e-mail nem de nome da conta Google', () => {
    const { db } = montar();
    const colunas = (
      db.prepare('PRAGMA table_info(conexoes_drive)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(colunas.sort()).toEqual(
      [
        'conectada_em',
        'estado',
        'motivo_do_ultimo_erro',
        'pasta_raiz_id',
        'pasta_raiz_link',
        'tokens_cifrados',
        'verificada_em',
        'workspace',
      ].sort(),
    );
  });

  it('isola por workspace: o A não vê a conexão, as pastas nem as peças do B', async () => {
    const { repo } = montar();
    await repo.conectar('ws-a', RAIZ, AUTORIZACAO, AGORA);
    await repo.guardarPastaDoProcesso({
      workspace: 'ws-a',
      numeroProcesso: '999',
      pasta: { id: 's', link: 'l' },
    });
    await repo.guardarPeca({
      workspace: 'ws-a',
      numeroProcesso: '999',
      pecaId: 'p1',
      arquivoId: 'arq',
      hash: 'h',
      nome: 'n.pdf',
      estado: 'no_destino',
      enviadaEm: AGORA,
      atualizadaEm: undefined,
    });
    expect(await repo.conexao('ws-b')).toBeUndefined();
    expect(await repo.autorizacao('ws-b')).toBeUndefined();
    expect(await repo.pastaDoProcesso('ws-b', '999')).toBeUndefined();
    expect(await repo.peca('ws-b', '999', 'p1')).toBeUndefined();
    expect(await repo.doProcesso('ws-b', '999')).toEqual([]);
    expect((await repo.peca('ws-a', '999', 'p1'))?.arquivoId).toBe('arq');
  });

  it('desconectar APAGA os tokens, guarda a pasta raiz e marca o histórico como desconectado', async () => {
    const { db, repo } = montar();
    await repo.conectar('ws-a', RAIZ, AUTORIZACAO, AGORA);
    await repo.guardarPeca({
      workspace: 'ws-a',
      numeroProcesso: '999',
      pecaId: 'p1',
      arquivoId: 'arq',
      hash: 'h',
      nome: 'n.pdf',
      estado: 'no_destino',
      enviadaEm: AGORA,
      atualizadaEm: undefined,
    });
    await repo.desconectar('ws-a', AGORA);
    const c = await repo.conexao('ws-a');
    expect(c?.estado).toBe('desconectado');
    expect(c?.pastaRaiz?.id).toBe('raiz-1'); // reconectar reaproveita a pasta
    expect(await repo.autorizacao('ws-a')).toBeUndefined();
    expect(
      (
        db.prepare('SELECT tokens_cifrados FROM conexoes_drive').get() as {
          tokens_cifrados: unknown;
        }
      ).tokens_cifrados,
    ).toBeNull();
    expect((await repo.peca('ws-a', '999', 'p1'))?.estado).toBe('desconectada');
  });

  it('reconectar reabilita o histórico e zera o erro', async () => {
    const { repo } = montar();
    await repo.conectar('ws-a', RAIZ, AUTORIZACAO, AGORA);
    await repo.guardarPeca({
      workspace: 'ws-a',
      numeroProcesso: '999',
      pecaId: 'p1',
      arquivoId: 'arq',
      hash: 'h',
      nome: 'n.pdf',
      estado: 'no_destino',
      enviadaEm: AGORA,
      atualizadaEm: undefined,
    });
    await repo.marcarEstado('ws-a', 'precisa_reconectar', 'autorizacao_revogada', AGORA);
    await repo.desconectar('ws-a', AGORA);
    const c = await repo.conectar('ws-a', RAIZ, AUTORIZACAO, AGORA);
    expect(c.estado).toBe('conectado');
    expect(c.motivoDoUltimoErro).toBeUndefined();
    expect((await repo.peca('ws-a', '999', 'p1'))?.estado).toBe('no_destino');
  });

  it('renovação atrasada NÃO ressuscita a autorização depois do desconectar', async () => {
    const { repo } = montar();
    await repo.conectar('ws-a', RAIZ, AUTORIZACAO, AGORA);
    await repo.desconectar('ws-a', AGORA);
    await repo.salvarAutorizacao('ws-a', { ...AUTORIZACAO, tokenDeAcesso: 'novo' });
    expect(await repo.autorizacao('ws-a')).toBeUndefined();
  });

  it('chave do cofre trocada: autorização ilegível vira "sem autorização", e o log não traz o token', async () => {
    const mensagens: string[] = [];
    const logger: Logger = {
      debug: (m, c) => void mensagens.push(m + JSON.stringify(c ?? {})),
      info: (m, c) => void mensagens.push(m + JSON.stringify(c ?? {})),
      warn: (m, c) => void mensagens.push(m + JSON.stringify(c ?? {})),
      error: (m, c) => void mensagens.push(m + JSON.stringify(c ?? {})),
      child: () => logger,
    };
    const { db, repo } = montar(undefined, logger);
    await repo.conectar('ws-a', RAIZ, AUTORIZACAO, AGORA);
    const outro = new RepositorioDoDriveSqlite(
      db,
      Cofre.comChaveBase64(Cofre.gerarChaveBase64()),
      logger,
    );
    expect(await outro.autorizacao('ws-a')).toBeUndefined();
    expect(mensagens.join('\n')).not.toContain(TOKEN_DE_ACESSO);
    expect(mensagens.join('\n')).not.toContain(TOKEN_DE_RENOVACAO);
    expect(mensagens.length).toBeGreaterThan(0);
  });

  it('trocar a pasta raiz limpa as subpastas (ficavam dentro da antiga)', async () => {
    const { repo } = montar();
    await repo.conectar('ws-a', RAIZ, AUTORIZACAO, AGORA);
    await repo.guardarPastaDoProcesso({
      workspace: 'ws-a',
      numeroProcesso: '999',
      pasta: { id: 's', link: 'l' },
    });
    await repo.atualizarPastaRaiz(
      'ws-a',
      { id: 'raiz-2', link: 'l2' },
      'pasta_raiz_recriada',
    );
    expect(await repo.pastaDoProcesso('ws-a', '999')).toBeUndefined();
    const c = await repo.conexao('ws-a');
    expect(c?.pastaRaiz?.id).toBe('raiz-2');
    expect(c?.motivoDoUltimoErro).toBe('pasta_raiz_recriada');
  });

  it('migração aditiva: um banco de antes da 0.42.0 (sem as tabelas do Drive) ganha as tabelas ao abrir', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'pv-drive-banco-'));
    const caminho = join(pasta, 'banco.db');
    try {
      const antes = abrirBanco(caminho);
      antes.exec(
        'DROP TABLE conexoes_drive; DROP TABLE pastas_no_drive; DROP TABLE pecas_no_drive;',
      );
      antes.close();
      const depois = abrirBanco(caminho);
      const nomes = (
        depois
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as Array<{ name: string }>
      ).map((t) => t.name);
      expect(nomes).toEqual(
        expect.arrayContaining(['conexoes_drive', 'pastas_no_drive', 'pecas_no_drive']),
      );
      depois.close();
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});
