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
import {
  carteira,
  grupo,
  infoProcesso,
  novidade,
  numeroValido,
  respostaNovidades,
} from '../helpers/atualizacoesSinteticas.js';
import type { GrupoSintetico } from '../helpers/atualizacoesSinteticas.js';
import type { FastifyInstance } from 'fastify';

/*
 * v0.37.2 NUM NAVEGADOR: a classe legível em Atualizações (sem palavra cortada no meio,
 * com title) e a aba "Meus processos" (filtro de classe por nome normalizado, última
 * movimentação sem repetição, sem rodapé redundante). Dados SINTÉTICOS (repositório público).
 */
const sem = CHROMIUM === undefined;

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

const CLASSE_DJEN = 'PROCEDIMENTO COMUM CíVEL';
const CLASSE_DATAJUD = 'Procedimento Comum Cível';

describe.skipIf(sem)(
  'Classe legível e carteira, no navegador',
  { timeout: 90_000 },
  () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    let servidor: FastifyInstance | undefined;
    let url = '';

    const NUMEROS = [
      numeroValido(7001, '26', '0100'),
      numeroValido(7002, '26', '0100'),
      numeroValido(7003, '26', '0100'),
    ];
    const CLASSES: Record<string, string> = {
      [NUMEROS[0] as string]: CLASSE_DATAJUD,
      [NUMEROS[1] as string]: CLASSE_DJEN,
      [NUMEROS[2] as string]: 'Execução Fiscal',
    };

    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath: CHROMIUM as string,
        args: ['--no-sandbox'],
      });
      // O servidor de verdade, com um tribunal falso que devolve três processos: duas
      // escritas CRUAS da mesma classe e uma outra classe.
      const app = aplicacaoDeTeste([
        new ProviderFalso({
          nome: 'falso',
          porNumero: async (numero) =>
            new Processo({
              numero: NumeroCNJ.criar(numero),
              tribunal: 'TJSP',
              classe: CLASSES[numero.replace(/\D/g, '')] ?? null,
              movimentacoes: [
                {
                  data: new Date('2026-09-20T13:00:00Z'),
                  titulo:
                    'Juntada de Petição — Juntada de Petição - MANDADO LEVANTAMENTO',
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
          // Dezenas de páginas abertas em poucos segundos: o limite padrão (60/min) barraria o teste.
          RATE_LIMIT_MAX: '100000',
        } as NodeJS.ProcessEnv),
      );
      for (const numero of NUMEROS) {
        const r = await servidor.inject({
          method: 'POST',
          url: '/v1/acompanhamentos',
          headers: { 'x-api-key': CHAVE },
          payload: { numero },
        });
        if (r.statusCode >= 300) throw new Error(`acompanhar: ${r.statusCode} ${r.body}`);
      }
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

    /* ------------------------------------------------------- Atualizações: coluna Classe */

    function gruposComClasses(): GrupoSintetico[] {
      const classes: Array<string | null> = [
        CLASSE_DJEN,
        CLASSE_DATAJUD,
        'EXECUÇÃO DE TÍTULO EXTRAJUDICIAL',
        'Cumprimento de Sentença',
        null,
      ];
      return classes.map((classe, i) => {
        const numero = numeroValido(7100 + i, '26', '0100');
        return grupo(
          numero,
          novidade(numero, 'Juntada de petição', { diasDetectada: i }),
          [],
          infoProcesso('TJSP', classe, [`Autora ${i}`], [`Empresa ${i} Ltda`]),
        );
      });
    }

    async function abrirAtualizacoes(
      largura: number,
      escuro = false,
      grupos = gruposComClasses(),
    ): Promise<void> {
      await novaPagina(largura, escuro);
      await ctx.route('**/v1/novidades**', async (rota) => {
        await rota.fulfill({
          json: respostaNovidades(grupos, { acompanhados: grupos.length }),
        });
      });
      await page.goto(url + '/');
      // Desde a v0.37.4 a aba abre em "Pedem providência"; estas medidas olham a lista inteira.
      await page.getByRole('button', { name: /^Todas \(/ }).click();
      await page.waitForSelector('.nvt-tabela');
    }

    for (const largura of [1920, 1366, 1280]) {
      it(`em ${largura}px a coluna Classe não corta palavra no meio, cabe em 2 linhas e tem title`, async () => {
        await abrirAtualizacoes(largura);
        const medidas = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>('.c-classe .nvt-classe')).map(
            (el) => {
              const cs = getComputedStyle(el);
              const linha = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
              // Cada palavra, medida sozinha com a mesma fonte: tem de caber na coluna.
              const sonda = document.createElement('span');
              sonda.style.cssText =
                'position:absolute;visibility:hidden;white-space:nowrap;font:' + cs.font;
              document.body.appendChild(sonda);
              const palavras = (el.textContent ?? '').split(/\s+/).filter(Boolean);
              const maior = Math.max(
                ...palavras.map((p) => {
                  sonda.textContent = p;
                  return sonda.getBoundingClientRect().width;
                }),
              );
              sonda.remove();
              return {
                texto: el.textContent ?? '',
                title: el.getAttribute('title') ?? '',
                largura: el.clientWidth,
                maiorPalavra: maior,
                linhas: Math.round(el.scrollHeight / linha),
                cortado: el.scrollHeight > el.clientHeight + 1,
              };
            },
          ),
        );
        expect(medidas).toHaveLength(4);
        for (const m of medidas) {
          expect(m.maiorPalavra, m.texto).toBeLessThanOrEqual(m.largura);
          expect(m.title, m.texto).not.toBe('');
        }
        // A classe do exemplo do dono: duas linhas, palavras inteiras, sem reticências.
        const comum = medidas.filter((m) => m.texto === 'Procedimento Comum Cível');
        expect(comum).toHaveLength(2);
        for (const m of comum) {
          expect(m.cortado).toBe(false);
          expect(m.linhas).toBeLessThanOrEqual(2);
        }
      });
    }

    it('a mesma classe tem o mesmo texto; o cru vai no title só quando difere; sem classe é "—"', async () => {
      await abrirAtualizacoes(1366);
      const celulas = await page.$$eval('.c-classe', (els) =>
        els.map((el) => ({
          texto: (el.textContent ?? '').trim(),
          title: el.querySelector('[title]')?.getAttribute('title') ?? '',
        })),
      );
      expect(celulas.map((c) => c.texto)).toEqual([
        'Procedimento Comum Cível',
        'Procedimento Comum Cível',
        'Execução de Título Extrajudicial',
        'Cumprimento de Sentença',
        '—',
      ]);
      expect(celulas[0]?.title).toBe(CLASSE_DJEN);
      expect(celulas[1]?.title).toBe(CLASSE_DATAJUD);
      expect(celulas[2]?.title).toBe('EXECUÇÃO DE TÍTULO EXTRAJUDICIAL');
    });

    it('1366px: Processo, Atualização e Ações seguem legíveis (número em até 2 linhas, botões dentro)', async () => {
      await abrirAtualizacoes(1366);
      const m = await page.evaluate(() => {
        const num = document.querySelector<HTMLElement>('.nvt-num');
        const linha = num ? parseFloat(getComputedStyle(num).lineHeight) || 18 : 18;
        const acoes = Array.from(document.querySelectorAll<HTMLElement>('.c-acoes'));
        return {
          linhasDoNumero: num
            ? Math.round(num.getBoundingClientRect().height / linha)
            : 0,
          acoesCortadas: acoes.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
          atualizacao:
            document.querySelector('.h-atu')?.getBoundingClientRect().width ?? 0,
        };
      });
      expect(m.linhasDoNumero).toBeLessThanOrEqual(2);
      expect(m.acoesCortadas).toBe(0);
      expect(m.atualizacao).toBeGreaterThan(150);
    });

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${largura}px (Atualizações e Meus processos)`, async () => {
        await abrirAtualizacoes(largura);
        const larg = () =>
          page.evaluate(() => ({
            sw: document.documentElement.scrollWidth,
            cw: document.documentElement.clientWidth,
          }));
        const a = await larg();
        expect(a.sw).toBeLessThanOrEqual(a.cw);
        await page.unroute('**/v1/novidades**');
        await page.click('#nav-processos');
        await page.waitForSelector('table.tab');
        const b = await larg();
        expect(b.sw).toBeLessThanOrEqual(b.cw);
      });
    }

    for (const escuro of [false, true]) {
      for (const aba of ['atualizacoes', 'processos'] as const) {
        it(`axe sem violações em ${aba}, tema ${escuro ? 'escuro' : 'claro'}, 1366px`, async () => {
          await abrirAtualizacoes(1366, escuro, [...gruposComClasses(), ...carteira(4)]);
          if (aba === 'processos') {
            await page.unroute('**/v1/novidades**');
            await page.click('#nav-processos');
            await page.waitForSelector('table.tab');
          }
          await page.addScriptTag({
            content: (AxeBuilder as unknown as { source: string }).source,
          });
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(
              document.querySelector('#conteudo')!,
              {
                rules: { 'color-contrast': { enabled: true } },
              },
            ),
          );
          expect(
            r.violations
              .map(
                (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
              )
              .join('\n'),
          ).toBe('');
        });
      }
    }

    /* ------------------------------------------------------------ Meus processos */

    async function abrirCarteira(largura = 1366): Promise<void> {
      await novaPagina(largura);
      await page.goto(url + '/');
      // A aba inicial precisa ter terminado de ligar o console antes do clique.
      await page.waitForSelector('#conteudo .nvt');
      await page.click('#nav-processos');
      await page.waitForSelector('table.tab');
    }

    it('o filtro de classe tem UMA opção para as duas grafias cruas e traz as duas', async () => {
      await abrirCarteira();
      await page.click('#f-mais');
      const opcoes = await page.$$eval('#f-cls option', (os) =>
        os.map((o) => (o.textContent ?? '').trim()),
      );
      expect(opcoes).toEqual(['Todas', 'Execução Fiscal', 'Procedimento Comum Cível']);
      expect(await page.locator('table.tab tbody tr').count()).toBe(3);

      await page.selectOption('#f-cls', { label: 'Procedimento Comum Cível' });
      await page.waitForFunction(
        () => document.querySelectorAll('table.tab tbody tr').length === 2,
      );
      // As duas linhas mostram a MESMA escrita; o cru está no title de uma delas.
      const subs = await page.$$eval('table.tab tbody tr td:first-child .t-sub', (els) =>
        els.map((e) => ({
          texto: (e.textContent ?? '').trim(),
          title: e.getAttribute('title') ?? '',
        })),
      );
      expect(subs.map((s) => s.texto)).toEqual([
        'Procedimento Comum Cível',
        'Procedimento Comum Cível',
      ]);
      expect(subs.map((s) => s.title).sort()).toEqual(
        [CLASSE_DJEN, CLASSE_DATAJUD].sort(),
      );
    });

    it('com filtro: só o aviso "Mostrando X de Y" diz a contagem; sem rodapé e sem subtítulo repetido', async () => {
      await abrirCarteira();
      // Sem filtro: o subtítulo diz o total UMA vez e não há rodapé.
      expect(await page.locator('.titulo-secao .sub').textContent()).toBe(
        '3 acompanhado(s)',
      );
      expect(await page.locator('.rodape-tab').count()).toBe(0);
      expect(await page.locator('.aviso').count()).toBe(0);
      expect(await page.locator('#cont-processos').textContent()).toBe('3');

      await page.click('#f-mais');
      await page.selectOption('#f-cls', { label: 'Execução Fiscal' });
      await page.waitForFunction(
        () => document.querySelectorAll('table.tab tbody tr').length === 1,
      );
      const aviso = (await page.locator('.aviso').textContent()) ?? '';
      expect(aviso).toContain('Mostrando 1 de 3 processos');
      expect(await page.locator('.titulo-secao .sub').count()).toBe(0);
      expect(await page.locator('.rodape-tab').count()).toBe(0);
      // Nenhuma outra linha da aba repete a contagem do corpo da tabela.
      const corpo = (await page.locator('#conteudo').innerText()).replace(aviso, '');
      expect(corpo).not.toMatch(/\d+ de \d+ processo/);
    });

    it('a última movimentação perde a repetição na exibição; o original fica no title', async () => {
      await abrirCarteira();
      const m = await page.$$eval('.t-mov-t', (els) =>
        els.map((e) => ({
          texto: (e.textContent ?? '').trim(),
          title: e.getAttribute('title') ?? '',
        })),
      );
      expect(m).toHaveLength(3);
      for (const x of m) {
        expect(x.texto).toBe('Juntada de Petição - MANDADO LEVANTAMENTO');
        expect(x.title).toBe(
          'Juntada de Petição — Juntada de Petição - MANDADO LEVANTAMENTO',
        );
      }
    });
  },
);
