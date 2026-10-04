import type { DatabaseSync } from 'node:sqlite';
import { Oab } from '../../../domain/entities/Oab.js';
import type { VigilanciaOab } from '../../../domain/entities/VigilanciaOab.js';
import type { RepositorioVigilancias } from '../../../domain/ports/RepositorioVigilancias.js';

interface LinhaVigilancia {
  workspace: string;
  oab: string;
  uf: string;
  apelido: string | null;
  criada_em: string;
  varrida_em: string | null;
  erro: string | null;
  processos_encontrados: number;
  ativa: number;
}

function paraDominio(l: LinhaVigilancia): VigilanciaOab {
  return {
    workspace: l.workspace,
    oab: Oab.criar(l.oab, l.uf),
    criadaEm: new Date(l.criada_em),
    processosEncontrados: l.processos_encontrados,
    ativa: l.ativa === 1,
    ...(l.apelido ? { apelido: l.apelido } : {}),
    ...(l.varrida_em ? { varridaEm: new Date(l.varrida_em) } : {}),
    ...(l.erro ? { erro: l.erro } : {}),
  };
}

export class RepositorioVigilanciasSqlite implements RepositorioVigilancias {
  constructor(private readonly db: DatabaseSync) {}

  async vigiar(
    workspace: string,
    oab: string,
    uf: string,
    apelido?: string,
  ): Promise<VigilanciaOab> {
    // Passa pelo value object antes de gravar: é o que garante que "12.345" e
    // "12345" não virem duas vigilâncias da mesma inscrição.
    const inscricao = Oab.criar(oab, uf);

    this.db
      .prepare(
        `INSERT INTO vigilancias_oab (workspace, oab, uf, apelido, criada_em, ativa)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (workspace, oab, uf) DO UPDATE SET
           apelido = COALESCE(excluded.apelido, vigilancias_oab.apelido),
           -- Recadastrar reativa, mas NÃO zera varrida_em: perder essa marca
           -- faria a varredura seguinte olhar 30 dias para trás de novo e
           -- ressuscitar como novidade tudo o que já havia sido visto.
           ativa = 1,
           erro = NULL`,
      )
      .run(
        workspace,
        inscricao.numero,
        inscricao.uf,
        apelido ?? null,
        new Date().toISOString(),
      );

    const criada = this.umaLinha(workspace, inscricao.numero, inscricao.uf);
    if (!criada) throw new Error('falha ao gravar vigilância de OAB');
    return criada;
  }

  async parar(workspace: string, oab: string, uf: string): Promise<boolean> {
    const inscricao = Oab.criar(oab, uf);
    // Desativa em vez de apagar: o histórico de quantos processos aquela
    // inscrição trouxe continua valendo, e religar não recomeça do zero.
    const r = this.db
      .prepare(
        `UPDATE vigilancias_oab SET ativa = 0
         WHERE workspace = ? AND oab = ? AND uf = ? AND ativa = 1`,
      )
      .run(workspace, inscricao.numero, inscricao.uf);
    return Number(r.changes) > 0;
  }

  async listar(workspace: string): Promise<VigilanciaOab[]> {
    const linhas = this.db
      .prepare(
        `SELECT * FROM vigilancias_oab WHERE workspace = ?
         ORDER BY ativa DESC, criada_em DESC`,
      )
      .all(workspace) as unknown as LinhaVigilancia[];
    return linhas.map(paraDominio);
  }

  async listarParaVarrer(limite: number, workspace?: string): Promise<VigilanciaOab[]> {
    // Quem nunca foi varrido primeiro (varrida_em NULL ordena antes), depois a
    // mais antiga. Sem isso, uma vigilância recém-criada esperaria a fila
    // inteira antes da primeira carga.
    //
    // Com `workspace`, só as dele — é a varredura manual. Sem, todas, que é a
    // agendada.
    const linhas = (
      workspace
        ? this.db
            .prepare(
              `SELECT * FROM vigilancias_oab WHERE ativa = 1 AND workspace = ?
               ORDER BY varrida_em IS NOT NULL, varrida_em ASC
               LIMIT ?`,
            )
            .all(workspace, limite)
        : this.db
            .prepare(
              `SELECT * FROM vigilancias_oab WHERE ativa = 1
               ORDER BY varrida_em IS NOT NULL, varrida_em ASC
               LIMIT ?`,
            )
            .all(limite)
    ) as unknown as LinhaVigilancia[];
    return linhas.map(paraDominio);
  }

  async registrarVarredura(
    workspace: string,
    oab: string,
    uf: string,
    varridaEm: Date,
    processosEncontrados: number,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE vigilancias_oab
         SET varrida_em = ?, erro = NULL,
             processos_encontrados = processos_encontrados + ?
         WHERE workspace = ? AND oab = ? AND uf = ?`,
      )
      .run(varridaEm.toISOString(), processosEncontrados, workspace, oab, uf);
  }

  async registrarFalha(
    workspace: string,
    oab: string,
    uf: string,
    erro: string,
  ): Promise<void> {
    // `varrida_em` NÃO é atualizado na falha, de propósito: a próxima varredura
    // precisa cobrir a janela que esta não conseguiu ler. Marcar como varrido
    // abriria um buraco silencioso no período exato em que a fonte esteve fora.
    this.db
      .prepare(
        `UPDATE vigilancias_oab SET erro = ?
         WHERE workspace = ? AND oab = ? AND uf = ?`,
      )
      .run(erro.slice(0, 500), workspace, oab, uf);
  }

  private umaLinha(
    workspace: string,
    oab: string,
    uf: string,
  ): VigilanciaOab | undefined {
    const linha = this.db
      .prepare(
        `SELECT * FROM vigilancias_oab WHERE workspace = ? AND oab = ? AND uf = ?`,
      )
      .get(workspace, oab, uf) as unknown as LinhaVigilancia | undefined;
    return linha ? paraDominio(linha) : undefined;
  }
}
