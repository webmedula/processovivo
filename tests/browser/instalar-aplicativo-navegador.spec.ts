/// <reference lib="dom" />
import AxeBuilder from 'axe-core';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROCESSO_TJGO } from '../helpers/leitor.js';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';
import { esperarConsolePronto } from './console.js';

/*
 * v0.70.1 NUM NAVEGADOR: "Instalar aplicativo" no pé do menu lateral e, no celular, um aviso discreto que some ao
 * fechar. O aviso do navegador (`beforeinstallprompt`) é simulado: é o mesmo evento que o Chrome dispara, com
 * `prompt()` dublado, porque o de verdade abre uma janela do sistema que o teste não alcança. O iPhone é simulado
 * pelo `userAgent` (o Chromium é o único navegador do ambiente): o que se prova é a NOSSA decisão, não o Safari.
 */
const sem = CHROMIUM === undefined;
const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

interface Janela {
  __promptChamado?: number;
  __pv?: { abrir(numero: string): void };
  axe: {
    run(
      raiz: Element,
      o: object,
    ): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }>;
  };
}

describe.skipIf(sem)('Instalar aplicativo, no navegador', { timeout: 90_000 }, () => {
  let browser: Browser;
  let amb: Ambiente;
  let ctx: BrowserContext;
  let page: Page;
  let erros: string[];

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
    expect(erros).toEqual([]);
    await ctx?.close();
    await amb?.encerrar();
  });

  async function abrir(
    w: number,
    o: {
      iphone?: boolean;
      escuro?: boolean;
      instalado?: boolean;
      semChave?: boolean;
    } = {},
  ): Promise<void> {
    amb = await iniciar({ pecasExtras: 2 });
    ctx = await browser.newContext({
      viewport: { width: w, height: w <= 900 ? 800 : 900 },
      colorScheme: o.escuro ? 'dark' : 'light',
      ...(o.iphone ? { userAgent: UA_IPHONE, hasTouch: true, isMobile: true } : {}),
    });
    await ctx.addInitScript(
      ([c, instalado]) => {
        if (c) {
          try {
            localStorage.setItem('processovivo.chave', c as string);
          } catch {
            /* sem armazenamento */
          }
        }
        if (instalado) {
          const original = window.matchMedia.bind(window);
          window.matchMedia = (q: string) =>
            q.includes('display-mode: standalone')
              ? ({
                  matches: true,
                  media: q,
                  addEventListener() {},
                  removeEventListener() {},
                } as unknown as MediaQueryList)
              : original(q);
        }
      },
      [o.semChave ? '' : CHAVE, o.instalado === true] as const,
    );
    page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    erros = [];
    page.on('pageerror', (e) => erros.push(String(e)));
    await page.goto(amb.url + '/');
    if (o.semChave) await page.locator('#c-email').waitFor();
    else await esperarConsolePronto(page);
  }

  /** O mesmo evento que o Chrome dispara quando a página pode ser instalada, com `prompt()` dublado. */
  async function navegadorOfereceInstalar(): Promise<void> {
    await page.evaluate(() => {
      const ev = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
        prompt(): void;
        userChoice: Promise<{ outcome: string }>;
      };
      ev.prompt = () => {
        const j = window as unknown as Janela;
        j.__promptChamado = (j.__promptChamado ?? 0) + 1;
      };
      ev.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(ev);
    });
  }

  const visivel = (q: string): Promise<boolean> =>
    page.evaluate((s) => {
      const e = document.querySelector(s);
      return (
        !!e &&
        e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility === 'visible'
      );
    }, q);

  async function axe(seletor: string): Promise<string[]> {
    await page.addScriptTag({
      content: (AxeBuilder as unknown as { source: string }).source,
    });
    return page.evaluate(async (s) => {
      const raiz = document.querySelector(s) as Element;
      const r = await (window as unknown as Janela).axe.run(raiz, {
        rules: { 'color-contrast': { enabled: true } },
      });
      return r.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
      );
    }, seletor);
  }

  it('no computador, o item aparece no pé do menu quando o navegador oferece, e abre a janela dele', async () => {
    await abrir(1920);
    await navegadorOfereceInstalar();
    const item = page.locator('#instalar-app');
    await item.waitFor({ state: 'visible' });
    expect((await item.textContent())?.trim()).toBe('Instalar aplicativo');
    // No computador o aviso de baixo não aparece: o item do menu já está à vista.
    expect(await visivel('#instalar-aviso')).toBe(false);
    // Mesmo desenho do "Tema", logo acima dele.
    const [a, t] = await Promise.all([
      item.boundingBox(),
      page.locator('#tema').boundingBox(),
    ]);
    expect(a!.y).toBeLessThan(t!.y);
    expect(a!.height).toBe(t!.height);
    await item.click();
    expect(await page.evaluate(() => (window as unknown as Janela).__promptChamado)).toBe(
      1,
    );
    // A janela do navegador só abre uma vez por aviso: o item some até o navegador oferecer de novo.
    await item.waitFor({ state: 'hidden' });
    expect(await axe('#lateral')).toEqual([]);
  });

  it('com o menu só de ícones, o item tem nome acessível e a dica diz "Instalar aplicativo"', async () => {
    await abrir(1024);
    await navegadorOfereceInstalar();
    const item = page.getByRole('button', { name: 'Instalar aplicativo' });
    await item.waitFor({ state: 'visible' });
    expect((await item.boundingBox())!.width).toBeLessThanOrEqual(44);
    await item.hover();
    await expect
      .poll(() => page.locator('#menu-dica').textContent())
      .toBe('Instalar aplicativo');
  });

  it('sem o navegador oferecer, sem sessão, ou já instalado, nada aparece', async () => {
    await abrir(1920);
    expect(await visivel('#instalar-app')).toBe(false);
    await ctx.close();
    await amb.encerrar();

    await abrir(390, { semChave: true });
    await navegadorOfereceInstalar();
    expect(await visivel('#instalar-app')).toBe(false);
    expect(await visivel('#instalar-aviso')).toBe(false);
    await ctx.close();
    await amb.encerrar();

    await abrir(390, { instalado: true, iphone: true });
    await navegadorOfereceInstalar();
    expect(await visivel('#instalar-aviso')).toBe(false);
    expect(
      await page.evaluate(
        () => getComputedStyle(document.getElementById('instalar-app')!).display,
      ),
    ).toBe('none');
  });

  it('no Android, o aviso de baixo instala, e "Agora não" o tira de vez (também depois de recarregar)', async () => {
    await abrir(390);
    await navegadorOfereceInstalar();
    const aviso = page.locator('#instalar-aviso');
    await aviso.waitFor({ state: 'visible' });
    await expect
      .poll(() => page.locator('#instalar-aviso-sim').textContent())
      .toBe('Instalar');
    // Não toma o foco de ninguém.
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(
      true,
    );
    expect(await axe('#instalar-aviso')).toEqual([]);
    // O conteúdo não fica escondido atrás do aviso: a página ganha espaço embaixo.
    expect(
      await page.evaluate(() =>
        parseFloat(getComputedStyle(document.getElementById('conteudo')!).paddingBottom),
      ),
    ).toBeGreaterThanOrEqual((await aviso.boundingBox())!.height + 12);
    await page.getByRole('button', { name: 'Agora não' }).click();
    await aviso.waitFor({ state: 'hidden' });
    // O item do menu continua, dentro da gaveta.
    await page.click('#menu-abrir');
    await page.locator('#instalar-app').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.reload();
    await esperarConsolePronto(page);
    await navegadorOfereceInstalar();
    await page.locator('#instalar-app').waitFor({ state: 'attached' });
    expect(await visivel('#instalar-aviso')).toBe(false);
  });

  it('no Android, "Instalar" no aviso abre a janela do navegador e o aviso some', async () => {
    await abrir(390);
    await navegadorOfereceInstalar();
    await page.locator('#instalar-aviso-sim').click();
    expect(await page.evaluate(() => (window as unknown as Janela).__promptChamado)).toBe(
      1,
    );
    await page.locator('#instalar-aviso').waitFor({ state: 'hidden' });
  });

  for (const escuro of [false, true]) {
    it(`no iPhone, "Como instalar" mostra o passo a passo, Esc fecha e o foco volta (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
      await abrir(390, { iphone: true, escuro });
      const sim = page.locator('#instalar-aviso-sim');
      await sim.waitFor({ state: 'visible' });
      expect(await sim.textContent()).toBe('Como instalar');
      expect(await axe('#instalar-aviso')).toEqual([]);
      await sim.focus();
      await page.keyboard.press('Enter');
      const janela = page.getByRole('dialog', { name: 'Instalar no iPhone' });
      await janela.waitFor({ state: 'visible' });
      expect(await janela.textContent()).toContain('Adicionar à Tela de Início');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        'instalar-ios-ok',
      );
      expect(await axe('#instalar-ios')).toEqual([]);
      await page.keyboard.press('Escape');
      await janela.waitFor({ state: 'hidden' });
      // Tocar em "Como instalar" conta como resposta: o aviso não volta, o item do menu sim.
      expect(await visivel('#instalar-aviso')).toBe(false);
    });
  }

  it('no iPhone, o item da gaveta fecha a gaveta e abre o passo a passo', async () => {
    await abrir(390, { iphone: true });
    await page.getByRole('button', { name: 'Agora não' }).click();
    await page.click('#menu-abrir');
    await page.locator('#instalar-app').click();
    await page
      .getByRole('dialog', { name: 'Instalar no iPhone' })
      .waitFor({ state: 'visible' });
    expect(
      await page.evaluate(() =>
        document.documentElement.classList.contains('menu-aberto'),
      ),
    ).toBe(false);
    await page.getByRole('button', { name: 'Entendi' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  });

  it('com a Pasta digital aberta o aviso sai da frente, e volta ao fechar', async () => {
    await abrir(390, { iphone: true });
    await page.locator('#instalar-aviso').waitFor({ state: 'visible' });
    await page.evaluate(
      (n) => (window as unknown as Janela).__pv!.abrir(n),
      PROCESSO_TJGO,
    );
    await page.waitForSelector('#pasta-abrir');
    await page.click('#pasta-abrir');
    await page.waitForSelector('#pasta .linha');
    expect(await visivel('#instalar-aviso')).toBe(false);
    await page.click('#pasta-fechar');
    await page.locator('#instalar-aviso').waitFor({ state: 'visible' });
  });

  for (const w of [1920, 1366, 1280, 1024, 768, 390]) {
    it(`sem rolagem horizontal em ${w}px, com o item e o aviso na tela`, async () => {
      await abrir(w, { iphone: w <= 900 });
      await navegadorOfereceInstalar();
      await page
        .locator(w <= 900 ? '#instalar-aviso' : '#instalar-app')
        .waitFor({ state: 'visible' });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      ).toBe(false);
      if (w <= 900) {
        const caixa = (await page.locator('#instalar-aviso').boundingBox())!;
        expect(caixa.x).toBeGreaterThanOrEqual(0);
        expect(caixa.x + caixa.width).toBeLessThanOrEqual(w);
      }
    });
  }
});
