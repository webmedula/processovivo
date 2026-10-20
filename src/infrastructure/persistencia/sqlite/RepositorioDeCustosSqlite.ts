import type { DatabaseSync } from 'node:sqlite';
import { chaveDoNomeDeCategoria } from '../../../domain/entities/Custo.js';
import type { CategoriaDeCusto, Custo } from '../../../domain/entities/Custo.js';
import type { RepositorioDeCustos } from '../../../domain/ports/RepositorioDeCustos.js';

type Linha = Record<string, unknown>;

/**
 * Centro de custos em SQLite (v0.47.0). Toda consulta leva `workspace = ?` — não existe leitura
 * por id sozinho. Nada daqui chega a log: valor, descrição e nome de categoria são dado do cliente
 * do advogado.
 */
export class RepositorioDeCustosSqlite implements RepositorioDeCustos {
  constructor(private readonly db: DatabaseSync) {}

  async listar(workspace: string, numeroProcesso: string): Promise<Custo[]> {
    const linhas = this.db
      .prepare(
        `SELECT * FROM custos_processo WHERE workspace = ? AND numero = ?
         ORDER BY data DESC, criado_em DESC, id DESC`,
      )
      .all(workspace, numeroProcesso) as Linha[];
    return linhas.map(paraCusto);
  }

  async contar(workspace: string, numeroProcesso: string): Promise<number> {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM custos_processo WHERE workspace = ? AND numero = ?',
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

  async inserir(c: Custo): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO custos_processo
           (workspace, id, numero, data, descricao, categoria, valor_centavos, reembolsavel,
            ressarcido_em, criado_em, atualizado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        c.ressarcidoEm ?? null,
        c.criadoEm.toISOString(),
        c.atualizadoEm.toISOString(),
      );
  }

  async atualizar(c: Custo): Promise<boolean> {
    const r = this.db
      .prepare(
        `UPDATE custos_processo SET
           data = ?, descricao = ?, categoria = ?, valor_centavos = ?, reembolsavel = ?,
           ressarcido_em = ?, atualizado_em = ?
         WHERE workspace = ? AND id = ?`,
      )
      .run(
        c.data,
        c.descricao,
        c.categoria,
        c.valorCentavos,
        c.reembolsavel ? 1 : 0,
        c.ressarcidoEm ?? null,
        c.atualizadoEm.toISOString(),
        c.workspace,
        c.id,
      );
    return Number(r.changes) > 0;
  }

  async excluir(workspace: string, id: string): Promise<boolean> {
    const r = this.db
      .prepare('DELETE FROM custos_processo WHERE workspace = ? AND id = ?')
      .run(workspace, id);
    return Number(r.changes) > 0;
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
        `INSERT INTO categorias_custo (workspace, id, nome, nome_chave, arquivada, criada_em)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.workspace,
        c.id,
        c.nome,
        chaveDoNomeDeCategoria(c.nome),
        c.arquivada ? 1 : 0,
        c.criadaEm.toISOString(),
      );
  }

  async atualizarCategoria(c: CategoriaDeCusto): Promise<boolean> {
    const r = this.db
      .prepare('UPDATE categorias_custo SET arquivada = ? WHERE workspace = ? AND id = ?')
      .run(c.arquivada ? 1 : 0, c.workspace, c.id);
    return Number(r.changes) > 0;
  }

  async apagarDoWorkspace(workspace: string): Promise<number> {
    let n = 0;
    for (const tabela of ['custos_processo', 'categorias_custo']) {
      n += Number(
        this.db.prepare(`DELETE FROM ${tabela} WHERE workspace = ?`).run(workspace)
          .changes,
      );
    }
    return n;
  }
}

function paraCusto(l: Linha): Custo {
  const ressarcidoEm =
    typeof l['ressarcido_em'] === 'string' ? l['ressarcido_em'] : undefined;
  return Object.freeze({
    id: String(l['id']),
    workspace: String(l['workspace']),
    numeroProcesso: String(l['numero']),
    data: String(l['data']),
    descricao: String(l['descricao']),
    categoria: String(l['categoria']),
    valorCentavos: Number(l['valor_centavos']),
    reembolsavel: Number(l['reembolsavel']) === 1,
    ...(ressarcidoEm !== undefined ? { ressarcidoEm } : {}),
    criadoEm: new Date(String(l['criado_em'])),
    atualizadoEm: new Date(String(l['atualizado_em'])),
  });
}

function paraCategoria(l: Linha): CategoriaDeCusto {
  return Object.freeze({
    id: String(l['id']),
    workspace: String(l['workspace']),
    nome: String(l['nome']),
    arquivada: Number(l['arquivada']) === 1,
    criadaEm: new Date(String(l['criada_em'])),
  });
}
