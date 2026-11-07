import { z } from 'zod';
import type {
  IdentidadeExterna,
  ProvedorDeIdentidade,
} from '../../../domain/ports/ProvedorDeIdentidade.js';
import {
  CodigoDeAutorizacaoRecusadoError,
  DomainError,
  ProviderIndisponivelError,
  RespostaInvalidaError,
  motivoDoProvedorOauth,
} from '../../../domain/errors/index.js';
import type {
  RespostaDoTransporte,
  TransporteDoDrive,
} from '../drive/TransporteDoDrive.js';

/**
 * Login com Google (v0.67.0): OpenID Connect, pelo MESMO cliente OAuth do Drive.
 *
 * Três escopos, e só os três: `openid email profile`. É o mínimo que diz quem é a pessoa
 * (`sub`), por qual e-mail (`email` + `email_verified`) e como se chama (`name`). Nada de
 * foto, Drive, agenda ou contatos — o Drive tem a conexão dele, com outro consentimento,
 * e as duas não se misturam (`include_granted_scopes=false`).
 *
 * A identidade é lida do `userinfo` com o token de acesso que o próprio Google acabou de
 * entregar, por TLS, em troca do código + segredo do cliente + PKCE. Por isso o `id_token`
 * não precisa ser verificado aqui (não se confere assinatura de JWT nem se baixa chave do
 * Google): a resposta do `userinfo` só pode ser do Google. O token de acesso vive só na
 * memória desta chamada e morre com ela — o login não precisa de nada depois da sessão
 * aberta, então `access_type=offline` NÃO é pedido e nenhum token de renovação existe.
 *
 * Nada aqui escreve token, código, segredo nem texto do Google em erro ou log: os erros
 * carregam só uma frase nossa.
 */
export const ESCOPOS_DO_LOGIN = 'openid email profile';
/** Como o escopo do e-mail pode voltar no token: o nome curto pedido e o longo que o Google usa. */
export const ESCOPOS_DE_EMAIL = [
  'email',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;
export const PROVEDOR_GOOGLE = 'google';

const URL_DE_AUTORIZACAO = 'https://accounts.google.com/o/oauth2/v2/auth';
const URL_DO_TOKEN = 'https://oauth2.googleapis.com/token';
const URL_DO_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

const esquemaDoToken = z.object({
  access_token: z.string().min(1),
  scope: z.string().optional(),
});

const esquemaDoUserinfo = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().min(3).max(320).optional(),
  // O Google manda booleano; o OIDC permite a string "true". Aceita os dois, decide depois.
  email_verified: z.union([z.boolean(), z.string()]).optional(),
  name: z.string().max(300).optional(),
});

export interface OpcoesGoogleIdentidadeAdapter {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly transporte: TransporteDoDrive;
}

export class GoogleIdentidadeAdapter implements ProvedorDeIdentidade {
  readonly nome = PROVEDOR_GOOGLE;

  constructor(private readonly opcoes: OpcoesGoogleIdentidadeAdapter) {}

  urlDeAutorizacao(entrada: {
    readonly estado: string;
    readonly desafio: string;
    readonly uriDeRetorno: string;
  }): string {
    const q = new URLSearchParams({
      client_id: this.opcoes.clientId,
      redirect_uri: entrada.uriDeRetorno,
      response_type: 'code',
      scope: ESCOPOS_DO_LOGIN,
      state: entrada.estado,
      // Sem `offline` e sem `consent`: o login não guarda nada depois da sessão. A tela de
      // escolha de conta aparece sempre, para quem tem mais de uma conta Google não cair na
      // errada sem ver.
      prompt: 'select_account',
      include_granted_scopes: 'false',
      code_challenge: entrada.desafio,
      code_challenge_method: 'S256',
    });
    return `${URL_DE_AUTORIZACAO}?${q.toString()}`;
  }

  async identidadePeloCodigo(entrada: {
    readonly codigo: string;
    readonly verificador: string;
    readonly uriDeRetorno: string;
  }): Promise<IdentidadeExterna> {
    const token = await this.chamar({
      metodo: 'POST',
      url: URL_DO_TOKEN,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      corpo: new URLSearchParams({
        client_id: this.opcoes.clientId,
        client_secret: this.opcoes.clientSecret,
        grant_type: 'authorization_code',
        code: entrada.codigo,
        code_verifier: entrada.verificador,
        redirect_uri: entrada.uriDeRetorno,
      }).toString(),
      timeoutMs: 20_000,
    });
    if (token.status >= 400 && token.status < 500) {
      // Código inválido, usado ou vencido, ou segredo errado: o Google respondeu, e a resposta
      // é "não". Só o `error` (lista fechada) segue ao log; a `error_description` fica aqui.
      const erro = (corpoJson(token) as { error?: unknown } | null)?.error;
      throw new CodigoDeAutorizacaoRecusadoError(this.nome, motivoDoProvedorOauth(erro));
    }
    if (token.status < 200 || token.status >= 300) {
      throw new ProviderIndisponivelError(this.nome, `token respondeu ${token.status}`);
    }
    const t = esquemaDoToken.safeParse(corpoJson(token));
    if (!t.success) {
      throw new RespostaInvalidaError(this.nome, 'resposta de token fora do contrato');
    }
    // O consentimento granular deixa a pessoa DESMARCAR o e-mail e ainda concluir a tela.
    // Sem e-mail não há conta: recusa-se aqui, antes de olhar o userinfo.
    //
    // ATENÇÃO (v0.67.1, visto em produção em 07/11/2026): pede-se `email`, mas o Google devolve
    // o escopo concedido pelo nome LONGO, `https://www.googleapis.com/auth/userinfo.email`.
    // A 0.67.0 procurava só `email` e recusava TODO login como "e-mail não concedido". Os dois
    // nomes valem; o teste de adapter usa o longo, que é o que o Google manda de fato.
    const concedidos = new Set((t.data.scope ?? '').split(/\s+/));
    const emailConcedido = ESCOPOS_DE_EMAIL.some((e) => concedidos.has(e));
    if (t.data.scope !== undefined && !emailConcedido) {
      throw new CodigoDeAutorizacaoRecusadoError(this.nome, 'escopo_negado');
    }

    const info = await this.chamar({
      metodo: 'GET',
      url: URL_DO_USERINFO,
      headers: { authorization: `Bearer ${t.data.access_token}` },
      timeoutMs: 20_000,
    });
    if (info.status < 200 || info.status >= 300) {
      throw new ProviderIndisponivelError(this.nome, `userinfo respondeu ${info.status}`);
    }
    const u = esquemaDoUserinfo.safeParse(corpoJson(info));
    if (!u.success || !u.data.email) {
      throw new RespostaInvalidaError(this.nome, 'identidade fora do contrato');
    }
    const verificado = u.data.email_verified;
    return {
      sujeito: u.data.sub,
      email: u.data.email,
      emailVerificado: verificado === true || verificado === 'true',
      nome: u.data.name?.trim() || undefined,
    };
  }

  /** Falha de rede vira erro do domínio, sem a mensagem original (que carrega a URL). */
  private async chamar(
    pedido: Parameters<TransporteDoDrive['requisitar']>[0],
  ): Promise<RespostaDoTransporte> {
    try {
      return await this.opcoes.transporte.requisitar(pedido);
    } catch (erro) {
      if (erro instanceof DomainError) throw erro;
      throw new ProviderIndisponivelError(
        this.nome,
        'falha de rede ao falar com o Google',
      );
    }
  }
}

function corpoJson(r: RespostaDoTransporte): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(r.bytes));
  } catch {
    return null;
  }
}
