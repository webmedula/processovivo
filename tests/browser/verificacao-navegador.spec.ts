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
 * v0.49.3 NUM NAVEGADOR: a verificação na tela — "Verificando X de N", "Na fila", "demorando" só sem avanço, o
 * progresso numa região viva discreta e a "última verificação". Servidor e console reais; /v1/sincronizar,
 * /v1/sincronizacao e o campo `verificacao` do painel são simulados com dados SINTÉTICOS. O tempo corre no relógio
 * falso do Playwright: nenhum teste espera tempo real.
 */
const sem = CHROMIUM === undefined;
const NA = numeroValido(9501);
const ULTIMA = '2026-10-20T14:10:00.000Z'; // 11:10 em São Paulo

interface Estado {
  emAndamento: boolean;
  situacao: 'ociosa' | 'na_fila' | 'em_andamento';
  total: number;
  concluidos: number;
  pendentes: number;
  demorando: boolean;
  desde: string | null;
  ultimoProgressoEm: string | null;
}
interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

const OCIOSO: Estado = {
  emAndamento: false,
  situacao: 'ociosa',
  total: 0,
  concluidos: 0,
  pendentes: 0,
  demorando: false,
  desde: null,
  ultimoProgressoEm: null,
};
const andamento = (
  concluidos: number,
  total: number,
  extra: Partial<Estado> = {},
): Estado => ({
  emAndamento: true,
  situacao: 'em_andamento',
  total,
  concluidos,
  pendentes: total - concluidos,
  demorando: false,
  desde: '2026-10-20T14:00:00.000Z',
  ultimoProgressoEm: concluidos ? '2026-10-20T14:05:00.000Z' : null,
  ...extra,
});

