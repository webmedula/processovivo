import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Config } from '../../src/infrastructure/config/env.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import {
  CODIGO,
  ProvedorFalso,
  estadoDaUrl,
  identidade,
} from '../helpers/loginGoogle.js';

/* Login com Google (v0.67.0) pelas rotas: provedor de mentira, nenhuma rede. */

const CHAVE = 'chave-de-teste-1234567890';
const SENHA = 'uma-senha-boa-o-bastante';
const RETORNO = '/v1/sessoes/google/retorno';

function config(): Config {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: CHAVE,
    CACHE_ENABLED: 'false',
    COOKIE_SECURE: 'false',
    RATE_LIMIT_MAX: '100000',
  } as NodeJS.ProcessEnv);
}

function cookieDe(resposta: { headers: Record<string, unknown> }): string {
  const bruto = resposta.headers['set-cookie'];
  const linha = Array.isArray(bruto) ? bruto[0] : bruto;
  return String(linha ?? '').split(';')[0] ?? '';
}

let servidor: FastifyInstance;
let app: Aplicacao;
let provedor: ProvedorFalso;

function montar(comLogin = true): void {
  provedor = new ProvedorFalso();
  app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    comAssinaturas: true,
    ...(comLogin ? { loginGoogle: { provedor } } : {}),
  });
  servidor = construirServidor(app, config());
}

afterEach(async () => {
  await servidor.close();
});

/** Começa o login e volta com o código: o que o navegador faria. */
async function entrarPeloGoogle(cookie?: string) {
  const inicio = await servidor.inject({ method: 'POST', url: '/v1/sessoes/google' });
  expect(inicio.statusCode).toBe(200);
  const url = (inicio.json() as { url: string }).url;
  expect(url.startsWith('https://accounts.google.com/')).toBe(true);
  return servidor.inject({
    method: 'GET',
    url: `${RETORNO}?code=${CODIGO}&state=${encodeURIComponent(estadoDaUrl(url))}`,
    ...(cookie ? { headers: { cookie } } : {}),
  });
}

async function cadastrar(email: string) {
  const r = await servidor.inject({
    method: 'POST',
    url: '/v1/contas',
    payload: { nome: 'Maria Silva', email, senha: SENHA },
  });
  expect(r.statusCode).toBe(201);
  return cookieDe(r);
}

describe('login com Google — desligado (o padrão)', () => {
  beforeEach(() => montar(false));

  it('a tela pergunta e recebe `disponivel: false`; as rotas de ação respondem 404', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/v1/sessoes/google' });
    expect(r.json()).toEqual({ disponivel: false });
    const p = await servidor.inject({ method: 'POST', url: '/v1/sessoes/google' });
    expect(p.statusCode).toBe(404);
    expect(p.json()).toMatchObject({ detalhes: { motivo: 'indisponivel' } });
    const v = await servidor.inject({ method: 'GET', url: `${RETORNO}?code=x&state=y` });
    expect(v.statusCode).toBe(404);
  });
});

