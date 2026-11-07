import type { Usuario } from '../../domain/entities/Usuario.js';
import { normalizarEmail } from '../../domain/entities/Usuario.js';
import { assinaturaDeTeste } from '../../domain/entities/Assinatura.js';
import { REGRAS_PADRAO } from '../../domain/entities/RegrasDeAssinatura.js';
import type { RepositorioAssinaturas } from '../../domain/ports/RepositorioAssinaturas.js';
import type { RepositorioRegrasDeAssinatura } from '../../domain/ports/RepositorioPlanos.js';
import {
  CredenciaisInvalidasError,
  SessaoInvalidaError,
} from '../../domain/errors/index.js';
import type { RepositorioUsuarios } from '../../domain/ports/RepositorioUsuarios.js';
import { SENHA_AUSENTE } from '../../domain/ports/RepositorioUsuarios.js';
import type { HashDeSenha, TokensDeSessao } from '../../domain/ports/Criptografia.js';
import type { Notificador } from '../../domain/ports/Notificador.js';
import { Oab } from '../../domain/entities/Oab.js';

export interface DadosDeCadastro {
  readonly email: string;
  readonly nome: string;
  readonly senha: string;
}

export interface SessaoAberta {
  readonly usuario: Usuario;
  /** O token em claro. Existe só até virar cookie — não se guarda, não se loga. */
  readonly token: string;
  readonly expiraEm: Date;
}

export interface OpcoesServicoContas {
  readonly repositorio: RepositorioUsuarios;
  /**
   * Onde o teste de conta nova é gravado.
   *
   * Opcional para que a suíte e a instalação de rede interna montem contas sem
   * cobrança nenhuma. Ausente, o cadastro segue como sempre foi — e o serviço
   * de assinaturas trata workspace sem assinatura como irrestrito, então nada
   * fica pela metade.
   */
  readonly assinaturas?: RepositorioAssinaturas;
  /**
   * Dias de teste e plano do teste, como o operador configurou no painel.
   * Ausente, valem as `REGRAS_PADRAO` — 14 dias no plano Peças.
   */
  readonly regras?: RepositorioRegrasDeAssinatura;
  readonly senhas: HashDeSenha;
  readonly tokens: TokensDeSessao;
  readonly duracaoSessaoMs: number;
  /**
   * Por onde o link de recuperação sai. Sem notificador habilitado, a
   * recuperação NÃO EXISTE: ver `podeRecuperarSenha`.
   */
  readonly notificador?: Notificador;
  /** Raiz pública do sistema, para montar o link do e-mail. */
  readonly urlBase?: string;
  /** Validade do link. Curta de propósito — ver `pedirRecuperacao`. */
  readonly duracaoRecuperacaoMs?: number;
}

/**
 * Quantos pedidos de recuperação a mesma conta pode fazer por hora.
 *
 * O limite não protege a conta — protege a CAIXA DE ENTRADA do dono dela.
 * Sem isso, qualquer um digita o e-mail de um advogado num laço e enche a
 * caixa dele com links nossos, e o Processo Vivo vira ferramenta de importunação com
 * o nosso domínio no remetente.
 */
const MAXIMO_RECUPERACOES_POR_HORA = 5;

/**
 * 1 hora de validade.
 *
 * Curta porque o link chega por e-mail, que é o canal menos seguro da cadeia:
 * fica no histórico, é sincronizado em vários aparelhos e sobrevive à
 * troca de senha. Uma hora é tempo de sobra para quem pediu, e janela curta
 * para quem achar a mensagem depois.
 */
const DURACAO_RECUPERACAO_MS = 60 * 60 * 1000;

/**
 * Contas, sessões e perfil.
 *
 * Cada conta nasce com um ambiente próprio, e é isso que permite vender o
 * Processo Vivo para advogados diferentes na mesma instalação: o `workspace` do
 * `Usuario` é a mesma coluna que já separava os dados por chave de API, então
 * nenhuma rota de dados precisou saber que contas passaram a existir.
 *
 * O cadastro é ABERTO por decisão de produto. Duas consequências que o código
 * precisa absorver, e absorve em outro lugar: o limite de requisições passa a
 * ser por conta (senão um cadastro abusivo gasta a cota compartilhada do CNJ
 * que todos os assinantes dividem), e o acesso ao tribunal continua sendo
 * credencial do próprio advogado, que ninguém consegue forjar.
 */
export class ServicoContas {
  private readonly repositorio: RepositorioUsuarios;
  private readonly assinaturas: RepositorioAssinaturas | undefined;
  private readonly regras: RepositorioRegrasDeAssinatura | undefined;
  private readonly senhas: HashDeSenha;
  private readonly tokens: TokensDeSessao;
  private readonly duracaoSessaoMs: number;
  private readonly notificador: Notificador | undefined;
  private readonly urlBase: string;
  private readonly duracaoRecuperacaoMs: number;

