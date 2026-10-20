/// <reference lib="dom" />
import { writeFileSync } from 'node:fs';
import AxeBuilder from 'axe-core';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAVE, CHROMIUM } from './ambiente.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';
import type { FastifyInstance } from 'fastify';

/*
 * v0.49.1 NUM NAVEGADOR: só a APRESENTAÇÃO do painel de Custos — colunas da tabela, ações em ícones com dica
 * e a grade do formulário. Dados SINTÉTICOS. Com PV_MEDIDAS=<arquivo> o teste de medição grava as larguras
 * das colunas em JSON (usado para o relatório antes/depois).
 */
const sem = CHROMIUM === undefined;
let proximo = 9100;
const novoNumero = (): string => numeroValido(proximo++, '26', '0100');
interface AxeNaPagina {
  axe: {
    run(
      raiz: Element,
      o: object,
    ): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }>;
  };
}
interface ConsolePv {
  __pv?: { abrir(n: string): unknown };
}

describe.skipIf(sem)('Painel de Custos, apresentação', { timeout: 120_000 }, () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let servidor: FastifyInstance | undefined;
  let url = '';

  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: CHROMIUM as string,
      args: ['--no-sandbox'],
    });
    const app = aplicacaoDeTeste([
      new ProviderFalso({
        nome: 'falso',
        porNumero: async (n) =>
          new Processo({
            numero: NumeroCNJ.criar(n),
            tribunal: 'TJSP',
            classe: 'Procedimento Comum Cível',
            partes: [],
            movimentacoes: [],
            procedencia: { provider: 'falso', consultadoEm: new Date(), deCache: false },
          } as ConstructorParameters<typeof Processo>[0]),
      }),
    ]);
    servidor = construirServidor(
      app,
      carregarConfig({
        PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
        LOG_LEVEL: 'silent',
        CACHE_ENABLED: 'false',
        PROCESSOVIVO_API_KEYS: CHAVE,
        RATE_LIMIT_MAX: '100000',
      } as NodeJS.ProcessEnv),
    );
    await servidor.listen({ host: '127.0.0.1', port: 0 });
    const addr = servidor.server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await browser?.close();
    await servidor?.close();
  });
  afterEach(async () => {
    await ctx?.close();
  });

  async function abrirPainel(largura: number, escuro = false): Promise<void> {
    const numero = novoNumero();
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
    page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (e) => {
      throw e;
    });
    await page.goto(url + '/');
    await page.waitForFunction(
      () => typeof (window as unknown as ConsolePv).__pv?.abrir === 'function',
    );
    await page.evaluate((n) => (window as unknown as ConsolePv).__pv!.abrir(n), numero);
    await page.waitForSelector('#cust-abrir');
    await page.locator('#cust-abrir').click();
    await page.waitForSelector('#cust-painel');
    await page.waitForFunction(
      () => !document.querySelector('#cust-lista')?.textContent?.includes('Carregando'),
    );
  }

  async function lancar(o: {
    descricao: string;
    valor: string;
    categoria?: string;
    data?: string;
  }): Promise<void> {
    await page.locator('#cust-novo').click();
    await page.locator('#cust-f-data').fill(o.data ?? '2026-10-20');
    await page.locator('#cust-f-desc').fill(o.descricao);
    if (o.categoria)
      await page.locator('#cust-f-cat').selectOption({ label: o.categoria });
    await page.locator('#cust-f-valor').fill(o.valor);
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
  }

  const LARGURAS = [1920, 1366, 1280, 1024];

  it('mede as colunas da tabela de lançamentos nas quatro larguras', async () => {
    const saida: Record<string, unknown> = {};
    for (const w of LARGURAS) {
      await abrirPainel(w);
      await lancar({
        descricao: 'Guia de custas iniciais',
        valor: '1.234,56',
        categoria: 'Custas iniciais',
      });
      saida[String(w)] = await page.evaluate(() => {
        const ths = Array.from(
          document.querySelectorAll('.cust-tab:not(.cust-tab-rec) th'),
        );
        const tr = document.querySelector(
          '.cust-tab:not(.cust-tab-rec) tbody tr',
        ) as HTMLElement;
        return {
          colunas: ths.map((t) => [
            t.textContent,
            Math.round(t.getBoundingClientRect().width),
          ]),
          alturaDaLinha: Math.round(tr.getBoundingClientRect().height),
          celulas: Array.from(tr.children).map((c) =>
            Math.round(c.getBoundingClientRect().height),
          ),
          filho: Array.from(tr.querySelectorAll('.sit-dica-wrap, .cust-ib'))
            .slice(0, 2)
            .map((c) => [c.className, Math.round(c.getBoundingClientRect().height)]),
          rolagemHorizontal: document.documentElement.scrollWidth > innerWidth,
        };
      });
      await ctx.close();
    }
    if (process.env['PV_MEDIDAS'])
      writeFileSync(process.env['PV_MEDIDAS'], JSON.stringify(saida, null, 1));
    expect(Object.keys(saida)).toHaveLength(4);
  });

  const LINHA = '#cust-lista .cust-tab:not(.cust-tab-rec) tbody tr';
  const lancamentoTipico = {
    descricao: 'Guia de custas iniciais',
    valor: '1.234,56',
    categoria: 'Custas iniciais',
  };

  for (const w of [1920, 1366, 1280]) {
    it(`${w}px: um lançamento típico ocupa UMA linha; data sem quebra, valor à direita e sem rolagem horizontal`, async () => {
      await abrirPainel(w);
      await lancar(lancamentoTipico);
      const m = await page.evaluate((sel) => {
        const tr = document.querySelector(sel) as HTMLElement;
        const linhas = (el: Element): number => {
          const r = document.createRange();
          r.selectNodeContents(el);
          return new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top)))
            .size;
        };
        const td = (i: number): HTMLElement => tr.children[i] as HTMLElement;
        const cs = getComputedStyle(td(3));
        return {
          altura: tr.getBoundingClientRect().height,
          alturaDoIcone: (
            tr.querySelector('.cust-ib') as HTMLElement
          ).getBoundingClientRect().height,
          linhasDaData: linhas(td(0)),
          linhasDaDescricao: linhas(td(1).querySelector('.cust-desc-t')!),
          alinhamentoDoValor: cs.textAlign,
          numeros: cs.fontVariantNumeric,
          valorNoLimite: td(3).scrollWidth <= td(3).clientWidth,
          dataNoLimite: td(0).scrollWidth <= td(0).clientWidth,
          acoesEmUmaFileira:
            new Set(
              Array.from(tr.querySelectorAll('.cust-ib')).map((b) =>
                Math.round(b.getBoundingClientRect().top),
              ),
            ).size === 1,
          rolagem: document.documentElement.scrollWidth > innerWidth,
        };
      }, LINHA);
      // 28 px do ícone + 2×6 de margem + a linha da borda: uma linha de texto não passa disso.
      expect(m.altura).toBeLessThanOrEqual(m.alturaDoIcone + 20);
      expect(m.linhasDaData).toBe(1);
      expect(m.linhasDaDescricao).toBe(1);
      expect(m.alinhamentoDoValor).toBe('right');
      expect(m.numeros).toContain('tabular-nums');
      expect(m.valorNoLimite).toBe(true);
      expect(m.dataNoLimite).toBe(true);
      expect(m.acoesEmUmaFileira).toBe(true);
      expect(m.rolagem).toBe(false);
    });
  }

  it('1024px: no máximo duas linhas por lançamento e sem rolagem horizontal', async () => {
    await abrirPainel(1024);
    await lancar(lancamentoTipico);
    const m = await page.evaluate((sel) => {
      const tr = document.querySelector(sel) as HTMLElement;
      const lh = parseFloat(getComputedStyle(tr.children[1] as HTMLElement).lineHeight);
      return {
        altura: tr.getBoundingClientRect().height,
        lh,
        rolagem: document.documentElement.scrollWidth > innerWidth,
        tabela: getComputedStyle(document.querySelector('.cust-tab')!).display,
      };
    }, LINHA);
    expect(m.tabela).toBe('table');
    expect(m.altura).toBeLessThanOrEqual(m.lh * 2 + 16 + 2);
    expect(m.rolagem).toBe(false);
  });

  it('a Subcategoria é uma linha com reticências e o texto inteiro no title e no nome acessível; a Descrição vai a duas linhas e depois corta', async () => {
    await abrirPainel(1280);
    const longa = 'Complementação de honorários periciais';
    await lancar({
      descricao: 'Texto de descrição muito longo '.repeat(12).trim(),
      valor: '10,00',
      categoria: longa,
    });
    const m = await page.evaluate((sel) => {
      const tr = document.querySelector(sel) as HTMLElement;
      const sub = tr.querySelector('.cust-sub-t') as HTMLElement;
      const desc = tr.querySelector('.cust-desc-t') as HTMLElement;
      return {
        cortada: sub.scrollWidth > sub.clientWidth,
        reticencias: getComputedStyle(sub).textOverflow,
        titulo: sub.getAttribute('title'),
        texto: sub.textContent,
        celula: (tr.children[2] as HTMLElement).innerText,
        descCortada: desc.scrollHeight > desc.clientHeight,
        descLinhas: Math.round(
          desc.clientHeight / parseFloat(getComputedStyle(desc).lineHeight),
        ),
        descTitulo: desc.getAttribute('title')?.length,
      };
    }, LINHA);
    expect(m.cortada).toBe(true);
    expect(m.reticencias).toBe('ellipsis');
    expect(m.titulo).toContain(longa);
    expect(m.texto).toContain(longa);
    expect(m.descLinhas).toBe(2);
    expect(m.descCortada).toBe(true);
    expect(m.descTitulo).toBeGreaterThan(150);
  });

  it('as ações são botões com nome acessível próprio, alvo de pelo menos 24 px, na ordem visual, e funcionam por Enter e Espaço', async () => {
    await abrirPainel(1366);
    await lancar(lancamentoTipico);
    const nomes = [
      'Editar lançamento',
      'Cancelar lançamento',
      'Anexar comprovante',
      'Histórico do lançamento',
    ];
    const linha = page.locator(LINHA);
    for (const n of nomes) {
      const b = linha.getByRole('button', { name: n });
      expect(await b.count(), n).toBe(1);
      expect(await b.getAttribute('type')).toBe('button');
      const caixa = (await b.boundingBox())!;
      expect(caixa.width).toBeGreaterThanOrEqual(24);
      expect(caixa.height).toBeGreaterThanOrEqual(24);
      expect(await b.locator('svg').getAttribute('aria-hidden')).toBe('true');
    }
    // A ordem do Tab é a visual (esquerda para a direita).
    await linha.getByRole('button', { name: nomes[0]! }).focus();
    for (const n of nomes.slice(1)) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      ).toBe(n);
    }
    // Espaço abre o formulário de edição; Enter abre o histórico.
    await linha.getByRole('button', { name: nomes[0]! }).focus();
    await page.keyboard.press('Space');
    await page.waitForSelector('#cust-form');
    expect(await page.locator('#cust-form-tit').textContent()).toBe('Editar lançamento');
    await page.locator('[data-cust="cancelar-form"]').click();
    await linha.getByRole('button', { name: nomes[3]! }).focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.cust-hist-lista');
  });

  it('a dica aparece com o mouse e com o foco, tem role=tooltip ligada por aria-describedby, e o Esc fecha só a dica', async () => {
    await abrirPainel(1366);
    await lancar(lancamentoTipico);
    const b = page.locator(LINHA).getByRole('button', { name: 'Cancelar lançamento' });
    const dica = async (): Promise<{
      visivel: string;
      texto: string;
      papel: string | null;
      ligada: boolean;
    }> =>
      b.evaluate((el) => {
        const id = el.getAttribute('aria-describedby')!;
        const d = document.getElementById(id)!;
        return {
          visivel: getComputedStyle(d).visibility,
          texto: d.textContent ?? '',
          papel: d.getAttribute('role'),
          ligada: d.previousElementSibling === el,
        };
      });
    expect((await dica()).visivel).toBe('hidden');
    await b.hover();
    let d = await dica();
    expect(d).toMatchObject({
      visivel: 'visible',
      texto: 'Cancelar lançamento',
      papel: 'tooltip',
      ligada: true,
    });
    await page.mouse.move(5, 5);
    expect((await dica()).visivel).toBe('hidden');
    await b.focus();
    d = await dica();
    expect(d.visivel).toBe('visible');
    // A dica não cobre a própria linha nem rouba o mouse.
    const caixaDica = await b.evaluate((el) => {
      const r = document
        .getElementById(el.getAttribute('aria-describedby')!)!
        .getBoundingClientRect();
      const tr = el.closest('tr')!.getBoundingClientRect();
      return {
        topo: r.top,
        fundoDaLinha: tr.bottom,
        eventos: getComputedStyle(
          document.getElementById(el.getAttribute('aria-describedby')!)!,
        ).pointerEvents,
      };
    });
    expect(caixaDica.topo).toBeGreaterThanOrEqual(caixaDica.fundoDaLinha - 12);
    expect(caixaDica.eventos).toBe('none');
    // Axe com a dica à vista.
    await page.addScriptTag({
      content: (AxeBuilder as unknown as { source: string }).source,
    });
    const r = await page.evaluate(() =>
      (window as unknown as AxeNaPagina).axe.run(
        { include: [['#cust-raiz']] } as unknown as Element,
        { rules: { 'color-contrast': { enabled: true } } },
      ),
    );
    expect(r.violations.map((v) => v.id)).toEqual([]);
    await page.keyboard.press('Escape');
    expect((await dica()).visivel).toBe('hidden');
    expect(await page.locator('#cust-painel').count()).toBe(1);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    ).toBe('Cancelar lançamento');
    // O segundo Esc volta a fazer o que fazia: fecha o painel.
    await page.keyboard.press('Escape');
    await page.waitForSelector('#cust-painel', { state: 'detached' });
  });

  it('o selo do clipe conta os comprovantes sem mudar o tamanho do botão, e o nome acessível diz quantos', async () => {
    await abrirPainel(1366);
    await lancar(lancamentoTipico);
    const sem = (await page
      .locator(LINHA)
      .getByRole('button', { name: 'Anexar comprovante' })
      .boundingBox())!;
    await page.route(/\/v1\/processos\/\d+\/custos(\?.*)?$/, async (rota) => {
      const resp = await rota.fetch();
      const corpo = (await resp.json()) as {
        lancamentos: Array<Record<string, unknown>>;
      };
      for (const l of corpo.lancamentos)
        l['comprovantes'] = [1, 2].map((i) => ({
          id: 'c' + i,
          nome: `arquivo-${i}.pdf`,
          tamanho: 1000,
          link: 'https://drive.google.com/file/d/x' + i,
        }));
      await rota.fulfill({ response: resp, json: corpo });
    });
    await page.locator('#cust-abrir').click();
    await page.locator('#cust-abrir').click();
    await page.waitForSelector('#cust-lista .cust-tab');
    const b = page
      .locator(LINHA)
      .getByRole('button', { name: 'Anexar comprovante (2 anexados)' });
    expect(await b.count()).toBe(1);
    const com = (await b.boundingBox())!;
    expect([com.width, com.height]).toEqual([sem.width, sem.height]);
    expect(await b.locator('.cust-ib-n').innerText()).toBe('2');
    expect(await b.locator('.cust-ib-n').getAttribute('aria-hidden')).toBe('true');
  });

  for (const w of [768, 390]) {
    it(`${w}px: cartões, com o texto da ação ao lado do ícone, e sem rolagem horizontal`, async () => {
      await abrirPainel(w);
      await lancar(lancamentoTipico);
      const m = await page.evaluate((sel) => {
        const tr = document.querySelector(sel) as HTMLElement;
        return {
          cartao: getComputedStyle(tr).display,
          textos: Array.from(tr.querySelectorAll('.cust-ib')).map((b) =>
            (b as HTMLElement).innerText.trim(),
          ),
          dicaVisivel: getComputedStyle(tr.querySelector('.sit-dica')!).display,
          alvo: Math.min(
            ...Array.from(tr.querySelectorAll('.cust-ib')).map(
              (b) => b.getBoundingClientRect().height,
            ),
          ),
          rolagem: document.documentElement.scrollWidth > innerWidth,
        };
      }, LINHA);
      expect(m.cartao).toBe('block');
      expect(m.textos).toEqual(['Editar', 'Cancelar', 'Comprovante', 'Histórico']);
      expect(m.dicaVisivel).toBe('none');
      expect(m.alvo).toBeGreaterThanOrEqual(44);
      expect(m.rolagem).toBe(false);
    });
  }

  for (const w of [1920, 1280, 1024]) {
    it(`${w}px: rótulo, caixa e altura de "Data do gasto", "Descrição" e "Valor (R$)" estão alinhados, e a prévia não empurra os vizinhos`, async () => {
      await abrirPainel(w);
      await page.locator('#cust-novo').click();
      const caixas = async (): Promise<
        Record<string, { rotulo: number; topo: number; altura: number; fundo: number }>
      > =>
        page.evaluate(() => {
          const r: Record<
            string,
            { rotulo: number; topo: number; altura: number; fundo: number }
          > = {};
          for (const id of [
            'cust-f-data',
            'cust-f-desc',
            'cust-f-valor',
            'cust-f-busca',
            'cust-f-cat',
          ]) {
            const c = document.getElementById(id)!.getBoundingClientRect();
            const l = document
              .querySelector(`label[for="${id}"]`)!
              .getBoundingClientRect();
            r[id] = {
              rotulo: Math.round(l.top),
              topo: Math.round(c.top),
              altura: Math.round(c.height),
              fundo: Math.round(c.bottom),
            };
          }
          return r;
        });
      const antes = await caixas();
      const linha1 = ['cust-f-data', 'cust-f-desc', 'cust-f-valor'].map((i) => antes[i]!);
      expect(new Set(linha1.map((c) => c.rotulo)).size).toBe(1);
      expect(new Set(linha1.map((c) => c.topo)).size).toBe(1);
      expect(new Set(linha1.map((c) => c.altura)).size).toBe(1);
      const linha2 = ['cust-f-busca', 'cust-f-cat'].map((i) => antes[i]!);
      expect(new Set(linha2.map((c) => c.topo)).size).toBe(1);
      expect(new Set(linha2.map((c) => c.altura)).size).toBe(1);
      // Digitar o valor mostra "= R$ 1.234,56" abaixo da caixa sem mexer em nenhum campo.
      await page.locator('#cust-f-valor').fill('1234,56');
      expect(await page.locator('#cust-f-previa').innerText()).toContain('1.234,56');
      expect(await caixas()).toEqual(antes);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      ).toBe(false);
    });
  }

  it('390px: o formulário empilha em uma coluna, sem rolagem horizontal, e a ordem do Tab é a de sempre', async () => {
    await abrirPainel(390);
    await page.locator('#cust-novo').click();
    const lefts = await page.evaluate(() =>
      ['cust-f-data', 'cust-f-desc', 'cust-f-valor', 'cust-f-busca', 'cust-f-cat'].map(
        (i) => Math.round(document.getElementById(i)!.getBoundingClientRect().left),
      ),
    );
    expect(new Set(lefts).size).toBe(1);
    await page.locator('#cust-f-data').focus();
    // O campo de data tem segmentos internos (dia, mês, ano): só conta quando o id muda.
    const ordem: string[] = ['cust-f-data'];
    for (let i = 0; i < 12 && ordem.length < 5; i++) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(() => document.activeElement?.id ?? '');
      if (id !== ordem[ordem.length - 1]) ordem.push(id);
    }
    expect(ordem).toEqual([
      'cust-f-data',
      'cust-f-desc',
      'cust-f-valor',
      'cust-f-busca',
      'cust-f-cat',
    ]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    ).toBe(false);
  });

  for (const escuro of [false, true]) {
    it(`axe sem violações na tabela de ícones e no formulário (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
      await abrirPainel(1280, escuro);
      await lancar(lancamentoTipico);
      await page.locator('#cust-novo').click();
      await page.addScriptTag({
        content: (AxeBuilder as unknown as { source: string }).source,
      });
      const r = await page.evaluate(() =>
        (window as unknown as AxeNaPagina).axe.run(
          { include: [['#cust-raiz']] } as unknown as Element,
          { rules: { 'color-contrast': { enabled: true } } },
        ),
      );
      expect(
        r.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
        ),
      ).toEqual([]);
    });
  }
});
