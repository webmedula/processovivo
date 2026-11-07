import type { Usuario } from '../entities/Usuario.js';

/**
 * Como uma senha fica guardada.
 *
 * O algoritmo e os parâmetros viajam JUNTO do hash, e não numa constante do
 * código. É o que permite endurecer o custo do scrypt daqui a dois anos sem
 * invalidar as senhas de quem já é assinante: cada hash sabe como foi feito, e
 * a verificação usa os parâmetros dele, não os de hoje.
 */
export type SenhaGuardada = string;

/**
 * O que vai na coluna `senha` de uma conta que nasceu pelo login com Google (v0.67.0) e
 * ainda não escolheu senha. NÃO é hash: `conferir` devolve `false` para ele em todo caso
 * (formato fora do contrato), então ninguém entra por senha nessa conta até ela criar uma
 * pelo "Esqueci minha senha". A coluna é `NOT NULL` e é por isso que existe um marcador em
 * vez de `NULL` — migração aditiva, sem mexer na tabela.
 */
export const SENHA_AUSENTE: SenhaGuardada = 'sem-senha';

export interface NovoUsuario {
  readonly email: string;
  readonly nome: string;
  readonly senhaGuardada: SenhaGuardada;
  // `workspace` NÃO entra aqui: quem cria a conta não escolhe o identificador
  // do ambiente. É o repositório que gera, aleatório, e devolve pronto no
  // `Usuario`. Deixar isso vir de fora abriria a porta para alguém pedir
  // cadastro apontando para o ambiente de outro assinante.
}

export interface PerfilEditavel {
  readonly nome?: string;
  readonly oab?: string;
  readonly ufOab?: string;
}

/**
 * Persistência de contas e sessões.
 *
 * Sessão mora aqui, e não num serviço de cache, por uma razão de produto: o
 * cache é em memória e evapora no redeploy. Com sessão em cache, todo deploy
 * desconectaria todos os assinantes ao mesmo tempo — e o Processo Vivo é redeployado
 * com frequência.
 *
 * **O token NUNCA é guardado.** O que entra e sai destes métodos é o hash dele.
 * Vazamento do banco não pode virar sessão aberta na conta de ninguém.
 */
export interface RepositorioUsuarios {
  criar(novo: NovoUsuario): Promise<Usuario>;
  porEmail(
    email: string,
  ): Promise<{ usuario: Usuario; senha: SenhaGuardada } | undefined>;
  porId(id: string): Promise<Usuario | undefined>;

  /**
   * A conta dona daquele ambiente.
   *
   * Existe para o aviso de assinatura, que precisa chegar ao e-mail de LOGIN e
   * não ao endereço configurado para avisos de movimentação: quem desligou os
   * avisos de processo não está pedindo para ser surpreendido por um bloqueio.
   *
   * Devolve `undefined` para workspace de chave de API, que não tem conta —
   * e é justamente por isso que quem chama não pode presumir que sempre há uma.
   */
  porWorkspace(workspace: string): Promise<Usuario | undefined>;
  atualizarPerfil(id: string, perfil: PerfilEditavel): Promise<Usuario>;
  trocarSenha(id: string, senhaGuardada: SenhaGuardada): Promise<void>;
  registrarAcesso(id: string): Promise<void>;

  /** @param hashDoToken SHA-256 do token; o token em si não chega aqui. */
  abrirSessao(hashDoToken: string, usuarioId: string, expiraEm: Date): Promise<void>;
  /** Devolve o dono da sessão, ou `undefined` se não existe ou expirou. */
  usuarioDaSessao(hashDoToken: string): Promise<Usuario | undefined>;
  encerrarSessao(hashDoToken: string): Promise<void>;
  /** Derruba TODAS as sessões de uma conta — usado ao trocar a senha. */
  encerrarSessoesDe(usuarioId: string): Promise<void>;
  /** Limpeza das expiradas. Sem isso a tabela cresce para sempre. */
  limparSessoesExpiradas(): Promise<number>;

  /**
   * Recuperação de senha. Como na sessão, o que entra e sai é o HASH do token.
   *
   * `consumirRecuperacao` é deliberadamente uma operação só: conferir e marcar
   * como usado em passos separados abriria a janela para o mesmo link ser
   * aceito duas vezes por duas requisições simultâneas.
   */
  abrirRecuperacao(hashDoToken: string, usuarioId: string, expiraEm: Date): Promise<void>;
  consumirRecuperacao(hashDoToken: string): Promise<Usuario | undefined>;
  /** Quantos pedidos a conta fez desde `desde`. Trava contra usar o sistema para inundar caixa de entrada. */
  contarRecuperacoesRecentes(usuarioId: string, desde: Date): Promise<number>;
}
