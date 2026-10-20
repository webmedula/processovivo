import type { DatabaseSync } from 'node:sqlite';
import type {
  Comprovante,
  TipoDeComprovante,
} from '../../../domain/entities/Comprovante.js';
import {
  chaveDeUnicidadeDaCategoria,
  ehPagador,
} from '../../../domain/entities/Custo.js';
import type { CategoriaDeCusto, Custo } from '../../../domain/entities/Custo.js';
import type {
  CampoAlterado,
  EntidadeDoHistorico,
  EventoDoHistorico,
  OperacaoDoHistorico,
} from '../../../domain/entities/HistoricoDeCustos.js';
import type { Recebimento } from '../../../domain/entities/Recebimento.js';
import type {
  FiltroDePeriodo,
  RepositorioDeCustos,
} from '../../../domain/ports/RepositorioDeCustos.js';

type Linha = Record<string, unknown>;

/**
 * Centro de custos em SQLite (v0.47.0, ampliado na v0.48.0). Toda consulta leva `workspace = ?` —
 * não existe leitura por id sozinho. Nada daqui chega a log: valor, descrição e nome de categoria
 * são dado do cliente do advogado.
 *
 * Não há DELETE de lançamento, recebimento nem histórico: cancelar é gravar `cancelado_em`. A mudança
 * e o evento do histórico entram na MESMA transação.
 */
export class RepositorioDeCustosSqlite implements RepositorioDeCustos {
  constructor(private readonly db: DatabaseSync) {}

