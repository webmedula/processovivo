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
  AtoSintetico,
  GrupoSintetico,
  SemNovidadeSintetico,
} from '../helpers/atualizacoesSinteticas.js';

/*
 * v0.37.6 — a conferência com o Projudi NUM NAVEGADOR: a linha mostra o ato que
 * gera a providência (com a data dele) e o último andamento à parte; "Detectado"
 * vira data absoluta quando está a mais de 7 dias do ato; e a intimação a outro
 * destinatário é dita em voz alta. Servidor e console reais; só /v1/novidades e
 * /v1/facetas recebem dados SINTÉTICOS (a API tem testes próprios).
 */
const sem = CHROMIUM === undefined;
const AGORA = Date.now();
const iso = (diasAtras: number): string => new Date(AGORA - diasAtras * DIA).toISOString();
const dataBr = (i: string): string =>
  new Date(i).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const diaMes = (i: string): string =>
  new Date(i).toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  });

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

const NA = numeroValido(8101); // providência ≠ último andamento; detecção longe do ato
const NB = numeroValido(8102); // o ato da providência é a própria atualização; detecção perto
const NC = numeroValido(8103); // só intimação a OUTRO destinatário
const ND = numeroValido(8104); // intimação com destinatário não confirmado
const NE = numeroValido(8105); // sem novidade, pede providência por ato diferente da última movimentação

const ato = (
  rotulo: string,
  dias: number,
  tipo: AtoSintetico['tipo'],
  paraOUsuario?: AtoSintetico['paraOUsuario'],
): AtoSintetico => ({
  rotulo,
  data: iso(dias),
  chave: `chave-${rotulo}-${dias}`,
  tipo,
  ...(paraOUsuario ? { paraOUsuario } : {}),
});

function cenario(): { grupos: GrupoSintetico[]; sem: SemNovidadeSintetico[] } {
  const atoA = ato('Ato ordinatório', 20, 'intimacao', 'sim');
  const atoB = ato('Citação', 3, 'citacao', 'desconhecido');
  const outro = ato('Intimação', 12, 'intimacao', 'nao');
  const atoD = ato('Ato ordinatório', 5, 'intimacao', 'desconhecido');
  const atoE = ato('Decisão', 6, 'outro', 'desconhecido');
  const gA = grupo(
    NA,
    { ...novidade(NA, 'Despacho', { diasDetectada: 2, diasAto: 28 }), data: iso(28) },
    [],
    infoProcesso('TJGO', 'Procedimento Comum Cível', ['Autora Sintética'], ['Ré Fictícia'], true, {
      situacao: 'pede',
      motivo: atoA,
      cumpridoEm: null,
    }),
  );
  const gB = grupo(
    NB,
    { ...novidade(NB, 'Citação', { diasDetectada: 2, diasAto: 3 }), data: atoB.data },
    [],
    infoProcesso('TJGO', 'Execução Fiscal', ['Fazenda Fictícia'], ['Devedor Fictício'], true, {
      situacao: 'pede',
      motivo: atoB,
      cumpridoEm: null,
    }),
  );
  const gC = grupo(
    NC,
    { ...novidade(NC, 'Juntada de petição', { diasDetectada: 1, diasAto: 1 }) },
    [],
    infoProcesso('TJGO', 'Procedimento Comum Cível', [], [], false, {
      situacao: 'outro',
      motivo: outro,
      cumpridoEm: null,
      outroDestinatario: outro,
    }),
  );
  const gD = grupo(
    ND,
    { ...novidade(ND, 'Ato ordinatório', { diasDetectada: 4, diasAto: 5 }), data: atoD.data },
    [],
    infoProcesso('TJGO', 'Procedimento Comum Cível', [], [], true, {
      situacao: 'pede',
      motivo: atoD,
      cumpridoEm: null,
    }),
  );
  const sE = semNovidade(NE, 'Juntada de petição', {
    diasAto: 2,
    processo: infoProcesso('TJGO', 'Procedimento Comum Cível', [], [], true, {
      situacao: 'pede',
      motivo: atoE,
      cumpridoEm: null,
    }),
  });
  return { grupos: [gA, gB, gC, gD], sem: [sE] };
}

