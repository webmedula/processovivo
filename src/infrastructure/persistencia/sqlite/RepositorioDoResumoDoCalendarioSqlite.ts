import type { DatabaseSync } from 'node:sqlite';
import type {
  ItemDoResumo,
  MotivoDoItem,
  RepositorioDoResumoDoCalendario,
} from '../../../domain/ports/RepositorioDoResumoDoCalendario.js';

type Linha = Record<string, unknown>;

/** Teto de linhas por rodada: uma conta com milhares de sugestões não trava o agendador. */
const LIMITE_DE_LINHAS = 5000;

export class RepositorioDoResumoDoCalendarioSqlite implements RepositorioDoResumoDoCalendario {
  constructor(private readonly db: DatabaseSync) {}

  async preferencia(workspace: string): Promise<boolean> {
    const l = this.db
      .prepare('SELECT ativo FROM calendario_resumo_preferencias WHERE workspace = ?')
      .get(workspace) as Linha | undefined;
    return l ? Number(l['ativo']) === 1 : true;
  }

  async definirPreferencia(
    workspace: string,
    ativo: boolean,
    agora: Date,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO calendario_resumo_preferencias (workspace, ativo, atualizado_em)
         VALUES (?, ?, ?)
         ON CONFLICT (workspace) DO UPDATE SET
           ativo = excluded.ativo, atualizado_em = excluded.atualizado_em`,
      )
      .run(workspace, ativo ? 1 : 0, agora.toISOString());
  }

  async itensPendentes(
    desdeDataLocal: string,
    maximoDeTentativas: number,
  ): Promise<ItemDoResumo[]> {
    // Um item por evento: `revisar` vence `sugerido`, porque é o que a pessoa precisa ler. O LEFT JOIN
    // casa com a MESMA (motivo, chave) que será gravada ao avisar.
    const linhas = this.db
      .prepare(
        `SELECT e.workspace, e.id, e.tipo, e.data_local, e.hora_local, e.numero, e.segredo_justica,
                e.mov_data,
                CASE WHEN e.revisar = 1 THEN 'revisar' ELSE 'novo' END AS motivo,
                CASE WHEN e.revisar = 1 THEN COALESCE(e.revisao_ate, '') ELSE '' END AS chave
           FROM eventos_calendario e
           LEFT JOIN calendario_resumo_itens i
             ON i.workspace = e.workspace AND i.evento_id = e.id
            AND i.motivo = CASE WHEN e.revisar = 1 THEN 'revisar' ELSE 'novo' END
            AND i.chave = CASE WHEN e.revisar = 1 THEN COALESCE(e.revisao_ate, '') ELSE '' END
          WHERE e.origem = 'detectado' AND e.estado <> 'descartado'
            AND e.data_local >= ? AND (e.estado = 'sugerido' OR e.revisar = 1)
            AND i.avisado_em IS NULL AND COALESCE(i.tentativas, 0) < ?
          ORDER BY e.workspace, e.data_local, IFNULL(e.hora_local, ''), e.id
          LIMIT ?`,
      )
      .all(desdeDataLocal, maximoDeTentativas, LIMITE_DE_LINHAS) as Linha[];
    return linhas.map(paraItem);
  }

  async enviadoNoDia(workspace: string, diaLocal: string): Promise<boolean> {
    const l = this.db
      .prepare(
        'SELECT 1 AS ok FROM calendario_resumo_envios WHERE workspace = ? AND dia_local = ?',
      )
      .get(workspace, diaLocal);
    return l !== undefined;
  }

  async registrarEnvio(
    workspace: string,
    itens: readonly ItemDoResumo[],
    diaLocal: string,
    agora: Date,
  ): Promise<void> {
    const quando = agora.toISOString();
    this.db.exec('BEGIN');
    try {
      const marcar = this.db.prepare(
        `INSERT INTO calendario_resumo_itens
           (workspace, evento_id, motivo, chave, tentativas, ultima_tentativa_em, avisado_em)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (workspace, evento_id, motivo, chave) DO UPDATE SET
           avisado_em = excluded.avisado_em, ultima_tentativa_em = excluded.ultima_tentativa_em`,
      );
      for (const i of itens)
        marcar.run(workspace, i.eventoId, i.motivo, i.chave, quando, quando);
      this.db
        .prepare(
          `INSERT INTO calendario_resumo_envios (workspace, dia_local, enviado_em, quantidade)
           VALUES (?, ?, ?, ?)`,
        )
        .run(workspace, diaLocal, quando, itens.length);
      this.db.exec('COMMIT');
    } catch (erro) {
      this.db.exec('ROLLBACK');
      throw erro;
    }
  }

  async registrarFalha(itens: readonly ItemDoResumo[], agora: Date): Promise<void> {
    const quando = agora.toISOString();
    this.db.exec('BEGIN');
    try {
      const falhar = this.db.prepare(
        `INSERT INTO calendario_resumo_itens
           (workspace, evento_id, motivo, chave, tentativas, ultima_tentativa_em)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (workspace, evento_id, motivo, chave) DO UPDATE SET
           tentativas = tentativas + 1, ultima_tentativa_em = excluded.ultima_tentativa_em`,
      );
      for (const i of itens)
        falhar.run(i.workspace, i.eventoId, i.motivo, i.chave, quando);
      this.db.exec('COMMIT');
    } catch (erro) {
      this.db.exec('ROLLBACK');
      throw erro;
    }
  }
}

function paraItem(l: Linha): ItemDoResumo {
  const hora =
    typeof l['hora_local'] === 'string' && l['hora_local'] ? l['hora_local'] : undefined;
  const mov =
    typeof l['mov_data'] === 'string' && l['mov_data']
      ? new Date(l['mov_data'])
      : undefined;
  return {
    workspace: String(l['workspace']),
    eventoId: String(l['id']),
    motivo: String(l['motivo']) as MotivoDoItem,
    chave: String(l['chave']),
    tipo: String(l['tipo']),
    dataLocal: String(l['data_local']),
    ...(hora ? { horaLocal: hora } : {}),
    numeroProcesso: String(l['numero']),
    segredoJustica: Number(l['segredo_justica']) === 1,
    ...(mov ? { dataDoAndamento: mov } : {}),
  };
}
