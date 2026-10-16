import type { DatabaseSync } from 'node:sqlite';
import type {
  AutorizacaoDoDestino,
  ConexaoComDestino,
  EstadoDaConexao,
  EstadoDaPecaNoDestino,
  MotivoDoErroDaConexao,
  PastaDoProcessoNoDestino,
  PastaNoDestino,
  PecaNoDestino,
} from '../../../domain/entities/DestinoDePecas.js';
import type { Logger } from '../../../domain/ports/Logger.js';
import type { RepositorioDoDrive } from '../../../domain/ports/RepositorioDoDrive.js';
import { loggerSilencioso } from '../../logging/ConsoleLogger.js';
import type { Cofre } from '../../seguranca/cofre.js';
import { SegredoIlegivelError } from '../../seguranca/cofre.js';

interface LinhaConexao {
  workspace: string;
  estado: string;
  pasta_raiz_id: string | null;
  pasta_raiz_link: string | null;
  tokens_cifrados: string | null;
  conectada_em: string;
  verificada_em: string | null;
  motivo_do_ultimo_erro: string | null;
}

interface LinhaPeca {
  workspace: string;
  numero: string;
  peca_id: string;
  arquivo_id: string;
  hash: string;
  nome: string;
  estado: string;
  enviada_em: string;
  atualizada_em: string | null;
}

const ESTADOS: readonly EstadoDaConexao[] = [
  'conectado',
  'precisa_reconectar',
  'desconectado',
];
const MOTIVOS: readonly MotivoDoErroDaConexao[] = [
  'autorizacao_revogada',
  'escopo_negado',
  'pasta_raiz_recriada',
];
const ESTADOS_DA_PECA: readonly EstadoDaPecaNoDestino[] = [
  'no_destino',
  'removida_no_destino',
  'desconectada',
];

function paraConexao(l: LinhaConexao): ConexaoComDestino {
  const estado = ESTADOS.find((e) => e === l.estado) ?? 'desconectado';
  const motivo = MOTIVOS.find((m) => m === l.motivo_do_ultimo_erro);
  return {
    workspace: l.workspace,
    estado,
    pastaRaiz:
      l.pasta_raiz_id && l.pasta_raiz_link
        ? { id: l.pasta_raiz_id, link: l.pasta_raiz_link }
        : undefined,
    conectadaEm: new Date(l.conectada_em),
    verificadaEm: l.verificada_em ? new Date(l.verificada_em) : undefined,
    motivoDoUltimoErro: motivo,
  };
}

function paraPeca(l: LinhaPeca): PecaNoDestino {
  return {
    workspace: l.workspace,
    numeroProcesso: l.numero,
    pecaId: l.peca_id,
    arquivoId: l.arquivo_id,
    hash: l.hash,
    nome: l.nome,
    estado: ESTADOS_DA_PECA.find((e) => e === l.estado) ?? 'no_destino',
    enviadaEm: new Date(l.enviada_em),
    atualizadaEm: l.atualizada_em ? new Date(l.atualizada_em) : undefined,
  };
}

/**
 * Persistência do Drive em SQLite. A autorização do Google vai CIFRADA na coluna
 * `tokens_cifrados`, pelo mesmo cofre (AES-256-GCM) que guarda a senha do tribunal.
 *
 * O que este repositório nunca faz: **não escreve token em log**, nem dentro de objeto
 * de contexto, nem em mensagem de erro. É o vazamento que não aparece em auditoria,
 * porque parece inofensivo na linha em que é escrito.
 */
export class RepositorioDoDriveSqlite implements RepositorioDoDrive {
  private readonly logger: Logger;

  constructor(
    private readonly db: DatabaseSync,
    private readonly cofre: Cofre,
    logger?: Logger,
  ) {
    this.logger = (logger ?? loggerSilencioso).child({ componente: 'drive-repositorio' });
  }

  async conexao(workspace: string): Promise<ConexaoComDestino | undefined> {
    const l = this.db
      .prepare('SELECT * FROM conexoes_drive WHERE workspace = ?')
      .get(workspace) as unknown as LinhaConexao | undefined;
    return l ? paraConexao(l) : undefined;
  }

