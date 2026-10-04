import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type {
  AncoraGuardada,
  ListagemDaPasta,
  PecaEmCache,
} from '../../../domain/entities/PastaDigital.js';
import type { RepositorioDaPasta } from '../../../domain/ports/RepositorioDaPasta.js';

/** O JSON da listagem é dado nosso, mas passa por Zod: linha velha ou editada à mão. */
const pecaListadaSchema = z.object({
  pecaId: z.string(),
  ordem: z.number().int().nonnegative(),
  rotulo: z.string(),
  data: z.string().optional(),
  movimento: z.number().int().optional(),
  movimentacao: z
    .object({
      numero: z.number().int(),
      posicao: z.number().int().positive().optional(),
      data: z.string(),
      descricao: z.string(),
      complemento: z.string().optional(),
    })
    .optional(),
  mimetype: z.string().optional(),
  sigilosa: z.boolean(),
});

interface LinhaListagem {
  numero: string;
  tribunal: string;
  listada_em: string;
  processo_sigiloso: number;
  pecas: string;
  total_atos_recebidos: number | null;
  datas_dos_atos: string | null;
  ancoras_invalidadas: number | null;
}

interface LinhaPeca {
  workspace: string;
  numero: string;
  peca_id: string;
  localizador: string;
  mimetype_original: string;
  conversao: string;
  observacao: string | null;
  bytes: number;
  paginas: number;
  obtida_em: string;
  expira_em: string;
}

const CONVERSOES = z.enum(['nenhuma', 'imagem', 'html']);

export class RepositorioDaPastaSqlite implements RepositorioDaPasta {
  constructor(private readonly db: DatabaseSync) {}

  async guardarListagem(workspace: string, l: ListagemDaPasta): Promise<void> {
    const pecas = l.pecas.map((p) => ({
      ...p,
      data: p.data?.toISOString(),
      ...(p.movimentacao
        ? { movimentacao: { ...p.movimentacao, data: p.movimentacao.data.toISOString() } }
        : {}),
    }));
    this.db
      .prepare(
        `INSERT INTO pasta_listagens
           (workspace, numero, tribunal, listada_em, processo_sigiloso, pecas,
            total_atos_recebidos, datas_dos_atos, ancoras_invalidadas)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace, numero) DO UPDATE SET
           tribunal = excluded.tribunal,
           listada_em = excluded.listada_em,
           processo_sigiloso = excluded.processo_sigiloso,
           pecas = excluded.pecas,
           total_atos_recebidos = excluded.total_atos_recebidos,
           datas_dos_atos = excluded.datas_dos_atos,
           ancoras_invalidadas = excluded.ancoras_invalidadas`,
      )
      .run(
        workspace,
        l.numeroProcesso,
        l.tribunal,
        l.listadaEm.toISOString(),
        l.processoSigiloso ? 1 : 0,
        JSON.stringify(pecas),
        l.totalAtosRecebidos ?? null,
        l.datasDosAtos
          ? JSON.stringify(l.datasDosAtos.map((d) => d.toISOString()))
          : null,
        l.ancorasInvalidadas ?? null,
      );
  }

  async obterListagem(
    workspace: string,
    numeroProcesso: string,
  ): Promise<ListagemDaPasta | undefined> {
    const linha = this.db
      .prepare(
        `SELECT numero, tribunal, listada_em, processo_sigiloso, pecas, total_atos_recebidos,
                datas_dos_atos, ancoras_invalidadas
           FROM pasta_listagens WHERE workspace = ? AND numero = ?`,
      )
      .get(workspace, numeroProcesso) as unknown as LinhaListagem | undefined;
    if (!linha) return undefined;
    const pecas = z.array(pecaListadaSchema).parse(JSON.parse(linha.pecas));
    return {
      numeroProcesso: linha.numero,
      tribunal: linha.tribunal,
      listadaEm: new Date(linha.listada_em),
      processoSigiloso: linha.processo_sigiloso === 1,
      ...(linha.total_atos_recebidos !== null
        ? { totalAtosRecebidos: linha.total_atos_recebidos }
        : {}),
      ...(linha.datas_dos_atos !== null
        ? {
            datasDosAtos: z
              .array(z.string())
              .parse(JSON.parse(linha.datas_dos_atos))
              .map((d) => new Date(d)),
          }
        : {}),
      ...(linha.ancoras_invalidadas
        ? { ancorasInvalidadas: linha.ancoras_invalidadas }
        : {}),
      pecas: pecas.map((p) => ({
        pecaId: p.pecaId,
        ordem: p.ordem,
        rotulo: p.rotulo,
        sigilosa: p.sigilosa,
        ...(p.data !== undefined ? { data: new Date(p.data) } : {}),
        ...(p.movimento !== undefined ? { movimento: p.movimento } : {}),
        ...(p.movimentacao !== undefined
          ? {
              movimentacao: {
                numero: p.movimentacao.numero,
                ...(p.movimentacao.posicao !== undefined
                  ? { posicao: p.movimentacao.posicao }
                  : {}),
                data: new Date(p.movimentacao.data),
                descricao: p.movimentacao.descricao,
                ...(p.movimentacao.complemento !== undefined
                  ? { complemento: p.movimentacao.complemento }
                  : {}),
              },
            }
          : {}),
        ...(p.mimetype !== undefined ? { mimetype: p.mimetype } : {}),
      })),
    };
  }

