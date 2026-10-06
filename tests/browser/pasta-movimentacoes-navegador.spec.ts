/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROCESSO_TJGO } from '../helpers/leitor.js';
import { CHAVE, CHROMIUM, TEXTO_LONGO, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';

/*
 * A Pasta com TODAS as movimentações (v0.36.0), num Chromium de verdade. Dados
 * sintéticos: 12 peças em 7 atos, mais 3 atos SEM peça (o da posição 3, no meio
 * da linha do tempo, e os da 9 e da 10, no fim).
 */
const sem = CHROMIUM === undefined;
interface Console_ {
  __pv?: { abrir(numero: string): void };
}
interface AxeNaPagina {
  axe: {
    run(
      raiz: Element,
      o: object,
    ): Promise<{
      violations: Array<{
        id: string;
        nodes: Array<{ target: string[]; any: Array<{ message: string }> }>;
      }>;
    }>;
  };
}

describe.skipIf(sem)(
  'Pasta digital — todas as movimentações, no navegador',
  { timeout: 60_000 },
  () => {
    let browser: Browser;
    let amb: Ambiente;
    let ctx: BrowserContext;
    let page: Page;
    let pedidosDePeca: string[];

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

    async function abrir(
      opcoes: { w?: number; h?: number; escuro?: boolean; semAtos?: boolean } = {},
    ): Promise<void> {
      amb = await iniciar({ atosSemPeca: !opcoes.semAtos });
      ctx = await browser.newContext({
        viewport: { width: opcoes.w ?? 1360, height: opcoes.h ?? 860 },
        colorScheme: opcoes.escuro ? 'dark' : 'light',
      });
      await ctx.addInitScript((c) => {
        try {
          localStorage.setItem('processovivo.chave', c);
        } catch {
          /* sem armazenamento: o teste falharia adiante, com a causa à vista */
        }
      }, CHAVE);
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      pedidosDePeca = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/pasta\/pecas\//.test(r.url()))
          pedidosDePeca.push(r.url());
      });
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
    const linha = (id: string) => page.locator(`#pf-${id}`);
    const contagem = async (): Promise<string> =>
      (await page.textContent('#pasta-contagem')) ?? '';
    const ids = (): Promise<string[]> =>
      page.$$eval('#pasta .linha', (ls) =>
        ls.map((l) => l.getAttribute('data-id') as string),
      );
    const lotes = (): number => amb.provedor.lotes().length;

    async function calibrar(): Promise<void> {
      await page.click('#pasta-cal summary');
      await page.fill('#pasta-cal-ultimo', '11');
      await page.click('#pasta-cal-form-ultimo button[type=submit]');
      await page.waitForFunction(() =>
        /Calibrada por você/.test(
          document.getElementById('pasta-aviso-num')?.textContent ?? '',
        ),
      );
      for (const [id, n] of [
        ['p07', '6'],
        ['p08', '8'],
      ] as const) {
        await linha(id).focus();
        await page.keyboard.press('n');
        await page.fill('#pasta-cal-ato', n);
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => (document.getElementById('pasta-cal-editor') as HTMLElement).hidden,
        );
      }
    }

    it('a linha sem peça é igual às demais: número, rótulo, data, descrição e o selo "Sem peça" — sem caixa', async () => {
      await abrir();
      expect(await ids()).toHaveLength(15);
      const l = linha('ato-3');
      expect(await l.locator('.ord > [aria-hidden=true]').textContent()).toBe('3');
      expect(await l.locator('.rot').textContent()).toBe('Movimentação');
      expect(await l.locator('.data').textContent()).toMatch(/13\/09\/2026|12\/09\/2026/);
      expect(await l.locator('.mov-t').textContent()).toContain(
        'Intimação sintética de teste',
      );
      expect(await l.locator('.selo').textContent()).toBe('Sem peça');
      expect(await l.locator('.cx').count()).toBe(0);
      expect(await l.getAttribute('aria-selected')).toBeNull();
      expect(await l.locator('.mov-cal').count()).toBe(1);
      // As de peça continuam com caixa.
      expect(await linha('p01').locator('.cx').count()).toBe(1);
      // Leitor de tela: número, grau de certeza e "sem peça".
      expect(await l.locator('.pcal-sr').textContent()).toContain('sem peça');
    });

    it('as linhas seguem a ordem da lista, com o ato sem peça na posição cronológica', async () => {
      await abrir();
      const todos = await ids();
      const i = todos.indexOf('ato-3');
      // Entre a peça do ato 2 (p04) e a do ato 4, como a lista de peças já vinha.
      expect(todos[i - 1]).toBe('p04');
      expect(todos[i + 1]).toBe('p05');
      // Os dois do fim vêm depois da última peça ligada a um ato; todos os números presentes.
      expect(todos.slice(-2)).toEqual(['ato-9', 'ato-10']);
    });

    it('o contador diz quantas linhas, peças e movimentações sem peça — e o chip filtra, dizendo quantas escondeu', async () => {
      await abrir();
      const c = await contagem();
      expect(c).toContain('mostrando 15 de 15 linhas');
      expect(c).toContain('12 peças');
      expect(c).toContain('3 sem peça');
      expect(await page.textContent('#pasta-chip-sem')).toBe('Sem peça (3)');
      await page.click('#pasta-chip-sem');
      expect(await ids()).toEqual(['ato-3', 'ato-9', 'ato-10']);
      expect(await page.getAttribute('#pasta-chip-sem', 'aria-pressed')).toBe('true');
      expect(await contagem()).toContain('12 escondidas pelos filtros');
      await page.click('#pasta-chip-sem');
      expect(await ids()).toHaveLength(15);
    });

    it('"só disponíveis" esconde as linhas sem peça e diz quantas escondeu', async () => {
      await abrir();
      await page.check('#pasta-so-disp');
      expect(await ids()).toEqual([]);
      expect(await contagem()).toContain('15 escondidas pelos filtros');
    });

    it('a busca acha a movimentação sem peça pela descrição e pelo número, sem casar o rótulo "Movimentação"', async () => {
      await abrir();
      await page.fill('#pasta-busca', 'intimacao sintetica');
      expect(await ids()).toEqual(['ato-3']);
      await page.fill('#pasta-busca', 'concluso ao juiz');
      expect(await ids()).toEqual(['ato-10']);
      await page.fill('#pasta-busca', '9');
      expect(await ids()).toContain('ato-9');
      await page.fill('#pasta-busca', 'movimentacao');
      // "Movimentação" é só o rótulo das linhas sem peça: não casa com todas elas.
      expect((await ids()).includes('ato-3')).toBe(false);
    });

    it('clicar numa movimentação sem peça mostra o cabeçalho e a mensagem — sem nenhum pedido ao tribunal', async () => {
      await abrir();
      await linha('ato-3').click({ position: { x: 150, y: 8 } });
      expect(await page.textContent('#pasta-nome')).toBe('Mov. 3 · Movimentação');
      expect(await page.textContent('#pasta-mov')).toContain(
        'Intimação sintética de teste',
      );
      expect(await page.textContent('#pasta-estado')).toContain(
        'Esta movimentação não tem peça (documento) anexada.',
      );
      expect(await page.locator('#pasta-paginas canvas').count()).toBe(0);
      // Passa bem mais que o debounce do servidor (400 ms): nada saiu.
      await page.waitForTimeout(900);
      expect(pedidosDePeca).toEqual([]);
      expect(lotes()).toBe(0);
      // A calibração continua à mão no cabeçalho.
      await page.click('#pasta-mov-informar');
      expect(await page.locator('#pasta-cal-ato').isVisible()).toBe(true);
    });

    it('Todas, Baixar PDF e Montar pasta atuam só sobre peças', async () => {
      await abrir();
      expect(await page.textContent('#pasta-todas')).toBe('Todas (11)');
      await page.click('#pasta-todas');
      expect(await page.textContent('#pasta-baixar-pdf')).toBe('Baixar PDF (11)');
      expect(await page.locator('#pasta .linha[aria-selected=true]').count()).toBe(11);
      expect(await page.locator('#pf-ato-3[aria-selected]').count()).toBe(0);
      // O espaço: numa linha sem peça não marca nada.
      await page.click('#pasta-nenhuma');
      await linha('ato-3').focus();
      await page.keyboard.press('Space');
      expect(await page.textContent('#pasta-baixar-pdf')).toBe('Baixar PDF (0)');
      // O texto do "Montar" continua contando só peças (a de sigilo fica de fora).
      expect(await page.textContent('#pasta-dica-montar')).toContain('11 peças');
      expect(pedidosDePeca).toEqual([]);
      expect(lotes()).toBe(0);
    });

    it('teclado: as setas chegam à linha sem peça, Enter abre e o foco é visível', async () => {
      await abrir();
      await linha('p01').focus();
      // p01, p02, p03, p04 → ato-3
      for (let k = 0; k < 4; k++) await page.keyboard.press('ArrowDown');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pf-ato-3');
      await page.keyboard.press('Enter');
      expect(await page.textContent('#pasta-estado')).toContain('não tem peça');
      expect(await linha('ato-3').getAttribute('aria-current')).toBe('true');
    });

    it('lacuna provada: com o 7 ausente entre exatos, aparece o marcador — e só sem filtro', async () => {
      await abrir();
      expect(await page.locator('#pasta .lacuna').count()).toBe(0);
      await calibrar();
      const lac = page.locator('#pasta .lacuna');
      expect(await lac.count()).toBe(1);
      expect(await lac.textContent()).toBe(
        'nº 7 · ato não recebido do tribunal (provavelmente bloqueado)',
      );
      expect(await lac.getAttribute('aria-disabled')).toBe('true');
      expect(await lac.getAttribute('tabindex')).toBeNull();
      // Não conta como linha: continuam 15.
      expect(await contagem()).toContain('mostrando 15 de 15 linhas');
      // Os números exatos dos dois lados.
      expect(await linha('p07').locator('.ord > [aria-hidden=true]').textContent()).toBe(
        '6',
      );
      expect(await linha('p08').locator('.ord > [aria-hidden=true]').textContent()).toBe(
        '8',
      );
      // Com filtro some, e a contagem diz.
      await page.fill('#pasta-busca', 'concluso');
      expect(await page.locator('#pasta .lacuna').count()).toBe(0);
      expect(await contagem()).toContain('1 marcador de ato não recebido');
    });

    it('antes da calibração (faixa ou posição) não há marcador de lacuna', async () => {
      await abrir();
      await page.click('#pasta-cal summary');
      await page.fill('#pasta-cal-ultimo', '11');
      await page.click('#pasta-cal-form-ultimo button[type=submit]');
      await page.waitForFunction(() =>
        /Calibrada por você/.test(
          document.getElementById('pasta-aviso-num')?.textContent ?? '',
        ),
      );
      expect(await page.locator('#pasta .lacuna').count()).toBe(0);
    });

    it('listagem anterior à 0.36.0: aviso com o botão de atualizar, sem erro e sem lista vazia', async () => {
      amb = await iniciar();
      ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
      await ctx.addInitScript(
        (c) => localStorage.setItem('processovivo.chave', c),
        CHAVE,
      );
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      await page.route('**/pasta', async (rota) => {
        const r = await rota.fetch();
        const j = (await r.json()) as Record<string, unknown>;
        j['todasAsMovimentacoes'] = false;
        j['atosSemPeca'] = [];
        j['lacunas'] = [];
        j['linhas'] = [];
        await rota.fulfill({ response: r, json: j });
      });
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
      expect(await ids()).toHaveLength(12);
      expect(await page.textContent('#pasta-aviso-atos')).toContain(
        'Atualize as peças para carregar todas as movimentações',
      );
      expect(await page.locator('#pasta-atualizar-lista').count()).toBe(1);
      expect(await contagem()).not.toContain('sem peça');
    });

    it('1.000 linhas renderizam sem travar e a lista continua rolando por dentro', async () => {
      amb = await iniciar();
      ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
      await ctx.addInitScript(
        (c) => localStorage.setItem('processovivo.chave', c),
        CHAVE,
      );
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      await page.route('**/pasta', async (rota) => {
        const r = await rota.fetch();
        const j = (await r.json()) as Record<string, unknown> & {
          pecas: Array<{ pecaId: string }>;
        };
        const atos = Array.from({ length: 988 }, (_, k) => ({
          posicao: 100 + k,
          numero: { tipo: 'posicao', n: 100 + k },
          data: new Date(Date.UTC(2026, 0, 1) + k * 3_600_000).toISOString(),
          descricao: `Ato sintético ${100 + k}`,
          complemento: null,
          vinculoIncerto: false,
        }));
        j['todasAsMovimentacoes'] = true;
        j['atosSemPeca'] = atos;
        j['linhas'] = [
          ...atos.map((a) => ({ tipo: 'ato', posicao: a.posicao })),
          ...j.pecas.map((p) => ({ tipo: 'peca', pecaId: p.pecaId })),
        ];
        await rota.fulfill({ response: r, json: j });
      });
      await page.goto(amb.url + '/');
      await page.waitForFunction(
        () => typeof (window as unknown as Console_).__pv?.abrir === 'function',
      );
      await page.evaluate(
        (n) => (window as unknown as Console_).__pv!.abrir(n),
        PROCESSO_TJGO,
      );
      await page.waitForSelector('#pasta-abrir');
      const t0 = Date.now();
      await page.click('#pasta-abrir');
      await page.waitForFunction(
        () => document.querySelectorAll('#pasta .linha').length === 1000,
      );
      expect(Date.now() - t0).toBeLessThan(3000);
      // Digitar na busca refiltra as 1.000 linhas sem engasgar.
      const t1 = Date.now();
      await page.fill('#pasta-busca', 'Ato sintético 1050');
      await page.waitForFunction(
        () => document.querySelectorAll('#pasta .linha').length === 1,
      );
      expect(Date.now() - t1).toBeLessThan(2000);
      expect(
        await page.$eval('#pasta-itens', (el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
    });

    it('descrição longa de ato sem peça: até 2 linhas, texto inteiro no mouse e no foco', async () => {
      await abrir();
      const l = linha('ato-9');
      const alturas = await l.locator('.mov-t').evaluate((el) => ({
        h: el.getBoundingClientRect().height,
        lh: parseFloat(getComputedStyle(el).lineHeight) || 16,
      }));
      expect(alturas.h).toBeLessThanOrEqual(alturas.lh * 2 + 2);
      expect(await l.locator('.mov').getAttribute('title')).toContain(
        'FIM-DO-TEXTO-LONGO',
      );
      await linha('p12').focus();
      await page.keyboard.press('ArrowDown'); // por teclado: :focus-visible, cai no ato-9
      const aberto = await l
        .locator('.mov-t')
        .evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
      expect(aberto).toBe(true);
      await l.click({ position: { x: 150, y: 8 } });
      expect(await page.textContent('#pasta-mov')).toContain('FIM-DO-TEXTO-LONGO');
      expect(TEXTO_LONGO).toContain('FIM-DO-TEXTO-LONGO');
    });

    it('largura da lista: 440 px em 1366 e até 520 px em 1920; placeholder da busca inteiro', async () => {
      await abrir({ w: 1366, h: 768 });
      const larg = async (): Promise<number> =>
        Math.round((await page.locator('#pasta-lista').boundingBox())!.width);
      expect(await larg()).toBe(440);
      const corta = await page.$eval('#pasta-busca', (el) => {
        const i = el as HTMLInputElement;
        return i.scrollWidth > i.clientWidth;
      });
      expect(corta).toBe(false);
      expect(await page.getAttribute('#pasta-busca', 'placeholder')).toBe(
        'Buscar rótulo, movimentação ou nº',
      );
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.waitForTimeout(300);
      expect(await larg()).toBe(520);
    });

    for (const [w, h] of [
      [1280, 800],
      [1024, 768],
      [768, 1024],
      [390, 844],
    ] as const) {
      it(`sem rolagem horizontal em ${w} px, com linhas sem peça e marcador de lacuna`, async () => {
        await abrir({ w, h });
        if (w > 900) await calibrar();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        expect(
          await page.$eval('#pasta-itens', (el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        if (w > 900) {
          // O visualizador continua utilizável (largura mínima).
          const visor = (await page.locator('#pasta-visor').boundingBox())!;
          expect(visor.width).toBeGreaterThanOrEqual(320);
        }
      });
    }

    for (const escuro of [false, true]) {
      it(`acessibilidade (axe) com linhas sem peça e o marcador de lacuna, tema ${escuro ? 'escuro' : 'claro'}`, async () => {
        await abrir({ escuro });
        await calibrar();
        await linha('ato-3').click({ position: { x: 150, y: 8 } });
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const resultado = await page.evaluate(async () => {
          const r = await (window as unknown as AxeNaPagina).axe.run(
            document.getElementById('pasta')!,
            {
              rules: { 'color-contrast': { enabled: true } },
            },
          );
          return r.violations.map((v) => ({
            id: v.id,
            nos: v.nodes
              .map((n) => n.target.join(' ') + ' :: ' + (n.any[0]?.message ?? ''))
              .slice(0, 4),
          }));
        });
        expect(resultado).toEqual([]);
      });
    }
  },
);
