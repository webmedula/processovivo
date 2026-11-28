/// <reference lib="dom" />
import AxeBuilder from 'axe-core';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';
import {
  grupo,
  infoProcesso,
  novidade,
  numeroValido,
  respostaNovidades,
  semNovidade,
} from '../helpers/atualizacoesSinteticas.js';

/*
 * v0.72.0 NUM NAVEGADOR: a atualização lida no Projudi ganha o selo "Projudi" na célula Atualização — na novidade e na
 * última movimentação do processo sem novidade —, sem tirar a célula de uma linha na tabela nem criar rolagem
 * horizontal. Dados SINTÉTICOS; /v1/novidades é simulada com o mesmo contrato da API.
 */
const sem = CHROMIUM === undefined;
const NP = numeroValido(9601); // novidade lida no Projudi
const ND = numeroValido(9602); // novidade do Diário
const NS = numeroValido(9603); // sem novidade, última movimentação do Projudi
interface AxeNaPagina {
  axe: {
    run(
      raiz: Element,
      o: object,
    ): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }>;
  };
}

describe.skipIf(sem)('selo "Projudi" nas Atualizações', { timeout: 120_000 }, () => {
  let browser: Browser;
  let amb: Ambiente;
  let ctx: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: CHROMIUM as string,
      args: ['--no-sandbox'],
    });
    amb = await iniciar();
  });
  afterAll(async () => {
    await browser?.close();
    await amb?.encerrar();
  });
  afterEach(async () => {
    await ctx?.close();
  });

  async function abrir(largura: number, escuro = false): Promise<void> {
    ctx = await browser.newContext({
      viewport: { width: largura, height: 900 },
      colorScheme: escuro ? 'dark' : 'light',
    });
    await ctx.addInitScript((c) => {
      try {
        localStorage.setItem('processovivo.chave', c);
      } catch {
        /* sem armazenamento: o teste falharia adiante, com a causa à vista */
      }
    }, CHAVE);
    await ctx.route('**/v1/novidades**', async (rota) => {
      if (new URL(rota.request().url()).searchParams.get('limite') === '1')
        return rota.fulfill({ json: respostaNovidades([]) });
      const info = (t: string) =>
        infoProcesso(
          t,
          'Procedimento Comum Cível',
          ['Parte Ativa Fictícia'],
          ['Parte Passiva Fictícia'],
        );
      const sS = semNovidade(NS, 'Juntada -> Petição', {
        diasAto: 2,
        processo: info('TJGO'),
      });
      return rota.fulfill({
        json: respostaNovidades(
          [
            grupo(
              NP,
              {
                ...novidade(NP, 'Despacho -> Mero Expediente', { diasDetectada: 1 }),
                doTribunal: true,
              },
              [],
              info('TJGO'),
            ),
            grupo(
              ND,
              {
                ...novidade(ND, 'Despacho', { diasDetectada: 1, vista: true }),
                doTribunal: false,
              },
              [],
              info('TJGO'),
            ),
          ],
          {
            acompanhados: 3,
            janelaDias: null,
            semNovidade: [
              {
                ...sS,
                ultimaMovimentacao: sS.ultimaMovimentacao
                  ? { ...sS.ultimaMovimentacao, doTribunal: true }
                  : null,
              },
            ],
          },
        ),
      });
    });
    await ctx.route('**/v1/facetas', async (rota) => {
      const real = (await (await rota.fetch()).json()) as Record<string, unknown>;
      await rota.fulfill({ json: { ...real, tribunais: ['TJGO'], classes: [] } });
    });
    page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e) => {
      throw e;
    });
    await page.goto(amb.url + '/');
    // A aba abre em "Pedem providência" e nenhum destes pede: vai a "Todas".
    await page.waitForSelector('[data-sit="todas"]');
    await page.locator('[data-sit="todas"]').first().click();
    await page.waitForFunction(
      () => document.querySelectorAll('.nvt-linha').length === 3,
    );
  }

  const linha = (n: string) => page.locator(`tr.nvt-linha[data-processo="${n}"]`);

  it('o selo aparece só no que veio do Projudi, com a explicação no title', async () => {
    await abrir(1366);
    await expect(linha(NP).locator('.nvt-pj').count()).resolves.toBe(1);
    await expect(linha(NS).locator('.nvt-pj').count()).resolves.toBe(1);
    await expect(linha(ND).locator('.nvt-pj').count()).resolves.toBe(0);
    const selo = linha(NP).locator('.nvt-pj');
    expect(await selo.textContent()).toBe('Projudi');
    const title = (await selo.getAttribute('title')) ?? '';
    expect(title).toContain('Projudi');
    expect(title.toLowerCase()).not.toContain('prazo');
  });

  for (const w of [1920, 1366, 1280, 1024]) {
    it(`${w}px: com o selo, a célula segue numa linha e não há rolagem horizontal`, async () => {
      await abrir(w);
      for (const n of [NP, NS]) {
        const h = await linha(n).evaluate((tr) => tr.getBoundingClientRect().height);
        expect(h).toBeLessThanOrEqual(56);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      ).toBe(false);
    });
  }

  for (const w of [768, 390]) {
    it(`${w}px (cartões): o selo aparece e não há rolagem horizontal`, async () => {
      await abrir(w);
      expect(await linha(NP).locator('.nvt-pj').isVisible()).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      ).toBe(false);
    });
  }

  for (const escuro of [false, true]) {
    it(`axe sem violações com o selo (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
      await abrir(1280, escuro);
      await page.addScriptTag({
        content: (AxeBuilder as unknown as { source: string }).source,
      });
      const r = await page.evaluate(() =>
        (window as unknown as AxeNaPagina).axe.run(
          { include: [['.nvt']] } as unknown as Element,
          { rules: { 'color-contrast': { enabled: true } } },
        ),
      );
      expect(
        r.violations.map(
          (v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).join(' | ')}`,
        ),
      ).toEqual([]);
    });
  }
});
