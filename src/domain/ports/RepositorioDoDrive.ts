import type {
  AutorizacaoDoDestino,
  ConexaoComDestino,
  EstadoDaConexao,
  MotivoDoErroDaConexao,
  PastaDoProcessoNoDestino,
  PastaNoDestino,
  PecaNoDestino,
} from '../entities/DestinoDePecas.js';

/**
 * PORTA da persistência do Drive (v0.42.0): a conexão, as pastas e o controle de
 * cada peça enviada.
 *
 * Toda operação recebe o `workspace` e filtra por ele: não existe "obter por id"
 * sem dono. A autorização (tokens) é o dado mais sensível daqui e vive CIFRADA
 * pelo mesmo cofre das credenciais de tribunal — a porta recebe e devolve em
 * claro e deixa a cifra do lado de fora do domínio. Nenhuma listagem a devolve:
 * `autorizacao` é o único caminho, chamado no momento de falar com o destino.
 */
export interface RepositorioDoDrive {
  conexao(workspace: string): Promise<ConexaoComDestino | undefined>;

  /** Grava a conexão nova (e a autorização) ou substitui a anterior do workspace. */
  conectar(
    workspace: string,
    pastaRaiz: PastaNoDestino,
    autorizacao: AutorizacaoDoDestino,
    agora: Date,
  ): Promise<ConexaoComDestino>;

  /** `undefined` sem conexão, desconectada ou com a autorização ilegível. */
  autorizacao(workspace: string): Promise<AutorizacaoDoDestino | undefined>;
  salvarAutorizacao(workspace: string, autorizacao: AutorizacaoDoDestino): Promise<void>;

  marcarEstado(
    workspace: string,
    estado: EstadoDaConexao,
    motivo: MotivoDoErroDaConexao | undefined,
    agora: Date,
  ): Promise<void>;
  atualizarPastaRaiz(
    workspace: string,
    pastaRaiz: PastaNoDestino,
    motivo: MotivoDoErroDaConexao | undefined,
  ): Promise<void>;
  registrarVerificacao(workspace: string, agora: Date): Promise<void>;

  /**
   * Desconecta: APAGA a autorização e mantém o histórico das peças marcado como
   * "desconectado". Não apaga nada no Drive do advogado.
   */
  desconectar(workspace: string, agora: Date): Promise<void>;

  pastaDoProcesso(
    workspace: string,
    numeroProcesso: string,
  ): Promise<PastaDoProcessoNoDestino | undefined>;
  guardarPastaDoProcesso(pasta: PastaDoProcessoNoDestino): Promise<void>;

  peca(
    workspace: string,
    numeroProcesso: string,
    pecaId: string,
  ): Promise<PecaNoDestino | undefined>;
  doProcesso(workspace: string, numeroProcesso: string): Promise<PecaNoDestino[]>;
  guardarPeca(peca: PecaNoDestino): Promise<void>;

  /** Exclusão de conta. @returns quantas linhas saíram. */
  apagarDoWorkspace(workspace: string): Promise<number>;
}