  constructor(opcoes: OpcoesServicoContas) {
    this.repositorio = opcoes.repositorio;
    this.assinaturas = opcoes.assinaturas;
    this.regras = opcoes.regras;
    this.senhas = opcoes.senhas;
    this.tokens = opcoes.tokens;
    this.duracaoSessaoMs = opcoes.duracaoSessaoMs;
    this.notificador = opcoes.notificador;
    this.urlBase = (opcoes.urlBase ?? '').replace(/\/+$/, '');
    this.duracaoRecuperacaoMs = opcoes.duracaoRecuperacaoMs ?? DURACAO_RECUPERACAO_MS;
  }

  /**
   * A recuperação de senha existe neste servidor?
   *
   * Sem notificador habilitado (isto é, sem SMTP configurado), ela NÃO existe —
   * e a interface não mostra o link. A alternativa seria aceitar o pedido,
   * responder "enviamos um e-mail" e não enviar nada: a pessoa esperaria uma
   * mensagem que nunca chega, tentaria de novo, e concluiria que o sistema está
   * quebrado. Mentir para o usuário é pior do que não ter a funcionalidade.
   */
  get podeRecuperarSenha(): boolean {
    return this.notificador?.habilitado === true && this.urlBase.length > 0;
  }

  /**
   * Cria a conta e já entra: cadastro que exige login logo em seguida é atrito
   * puro, e a pessoa acabou de provar que sabe a senha.
   *
   * @throws {EmailInvalidoError} {EmailJaCadastradoError} {SenhaFracaError}
   */
  async cadastrar(dados: DadosDeCadastro): Promise<SessaoAberta> {
    const email = normalizarEmail(dados.email);
    // `guardarSenha` ANTES de tocar no banco: se a senha é fraca, a pessoa
    // recebe o aviso sem que nada tenha sido gravado.
    const senhaGuardada = this.senhas.guardar(dados.senha);
    const usuario = await this.criarConta(email, dados.nome, senhaGuardada);
    return this.abrirSessao(usuario);
  }

  /**
   * Conta que nasce pelo login com Google (v0.67.0): SEM senha. O e-mail já chegou
   * normalizado e verificado pelo provedor; quem abre a sessão é `ServicoLoginGoogle`, depois
   * de ligar a identidade — por isso aqui não há sessão. A conta ganha o mesmo teste de
   * assinatura do cadastro comum: a porta de entrada não muda o plano.
   *
   * @throws {EmailJaCadastradoError}
   */
  async cadastrarSemSenha(dados: {
    readonly email: string;
    readonly nome: string;
  }): Promise<Usuario> {
    return this.criarConta(normalizarEmail(dados.email), dados.nome, SENHA_AUSENTE);
  }

  /** A conta tem senha própria? `false` para a que nasceu pelo Google e ainda não criou uma. */
  async temSenha(usuario: Usuario): Promise<boolean> {
    const achado = await this.repositorio.porEmail(usuario.email);
    return achado !== undefined && achado.senha !== SENHA_AUSENTE;
  }

  /** Abre a sessão de quem acabou de ser identificado por OUTRO caminho (o login com Google). */
  async abrirSessaoPara(usuario: Usuario): Promise<SessaoAberta> {
    await this.repositorio.registrarAcesso(usuario.id);
    return this.abrirSessao(usuario);
  }

  private async criarConta(
    email: string,
    nome: string,
    senhaGuardada: string,
  ): Promise<Usuario> {
    const usuario = await this.repositorio.criar({
      email,
      nome: nome.trim() || email.split('@')[0] || 'Advogado',
      senhaGuardada,
    });

    // O teste nasce JUNTO da conta, e não numa chamada separada da rota.
    // Separar abriria a janela em que a conta existe sem assinatura nenhuma —
    // e quem caísse nessa janela veria um sistema que aceitou o cadastro e
    // recusa tudo em seguida, sem explicar por quê.
    if (this.assinaturas) {
      const regras = this.regras ? await this.regras.ler() : REGRAS_PADRAO;
      await this.assinaturas.salvar(
        assinaturaDeTeste({
          workspace: usuario.workspace,
          plano: regras.planoDoTeste,
          dias: regras.diasDeTeste,
          agora: new Date(),
        }),
      );
    }

    return usuario;
  }

