import type { DatabaseSync } from 'node:sqlite';
import type {
  Acompanhamento,
  Novidade,
} from '../../../domain/entities/Acompanhamento.js';
import { nomeDaClasse } from '../../../domain/entities/nomeDaClasse.js';
import type { Movimentacao } from '../../../domain/entities/Movimentacao.js';
import type { Processo } from '../../../domain/entities/Processo.js';
import type {
  AcompanhamentoResumido,
  FiltroAcompanhamentos,
  FiltroNovidades,
  RepositorioAcompanhamentos,
} from '../../../domain/ports/RepositorioAcompanhamentos.js';
import type { ProcessoSerializado } from '../processoSerializacao.js';
import { paraBusca } from '../normalizacaoBusca.js';
import { reidratarProcesso, serializarProcesso } from '../processoSerializacao.js';

type Linha = Record<string, unknown>;

const texto = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const data = (v: unknown): Date | undefined => {
  const s = texto(v);
  return s ? new Date(s) : undefined;
};

export class RepositorioAcompanhamentosSqlite implements RepositorioAcompanhamentos {
  constructor(private readonly db: DatabaseSync) {}

  async acompanhar(
    workspace: string,
    numero: string,
    apelido?: string,
  ): Promise<Acompanhamento> {
    const agora = new Date().toISOString();
    // ON CONFLICT DO UPDATE do apelido: reacompanhar não pode apagar o retrato
    // nem o histórico de novidades já detectadas.
    this.db
      .prepare(
        `INSERT INTO acompanhamentos (workspace, numero, apelido, criado_em)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace, numero)
         DO UPDATE SET apelido = COALESCE(excluded.apelido, acompanhamentos.apelido)`,
      )
      .run(workspace, numero, apelido ?? null, agora);

    const criado = await this.buscar(workspace, numero);
    if (!criado) throw new Error('falha ao gravar acompanhamento');
    return criado;
  }

  async contarAcompanhamentos(workspace: string): Promise<number> {
    const linha = this.db
      .prepare('SELECT COUNT(*) AS n FROM acompanhamentos WHERE workspace = ?')
      .get(workspace) as unknown as { n: number };
    return Number(linha.n);
  }

  async deixarDeAcompanhar(workspace: string, numero: string): Promise<boolean> {
    const r = this.db
      .prepare('DELETE FROM acompanhamentos WHERE workspace = ? AND numero = ?')
      .run(workspace, numero);
    // As novidades vão junto: guardá-las órfãs faria o feed citar um processo
    // que o usuário deliberadamente parou de acompanhar.
    this.db
      .prepare('DELETE FROM novidades WHERE workspace = ? AND numero = ?')
      .run(workspace, numero);
    return Number(r.changes) > 0;
  }

  /**
   * Grava o rótulo de cliente. String vazia APAGA o rótulo.
   *
   * Sem COALESCE, ao contrário de `acompanhar`: aqui é preciso conseguir
   * limpar um rótulo digitado errado, e COALESCE tornaria isso impossível —
   * o advogado apagaria o campo, salvaria, e o nome errado continuaria lá.
   */
  async rotular(workspace: string, numero: string, cliente: string): Promise<boolean> {
    const limpo = cliente.trim();
    const r = this.db
      .prepare(
        'UPDATE acompanhamentos SET cliente = ? WHERE workspace = ? AND numero = ?',
      )
      .run(limpo || null, workspace, numero);
    return Number(r.changes) > 0;
  }

  async clientes(workspace: string): Promise<string[]> {
    const linhas = this.db
      .prepare(
        `SELECT DISTINCT cliente AS v FROM acompanhamentos
          WHERE workspace = ? AND cliente IS NOT NULL AND TRIM(cliente) <> ''
          ORDER BY v COLLATE NOCASE`,
      )
      .all(workspace) as Linha[];
    return linhas.map((l) => String(l['v']));
  }

  async buscar(workspace: string, numero: string): Promise<Acompanhamento | undefined> {
    const linha = this.db
      .prepare('SELECT * FROM acompanhamentos WHERE workspace = ? AND numero = ?')
      .get(workspace, numero) as Linha | undefined;
    return linha ? this.paraAcompanhamento(linha) : undefined;
  }

