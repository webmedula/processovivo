import { describe, expect, it } from 'vitest';
import { ServicoAdministradores } from '../../src/application/services/ServicoAdministradores.js';
import { ABAS_DO_ADMIN, abasEmOrdem } from '../../src/domain/entities/AbasDoAdmin.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDePermissoesDoAdminSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDePermissoesDoAdminSqlite.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';

const T0 = new Date('2026-10-27T12:00:00Z');
const relogio = (inicio: Date): Clock & { avancar(ms: number): void } => {
  let agora = inicio.getTime();
  return {
    agora: () => new Date(agora),
    monotonico: () => agora,
    avancar: (ms: number) => {
      agora += ms;
    },
  };
};

describe('permissões do /admin — migração aditiva', () => {
  it('banco vazio: cria as três tabelas; banco da versão anterior: só acrescenta; segunda execução não altera nada', () => {
    const db = abrirBanco(':memory:');
    const tabelas = (): string[] =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((l) => l.name);
    for (const t of ['admin_permissoes', 'admin_permissoes_historico', 'admin_acessos']) {
      expect(tabelas()).toContain(t);
    }
    // As tabelas de auditoria que já existiam continuam com as mesmas colunas.
    const colunas = (t: string): string[] =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
    expect(colunas('ia_alteracoes')).toEqual(
      expect.arrayContaining([
        'em',
        'autor',
        'funcao',
        'tipo',
        'valor_anterior',
        'valor_novo',
      ]),
    );
    expect(colunas('admin_permissoes')).toEqual([
      'usuario',
      'aba',
      'liberado_por',
      'liberado_em',
    ]);

    // Segunda execução do esquema por cima de dados: nada duplica nem se perde.
    const repo = new RepositorioDePermissoesDoAdminSqlite(db);
    repo.substituir('ana', ['ia'], 'x', T0);
    const antes = tabelas();
    db.exec(
      'CREATE TABLE IF NOT EXISTS admin_permissoes (usuario TEXT NOT NULL, aba TEXT NOT NULL, liberado_por TEXT NOT NULL, liberado_em TEXT NOT NULL, PRIMARY KEY (usuario, aba))',
    );
    expect(tabelas()).toEqual(antes);
    expect(repo.abasDe('ana')).toEqual(['ia']);
  });

  it('substituir grava só o que mudou, no histórico, e repetir o mesmo conjunto não grava nada', () => {
    const repo = new RepositorioDePermissoesDoAdminSqlite(abrirBanco(':memory:'));
    expect(repo.substituir('ana', ['ia', 'chaves'], 'dono-x', T0)).toHaveLength(2);
    expect(repo.substituir('ana', ['ia', 'chaves'], 'dono-x', T0)).toEqual([]);
    expect(
      repo.substituir('ana', ['ia'], 'dono-x', T0).map((m) => `${m.acao}:${m.aba}`),
    ).toEqual(['tirou:chaves']);
    expect(repo.historico(10)).toHaveLength(3);
    expect(repo.todas().map((p) => p.aba)).toEqual(['ia']);
  });

  it('o repositório é isolado por usuário', () => {
    const repo = new RepositorioDePermissoesDoAdminSqlite(abrirBanco(':memory:'));
    repo.substituir('ana', ['ia'], 'x', T0);
    expect(repo.abasDe('beto')).toEqual([]);
  });
});

describe('ServicoAdministradores', () => {
  function montar(): {
    servico: ServicoAdministradores;
    repo: RepositorioDePermissoesDoAdminSqlite;
    relogio: ReturnType<typeof relogio>;
  } {
    const repo = new RepositorioDePermissoesDoAdminSqlite(abrirBanco(':memory:'));
    const r = relogio(T0);
    return {
      servico: new ServicoAdministradores({
        restritos: ['ana', 'beto'],
        repositorio: repo,
        clock: r,
        logger: loggerSilencioso,
      }),
      repo,
      relogio: r,
    };
  }

  it('aba nova do código nasce fechada: a lista vem do código e não do banco', () => {
    const { servico } = montar();
    expect(servico.abasDo('ana')).toEqual({ ok: true, abas: [] });
    expect(abasEmOrdem(['ia', 'aba-do-futuro', 'chaves', 'ia'])).toEqual([
      'chaves',
      'ia',
    ]);
    expect(ABAS_DO_ADMIN).not.toContain('administradores');
  });

  it('o último acesso é gravado no máximo uma vez por minuto e só de quem está declarado', () => {
    const { servico, repo, relogio: r } = montar();
    servico.registrarAcesso('ana');
    const primeiro = repo.ultimosAcessos().get('ana');
    r.avancar(30_000);
    servico.registrarAcesso('ana');
    expect(repo.ultimosAcessos().get('ana')).toEqual(primeiro);
    r.avancar(31_000);
    servico.registrarAcesso('ana');
    expect(repo.ultimosAcessos().get('ana')).not.toEqual(primeiro);
    servico.registrarAcesso('desconhecido');
    expect(repo.ultimosAcessos().has('desconhecido')).toBe(false);
  });

  it('falha de gravação do acesso nunca lança', () => {
    const { servico, repo } = montar();
    repo.registrarAcesso = () => {
      throw new Error('banco fechado');
    };
    expect(() => servico.registrarAcesso('ana')).not.toThrow();
  });
});
