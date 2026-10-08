/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';
import {
  DIA,
  grupo,
  infoProcesso,
  novidade,
  numeroValido,
  respostaNovidades,
  semNovidade,
} from '../helpers/atualizacoesSinteticas.js';
import type {
  GrupoSintetico,
  ProvidenciaSintetica,
  SemNovidadeSintetico,
} from '../helpers/atualizacoesSinteticas.js';

/*
 * "Marcar como cumprido" (v0.37.5) NUM NAVEGADOR. O servidor e o console são os
 * reais; /v1/novidades, /v1/facetas e as rotas de cumprido são simuladas aqui com
 * dados SINTÉTICOS, com o mesmo contrato da API (a API tem teste próprio em
 * tests/http/cumprido.spec.ts).
 */
const sem = CHROMIUM === undefined;
const AGORA = Date.now();
const iso = (diasAtras: number): string =>
  new Date(AGORA - diasAtras * DIA).toISOString();

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

type Info = NonNullable<GrupoSintetico['processo']>;

describe.skipIf(sem)(
  'Atualizações — marcar como cumprido, no navegador',
  { timeout: 90_000 },
  () => {
    let browser: Browser;
    let amb: Ambiente;
    let ctx: BrowserContext;
    let page: Page;
    const dialogos: string[] = [];

    // Processos sintéticos: A (intimação; a linha mostra OUTRO ato), B (citação; é o ato da linha),
    // C (intimação que passou de 30 dias sem marca) e D (nada a dizer).
    const NA = numeroValido(7001);
    const NB = numeroValido(7002);
    const NC = numeroValido(7003);
    const ND = numeroValido(7004);
    const motivo = (rotulo: string, dias: number, tipo: 'intimacao' | 'citacao') => ({
      rotulo,
      data: iso(dias),
      chave: `chave-${rotulo}-${dias}`,
      tipo,
    });
    const pede = (
      rotulo: string,
      dias: number,
      tipo: 'intimacao' | 'citacao',
    ): ProvidenciaSintetica => ({
      situacao: 'pede',
      motivo: motivo(rotulo, dias, tipo),
      cumpridoEm: null,
    });

    let infos: Record<string, Info>;
    let ultimos: Record<string, { data: string; titulo: string }>;

    function cenario(): { grupos: GrupoSintetico[]; sem: SemNovidadeSintetico[] } {
      const gA = grupo(
        NA,
        {
          ...novidade(NA, 'Juntada de petição', { diasDetectada: 1 }),
          data: ultimos[NA]!.data,
        },
        [],
        infos[NA] ?? null,
      );
      const gB = grupo(
        NB,
        {
          ...novidade(NB, 'Citação', { diasDetectada: 2 }),
          data: ultimos[NB]!.data,
        },
        [],
        infos[NB] ?? null,
      );
      const sD = semNovidade(ND, 'Despacho', { diasAto: 3, processo: infos[ND]! });
      const sC = semNovidade(NC, 'Juntada de petição', {
        diasAto: 40,
        processo: infos[NC]!,
      });
      return { grupos: [gA, gB], sem: [sD, sC] };
    }

    function reiniciar(): void {
      infos = {
        [NA]: infoProcesso(
          'TJGO',
          'Procedimento Comum Cível',
          ['Autora Sintética'],
          ['Ré Fictícia'],
          true,
          pede('Ato ordinatório', 12, 'intimacao'),
        ),
        [NB]: infoProcesso(
          'TJSP',
          'Execução Fiscal',
          ['Fazenda Fictícia'],
          ['Devedor Fictício'],
          true,
          pede('Citação', 2, 'citacao'),
        ),
        [NC]: infoProcesso('TJMG', 'Procedimento Comum Cível', [], [], false, {
          situacao: 'venceu',
          motivo: motivo('Intimação antiga', 40, 'intimacao'),
          cumpridoEm: null,
        }),
        [ND]: infoProcesso('TJGO', 'Procedimento Comum Cível', [], [], false, null),
      };
      ultimos = {
        [NA]: { data: iso(1), titulo: 'Juntada de petição' },
        // Em B a linha mostra o PRÓPRIO ato que gera a providência: nada de segunda linha.
        [NB]: { data: infos[NB]!.providencia!.motivo.data, titulo: 'Citação' },
      };
    }

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
      opcoes: { largura?: number; escuro?: boolean; falhaNaMarca?: boolean } = {},
    ): Promise<void> {
      reiniciar();
      dialogos.length = 0;
      ctx = await browser.newContext({
        viewport: { width: opcoes.largura ?? 1280, height: 900 },
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
        const url = new URL(rota.request().url());
        if (url.searchParams.get('limite') === '1') {
          return rota.fulfill({ json: respostaNovidades([]) });
        }
        const c = cenario();
        return rota.fulfill({
          json: respostaNovidades(c.grupos, {
            acompanhados: 4,
            janelaDias: null,
            semNovidade: c.sem,
          }),
        });
      });
      await ctx.route('**/v1/facetas', async (rota) => {
        const real = (await (await rota.fetch()).json()) as Record<string, unknown>;
        await rota.fulfill({
          json: { ...real, tribunais: ['TJGO', 'TJMG', 'TJSP'], classes: [] },
        });
      });
      // O contrato da API de cumprido (tests/http/cumprido.spec.ts), com estado.
      await ctx.route('**/v1/acompanhamentos/*/cumprido', async (rota) => {
        const req = rota.request();
        const numero = req.url().split('/v1/acompanhamentos/')[1]!.split('/')[0]!;
        const dig = (n: string): string => n.replace(/\D/g, '');
        const alvo = [NA, NB, NC, ND].find((n) => dig(n) === dig(numero))!;
        if (opcoes.falhaNaMarca) {
          return rota.fulfill({
            status: 409,
            json: {
              erro: 'ATO_DA_PROVIDENCIA_INVALIDO',
              mensagem: 'Esse ato não está mais no último retrato do processo.',
            },
          });
        }
        const info = infos[alvo]!;
        if (req.method() === 'POST') {
          const antes = info.providencia!;
          infos[alvo] = {
            ...info,
            pedeProvidencia: false,
            motivoProvidencia: null,
            providencia: {
              situacao: 'cumprida',
              motivo: antes.motivo,
              cumpridoEm: new Date().toISOString(),
            },
          };
        } else {
          const antes = info.providencia!;
          infos[alvo] = {
            ...info,
            pedeProvidencia: true,
            motivoProvidencia: '"' + antes.motivo.rotulo + '" nos últimos 10 dias',
            providencia: { situacao: 'pede', motivo: antes.motivo, cumpridoEm: null },
          };
        }
        return rota.fulfill({ json: { processo: infos[alvo] } });
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      page.on('dialog', async (d) => {
        dialogos.push(d.message());
        await d.dismiss();
      });
      await page.goto(amb.url + '/');
      await page.waitForSelector('.nvt-tabela, .nvt-sem-prov');
    }

    const linhas = () => page.locator('.nvt-tabela tr.nvt-linha');
    const numeros = () =>
      page.locator('.nvt-tabela tr.nvt-linha .nvt-num').allTextContents();
    const resumo = () => page.locator('.nvt-resumo').innerText();
    const ao = (n: string) => page.locator(`tr.nvt-linha[data-processo="${n}"]`);

    it('abre só com as intimações/citações pendentes, com o selo do tipo e a segunda linha quando o ato é outro', async () => {
      await abrir();

      expect(await linhas().count()).toBe(2);
      const a = ao(NA);
      expect(await a.locator('.selo.int').textContent()).toBe('Intimação');
      expect(await ao(NB).locator('.selo.int').textContent()).toBe('Citação');

      // A: a linha mostra "Juntada de petição"; a providência vem do "Ato ordinatório".
      const por = ((await a.locator('.nvt-por').textContent()) ?? '').replace(
        /\s+/g,
        ' ',
      );
      expect(por).toMatch(/^Pede providência por: Ato ordinatório · /);
      expect(por).toMatch(/\d{2}\/\d{2}\/\d{4}/);
      // B: é o mesmo ato — nada a mais.
      expect(await ao(NB).locator('.nvt-por').count()).toBe(0);

      // O que ficou de fora é dito: nada de "prazo" no texto novo.
      const texto = await resumo();
      expect(texto).toContain('1 sem marca há mais de 30 dias');
      expect(texto).not.toMatch(/prazo/i);
      expect(texto).not.toContain('marcado');
    });

    it('marcar tira o processo da lista, atualiza a frase, anuncia e leva o foco ao vizinho', async () => {
      await abrir();

      await ao(NA).getByRole('button', { name: 'Marcar como cumprido' }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 1,
      );

      expect(await numeros()).toHaveLength(1);
      const texto = await resumo();
      expect(texto).toContain('1 marcado como cumprido');
      expect(texto).toContain('1 sem marca há mais de 30 dias');
      expect(
        await page.getByRole('button', { name: 'Pedem providência (1)' }).count(),
      ).toBe(1);
      expect(await page.locator('#nvt-live').textContent()).toMatch(
        /Marcado como cumprido\. 1 processo ainda pede providência\./,
      );
      // Foco coerente: o botão de marcar do processo que sobrou.
      const foco = await page.evaluate(() =>
        document.activeElement?.getAttribute('data-foco'),
      );
      expect(foco).toBe(`cumprir-${NB}`);
    });

    it('"Ver" lista os marcados com "Desfazer"; desfazer pede confirmação leve, sem alert/confirm do navegador', async () => {
      await abrir();
      await ao(NA).getByRole('button', { name: 'Marcar como cumprido' }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 1,
      );

      await page.getByRole('button', { name: 'Ver', exact: true }).click();
      expect(await linhas().count()).toBe(1);
      expect(await ao(NA).locator('.selo.cum').textContent()).toBe('cumprido');
      expect(await resumo()).toContain('1 processo marcado como cumprido');

      await ao(NA).getByRole('button', { name: 'Desfazer', exact: true }).click();
      // A confirmação mora na célula: dois botões, e o foco no "Sim".
      const conf = ao(NA).locator('.pvp-conf');
      expect(await conf.count()).toBe(1);
      expect(await conf.getAttribute('role')).toBe('group');
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
        'Sim, desfazer',
      );

      // Cancelar não desfaz nada e devolve o foco ao "Desfazer".
      await conf.getByRole('button', { name: 'Cancelar' }).click();
      expect(await ao(NA).locator('.pvp-conf').count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
        'Desfazer',
      );

      // Esc também cancela.
      await ao(NA).getByRole('button', { name: 'Desfazer', exact: true }).click();
      await page.keyboard.press('Escape');
      expect(await ao(NA).locator('.pvp-conf').count()).toBe(0);

      // Confirmar desfaz; era o último marcado, então volta ao filtro de providência com A de volta.
      await ao(NA).getByRole('button', { name: 'Desfazer', exact: true }).click();
      await ao(NA).getByRole('button', { name: 'Sim, desfazer' }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 2,
      );
      expect(await numeros()).toHaveLength(2);
      expect(await ao(NA).locator('.selo.am').count()).toBe(1);
      expect(await resumo()).not.toContain('marcado');
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute('data-foco')),
      ).toBe(`cumprir-${NA}`);
      expect(dialogos).toEqual([]);
    });

    it('funciona só com o teclado: Tab até o botão e Enter marcam', async () => {
      await abrir();
      const botao = ao(NA).getByRole('button', { name: 'Marcar como cumprido' });
      await botao.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 1,
      );
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
        'Marcar como cumprido',
      );
    });

    it('em "Todas", a linha marcada fica, com o selo "cumprido" e o foco em "Desfazer"', async () => {
      await abrir();
      await page.getByRole('button', { name: /^Todas \(/ }).click();
      expect(await linhas().count()).toBe(4);

      await ao(NA).getByRole('button', { name: 'Marcar como cumprido' }).click();
      await ao(NA).locator('.selo.cum').waitFor();
      expect(await ao(NA).locator('.selo.am').count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
        'Desfazer',
      );
      // A venceu-por-tempo aparece em Todas, dita, sem botão de marcar.
      expect(await ao(NC).locator('.nvt-venceu').textContent()).toContain(
        'sem marca há mais de 30 dias',
      );
    });

    it('falha ao marcar: o processo continua na lista e a tela diz por quê', async () => {
      await abrir({ falhaNaMarca: true });
      await ao(NA).getByRole('button', { name: 'Marcar como cumprido' }).click();
      await page.locator('.nvt-erro[role="alert"]').waitFor();
      expect(await page.locator('.nvt-erro').textContent()).toContain(
        'Esse ato não está mais',
      );
      expect(await linhas().count()).toBe(2);
      expect(
        await ao(NA).getByRole('button', { name: 'Marcar como cumprido' }).isEnabled(),
      ).toBe(true);
    });

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${largura}px, com e sem marcados, em Todas e na lista dos marcados`, async () => {
        await abrir({ largura });
        const medir = (): Promise<{ sw: number; cw: number }> =>
          page.evaluate(() => ({
            sw: document.documentElement.scrollWidth,
            cw: document.documentElement.clientWidth,
          }));
        let m = await medir();
        expect(m.sw).toBeLessThanOrEqual(m.cw);

        await ao(NA).getByRole('button', { name: 'Marcar como cumprido' }).click();
        await page.waitForFunction(
          () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 1,
        );
        m = await medir();
        expect(m.sw).toBeLessThanOrEqual(m.cw);

        await page.getByRole('button', { name: 'Ver', exact: true }).click();
        await ao(NA).getByRole('button', { name: 'Desfazer', exact: true }).click();
        m = await medir();
        expect(m.sw).toBeLessThanOrEqual(m.cw);

        await page.getByRole('button', { name: 'Cancelar' }).click();
        await page
          .getByRole('button', { name: 'Voltar aos que pedem providência' })
          .click();
        await page.getByRole('button', { name: /^Todas \(/ }).click();
        m = await medir();
        expect(m.sw).toBeLessThanOrEqual(m.cw);
      });
    }

    for (const escuro of [false, true]) {
      it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): padrão, depois de marcar, "Ver" e confirmação`, async () => {
        await abrir({ escuro });
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const rodar = async (): Promise<string> => {
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(
              document.querySelector('#conteudo')!,
              {
                rules: { 'color-contrast': { enabled: true } },
              },
            ),
          );
          return r.violations
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
            .join('\n');
        };
        expect(await rodar(), 'padrão').toBe('');

        await ao(NA).getByRole('button', { name: 'Marcar como cumprido' }).click();
        await page.waitForFunction(
          () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 1,
        );
        expect(await rodar(), 'depois de marcar').toBe('');

        await page.getByRole('button', { name: 'Ver', exact: true }).click();
        expect(await rodar(), 'Ver').toBe('');

        await ao(NA).getByRole('button', { name: 'Desfazer', exact: true }).click();
        expect(await rodar(), 'confirmação').toBe('');

        await page.getByRole('button', { name: 'Cancelar' }).click();
        await page
          .getByRole('button', { name: 'Voltar aos que pedem providência' })
          .click();
        await page.getByRole('button', { name: /^Todas \(/ }).click();
        expect(await rodar(), 'Todas').toBe('');
      });
    }
  },
);