  /**
   * @throws {CredenciaisInvalidasError} tanto para e-mail desconhecido quanto
   *         para senha errada — e gastando o mesmo tempo nos dois casos.
   */
  async entrar(emailBruto: string, senha: string): Promise<SessaoAberta> {
    // `normalizarEmail` lança em e-mail malformado, e isso denunciaria a
    // diferença entre "formato ruim" e "não existe". Aqui a forma errada é
    // apenas mais um jeito de não haver conta.
    let email: string;
    try {
      email = normalizarEmail(emailBruto);
    } catch {
      this.senhas.conferir(senha, this.senhas.hashDeComparacao);
      throw new CredenciaisInvalidasError();
    }

    const achado = await this.repositorio.porEmail(email);
    if (!achado) {
      // O scrypt roda mesmo sem conta. Sem esta linha, e-mail desconhecido
      // responde em 1ms e e-mail real em 100ms — e quem mede de fora levanta
      // a lista de assinantes testando endereços.
      this.senhas.conferir(senha, this.senhas.hashDeComparacao);
      throw new CredenciaisInvalidasError();
    }

    if (!this.senhas.conferir(senha, achado.senha)) {
      throw new CredenciaisInvalidasError();
    }

    await this.repositorio.registrarAcesso(achado.usuario.id);
    return this.abrirSessao(achado.usuario);
  }

  /** @throws {SessaoInvalidaError} */
  async resolverSessao(token: string): Promise<Usuario> {
    const usuario = await this.repositorio.usuarioDaSessao(this.tokens.hash(token));
    if (!usuario) throw new SessaoInvalidaError();
    return usuario;
  }

  async sair(token: string): Promise<void> {
    await this.repositorio.encerrarSessao(this.tokens.hash(token));
  }

  /**
   * Completa o perfil — é aqui que a OAB entra, depois do cadastro.
   *
   * A inscrição passa por `Oab.criar`, que normaliza e valida. Guardar "47.383"
   * e "47383" como coisas diferentes faria a vigilância procurar por um texto
   * que o DJEN nunca devolve, e o sintoma seria "cadastrei e não achou nada".
   */
  async atualizarPerfil(
    usuario: Usuario,
    perfil: {
      nome?: string | undefined;
      oab?: string | undefined;
      ufOab?: string | undefined;
    },
  ): Promise<Usuario> {
    const inscricao =
      perfil.oab && perfil.ufOab ? Oab.criar(perfil.oab, perfil.ufOab) : undefined;

    return this.repositorio.atualizarPerfil(usuario.id, {
      ...(perfil.nome ? { nome: perfil.nome.trim() } : {}),
      ...(inscricao ? { oab: inscricao.numero, ufOab: inscricao.uf } : {}),
    });
  }

  /**
   * Troca a senha e **derruba as outras sessões**.
   *
   * Quem troca a senha costuma estar fazendo isso porque desconfia que alguém
   * entrou. Manter as sessões antigas válidas deixaria o invasor dentro da
   * conta depois da troca — que é exatamente o que a pessoa acabou de tentar
   * impedir. A sessão atual é reaberta em seguida, para não expulsar o dono.
   *
   * @throws {CredenciaisInvalidasError} {SenhaFracaError}
   */
  async trocarSenha(
    usuario: Usuario,
    senhaAtual: string,
    senhaNova: string,
  ): Promise<SessaoAberta> {
    const achado = await this.repositorio.porEmail(usuario.email);
    if (!achado || !this.senhas.conferir(senhaAtual, achado.senha)) {
      throw new CredenciaisInvalidasError();
    }

    const guardada = this.senhas.guardar(senhaNova);
    await this.repositorio.trocarSenha(usuario.id, guardada);
    await this.repositorio.encerrarSessoesDe(usuario.id);
    return this.abrirSessao(usuario);
  }

  /**
   * Pede a recuperação. **Nunca diz se o e-mail existe.**
   *
   * Sempre devolve `void` e a rota sempre responde a mesma coisa — inclusive
   * para endereço malformado, inexistente, ou que estourou o limite de pedidos.
   * Qualquer diferença observável transformaria esta rota, que é pública e não
   * exige nada, no verificador de assinantes mais cômodo possível: melhor que o
   * login, porque nem senha precisa.
   *
   * **O envio NÃO é aguardado**, e isso é parte da mesma defesa. Medido contra
   * um SMTP inalcançável: com `await`, o pedido de um e-mail cadastrado ficava
   * pendurado até o timeout do nodemailer, enquanto o de um endereço
   * desconhecido voltava na hora. Mensagem idêntica, status idêntico — e o
   * relógio contando quem é assinante.
   *
   * Sobra uma diferença, e vale dizer qual em vez de fingir que não existe: a
   * conta que existe paga um `COUNT` e um `INSERT` a mais. Medido em ~0,14 ms
   * contra ~0,24 ms — abaixo do jitter de qualquer rede, e explorá-la exigiria
   * milhares de amostras por endereço contra um teto de 60 requisições por
   * minuto por IP. Some-se que o 409 do cadastro já revela o mesmo fato de
   * graça, por decisão de produto: fechar este resíduo antes daquele seria
   * trancar a janela com a porta aberta.
   *
   * A falha de envio é engolida (o notificador já a registra em log): quem
   * pediu vê a mesma mensagem e pede de novo. Um erro visível aqui confirmaria
   * que a conta existe, que é justamente o que não pode vazar.
   */
  async pedirRecuperacao(emailBruto: string): Promise<void> {
    if (!this.podeRecuperarSenha) return;

    let email: string;
    try {
      email = normalizarEmail(emailBruto);
    } catch {
      return;
    }

    const achado = await this.repositorio.porEmail(email);
    if (!achado) return;

    const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000);
    const recentes = await this.repositorio.contarRecuperacoesRecentes(
      achado.usuario.id,
      umaHoraAtras,
    );
    if (recentes >= MAXIMO_RECUPERACOES_POR_HORA) return;

