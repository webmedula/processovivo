import type { DatabaseSync } from 'node:sqlite';
import { EventoDeCalendario } from '../../../domain/entities/EventoDeCalendario.js';
import type {
  EstadoDoEvento,
  OrigemDoEvento,
  TipoDeEvento,
} from '../../../domain/entities/EventoDeCalendario.js';
import type {
  FeedDoCalendario,
  FiltroDeEventos,
  RepositorioDeEventos,
} from '../../../domain/ports/RepositorioDeEventos.js';

type Linha = Record<string, unknown>;

const texto = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const data = (v: unknown): Date | undefined => {
  const s = texto(v);
  return s ? new Date(s) : undefined;
};

const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);

export class RepositorioDeEventosSqlite implements RepositorioDeEventos {
  constructor(private readonly db: DatabaseSync) {}

  async inserirSeNovo(evento: EventoDeCalendario): Promise<boolean> {
    // DO NOTHING sem alvo: vale para a chave primária E para o índice único
    // parcial da chave de detecção — que é o que barra o descartado de voltar.
    const r = this.db
      .prepare(`${INSERIR} ON CONFLICT DO NOTHING`)
      .run(...valores(evento));
    return Number(r.changes) > 0;
  }

  async salvar(evento: EventoDeCalendario): Promise<void> {
    this.db
      .prepare(
        `${INSERIR}
         ON CONFLICT (workspace, id) DO UPDATE SET
           tipo = excluded.tipo, titulo = excluded.titulo,
           observacao = excluded.observacao, data_local = excluded.data_local,
           hora_local = excluded.hora_local, duracao_min = excluded.duracao_min,
           estado = excluded.estado, revisar = excluded.revisar,
           revisao_ate = excluded.revisao_ate,
           segredo_justica = excluded.segredo_justica, calculado = excluded.calculado,
           sequencia = excluded.sequencia, atualizado_em = excluded.atualizado_em,
           confirmado_em = excluded.confirmado_em,
           descartado_em = excluded.descartado_em`,
      )
      .run(...valores(evento));
  }

  async buscar(workspace: string, id: string): Promise<EventoDeCalendario | undefined> {
    const linha = this.db
      .prepare('SELECT * FROM eventos_calendario WHERE workspace = ? AND id = ?')
      .get(workspace, id) as Linha | undefined;
    return linha ? paraEvento(linha) : undefined;
  }

  async listar(
    workspace: string,
    filtro: FiltroDeEventos,
  ): Promise<EventoDeCalendario[]> {
    const cond = ['workspace = ?', 'data_local >= ?', 'data_local <= ?'];
    const args: string[] = [workspace, filtro.de, filtro.ate];
    if (filtro.estados && filtro.estados.length > 0) {
      cond.push(`estado IN (${filtro.estados.map(() => '?').join(', ')})`);
      args.push(...filtro.estados);
    }
    const linhas = this.db
      .prepare(
        `SELECT * FROM eventos_calendario WHERE ${cond.join(' AND ')}
          ORDER BY data_local, IFNULL(hora_local, ''), id`,
      )
      .all(...args) as Linha[];
    return linhas.map(paraEvento);
  }

