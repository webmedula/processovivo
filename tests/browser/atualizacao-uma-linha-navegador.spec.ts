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
 * v0.49.4 NUM NAVEGADOR: a coluna Atualização em UMA linha (ponto azul, tipo, etiqueta, "Não lida", aviso "Sem atualização
 * detectada"), sem o link "Abrir processo" na tabela (o número do processo e o ícone de Ações abrem o processo) e COM ele
 * nos cartões. Dados SINTÉTICOS; /v1/novidades é simulada com o mesmo contrato da API.
 */
const sem = CHROMIUM === undefined;
const NL = numeroValido(9501); // ato lido
const NU = numeroValido(9502); // não lida + etiqueta "Intimação"
const NS = numeroValido(9503); // sem atualização detectada
const NG = numeroValido(9504); // rótulo do ato muito longo
interface AxeNaPagina {
  axe: {
    run(
      raiz: Element,
      o: object,
    ): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }>;
  };
}

describe.skipIf(sem)(
  'Atualização em uma linha, sem "Abrir processo" na tabela',
  { timeout: 120_000 },
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
        const info = (t: string, prov?: Parameters<typeof infoProcesso>[5]) =>
          infoProcesso(
            t,
            'Procedimento Comum Cível',
            ['Parte Ativa Fictícia'],
            ['Parte Passiva Fictícia'],
            prov !== undefined,
            prov,
          );
        // Mesmo rótulo e mesma data do ato da providência: a linha não ganha a segunda linha "Último andamento".
        const nU = novidade(NU, 'Ato ordinatório', { diasDetectada: 1, diasAto: 3 });
        const sS = semNovidade(NS, 'Conclusos para decisão', {
          diasAto: 5,
          processo: info('TJMG'),
        });
        return rota.fulfill({
          json: respostaNovidades(
            [
              grupo(
                NL,
                novidade(NL, 'Despacho', { diasDetectada: 1, vista: true }),
                [],
                info('TJGO'),
              ),
              grupo(
                NU,
                nU,
                [],
                info('TJGO', {
                  situacao: 'pede',
                  motivo: {
                    rotulo: 'Ato ordinatório',
                    data: nU.data,
                    chave: 'chave-prov-9502',
                    tipo: 'intimacao',
                  },
                  cumpridoEm: null,
                }),
              ),
              grupo(
                NG,
                novidade(
                  NG,
                  'Decisão interlocutória sobre pedido de tutela de urgência em caráter antecedente e outras providências do juízo',
                  { diasDetectada: 1, vista: true },
                ),
                [],
                info('TJSP'),
              ),
            ],
            { acompanhados: 4, janelaDias: null, semNovidade: [sS] },
          ),
        });
      });
      await ctx.route('**/v1/facetas', async (rota) => {
        const real = (await (await rota.fetch()).json()) as Record<string, unknown>;
        await rota.fulfill({
          json: { ...real, tribunais: ['TJGO', 'TJMG', 'TJSP'], classes: [] },
        });
      });
      await ctx.route('**/v1/analises/disponibilidade', (rota) =>
        rota.fulfill({ json: { habilitada: true } }),
      );
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      await page.goto(amb.url + '/');
      await page.waitForSelector('.nvt-linha');
      const todos = page.locator('[data-sit="todas"]').first();
      if (await todos.count()) await todos.click();
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-linha').length === 4,
      );
    }

    const linha = (n: string) => page.locator(`tr.nvt-linha[data-processo="${n}"]`);
    const alturaDe = (n: string): Promise<number> =>
      linha(n).evaluate((tr) => tr.getBoundingClientRect().height);

    for (const w of [1920, 1366, 1280]) {
      it(`${w}px: lida, "Não lida" e "Sem atualização detectada" ocupam de 48 a 56 px, numa linha só`, async () => {
        await abrir(w);
        for (const n of [NL, NU, NS, NG]) {
          const h = await alturaDe(n);
          expect(h).toBeGreaterThanOrEqual(48);
          expect(h).toBeLessThanOrEqual(56);
          // Tudo o que a célula tem de visível está na MESMA faixa vertical (uma linha de texto).
          const topos = await linha(n).evaluate((tr) => {
            const c = tr.querySelector('.c-atu')!;
            const alvos = Array.from(
              c.querySelectorAll('.nvt-tipo, .selo, .nvt-sem'),
            ) as HTMLElement[];
            return alvos.map((e) => {
              const r = e.getBoundingClientRect();
              return r.top + r.height / 2;
            });
          });
          expect(Math.max(...topos) - Math.min(...topos)).toBeLessThanOrEqual(4);
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        ).toBe(false);
      });
    }

    it('1024px: segue tabela, sem rolagem horizontal e cada processo em uma linha de texto', async () => {
      await abrir(1024);
      expect(
        await page.evaluate(
          () => getComputedStyle(document.querySelector('.nvt-tabela')!).display,
        ),
      ).toBe('table');
      for (const n of [NL, NU, NS]) expect(await alturaDe(n)).toBeLessThanOrEqual(56);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      ).toBe(false);
    });

    it('a ordem dentro da célula é: ponto azul, tipo, etiqueta, "Não lida"; o ponto azul não é lido (é só desenho)', async () => {
      await abrir(1366);
      const c = linha(NU).locator('.c-atu');
      const m = await c.evaluate((el) => {
        const tit = el.querySelector('.nvt-tit') as HTMLElement;
        const ordem = Array.from(el.querySelectorAll('.nvt-tipo, .selo')).map((e) => ({
          classe: e.className,
          texto: e.textContent?.trim(),
          x: Math.round(e.getBoundingClientRect().left),
        }));
        return {
          negrito: getComputedStyle(tit).fontWeight,
          naoLida: tit.classList.contains('nl'),
          // O ponto azul é pseudo-elemento: sem nó no DOM, então nenhum leitor de tela o anuncia.
          ponto: getComputedStyle(tit, '::before').content,
          pontoNoDom: el.querySelectorAll('.ponto, [class*="ponto"]').length,
          ordem,
          textoDaCelula: (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
        };
      });
      expect(m.negrito).toBe('700');
      expect(m.naoLida).toBe(true);
      expect(m.ponto).toBe('""');
      expect(m.pontoNoDom).toBe(0);
      expect(m.ordem.map((o) => o.texto)).toEqual([
        'Ato ordinatório',
        'Intimação',
        'Não lida',
      ]);
      expect(m.ordem.map((o) => o.x)).toEqual(
        [...m.ordem.map((o) => o.x)].sort((a, b) => a - b),
      );
      // "Não lida" é lida UMA vez.
      expect(m.textoDaCelula.match(/Não lida/g)?.length).toBe(1);
    });

    it('"Sem atualização detectada" fica na mesma linha, em letra pequena e cor secundária, com o texto completo no title e no DOM', async () => {
      await abrir(1366);
      const sem = linha(NS).locator('.c-atu .nvt-sem');
      expect(((await sem.textContent()) ?? '').replace(/\s+/g, ' ')).toContain(
        'Sem atualização detectada',
      );
      expect(await sem.getAttribute('title')).toContain('Última movimentação conhecida');
      const e = await sem.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          px: parseFloat(cs.fontSize),
          pesoDoAviso: Number(cs.fontWeight),
          corta: cs.textOverflow === 'ellipsis' && cs.overflow === 'hidden',
          nowrap: cs.whiteSpace === 'nowrap',
        };
      });
      expect(e.px).toBeLessThanOrEqual(12.5);
      expect(e.pesoDoAviso).toBeLessThan(700);
      expect(e.corta).toBe(true);
      expect(e.nowrap).toBe(true);
    });

    it('rótulo de ato muito longo é cortado com reticências, sem quebrar a linha, e o title tem o texto inteiro', async () => {
      await abrir(1280);
      const m = await linha(NG)
        .locator('.c-atu .nvt-tipo')
        .evaluate((el) => ({
          cortado: el.scrollWidth > el.clientWidth,
          reticencias: getComputedStyle(el).textOverflow,
          titulo: el.closest('.nvt-tit')!.getAttribute('title'),
        }));
      expect(m.cortado).toBe(true);
      expect(m.reticencias).toBe('ellipsis');
      expect(m.titulo).toContain('outras providências do juízo');
      expect(await alturaDe(NG)).toBeLessThanOrEqual(56);
    });

    it('na tabela não há link "Abrir processo" à vista nem na ordem do Tab; o número do processo segue sendo o link que abre o processo', async () => {
      await abrir(1366);
      for (const n of [NL, NU, NS]) {
        const l = linha(n);
        expect(await l.locator('.nov-abrir').isVisible()).toBe(false);
        expect(await l.locator('.c-atu').innerText()).not.toContain('Abrir processo');
        const num = l.locator('.nvt-num');
        expect(await num.evaluate((a) => a.tagName)).toBe('A');
        // Reescrito na 0.57.0: o link do número passou de `/?processo=<número>` ao endereço opaco da navegação por hash;
        // o número do processo nunca vai à URL. Continua sendo "o link que abre o processo".
        const href = (await num.getAttribute('href')) ?? '';
        expect(href).toMatch(/^#\/processo\/[a-z0-9]{6,20}$/);
        expect(href).not.toContain(n.replace(/\D/g, ''));
        // O botão de copiar é outro controle, ao lado.
        expect(
          await l.getByRole('button', { name: /^Copiar o número do processo / }).count(),
        ).toBe(1);
      }
      // Nome acessível do número hoje: só o número formatado (o papel "link" diz que é um link).
      const link = linha(NL).getByRole('link');
      expect(await link.count()).toBe(1);
      expect(((await link.textContent()) ?? '').trim()).toMatch(
        /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/,
      );
    });

    it('o número abre o processo com o mouse e com o Enter', async () => {
      await abrir(1366);
      const num = linha(NL).locator('.nvt-num');
      await num.click();
      await page.waitForSelector('#voltar');
      expect(await page.locator('.nvt-tabela').count()).toBe(0); // saiu da tabela para a tela do processo
      await page.click('#voltar');
      await page.waitForSelector('.nvt-linha');
      await linha(NL).locator('.nvt-num').focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('#voltar');
      expect(await page.locator('.nvt-tabela').count()).toBe(0); // saiu da tabela para a tela do processo
    });

    it('ordem do Tab na linha: número, copiar, caixa "Cumprido", abrir, pasta, IA', async () => {
      await abrir(1366);
      await linha(NU).locator('.nvt-num').focus();
      const ordem: string[] = [];
      for (let i = 0; i < 6; i++) {
        ordem.push(
          await page.evaluate(() => {
            const a = document.activeElement as HTMLElement;
            return a.getAttribute('data-cx') ?? a.getAttribute('data-acao') ?? '';
          }),
        );
        await page.keyboard.press('Tab');
      }
      // O número é <a data-acao="abrir">; o ícone de Ações também é "abrir" (pelo botão).
      expect(ordem).toEqual(['abrir', 'copiar', 'cumprido', 'abrir', 'pasta', 'ia']);
      const tags: string[] = [];
      await linha(NU).locator('.nvt-num').focus();
      for (let i = 0; i < 4; i++) {
        tags.push(
          await page.evaluate(() => (document.activeElement as HTMLElement).tagName),
        );
        await page.keyboard.press('Tab');
      }
      expect(tags).toEqual(['A', 'BUTTON', 'INPUT', 'BUTTON']);
    });

    it('a dica do botão de copiar aparece com mouse e foco (a do número não existe na 0.49.3 e não foi criada)', async () => {
      await abrir(1366);
      const b = linha(NL).getByRole('button', { name: /^Copiar o número do processo / });
      const v = () =>
        b.evaluate(
          (el) =>
            getComputedStyle(
              document.getElementById(el.getAttribute('aria-describedby')!)!,
            ).visibility,
        );
      expect(await v()).toBe('hidden');
      await b.hover();
      expect(await v()).toBe('visible');
      expect(
        await linha(NL)
          .locator('.nvt-num')
          .evaluate((a) => a.hasAttribute('aria-describedby')),
      ).toBe(false);
    });

    it('o painel de IA ainda abre pelo ícone da fileira', async () => {
      await abrir(1366);
      await ctx.route('**/v1/acompanhamentos/*/analise', (rota) =>
        rota.fulfill({
          status: 403,
          json: { erro: 'X', mensagem: 'x', detalhes: { motivo: 'sem_plano' } },
        }),
      );
      await linha(NL).getByRole('button', { name: 'Analisar com IA' }).click();
      await page.waitForSelector('#pvia-' + NL.replace(/\D/g, ''));
    });

    for (const w of [768, 390]) {
      it(`${w}px: cartões; "Abrir processo" visível e funcionando, número clicável, selos podem usar mais de uma linha e não há rolagem horizontal`, async () => {
        await abrir(w);
        for (const n of [NL, NU, NS]) {
          const l = linha(n);
          expect(await l.evaluate((tr) => getComputedStyle(tr).display)).toBe('grid');
          const botao = l.locator('.c-atu .nov-abrir');
          expect(await botao.isVisible()).toBe(true);
          expect(((await botao.innerText()) ?? '').trim()).toBe('Abrir processo');
          expect((await botao.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          expect(await l.locator('.nvt-num').isVisible()).toBe(true);
        }
        await linha(NU).locator('.c-atu .nov-abrir').click();
        await page.waitForSelector('#voltar');
        expect(await page.locator('.nvt-tabela').count()).toBe(0); // saiu da tabela para a tela do processo
        await page.click('#voltar');
        await page.waitForSelector('.nvt-linha');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        ).toBe(false);
      });
    }

    for (const w of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${w}px`, async () => {
        await abrir(w);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        ).toBe(false);
      });
    }

    for (const escuro of [false, true]) {
      it(`axe sem violações na tabela com a célula em uma linha (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
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
  },
);