  /** `node:sqlite` é síncrono: BEGIN/COMMIT em volta de statements síncronos é atômico. */
  private transacao<T>(corpo: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = corpo();
      this.db.exec('COMMIT');
      return r;
    } catch (erro) {
      this.db.exec('ROLLBACK');
      throw erro;
    }
  }

  private gravarEvento(e: EventoDoHistorico): void {
    this.db
      .prepare(
        `INSERT INTO historico_custos
           (workspace, id, numero, entidade, entidade_id, operacao, quando, campos, motivo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.workspace,
        e.id,
        e.numeroProcesso,
        e.entidade,
        e.entidadeId,
        e.operacao,
        e.quando.toISOString(),
        JSON.stringify(e.campos),
        e.motivo ?? null,
      );
  }

  async listar(
    workspace: string,
    numeroProcesso: string,
    incluirCancelados: boolean,
  ): Promise<Custo[]> {
    const linhas = this.db
      .prepare(
        `SELECT * FROM custos_processo WHERE workspace = ? AND numero = ?
           ${incluirCancelados ? '' : 'AND cancelado_em IS NULL'}
         ORDER BY data DESC, criado_em DESC, id DESC`,
      )
      .all(workspace, numeroProcesso) as Linha[];
    return linhas.map(paraCusto);
  }

  async contar(workspace: string, numeroProcesso: string): Promise<number> {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM custos_processo
          WHERE workspace = ? AND numero = ? AND cancelado_em IS NULL`,
      )
      .get(workspace, numeroProcesso) as { n: number };
    return Number(r.n);
  }

  async buscar(workspace: string, id: string): Promise<Custo | undefined> {
    const linha = this.db
      .prepare('SELECT * FROM custos_processo WHERE workspace = ? AND id = ?')
      .get(workspace, id) as Linha | undefined;
    return linha ? paraCusto(linha) : undefined;
  }

  async inserir(c: Custo, evento: EventoDoHistorico): Promise<void> {
    this.transacao(() => {
      this.db
        .prepare(
          `INSERT INTO custos_processo
             (workspace, id, numero, data, descricao, categoria, valor_centavos, reembolsavel,
              pago_por, cancelado_em, cancelado_motivo, criado_em, atualizado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.workspace,
          c.id,
          c.numeroProcesso,
          c.data,
          c.descricao,
          c.categoria,
          c.valorCentavos,
          c.reembolsavel ? 1 : 0,
          c.pagoPor,
          c.canceladoEm?.toISOString() ?? null,
          c.motivoDoCancelamento ?? null,
          c.criadoEm.toISOString(),
          c.atualizadoEm.toISOString(),
        );
      this.gravarEvento(evento);
    });
  }

  async atualizar(c: Custo, evento: EventoDoHistorico): Promise<boolean> {
    return this.transacao(() => {
      const r = this.db
        .prepare(
          `UPDATE custos_processo SET
             data = ?, descricao = ?, categoria = ?, valor_centavos = ?, reembolsavel = ?,
             pago_por = ?, cancelado_em = ?, cancelado_motivo = ?, atualizado_em = ?
           WHERE workspace = ? AND id = ?`,
        )
        .run(
          c.data,
          c.descricao,
          c.categoria,
          c.valorCentavos,
          c.reembolsavel ? 1 : 0,
          c.pagoPor,
          c.canceladoEm?.toISOString() ?? null,
          c.motivoDoCancelamento ?? null,
          c.atualizadoEm.toISOString(),
          c.workspace,
          c.id,
        );
      if (Number(r.changes) === 0) return false;
      this.gravarEvento(evento);
      return true;
    });
  }

  async listarRecebimentos(
    workspace: string,
    numeroProcesso: string,
    incluirCancelados: boolean,
  ): Promise<Recebimento[]> {
    const linhas = this.db
      .prepare(
        `SELECT * FROM recebimentos_processo WHERE workspace = ? AND numero = ?
           ${incluirCancelados ? '' : 'AND cancelado_em IS NULL'}
         ORDER BY data DESC, criado_em DESC, id DESC`,
      )
      .all(workspace, numeroProcesso) as Linha[];
    return linhas.map(paraRecebimento);
  }

  async contarRecebimentos(workspace: string, numeroProcesso: string): Promise<number> {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM recebimentos_processo
          WHERE workspace = ? AND numero = ? AND cancelado_em IS NULL`,
      )
      .get(workspace, numeroProcesso) as { n: number };
    return Number(r.n);
  }

  async buscarRecebimento(
    workspace: string,
    id: string,
  ): Promise<Recebimento | undefined> {
    const linha = this.db
      .prepare('SELECT * FROM recebimentos_processo WHERE workspace = ? AND id = ?')
      .get(workspace, id) as Linha | undefined;
    return linha ? paraRecebimento(linha) : undefined;
  }

  async inserirRecebimento(r: Recebimento, evento: EventoDoHistorico): Promise<void> {
    this.transacao(() => {
      this.db
        .prepare(
          `INSERT INTO recebimentos_processo
             (workspace, id, numero, data, valor_centavos, observacao, cancelado_em,
              cancelado_motivo, criado_em, atualizado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.workspace,
          r.id,
          r.numeroProcesso,
          r.data,
          r.valorCentavos,
          r.observacao ?? null,
          r.canceladoEm?.toISOString() ?? null,
          r.motivoDoCancelamento ?? null,
          r.criadoEm.toISOString(),
          r.atualizadoEm.toISOString(),
        );
      this.gravarEvento(evento);
    });
  }

  async atualizarRecebimento(
    r: Recebimento,
    evento: EventoDoHistorico,
  ): Promise<boolean> {
    return this.transacao(() => {
      const res = this.db
        .prepare(
          `UPDATE recebimentos_processo SET
             data = ?, valor_centavos = ?, observacao = ?, cancelado_em = ?,
             cancelado_motivo = ?, atualizado_em = ?
           WHERE workspace = ? AND id = ?`,
        )
        .run(
          r.data,
          r.valorCentavos,
          r.observacao ?? null,
          r.canceladoEm?.toISOString() ?? null,
          r.motivoDoCancelamento ?? null,
          r.atualizadoEm.toISOString(),
          r.workspace,
          r.id,
        );
      if (Number(res.changes) === 0) return false;
      this.gravarEvento(evento);
      return true;
    });
  }

  async listarDoWorkspace(
    workspace: string,
    filtro: FiltroDePeriodo,
    incluirCancelados: boolean,
  ): Promise<Custo[]> {
    const { sql, args } = periodo(filtro);
    const linhas = this.db
      .prepare(
        `SELECT * FROM custos_processo WHERE workspace = ? ${sql}
           ${incluirCancelados ? '' : 'AND cancelado_em IS NULL'}
         ORDER BY numero, data DESC, criado_em DESC, id DESC`,
      )
      .all(workspace, ...args) as Linha[];
    return linhas.map(paraCusto);
  }

  async listarRecebimentosDoWorkspace(
    workspace: string,
    filtro: FiltroDePeriodo,
    incluirCancelados: boolean,
  ): Promise<Recebimento[]> {
    const { sql, args } = periodo(filtro);
    const linhas = this.db
      .prepare(
        `SELECT * FROM recebimentos_processo WHERE workspace = ? ${sql}
           ${incluirCancelados ? '' : 'AND cancelado_em IS NULL'}
         ORDER BY numero, data DESC, criado_em DESC, id DESC`,
      )
      .all(workspace, ...args) as Linha[];
    return linhas.map(paraRecebimento);
  }

  async listarComprovantes(
    workspace: string,
    numeroProcesso?: string,
  ): Promise<Comprovante[]> {
    const linhas = (
      numeroProcesso === undefined
        ? this.db
            .prepare(
              'SELECT * FROM comprovantes_custo WHERE workspace = ? ORDER BY anexado_em, id',
            )
            .all(workspace)
        : this.db
            .prepare(
              'SELECT * FROM comprovantes_custo WHERE workspace = ? AND numero = ? ORDER BY anexado_em, id',
            )
            .all(workspace, numeroProcesso)
    ) as Linha[];
    return linhas.map(paraComprovante);
  }

  async contarComprovantes(workspace: string, custoId: string): Promise<number> {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM comprovantes_custo WHERE workspace = ? AND custo_id = ?',
      )
      .get(workspace, custoId) as { n: number };
    return Number(r.n);
  }

  async buscarComprovante(workspace: string, id: string): Promise<Comprovante | undefined> {
    const l = this.db
      .prepare('SELECT * FROM comprovantes_custo WHERE workspace = ? AND id = ?')
      .get(workspace, id) as Linha | undefined;
    return l ? paraComprovante(l) : undefined;
  }

  async inserirComprovante(
    c: Comprovante,
    maximo: number,
    evento: EventoDoHistorico,
  ): Promise<boolean> {
    return this.transacao(() => {
      const n = this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM comprovantes_custo WHERE workspace = ? AND custo_id = ?',
        )
        .get(c.workspace, c.custoId) as { n: number };
      if (Number(n.n) >= maximo) return false;
      this.db
        .prepare(
          `INSERT INTO comprovantes_custo
             (workspace, id, custo_id, numero, arquivo_id, link, nome, tipo, tamanho, anexado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.workspace,
          c.id,
          c.custoId,
          c.numeroProcesso,
          c.arquivoId,
          c.link,
          c.nome,
          c.tipo,
          c.tamanho,
          c.anexadoEm.toISOString(),
        );
      this.gravarEvento(evento);
      return true;
    });
  }

  async removerComprovante(
    workspace: string,
    id: string,
    evento: EventoDoHistorico,
  ): Promise<boolean> {
    return this.transacao(() => {
      const r = this.db
        .prepare('DELETE FROM comprovantes_custo WHERE workspace = ? AND id = ?')
        .run(workspace, id);
      if (Number(r.changes) === 0) return false;
      this.gravarEvento(evento);
      return true;
    });
  }

  async categorias(workspace: string): Promise<CategoriaDeCusto[]> {
    const linhas = this.db
      .prepare(
        'SELECT * FROM categorias_custo WHERE workspace = ? ORDER BY nome_chave, id',
      )
      .all(workspace) as Linha[];
    return linhas.map(paraCategoria);
  }

  async buscarCategoria(
    workspace: string,
    id: string,
  ): Promise<CategoriaDeCusto | undefined> {
    const linha = this.db
      .prepare('SELECT * FROM categorias_custo WHERE workspace = ? AND id = ?')
      .get(workspace, id) as Linha | undefined;
    return linha ? paraCategoria(linha) : undefined;
  }

  async inserirCategoria(c: CategoriaDeCusto): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO categorias_custo (workspace, id, nome, nome_chave, grupo, arquivada, criada_em)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.workspace,
        c.id,
        c.nome,
        chaveDeUnicidadeDaCategoria(c.grupo, c.nome),
        c.grupo,
        c.arquivada ? 1 : 0,
        c.criadaEm.toISOString(),
      );
  }

  async atualizarCategoria(c: CategoriaDeCusto): Promise<boolean> {
    const r = this.db
      .prepare(
        `UPDATE categorias_custo SET arquivada = ?, grupo = ?, nome_chave = ?
          WHERE workspace = ? AND id = ?`,
      )
      .run(
        c.arquivada ? 1 : 0,
        c.grupo,
        chaveDeUnicidadeDaCategoria(c.grupo, c.nome),
        c.workspace,
        c.id,
      );
    return Number(r.changes) > 0;
  }

  async usosDaCategoria(workspace: string, codigo: string): Promise<number> {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM custos_processo WHERE workspace = ? AND categoria = ?',
      )
      .get(workspace, codigo) as { n: number };
    return Number(r.n);
  }

  async historico(
    workspace: string,
    entidade: EntidadeDoHistorico,
    entidadeId: string,
  ): Promise<EventoDoHistorico[]> {
    const linhas = this.db
      .prepare(
        `SELECT * FROM historico_custos
          WHERE workspace = ? AND entidade = ? AND entidade_id = ?
          ORDER BY quando ASC, rowid ASC`,
      )
      .all(workspace, entidade, entidadeId) as Linha[];
    return linhas.map(paraEvento);
  }

  async apagarDoWorkspace(workspace: string): Promise<number> {
    let n = 0;
    for (const tabela of [
      'custos_processo',
      'recebimentos_processo',
      'categorias_custo',
      'historico_custos',
      'comprovantes_custo',
    ]) {
      n += Number(
        this.db.prepare(`DELETE FROM ${tabela} WHERE workspace = ?`).run(workspace)
          .changes,
      );
    }
    return n;
  }
}