describe('login com Google — entrar', () => {
  beforeEach(() => montar());

  it('a tela recebe `disponivel: true` sem precisar de sessão', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/v1/sessoes/google' });
    expect(r.json()).toEqual({ disponivel: true });
  });

  it('identidade nova com e-mail verificado: cria a conta SEM senha, já entra e ganha o teste do plano', async () => {
    provedor.quandoCodigo(CODIGO, identidade());
    const r = await entrarPeloGoogle();
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/?google=conta-nova');
    const cookie = cookieDe(r);
    expect(cookie).toMatch(/^processovivo_sessao=/);
    // O token não vai à URL nem ao corpo.
    expect(String(r.headers.location)).not.toContain(cookie.split('=')[1]);
    expect(r.body).not.toContain(cookie.split('=')[1]);

    const eu = await servidor.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { cookie },
    });
    expect(eu.statusCode).toBe(200);
    expect(eu.json()).toMatchObject({
      usuario: { email: 'ana@exemplo.test', nome: 'Ana Exemplo' },
      trilha: { conta: true, oab: false },
    });
    const assinatura = await servidor.inject({
      method: 'GET',
      url: '/v1/assinatura',
      headers: { cookie },
    });
    expect(assinatura.statusCode).toBe(200);
    expect(assinatura.json()).toMatchObject({ assinatura: { ehTeste: true } });
    // Não entra por senha nenhuma (a conta nasceu sem).
    const porSenha = await servidor.inject({
      method: 'POST',
      url: '/v1/sessoes',
      payload: { email: 'ana@exemplo.test', senha: 'sem-senha' },
    });
    expect(porSenha.statusCode).toBe(401);
    // E "Minha conta" sabe que não há senha.
    const g = await servidor.inject({
      method: 'GET',
      url: '/v1/eu/google',
      headers: { cookie },
    });
    expect(g.json()).toMatchObject({ disponivel: true, ligada: true, temSenha: false });
  });

  it('segunda entrada com a mesma identidade cai na MESMA conta, mesmo que o e-mail do Google tenha mudado', async () => {
    provedor.quandoCodigo(CODIGO, identidade());
    const primeira = await entrarPeloGoogle();
    const id1 = (
      await servidor.inject({
        method: 'GET',
        url: '/v1/eu',
        headers: { cookie: cookieDe(primeira) },
      })
    ).json() as { usuario: { id: string } };

    provedor.quandoCodigo(CODIGO, identidade({ email: 'outro@exemplo.test' }));
    const segunda = await entrarPeloGoogle();
    expect(segunda.headers.location).toBe('/?google=ok');
    const id2 = (
      await servidor.inject({
        method: 'GET',
        url: '/v1/eu',
        headers: { cookie: cookieDe(segunda) },
      })
    ).json() as { usuario: { id: string; email: string } };
    expect(id2.usuario.id).toBe(id1.usuario.id);
    expect(id2.usuario.email).toBe('ana@exemplo.test');
  });

  it('conta que já existe com o mesmo e-mail VERIFICADO: liga e entra nela, sem criar outra', async () => {
    await cadastrar('ana@exemplo.test');
    provedor.quandoCodigo(CODIGO, identidade({ nome: 'Outro Nome' }));
    const r = await entrarPeloGoogle();
    expect(r.headers.location).toBe('/?google=ok');
    const eu = await servidor.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { cookie: cookieDe(r) },
    });
    // A conta é a de antes: nome de antes, senha de antes.
    expect(eu.json()).toMatchObject({ usuario: { nome: 'Maria Silva' } });
    const porSenha = await servidor.inject({
      method: 'POST',
      url: '/v1/sessoes',
      payload: { email: 'ana@exemplo.test', senha: SENHA },
    });
    expect(porSenha.statusCode).toBe(200);
  });

  it('e-mail NÃO verificado pelo Google nunca entra numa conta existente nem cria conta', async () => {
    await cadastrar('ana@exemplo.test');
    provedor.quandoCodigo(CODIGO, identidade({ emailVerificado: false }));
    const r = await entrarPeloGoogle();
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/?google=erro&motivo=email_nao_verificado');
    expect(r.headers['set-cookie']).toBeUndefined();
    const sujeitoNovo = identidade({
      sujeito: 'sub-0002',
      email: 'novo@exemplo.test',
      emailVerificado: false,
    });
    provedor.quandoCodigo(CODIGO, sujeitoNovo);
    const r2 = await entrarPeloGoogle();
    expect(r2.headers.location).toBe('/?google=erro&motivo=email_nao_verificado');
    expect(await app.usuarios.porEmail('novo@exemplo.test')).toBeUndefined();
  });

  it('o `state` vale UMA vez: repetir o retorno é `estado_invalido`, e um inventado também', async () => {
    provedor.quandoCodigo(CODIGO, identidade());
    const inicio = await servidor.inject({ method: 'POST', url: '/v1/sessoes/google' });
    const estado = estadoDaUrl((inicio.json() as { url: string }).url);
    const ok = await servidor.inject({
      method: 'GET',
      url: `${RETORNO}?code=${CODIGO}&state=${encodeURIComponent(estado)}`,
    });
    expect(ok.headers.location).toBe('/?google=conta-nova');
    const repetido = await servidor.inject({
      method: 'GET',
      url: `${RETORNO}?code=${CODIGO}&state=${encodeURIComponent(estado)}`,
    });
    expect(repetido.headers.location).toBe('/?google=erro&motivo=estado_invalido');
    const inventado = await servidor.inject({
      method: 'GET',
      url: `${RETORNO}?code=${CODIGO}&state=abc.def`,
    });
    expect(inventado.headers.location).toBe('/?google=erro&motivo=estado_invalido');
    // Só UMA ida ao provedor: o `state` ruim é recusado antes de qualquer chamada.
    expect(provedor.pedidos).toHaveLength(1);
  });

  it('cancelado na tela do Google: volta com `negado`, o state é gasto e o provedor não é chamado', async () => {
    const inicio = await servidor.inject({ method: 'POST', url: '/v1/sessoes/google' });
    const estado = estadoDaUrl((inicio.json() as { url: string }).url);
    const r = await servidor.inject({
      method: 'GET',
      url: `${RETORNO}?error=access_denied&state=${encodeURIComponent(estado)}`,
    });
    expect(r.headers.location).toBe('/?google=erro&motivo=negado');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(provedor.pedidos).toHaveLength(0);
    const depois = await servidor.inject({
      method: 'GET',
      url: `${RETORNO}?code=${CODIGO}&state=${encodeURIComponent(estado)}`,
    });
    expect(depois.headers.location).toBe('/?google=erro&motivo=estado_invalido');
  });

  it('o Google recusa o código ou não responde: motivo de lista fechada, sem sessão e sem texto do provedor', async () => {
    provedor.quandoCodigo(CODIGO, 'recusa');
    const r = await entrarPeloGoogle();
    expect(r.headers.location).toBe('/?google=erro&motivo=autorizacao_recusada');
    expect(r.headers['set-cookie']).toBeUndefined();
    provedor.quandoCodigo(CODIGO, 'indisponivel');
    const r2 = await entrarPeloGoogle();
    expect(r2.headers.location).toBe('/?google=erro&motivo=indisponivel');
  });
});

