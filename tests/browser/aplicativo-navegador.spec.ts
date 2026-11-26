/// <reference lib="dom" />
import AxeBuilder from 'axe-core';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHROMIUM } from './ambiente.js';
import { montarCenarioDePagamento } from '../helpers/pagamentos.js';
import type { CenarioDePagamento } from '../helpers/pagamentos.js';

/*
 * v0.70.0 NUM NAVEGADOR: o console vira aplicativo instalável. Servidor real em 127.0.0.1 (contexto
 * seguro, como o HTTPS de produção). Prova: o worker registra e assume a página, o Chrome lê o
 * manifesto e os ícones, nada vai para o Cache Storage, e sem rede a página "sem conexão" aparece
 * (com axe nos dois temas e sem rolagem horizontal) e o "Tentar de novo" volta ao console.
 */
const sem = CHROMIUM === undefined;
interface AxeNaPagina {
  axe: {
    run(
      raiz: Document,
      o: object,
    ): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }>;
  };
}

describe.skipIf(sem)(
  'Aplicativo instalável (PWA), no navegador',
  { timeout: 60_000 },
  () => {
    let browser: Browser;
    let cenario: CenarioDePagamento;
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

    async function subir(largura = 1280, escuro = false): Promise<void> {
      cenario = montarCenarioDePagamento({ comPagamento: false });
      await cenario.servidor.listen({ host: '127.0.0.1', port: 0 });
      const addr = cenario.servidor.server.address();
      url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      ctx = await browser.newContext({
        viewport: { width: largura, height: 900 },
        colorScheme: escuro ? 'dark' : 'light',
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
    }

    /** Abre o console e espera o worker assumir a página (`clients.claim`). */
    async function abrirComWorker(): Promise<void> {
      await page.goto(url);
      await page.locator('#c-email').waitFor();
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    }

    it('registra o worker em "/", lê o manifesto e não guarda nada no aparelho', async () => {
      await subir();
      await abrirComWorker();
      const estado = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement;
        const m = (await (await fetch(link.href)).json()) as { icons: { src: string }[] };
        const icones = await Promise.all(
          m.icons.map(
            (i) =>
              new Promise<string>((ok) => {
                const img = new Image();
                img.onload = () => ok(`${img.naturalWidth}x${img.naturalHeight}`);
                img.onerror = () => ok('erro');
                img.src = i.src;
              }),
          ),
        );
        return { escopo: reg?.scope ?? '', icones, caches: await caches.keys() };
      });
      expect(estado.escopo).toBe(`${url}/`);
      expect(estado.icones).toEqual(['192x192', '512x512', '512x512']);
      expect(estado.caches).toEqual([]);
      // O próprio Chrome diz se a página é instalável (o que liga o "Instalar"): nenhuma pendência dela.
      const cdp = await ctx.newCDPSession(page);
      const { installabilityErrors } = (await cdp.send(
        'Page.getInstallabilityErrors',
      )) as {
        installabilityErrors: { errorId: string }[];
      };
      // `in-incognito` é do teste (todo contexto do Playwright é anônimo), não da página.
      expect(
        installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito'),
      ).toEqual([]);
    });

    it('com o worker ativo, a API segue para a rede normalmente (entrar continua funcionando)', async () => {
      await subir();
      await abrirComWorker();
      const status = await page.evaluate(async () => (await fetch('/v1/eu')).status);
      // Sem sessão: a API responde ela mesma (401), não a página "sem conexão" do worker.
      expect(status).toBe(401);
    });

    it('sem internet, mostra "sem conexão" e o "Tentar de novo" volta ao console com a rede', async () => {
      await subir();
      await abrirComWorker();
      await ctx.setOffline(true);
      await page.reload();
      await expect
        .poll(() => page.locator('h1').textContent())
        .toBe('Sem conexão com a internet');
      await ctx.setOffline(false);
      await page.getByRole('button', { name: 'Tentar de novo' }).click();
      await page.locator('#c-email').waitFor();
    });

    for (const escuro of [false, true]) {
      it(`a página "sem conexão" passa no axe (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        await subir(1280, escuro);
        await abrirComWorker();
        await ctx.setOffline(true);
        await page.reload();
        await page.getByRole('button', { name: 'Tentar de novo' }).waitFor();
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const r = await page.evaluate(() =>
          (window as unknown as AxeNaPagina).axe.run(document, {
            rules: { 'color-contrast': { enabled: true } },
          }),
        );
        expect(
          r.violations.map(
            (v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).join(' | ')}`,
          ),
        ).toEqual([]);
      });
    }

    for (const w of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`a página "sem conexão" não tem rolagem horizontal em ${w}px`, async () => {
        await subir(w);
        await abrirComWorker();
        await ctx.setOffline(true);
        await page.reload();
        const botao = page.getByRole('button', { name: 'Tentar de novo' });
        await botao.waitFor();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        ).toBe(false);
        // Teclado: o botão é o primeiro (e único) controle, com foco visível.
        await page.keyboard.press('Tab');
        expect(await botao.evaluate((b) => b === document.activeElement)).toBe(true);
      });
    }
  },
);
