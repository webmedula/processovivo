import type {
  AncoraGuardada,
  ListagemDaPasta,
  PecaEmCache,
} from '../entities/PastaDigital.js';

/**
 * PORTA da persistência da Pasta digital: o retrato da listagem do tribunal e o
 * METADADO de cada peça guardada. Os bytes ficam no armazém; aqui só o índice.
 *
 * Toda operação recebe o `workspace` e filtra por ele. Não existe "obter peça
 * por id" sem dono: a conferência de isolamento A × B mora na consulta, e não
 * na boa vontade de quem chama.
 */
export interface RepositorioDaPasta {
  /** Substitui a listagem anterior do processo (a do tribunal vale mais que a velha). */
  guardarListagem(workspace: string, listagem: ListagemDaPasta): Promise<void>;
  obterListagem(
    workspace: string,
    numeroProcesso: string,
  ): Promise<ListagemDaPasta | undefined>;

  guardarPeca(peca: PecaEmCache): Promise<void>;
  obterPeca(
    workspace: string,
    numeroProcesso: string,
    pecaId: string,
  ): Promise<PecaEmCache | undefined>;
  /** Todas as peças guardadas do processo (inclusive vencidas: quem lê confere o prazo). */
  doProcesso(workspace: string, numeroProcesso: string): Promise<PecaEmCache[]>;
  doWorkspace(workspace: string): Promise<PecaEmCache[]>;
  apagarPeca(workspace: string, numeroProcesso: string, pecaId: string): Promise<void>;

  /** Peças cujo prazo de guarda passou — só o executor da limpeza lê sem workspace. */
  vencidas(agora: Date): Promise<PecaEmCache[]>;

  /** Âncoras de calibração do número do Projudi (v0.35.0), por posição crescente. */
  ancorasDoProcesso(workspace: string, numeroProcesso: string): Promise<AncoraGuardada[]>;
  /** Insere ou substitui a âncora da mesma posição. */
  guardarAncora(
    workspace: string,
    numeroProcesso: string,
    ancora: AncoraGuardada,
  ): Promise<void>;
  /** @returns se havia âncora naquela posição. */
  removerAncora(
    workspace: string,
    numeroProcesso: string,
    posicao: number,
  ): Promise<boolean>;
  limparAncoras(workspace: string, numeroProcesso: string): Promise<number>;
  /** Zera o aviso "calibração anterior invalidada" da listagem gravada. */
  zerarAncorasInvalidadas(workspace: string, numeroProcesso: string): Promise<void>;

  /** Exclusão de conta. @returns quantas linhas saíram. */
  apagarDoWorkspace(workspace: string): Promise<number>;
}