describe('login com Google — ligar e desligar de dentro da conta', () => {
  beforeEach(() => montar());

  it('"Minha conta" vê a ligação; ligar exige a MESMA sessão no retorno; desligar funciona com senha', async () => {
    const cookie = await cadastrar('maria@exemplo.test');
    const antes = await servidor.inject({
      method: 'GET',
      url: '/v1/eu/google',
      headers: { cookie },
    });
    expect(antes.json()).toEqual({
      disponivel: true,
      ligada: false,
      ligadaEm: null,
      temSenha: true,
    });

    const inicio = await servidor.inject({
      method: 'POST',
      url: '/v1/eu/google',
      headers: { cookie },
    });
    expect(inicio.statusCode).toBe(200);
    const estado = estadoDaUrl((inicio.json() as { url: string }).url);
    provedor.quandoCodigo(CODIGO, identidade({ email: 'qualquer@gmail.test' }));

    // Sem a sessão: recusado, e o state foi gasto.
    const semSessao = await servidor.inject({
      method: 'GET',
      url: `${RETORNO}?code=${CODIGO}&state=${encodeURIComponent(estado)}`,
    });
    expect(semSessao.headers.location).toBe('/?google=erro&motivo=sessao_diferente');
    expect(provedor.pedidos).toHaveLength(0);

    const inicio2 = await servidor.inject({
      method: 'POST',
      url: '/v1/eu/google',
      headers: { cookie },
    });
    const estado2 = estadoDaUrl((inicio2.json() as { url: string }).url);
    const ligou = await servidor.inject({
      method: 'GET',
      url: `${RETORNO}?code=${CODIGO}&state=${encodeURIComponent(estado2)}`,
      headers: { cookie },
    });
    expect(ligou.headers.location).toBe('/?google=ligada');
    // Ligar NÃO abre sessão nova: o cookie de quem já está dentro continua o mesmo.
    expect(ligou.headers['set-cookie']).toBeUndefined();
    const depois = await servidor.inject({
      method: 'GET',
      url: '/v1/eu/google',
      headers: { cookie },
    });
    expect(depois.json()).toMatchObject({ ligada: true, temSenha: true });
    expect(typeof (depois.json() as { ligadaEm: string }).ligadaEm).toBe('string');

    // Agora o login pelo Google entra NESTA conta.
    const entrou = await entrarPeloGoogle();
    expect(entrou.headers.location).toBe('/?google=ok');
    const eu = await servidor.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { cookie: cookieDe(entrou) },
    });
    expect(eu.json()).toMatchObject({ usuario: { email: 'maria@exemplo.test' } });

    const desligou = await servidor.inject({
      method: 'DELETE',
      url: '/v1/eu/google',
      headers: { cookie },
    });
    expect(desligou.json()).toEqual({ desligada: true });
    const deNovo = await servidor.inject({
      method: 'DELETE',
      url: '/v1/eu/google',
      headers: { cookie },
    });
    expect(deNovo.statusCode).toBe(404);
    expect(deNovo.json()).toMatchObject({ detalhes: { motivo: 'nao_vinculada' } });
  });

  it('a identidade de uma conta não liga em outra: `conta_google_em_uso`, e nada muda', async () => {
    provedor.quandoCodigo(CODIGO, identidade());
    await entrarPeloGoogle(); // Ana, pelo Google
    const cookieB = await cadastrar('bruno@exemplo.test');
    const inicio = await servidor.inject({
      method: 'POST',
      url: '/v1/eu/google',
      headers: { cookie: cookieB },
    });
    const estado = estadoDaUrl((inicio.json() as { url: string }).url);
    const r = await servidor.inject({
      method: 'GET',
      url: `${RETORNO}?code=${CODIGO}&state=${encodeURIComponent(estado)}`,
      headers: { cookie: cookieB },
    });
    expect(r.headers.location).toBe('/?google=erro&motivo=conta_google_em_uso');
    const g = await servidor.inject({
      method: 'GET',
      url: '/v1/eu/google',
      headers: { cookie: cookieB },
    });
    expect(g.json()).toMatchObject({ ligada: false });
  });

  it('conta que nasceu pelo Google não desliga sem senha (409), e passa a poder depois de redefinir a senha', async () => {
    provedor.quandoCodigo(CODIGO, identidade());
    const cookie = cookieDe(await entrarPeloGoogle());
    const r = await servidor.inject({
      method: 'DELETE',
      url: '/v1/eu/google',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ detalhes: { motivo: 'conta_sem_senha' } });
    expect(
      (
        await servidor.inject({
          method: 'GET',
          url: '/v1/eu/google',
          headers: { cookie },
        })
      ).json(),
    ).toMatchObject({ ligada: true });
  });

  it('as rotas de /v1/eu/google exigem sessão: chave de API e anônimo recebem 401', async () => {
    const anonimo = await servidor.inject({ method: 'GET', url: '/v1/eu/google' });
    expect(anonimo.statusCode).toBe(401);
    const chave = await servidor.inject({
      method: 'POST',
      url: '/v1/eu/google',
      headers: { 'x-api-key': CHAVE },
    });
    expect(chave.statusCode).toBe(401);
  });
});
