import type { DatabaseSync } from 'node:sqlite';
import { chaveDeOab } from '../../../domain/entities/destinatarioDaComunicacao.js';
import type { OabsDoWorkspace } from '../../../domain/ports/OabsDoWorkspace.js';

type Linha = Record<string, unknown>;

/**
 * Lê `usuarios` (a inscrição do cadastro) e `vigilancias_oab` (as vigiadas,
 * ativas ou não: pausar a vigilância não muda de quem é a inscrição).
 */
export class OabsDoWorkspaceSqlite implements OabsDoWorkspace {
  constructor(private readonly db: DatabaseSync) {}

  async chaves(workspace: string): Promise<ReadonlySet<string>> {
    const chaves = new Set<string>();
    const dono = this.db
      .prepare('SELECT oab, uf_oab FROM usuarios WHERE workspace = ?')
      .all(workspace) as Linha[];
    for (const l of dono) {
      chaves.add(chaveDeOab(String(l['oab'] ?? ''), String(l['uf_oab'] ?? '')));
    }
    const vigiadas = this.db
      .prepare('SELECT oab, uf FROM vigilancias_oab WHERE workspace = ?')
      .all(workspace) as Linha[];
    for (const l of vigiadas) {
      chaves.add(chaveDeOab(String(l['oab'] ?? ''), String(l['uf'] ?? '')));
    }
    chaves.delete('');
    return chaves;
  }
}