  async conectar(
    workspace: string,
    pastaRaiz: PastaNoDestino,
    autorizacao: AutorizacaoDoDestino,
    agora: Date,
  ): Promise<ConexaoComDestino> {
    this.db
      .prepare(
        `INSERT INTO conexoes_drive
           (workspace, estado, pasta_raiz_id, pasta_raiz_link, tokens_cifrados,
            conectada_em, verificada_em, motivo_do_ultimo_erro)
         VALUES (?, 'conectado', ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (workspace) DO UPDATE SET
           estado = 'conectado',
           pasta_raiz_id = excluded.pasta_raiz_id,
           pasta_raiz_link = excluded.pasta_raiz_link,
           tokens_cifrados = excluded.tokens_cifrados,
           conectada_em = excluded.conectada_em,
           verificada_em = excluded.verificada_em,
           motivo_do_ultimo_erro = NULL`,
      )
      .run(
        workspace,
        pastaRaiz.id,
        pastaRaiz.link,
        this.cifrar(autorizacao),
        agora.toISOString(),
        agora.toISOString(),
      );
    // Reconectar reabilita o histórico: as peças voltam a valer como "enviadas".
    this.db
      .prepare(
        "UPDATE pecas_no_drive SET estado = 'no_destino' WHERE workspace = ? AND estado = 'desconectada'",
      )
      .run(workspace);
    const c = await this.conexao(workspace);
    if (!c) throw new Error('conexão do Drive não foi gravada');
    return c;
  }

  async autorizacao(workspace: string): Promise<AutorizacaoDoDestino | undefined> {
    const l = this.db
      .prepare('SELECT tokens_cifrados FROM conexoes_drive WHERE workspace = ?')
      .get(workspace) as unknown as { tokens_cifrados: string | null } | undefined;
    if (!l?.tokens_cifrados) return undefined;
    try {
      const j = JSON.parse(this.cofre.decifrar(l.tokens_cifrados)) as {
        a?: unknown;
        r?: unknown;
        e?: unknown;
      };
      if (typeof j.a !== 'string' || typeof j.r !== 'string' || typeof j.e !== 'string') {
        return undefined;
      }
      return { tokenDeAcesso: j.a, tokenDeRenovacao: j.r, expiraEm: new Date(j.e) };
    } catch (erro) {
      // Ilegível é indistinguível de "sem autorização" para quem chama — a saída é reconectar —,
      // mas o log registra a diferença (a chave do cofre mudou?), sem NENHUM valor.
      if (erro instanceof SegredoIlegivelError) {
        this.logger.error('autorização do Drive não pôde ser decifrada', {
          workspace,
          motivo: erro.message,
        });
        return undefined;
      }
      if (erro instanceof SyntaxError) return undefined;
      throw erro;
    }
  }

  async salvarAutorizacao(
    workspace: string,
    autorizacao: AutorizacaoDoDestino,
  ): Promise<void> {
    // Só atualiza conexão que existe e não foi desconectada: renovação atrasada que chega
    // depois do "Desconectar" não pode ressuscitar a autorização.
    this.db
      .prepare(
        `UPDATE conexoes_drive SET tokens_cifrados = ?
         WHERE workspace = ? AND tokens_cifrados IS NOT NULL`,
      )
      .run(this.cifrar(autorizacao), workspace);
  }