function paraCusto(l: Linha): Custo {
  const canceladoEm =
    typeof l['cancelado_em'] === 'string' ? new Date(l['cancelado_em']) : undefined;
  const motivo =
    typeof l['cancelado_motivo'] === 'string' && l['cancelado_motivo']
      ? l['cancelado_motivo']
      : undefined;
  return Object.freeze({
    id: String(l['id']),
    workspace: String(l['workspace']),
    numeroProcesso: String(l['numero']),
    data: String(l['data']),
    descricao: String(l['descricao']),
    categoria: String(l['categoria']),
    valorCentavos: Number(l['valor_centavos']),
    reembolsavel: Number(l['reembolsavel']) === 1,
    pagoPor: ehPagador(l['pago_por']) ? l['pago_por'] : 'escritorio',
    criadoEm: new Date(String(l['criado_em'])),
    atualizadoEm: new Date(String(l['atualizado_em'])),
    ...(canceladoEm ? { canceladoEm } : {}),
    ...(motivo ? { motivoDoCancelamento: motivo } : {}),
  });
}

function paraRecebimento(l: Linha): Recebimento {
  const canceladoEm =
    typeof l['cancelado_em'] === 'string' ? new Date(l['cancelado_em']) : undefined;
  const motivo =
    typeof l['cancelado_motivo'] === 'string' && l['cancelado_motivo']
      ? l['cancelado_motivo']
      : undefined;
  const observacao =
    typeof l['observacao'] === 'string' && l['observacao'] ? l['observacao'] : undefined;
  return Object.freeze({
    id: String(l['id']),
    workspace: String(l['workspace']),
    numeroProcesso: String(l['numero']),
    data: String(l['data']),
    valorCentavos: Number(l['valor_centavos']),
    ...(observacao ? { observacao } : {}),
    criadoEm: new Date(String(l['criado_em'])),
    atualizadoEm: new Date(String(l['atualizado_em'])),
    ...(canceladoEm ? { canceladoEm } : {}),
    ...(motivo ? { motivoDoCancelamento: motivo } : {}),
  });
}

