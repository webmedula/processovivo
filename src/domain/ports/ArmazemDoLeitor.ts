/**
 * PORTA da guarda temporária do leitor de peças: os arquivos baixados do
 * tribunal enquanto o job anda, e o PDF combinado depois de pronto.
 *
 * **Isto reverte uma regra antiga, por decisão do dono (29/09/2026).** Até a
 * v0.29 nenhum arquivo de peça ficava no nosso disco. O PDF combinado fica —
 * por prazo curto, com cota, fora do diretório servido e fora do backup —
 * porque montar de novo a cada abertura custaria minutos de consultas ao
 * tribunal contra a conta do advogado.
 *
 * Toda operação recebe o `workspace`, e não é cerimônia: o caminho em disco é
 * derivado dele, e o armazém não oferece forma de chegar a um arquivo sem
 * dizer de quem ele é. A conferência de DONO acontece antes, no serviço,
 * contra o job gravado — aqui é a segunda trava.
 *
 * Localizadores são opacos: strings que só o armazém e o montador entendem.
 * Nunca vão para a resposta HTTP nem para o log.
 */
export interface ArmazemDoLeitor {
  /**
   * Grava o arquivo de uma peça na pasta do job. `extensao` (padrão `bin`) é a
   * do tipo que o tribunal declarou: PDF tem de terminar em `.pdf`, porque há
   * sistema em que o qpdf só abre arquivo com essa extensão (v0.66.1).
   */
  gravarPeca(
    workspace: string,
    jobId: string,
    ordem: number,
    bytes: Uint8Array,
    extensao?: string,
  ): Promise<string>;

  /**
   * Grava bytes num arquivo NOVO de nome aleatório na pasta `pastaId` e devolve
   * o localizador. É o que a guarda por peça da Pasta digital usa: o nome não é
   * derivável do id da peça (que o cliente conhece).
   */
  gravarArquivo(
    workspace: string,
    pastaId: string,
    bytes: Uint8Array,
    extensao: string,
  ): Promise<string>;

  /** Apaga UM arquivo. @returns bytes liberados (0 se já não existia). */
  apagarArquivo(workspace: string, localizador: string): Promise<number>;

  /**
   * Apaga arquivos temporários (`.tmp`) mais velhos que `idadeMinimaMs` em
   * TODA a guarda — sobra de um processo que caiu entre gravar e converter.
   * @returns quantos saíram.
   */
  removerTemporarios(idadeMinimaMs: number): Promise<number>;

  /** Localizador de um arquivo NOVO na pasta do job (nome aleatório). */
  novoArquivo(workspace: string, jobId: string, extensao: string): string;

  /**
   * Caminho que o MONTADOR entende para um localizador (cria a pasta).
   *
   * É a ponte entre os dois adapters, e passa pelo serviço de propósito: o
   * montador não conhece o armazém, recebe só caminhos já resolvidos — e
   * resolvidos por quem confere que eles caem dentro da pasta do workspace.
   */
  caminhoLocal(workspace: string, localizador: string): Promise<string>;

  /** `undefined` quando o arquivo não existe (expirou, foi apagado). */
  tamanho(workspace: string, localizador: string): Promise<number | undefined>;

  /** Bytes de `inicio` a `fim` (inclusive), em pedaços — nunca o arquivo inteiro na memória. */
  ler(
    workspace: string,
    localizador: string,
    inicio: number,
    fim: number,
  ): AsyncIterable<Uint8Array>;

  /** Apaga os arquivos de trabalho do job, mantendo o que estiver em `manter`. */
  limparTrabalho(
    workspace: string,
    jobId: string,
    manter: readonly string[],
  ): Promise<void>;

  /** Apaga tudo do job. @returns bytes liberados. */
  apagarJob(workspace: string, jobId: string): Promise<number>;

  /** Apaga tudo do workspace (exclusão de conta). @returns bytes liberados. */
  apagarWorkspace(workspace: string): Promise<number>;

  /** Bytes ocupados por um workspace. */
  usoDoWorkspace(workspace: string): Promise<number>;

  /** Bytes ocupados no total, e por quantos workspaces. */
  usoTotal(): Promise<{ readonly bytes: number; readonly workspaces: number }>;
}