  async marcarEstado(
    workspace: string,
    estado: EstadoDaConexao,
    motivo: MotivoDoErroDaConexao | undefined,
    agora: Date,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE conexoes_drive SET estado = ?, motivo_do_ultimo_erro = ?, verificada_em = ?
         WHERE workspace = ?`,
      )
      .run(estado, motivo ?? null, agora.toISOString(), workspace);
  }

  async atualizarPastaRaiz(
    workspace: string,
    pastaRaiz: PastaNoDestino,
    motivo: MotivoDoErroDaConexao | undefined,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE conexoes_drive SET pasta_raiz_id = ?, pasta_raiz_link = ?, motivo_do_ultimo_erro = ?
         WHERE workspace = ?`,
      )
      .run(pastaRaiz.id, pastaRaiz.link, motivo ?? null, workspace);
    // As subpastas ficavam dentro da raiz antiga: cada processo cria a dele de novo.
    this.db.prepare('DELETE FROM pastas_no_drive WHERE workspace = ?').run(workspace);
  }

  async registrarVerificacao(workspace: string, agora: Date): Promise<void> {
    this.db
      .prepare('UPDATE conexoes_drive SET verificada_em = ? WHERE workspace = ?')
      .run(agora.toISOString(), workspace);
  }

  async desconectar(workspace: string, agora: Date): Promise<void> {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE conexoes_drive
             SET estado = 'desconectado', tokens_cifrados = NULL, verificada_em = ?,
                 motivo_do_ultimo_erro = NULL
           WHERE workspace = ?`,
        )
        .run(agora.toISOString(), workspace);
      this.db
        .prepare(
          "UPDATE pecas_no_drive SET estado = 'desconectada' WHERE workspace = ? AND estado = 'no_destino'",
        )
        .run(workspace);
      this.db.exec('COMMIT');
    } catch (erro) {
      this.db.exec('ROLLBACK');
      throw erro;
    }
  }

  async pastaDoProcesso(
    workspace: string,
    numeroProcesso: string,
  ): Promise<PastaDoProcessoNoDestino | undefined> {
    const l = this.db
      .prepare(
        'SELECT pasta_id, pasta_link FROM pastas_no_drive WHERE workspace = ? AND numero = ?',
      )
      .get(workspace, numeroProcesso) as unknown as
      { pasta_id: string; pasta_link: string } | undefined;
    return l
      ? {
          workspace,
          numeroProcesso,
          pasta: { id: l.pasta_id, link: l.pasta_link },
        }
      : undefined;
  }

  async guardarPastaDoProcesso(pasta: PastaDoProcessoNoDestino): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pastas_no_drive (workspace, numero, pasta_id, pasta_link)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace, numero) DO UPDATE SET
           pasta_id = excluded.pasta_id, pasta_link = excluded.pasta_link`,
      )
      .run(pasta.workspace, pasta.numeroProcesso, pasta.pasta.id, pasta.pasta.link);
  }

  async peca(
    workspace: string,
    numeroProcesso: string,
    pecaId: string,
  ): Promise<PecaNoDestino | undefined> {
    const l = this.db
      .prepare(
        'SELECT * FROM pecas_no_drive WHERE workspace = ? AND numero = ? AND peca_id = ?',
      )
      .get(workspace, numeroProcesso, pecaId) as unknown as LinhaPeca | undefined;
    return l ? paraPeca(l) : undefined;
  }

  async doProcesso(workspace: string, numeroProcesso: string): Promise<PecaNoDestino[]> {
    const linhas = this.db
      .prepare('SELECT * FROM pecas_no_drive WHERE workspace = ? AND numero = ?')
      .all(workspace, numeroProcesso) as unknown as LinhaPeca[];
    return linhas.map(paraPeca);
  }

  async guardarPeca(peca: PecaNoDestino): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pecas_no_drive
           (workspace, numero, peca_id, arquivo_id, hash, nome, estado, enviada_em, atualizada_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace, numero, peca_id) DO UPDATE SET
           arquivo_id = excluded.arquivo_id, hash = excluded.hash, nome = excluded.nome,
           estado = excluded.estado, enviada_em = excluded.enviada_em,
           atualizada_em = excluded.atualizada_em`,
      )
      .run(
        peca.workspace,
        peca.numeroProcesso,
        peca.pecaId,
        peca.arquivoId,
        peca.hash,
        peca.nome,
        peca.estado,
        peca.enviadaEm.toISOString(),
        peca.atualizadaEm ? peca.atualizadaEm.toISOString() : null,
      );
  }

  async apagarDoWorkspace(workspace: string): Promise<number> {
    let n = 0;
    for (const tabela of ['pecas_no_drive', 'pastas_no_drive', 'conexoes_drive']) {
      n += Number(
        this.db.prepare(`DELETE FROM ${tabela} WHERE workspace = ?`).run(workspace)
          .changes,
      );
    }
    return n;
  }

  private cifrar(a: AutorizacaoDoDestino): string {
    return this.cofre.cifrar(
      JSON.stringify({
        a: a.tokenDeAcesso,
        r: a.tokenDeRenovacao,
        e: a.expiraEm.toISOString(),
      }),
    );
  }
}
