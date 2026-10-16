import { WorkspaceInvalidoError } from '../../domain/errors/index.js';
import type { RepositorioUsuarios } from '../../domain/ports/RepositorioUsuarios.js';
import type { ServicoChavesApi } from './ServicoChavesApi.js';

/**
 * Workspace de chave: 16 hex (`workspaceDaChave`). Workspace de conta: 32 hex
 * (`novoWorkspace`, 16 bytes aleatórios). Qualquer outra forma é digitação errada.
 */
const FORMATO_DO_WORKSPACE = /^(?:[0-9a-f]{16}|[0-9a-f]{32})$/;

export interface OpcoesLocalizadorDeWorkspace {
  readonly usuarios: Pick<RepositorioUsuarios, 'porWorkspace'>;
  readonly chavesApi: Pick<ServicoChavesApi, 'listar'>;
  /** Workspaces das chaves de `PROCESSOVIVO_API_KEYS` (derivados, nunca as chaves). */
  readonly workspacesDeChavesDoEnv: readonly string[];
}

/**
 * Confirma que um workspace informado À MÃO (`assinatura liberar --workspace`) existe.
 *
 * Existir = ser de uma conta, de uma chave emitida no `/admin` e não revogada, ou de uma chave
 * do `.env`. Sem esta conferência, uma letra trocada no id criaria uma assinatura para um
 * ambiente que ninguém usa — e o operador acharia que liberou o Drive para a própria conta.
 * Não muda nenhuma regra de plano: só diz QUAL workspace o comando administrativo atinge.
 */
export class LocalizadorDeWorkspace {
  constructor(private readonly opcoes: OpcoesLocalizadorDeWorkspace) {}

  /**
   * @returns o id normalizado (minúsculas, sem espaço nas pontas).
   * @throws {WorkspaceInvalidoError} malformado ou inexistente — nada é gravado por quem chama.
   */
  async confirmar(informado: string): Promise<string> {
    const id = informado.trim().toLowerCase();
    if (!FORMATO_DO_WORKSPACE.test(id)) throw new WorkspaceInvalidoError('malformado');

    if (this.opcoes.workspacesDeChavesDoEnv.includes(id)) return id;
    if (await this.opcoes.usuarios.porWorkspace(id)) return id;
    const chaves = await this.opcoes.chavesApi.listar();
    if (chaves.some((c) => c.workspace === id && !c.revogadaEm)) return id;

    throw new WorkspaceInvalidoError('inexistente');
  }
}