describe.skipIf(sem)(
  'Atualizações — conferência com o Projudi (v0.37.6), no navegador',
  { timeout: 90_000 },
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

    async function abrir(opcoes: { largura?: number; escuro?: boolean } = {}): Promise<void> {
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
          json: respostaNovidades(c.grupos, { acompanhados: 5, janelaDias: null, semNovidade: c.sem }),
        });
      });
      await ctx.route('**/v1/facetas', async (rota) => {
        const real = (await (await rota.fetch()).json()) as Record<string, unknown>;
        await rota.fulfill({ json: { ...real, tribunais: ['TJGO'], classes: [] } });
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      await page.goto(amb.url + '/');
      await page.waitForSelector('.nvt-tabela, .nvt-sem-prov');
    }

    const ao = (n: string) => page.locator(`tr.nvt-linha[data-processo="${n}"]`);
    const norm = (t: string | null): string => (t ?? '').replace(/\s+/g, ' ').trim();
    const todas = async (): Promise<void> => {
      await page.getByRole('button', { name: /^Todas \(/ }).click();
    };

    it('a linha com providência mostra o ATO da providência, com a data dele; o último andamento vai à parte', async () => {
      await abrir();
      const a = ao(NA);
      expect(norm(await a.locator('.nvt-tit').textContent())).toBe('Ato ordinatório Intimação');
      // Data do ato = a do ato que gera a providência, não a do despacho (28 dias atrás).
      expect(norm(await a.locator('td.c-data').textContent())).toBe(dataBr(iso(20)));
      expect(norm(await a.locator('.nvt-ult').textContent())).toBe(
        `Último andamento: Despacho · ${dataBr(iso(28))}`,
      );
      expect(await a.innerText()).not.toContain('Pede providência por');
      // O selo diz se o destinatário está confirmado.
      expect(await a.locator('.selo.int').getAttribute('title')).toContain('Destinatário confirmado');
    });

    it('quando o ato da providência é a própria atualização, não há segunda linha', async () => {
      await abrir();
      const b = ao(NB);
      expect(norm(await b.locator('.nvt-tit').textContent())).toBe('Citação Citação');
      expect(await b.locator('.nvt-ult').count()).toBe(0);
      expect(norm(await b.locator('td.c-data').textContent())).toBe(dataBr(iso(3)));
    });

    it('destinatário não confirmado diz isso no title do selo', async () => {
      await abrir();
      expect(await ao(ND).locator('.selo.int').getAttribute('title')).toContain(
        'Destinatário não confirmado',
      );
    });

    it('"Detectado" vira data absoluta quando está a mais de 7 dias do ato; senão fica relativo', async () => {
      await abrir();
      // A: ato de 20 dias atrás, detectado há 2 dias → 18 dias de distância.
      const a = ao(NA).locator('td.c-det');
      expect(await a.locator('[aria-hidden="true"]').textContent()).toBe(`em ${diaMes(iso(2))}`);
      expect(norm(await a.textContent())).toContain(`detectado em ${diaMes(iso(2))}`);
      const titulo = (await a.locator('span[title]').first().getAttribute('title')) ?? '';
      expect(titulo).toContain(
        'Data do ato é a do tribunal; detectado é quando o Processo Vivo viu pela primeira vez.',
      );
      // A detecção é da atualização (o despacho), e o title diz.
      expect(titulo).toContain('refere-se ao último andamento');
      // B: ato de 3 dias, detectado há 2 → continua "há 2 dias".
      const b = ao(NB).locator('td.c-det');
      expect(await b.locator('[aria-hidden="true"]').textContent()).toBe('há 2 dias');
    });

    it('intimação a outro destinatário: fora de "Pedem providência", dita em voz alta, e visível em "Todas"', async () => {
      await abrir();
      expect(await page.locator('tr.nvt-linha').count()).toBe(4); // A, B, D e E (sem novidade)
      expect(await ao(NC).count()).toBe(0);
      const resumo = norm(await page.locator('.nvt-resumo').innerText());
      expect(resumo).toContain('1 com intimação a outro destinatário');
      expect(resumo).not.toMatch(/prazo/i);

      await todas();
      const c = ao(NC);
      expect(await c.count()).toBe(1);
      expect(norm(await c.locator('.nvt-outro').textContent())).toBe('Intimação a outro destinatário');
    });

    it('"Ver" lista só os de outro destinatário, e "Voltar" retorna ao filtro padrão', async () => {
      await abrir();
      await page.locator('[data-foco="ver-outros"]').click();
      expect(await page.locator('tr.nvt-linha').count()).toBe(1);
      expect(await ao(NC).count()).toBe(1);
      const resumo = norm(await page.locator('.nvt-resumo').innerText());
      expect(resumo).toContain('1 processo com intimação a outro destinatário');
      expect(resumo).toContain('se for de um colega do escritório, confira no processo');
      await page.getByRole('button', { name: 'Voltar aos que pedem providência' }).click();
      expect(await page.locator('tr.nvt-linha').count()).toBe(4);
    });

    it('sem novidade registrada: a linha também é sobre o ato da providência', async () => {
      await abrir();
      const e = ao(NE);
      expect(norm(await e.locator('.nvt-tit').textContent())).toBe('Decisão');
      expect(norm(await e.locator('td.c-data').textContent())).toBe(dataBr(iso(6)));
      expect(norm(await e.locator('.nvt-ult').textContent())).toBe(
        `Último andamento: Juntada de petição · ${dataBr(iso(2))}`,
      );
      expect(norm(await e.locator('.nvt-sem').textContent())).toBe('Sem atualização detectada');
    });

    it('ordenar por "Data do ato" usa a data que a linha mostra', async () => {
      await abrir();
      await page.locator('[data-chave="dataAto"]').click(); // mais recente primeiro
      const numeros = await page.locator('tr.nvt-linha').evaluateAll((trs) =>
        trs.map((t) => (t as HTMLElement).dataset['processo']),
      );
      // Datas exibidas: B (3 dias), D (5), E (6), A (20) — não as dos últimos andamentos.
      expect(numeros).toEqual([NB, ND, NE, NA]);
    });

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${largura}px: padrão, "Todas" e "Ver"`, async () => {
        await abrir({ largura });
        const medir = () =>
          page.evaluate(() => ({
            sw: document.documentElement.scrollWidth,
            cw: document.documentElement.clientWidth,
          }));
        let m = await medir();
        expect(m.sw).toBeLessThanOrEqual(m.cw);
        await todas();
        m = await medir();
        expect(m.sw).toBeLessThanOrEqual(m.cw);
        await page.locator('[data-foco="sit-providencia"]').click();
        await page.locator('[data-foco="ver-outros"]').click();
        m = await medir();
        expect(m.sw).toBeLessThanOrEqual(m.cw);
      });
    }

    for (const escuro of [false, true]) {
      it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): padrão, "Todas" e "Ver"`, async () => {
        await abrir({ escuro });
        await page.addScriptTag({ content: (AxeBuilder as unknown as { source: string }).source });
        const rodar = async (): Promise<string> => {
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(document.querySelector('#conteudo')!, {
              rules: { 'color-contrast': { enabled: true } },
            }),
          );
          return r.violations
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
            .join('\n');
        };
        expect(await rodar(), 'padrão').toBe('');
        await todas();
        expect(await rodar(), 'Todas').toBe('');
        await page.locator('[data-foco="sit-providencia"]').click();
        await page.locator('[data-foco="ver-outros"]').click();
        expect(await rodar(), 'Ver').toBe('');
      });
    }
  },
);
