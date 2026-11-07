/// <reference lib="dom" />
import AxeBuilder from 'axe-core';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHROMIUM } from './ambiente.js';
import { SENHA, montarCenarioDePagamento } from '../helpers/pagamentos.js';
import type { CenarioDePagamento } from '../helpers/pagamentos.js';
import { CODIGO, ProvedorFalso, identidade } from '../helpers/loginGoogle.js';

/*
 * Login com Google (v0.67.0) NUM NAVEGADOR: o botão na tela de entrada, o retorno com erro, o cartão em
 * "Minha conta" e a conta que nasce pelo Google. Servidor e console reais; o "Google" é o provedor falso,
 * e a navegação para accounts.google.com é interceptada (nenhuma rede). Contas sintéticas.
 */
const sem = CHROMIUM === undefined;
const EMAIL = 'ana@exemplo.test';
interface AxeNaPagina {
  axe: {
    run(
      raiz: Element,
      o: object,
    ): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }>;
  };
}

describe.skipIf(sem)('Login com Google, no navegador', { timeout: 90_000 }, () => {
  let browser: Browser;
  let cenario: CenarioDePagamento;
  let provedor: ProvedorFalso;
  let ctx: BrowserContext;
  let page: Page;
  let url = '';

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

  async function subir(largura = 1280, escuro = false, comLogin = true): Promise<void> {
    provedor = new ProvedorFalso();
    cenario = montarCenarioDePagamento({
      comPagamento: false,
      ...(comLogin ? { loginGoogle: { provedor } } : {}),
    });
    await cenario.servidor.listen({ host: '127.0.0.1', port: 0 });
    const addr = cenario.servidor.server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    ctx = await browser.newContext({
      viewport: { width: largura, height: 900 },
      colorScheme: escuro ? 'dark' : 'light',
    });
    page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e) => {
      throw e;
    });
  }

  /** O navegador NUNCA chega ao Google: a ida é interceptada e o teste "volta" pela rota de retorno. */
  async function interceptarGoogle(): Promise<{ idas: string[] }> {
    const idas: string[] = [];
    await page.route('https://accounts.google.com/**', async (rota) => {
      const u = rota.request().url();
      idas.push(u);
      const estado = new URL(u).searchParams.get('state') ?? '';
      await rota.fulfill({
        status: 302,
        headers: {
          location: `${url}/v1/sessoes/google/retorno?code=${CODIGO}&state=${encodeURIComponent(estado)}`,
        },
      });
    });
    return { idas };
  }

  const sobreRodagem = () =>
    page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

  it('o botão aparece nas duas abas só com o login ligado; desligado, a tela é a de antes', async () => {
    await subir();
    await page.goto(url);
    await page.locator('#c-google-bt').waitFor();
    expect((await page.locator('#c-google-bt').textContent())?.trim()).toBe(
      'Entrar com Google',
    );
    await page.getByRole('tab', { name: 'Criar conta' }).click();
    await page.locator('#c-google-bt').waitFor();
    expect((await page.locator('#c-google-bt').textContent())?.trim()).toBe(
      'Criar conta com Google',
    );
    expect(await page.locator('.lg-nota').textContent()).toContain(
      'Usamos só o seu nome e o seu e-mail',
    );
    await ctx.close();
    await cenario.servidor.close();

    await subir(1280, false, false);
    await page.goto(url);
    await page.locator('#c-email').waitFor();
    await page.waitForTimeout(300);
    expect(await page.locator('#c-google-bt').count()).toBe(0);
    expect(await page.locator('.lg-ou').count()).toBe(0);
  });

  it('o clique vai ao Google e a volta cria a conta e entra; a URL fica limpa e a trilha pede a OAB', async () => {
    await subir();
    provedor.quandoCodigo(CODIGO, identidade({ email: EMAIL }));
    const { idas } = await interceptarGoogle();
    await page.goto(url);
    await page.locator('#c-google-bt').waitFor();
    await page.locator('#c-google-bt').click();
    await page.locator('#lateral:not(.oculto)').waitFor();
    expect(idas).toHaveLength(1);
    expect(idas[0]?.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(
      true,
    );
    // O parâmetro do retorno saiu da barra, e a sessão está aberta.
    expect(new URL(page.url()).searchParams.has('google')).toBe(false);
    const eu = await page.evaluate(() => fetch('/v1/eu').then((r) => r.json()));
    expect(eu).toMatchObject({ usuario: { email: EMAIL }, trilha: { oab: false } });
    // Teclado: o botão da tela de entrada é focável e tem nome.
    await page.evaluate(() => fetch('/v1/sessoes', { method: 'DELETE' }));
    await page.goto(url);
    await page.locator('#c-google-bt').waitFor();
    await page.locator('#c-google-bt').focus();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('c-google-bt');
    expect(await page.locator('#c-google-bt').getAttribute('type')).toBe('button');
  });

  it('cancelado no Google: volta à entrada com a frase fixa, sem sessão, e o parâmetro sai da barra', async () => {
    await subir();
    await page.goto(`${url}/?google=erro&motivo=negado`);
    await page.locator('#c-google-aviso .lg-aviso').waitFor();
    expect((await page.locator('#c-google-aviso').textContent())?.trim()).toBe(
      'A entrada com o Google foi cancelada. Nada mudou.',
    );
    expect(page.url()).not.toContain('google=');
    expect(await page.locator('#lateral.oculto').count()).toBe(1);
    // Motivo desconhecido não vira texto do servidor: cai na frase genérica.
    await page.goto(`${url}/?google=erro&motivo=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
    await page.locator('#c-google-aviso .lg-aviso').waitFor();
    expect((await page.locator('#c-google-aviso').textContent())?.trim()).toBe(
      'Não foi possível falar com o Google agora. Tente de novo em instantes.',
    );
    expect(await page.locator('#c-google-aviso script').count()).toBe(0);
  });

  it('em "Minha conta": conta com senha liga e desliga; conta nascida pelo Google vê como criar senha', async () => {
    await subir();
    await page.goto(url);
    await page.getByRole('tab', { name: 'Criar conta' }).click();
    await page.fill('#c-nome', 'Maria Silva');
    await page.fill('#c-email', 'maria@exemplo.test');
    await page.fill('#c-senha', SENHA);
    await page.click('#c-enviar');
    await page.locator('#lateral:not(.oculto)').waitFor();
    await page.evaluate(() =>
      (window as unknown as { __processovivo_ir: (a: string) => void }).__processovivo_ir(
        'conta',
      ),
    );
    await page.locator('#g-ligar').waitFor();
    expect(await page.locator('#g-desligar').count()).toBe(0);

    provedor.quandoCodigo(
      CODIGO,
      identidade({ sujeito: 'sub-maria', email: 'qualquer@gmail.test' }),
    );
    await interceptarGoogle();
    const carregou = page.waitForEvent('load');
    await page.locator('#g-ligar').click();
    await carregou;
    await page.locator('#lateral:not(.oculto)').waitFor();
    await page.evaluate(() =>
      (window as unknown as { __processovivo_ir: (a: string) => void }).__processovivo_ir(
        'conta',
      ),
    );
    await page.locator('#g-desligar').waitFor();
    expect(await page.locator('#g-aviso').textContent()).toContain(
      'Conta Google ligada.',
    );
    page.once('dialog', (d) => void d.accept());
    await page.locator('#g-desligar').click();
    await page.locator('#g-ligar').waitFor();
    await ctx.close();
    await cenario.servidor.close();

    await subir();
    provedor.quandoCodigo(CODIGO, identidade({ email: EMAIL }));
    await interceptarGoogle();
    await page.goto(url);
    await page.locator('#c-google-bt').click();
    await page.locator('#lateral:not(.oculto)').waitFor();
    await page.evaluate(() =>
      (window as unknown as { __processovivo_ir: (a: string) => void }).__processovivo_ir(
        'conta',
      ),
    );
    await page.locator('#g-cartao .cartao').waitFor();
    expect(await page.locator('#g-desligar').count()).toBe(0);
    expect(await page.locator('#g-cartao').textContent()).toContain(
      'ainda não tem senha',
    );
  });

  for (const escuro of [false, true]) {
    it(`axe sem violações na entrada com o botão e em "Minha conta" (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
      await subir(1280, escuro);
      await page.goto(`${url}/?google=erro&motivo=negado`);
      await page.locator('#c-google-aviso .lg-aviso').waitFor();
      for (const aba of ['Entrar', 'Criar conta']) {
        await page.getByRole('tab', { name: aba }).click();
        await page.locator('#c-google-bt').waitFor();
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const r = await page.evaluate(() =>
          (window as unknown as AxeNaPagina).axe.run(
            // Só o que esta tela acrescentou: a nota de senha do cadastro (`.nota` em `--tinta3`) é de antes e mede
            // 4,2:1 — trocar a variável global é decisão à parte (CLAUDE.md, calendário).
            { include: [['#c-google']] } as unknown as Element,
            { rules: { 'color-contrast': { enabled: true } } },
          ),
        );
        expect(
          r.violations.map(
            (v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).join(' | ')}`,
          ),
        ).toEqual([]);
      }
    });
  }

  for (const w of [1920, 1366, 1280, 1024, 768, 390]) {
    it(`sem rolagem horizontal em ${w}px, com o botão nas duas abas`, async () => {
      await subir(w);
      await page.goto(url);
      for (const aba of ['Entrar', 'Criar conta']) {
        await page.getByRole('tab', { name: aba }).click();
        await page.locator('#c-google-bt').waitFor();
        expect(await sobreRodagem()).toBe(false);
        const dentro = await page.locator('#c-google-bt').evaluate((el) => {
          const r = el.getBoundingClientRect();
          const caixa = (
            el.closest('.entrada-caixa') as HTMLElement
          ).getBoundingClientRect();
          return r.left >= caixa.left && r.right <= caixa.right && r.height >= 44;
        });
        expect(dentro).toBe(true);
      }
    });
  }
});
