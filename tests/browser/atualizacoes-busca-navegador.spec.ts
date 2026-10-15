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
  semNovidade,
} from '../helpers/atualizacoesSinteticas.js';
import type {
  GrupoSintetico,
  SemNovidadeSintetico,
} from '../helpers/atualizacoesSinteticas.js';

/*
 * v0.41.0 — a busca pelo NÚMERO do processo na aba Atualizações, num navegador.
 * O servidor e o console são os reais; /v1/novidades e /v1/facetas recebem uma
 * carteira SINTÉTICA (números com DV válido, inventados) e o dublê do servidor
 * aplica o Período e o Tribunal como o de verdade, inclusive os dois campos
 * novos com os números de quem ficou fora.
 */
const sem = CHROMIUM === undefined;

interface Item {
  numero: string;
  tribunal: 'TJGO' | 'TJSP';
  /** `dentro`: tem atualização nos últimos 15 dias. `sem`: nenhuma novidade registrada. */
  tipo: 'dentro' | 'antigo' | 'sem';
  providencia?: boolean;
  lida?: boolean;
}

const n = (seq: number, trib: 'TJGO' | 'TJSP'): string =>
  numeroValido(seq, trib === 'TJGO' ? '09' : '26');

/* Sequenciais distintos por processo; "090011" casa todo TJGO e "260011" todo TJSP. */
const P1 = n(7100001, 'TJGO'); // dentro, não lida
const P2 = n(7200002, 'TJGO'); // dentro, lida, pede providência
const P3 = n(7300003, 'TJGO'); // dentro, lida
const P4 = n(7400004, 'TJGO'); // atualização antiga
const P5 = n(7500005, 'TJGO'); // nenhuma novidade
const P6 = n(8600006, 'TJSP'); // dentro, lida
const P7 = n(8700007, 'TJSP'); // atualização antiga

const CARTEIRA: Item[] = [
  { numero: P1, tribunal: 'TJGO', tipo: 'dentro', lida: false },
  { numero: P2, tribunal: 'TJGO', tipo: 'dentro', lida: true, providencia: true },
  { numero: P3, tribunal: 'TJGO', tipo: 'dentro', lida: true },
  { numero: P4, tribunal: 'TJGO', tipo: 'antigo', lida: true },
  { numero: P5, tribunal: 'TJGO', tipo: 'sem' },
  { numero: P6, tribunal: 'TJSP', tipo: 'dentro', lida: true },
  { numero: P7, tribunal: 'TJSP', tipo: 'antigo', lida: true },
];