describe.skipIf(sem)(
  'Verificação dos processos, no navegador',
  { timeout: 120_000 },
  () => {
    let browser: Browser;
    let amb: Ambiente;
    let ctx: BrowserContext;
    let page: Page;
    let estado: Estado;
    let ultimaEm = ULTIMA;
    let respostaDoPost: Record<string, unknown>;
    const pedidos: string[] = [];

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
      opcoes: {
        largura?: number;
        escuro?: boolean;
        inicial?: Estado;
        relogio?: boolean;
      } = {},
    ): Promise<void> {
      estado = opcoes.inicial ?? OCIOSO;
      ultimaEm = ULTIMA;
      respostaDoPost = { iniciada: true, jaEmAndamento: false, naFila: false };
      pedidos.length = 0;
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
            { acompanhados: 1, janelaDias: null },
          ),
        });
      });
      await ctx.route('**/v1/facetas', async (rota) => {
        const real = (await (await rota.fetch()).json()) as Record<string, unknown>;
        await rota.fulfill({ json: { ...real, tribunais: ['TJGO'], classes: [] } });
      });
      await ctx.route('**/v1/painel', async (rota) => {
        const real = (await (await rota.fetch()).json()) as {
          verificacao: Record<string, unknown>;
        };
        await rota.fulfill({
          json: {
            ...real,
            verificacao: { ...real.verificacao, ultimaEm, naoVerificados: 0, ...estado },
          },
        });
      });
      await ctx.route('**/v1/sincronizacao', (rota) => rota.fulfill({ json: estado }));
      await ctx.route('**/v1/sincronizar', (rota) => {
        pedidos.push(rota.request().method());
        return rota.fulfill({ status: 202, json: respostaDoPost });
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      // Instalado ANTES de abrir: os intervalos que a página cria na abertura (o selo de uma rodada em
      // curso) têm de nascer no relógio falso, senão correm em tempo real e o teste dependeria dele.
      if (opcoes.relogio !== false) await page.clock.install();
      await page.goto(amb.url + '/');
      await page.waitForSelector('#sincronizar');
      await page.waitForSelector('.nvt-linha, .nvt-sem-prov, .vazio');
      if (opcoes.relogio !== false) {
        // Relógio PARADO: o intervalo de consulta (4 s) só anda quando o teste manda.
        await page.clock.pauseAt(new Date(Date.now() + 60_000));
      }
    }

    const botao = () => page.locator('#sincronizar');
    const aviso = () =>
      page.locator('#sincronizar').locator('xpath=../..').locator('.aviso');
    const selo = () => page.locator('#vigia-selo');
    const viva = () => page.locator('.verif-sr[role="status"]');
    const passar = async (ms: number): Promise<void> => {
      await page.clock.runFor(ms);
      // Deixa as respostas simuladas voltarem e a tela pintar. Espera REAL do lado do teste: com o relógio falso, nem
      // `requestAnimationFrame` nem `setTimeout` da página andam sozinhos.
      await new Promise((r) => setTimeout(r, 60));
    };

    it('"na_fila": o botão diz "Na fila", o aviso explica e NÃO diz "Verificação iniciada"', async () => {
      await abrir();
      estado = {
        ...OCIOSO,
        emAndamento: true,
        situacao: 'na_fila',
        desde: '2026-10-20T14:00:00.000Z',
      };
      respostaDoPost = { iniciada: true, jaEmAndamento: false, naFila: true };
      await botao().click();
      await expect.poll(async () => (await botao().innerText()).trim()).toBe('Na fila');
      expect(await aviso().innerText()).toBe(
        'Na fila: sua verificação começa quando a rodada atual terminar.',
      );
      expect(await botao().innerText()).not.toContain('Verificação iniciada');
      expect(pedidos).toEqual(['POST']);
      expect(await botao().isDisabled()).toBe(true);
    });

    it('"em_andamento": "Verificando X de N" e atualiza a cada consulta (4 s)', async () => {
      await abrir();
      estado = andamento(3, 12);
      await botao().click();
      await expect
        .poll(async () => (await botao().innerText()).trim())
        .toBe('Verificando 3 de 12');
      expect(await aviso().innerText()).toContain('Verificando 3 de 12.');
      estado = andamento(4, 12);
      await passar(4000);
      await expect
        .poll(async () => (await botao().innerText()).trim())
        .toBe('Verificando 4 de 12');
      estado = andamento(9, 12);
      await passar(4000);
      await expect
        .poll(async () => (await botao().innerText()).trim())
        .toBe('Verificando 9 de 12');
      expect(await botao().locator('.gira').count()).toBe(1);
    });

    it('rodada longa COM progresso nunca mostra "demorando", mesmo passando de 5 minutos', async () => {
      await abrir();
      estado = andamento(1, 40);
      await botao().click();
      await expect
        .poll(async () => (await botao().innerText()).trim())
        .toBe('Verificando 1 de 40');
      // 8 minutos de relógio, o servidor anda sempre (demorando: false): a tela nunca diz que demorou.
      for (let i = 2; i <= 121; i++) {
        estado = andamento(i, 40 + 100, { demorando: false });
        await passar(4000);
      }
      expect(await botao().innerText()).not.toContain('demorando');
      expect(await aviso().innerText()).not.toContain('sem avançar');
    });

    it('"demorando" só quando o servidor diz que PAROU de avançar: frase sem culpar o tribunal e com a última verificação', async () => {
      await abrir();
      estado = andamento(2, 12);
      await botao().click();
      await expect
        .poll(async () => (await botao().innerText()).trim())
        .toBe('Verificando 2 de 12');
      estado = andamento(2, 12, { demorando: true });
      await passar(4000);
      await expect
        .poll(async () => (await botao().innerText()).trim())
        .toBe('Verificação demorando');
      const texto = await aviso().innerText();
      expect(texto).toContain('A verificação está sem avançar há alguns minutos.');
      expect(texto).toContain('As fontes dos tribunais podem estar lentas.');
      expect(texto).toContain('Última verificação às 11:10.');
      expect(texto).not.toContain('estão lentas');
      // Voltou a andar: o aviso de demora some.
      estado = andamento(3, 12);
      await passar(4000);
      await expect
        .poll(async () => (await botao().innerText()).trim())
        .toBe('Verificando 3 de 12');
      expect(await aviso().innerText()).not.toContain('sem avançar');
    });

    it('ao terminar: a tela se refaz, o botão volta a "Verificar agora" e a "última verificação" é a nova', async () => {
      await abrir();
      estado = andamento(11, 12);
      await botao().click();
      await expect
        .poll(async () => (await botao().innerText()).trim())
        .toBe('Verificando 11 de 12');
      estado = OCIOSO;
      ultimaEm = '2026-10-20T15:30:00.000Z'; // 12:30 em São Paulo
      await passar(4000);
      await expect
        .poll(async () => (await botao().innerText()).trim())
        .toBe('Verificar agora');
      expect(await botao().isDisabled()).toBe(false);
      await expect
        .poll(async () => (await page.locator('.vigia').first().innerText()).trim())
        .toContain('12:30');
    });

    it('abrir o painel com uma rodada em curso: o selo mostra o progresso e o acompanha, sem clicar em nada', async () => {
      await abrir({ inicial: andamento(3, 12) });
      await expect
        .poll(async () => (await selo().innerText()).trim())
        .toBe('Verificando 3 de 12');
      estado = andamento(5, 12);
      await passar(4000);
      await expect
        .poll(async () => (await selo().innerText()).trim())
        .toBe('Verificando 5 de 12');
      expect(pedidos).toEqual([]); // nada foi disparado
    });

    it('selo: "Na fila para verificar" e "demorando" (só sem avanço), com a última verificação', async () => {
      await abrir({ inicial: { ...OCIOSO, emAndamento: true, situacao: 'na_fila' } });
      expect((await selo().innerText()).trim()).toBe('Na fila para verificar');
      await ctx.close();
      await abrir({ inicial: andamento(2, 12, { demorando: true }) });
      const t = (await selo().innerText()).trim();
      expect(t).toContain('Verificação demorando: sem avanço há alguns minutos.');
      expect(t).toContain('Última verificação às 11:10.');
      expect(await selo().getAttribute('class')).toContain('atencao');
    });

    it('região viva: anuncia mudança de situação na hora e o X no máximo uma vez a cada 10 s', async () => {
      await abrir();
      await page.evaluate(() => {
        const w = window as unknown as {
          __anuncios: Array<{ t: number; texto: string }>;
        };
        w.__anuncios = [];
        new MutationObserver(() => {
          const r = document.querySelector('.verif-sr[role="status"]');
          // Qualquer mutação do corpo dispara o observador: só conta quando o TEXTO muda.
          const texto = r?.textContent ?? '';
          const ultimo = w.__anuncios[w.__anuncios.length - 1];
          if (r && texto !== ultimo?.texto) w.__anuncios.push({ t: Date.now(), texto });
        }).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });
      estado = andamento(0, 30);
      await botao().click();
      await expect
        .poll(async () => (await botao().innerText()).trim())
        .toBe('Verificando 0 de 30');
      // 60 s de relógio com o X mudando a CADA consulta (4 s).
      for (let i = 1; i <= 15; i++) {
        estado = andamento(i, 30);
        await passar(4000);
      }
      const anuncios = await page.evaluate(
        () =>
          (window as unknown as { __anuncios: Array<{ t: number; texto: string }> })
            .__anuncios,
      );
      const progresso = anuncios.filter((a) => /^Verificando \d+ de 30\.$/.test(a.texto));
      expect(progresso.length).toBeGreaterThan(1);
      // No máximo uma por 10 s (o primeiro é a mudança de situação, na hora).
      for (let i = 1; i < progresso.length; i++) {
        expect(progresso[i]!.t - progresso[i - 1]!.t).toBeGreaterThanOrEqual(9_900);
      }
      expect(progresso.length).toBeLessThanOrEqual(7); // 60 s / 10 s + o primeiro
      // A região é discreta (fora do fluxo visual) e educada.
      expect(await viva().getAttribute('aria-live')).toBe('polite');
      const caixa = await viva().boundingBox();
      expect(caixa === null || (caixa.width <= 1 && caixa.height <= 1)).toBe(true);
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações com "Na fila" e com "demorando" (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        // O axe usa temporizadores: sem relógio falso aqui.
        await abrir({
          escuro,
          relogio: false,
          inicial: andamento(2, 12, { demorando: true }),
        });
        estado = {
          ...OCIOSO,
          emAndamento: true,
          situacao: 'na_fila',
          desde: '2026-10-20T14:00:00.000Z',
        };
        respostaDoPost = { iniciada: true, jaEmAndamento: false, naFila: true };
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        for (let rodada = 0; rodada < 2; rodada++) {
          if (rodada === 1)
            await botao()
              .click()
              .catch(() => undefined);
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(
              { include: [['.cabeca']] } as unknown as Element,
              { rules: { 'color-contrast': { enabled: true } } },
            ),
          );
          expect(
            r.violations.map(
              (v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).join(' | ')}`,
            ),
          ).toEqual([]);
        }
      });
    }

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${largura}px, com o aviso e o selo longos`, async () => {
        await abrir({ largura, inicial: andamento(2, 12, { demorando: true }) });
        estado = andamento(2, 12, { demorando: true });
        await botao().click();
        await expect
          .poll(async () => (await botao().innerText()).trim())
          .toBe('Verificação demorando');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        ).toBe(false);
      });
    }
  },
);
