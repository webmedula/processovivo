/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROCESSO_TJGO } from '../helpers/leitor.js';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';

/*
 * Layout da Pasta digital (v0.35.3): a lista sobe e ocupa a altura da janela;
 * só ela e o visualizador rolam, cada um por dentro. Peças sintéticas.
 */
const sem = CHROMIUM === undefined;
interface Console_ {
  __pv?: { abrir(numero: string): void };
}
interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

const TELAS = [
  { w: 1920, h: 1080, desktop: true },
  { w: 1366, h: 768, desktop: true },
  { w: 1024, h: 768, desktop: true },
  { w: 768, h: 1024, desktop: false },
  { w: 390, h: 844, desktop: false },
] as const;

describe.skipIf(sem)(
  'Pasta digital — layout em altura total',
  { timeout: 60_000 },
  () => {
    let browser: Browser;
    let amb: Ambiente;
    let ctx: BrowserContext;
    let page: Page;

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
      await amb?.encerrar();
    });

    async function abrirPasta(
      w: number,
      h: number,
      escuro = false,
      extras = 40,
    ): Promise<void> {
      amb = await iniciar({ pecasExtras: extras });
      ctx = await browser.newContext({
        viewport: { width: w, height: h },
        colorScheme: escuro ? 'dark' : 'light',
      });
      await ctx.addInitScript((c) => {
        try {
          localStorage.setItem('processovivo.chave', c);
        } catch {
          /* sem armazenamento */
        }
      }, CHAVE);
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(amb.url + '/');
      await page.waitForFunction(
        () => typeof (window as unknown as Console_).__pv?.abrir === 'function',
      );
      await page.evaluate(
        (n) => (window as unknown as Console_).__pv!.abrir(n),
        PROCESSO_TJGO,
      );
      await page.waitForSelector('#pasta-abrir');
      await page.click('#pasta-abrir');
      await page.waitForSelector('#pasta .linha');
    }

    const medir = () =>
      page.evaluate(() => {
        const d = document.documentElement;
        const itens = document.getElementById('pasta-itens') as HTMLElement;
        const lista = document.getElementById('pasta-lista') as HTMLElement;
        const primeira = document.querySelector('#pasta .linha') as HTMLElement;
        const area = itens.getBoundingClientRect();
        const linhas = Array.from(document.querySelectorAll('#pasta .linha')).filter(
          (l) => {
            const r = l.getBoundingClientRect();
            return r.top >= area.top - 1 && r.bottom <= area.bottom + 1;
          },
        ).length;
        return {
          rolaH: d.scrollWidth > d.clientWidth,
          rolaPagina: d.scrollHeight > d.clientHeight,
          itensRolam: itens.scrollHeight > itens.clientHeight,
          listaRola: lista.scrollHeight > lista.clientHeight,
          primeiraTop: Math.round(primeira.getBoundingClientRect().top),
          areaDaLista: Math.round(area.height),
          linhasVisiveis: linhas,
          altura: window.innerHeight,
        };
      });

    for (const t of TELAS) {
      it(`${t.w}×${t.h}: sem rolagem horizontal, a página não rola e a lista rola por dentro`, async () => {
        await abrirPasta(t.w, t.h);
        const m = await medir();
        expect(m.rolaH).toBe(false);
        expect(m.rolaPagina).toBe(false);
        if (t.desktop) {
          expect(m.itensRolam).toBe(true);
          // A primeira linha começa no alto: 1366+ no terço superior (com folga de
          // ~4% pelos avisos obrigatórios); 1024 tem os avisos em mais linhas.
          expect(m.primeiraTop).toBeLessThanOrEqual(
            Math.round(m.altura * (t.w >= 1366 ? 0.38 : 0.48)),
          );
          // Cabem 6 linhas compactas (76 px) na área da lista (5 em 1024, onde o topo
          // quebra em duas linhas); as da massa de teste têm descrição de 2 linhas,
          // por isso o que se conta inteiro é menos.
          expect(m.areaDaLista).toBeGreaterThanOrEqual((t.w >= 1366 ? 6 : 5) * 76);
          expect(m.linhasVisiveis).toBeGreaterThanOrEqual(t.h >= 1000 ? 9 : 5);
        } else {
          // Celular/tablet em pé: filtros e lista rolam juntos, dentro da própria
          // coluna, e o gesto encadeia para fora (sem overscroll-behavior: contain).
          expect(m.listaRola).toBe(true);
          expect(
            await page.evaluate(
              () =>
                getComputedStyle(document.getElementById('pasta-lista')!)
                  .overscrollBehaviorY,
            ),
          ).not.toBe('contain');
        }
      });
    }

    it('os avisos obrigatórios continuam à vista (com número não exato, o da numeração também)', async () => {
      for (const t of TELAS) {
        await abrirPasta(t.w, t.h);
        const r = await page.evaluate(() => {
          const dentro = (id: string) => {
            const e = document.getElementById(id);
            if (!e) return null;
            const b = e.getBoundingClientRect();
            return b.height > 0 && b.bottom <= window.innerHeight;
          };
          return {
            proc: document.querySelector('#pasta-aviso .proc')?.textContent ?? '',
            procVisivel: dentro('pasta-aviso'),
            numVisivel: dentro('pasta-aviso-num'),
            num: document.getElementById('pasta-aviso-num')?.textContent ?? '',
            cal: dentro('pasta-cal'),
          };
        });
        expect(r.proc).toContain('não é consulta ao vivo');
        expect(r.procVisivel).toBe(true);
        expect(r.num).toContain('Numeração das movimentações calculada');
        expect(r.numVisivel).toBe(true);
        expect(r.cal).toBe(true);
        // A estimativa do "Montar" saiu da faixa fixa do topo.
        expect(await page.textContent('#pasta-aviso')).not.toContain(
          'Montar a pasta completa busca',
        );
        await ctx.close();
        await amb.encerrar();
      }
    });

    it('a dica do "Montar pasta completa" abre pelo foco do teclado, descreve o botão e fecha com Escape', async () => {
      await abrirPasta(1366, 768);
      const dica = page.locator('#pasta-dica-montar');
      expect(await dica.isVisible()).toBe(false);
      expect(await page.getAttribute('#pasta-montar', 'aria-describedby')).toBe(
        'pasta-dica-montar',
      );
      await page.focus('#pasta-montar');
      expect(await dica.isVisible()).toBe(true);
      expect(await dica.textContent()).toContain('Montar a pasta completa busca');
      await page.keyboard.press('Escape');
      expect(await dica.isVisible()).toBe(false);
      // Tirar o foco e voltar a abre de novo.
      await page.evaluate(() => (document.activeElement as HTMLElement).blur());
      await page.focus('#pasta-montar');
      expect(await dica.isVisible()).toBe(true);
    });

    it('marcar uma peça não faz a lista pular; o cabeçalho, os avisos e a busca ficam parados', async () => {
      await abrirPasta(1366, 768);
      const itens = page.locator('#pasta-itens');
      await itens.evaluate((e) => (e.scrollTop = 400));
      const fixos = () =>
        page.evaluate(() =>
          ['#pasta>.topo', '#pasta>.aviso', '#pasta-busca', '#pasta-contagem'].map((q) =>
            Math.round(document.querySelector(q)!.getBoundingClientRect().top),
          ),
        );
      const antes = await fixos();
      const alvo = page.locator('#pasta .linha').nth(9);
      const topoAntes = (await alvo.boundingBox())!.y;
      await alvo.locator('.cx').click();
      expect(await itens.evaluate((e) => e.scrollTop)).toBe(400);
      expect(Math.round((await alvo.boundingBox())!.y)).toBe(Math.round(topoAntes));
      expect(await fixos()).toEqual(antes);
      expect(await page.textContent('#pasta-contagem')).toContain('1');
    });

    it('a barra do visualizador fica fixa no topo enquanto o documento rola por baixo', async () => {
      await abrirPasta(1366, 768);
      await page.locator('#pf-p05').click();
      await page.waitForSelector('#pasta .pagina canvas');
      const topo = () =>
        page.evaluate(() =>
          Math.round(
            document.getElementById('pasta-ferramentas')!.getBoundingClientRect().top,
          ),
        );
      const antes = await topo();
      await page.evaluate(() => {
        const p = document.getElementById('pasta-paginas')!;
        p.scrollTop = p.scrollHeight;
      });
      expect(
        await page.evaluate(() => document.getElementById('pasta-paginas')!.scrollTop),
      ).toBeGreaterThan(0);
      expect(await topo()).toBe(antes);
      // A página inteira continua parada.
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollHeight <=
            document.documentElement.clientHeight,
        ),
      ).toBe(true);
      // As regiões rolantes têm nome e entram na ordem de tabulação.
      expect(await page.getAttribute('#pasta-lista', 'aria-label')).toBe(
        'Lista de peças',
      );
      expect(await page.getAttribute('#pasta-visor', 'aria-label')).toBe(
        'Visualizador da peça',
      );
      expect(await page.getAttribute('#pasta-paginas', 'tabindex')).toBe('0');
    });

    for (const escuro of [false, true]) {
      it(`acessibilidade (axe) com a lista cheia e a dica aberta, tema ${escuro ? 'escuro' : 'claro'}`, async () => {
        await abrirPasta(1366, 768, escuro);
        await page.focus('#pasta-montar');
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const r = await page.evaluate(async () => {
          const res = await (window as unknown as AxeNaPagina).axe.run(
            document.getElementById('pasta')!,
            {},
          );
          return res.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          );
        });
        expect(r).toEqual([]);
      });
    }
  },
);