  async listar(
    workspace: string,
    filtro: FiltroAcompanhamentos = {},
  ): Promise<AcompanhamentoResumido[]> {
    const cond: string[] = ['a.workspace = ?'];
    const args: Array<string | number> = [workspace];

    if (filtro.tribunal) {
      cond.push('a.tribunal = ?');
      args.push(filtro.tribunal);
    }
    if (filtro.classe) {
      // O filtro vem com o nome NORMALIZADO que a faceta oferece; o banco guarda
      // cada grafia como o tribunal mandou. Casa com todas as variantes cruas que
      // normalizam igual — sem migrar nada e sem mudar o que está gravado.
      const variantes = this.variantesDaClasse(workspace, filtro.classe);
      cond.push(`a.classe IN (${variantes.map(() => '?').join(', ')})`);
      args.push(...variantes);
    }
    if (filtro.parte) {
      // `paraBusca` nas DUAS pontas — a mesma função que gravou a coluna. O
      // advogado digita "sunsquare" e o tribunal gravou "CONDOMINIO
      // SUNSQUARE"; digita "jose" e está gravado "JOSÉ". Divergir aqui faria o
      // filtro achar uns nomes e não outros, sem erro nenhum.
      cond.push('a.partes_texto LIKE ?');
      args.push(`%${paraBusca(filtro.parte)}%`);
    }

    if (filtro.cliente) {
      cond.push("IFNULL(a.cliente, '') LIKE ?");
      args.push(`%${filtro.cliente}%`);
    }

    if (filtro.texto) {
      // O JSON do processo entra na busca livre para pegar vara e assunto sem
      // desnormalizar mais colunas. Volume por workspace é pequeno.
      // Aspas SIMPLES: no SQLite, aspas duplas são identificador, não string.
      cond.push(
        "(a.numero LIKE ? OR IFNULL(a.apelido,'') LIKE ? OR IFNULL(a.cliente,'') LIKE ? " +
          "OR IFNULL(a.processo,'') LIKE ?)",
      );
      const alvo = `%${filtro.texto.replace(/\D/g, '') || filtro.texto}%`;
      args.push(alvo, `%${filtro.texto}%`, `%${filtro.texto}%`, `%${filtro.texto}%`);
    }
    if (filtro.movimentadoNosUltimosDias !== undefined) {
      const limite = new Date(
        Date.now() - filtro.movimentadoNosUltimosDias * 86_400_000,
      ).toISOString();
      cond.push('a.ultima_mov_data >= ?');
      args.push(limite);
    }

    if (filtro.somenteComNovidade) {
      // Vai no WHERE e não num HAVING: a contagem é subconsulta correlacionada,
      // não agregação — SQLite recusa HAVING sem GROUP BY.
      cond.push(
        `EXISTS (SELECT 1 FROM novidades n
                  WHERE n.workspace = a.workspace AND n.numero = a.numero
                    AND n.vista_em IS NULL)`,
      );
    }

    const ordem =
      filtro.ordem === 'ADICIONADO_RECENTE'
        ? 'a.criado_em DESC'
        : filtro.ordem === 'NUMERO'
          ? 'a.numero ASC'
          : 'a.ultima_mov_data DESC NULLS LAST';

    const linhas = this.db
      .prepare(
        `SELECT a.*,
                (SELECT COUNT(*) FROM novidades n
                  WHERE n.workspace = a.workspace AND n.numero = a.numero
                    AND n.vista_em IS NULL) AS nao_vistas
           FROM acompanhamentos a
          WHERE ${cond.join(' AND ')}
          ORDER BY ${ordem}`,
      )
      .all(...args) as Linha[];

    return linhas.map((l) => {
      const base = this.paraAcompanhamento(l);
      const ultima = base.processo?.ultimaMovimentacao;
      return {
        ...base,
        novidadesNaoVistas: Number(l['nao_vistas'] ?? 0),
        ...(ultima ? { ultimaMovimentacao: ultima } : {}),
      };
    });
  }

