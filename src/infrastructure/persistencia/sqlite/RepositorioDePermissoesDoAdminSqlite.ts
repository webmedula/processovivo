import type { DatabaseSync } from 'node:sqlite';
import type {
  AcaoDePermissao,
  MudancaDePermissao,
  PermissaoDoAdmin,
  RepositorioDePermissoesDoAdmin,
} from '../../../domain/ports/RepositorioDePermissoesDoAdmin.js';

/**
 * Permissões por aba dos administradores restritos. Qualquer falha de leitura SOBE (não vira lista vazia
 * silenciosa): quem pergunta trata como "sem acesso", e a diferença entre "sem aba" e "não deu para ler" aparece
 * na tela do restrito.
 */
export class RepositorioDePermissoesDoAdminSqlite implements RepositorioDePermissoesDoAdmin {
  constructor(private readonly db: DatabaseSync) {}

  abasDe(usuario: string): string[] {
    const linhas = this.db
      .prepare('SELECT aba FROM admin_permissoes WHERE usuario = ?')
      .all(usuario) as unknown as Array<{ aba: string }>;
    return linhas.map((l) => l.aba);
  }

  todas(): PermissaoDoAdmin[] {
    const linhas = this.db
      .prepare(
        'SELECT usuario, aba, liberado_por, liberado_em FROM admin_permissoes ORDER BY usuario, aba',
      )
      .all() as unknown as Array<{
      usuario: string;
      aba: string;
      liberado_por: string;
      liberado_em: string;
    }>;
    return linhas.map((l) => ({
      usuario: l.usuario,
      aba: l.aba,
      liberadoPor: l.liberado_por,
      liberadoEm: new Date(l.liberado_em),
    }));
  }

  substituir(
    usuario: string,
    abas: readonly string[],
    por: string,
    em: Date,
  ): MudancaDePermissao[] {
    const desejadas = new Set(abas);
    const quando = em.toISOString();
    this.db.exec('BEGIN');
    try {
      const atuais = new Set(this.abasDe(usuario));
      const mudancas: MudancaDePermissao[] = [];
      const insere = this.db.prepare(
        'INSERT INTO admin_permissoes (usuario, aba, liberado_por, liberado_em) VALUES (?, ?, ?, ?)',
      );
      const apaga = this.db.prepare(
        'DELETE FROM admin_permissoes WHERE usuario = ? AND aba = ?',
      );
      const historico = this.db.prepare(
        'INSERT INTO admin_permissoes_historico (em, por, usuario, aba, acao) VALUES (?, ?, ?, ?, ?)',
      );
      const registrar = (aba: string, acao: AcaoDePermissao): void => {
        historico.run(quando, por, usuario, aba, acao);
        mudancas.push({ em, por, usuario, aba, acao });
      };
      for (const aba of desejadas) {
        if (atuais.has(aba)) continue;
        insere.run(usuario, aba, por, quando);
        registrar(aba, 'liberou');
      }
      for (const aba of atuais) {
        if (desejadas.has(aba)) continue;
        apaga.run(usuario, aba);
        registrar(aba, 'tirou');
      }
      this.db.exec('COMMIT');
      return mudancas;
    } catch (erro) {
      this.db.exec('ROLLBACK');
      throw erro;
    }
  }

  historico(limite: number): MudancaDePermissao[] {
    const linhas = this.db
      .prepare(
        'SELECT em, por, usuario, aba, acao FROM admin_permissoes_historico ORDER BY id DESC LIMIT ?',
      )
      .all(limite) as unknown as Array<{
      em: string;
      por: string;
      usuario: string;
      aba: string;
      acao: string;
    }>;
    return linhas.map((l) => ({
      em: new Date(l.em),
      por: l.por,
      usuario: l.usuario,
      aba: l.aba,
      acao: l.acao === 'tirou' ? 'tirou' : 'liberou',
    }));
  }

  registrarAcesso(usuario: string, em: Date): void {
    this.db
      .prepare(
        `INSERT INTO admin_acessos (usuario, ultimo_acesso) VALUES (?, ?)
         ON CONFLICT(usuario) DO UPDATE SET ultimo_acesso = excluded.ultimo_acesso`,
      )
      .run(usuario, em.toISOString());
  }

  ultimosAcessos(): Map<string, Date> {
    const linhas = this.db
      .prepare('SELECT usuario, ultimo_acesso FROM admin_acessos')
      .all() as unknown as Array<{ usuario: string; ultimo_acesso: string }>;
    return new Map(linhas.map((l) => [l.usuario, new Date(l.ultimo_acesso)]));
  }
}
