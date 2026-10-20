/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHROMIUM } from './ambiente.js';
import {
  CHAVE_DE_API,
  SENHA,
  configDePagamento,
  montarCenarioDePagamento,
  precificar,
} from '../helpers/pagamentos.js';
import type { CenarioDePagamento } from '../helpers/pagamentos.js';
import { construirServidor } from '../../src/main/http/servidor.js';

/*
 * O plano escolhido no site atravessando cadastro e login (v0.45.0), NUM NAVEGADOR: servidor e console
 * reais, gateway falso (sem rede), contas sintéticas. O site de vendas é só um link para a raiz.
 */
const sem = CHROMIUM === undefined;
const CHECKOUT_FALSO = 'https://pagamento-falso.exemplo.invalid/**';
const EMAIL = 'ana@exemplo.test';

describe.skipIf(sem)('Plano escolhido no site, no navegador', { timeout: 90_000 }, () => {
  let browser: Browser;
  let cenario: CenarioDePagamento;
  let ctx: BrowserContext;
  let page: Page;
  let url = '';
  const dialogos: string[] = [];
  const pedidosAoCheckout: string[] = [];

  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: CHROMIUM as string,
      args: ['--no-sandbox'],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  afterEach(async () => {
    await ctx?.close();
    await cenario?.servidor.close();
  });

  async function subir(
    opcoes: { comPagamento?: boolean; comConta?: boolean; largura?: number } = {},
  ): Promise<void> {
    cenario = montarCenarioDePagamento({
      comPagamento: opcoes.comPagamento ?? true,
      comAssinaturas: true,
    });
    const servidor = construirServidor(
      cenario.app,
      configDePagamento({ PROCESSOVIVO_TERMOS_URL: 'https://exemplo.test/termos' }),
    );
    await cenario.servidor.close();
    cenario = { ...cenario, servidor };
    // `pecas` vendável; `acompanhamento` à venda SEM preço; `ia` fora de venda.
    await precificar(cenario, 'pecas', 4990);
    await precificar(cenario, 'acompanhamento', null);
    if (opcoes.comConta) {
      await servidor.inject({
        method: 'POST',
        url: '/v1/contas',
        payload: { nome: 'Pessoa Sintética', email: EMAIL, senha: SENHA },
      });
    }
    await servidor.listen({ host: '127.0.0.1', port: 0 });
    const addr = servidor.server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    ctx = await browser.newContext({
      viewport: { width: opcoes.largura ?? 1280, height: 900 },
    });
    await ctx.route(CHECKOUT_FALSO, (r) =>
      r.fulfill({ contentType: 'text/html', body: '<title>checkout falso</title>' }),
    );
    page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e) => {
      throw e;
    });
    page.on('dialog', async (d) => {
      dialogos.push(d.message());
      await d.dismiss();
    });
    page.on('request', (r) => {
      if (r.url().endsWith('/v1/assinatura/checkout')) pedidosAoCheckout.push(r.method());
    });
    dialogos.length = 0;
    pedidosAoCheckout.length = 0;
  }

  async function criarConta(): Promise<void> {
    await page.fill('#c-nome', 'Pessoa Sintética');
    await page.fill('#c-email', EMAIL);
    await page.fill('#c-senha', SENHA);
    await page.click('#c-enviar');
  }
  async function entrar(): Promise<void> {
    await page.fill('#c-email', EMAIL);
    await page.fill('#c-senha', SENHA);
    await page.click('#c-enviar');
  }

  const painel = () => page.getByRole('group', { name: 'Confirmar assinatura' });

  it('"Assinar agora": site → cadastro (já aberto em "Criar conta") → confirmação do plano; NADA é cobrado', async () => {
    await subir();
    await page.goto(`${url}/?plano=pecas&assinar=1&conta=1`);
    await page.locator('#c-nome').waitFor();
    // O cadastro abriu direto, e os parâmetros saíram da barra de endereço.
    expect(
      await page.getByRole('tab', { name: 'Criar conta' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(new URL(page.url()).search).toBe('');
    await criarConta();
    await painel().waitFor();
    const texto = await painel().innerText();
    expect(texto).toContain('Peças');
    expect(texto).toMatch(/R\$\s49,90 por mês/);
    expect(texto).toContain('Renovação automática. Você pode cancelar quando quiser.');
    expect(texto).toContain('Ambiente de teste, nenhuma cobrança real.');
    expect(await painel().getByRole('checkbox').isChecked()).toBe(false);
    expect(
      await painel()
        .getByRole('button', { name: 'Continuar para o pagamento' })
        .isDisabled(),
    ).toBe(true);
    expect(
      await painel().getByRole('link', { name: 'Termos de Uso' }).getAttribute('href'),
    ).toBe('https://exemplo.test/termos');
    expect(pedidosAoCheckout).toEqual([]);
    expect(cenario.gateway.pedidos).toHaveLength(0);
    // O plano foi consumido: recarregar não reabre a confirmação por conta própria.
    await page.reload();
    await page.locator('#nav-conta').click();
    await page.locator('#pv-pagamento .pgto').waitFor();
    expect(await painel().count()).toBe(0);
  });

  it('só depois do aceite e do clique em "Continuar" o checkout é criado, com o aceite registrado', async () => {
    await subir();
    await page.goto(`${url}/?plano=pecas&assinar=1&conta=1`);
    await criarConta();
    await painel().waitFor();
    await painel().getByRole('checkbox').check();
    await painel().getByRole('button', { name: 'Continuar para o pagamento' }).click();
    await page.waitForURL(
      /pagamento-falso\.exemplo\.invalid\/checkout\/fake-assinatura-1/,
    );
    expect(cenario.gateway.pedidos).toHaveLength(1);
    const u = (await cenario.app.usuarios.porEmail(EMAIL))!.usuario;
    const aceites = await cenario.app.pagamentos!.aceitesDe(u.workspace);
    expect(aceites).toMatchObject([{ versao: '1.1', plano: 'pecas' }]);
  });

  it('sem "assinar": entra no teste normalmente (Atualizações), sem abrir checkout, e o plano fica DESTACADO por texto em Minha conta', async () => {
    await subir();
    await page.goto(`${url}/?plano=pecas&conta=1`);
    await criarConta();
    await page.locator('#nav-conta').waitFor({ state: 'visible' });
    // Segue na aba inicial: nenhuma confirmação.
    // Espera o console marcar a aba ativa (antes disso o atributo `class` ainda não existe).
    await page.waitForFunction(() =>
      /on|ativo|atual/.test(document.getElementById('nav-novidades')?.className ?? ''),
    );
    expect(await painel().count()).toBe(0);
    await page.locator('#nav-conta').click();
    await page.locator('.pgto-plano-escolhido').waitFor();
    expect(await page.locator('.pgto-escolhido').innerText()).toBe('Plano escolhido');
    expect(await painel().count()).toBe(0);
    expect(pedidosAoCheckout).toEqual([]);
    expect(cenario.gateway.pedidos).toHaveLength(0);
  });

  it('conta já existente que entra com ?plano= segue o mesmo caminho', async () => {
    await subir({ comConta: true });
    await page.goto(`${url}/?plano=pecas&assinar=1`);
    await page.locator('#c-email').waitFor();
    // Sem `conta=1` a tela abre em "Entrar".
    expect(
      await page.getByRole('tab', { name: 'Entrar' }).getAttribute('aria-selected'),
    ).toBe('true');
    await entrar();
    await painel().waitFor();
    expect(cenario.gateway.pedidos).toHaveLength(0);
  });

  it('o plano sobrevive a um erro de login: errar a senha e acertar depois ainda abre a confirmação', async () => {
    await subir({ comConta: true });
    await page.goto(`${url}/?plano=pecas&assinar=1`);
    await page.fill('#c-email', EMAIL);
    await page.fill('#c-senha', 'senha-errada-qualquer');
    await page.click('#c-enviar');
    await page.locator('#c-erro .nota').waitFor();
    await entrar();
    await painel().waitFor();
  });

  const INVALIDOS: Array<[string, string]> = [
    ['formato fora do catálogo', 'PECAS'],
    ['inexistente', 'nao-existe'],
    ['plano à venda SEM preço', 'acompanhamento'],
    ['plano fora de venda', 'ia'],
    ['URL', encodeURIComponent('https://evil.example.test/')],
    ['caminho', encodeURIComponent('//evil.example.test/x')],
    ['script', encodeURIComponent('<script>alert(1)</script>')],
    ['valor enorme', 'a'.repeat(5000)],
    ['vazio', ''],
  ];
  for (const [nome, valor] of INVALIDOS) {
    it(`?plano= inválido (${nome}) é ignorado em silêncio: login normal, sem confirmação, sem destaque, sem redirecionamento`, async () => {
      await subir({ comConta: true });
      await page.goto(`${url}/?plano=${valor}&assinar=1`);
      await page.locator('#c-email').waitFor();
      expect(new URL(page.url()).origin).toBe(url);
      expect(new URL(page.url()).search).toBe('');
      await entrar();
      await page.locator('#nav-conta').waitFor({ state: 'visible' });
      await page.locator('#nav-conta').click();
      await page.locator('#pv-pagamento .pgto').waitFor();
      expect(await painel().count()).toBe(0);
      expect(await page.locator('.pgto-escolhido').count()).toBe(0);
      expect(new URL(page.url()).origin).toBe(url);
      expect(dialogos).toEqual([]);
      expect(pedidosAoCheckout).toEqual([]);
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    });
  }

  it('`conta=1` com plano inválido ainda abre o cadastro, sem plano e sem confirmação', async () => {
    await subir();
    await page.goto(
      `${url}/?plano=${encodeURIComponent('https://evil.example.test/')}&assinar=1&conta=1`,
    );
    await page.locator('#c-nome').waitFor();
    await criarConta();
    await page.locator('#nav-conta').waitFor({ state: 'visible' });
    await page.locator('#nav-conta').click();
    await page.locator('#pv-pagamento .pgto').waitFor();
    expect(await painel().count()).toBe(0);
    expect(await page.locator('.pgto-escolhido').count()).toBe(0);
    expect(new URL(page.url()).origin).toBe(url);
  });

  it('`assinar=1` sozinho (sem plano) não faz nada', async () => {
    await subir({ comConta: true });
    await page.goto(`${url}/?assinar=1`);
    await page.locator('#c-email').waitFor();
    await entrar();
    await page.locator('#nav-conta').waitFor({ state: 'visible' });
    await page.locator('#nav-conta').click();
    await page.locator('#pv-pagamento .pgto').waitFor();
    expect(await painel().count()).toBe(0);
  });

  it('`assinar` com valor diferente de 1 só destaca o plano: nunca abre a confirmação', async () => {
    await subir({ comConta: true });
    await page.goto(`${url}/?plano=pecas&assinar=true`);
    await page.locator('#c-email').waitFor();
    await entrar();
    await page.locator('#nav-conta').waitFor({ state: 'visible' });
    expect(await painel().count()).toBe(0);
  });

  it('plano guardado EXPIRADO (mais de 30 minutos) é descartado', async () => {
    await subir({ comConta: true });
    await page.goto(`${url}/?plano=pecas&assinar=1`);
    await page.locator('#c-email').waitFor();
    await page.evaluate(() => {
      const k = 'processovivo.plano-escolhido';
      const o = JSON.parse(sessionStorage.getItem(k) ?? '{}');
      o.ate = Date.now() - 1000;
      sessionStorage.setItem(k, JSON.stringify(o));
    });
    await entrar();
    await page.locator('#nav-conta').waitFor({ state: 'visible' });
    // A confirmação só aparece em Minha conta; sem plano válido, a aba inicial segue.
    await page.locator('#nav-conta').click();
    await page.locator('#pv-pagamento .pgto').waitFor();
    expect(await painel().count()).toBe(0);
    expect(await page.locator('.pgto-escolhido').count()).toBe(0);
  });

  it('sessionStorage indisponível: a reserva em memória faz o fluxo funcionar mesmo assim', async () => {
    await subir({ comConta: true });
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        get() {
          throw new Error('bloqueado');
        },
      });
    });
    await page.goto(`${url}/?plano=pecas&assinar=1`);
    await page.locator('#c-email').waitFor();
    await entrar();
    await painel().waitFor();
  });

  it('pagamento DESLIGADO: a confirmação não aparece e a pessoa cai no teste grátis', async () => {
    await subir({ comPagamento: false, comConta: true });
    await page.goto(`${url}/?plano=pecas&assinar=1`);
    await page.locator('#c-email').waitFor();
    await entrar();
    await page.locator('#nav-conta').waitFor({ state: 'visible' });
    await page.locator('#nav-novidades').waitFor();
    expect(await painel().count()).toBe(0);
    await page.locator('#nav-conta').click();
    expect(await page.locator('.pgto-plano-escolhido').count()).toBe(0);
    expect(await page.getByRole('button', { name: /Assinar|Continuar/ }).count()).toBe(0);
  });

  it('renovação automática já ativa (de QUALQUER plano): não abre a confirmação e diz como trocar', async () => {
    await subir({ comConta: true });
    // A conta assina o plano `acompanhamento` (com preço) e a renovação fica autorizada.
    await precificar(cenario, 'acompanhamento', 1990);
    const u = (await cenario.app.usuarios.porEmail(EMAIL))!.usuario;
    await cenario.app.pagamentos!.iniciarCheckout({
      workspace: u.workspace,
      plano: 'acompanhamento',
      aceiteTermos: true,
    });
    const cob = (await cenario.app.pagamentos!.cobrancaDe(u.workspace))!;
    cenario.gateway.definirEstado(cob.gatewayId!, 'autorizada');
    const { avisar } = await import('../helpers/pagamentos.js');
    await avisar(cenario, { topico: 'subscription_preapproval', id: cob.gatewayId! });
    await page.goto(`${url}/?plano=pecas&assinar=1`);
    await page.locator('#c-email').waitFor();
    await entrar();
    await page
      .locator('#pv-pagamento .tt', { hasText: 'Renovação automática ativa' })
      .waitFor();
    expect(await painel().count()).toBe(0);
    expect(await page.locator('.pgto-erro[role="alert"]').innerText()).toContain(
      'Para trocar de plano, cancele a renovação atual primeiro.',
    );
    expect(cenario.gateway.pedidos).toHaveLength(1); // só o do `iniciarCheckout` de preparação
  });

  it('plano pago e vigente (Pix) do MESMO plano: não abre checkout e mostra o estado atual', async () => {
    await subir({ comConta: true });
    const u = (await cenario.app.usuarios.porEmail(EMAIL))!.usuario;
    await cenario.app.assinaturas.liberar({
      workspace: u.workspace,
      plano: 'pecas',
      meses: 3,
    });
    await page.goto(`${url}/?plano=pecas&assinar=1`);
    await page.locator('#c-email').waitFor();
    await entrar();
    await page.locator('.pgto-erro[role="alert"]').waitFor();
    expect(await page.locator('.pgto-erro[role="alert"]').innerText()).toMatch(
      /O plano Peças já está vigente até \d{2}\/\d{2}\/\d{4}\./,
    );
    expect(await painel().count()).toBe(0);
  });

  it('conta de chave de API (sem "Minha conta"): o plano é descartado e a chave segue recusada no checkout', async () => {
    await subir();
    await page.goto(`${url}/?plano=pecas&assinar=1`);
    await page
      .locator('#c-chave')
      .waitFor({ state: 'attached' })
      .catch(() => undefined);
    await page.evaluate(
      (chave) => localStorage.setItem('processovivo.chave', chave),
      CHAVE_DE_API,
    );
    await page.reload();
    await page.waitForSelector('#nav-novidades', { state: 'visible' });
    expect(await page.locator('#nav-conta').isVisible()).toBe(false);
    expect(await painel().count()).toBe(0);
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    // O servidor mantém a recusa.
    const r = await cenario.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { 'x-api-key': CHAVE_DE_API },
      payload: { plano: 'pecas', aceiteTermos: true },
    });
    expect(r.statusCode).toBe(403);
  });
});
