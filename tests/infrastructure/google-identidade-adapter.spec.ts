import { describe, expect, it } from 'vitest';
import {
  ESCOPOS_DO_LOGIN,
  GoogleIdentidadeAdapter,
} from '../../src/infrastructure/adapters/identidade/GoogleIdentidadeAdapter.js';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
} from '../../src/domain/errors/index.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  CODIGO_DO_GOOGLE,
  TOKEN_DE_ACESSO,
  TransporteFalso,
  resposta,
} from '../helpers/transporteDoDrive.js';

/* O adapter do login com Google (v0.67.0) contra um transporte de mentira. Nenhuma rede. */

const RETORNO = 'https://app.exemplo.test/v1/sessoes/google/retorno';

function adapter(t: TransporteFalso): GoogleIdentidadeAdapter {
  return new GoogleIdentidadeAdapter({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    transporte: t,
  });
}

const entrada = {
  codigo: CODIGO_DO_GOOGLE,
  verificador: 'VERIFICADOR-PKCE',
  uriDeRetorno: RETORNO,
};

describe('GoogleIdentidadeAdapter', () => {
  it('a URL de autorização pede só `openid email profile`, com PKCE, sem `offline` e sem somar escopos de outras conexões', () => {
    const url = new URL(
      adapter(new TransporteFalso()).urlDeAutorizacao({
        estado: 'E',
        desafio: 'D',
        uriDeRetorno: RETORNO,
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(url.searchParams.get('scope')).toBe(ESCOPOS_DO_LOGIN);
    expect(ESCOPOS_DO_LOGIN).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge')).toBe('D');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('E');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('access_type')).toBeNull();
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.toString()).not.toContain(CLIENT_SECRET);
  });

  it('troca o código pelo token (com segredo e verificador) e lê a identidade do userinfo', async () => {
    const t = new TransporteFalso().responder(
      resposta(200, {
        access_token: TOKEN_DE_ACESSO,
        scope: 'openid email profile',
        expires_in: 3600,
      }),
      resposta(200, {
        sub: 'sub-0001',
        email: 'Ana@Exemplo.test',
        email_verified: true,
        name: ' Ana Exemplo ',
      }),
    );
    const id = await adapter(t).identidadePeloCodigo(entrada);
    expect(id).toEqual({
      sujeito: 'sub-0001',
      email: 'Ana@Exemplo.test',
      emailVerificado: true,
      nome: 'Ana Exemplo',
    });
    const token = t.pedidos[0];
    expect(token?.url).toBe('https://oauth2.googleapis.com/token');
    const corpo = new URLSearchParams(String(token?.corpo));
    expect(corpo.get('code')).toBe(CODIGO_DO_GOOGLE);
    expect(corpo.get('code_verifier')).toBe('VERIFICADOR-PKCE');
    expect(corpo.get('client_secret')).toBe(CLIENT_SECRET);
    expect(corpo.get('redirect_uri')).toBe(RETORNO);
    expect(t.pedidos[1]?.headers?.authorization).toBe(`Bearer ${TOKEN_DE_ACESSO}`);
  });

  it('`email_verified` como texto "true" conta; ausente ou "false" é não verificado', async () => {
    const t = new TransporteFalso().responder(
      resposta(200, { access_token: TOKEN_DE_ACESSO }),
      resposta(200, { sub: 's', email: 'a@b.test', email_verified: 'true' }),
      resposta(200, { access_token: TOKEN_DE_ACESSO }),
      resposta(200, { sub: 's', email: 'a@b.test' }),
    );
    const a = adapter(t);
    expect((await a.identidadePeloCodigo(entrada)).emailVerificado).toBe(true);
    const segunda = await a.identidadePeloCodigo(entrada);
    expect(segunda.emailVerificado).toBe(false);
    expect(segunda.nome).toBeUndefined();
  });

  it('código recusado (4xx) é RespostaInvalida; 5xx e rede são ProviderIndisponivel — nunca com texto do Google', async () => {
    const t = new TransporteFalso().responder(
      resposta(400, { error: 'invalid_grant', error_description: 'SEGREDO-NA-MENSAGEM' }),
      resposta(503, 'fora'),
      new Error('ECONNRESET com a URL dentro'),
    );
    const a = adapter(t);
    await expect(a.identidadePeloCodigo(entrada)).rejects.toBeInstanceOf(
      RespostaInvalidaError,
    );
    await expect(a.identidadePeloCodigo(entrada)).rejects.toBeInstanceOf(
      ProviderIndisponivelError,
    );
    const erro = await a.identidadePeloCodigo(entrada).catch((e: Error) => e);
    expect(erro).toBeInstanceOf(ProviderIndisponivelError);
    for (const p of [erro]) {
      expect(String((p as Error).message)).not.toContain('SEGREDO-NA-MENSAGEM');
      expect(String((p as Error).message)).not.toContain('ECONNRESET');
    }
  });

  it('permissão do e-mail desmarcada, ou userinfo sem e-mail: recusa sem inventar identidade', async () => {
    const t = new TransporteFalso().responder(
      resposta(200, { access_token: TOKEN_DE_ACESSO, scope: 'openid profile' }),
      resposta(200, { access_token: TOKEN_DE_ACESSO }),
      resposta(200, { sub: 's', name: 'Sem e-mail' }),
    );
    const a = adapter(t);
    await expect(a.identidadePeloCodigo(entrada)).rejects.toBeInstanceOf(
      RespostaInvalidaError,
    );
    expect(t.pedidos).toHaveLength(1); // nem chamou o userinfo
    await expect(a.identidadePeloCodigo(entrada)).rejects.toBeInstanceOf(
      RespostaInvalidaError,
    );
  });
});