  async guardarPeca(p: PecaEmCache): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pasta_pecas
           (workspace, numero, peca_id, localizador, mimetype_original, conversao,
            observacao, bytes, paginas, obtida_em, expira_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace, numero, peca_id) DO UPDATE SET
           localizador = excluded.localizador,
           mimetype_original = excluded.mimetype_original,
           conversao = excluded.conversao,
           observacao = excluded.observacao,
           bytes = excluded.bytes,
           paginas = excluded.paginas,
           obtida_em = excluded.obtida_em,
           expira_em = excluded.expira_em`,
      )
      .run(
        p.workspace,
        p.numeroProcesso,
        p.pecaId,
        p.localizador,
        p.mimetypeOriginal,
        p.conversao,
        p.observacao ?? null,
        p.bytes,
        p.paginas,
        p.obtidaEm.toISOString(),
        p.expiraEm.toISOString(),
      );
  }

  async obterPeca(
    workspace: string,
    numeroProcesso: string,
    pecaId: string,
  ): Promise<PecaEmCache | undefined> {
    const linha = this.db
      .prepare(
        'SELECT * FROM pasta_pecas WHERE workspace = ? AND numero = ? AND peca_id = ?',
      )
      .get(workspace, numeroProcesso, pecaId) as unknown as LinhaPeca | undefined;
    return linha ? lerPeca(linha) : undefined;
  }

  async doProcesso(workspace: string, numeroProcesso: string): Promise<PecaEmCache[]> {
    const linhas = this.db
      .prepare('SELECT * FROM pasta_pecas WHERE workspace = ? AND numero = ?')
      .all(workspace, numeroProcesso) as unknown as LinhaPeca[];
    return linhas.map(lerPeca);
  }

  async doWorkspace(workspace: string): Promise<PecaEmCache[]> {
    const linhas = this.db
      .prepare('SELECT * FROM pasta_pecas WHERE workspace = ?')
      .all(workspace) as unknown as LinhaPeca[];
    return linhas.map(lerPeca);
  }

  async apagarPeca(
    workspace: string,
    numeroProcesso: string,
    pecaId: string,
  ): Promise<void> {
    this.db
      .prepare(
        'DELETE FROM pasta_pecas WHERE workspace = ? AND numero = ? AND peca_id = ?',
      )
      .run(workspace, numeroProcesso, pecaId);
  }

  async vencidas(agora: Date): Promise<PecaEmCache[]> {
    const linhas = this.db
      .prepare('SELECT * FROM pasta_pecas WHERE expira_em <= ?')
      .all(agora.toISOString()) as unknown as LinhaPeca[];
    return linhas.map(lerPeca);
  }

  async ancorasDoProcesso(
    workspace: string,
    numeroProcesso: string,
  ): Promise<AncoraGuardada[]> {
    const linhas = this.db
      .prepare(
        `SELECT posicao, numero_projudi, data_hora_do_ato, criada_em
           FROM pasta_ancoras WHERE workspace = ? AND numero = ? ORDER BY posicao`,
      )
      .all(workspace, numeroProcesso) as unknown as Array<{
      posicao: number;
      numero_projudi: number;
      data_hora_do_ato: string;
      criada_em: string;
    }>;
    return linhas.map((l) => ({
      posicao: l.posicao,
      numeroProjudi: l.numero_projudi,
      dataHoraDoAto: new Date(l.data_hora_do_ato),
      criadaEm: new Date(l.criada_em),
    }));
  }

  async guardarAncora(
    workspace: string,
    numeroProcesso: string,
    a: AncoraGuardada,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pasta_ancoras
           (workspace, numero, posicao, numero_projudi, data_hora_do_ato, criada_em)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace, numero, posicao) DO UPDATE SET
           numero_projudi = excluded.numero_projudi,
           data_hora_do_ato = excluded.data_hora_do_ato,
           criada_em = excluded.criada_em`,
      )
      .run(
        workspace,
        numeroProcesso,
        a.posicao,
        a.numeroProjudi,
        a.dataHoraDoAto.toISOString(),
        a.criadaEm.toISOString(),
      );
  }

  async removerAncora(
    workspace: string,
    numeroProcesso: string,
    posicao: number,
  ): Promise<boolean> {
    const r = this.db
      .prepare(
        'DELETE FROM pasta_ancoras WHERE workspace = ? AND numero = ? AND posicao = ?',
      )
      .run(workspace, numeroProcesso, posicao);
    return Number(r.changes) > 0;
  }

  async limparAncoras(workspace: string, numeroProcesso: string): Promise<number> {
    const r = this.db
      .prepare('DELETE FROM pasta_ancoras WHERE workspace = ? AND numero = ?')
      .run(workspace, numeroProcesso);
    return Number(r.changes);
  }

  async zerarAncorasInvalidadas(
    workspace: string,
    numeroProcesso: string,
  ): Promise<void> {
    this.db
      .prepare(
        'UPDATE pasta_listagens SET ancoras_invalidadas = NULL WHERE workspace = ? AND numero = ?',
      )
      .run(workspace, numeroProcesso);
  }

  async apagarDoWorkspace(workspace: string): Promise<number> {
    const c = this.db
      .prepare('DELETE FROM pasta_ancoras WHERE workspace = ?')
      .run(workspace);
    const a = this.db
      .prepare('DELETE FROM pasta_pecas WHERE workspace = ?')
      .run(workspace);
    const b = this.db
      .prepare('DELETE FROM pasta_listagens WHERE workspace = ?')
      .run(workspace);
    return Number(a.changes) + Number(b.changes) + Number(c.changes);
  }
}

function lerPeca(l: LinhaPeca): PecaEmCache {
  return {
    workspace: l.workspace,
    numeroProcesso: l.numero,
    pecaId: l.peca_id,
    localizador: l.localizador,
    mimetypeOriginal: l.mimetype_original,
    conversao: CONVERSOES.parse(l.conversao),
    ...(l.observacao !== null ? { observacao: l.observacao } : {}),
    bytes: l.bytes,
    paginas: l.paginas,
    obtidaEm: new Date(l.obtida_em),
    expiraEm: new Date(l.expira_em),
  };
}
