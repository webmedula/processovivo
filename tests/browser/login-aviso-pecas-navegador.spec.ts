/// <reference lib="dom" />
import AxeBuilder from 'axe-core';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHROMIUM } from './ambiente.js';
import { SENHA, montarCenarioDePagamento } from '../helpers/pagamentos.js';
import type { CenarioDePagamento } from '../helpers/pagamentos.js';

/*
 * v0.50.1 NUM NAVEGADOR: o painel da esquerda do login/cadastro avisa que as peças só valem para o TJGO por
 * enquanto. Servidor e console reais; contas sintéticas. Só texto e layout: login e cadastro seguem os mesmos.
 */
const sem = CHROMIUM === undefined;
const AVISO =
  'Por enquanto, o acesso às peças vale apenas para o Tribunal de Justiça de Goiás (TJGO). ' +
  'Em breve, será estendido a todos os tribunais do Brasil.';
const EMAIL = 'ana@exemplo.test';
interface AxeNaPagina {
  axe: {
    run(
      raiz: Element,
      o: object,
    ): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }>;
  };
}

describe.skipIf(sem)(
  'Aviso das peças no painel de entrada, no navegador',
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
      page.on('pageerror', (e) => {
        throw e;
      });
    }

    const aviso = () => page.locator('.entrada-marca .beneficio-aviso');
    const sobreRodagem = () =>
      page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

    it('aparece abaixo do benefício de peças, com o texto exato, em "Entrar" e em "Criar conta"', async () => {
      await subir();
      await page.goto(url);
      await page.locator('#c-email').waitFor();
      for (const aba of ['Entrar', 'Criar conta']) {
        await page.getByRole('tab', { name: aba }).click();
        expect(await aviso().count()).toBe(1);
        expect((await aviso().textContent())?.trim()).toBe(AVISO);
        // É texto simples: sem link, sem botão, sem tooltip, e sem check próprio.
        expect(
          await page
            .locator('.entrada-marca .beneficio-aviso a, .beneficio-aviso [title]')
            .count(),
        ).toBe(0);
        const beneficios = page.locator('.entrada-marca .beneficio');
        expect(await beneficios.count()).toBe(3);
        expect(await page.locator('.entrada-marca .beneficio-aviso .ck').count()).toBe(0);
        // Pertence ao terceiro benefício (e só a ele), depois do texto dele.
        expect(await beneficios.nth(2).locator('.beneficio-aviso').count()).toBe(1);
        expect(await beneficios.nth(0).locator('.beneficio-aviso').count()).toBe(0);
        expect(await beneficios.nth(1).locator('.beneficio-aviso').count()).toBe(0);
        const g = await page.evaluate(() => {
          const b = document.querySelectorAll(
            '.entrada-marca .beneficio',
          )[2] as HTMLElement;
          const forte = b.querySelector('b') as HTMLElement;
          const av = b.querySelector('.beneficio-aviso') as HTMLElement;
          const ck = b.querySelector('.ck') as HTMLElement;
          return {
            abaixo:
              av.getBoundingClientRect().top >= forte.getBoundingClientRect().bottom - 1,
            alinhadoAoTexto:
              Math.abs(
                av.getBoundingClientRect().left - forte.getBoundingClientRect().left,
              ) < 1,
            naoNoIcone:
              av.getBoundingClientRect().left >= ck.getBoundingClientRect().right,
            menor:
              parseFloat(getComputedStyle(av).fontSize) <
              parseFloat(getComputedStyle(b).fontSize),
          };
        });
        expect(g).toEqual({
          abaixo: true,
          alinhadoAoTexto: true,
          naoNoIcone: true,
          menor: true,
        });
      }
    });

    it('os outros dois benefícios, o título e o quadro de silêncio continuam como eram', async () => {
      await subir();
      await page.goto(url);
      await page.locator('#c-email').waitFor();
      const m = page.locator('.entrada-marca');
      expect((await m.locator('h1').textContent())?.trim()).toBe(
        'Seus processos vigiados.Você, avisado.',
      );
      expect((await m.locator('.beneficio').nth(0).textContent())?.trim()).toBe(
        'Publicações no seu nome, encontradas pela sua OAB no Diário de Justiça',
      );
      expect((await m.locator('.beneficio').nth(1).textContent())?.trim()).toBe(
        'Andamentos de cada processo, sem abrir o site do tribunal',
      );
      expect((await m.locator('.beneficio b').nth(2).textContent())?.trim()).toBe(
        'Peças das partes',
      );
      expect(await m.locator('.promessa').textContent()).toContain(
        'Se não conseguirmos verificar, você também fica sabendo.',
      );
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações no painel da esquerda, nas duas abas (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        await subir(1280, escuro);
        await page.goto(url);
        await page.locator('#c-email').waitFor();
        for (const aba of ['Entrar', 'Criar conta']) {
          await page.getByRole('tab', { name: aba }).click();
          await page.addScriptTag({
            content: (AxeBuilder as unknown as { source: string }).source,
          });
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(
              { include: [['.entrada-marca']] } as unknown as Element,
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
      it(`sem rolagem horizontal em ${w}px, nas duas abas`, async () => {
        await subir(w);
        await page.goto(url);
        await page.locator('#c-email').waitFor();
        for (const aba of ['Entrar', 'Criar conta']) {
          await page.getByRole('tab', { name: aba }).click();
          expect(await sobreRodagem()).toBe(false);
          // Até 900 px a lista de benefícios inteira é escondida (regra de antes): o aviso some junto com a
          // afirmação a que se refere, e o formulário segue logo abaixo da marca.
          if (w <= 900) expect(await aviso().isVisible()).toBe(false);
          else {
            expect(await aviso().isVisible()).toBe(true);
            const dentro = await aviso().evaluate((el) => {
              const r = el.getBoundingClientRect();
              const marca = (
                el.closest('.entrada-marca') as HTMLElement
              ).getBoundingClientRect();
              return r.left >= marca.left && r.right <= marca.right;
            });
            expect(dentro).toBe(true);
          }
        }
      });
    }

    it('em 390 px o formulário continua começando perto do topo (o aviso não o empurra)', async () => {
      await subir(390);
      await page.goto(url);
      await page.locator('#c-email').waitFor();
      const topo = await page
        .locator('.entrada-form')
        .evaluate((el) => el.getBoundingClientRect().top);
      expect(topo).toBeLessThan(330);
    });

    it('entrar e criar conta seguem funcionando', async () => {
      await subir();
      await page.goto(url);
      await page.getByRole('tab', { name: 'Criar conta' }).click();
      await page.fill('#c-nome', 'Pessoa Sintética');
      await page.fill('#c-email', EMAIL);
      await page.fill('#c-senha', SENHA);
      await page.click('#c-enviar');
      await page.locator('#lateral:not(.oculto)').waitFor();
      expect(await page.evaluate(() => document.body.classList.contains('fora'))).toBe(
        false,
      );
      await page.request.post(`${url}/v1/sessoes/encerrar`).catch(() => undefined);
      await page.context().clearCookies();
      await page.goto(url);
      await page.fill('#c-email', EMAIL);
      await page.fill('#c-senha', SENHA);
      await page.click('#c-enviar');
      await page.locator('#lateral:not(.oculto)').waitFor();
    });
  },
);