  async listarParaSincronizar(
    limite: number,
    workspace?: string,
  ): Promise<Acompanhamento[]> {
    // Nunca sincronizados primeiro, depois os mais antigos. Assim quem acabou
    // de ser adicionado recebe o primeiro retrato logo.
    //
    // Sem `workspace` é a varredura agendada, que precisa ver todo mundo. COM
    // `workspace` é alguém clicando em "verificar agora", e aí só os processos
    // dele — senão uma conta dispara consulta ao tribunal sobre a carteira
    // alheia e gasta a cota compartilhada do CNJ em nome dos outros.
    const linhas = workspace
      ? (this.db
          .prepare(
            `SELECT * FROM acompanhamentos
              WHERE workspace = ?
              ORDER BY (sincronizado_em IS NULL) DESC, sincronizado_em ASC
              LIMIT ?`,
          )
          .all(workspace, limite) as Linha[])
      : (this.db
          .prepare(
            `SELECT * FROM acompanhamentos
              ORDER BY (sincronizado_em IS NULL) DESC, sincronizado_em ASC
              LIMIT ?`,
          )
          .all(limite) as Linha[]);
    return linhas.map((l) => this.paraAcompanhamento(l));
  }

  async registrarSincronizacao(
    workspace: string,
    numero: string,
    processo: Processo,
    novidades: readonly Movimentacao[],
  ): Promise<void> {
    const agora = new Date().toISOString();
    const serializado = JSON.stringify(serializarProcesso(processo));
    const ultima = processo.ultimaMovimentacao?.data.toISOString() ?? null;

    // Tudo numa transação: retrato e novidades têm que avançar juntos. Se o
    // retrato gravasse sem as novidades, elas nunca mais seriam detectadas —
    // na próxima varredura já fariam parte do "conhecido".
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE acompanhamentos
              SET processo = ?, sincronizado_em = ?, erro = NULL,
                  tribunal = ?, classe = ?, ultima_mov_data = ?,
                  partes_texto = ?
            WHERE workspace = ? AND numero = ?`,
        )
        .run(
          serializado,
          agora,
          processo.tribunal,
          processo.classe ?? null,
          ultima,
          textoDasPartes(processo),
          workspace,
          numero,
        );

      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO novidades
           (workspace, numero, data, titulo, codigo_tpu, conteudo, tribunal, detectada_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of novidades) {
        ins.run(
          workspace,
          numero,
          m.data.toISOString(),
          m.titulo,
          m.codigoTpu ?? null,
          m.conteudo ?? null,
          processo.tribunal,
          agora,
        );
      }
      this.db.exec('COMMIT');
    } catch (erro) {
      this.db.exec('ROLLBACK');
      throw erro;
    }
  }

  async registrarFalha(workspace: string, numero: string, erro: string): Promise<void> {
    // `sincronizado_em` NÃO avança numa falha — ele é "último sucesso". Mas
    // registramos a tentativa para a fila não ficar presa no mesmo item.
    this.db
      .prepare(
        `UPDATE acompanhamentos SET erro = ?
          WHERE workspace = ? AND numero = ?`,
      )
      .run(erro.slice(0, 500), workspace, numero);
  }

  async listarNovidades(
    workspace: string,
    filtro: FiltroNovidades = {},
  ): Promise<Novidade[]> {
    const cond = ['workspace = ?'];
    const args: Array<string | number> = [workspace];

    if (filtro.numero) {
      cond.push('numero = ?');
      args.push(filtro.numero);
    }
    if (filtro.tribunal) {
      cond.push('tribunal = ?');
      args.push(filtro.tribunal);
    }
    if (filtro.somenteNaoVistas) cond.push('vista_em IS NULL');
    if (filtro.desde) {
      cond.push('detectada_em >= ?');
      args.push(filtro.desde.toISOString());
    }

    args.push(filtro.limite ?? 200);

    const linhas = this.db
      .prepare(
        `SELECT * FROM novidades
          WHERE ${cond.join(' AND ')}
          ORDER BY detectada_em DESC, data DESC
          LIMIT ?`,
      )
      .all(...args) as Linha[];

    return linhas.map((l) => ({
      id: Number(l['id']),
      workspace: String(l['workspace']),
      numero: String(l['numero']),
      data: new Date(String(l['data'])),
      titulo: String(l['titulo']),
      ...(l['codigo_tpu'] !== null && l['codigo_tpu'] !== undefined
        ? { codigoTpu: Number(l['codigo_tpu']) }
        : {}),
      ...(texto(l['conteudo']) ? { conteudo: String(l['conteudo']) } : {}),
      detectadaEm: new Date(String(l['detectada_em'])),
      ...(data(l['vista_em']) ? { vistaEm: data(l['vista_em']) as Date } : {}),
    }));
  }

  async contarNaoVistas(workspace: string): Promise<number> {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM novidades WHERE workspace = ? AND vista_em IS NULL',
      )
      .get(workspace) as Linha;
    return Number(r['n'] ?? 0);
  }

  async marcarComoVistas(workspace: string, numero?: string): Promise<number> {
    const agora = new Date().toISOString();
    const r = numero
      ? this.db
          .prepare(
            `UPDATE novidades SET vista_em = ?
              WHERE workspace = ? AND numero = ? AND vista_em IS NULL`,
          )
          .run(agora, workspace, numero)
      : this.db
          .prepare(
            'UPDATE novidades SET vista_em = ? WHERE workspace = ? AND vista_em IS NULL',
          )
          .run(agora, workspace);
    return Number(r.changes);
  }

  async facetas(workspace: string): Promise<{ tribunais: string[]; classes: string[] }> {
    const col = (nome: string): string[] =>
      (
        this.db
          .prepare(
            `SELECT DISTINCT ${nome} AS v FROM acompanhamentos
              WHERE workspace = ? AND ${nome} IS NOT NULL ORDER BY v`,
          )
          .all(workspace) as Linha[]
      ).map((l) => String(l['v']));

    // Uma opção por classe NORMALIZADA: "PROCEDIMENTO COMUM CíVEL" (DJEN) e
    // "Procedimento Comum Cível" (DataJud) são a mesma classe.
    const classes = [
      ...new Set(
        col('classe')
          .map(nomeDaClasse)
          .filter((c) => c !== ''),
      ),
    ];
    classes.sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return { tribunais: col('tribunal'), classes };
  }

  /** Grafias cruas guardadas que normalizam igual ao nome pedido (nunca vazio). */
  private variantesDaClasse(workspace: string, pedido: string): string[] {
    const alvo = nomeDaClasse(pedido);
    const guardadas = (
      this.db
        .prepare(
          `SELECT DISTINCT classe AS v FROM acompanhamentos
            WHERE workspace = ? AND classe IS NOT NULL`,
        )
        .all(workspace) as Linha[]
    ).map((l) => String(l['v']));
    const casam = guardadas.filter((v) => nomeDaClasse(v) === alvo);
    // Nada casa: devolve o pedido cru, e o filtro corretamente não acha nada.
    return casam.length > 0 ? casam : [pedido];
  }

  private paraAcompanhamento(l: Linha): Acompanhamento {
    const bruto = texto(l['processo']);
    const processo = bruto
      ? reidratarProcesso(JSON.parse(bruto) as ProcessoSerializado, true)
      : undefined;

    return {
      workspace: String(l['workspace']),
      numero: String(l['numero']),
      ...(texto(l['apelido']) ? { apelido: String(l['apelido']) } : {}),
      ...(texto(l['cliente']) ? { cliente: String(l['cliente']) } : {}),
      criadoEm: new Date(String(l['criado_em'])),
      ...(data(l['sincronizado_em'])
        ? { sincronizadoEm: data(l['sincronizado_em']) as Date }
        : {}),
      ...(texto(l['erro']) ? { erro: String(l['erro']) } : {}),
      ...(processo ? { processo } : {}),
    };
  }
}

/**
 * Nomes das partes num só texto, em maiúsculas, para a coluna desnormalizada.
 *
 * Normalizado na GRAVAÇÃO, e não só na consulta: o `LIKE` do SQLite é
 * insensível a caixa apenas para ASCII, e nome brasileiro tem acento. Ver
 * `paraBusca` para o porquê de dobrar o acento também.
 */
function textoDasPartes(processo: Processo): string {
  const nomes = processo.partes.map((p) => p.nome.trim()).filter(Boolean);
  // String vazia, não NULL: NULL faria a retrocarga do arranque revisitar
  // este processo para sempre.
  return nomes.length > 0 ? paraBusca(nomes.join(' | ')) : '';
}
