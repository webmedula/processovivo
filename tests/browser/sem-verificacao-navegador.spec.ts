/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';
import {
  grupo,
  infoProcesso,
  novidade,
  numeroValido,
  respostaNovidades,
} from '../helpers/atualizacoesSinteticas.js';

/*
 * v0.69.0 NUM NAVEGADOR: o selo "N sem verificação" vira botão e mostra QUAIS processos, com motivo e a
 * última verificação que deu certo. Servidor e console reais; `/v1/novidades` e o campo `verificacao` do
 * painel são simulados com dados SINTÉTICOS (CNJ de mentira, cliente inventado).
 */
const sem = CHROMIUM === undefined;
const NA = numeroValido(9601);
const NB = numeroValido(9602);
const NC = numeroValido(9603);

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

const UM = [
  {
    numero: NB,
    cliente: 'Cliente Fictício da Silva',
    tribunal: 'TRT18',
    motivo: 'fontes_indisponiveis',
    ultimaVerificacaoEm: '2026-11-18T14:10:00.000Z',
  },
];
const DOIS = [
  ...UM,
  {
    numero: NC,
    cliente: null,
    tribunal: null,
    motivo: 'nao_encontrado',
    ultimaVerificacaoEm: null,
  },
];

describe.skipIf(sem)(
  'Processos sem verificação, no navegador',
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

    async function abrir(
      lista: Array<Record<string, unknown>> | undefined,
      opcoes: { largura?: number; escuro?: boolean; naoVerificados?: number } = {},
    ): Promise<void> {
      ctx = await browser.newContext({
        viewport: { width: opcoes.largura ?? 390, height: 900 },
        colorScheme: opcoes.escuro ? 'dark' : 'light',
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
        return rota.fulfill({
          json: respostaNovidades(
            [
              grupo(
                NA,
                novidade(NA, 'Despacho', { diasDetectada: 1 }),
                [],
                infoProcesso(
                  'TJGO',
                  'Execução Fiscal',
                  ['Parte Fictícia'],
                  ['Outra Fictícia'],
                ),
              ),
            ],
            { acompanhados: 3, janelaDias: null },
          ),
        });
      });
      await ctx.route('**/v1/painel', async (rota) => {
        const real = (await (await rota.fetch()).json()) as {
          verificacao: Record<string, unknown>;
        };
        const v: Record<string, unknown> = {
          ...real.verificacao,
          ultimaEm: '2026-11-19T14:10:00.000Z',
          naoVerificados: opcoes.naoVerificados ?? lista?.length ?? 1,
        };
        if (lista) v['semVerificacao'] = lista;
        else delete v['semVerificacao'];
        await rota.fulfill({ json: { ...real, verificacao: v } });
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      await page.goto(amb.url + '/');
      await page.waitForSelector('#sincronizar');
    }

    const botao = () => page.locator('#semv-bt');
    const painel = () => page.locator('#semv-painel');

    it('um processo: o selo diz "ver qual", abre a lista com número, cliente, tribunal, motivo e última verificação', async () => {
      await abrir(UM);
      expect(
        (await botao().innerText()).replace('▾', '').replace(/\s+/g, ' ').trim(),
      ).toBe('1 sem verificação · ver qual');
      expect(await botao().getAttribute('aria-expanded')).toBe('false');
      expect(await painel().isHidden()).toBe(true);

      await botao().click();
      expect(await botao().getAttribute('aria-expanded')).toBe('true');
      expect(await painel().isVisible()).toBe(true);
      // O foco vai ao título da lista: no celular, ela fica abaixo dos botões e entra na tela.
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('semv-titulo');
      const texto = await painel().innerText();
      expect(texto).toContain('Processo sem verificação');
      expect(texto).toContain(NB);
      expect(texto).toContain('Cliente Fictício da Silva');
      expect(texto).toContain('TRT18');
      expect(texto).toContain(
        'As fontes públicas (CNJ e Diário) não responderam na última tentativa.',
      );
      expect(texto).toContain('Última verificação que deu certo: 18/11/2026, 11:10');
      expect(texto).toContain('confira este processo no sistema do tribunal');

      // Fecha de novo.
      await botao().click();
      expect(await painel().isHidden()).toBe(true);
    });

    it('dois processos: "ver quais", plural, cada motivo na sua frase, e o número abre o processo', async () => {
      await abrir(DOIS);
      expect(
        (await botao().innerText()).replace('▾', '').replace(/\s+/g, ' ').trim(),
      ).toBe('2 sem verificação · ver quais');
      await botao().click();
      const texto = await painel().innerText();
      expect(texto).toContain('Processos sem verificação');
      expect(texto).toContain('mas não acharam este número');
      expect(texto).toContain('Nenhuma verificação deu certo ainda.');
      expect(texto).toContain('confira estes processos');
      await page.locator(`[data-semv-abrir="${NC}"]`).click();
      await expect
        .poll(() => page.evaluate(() => location.hash))
        .toMatch(/^#\/processo\//);
      // Nada pessoal na URL: o número do processo não entra no endereço.
      expect(await page.evaluate(() => location.href)).not.toContain(
        NC.replace(/\D/g, ''),
      );
    });

    it('a lista aberta continua aberta quando a tela se redesenha', async () => {
      await abrir(UM);
      await botao().click();
      await page.evaluate(() => {
        (document.querySelector('[data-aba="novidades"]') as HTMLElement | null)?.click();
      });
      await page.waitForSelector('#semv-bt');
      expect(await botao().getAttribute('aria-expanded')).toBe('true');
      expect(await painel().isVisible()).toBe(true);
    });

    it('servidor sem a lista: o selo de antes, sem botão (nada promete o que não abre)', async () => {
      await abrir(undefined, { naoVerificados: 1 });
      expect(await botao().count()).toBe(0);
      expect((await page.locator('.vigia.atencao').innerText()).trim()).toBe(
        '1 sem verificação',
      );
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações com a lista aberta (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        await abrir(DOIS, { escuro });
        await botao().click();
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const r = await page.evaluate(() =>
          (window as unknown as AxeNaPagina).axe.run(
            { include: [['.cabeca'], ['#semv-painel']] } as unknown as Element,
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

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${largura}px com a lista aberta`, async () => {
        await abrir(DOIS, { largura });
        await botao().click();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        ).toBe(false);
      });
    }
  },
);
