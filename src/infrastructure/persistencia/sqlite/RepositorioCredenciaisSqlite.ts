import type { DatabaseSync } from 'node:sqlite';
import type {
  CredencialCadastrada,
  RepositorioCredenciais,
} from '../../../domain/ports/RepositorioCredenciais.js';
import type { CredencialTribunal } from '../../../domain/ports/ProvedorDePecas.js';
import type { Logger } from '../../../domain/ports/Logger.js';
import { loggerSilencioso } from '../../logging/ConsoleLogger.js';
import type { Cofre } from '../../seguranca/cofre.js';
import { SegredoIlegivelError } from '../../seguranca/cofre.js';

interface LinhaCredencial {
  workspace: string;
  tribunal: string;
  identificacao: string;
  senha_cifrada: string;
  criada_em: string;
  usada_em: string | null;
  recusada_em: string | null;
}

function paraCadastrada(l: LinhaCredencial): CredencialCadastrada {
  return {
    tribunal: l.tribunal,
    identificacao: l.identificacao,
    criadaEm: new Date(l.criada_em),
    ...(l.usada_em ? { usadaEm: new Date(l.usada_em) } : {}),
    ...(l.recusada_em ? { recusadaEm: new Date(l.recusada_em) } : {}),
  };
}

/**
 * Credenciais de tribunal em SQLite, com a senha CIFRADA na coluna.
 *
 * A cifra fica aqui e não no domínio de propósito: o domínio pede "a senha", e
 * onde ela esteve guardada é problema de infraestrutura — a mesma razão que
 * mantém `zod` fora de `domain/`.
 *
 * O que este repositório nunca faz, e vale escrito porque é fácil quebrar sem
 * perceber: **não escreve senha em log**. Nem em `debug`, nem dentro de objeto
 * de contexto, nem em mensagem de erro. Log de credencial é o vazamento que não
 * aparece em nenhuma auditoria de código, porque parece inofensivo na linha em
 * que é escrito.
 */
export class RepositorioCredenciaisSqlite implements RepositorioCredenciais {
  private readonly logger: Logger;

  constructor(
    private readonly db: DatabaseSync,
    private readonly cofre: Cofre,
    logger?: Logger,
  ) {
    this.logger = (logger ?? loggerSilencioso).child({ componente: 'credenciais' });
  }

  async obter(
    workspace: string,
    tribunal: string,
  ): Promise<CredencialTribunal | undefined> {
    const linha = this.db
      .prepare('SELECT * FROM credenciais_tribunal WHERE workspace = ? AND tribunal = ?')
      .get(workspace, tribunal.toUpperCase()) as unknown as LinhaCredencial | undefined;

    if (!linha) return undefined;

    try {
      return {
        tribunal: linha.tribunal,
        identificacao: linha.identificacao,
        senha: this.cofre.decifrar(linha.senha_cifrada),
      };
    } catch (erro) {
      // Segredo ilegível é indistinguível de "não cadastrado" para quem chama, e
      // isso é proposital: o caso de uso vai pedir para cadastrar de novo, que é
      // exatamente a saída correta quando a chave do cofre mudou. Mas o log
      // registra a diferença, senão o operador nunca descobre que o problema é a
      // variável de ambiente e não o usuário.
      if (erro instanceof SegredoIlegivelError) {
        this.logger.error('credencial guardada não pôde ser decifrada', {
          workspace,
          tribunal,
          motivo: erro.message,
        });
        return undefined;
      }
      throw erro;
    }
  }

  async listar(workspace: string): Promise<CredencialCadastrada[]> {
    const linhas = this.db
      .prepare(
        'SELECT * FROM credenciais_tribunal WHERE workspace = ? ORDER BY tribunal',
      )
      .all(workspace) as unknown as LinhaCredencial[];
    return linhas.map(paraCadastrada);
  }

  async salvar(
    workspace: string,
    credencial: CredencialTribunal,
  ): Promise<CredencialCadastrada> {
    const tribunal = credencial.tribunal.toUpperCase();
    const cifrada = this.cofre.cifrar(credencial.senha);

    // Recadastrar limpa `recusada_em`: a pessoa está justamente corrigindo o que
    // foi recusado, e manter a marca faria a interface continuar acusando erro
    // numa credencial nova que ainda nem foi usada.
    this.db
      .prepare(
        `INSERT INTO credenciais_tribunal
           (workspace, tribunal, identificacao, senha_cifrada, criada_em)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace, tribunal) DO UPDATE SET
           identificacao = excluded.identificacao,
           senha_cifrada = excluded.senha_cifrada,
           criada_em     = excluded.criada_em,
           recusada_em   = NULL`,
      )
      .run(
        workspace,
        tribunal,
        credencial.identificacao,
        cifrada,
        new Date().toISOString(),
      );

    const cadastrada = (await this.listar(workspace)).find((c) => c.tribunal === tribunal);
    if (!cadastrada) {
      throw new Error(`credencial de ${tribunal} não foi encontrada após a gravação`);
    }
    return cadastrada;
  }

  async remover(workspace: string, tribunal: string): Promise<boolean> {
    const r = this.db
      .prepare('DELETE FROM credenciais_tribunal WHERE workspace = ? AND tribunal = ?')
      .run(workspace, tribunal.toUpperCase());
    return Number(r.changes) > 0;
  }

  async registrarUso(workspace: string, tribunal: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE credenciais_tribunal SET usada_em = ?, recusada_em = NULL
         WHERE workspace = ? AND tribunal = ?`,
      )
      .run(new Date().toISOString(), workspace, tribunal.toUpperCase());
  }

  async registrarRecusa(workspace: string, tribunal: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE credenciais_tribunal SET recusada_em = ?
         WHERE workspace = ? AND tribunal = ?`,
      )
      .run(new Date().toISOString(), workspace, tribunal.toUpperCase());
  }
}
