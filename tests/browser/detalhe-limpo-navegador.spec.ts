/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
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
 * v0.41.1 NUM NAVEGADOR: a tela de detalhe do processo sem os blocos "Pede providência"
 * e "Última movimentação"; a ordem passa a ser cabeçalho → Peças do processo → Partes →
 * Linha do tempo. O mesmo processo, que TEM ato pedindo providência, continua com selo,
 * filtro e contagem na aba Atualizações (regressão: só a apresentação do detalhe saiu).
 * Servidor e console reais; dados SINTÉTICOS (repositório público).
 */
const sem = CHROMIUM === undefined;
const NUMERO = numeroValido(7101, '26', '0100');
const DIA = 86_400_000;

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}
interface ConsolePv {
  __pv?: { abrir(n: string): unknown };
}

describe.skipIf(sem)(
  'Tela de detalhe sem os blocos antigos, no navegador',
  { timeout: 90_000 },
  () => {
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
          porNumero: async (numero) =>
            new Processo({
              numero: NumeroCNJ.criar(numero),
              tribunal: 'TJSP',
              classe: 'Procedimento Comum Cível',
              partes: [
                {
                  nome: 'Autora Sintética',
                  polo: 'ATIVO',
                  tipoPessoa: 'FISICA',
                  advogados: [],
                },
                {
                  nome: 'Empresa Sintética',
                  polo: 'PASSIVO',
                  tipoPessoa: 'JURIDICA',
                  advogados: [],
                },
              ],
              movimentacoes: [
                {
                  // Pede providência (prazo em dias), dentro da janela de 10 dias.
                  data: new Date(Date.now() - 1 * DIA),
                  titulo: 'Ato ordinatório',
                  conteudo:
                    'Intime-se a parte autora para manifestar-se no prazo de 5 dias.',
                },
                {
                  data: new Date(Date.now() - 40 * DIA),
                  titulo: 'Juntada de documentos',
                },
              ],
              procedencia: {
                provider: 'falso',
                consultadoEm: new Date(),
                deCache: false,
              },
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
      const r = await servidor.inject({
        method: 'POST',
        url: '/v1/acompanhamentos',
        headers: { 'x-api-key': CHAVE },
        payload: { numero: NUMERO },
      });
      if (r.statusCode >= 300) throw new Error(`acompanhar: ${r.statusCode} ${r.body}`);
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

    async function novaPagina(largura: number, escuro = false): Promise<void> {
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
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
    }

    async function abrirDetalhe(largura = 1280, escuro = false): Promise<void> {
      await novaPagina(largura, escuro);
      await page.goto(url + '/');
      await page.waitForFunction(
        () => typeof (window as unknown as ConsolePv).__pv?.abrir === 'function',
      );
      await page.evaluate((n) => (window as unknown as ConsolePv).__pv!.abrir(n), NUMERO);
      await page.waitForSelector('#pecas-resumo .cartao h3');
      await page.waitForSelector(
        'h3.sec:has-text("Linha do tempo"), h3.sec:has-text("Andamentos")',
      );
    }

    it('não tem "Pede providência" nem "Última movimentação" no bloco de dados; a ordem é Peças → Partes → Linha do tempo', async () => {
      await abrirDetalhe();
      const texto = await page.locator('#conteudo').innerText();
      // "Pede providência" continua existindo como CHIP do filtro da linha do tempo (a marca
      // do ato não saiu); o que saiu foi o bloco/cartão.
      expect(await page.locator('.cartao.alerta').count()).toBe(0);
      expect(await page.locator('.agora').count()).toBe(0);
      expect(texto).not.toContain('Última movimentação');
      expect(texto).not.toContain('ato(s) anterior(es)');
      expect(texto).not.toContain('Marcado por leitura automática');
      expect(texto).not.toMatch(/Pede providência\s*·/);
      const titulos = await page.locator('#conteudo h3.sec').allTextContents();
      const norm = titulos.map((t) => t.replace(/\s+/g, ' ').trim());
      const i = (re: RegExp): number => norm.findIndex((t) => re.test(t));
      expect(i(/^Peças do processo/)).toBeGreaterThan(-1);
      expect(i(/^Partes$/)).toBe(i(/^Peças do processo/) + 1);
      expect(i(/^(Linha do tempo|Andamentos)/)).toBe(i(/^Partes$/) + 1);
      // As partes continuam com o conteúdo de antes.
      expect(texto).toContain('Autora Sintética');
      expect(texto).toContain('Empresa Sintética');
      // E a marca do ato na linha do tempo e no filtro continua.
      expect(await page.locator('.ev.pede').count()).toBe(1);
      expect(await page.locator('.chips').innerText()).toContain('Pede providência');
    });

    it('sem vão: as Partes ficam logo abaixo do card de peças, com a margem de sempre', async () => {
      await abrirDetalhe();
      const caixa = await page.evaluate(() => {
        const pecas = document.querySelector('#pecas-resumo')!.getBoundingClientRect();
        const partes = Array.from(document.querySelectorAll('#conteudo h3.sec'))
          .find((h) => h.textContent?.trim() === 'Partes')!
          .closest('.cartao')!
          .getBoundingClientRect();
        return { vao: partes.top - pecas.bottom };
      });
      // O card de peças reserva 96 px e as Partes vêm em seguida: o vão é a margem do
      // cartão (um valor pequeno), nunca a altura de um bloco que saiu.
      expect(caixa.vao).toBeGreaterThanOrEqual(0);
      expect(caixa.vao).toBeLessThan(40);
    });

    it('regressão: a aba Atualizações segue mostrando o selo, o filtro e a contagem do mesmo processo', async () => {
      await novaPagina(1280);
      await page.goto(url + '/');
      await page.waitForSelector('.nvt-tabela');
      const linha = page.locator(`tr.nvt-linha[data-processo="${NUMERO}"]`);
      expect(await linha.count()).toBe(1);
      // (0.46.0) O sinal é a caixa "Cumprido" desmarcada, com a dica "Pede providência…" (não há mais texto de estado).
      expect(
        await linha.locator('.c-acoes input[type="checkbox"]:not(:checked)').count(),
      ).toBe(1);
      expect(await linha.locator('.c-acoes .sit-dica').textContent()).toMatch(
        /^Pede providência/,
      );
      // O filtro e a contagem do chip.
      const chip = page.locator('[data-foco="sit-providencia"]');
      expect(await chip.innerText()).toMatch(/Pedem providência[\s\S]*1/);
    });

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${largura}px`, async () => {
        await abrirDetalhe(largura);
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        }));
        expect(m.sw).toBeLessThanOrEqual(m.cw);
      });
    }

    for (const escuro of [false, true]) {
      it(`axe sem violações e tabulação na ordem Peças → Partes → Linha do tempo (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        await abrirDetalhe(1280, escuro);
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const r = await page.evaluate(() =>
          (window as unknown as AxeNaPagina).axe.run(
            // "← voltar" usa o --tinta3 global (4,2:1): problema anterior a esta versão,
            // registrado no CLAUDE.md; trocar a variável é decisão à parte.
            { include: [['#conteudo']], exclude: [['#voltar']] } as unknown as Element,
            { rules: { 'color-contrast': { enabled: true } } },
          ),
        );
        expect(
          r.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          ),
        ).toEqual([]);
        // A ordem de tabulação segue a do DOM: o card de peças (onde ficam "Pasta digital" e
        // "Atualizar") precede as Partes, que precedem a linha do tempo. Nenhum tabindex
        // positivo reordena isso.
        const ordem = await page.evaluate(() => {
          const antes = (a: Element, b: Element): boolean =>
            !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
          const pecas = document.querySelector('#pecas-resumo')!;
          const partes = Array.from(document.querySelectorAll('#conteudo h3.sec')).find(
            (h) => h.textContent?.trim() === 'Partes',
          )!;
          const chips = document.querySelector('.chips')!;
          return {
            pecasAntesDePartes: antes(pecas, partes),
            partesAntesDaLinha: antes(partes, chips),
            tabindexPositivo: document.querySelectorAll(
              '#conteudo [tabindex]:not([tabindex="0"]):not([tabindex^="-"])',
            ).length,
          };
        });
        expect(ordem).toEqual({
          pecasAntesDePartes: true,
          partesAntesDaLinha: true,
          tabindexPositivo: 0,
        });
      });
    }
  },
);
