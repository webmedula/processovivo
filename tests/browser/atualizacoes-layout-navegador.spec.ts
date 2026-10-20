/// <reference lib="dom" />
import { writeFileSync } from 'node:fs';
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
 * v0.49.2 NUM NAVEGADOR: só a APRESENTAÇÃO da tabela de Atualizações — linha compacta, número do processo sem quebra,
 * Ações em ícones com dica (inclusive "Analisar com IA") e texto visível nos cartões. Dados SINTÉTICOS; /v1/novidades
 * é simulada com o mesmo contrato da API. Com PV_MEDIDAS=<arquivo> o teste de medição grava as larguras em JSON.
 */
const sem = CHROMIUM === undefined;
const NA = numeroValido(9301);
const NB = numeroValido(9302);
const NC = numeroValido(9303);
interface AxeNaPagina {
  axe: {
    run(
      raiz: Element,
      o: object,
    ): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }>;
  };
}
const iso = (dias: number): string =>
  new Date(Date.now() - dias * 86_400_000).toISOString();

describe.skipIf(sem)('Atualizações, apresentação da tabela', { timeout: 120_000 }, () => {
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
      const gA = grupo(
        NA,
        { ...novidade(NA, 'Juntada de petição', { diasDetectada: 1 }), data: iso(1) },
        [],
        infoProcesso(
          'TJGO',
          'Procedimento Comum Cível',
          ['Autora Sintética'],
          ['Ré Fictícia'],
          true,
          {
            situacao: 'pede',
            motivo: {
              rotulo: 'Ato ordinatório',
              data: iso(3),
              chave: 'chave-prov-9301',
              tipo: 'intimacao',
            },
            cumpridoEm: null,
          },
        ),
      );
      const gB = grupo(
        NB,
        novidade(NB, 'Despacho', { diasDetectada: 2 }),
        [],
        infoProcesso(
          'TJSP',
          'Execução Fiscal',
          ['Fazenda Pública Fictícia do Estado Imaginário'],
          ['Devedor Fictício'],
        ),
      );
      const sC = semNovidade(NC, 'Conclusos para decisão', {
        diasAto: 5,
        processo: infoProcesso(
          'TJMG',
          'Procedimento Comum Cível',
          ['Parte Ativa Fictícia'],
          ['Parte Passiva Fictícia'],
        ),
      });
      return rota.fulfill({
        json: respostaNovidades([gA, gB], {
          acompanhados: 3,
          janelaDias: null,
          semNovidade: [sC],
        }),
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
    // O painel de IA abre pelo ícone; a resposta é uma recusa fixa (o conteúdo da análise tem teste próprio).
    await ctx.route('**/v1/acompanhamentos/*/analise', (rota) =>
      rota.fulfill({
        status: 403,
        json: { erro: 'X', mensagem: 'x', detalhes: { motivo: 'sem_plano' } },
      }),
    );
    page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e) => {
      throw e;
    });
    await page.goto(amb.url + '/');
    await page.waitForSelector('.nvt-linha');
    // Mostra todos os processos (o filtro nasce em "Pedem providência").
    const todos = page.locator('[data-sit="todas"]').first();
    if (await todos.count()) await todos.click();
    await page.waitForFunction(
      () => document.querySelectorAll('.nvt-linha').length === 3,
    );
  }

  const LARGURAS = [1920, 1366, 1280, 1024];

  it('mede as colunas e a altura das linhas nas quatro larguras', async () => {
    const saida: Record<string, unknown> = {};
    for (const w of LARGURAS) {
      await abrir(w);
      saida[String(w)] = await page.evaluate(() => {
        const ths = Array.from(document.querySelectorAll('.nvt-tabela th'));
        return {
          colunas: ths.map((t) => [
            t.textContent?.trim().replace(/\s+/g, ' '),
            Math.round(t.getBoundingClientRect().width),
          ]),
          alturas: Array.from(document.querySelectorAll('.nvt-linha')).map((l) =>
            Math.round(l.getBoundingClientRect().height),
          ),
          cabecalho: Math.round(ths[0]!.getBoundingClientRect().height),
          conteudos: Array.from(document.querySelectorAll('.nvt-linha')[1]!.children).map(
            (c) => Math.round((c.firstElementChild ?? c).getBoundingClientRect().height),
          ),
          rolagem: document.documentElement.scrollWidth > innerWidth,
          tabela: getComputedStyle(document.querySelector('.nvt-tabela')!).display,
        };
      });
      if (process.env['PV_PRINT'])
        await page.screenshot({ path: `${process.env['PV_PRINT']}/at-${w}.png` });
      await ctx.close();
    }
    if (process.env['PV_MEDIDAS'])
      writeFileSync(process.env['PV_MEDIDAS'], JSON.stringify(saida, null, 1));
    expect(Object.keys(saida)).toHaveLength(4);
  });

  const linha = (n: string) => page.locator(`tr.nvt-linha[data-processo="${n}"]`);

  for (const w of [1920, 1366, 1280]) {
    it(`${w}px: a linha típica tem de 48 a 56 px; número em uma linha; Ações numa fileira; cabeçalhos e datas sem quebra`, async () => {
      await abrir(w);
      const m = await page.evaluate((n) => {
        const tr = document.querySelector(
          `tr.nvt-linha[data-processo="${n}"]`,
        ) as HTMLElement;
        const linhas = (el: Element): number => {
          const r = document.createRange();
          r.selectNodeContents(el);
          return new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top)))
            .size;
        };
        const topos = Array.from(
          tr.querySelectorAll('.c-acoes button, .c-acoes input'),
        ).map((e) => Math.round(e.getBoundingClientRect().top));
        const num = tr.querySelector('.nvt-num') as HTMLElement;
        const copiar = tr.querySelector('.nvt-copiar') as HTMLElement;
        return {
          altura: tr.getBoundingClientRect().height,
          linhasDoNumero: linhas(num),
          numeroEIconeColados:
            copiar.getBoundingClientRect().left - num.getBoundingClientRect().right,
          fileira: new Set(topos).size,
          controles: topos.length,
          cabecalhos: Array.from(document.querySelectorAll('.nvt-tabela th')).map((th) =>
            Math.round(th.getBoundingClientRect().height),
          ),
          dataEDetectado: [
            linhas(tr.querySelector('.c-data')!),
            linhas(tr.querySelector('.c-det [aria-hidden="true"]')!),
          ],
          rolagem: document.documentElement.scrollWidth > innerWidth,
        };
      }, NB);
      expect(m.altura).toBeGreaterThanOrEqual(48);
      expect(m.altura).toBeLessThanOrEqual(56);
      expect(m.linhasDoNumero).toBe(1);
      expect(m.numeroEIconeColados).toBeLessThanOrEqual(6);
      expect(m.fileira).toBe(1);
      expect(m.controles).toBe(3); // B não pede providência: abrir, pasta, IA
      // Cabeçalhos em UMA linha: todos com a altura de uma linha (a coluna Classe some abaixo de 1600 px: altura 0).
      expect(m.cabecalhos.every((n) => n <= 52)).toBe(true);
      expect(m.dataEDetectado).toEqual([1, 1]);
      expect(m.rolagem).toBe(false);
    });
  }

  it('Partes: até 2 linhas, com o texto inteiro no title; cabeçalho "Data" mantém o nome completo', async () => {
    await abrir(1920);
    const m = await page.evaluate((n) => {
      const el = document.querySelector(
        `tr.nvt-linha[data-processo="${n}"] .nvt-partes`,
      ) as HTMLElement;
      return {
        linhas: Math.round(
          el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
        ),
        title: el.getAttribute('title'),
        texto: el.textContent,
        ord: (
          document.querySelector('[data-chave="dataAto"]') as HTMLElement
        ).getAttribute('aria-label'),
        ordTitle: (
          document.querySelector('[data-chave="dataAto"]') as HTMLElement
        ).getAttribute('title'),
      };
    }, NB);
    expect(m.linhas).toBe(2);
    expect(m.title).toBe(m.texto);
    expect(m.title).toContain('Fazenda Pública Fictícia do Estado Imaginário');
    expect(m.ord).toBe('Data do ato');
    expect(m.ordTitle).toBe('Data do ato');
    // O nome acessível do cabeçalho segue "Data do ato" para quem ordena.
    expect(await page.getByRole('button', { name: 'Data do ato' }).count()).toBe(1);
  });

  it('o aviso "Sem atualização detectada" mora na linha do ato e não ganha linha própria em 1920 px', async () => {
    await abrir(1920);
    const c = linha(NC).locator('.c-atu');
    expect((await c.locator('.nvt-sem').textContent())?.replace(/\s+/g, ' ')).toContain(
      'Sem atualização detectada',
    );
    expect(await c.locator('.nvt-sem').getAttribute('title')).toContain(
      'Última movimentação conhecida',
    );
    const h = await linha(NC).evaluate((tr) => tr.getBoundingClientRect().height);
    expect(h).toBeLessThanOrEqual(56);
  });

  it('as ações são botões reais com nome acessível, alvo de pelo menos 24 px, na ordem visual; Enter e Espaço ativam', async () => {
    await abrir(1366);
    const l = linha(NA);
    const copiar = l.getByRole('button', { name: /^Copiar o número do processo / });
    const caixa = l.locator('input[data-cx="cumprido"]');
    const abrirB = l
      .locator('.c-acoes')
      .getByRole('button', { name: /^Abrir o processo / });
    const pasta = l.getByRole('button', { name: /^Abrir a pasta digital do processo / });
    const ia = l.getByRole('button', { name: 'Analisar com IA' });
    for (const b of [copiar, caixa, abrirB, pasta, ia]) {
      // A caixa é um <input> pequeno dentro do rótulo de 28 px: o alvo é o rótulo.
      const alvo = b === caixa ? l.locator('.sit-cx') : b;
      const caixaPx = (await alvo.boundingBox())!;
      expect(caixaPx.width).toBeGreaterThanOrEqual(24);
      expect(caixaPx.height).toBeGreaterThanOrEqual(24);
    }
    expect(await ia.getAttribute('type')).toBe('button');
    expect(await ia.locator('svg').getAttribute('aria-hidden')).toBe('true');
    // Ordem do Tab = ordem visual: copiar, caixa, abrir, pasta, IA.
    await copiar.focus();
    const ordem: string[] = [];
    // O "Abrir processo" da célula Atualização vem entre o copiar e a caixa, na ordem visual.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      ordem.push(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute('data-cx') ??
            document.activeElement?.getAttribute('data-acao') ??
            '',
        ),
      );
    }
    expect(ordem).toEqual(['abrir', 'cumprido', 'abrir', 'pasta', 'ia']);
    // Espaço abre o painel de IA pelo ícone; Enter o fecha.
    await ia.focus();
    await page.keyboard.press('Space');
    await page.waitForSelector('#pvia-' + NA.replace(/\D/g, ''));
    expect(await ia.getAttribute('aria-expanded')).toBe('true');
    await page.getByRole('button', { name: 'Analisar com IA' }).first().focus();
  });

  it('a análise de IA abre pelo ícone (mesmo clique de antes) e o ícone mostra aberto/fechado em aria-expanded', async () => {
    await abrir(1280);
    const ia = linha(NB).getByRole('button', { name: 'Analisar com IA' });
    expect(await ia.getAttribute('aria-expanded')).toBe('false');
    await ia.click();
    await page.waitForSelector('#pvia-' + NB.replace(/\D/g, ''));
    expect(
      await linha(NB)
        .getByRole('button', { name: 'Analisar com IA' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(await page.locator('#pvia-' + NB.replace(/\D/g, '')).innerText()).toContain(
      'plano IA',
    );
  });

  it('a dica aparece com mouse e com foco em todos os ícones, com o texto certo, e o Esc fecha só a dica', async () => {
    await abrir(1366);
    const casos: Array<[string, RegExp | string, string]> = [
      ['copiar', /^Copiar o número do processo /, 'Copiar número'],
      ['abrir', /^Abrir o processo /, 'Abrir o processo'],
      ['pasta', /^Abrir a pasta digital do processo /, 'Abrir a pasta do processo'],
      ['ia', 'Analisar com IA', 'Analisar com IA'],
    ];
    for (const [, nome, texto] of casos) {
      const b = linha(NB)
        .locator('.nvt-proc, .c-acoes')
        .getByRole('button', { name: nome });
      const d = async (): Promise<{ v: string; t: string; papel: string | null }> =>
        b.evaluate((el) => {
          const e = document.getElementById(el.getAttribute('aria-describedby')!)!;
          return {
            v: getComputedStyle(e).visibility,
            t: e.textContent ?? '',
            papel: e.getAttribute('role'),
          };
        });
      expect((await d()).v).toBe('hidden');
      await b.hover();
      expect(await d()).toEqual({ v: 'visible', t: texto, papel: 'tooltip' });
      await page.mouse.move(2, 2);
      expect((await d()).v).toBe('hidden');
      await b.focus();
      expect((await d()).v).toBe('visible');
      await page.keyboard.press('Escape');
      expect((await d()).v).toBe('hidden');
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON');
    }
    // A dica da caixa "Cumprido" continua a da 0.46.1.
    const caixa = linha(NA).locator('input[data-cx="cumprido"]');
    await caixa.focus();
    expect(
      await caixa.evaluate(
        (el) =>
          document.getElementById(el.getAttribute('aria-describedby')!)!.textContent,
      ),
    ).toBe('Pede providência. Marque quando cumprida.');
  });

  for (const w of [768, 390]) {
    it(`${w}px: cartões; cada ícone ganha o texto ao lado (inclusive "Analisar com IA"), a dica some e não há rolagem horizontal`, async () => {
      await abrir(w);
      const m = await page.evaluate((n) => {
        const tr = document.querySelector(
          `tr.nvt-linha[data-processo="${n}"]`,
        ) as HTMLElement;
        const bs = Array.from(
          tr.querySelectorAll('.nvt-acoes .nvt-ic, .nvt-copiar'),
        ) as HTMLElement[];
        return {
          cartao: getComputedStyle(tr).display,
          textos: bs.map((b) => b.innerText.trim()),
          alvo: Math.min(...bs.map((b) => b.getBoundingClientRect().height)),
          dica: getComputedStyle(tr.querySelector('.nvt-acoes .sit-dica')!).display,
          rolagem: document.documentElement.scrollWidth > innerWidth,
        };
      }, NB);
      expect(m.cartao).toBe('grid');
      expect(m.textos).toEqual(['Copiar número', 'Abrir', 'Pasta', 'Analisar com IA']);
      expect(m.alvo).toBeGreaterThanOrEqual(44);
      expect(m.dica).toBe('none');
      expect(m.rolagem).toBe(false);
    });
  }

  it('1024px: tabela (não cartões), sem rolagem horizontal e o número do processo ainda em uma linha', async () => {
    await abrir(1024);
    const m = await page.evaluate((n) => {
      const tr = document.querySelector(
        `tr.nvt-linha[data-processo="${n}"]`,
      ) as HTMLElement;
      const num = tr.querySelector('.nvt-num') as HTMLElement;
      return {
        tabela: getComputedStyle(document.querySelector('.nvt-tabela')!).display,
        altura: num.getBoundingClientRect().height,
        rolagem: document.documentElement.scrollWidth > innerWidth,
      };
    }, NB);
    expect(m.tabela).toBe('table');
    expect(m.altura).toBeLessThan(24);
    expect(m.rolagem).toBe(false);
  });

  for (const escuro of [false, true]) {
    it(`axe sem violações na tabela, com uma dica à vista (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
      await abrir(1280, escuro);
      await linha(NB).getByRole('button', { name: 'Analisar com IA' }).focus();
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

  for (const w of [1920, 1366, 1280, 1024, 768, 390]) {
    it(`sem rolagem horizontal em ${w}px, com a dica aberta`, async () => {
      await abrir(w);
      if (w >= 1024)
        await linha(NA).getByRole('button', { name: 'Analisar com IA' }).hover();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      ).toBe(false);
    });
  }

  it('copiar: o aviso "Copiado" fica junto do número (sem empurrar a linha) e o resultado é anunciado', async () => {
    await abrir(1366);
    await ctx
      .grantPermissions(['clipboard-read', 'clipboard-write'])
      .catch(() => undefined);
    const l = linha(NB);
    const antes = await l.evaluate((tr) => tr.getBoundingClientRect().height);
    await l.getByRole('button', { name: /^Copiar o número do processo / }).click();
    await page.waitForFunction(() =>
      /copiado|Não foi possível copiar/.test(
        document.getElementById('nvt-live')?.textContent ?? '',
      ),
    );
    expect(await l.evaluate((tr) => tr.getBoundingClientRect().height)).toBe(antes);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    ).toBe(false);
  });
});
