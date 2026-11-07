import { randomBytes } from 'node:crypto';
import type { Usuario } from '../../domain/entities/Usuario.js';
import { normalizarEmail } from '../../domain/entities/Usuario.js';
import {
  CodigoDeAutorizacaoRecusadoError,
  DomainError,
  LoginGoogleRecusadoError,
  ProviderIndisponivelError,
} from '../../domain/errors/index.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { ProvedorDeIdentidade } from '../../domain/ports/ProvedorDeIdentidade.js';
import type { RepositorioIdentidades } from '../../domain/ports/RepositorioIdentidades.js';
import type { RepositorioUsuarios } from '../../domain/ports/RepositorioUsuarios.js';
import type { EstadosDeConexao } from '../politicas/estadosDeConexao.js';
import { EstadoDeConexaoRecusado } from '../politicas/estadosDeConexao.js';
import type { ServicoContas, SessaoAberta } from './ServicoContas.js';

/**
 * Login com Google (v0.67.0): uma PORTA DE ENTRADA a mais, nunca uma conta nova.
 *
 * O que entra pelo Google cai na mesma conta de `usuarios`, com o mesmo `workspace`, a mesma
 * sessão em cookie e o mesmo plano. Quem entra por senha e quem entra pelo Google é a mesma
 * pessoa para todo o resto do sistema — nenhuma rota de dados sabe por onde ela entrou.
 *
 * Três caminhos ao concluir, e a ordem importa:
 *
 * 1. **A identidade já está ligada a uma conta** → entra nela. É o caminho de todo dia.
 * 2. **Não está ligada, e há conta com o MESMO e-mail** → liga e entra, mas SÓ se o Google
 *    confirmou o e-mail (`email_verified`). Sem a confirmação, uma conta Google aberta com o
 *    e-mail de outra pessoa entraria na conta dela: é o roubo de conta que esta regra impede.
 * 3. **Não há conta** → cria uma, SEM senha, com o nome que o Google deu, e com o teste de
 *    assinatura de sempre. Para ter senha depois, a pessoa usa o "Esqueci minha senha".
 *
 * A ligação também pode ser feita de DENTRO da conta ("Minha conta" → "Ligar conta Google"):
 * aí o `state` assinado carrega a conta, e o retorno exige a MESMA sessão por cookie. Desligar
 * só é permitido com senha: uma conta sem senha e sem Google não teria por onde entrar.
 *
 * O `state` e o PKCE são os mesmos do Drive (`EstadosDeConexao`, com segredo próprio): a parte
 * assinada diz se o retorno é de login (`login:<nonce>`) ou de ligação (`conta:<id>`), e um
 * retorno de login nunca liga uma conta, nem um de ligação abre sessão para outra pessoa.
 *
 * Nada do Google é guardado além do `sub`: nem e-mail do provedor, nem token, nem foto.
 */
export type MotivoDoRetornoDoLogin =
  | 'negado'
  | 'estado_invalido'
  | 'autorizacao_recusada'
  | 'email_nao_verificado'
  | 'email_invalido'
  | 'conta_google_em_uso'
  | 'sessao_diferente'
  | 'indisponivel';

export type ResultadoDoRetorno =
  | {
      readonly ok: true;
      readonly tipo: 'sessao';
      readonly sessao: SessaoAberta;
      readonly contaNova: boolean;
    }
  | { readonly ok: true; readonly tipo: 'ligada' }
  | { readonly ok: false; readonly motivo: MotivoDoRetornoDoLogin };

export interface OpcoesServicoLoginGoogle {
  readonly provedor: ProvedorDeIdentidade;
  readonly identidades: RepositorioIdentidades;
  readonly usuarios: RepositorioUsuarios;
  readonly contas: ServicoContas;
  readonly estados: EstadosDeConexao;
  readonly uriDeRetorno: string;
  readonly logger: Logger;
  /** Só para teste. */
  readonly aleatorio?: (n: number) => Buffer;
}

const PREFIXO_LOGIN = 'login:';
const PREFIXO_CONTA = 'conta:';

export class ServicoLoginGoogle {
  constructor(private readonly o: OpcoesServicoLoginGoogle) {}

  /** A URL do Google para quem está FORA. O `state` leva um nonce próprio, não uma conta. */
  iniciarLogin(): { readonly url: string } {
    // Cada pedido ganha o próprio "dono" no `state`: o teto de pendentes do `EstadosDeConexao`
    // é por dono, e um dono único para todos os logins deixaria cinco pessoas abrirem a tela
    // do Google e a sexta invalidar a primeira.
    const dono =
      PREFIXO_LOGIN + (this.o.aleatorio ?? randomBytes)(9).toString('base64url');
    return this.url(dono);
  }

  /** A URL do Google para ligar a conta de quem JÁ está dentro. */
  iniciarLigacao(usuario: Usuario): { readonly url: string } {
    return this.url(PREFIXO_CONTA + usuario.id);
  }

  /** A pessoa cancelou na tela do Google: gasta o `state` para ele não ficar valendo. */
  descartar(estado: string): void {
    try {
      this.o.estados.consumir(estado);
    } catch {
      // Já era inválido, expirado ou usado: nada a fazer.
    }
  }

