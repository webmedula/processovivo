import type { DatabaseSync } from 'node:sqlite';
import type {
  LigacaoDeIdentidade,
  RepositorioIdentidades,
} from '../../../domain/ports/RepositorioIdentidades.js';

interface Linha {
  provedor: string;
  sujeito: string;
  usuario_id: string;
  ligada_em: string;
}

/**
 * Ligações conta ↔ identidade externa (v0.67.0). Só provedor, sujeito, conta e instante.
 * As duas unicidades (um sujeito → uma conta; uma conta → um sujeito por provedor) são do
 * esquema: `PRIMARY KEY (provedor, sujeito)` e `UNIQUE (provedor, usuario_id)`.
 */
export class RepositorioIdentidadesSqlite implements RepositorioIdentidades {
  constructor(private readonly db: DatabaseSync) {}

  async usuarioDe(provedor: string, sujeito: string): Promise<string | undefined> {
    const l = this.db
      .prepare(
        'SELECT usuario_id FROM identidades_externas WHERE provedor = ? AND sujeito = ?',
      )
      .get(provedor, sujeito) as unknown as { usuario_id: string } | undefined;
    return l?.usuario_id;
  }

  async ligacaoDe(
    provedor: string,
    usuarioId: string,
  ): Promise<LigacaoDeIdentidade | undefined> {
    const l = this.db
      .prepare('SELECT * FROM identidades_externas WHERE provedor = ? AND usuario_id = ?')
      .get(provedor, usuarioId) as unknown as Linha | undefined;
    if (!l) return undefined;
    return {
      provedor: l.provedor,
      usuarioId: l.usuario_id,
      ligadaEm: new Date(l.ligada_em),
    };
  }

  async ligar(provedor: string, sujeito: string, usuarioId: string): Promise<void> {
    // `OR IGNORE` cobre o mesmo par repetido (idempotente). Par CONFLITANTE — sujeito em outra
    // conta, ou conta com outro sujeito — também é ignorado pelo banco; quem chama confere
    // antes e lê de novo depois, então a corrida nunca liga ninguém à conta errada.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO identidades_externas (provedor, sujeito, usuario_id, ligada_em)
         VALUES (?, ?, ?, ?)`,
      )
      .run(provedor, sujeito, usuarioId, new Date().toISOString());
  }

  async desligar(provedor: string, usuarioId: string): Promise<boolean> {
    const r = this.db
      .prepare('DELETE FROM identidades_externas WHERE provedor = ? AND usuario_id = ?')
      .run(provedor, usuarioId);
    return Number(r.changes) > 0;
  }
}