function paraCategoria(l: Linha): CategoriaDeCusto {
  return Object.freeze({
    id: String(l['id']),
    workspace: String(l['workspace']),
    nome: String(l['nome']),
    grupo: String(l['grupo'] ?? '12'),
    arquivada: Number(l['arquivada']) === 1,
    criadaEm: new Date(String(l['criada_em'])),
  });
}

function paraEvento(l: Linha): EventoDoHistorico {
  let campos: CampoAlterado[] = [];
  try {
    const bruto: unknown = JSON.parse(String(l['campos'] ?? '[]'));
    if (Array.isArray(bruto)) campos = bruto as CampoAlterado[];
  } catch {
    campos = [];
  }
  const motivo = typeof l['motivo'] === 'string' && l['motivo'] ? l['motivo'] : undefined;
  return Object.freeze({
    id: String(l['id']),
    workspace: String(l['workspace']),
    numeroProcesso: String(l['numero']),
    entidade: String(l['entidade']) as EntidadeDoHistorico,
    entidadeId: String(l['entidade_id']),
    operacao: String(l['operacao']) as OperacaoDoHistorico,
    quando: new Date(String(l['quando'])),
    campos,
    ...(motivo ? { motivo } : {}),
  });
}

/** `AND data >= ? AND data <= ?` para o período (datas AAAA-MM-DD, inclusive). */
function periodo(f: FiltroDePeriodo): { sql: string; args: string[] } {
  const args: string[] = [];
  let sql = '';
  if (f.de !== undefined) {
    sql += ' AND data >= ?';
    args.push(f.de);
  }
  if (f.ate !== undefined) {
    sql += ' AND data <= ?';
    args.push(f.ate);
  }
  return { sql, args };
}

function paraComprovante(l: Linha): Comprovante {
  return Object.freeze({
    id: String(l['id']),
    workspace: String(l['workspace']),
    custoId: String(l['custo_id']),
    numeroProcesso: String(l['numero']),
    arquivoId: String(l['arquivo_id']),
    link: String(l['link']),
    nome: String(l['nome']),
    tipo: String(l['tipo']) as TipoDeComprovante,
    tamanho: Number(l['tamanho']),
    anexadoEm: new Date(String(l['anexado_em'])),
  });
}