  async contar(workspace: string, de: string, ate: string): Promise<number> {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM eventos_calendario
          WHERE workspace = ? AND data_local >= ? AND data_local <= ?`,
      )
      .get(workspace, de, ate) as unknown as { n: number };
    return Number(r.n);
  }

  async detectadosDoProcesso(
    workspace: string,
    numero: string,
  ): Promise<EventoDeCalendario[]> {
    const linhas = this.db
      .prepare(
        `SELECT * FROM eventos_calendario
          WHERE workspace = ? AND numero = ? AND origem = 'detectado'`,
      )
      .all(workspace, numero) as Linha[];
    return linhas.map(paraEvento);
  }

  async atualizarSegredo(
    workspace: string,
    numero: string,
    segredo: boolean,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE eventos_calendario SET segredo_justica = ?
          WHERE workspace = ? AND numero = ? AND segredo_justica <> ?`,
      )
      .run(segredo ? 1 : 0, workspace, numero, segredo ? 1 : 0);
  }

  async feedAtivo(workspace: string): Promise<FeedDoCalendario | undefined> {
    const linha = this.db
      .prepare(
        `SELECT * FROM calendario_feeds WHERE workspace = ? AND revogado_em IS NULL
          ORDER BY criado_em DESC LIMIT 1`,
      )
      .get(workspace) as Linha | undefined;
    return linha ? paraFeed(linha) : undefined;
  }

  async feedPorHash(tokenHash: string): Promise<FeedDoCalendario | undefined> {
    const linha = this.db
      .prepare('SELECT * FROM calendario_feeds WHERE token_hash = ?')
      .get(tokenHash) as Linha | undefined;
    return linha ? paraFeed(linha) : undefined;
  }

  async substituirFeed(feed: FeedDoCalendario): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE calendario_feeds SET revogado_em = ?
            WHERE workspace = ? AND revogado_em IS NULL`,
        )
        .run(feed.criadoEm.toISOString(), feed.workspace);
      this.db
        .prepare(
          `INSERT INTO calendario_feeds
             (id, workspace, token_hash, inclui_sugeridos, criado_em, revogado_em)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          feed.id,
          feed.workspace,
          feed.tokenHash,
          feed.incluiSugeridos ? 1 : 0,
          feed.criadoEm.toISOString(),
        );
      this.db.exec('COMMIT');
    } catch (erro) {
      this.db.exec('ROLLBACK');
      throw erro;
    }
  }

  async alterarFeed(
    workspace: string,
    incluiSugeridos: boolean,
  ): Promise<FeedDoCalendario | undefined> {
    this.db
      .prepare(
        `UPDATE calendario_feeds SET inclui_sugeridos = ?
          WHERE workspace = ? AND revogado_em IS NULL`,
      )
      .run(incluiSugeridos ? 1 : 0, workspace);
    return this.feedAtivo(workspace);
  }

  async revogarFeed(workspace: string, agora: Date): Promise<boolean> {
    const r = this.db
      .prepare(
        `UPDATE calendario_feeds SET revogado_em = ?
          WHERE workspace = ? AND revogado_em IS NULL`,
      )
      .run(agora.toISOString(), workspace);
    return Number(r.changes) > 0;
  }

  async workspacesSemRetroativo(limite: number): Promise<string[]> {
    const linhas = this.db
      .prepare(
        `SELECT DISTINCT a.workspace AS ws FROM acompanhamentos a
          WHERE NOT EXISTS (
            SELECT 1 FROM calendario_retroativo r WHERE r.workspace = a.workspace)
          ORDER BY a.workspace LIMIT ?`,
      )
      .all(limite) as Linha[];
    return linhas.map((l) => String(l['ws']));
  }

  async marcarRetroativo(workspace: string, agora: Date): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO calendario_retroativo (workspace, feito_em) VALUES (?, ?)
         ON CONFLICT (workspace) DO UPDATE SET feito_em = excluded.feito_em`,
      )
      .run(workspace, agora.toISOString());
  }
}

const INSERIR = `INSERT INTO eventos_calendario
  (workspace, id, numero, tribunal, tipo, titulo, observacao, data_local, hora_local,
   duracao_min, origem, estado, mov_id, mov_data, trecho, chave_deteccao, revisar,
   revisao_ate, segredo_justica, sequencia, criado_em, atualizado_em, confirmado_em,
   descartado_em, calculado)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function valores(e: EventoDeCalendario): Array<string | number | null> {
  return [
    e.workspace,
    e.id,
    e.numeroProcesso,
    e.tribunal,
    e.tipo,
    e.titulo,
    e.observacao ?? null,
    e.dataLocal,
    e.horaLocal ?? null,
    e.duracaoMin ?? null,
    e.origem,
    e.estado,
    e.procedencia?.movimentacaoId ?? null,
    iso(e.procedencia?.dataDoAndamento),
    e.procedencia?.trecho ?? null,
    e.chaveDeDeteccao ?? null,
    e.revisar ? 1 : 0,
    iso(e.revisaoAte),
    e.segredoJustica ? 1 : 0,
    e.sequencia,
    e.criadoEm.toISOString(),
    e.atualizadoEm.toISOString(),
    iso(e.confirmadoEm),
    iso(e.descartadoEm),
    e.calculado ? 1 : 0,
  ];
}

function paraEvento(l: Linha): EventoDeCalendario {
  const movId = texto(l['mov_id']);
  const movData = data(l['mov_data']);
  const observacao = texto(l['observacao']);
  const hora = texto(l['hora_local']);
  const chave = texto(l['chave_deteccao']);
  const revisaoAte = data(l['revisao_ate']);
  const confirmadoEm = data(l['confirmado_em']);
  const descartadoEm = data(l['descartado_em']);
  const duracao = l['duracao_min'];
  return new EventoDeCalendario({
    id: String(l['id']),
    workspace: String(l['workspace']),
    numeroProcesso: String(l['numero']),
    tribunal: String(l['tribunal']),
    tipo: String(l['tipo']) as TipoDeEvento,
    titulo: String(l['titulo']),
    ...(observacao !== undefined ? { observacao } : {}),
    dataLocal: String(l['data_local']),
    ...(hora !== undefined ? { horaLocal: hora } : {}),
    ...(typeof duracao === 'number' || typeof duracao === 'bigint'
      ? { duracaoMin: Number(duracao) }
      : {}),
    origem: String(l['origem']) as OrigemDoEvento,
    estado: String(l['estado']) as EstadoDoEvento,
    ...(movId !== undefined && movData
      ? {
          procedencia: {
            movimentacaoId: movId,
            dataDoAndamento: movData,
            trecho: String(l['trecho'] ?? ''),
          },
        }
      : {}),
    ...(chave !== undefined ? { chaveDeDeteccao: chave } : {}),
    revisar: Number(l['revisar']) === 1,
    ...(revisaoAte ? { revisaoAte } : {}),
    segredoJustica: Number(l['segredo_justica']) === 1,
    ...(Number(l['calculado']) === 1 ? { calculado: true } : {}),
    sequencia: Number(l['sequencia']),
    criadoEm: new Date(String(l['criado_em'])),
    atualizadoEm: new Date(String(l['atualizado_em'])),
    ...(confirmadoEm ? { confirmadoEm } : {}),
    ...(descartadoEm ? { descartadoEm } : {}),
  });
}

function paraFeed(l: Linha): FeedDoCalendario {
  const revogadoEm = data(l['revogado_em']);
  return {
    id: String(l['id']),
    workspace: String(l['workspace']),
    tokenHash: String(l['token_hash']),
    incluiSugeridos: Number(l['inclui_sugeridos']) === 1,
    criadoEm: new Date(String(l['criado_em'])),
    ...(revogadoEm ? { revogadoEm } : {}),
  };
}