function mascara(d: string): string {
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16, 20)}`;
}

function montar(): {
  grupo: (i: Item) => GrupoSintetico;
  sem: (i: Item) => SemNovidadeSintetico;
} {
  const info = (i: Item) =>
    infoProcesso(
      i.tribunal,
      'Procedimento Comum Cível',
      ['Autora Sintética'],
      ['Ré Fictícia'],
      !!i.providencia,
    );
  return {
    grupo: (i) =>
      grupo(
        i.numero,
        novidade(i.numero, i.providencia ? 'Intimação' : 'Juntada de petição', {
          diasDetectada: i.tipo === 'antigo' ? 40 : 2,
          vista: i.lida ?? true,
          exigeAcao: !!i.providencia,
          conteudo: `Texto sintético do ato de ${i.numero.slice(0, 7)}.`,
        }),
        [],
        info(i),
      ),
    sem: (i) => semNovidade(i.numero, 'Distribuição', { diasAto: 60, processo: info(i) }),
  };
}

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

describe.skipIf(sem)(
  'Atualizações — busca pelo número do processo, no navegador',
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

    async function abrir(
      itens: Item[] = CARTEIRA,
      opcoes: { largura?: number; escuro?: boolean } = {},
    ): Promise<void> {
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
      const m = montar();
      await ctx.route('**/v1/novidades**', async (rota) => {
        const url = new URL(rota.request().url());
        const todos = itens.map((i) => i.numero);
        if (url.searchParams.get('limite') === '1') {
          return rota.fulfill({
            json: respostaNovidades([], { acompanhados: todos.length }),
          });
        }
        const todas = url.searchParams.get('janela') === 'todas';
        const tribunal = url.searchParams.get('tribunal');
        const doTribunal = (i: Item): boolean => !tribunal || i.tribunal === tribunal;
        const comNovidade = itens.filter((i) => i.tipo !== 'sem' && doTribunal(i));
        const grupos = comNovidade
          .filter((i) => todas || i.tipo === 'dentro')
          .map(m.grupo);
        const semNov = itens.filter((i) => i.tipo === 'sem' && doTribunal(i)).map(m.sem);
        const foraDoTribunalEscolhido = itens.filter((i) => !doTribunal(i));
        return rota.fulfill({
          json: respostaNovidades(grupos, {
            acompanhados: itens.length,
            janelaDias: todas ? null : 15,
            semNovidade: semNov,
            processosForaDaJanela: todas
              ? 0
              : itens.filter((i) => doTribunal(i) && i.tipo !== 'dentro').length,
            numerosForaDaJanela: todas
              ? []
              : itens.filter((i) => i.tipo !== 'dentro').map((i) => i.numero),
            numerosEmOutroTribunal: foraDoTribunalEscolhido.map((i) => i.numero),
          }),
        });
      });
      await ctx.route('**/v1/facetas', async (rota) => {
        const real = (await (await rota.fetch()).json()) as Record<string, unknown>;
        await rota.fulfill({
          json: { ...real, tribunais: ['TJGO', 'TJSP'], classes: [] },
        });
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      await page.goto(amb.url + '/');
      await page.waitForSelector('.nvt-tabela, .nvt-sem-prov');
    }

    async function situacao(rotulo: RegExp): Promise<void> {
      await page.getByRole('button', { name: rotulo }).click();
      await page.waitForSelector('.nvt-tabela, .nvt-sem-prov, .vazio');
    }
    const todasAsSituacoes = () => situacao(/^Todas \(/);

    const campo = () => page.locator('#nvt-busca');
    const linhas = () => page.locator('.nvt-tabela tr.nvt-linha');
    const numeros = async (): Promise<string[]> =>
      await page
        .locator('.nvt-tabela tr.nvt-linha')
        .evaluateAll((l) => l.map((x) => x.getAttribute('data-processo') ?? ''));
    const aviso = () => page.locator('.nvt-busca-aviso');
    const live = () => page.locator('#nvt-live');
    /** Espera passar o tempo da busca (200 ms) e o redesenho. */
    async function digitar(texto: string): Promise<void> {
      await campo().click();
      await campo().fill('');
      await page.keyboard.type(texto, { delay: 15 });
      await page.waitForTimeout(450);
    }

    /* ------------------------------------------------------------ o campo */

    it('o campo tem rótulo visível ligado a ele, placeholder, type=search, inputmode numérico e autocomplete desligado', async () => {
      await abrir();
      const c = campo();
      expect(await page.locator('label[for="nvt-busca"]').textContent()).toBe(
        'Número do processo',
      );
      expect(await page.locator('label[for="nvt-busca"]').isVisible()).toBe(true);
      expect(await c.getAttribute('type')).toBe('search');
      expect(await c.getAttribute('inputmode')).toBe('numeric');
      expect(await c.getAttribute('autocomplete')).toBe('off');
      expect(await c.getAttribute('placeholder')).toBe('Digite parte do número');
      // Fica no bloco de filtros, antes do Período.
      const ordem = await page
        .locator('.nvt-filtros > *, .nvt-barra > *')
        .evaluateAll((e) => e.map((x) => x.textContent?.slice(0, 20) ?? ''));
      expect(ordem[0]).toContain('Número do processo');
      expect(ordem[1]).toContain('Período');
      expect(await page.locator('.nvt-filtros').count()).toBe(1);
    });

    it('digitar filtra a tabela depois de uma espera curta, e o número é só dígitos', async () => {
      await abrir();
      await todasAsSituacoes();
      expect((await numeros()).length).toBe(7);
      await campo().click();
      await page.keyboard.type('7200002');
      // Antes da espera de 200 ms a tela ainda não foi redesenhada.
      expect((await numeros()).length).toBe(7);
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 1,
      );
      expect(await numeros()).toEqual([P2]);
      expect(await aviso().first().textContent()).toContain('1 processo encontrado');
    });

    it('termo com menos de 4 dígitos não filtra nem avisa nada', async () => {
      await abrir();
      await todasAsSituacoes();
      await digitar('720');
      expect((await numeros()).length).toBe(7);
      expect(await aviso().count()).toBe(0);
      expect((await live().textContent()) ?? '').not.toContain('encontrado');
    });

    it('colar um número formatado acha o processo', async () => {
      await abrir();
      await todasAsSituacoes();
      await campo().click();
      await page.keyboard.insertText(mascara(P3));
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 1,
      );
      expect(await numeros()).toEqual([P3]);
      // O campo guarda o que foi colado, como a pessoa colou.
      expect(await campo().inputValue()).toBe(mascara(P3));
    });

    it('trecho do começo (sequencial) e do fim (origem) acham por qualquer posição', async () => {
      await abrir();
      await todasAsSituacoes();
      await digitar('7400004');
      expect(await numeros()).toEqual([P4]);
      await digitar('260011');
      expect((await numeros()).sort()).toEqual([P6, P7].sort());
    });

    it('o foco e o cursor ficam no campo enquanto digita, mesmo digitando no meio; o campo não é refeito', async () => {
      await abrir();
      await todasAsSituacoes();
      await page.evaluate(() => {
        (document.getElementById('nvt-busca') as unknown as { __marca: number }).__marca =
          42;
      });
      await campo().click();
      await page.keyboard.type('7100', { delay: 40 });
      await page.waitForTimeout(450);
      // Cursor no meio: o dígito entra ali e o cursor fica logo depois dele.
      await campo().evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 2));
      await page.keyboard.type('9', { delay: 40 });
      await page.waitForTimeout(450);
      const estado = await page.evaluate(() => {
        const el = document.getElementById('nvt-busca') as HTMLInputElement & {
          __marca?: number;
        };
        return {
          ativo: document.activeElement === el,
          valor: el.value,
          cursor: el.selectionStart,
          marca: el.__marca,
        };
      });
      expect(estado).toEqual({ ativo: true, valor: '71900', cursor: 3, marca: 42 });
    });

    it('Limpar aparece com termo, limpa, volta o foco ao campo e restaura a lista', async () => {
      await abrir();
      await todasAsSituacoes();
      expect(await page.locator('.nvt-busca-limpar').isVisible()).toBe(false);
      await digitar('7200002');
      expect(await page.locator('.nvt-busca-limpar').isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Limpar', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 7,
      );
      expect(await campo().inputValue()).toBe('');
      expect(await page.locator('.nvt-busca-limpar').isVisible()).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('nvt-busca');
      expect(await aviso().count()).toBe(0);
    });

    it('Esc dentro do campo também limpa', async () => {
      await abrir();
      await todasAsSituacoes();
      await digitar('7200002');
      expect((await numeros()).length).toBe(1);
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 7,
      );
      expect(await campo().inputValue()).toBe('');
    });

    it('a busca não fica guardada: recarregar a página zera o campo e nada vai para o armazenamento', async () => {
      await abrir();
      await todasAsSituacoes();
      await digitar('7200002');
      const guardado = await page.evaluate(() =>
        JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
      );
      expect(guardado).not.toContain('7200002');
      await page.reload();
      await page.waitForSelector('.nvt-tabela, .nvt-sem-prov');
      expect(await campo().inputValue()).toBe('');
    });

    it('mudar o termo volta para a página 1', async () => {
      const muitos: Item[] = Array.from({ length: 30 }, (_, i) => ({
        numero: n(6000100 + i, 'TJGO'),
        tribunal: 'TJGO' as const,
        tipo: 'dentro' as const,
        lida: true,
      }));
      await abrir(muitos);
      await todasAsSituacoes();
      await page.locator('select[data-sel="porpagina"]').selectOption('10');
      await page.getByRole('button', { name: 'Próxima página' }).click();
      expect(await page.locator('.nvt-pagina').textContent()).toBe('Página 2 de 3');
      await digitar('60001');
      expect(await page.locator('.nvt-pagina').textContent()).toBe('Página 1 de 3');
    });

    it('anuncia a contagem na região aria-live só depois da espera, não a cada tecla', async () => {
      await abrir();
      await todasAsSituacoes();
      await page.evaluate(() => {
        const live = document.getElementById('nvt-live')!;
        (window as unknown as { __anuncios: string[] }).__anuncios = [];
        new MutationObserver(() => {
          (window as unknown as { __anuncios: string[] }).__anuncios.push(
            live.textContent ?? '',
          );
        }).observe(live, { childList: true, characterData: true, subtree: true });
      });
      await campo().click();
      await page.keyboard.type('7200002', { delay: 20 });
      await page.waitForTimeout(500);
      const anuncios = await page.evaluate(
        () => (window as unknown as { __anuncios: string[] }).__anuncios,
      );
      expect(anuncios.filter((a) => a !== '')).toEqual(['1 processo encontrado']);
      expect(await live().getAttribute('aria-live')).toBe('polite');
    });

    it('o termo digitado nunca entra no HTML da página como marcação', async () => {
      await abrir();
      await todasAsSituacoes();
      await digitar('<img src=x onerror=alert(1)>');
      expect(await page.locator('#conteudo img[src="x"]').count()).toBe(0);
      expect(await page.locator('#conteudo').innerHTML()).not.toContain('onerror');
    });

    /* ------------------------------------------------- respeita os filtros e diz o que está fora */

    it('respeita a Situação: com "Pedem providência" só entra quem pede, e o resto vem na frase de "outra situação"', async () => {
      await abrir();
      // Abre no padrão (Pedem providência), Período desligado, todos os tribunais.
      await digitar('090011');
      expect(await numeros()).toEqual([P2]);
      const texto = (await aviso().first().textContent()) ?? '';
      expect(texto).toContain('1 processo encontrado');
      expect(texto).toContain('4 processos com esse número em outra situação');
      expect(texto).not.toContain('fora dos últimos');
      expect(texto).not.toContain('outro tribunal');
    });

    it('"Ver" de outra situação passa para Todas e mantém a busca', async () => {
      await abrir();
      await digitar('090011');
      await aviso().first().getByRole('button', { name: 'Ver', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 5,
      );
      expect((await numeros()).sort()).toEqual([P1, P2, P3, P4, P5].sort());
      expect(await campo().inputValue()).toBe('090011');
      expect(
        await page
          .getByRole('button', { name: /^Todas \(/ })
          .getAttribute('aria-pressed'),
      ).toBe('true');
      expect(await page.locator('.nvt-busca-aviso').first().textContent()).not.toContain(
        'outra situação',
      );
    });

    it('fora do Período: a frase usa os dias do servidor e o "Ver" desliga o Período mantendo a busca', async () => {
      await abrir();
      await todasAsSituacoes();
      await page.getByRole('button', { name: 'Últimos 15 dias' }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-janela="padrao"]')
            ?.getAttribute('aria-pressed') === 'true',
      );
      await digitar('090011');
      expect((await numeros()).sort()).toEqual([P1, P2, P3].sort());
      const texto = (await aviso().first().textContent()) ?? '';
      expect(texto).toContain('3 processos encontrados');
      expect(texto).toContain('2 fora dos últimos 15 dias');
      await aviso().first().getByRole('button', { name: 'Ver', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 5,
      );
      expect(await campo().inputValue()).toBe('090011');
      expect(
        await page.locator('[data-janela="todas"]').getAttribute('aria-pressed'),
      ).toBe('true');
    });

    it('fora do Tribunal: "Ver" volta a "Todos os tribunais" mantendo a busca', async () => {
      await abrir();
      await todasAsSituacoes();
      await page.locator('#nvt-trib').selectOption('TJSP');
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 2,
      );
      await digitar('7400004');
      // A tabela esvaziou: o vazio usa a frase do tribunal, e não "Nenhum processo".
      expect(await linhas().count()).toBe(0);
      const bloco = (await aviso().first().textContent()) ?? '';
      expect(bloco).toContain('1 em outro tribunal');
      expect(bloco).not.toContain('Nenhum processo');
      await aviso().first().getByRole('button', { name: 'Ver', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 1,
      );
      expect(await numeros()).toEqual([P4]);
      expect(await page.locator('#nvt-trib').inputValue()).toBe('');
      expect(await campo().inputValue()).toBe('7400004');
    });

    it('vazio com casamento fora mostra as frases e nunca "Nenhum processo"', async () => {
      await abrir();
      // Padrão (Pedem providência): P3 existe, mas em outra situação.
      await digitar('7300003');
      expect(await linhas().count()).toBe(0);
      const t = await page.locator('#conteudo').innerText();
      expect(t).toContain('1 processo com esse número em outra situação');
      expect(t).not.toContain('Nenhum processo');
      expect(await page.locator('table').count()).toBe(0);
      expect((await live().textContent()) ?? '').toContain(
        'Nenhum resultado nos filtros atuais',
      );
    });

    it('número que não existe em lugar nenhum: frase própria, sem "Ver"', async () => {
      await abrir();
      await digitar('9999999');
      const bloco = aviso().first();
      expect(await bloco.textContent()).toBe(
        'Nenhum processo acompanhado com esse número.',
      );
      expect(await bloco.getByRole('button').count()).toBe(0);
      expect((await live().textContent()) ?? '').toBe(
        'Nenhum processo acompanhado com esse número',
      );
    });

    it('processo fora por dois motivos (Período e Tribunal) conta uma vez, no Período; depois do "Ver" passa para o Tribunal', async () => {
      await abrir();
      await todasAsSituacoes();
      await page.locator('#nvt-trib').selectOption('TJSP');
      await page.waitForFunction(
        () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 2,
      );
      await page.getByRole('button', { name: 'Últimos 15 dias' }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-janela="padrao"]')
            ?.getAttribute('aria-pressed') === 'true',
      );
      await digitar('090011');
      const texto = (await page.locator('#conteudo').innerText()).replace(/\s+/g, ' ');
      // TJGO: P1, P2, P3 estão no período, mas em outro tribunal; P4 e P5 estão fora dos dois.
      expect(texto).toContain('2 fora dos últimos 15 dias');
      expect(texto).toContain('3 em outro tribunal');
      expect(texto).not.toContain('5 em outro tribunal');
      await aviso()
        .first()
        .getByRole('button', { name: 'Ver', exact: true })
        .first()
        .click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-janela="todas"]')
            ?.getAttribute('aria-pressed') === 'true',
      );
      await page.waitForSelector('.nvt-busca-aviso');
      const depois = (await page.locator('#conteudo').innerText()).replace(/\s+/g, ' ');
      expect(depois).toContain('5 em outro tribunal');
      expect(depois).not.toContain('fora dos últimos');
    });

    /* ---------------------------------------------------- layout, temas e acessibilidade */

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${largura}px, com a busca e os avisos na tela`, async () => {
        await abrir(CARTEIRA, { largura });
        await digitar('090011');
        expect(await aviso().count()).toBeGreaterThan(0);
        await page.getByRole('button', { name: 'Últimos 15 dias' }).click();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-janela="padrao"]')
              ?.getAttribute('aria-pressed') === 'true',
        );
        await page.locator('#nvt-trib').selectOption('TJSP');
        await page.waitForSelector('.nvt-busca-aviso');
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
          campo: document.getElementById('nvt-busca')!.getBoundingClientRect().right,
        }));
        expect(m.sw).toBeLessThanOrEqual(m.cw);
        expect(m.campo).toBeLessThanOrEqual(m.cw);
      });
    }

    for (const escuro of [false, true]) {
      for (const largura of [1280, 390]) {
        for (const estado of [
          'com resultado e frases',
          'vazio com frases',
          'inexistente',
        ]) {
          it(`axe sem violações, tema ${escuro ? 'escuro' : 'claro'}, ${largura}px, ${estado}`, async () => {
            await abrir(CARTEIRA, { largura, escuro });
            if (estado === 'com resultado e frases') await digitar('090011');
            else if (estado === 'vazio com frases') await digitar('7300003');
            else await digitar('9999999');
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
                  (v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).join(' | ')}`,
                )
                .join('\n'),
            ).toBe('');
          });
        }
      }
    }
  },
);