  /** @param usuarioDaSessao quem está logado no navegador que trouxe o retorno, se alguém. */
  async concluir(entrada: {
    readonly codigo: string;
    readonly estado: string;
    readonly usuarioDaSessao?: Usuario;
  }): Promise<ResultadoDoRetorno> {
    let dono: string;
    let verificador: string;
    try {
      const c = this.o.estados.consumir(entrada.estado);
      dono = c.workspace;
      verificador = c.verificador;
    } catch (erro) {
      if (erro instanceof EstadoDeConexaoRecusado)
        return { ok: false, motivo: 'estado_invalido' };
      throw erro;
    }

    const ligacao = dono.startsWith(PREFIXO_CONTA)
      ? dono.slice(PREFIXO_CONTA.length)
      : undefined;
    if (ligacao !== undefined && entrada.usuarioDaSessao?.id !== ligacao) {
      // O `state` é de uma ligação, mas quem trouxe o retorno não é a conta que a pediu
      // (ou ninguém está logado). Ligar aqui entregaria a conta de um à identidade de outro.
      return { ok: false, motivo: 'sessao_diferente' };
    }

    let identidade;
    try {
      identidade = await this.o.provedor.identidadePeloCodigo({
        codigo: entrada.codigo,
        verificador,
        uriDeRetorno: this.o.uriDeRetorno,
      });
    } catch (erro) {
      if (erro instanceof ProviderIndisponivelError) {
        this.o.logger.warn('login com Google: o Google não respondeu', {
          motivo: erro.codigo,
        });
        return { ok: false, motivo: 'indisponivel' };
      }
      if (erro instanceof DomainError) {
        // `motivoDoGoogle` é o `error` da resposta OAuth em lista fechada (v0.67.1): é o que
        // separa segredo errado (`invalid_client`) de código usado de novo (`invalid_grant`).
        this.o.logger.warn('login com Google: autorização recusada', {
          motivo: erro.codigo,
          ...(erro instanceof CodigoDeAutorizacaoRecusadoError
            ? { motivoDoGoogle: erro.motivoDoProvedor }
            : {}),
        });
        return { ok: false, motivo: 'autorizacao_recusada' };
      }
      throw erro;
    }
    const provedor = this.o.provedor.nome;
    const jaLigadaA = await this.o.identidades.usuarioDe(provedor, identidade.sujeito);

    if (ligacao !== undefined) {
      if (jaLigadaA !== undefined && jaLigadaA !== ligacao) {
        return { ok: false, motivo: 'conta_google_em_uso' };
      }
      await this.o.identidades.ligar(provedor, identidade.sujeito, ligacao);
      if (
        (await this.o.identidades.usuarioDe(provedor, identidade.sujeito)) !== ligacao
      ) {
        return { ok: false, motivo: 'conta_google_em_uso' };
      }
      this.o.logger.info('conta Google ligada pela própria conta', {});
      return { ok: true, tipo: 'ligada' };
    }

    if (jaLigadaA !== undefined) {
      const usuario = await this.o.usuarios.porId(jaLigadaA);
      if (!usuario) return { ok: false, motivo: 'estado_invalido' };
      return this.entrar(usuario, false);
    }

    // Identidade nova. Só o e-mail CONFIRMADO pelo Google serve para achar (ou criar) a conta.
    if (!identidade.emailVerificado) return { ok: false, motivo: 'email_nao_verificado' };
    let email: string;
    try {
      email = normalizarEmail(identidade.email);
    } catch {
      return { ok: false, motivo: 'email_invalido' };
    }

    const existente = await this.o.usuarios.porEmail(email);
    let usuario: Usuario;
    let contaNova = false;
    if (existente) {
      usuario = existente.usuario;
    } else {
      usuario = await this.o.contas.cadastrarSemSenha({
        email,
        nome: identidade.nome ?? '',
      });
      contaNova = true;
    }
    await this.o.identidades.ligar(provedor, identidade.sujeito, usuario.id);
    // Lê de volta: numa corrida (dois retornos do mesmo sujeito, ou a conta já com outro
    // sujeito), o banco ignorou o INSERT e quem decide é o que ficou gravado.
    if (
      (await this.o.identidades.usuarioDe(provedor, identidade.sujeito)) !== usuario.id
    ) {
      return { ok: false, motivo: 'conta_google_em_uso' };
    }
    this.o.logger.info('login com Google concluído', { contaNova });
    return this.entrar(usuario, contaNova);
  }

  /** A ligação desta conta, para a tela "Minha conta". */
  async situacao(usuario: Usuario): Promise<{
    readonly ligada: boolean;
    readonly ligadaEm: Date | undefined;
    readonly temSenha: boolean;
  }> {
    const l = await this.o.identidades.ligacaoDe(this.o.provedor.nome, usuario.id);
    return {
      ligada: l !== undefined,
      ligadaEm: l?.ligadaEm,
      temSenha: await this.o.contas.temSenha(usuario),
    };
  }

  /**
   * Desliga a conta Google. Recusa quando a conta não tem senha: desligar deixaria a pessoa
   * sem nenhum jeito de entrar.
   * @throws {LoginGoogleRecusadoError} `conta_sem_senha` | `nao_vinculada`
   */
  async desligar(usuario: Usuario): Promise<void> {
    if (!(await this.o.contas.temSenha(usuario))) {
      throw new LoginGoogleRecusadoError(
        'conta_sem_senha',
        'Crie uma senha antes de desligar a conta Google: sem as duas, não haveria como entrar.',
      );
    }
    const havia = await this.o.identidades.desligar(this.o.provedor.nome, usuario.id);
    if (!havia) {
      throw new LoginGoogleRecusadoError(
        'nao_vinculada',
        'Esta conta não está ligada ao Google.',
      );
    }
  }

  private url(dono: string): { readonly url: string } {
    const { estado, desafio } = this.o.estados.emitir(dono);
    return {
      url: this.o.provedor.urlDeAutorizacao({
        estado,
        desafio,
        uriDeRetorno: this.o.uriDeRetorno,
      }),
    };
  }

  private async entrar(
    usuario: Usuario,
    contaNova: boolean,
  ): Promise<ResultadoDoRetorno> {
    const sessao = await this.o.contas.abrirSessaoPara(usuario);
    return { ok: true, tipo: 'sessao', sessao, contaNova };
  }
}