    const token = this.tokens.gerar();
    const expiraEm = new Date(Date.now() + this.duracaoRecuperacaoMs);
    await this.repositorio.abrirRecuperacao(
      this.tokens.hash(token),
      achado.usuario.id,
      expiraEm,
    );

    const link = `${this.urlBase}/?recuperar=${encodeURIComponent(token)}`;
    const minutos = Math.round(this.duracaoRecuperacaoMs / 60000);
    // `void` + `catch` vazio: solta o envio e volta. O `catch` não é
    // negligência — é o que impede um SMTP fora do ar de virar rejeição de
    // promessa não tratada, que em Node derruba o processo inteiro.
    void this.notificador
      ?.enviar({
        para: achado.usuario.email,
        assunto: 'Processo Vivo — redefinir sua senha',
        texto:
          `Olá, ${achado.usuario.primeiroNome}.\n\n` +
          `Alguém pediu para redefinir a senha da sua conta no Processo Vivo. ` +
          `Se foi você, abra o link abaixo nos próximos ${minutos} minutos:\n\n` +
          `${link}\n\n` +
          `O link vale UMA vez e expira depois desse prazo.\n\n` +
          `Se não foi você, ignore esta mensagem: sua senha continua a mesma e ` +
          `ninguém consegue entrar sem abrir este link.\n`,
      })
      ?.catch(() => {});
  }

  /**
   * Redefine a senha a partir do link, e JÁ ENTRA.
   *
   * Todas as sessões anteriores caem — quem recuperou a senha pode estar
   * justamente tirando alguém de dentro. A sessão devolvida é nova.
   *
   * @throws {SessaoInvalidaError} link inválido, expirado ou já usado. Os três
   *   dão a mesma resposta: distinguir "já usado" de "não existe" contaria a
   *   quem achou o e-mail que o link foi real.
   * @throws {SenhaFracaError}
   */
  async redefinirSenha(token: string, senhaNova: string): Promise<SessaoAberta> {
    // A ordem destas três linhas é deliberada, e cada passo tem seu motivo.
    //
    // 1. `validar` primeiro, porque é de graça e porque uma senha curta NÃO
    //    pode queimar o link: um erro de digitação obrigaria a pedir outro
    //    e-mail, e com cinco pedidos por hora isso vira ficar de fora da
    //    própria conta.
    // 2. O token depois: SHA-256 e uma busca por chave primária, microssegundos.
    // 3. O scrypt por ÚLTIMO. Ele gasta ~50ms de CPU e 16 MB, bloqueando o
    //    event loop. Esta rota é pública: pagá-lo antes de conferir o token
    //    entregaria de graça, a qualquer um com um token inventado, 50ms de CPU
    //    por requisição — negação de serviço barata contra um processo de
    //    thread única, sem comprar defesa nenhuma, porque o token não é segredo
    //    escolhido por humano e não precisa de tempo constante.
    this.senhas.validar(senhaNova);

    const usuario = await this.repositorio.consumirRecuperacao(this.tokens.hash(token));
    if (!usuario) throw new SessaoInvalidaError();

    const guardada = this.senhas.guardar(senhaNova);
    await this.repositorio.trocarSenha(usuario.id, guardada);
    await this.repositorio.encerrarSessoesDe(usuario.id);
    await this.repositorio.registrarAcesso(usuario.id);
    return this.abrirSessao(usuario);
  }

  async limparSessoesExpiradas(): Promise<number> {
    return this.repositorio.limparSessoesExpiradas();
  }

  private async abrirSessao(usuario: Usuario): Promise<SessaoAberta> {
    const token = this.tokens.gerar();
    const expiraEm = new Date(Date.now() + this.duracaoSessaoMs);
    await this.repositorio.abrirSessao(this.tokens.hash(token), usuario.id, expiraEm);
    return { usuario, token, expiraEm };
  }
}
