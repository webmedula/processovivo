/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';

/*
 * A página inicial (v0.35.1) NUM NAVEGADOR: "Últimas atualizações" mostra só o
 * começo do texto, e nome de arquivo comprido não empurra o trilho para fora da
 * página. O servidor é o real; só as respostas de /v1/novidades e /v1/painel
 * recebem dados sintéticos por cima (decisão de ~3.000 caracteres e nome de
 * arquivo de 120 caracteres sem espaço), sem nada real.
 */
const sem = CHROMIUM === undefined;
const NUMERO = '5818922-04.2026.8.09.0011';
const NOME_LONGO =
  ('arquivosinteticosemespaco' + 'abcdefghij').repeat(3).slice(0, 120) + '.pdf';
const TEXTO_FIM = 'FIM-DO-TEXTO-DA-DECISAO';
const DECISAO =
  'Julgo procedente o pedido formulado na inicial para condenar a parte ré. '.repeat(40) +
  TEXTO_FIM;

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

describe.skipIf(sem)('Página inicial — no navegador', { timeout: 60_000 }, () => {
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

  async function abrir(largura: number, escuro = false): Promise<void> {
    amb = await iniciar();
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
    const agora = new Date().toISOString();
    const diasAtras = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const nov = (
      titulo: string,
      conteudo: string | null,
      vista = false,
      detectadaEm = agora,
    ) => ({
      id: Math.floor(Math.random() * 1e9),
      numero: NUMERO,
      data: agora,
      titulo,
      codigoTpu: null,
      conteudo,
      detectadaEm,
      exigeAcao: false,
      vista,
    });
    const principal = nov('Sentença', DECISAO);
    const anterior = nov('Decisão interlocutória', DECISAO, false, diasAtras(1));
    const vazia = nov('Conclusos para despacho', null, false, diasAtras(11));
    await ctx.route('**/v1/novidades**', async (rota) => {
      const real = (await (await rota.fetch()).json()) as Record<string, unknown>;
      await rota.fulfill({
        json: {
          ...real,
          acompanhados: 1,
          naoVistas: 1,
          janelaDias: 15,
          janelaPadraoDias: 15,
          foraDaJanela: 0,
          grupos: [
            {
              numero: NUMERO,
              maisRecente: principal,
              anteriores: [anterior, vazia],
              naoVistas: 1,
            },
          ],
        },
      });
    });
    await ctx.route('**/v1/painel', async (rota) => {
      const real = (await (await rota.fetch()).json()) as Record<string, unknown>;
      await rota.fulfill({
        json: {
          ...real,
          pecasBaixadas: [
            {
              numero: NUMERO.replace(/\D/g, ''),
              idPeca: 'x1',
              rotulo: NOME_LONGO,
              mimetype: 'application/pdf',
              bytes: 1234,
              baixadaEm: agora,
            },
          ],
        },
      });
    });
    page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(amb.url + '/');
    await page.waitForSelector('.nov-grupo');
  }

  it('mostra só o começo da decisão de ~3.000 caracteres, sem o fim, e abre o processo pelo botão', async () => {
    await abrir(1280);
    expect(DECISAO.length).toBeGreaterThan(2900);
    const texto = (await page.locator('.nov-grupo .nov-txt').first().innerText()).trim();
    expect(texto.length).toBeLessThanOrEqual(222);
    expect(texto.endsWith('…')).toBe(true);
    expect(await page.locator('.nov-grupo').innerText()).not.toContain(TEXTO_FIM);
    // As reticências não são lidas como texto: estão em aria-hidden.
    expect(
      await page.locator('.nov-txt > span[aria-hidden="true"]').first().textContent(),
    ).toBe('…');
    // No máximo 3 linhas visuais.
    const linhas = await page
      .locator('.nov-txt')
      .first()
      .evaluate((el) => {
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
        return Math.round(el.getBoundingClientRect().height / lh);
      });
    expect(linhas).toBeLessThanOrEqual(3);
    // Quem quer ler abre o processo.
    expect(await page.locator('.nov-abrir').count()).toBeGreaterThan(0);
    // A anterior expandida também vem em trecho; sem texto, nenhum bloco vazio.
    await page.click('[data-mais]');
    expect(await page.locator('.nov-ant .nov-txt').count()).toBe(1);
    expect(await page.locator('.nov-trecho:empty').count()).toBe(0);
    expect(await page.locator('.nov-grupo').innerText()).not.toContain(TEXTO_FIM);
    // Nada foi escondido: as três atualizações continuam na tela.
    expect(await page.locator('.nov-grupo .nov').count()).toBe(3);
  });

  it('"detectado há N dias" nos três lugares (destaque, anterior, anterior expandida), com hoje/singular/plural', async () => {
    await abrir(1280);
    const textos = () => page.locator('.nov .lado > span:last-child').allTextContents();
    // Fechado: só a atualização em destaque (detectada agora).
    expect(
      await page.locator('.nov-grupo > .nov .lado > span:last-child').allTextContents(),
    ).toEqual(['detectado hoje']);
    await page.click('[data-mais]');
    expect(await textos()).toEqual([
      'detectado hoje',
      'detectado há 1 dia',
      'detectado há 11 dias',
    ]);
    // A data do ato continua no quadro à esquerda; o tooltip explica a diferença.
    expect(
      await page.locator('.nov .lado > span:last-child').first().getAttribute('title'),
    ).toBe(
      'Quando o Processo Vivo percebeu este ato. A data do ato está no quadro à esquerda.',
    );
    expect(await page.locator('.nov-grupo').innerText()).not.toMatch(
      /(?<!detectado )há \d+ dias?/,
    );
  });

  it('o cartão "Pedem providência" não fala de prazo', async () => {
    await abrir(1280);
    const corpo = (await page.locator('body').innerText()).toLowerCase();
    expect(corpo).not.toContain('abre prazo');
    expect(corpo).toMatch(/ato dos últimos \d+ dias que pede providência/);
  });

  for (const largura of [1280, 1024, 768, 390]) {
    it(`nome de arquivo de 120 caracteres sem espaço não gera rolagem horizontal (${largura}px)`, async () => {
      await abrir(largura);
      await page.waitForSelector('.baixa');
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        trilho: document.querySelector('.trilho')?.getBoundingClientRect().right ?? 0,
      }));
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      expect(m.trilho).toBeLessThanOrEqual(m.cw);
      // O nome inteiro continua na tela, quebrado em linhas — sem "…" de truncamento.
      expect(await page.locator('.baixa .t').first().textContent()).toBe(NOME_LONGO);
    });
  }

  for (const escuro of [false, true]) {
    it(`axe sem violações no tema ${escuro ? 'escuro' : 'claro'}`, async () => {
      await abrir(1280, escuro);
      await page.addScriptTag({
        content: (AxeBuilder as unknown as { source: string }).source,
      });
      const r = await page.evaluate(() =>
        (window as unknown as AxeNaPagina).axe.run(document.querySelector('.feed')!, {
          rules: { 'color-contrast': { enabled: true } },
        }),
      );
      expect(
        r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`),
      ).toEqual([]);
    });
  }
});
