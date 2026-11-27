import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Parte } from '../../../domain/entities/Parte.js';
import type { RepositorioPartesDoTribunal } from '../../../domain/ports/RepositorioPartesDoTribunal.js';

/**
 * O JSON é dado nosso, mas passa por Zod: linha velha ou editada à mão não chega torta à tela.
 * O esquema é a LISTA FECHADA do que se guarda — campo a mais (documento, endereço) não entra
 * na gravação e é descartado na leitura.
 */
const parteSchema = z.object({
  nome: z.string().min(1),
  polo: z.enum(['ATIVO', 'PASSIVO', 'OUTROS']),
  tipoPessoa: z.enum(['FISICA', 'JURIDICA', 'DESCONHECIDO']),
  advogados: z.array(
    z.object({
      nome: z.string(),
      oab: z.string().optional(),
      ufOab: z.string().optional(),
    }),
  ),
});

function paraGravar(p: Parte): z.infer<typeof parteSchema> {
  return {
    nome: p.nome,
    polo: p.polo,
    tipoPessoa: p.tipoPessoa,
    advogados: p.advogados.map((a) => ({
      nome: a.nome,
      ...(a.oab !== undefined ? { oab: a.oab } : {}),
      ...(a.ufOab !== undefined ? { ufOab: a.ufOab } : {}),
    })),
  };
}

function lerPartes(json: string): Parte[] {
  return z
    .array(parteSchema)
    .parse(JSON.parse(json))
    .map((p) => ({
      nome: p.nome,
      polo: p.polo,
      tipoPessoa: p.tipoPessoa,
      advogados: p.advogados.map((a) => ({
        nome: a.nome,
        ...(a.oab !== undefined ? { oab: a.oab } : {}),
        ...(a.ufOab !== undefined ? { ufOab: a.ufOab } : {}),
      })),
    }));
}

export class RepositorioPartesDoTribunalSqlite implements RepositorioPartesDoTribunal {
  constructor(private readonly db: DatabaseSync) {}

  async guardar(
    workspace: string,
    numeroProcesso: string,
    partes: readonly Parte[],
    em: Date,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO partes_do_tribunal (workspace, numero, partes, gravadas_em)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace, numero) DO UPDATE SET
           partes = excluded.partes,
           gravadas_em = excluded.gravadas_em`,
      )
      .run(
        workspace,
        numeroProcesso,
        JSON.stringify(partes.map(paraGravar)),
        em.toISOString(),
      );
  }

  async remover(workspace: string, numeroProcesso: string): Promise<void> {
    this.db
      .prepare('DELETE FROM partes_do_tribunal WHERE workspace = ? AND numero = ?')
      .run(workspace, numeroProcesso);
  }

  async doWorkspace(workspace: string): Promise<ReadonlyMap<string, readonly Parte[]>> {
    const linhas = this.db
      .prepare('SELECT numero, partes FROM partes_do_tribunal WHERE workspace = ?')
      .all(workspace) as unknown as Array<{ numero: string; partes: string }>;
    const mapa = new Map<string, readonly Parte[]>();
    for (const l of linhas) {
      // Uma linha torta não derruba as outras: aquele processo volta às partes do Diário.
      try {
        const partes = lerPartes(l.partes);
        if (partes.length > 0) mapa.set(l.numero, partes);
      } catch {
        /* ignora a linha */
      }
    }
    return mapa;
  }

  async apagarDoWorkspace(workspace: string): Promise<number> {
    const r = this.db
      .prepare('DELETE FROM partes_do_tribunal WHERE workspace = ?')
      .run(workspace);
    return Number(r.changes);
  }
}
