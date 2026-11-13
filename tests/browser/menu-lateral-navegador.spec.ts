/// <reference lib="dom" />
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROCESSO_TJGO } from '../helpers/leitor.js';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';
import { esperarConsolePronto } from './console.js';

/*
 * Menu lateral e topo da Pasta digital (v0.68.0), num Chromium de verdade contra o servidor real e um tribunal
 * falso. Peças, atos e números são sintéticos, como em todo o repositório.
 *
 * - Pasta aberta: o menu não está no layout em largura nenhuma; o ☰ o abre como gaveta.
 * - Fora da Pasta: completo de 1280 px para cima, ícones abaixo disso, gaveta de 900 px para baixo.
 * - Topo da Pasta: aviso em uma linha, com o texto completo em "Detalhes"; tipos em uma linha; divisor.
 *
 * Capturas: com PV_CAPTURAS=<pasta> o teste da matriz grava as telas ali (dados fictícios).
 */
const sem = CHROMIUM === undefined;
const CAPTURAS = process.env['PV_CAPTURAS'] ?? '';
const LARGURAS = [1920, 1366, 1280, 1024, 768, 390] as const;

interface Console_ {
  __pv?: { abrir(numero: string): void };
}
interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

describe.skipIf(sem)(
  'Menu lateral e topo da Pasta — no navegador',
  { timeout: 90_000 },
  () => {
    let browser: Browser;
    let amb: Ambiente;
    let ctx: BrowserContext;
    let page: Page;
    let erros: string[];

    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath: CHROMIUM as string,
        args: ['--no-sandbox'],
      });
      if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(async () => {
      await ctx?.close();
      await amb?.encerrar();
    });

    async function abrirConsole(
      w: number,
      h: number,
      o: {
        escuro?: boolean;
        semMovimento?: boolean;
        armazenamentoFalha?: boolean;
        extras?: number;
      } = {},
    ): Promise<void> {
      amb = await iniciar({ pecasExtras: o.extras ?? 30, atosSemPeca: true });
      ctx = await browser.newContext({
        viewport: { width: w, height: h },
        colorScheme: o.escuro ? 'dark' : 'light',
        reducedMotion: o.semMovimento ? 'reduce' : 'no-preference',
        deviceScaleFactor: CAPTURAS ? 2 : 1,
      });
      await ctx.addInitScript(
        ([c, falha]) => {
          try {
            localStorage.setItem('processovivo.chave', c as string);
          } catch {
            /* sem armazenamento */
          }
          if (falha) {
            // Só as preferências de layout falham: a chave do teste continua entrando.
            const layout = (k: string) =>
              k === 'processovivo.menu' || k === 'processovivo.pasta.lista';
            const ler = Storage.prototype.getItem;
            const gravar = Storage.prototype.setItem;
            Storage.prototype.getItem = function (k: string) {
              if (layout(k)) throw new Error('armazenamento indisponível');
              return ler.call(this, k);
            };
            Storage.prototype.setItem = function (k: string, v: string) {
              if (layout(k)) throw new Error('armazenamento indisponível');
              gravar.call(this, k, v);
            };
          }
        },
        [CHAVE, o.armazenamentoFalha === true] as const,
      );
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      erros = [];
      page.on('pageerror', (e) => erros.push(String(e)));
      await page.goto(amb.url + '/');
      await esperarConsolePronto(page);
    }
    async function abrirPasta(): Promise<void> {
      await page.evaluate(
        (n) => (window as unknown as Console_).__pv!.abrir(n),
        PROCESSO_TJGO,
      );
      await page.waitForSelector('#pasta-abrir');
      await page.click('#pasta-abrir');
      await page.waitForSelector('#pasta .linha');
    }
    /**
     * O axe sobre as regiões que existem na tela (menu, barra de cima, conteúdo e Pasta), como os outros testes de
     * navegador: a página inteira acusa a falta de um h1, que não é desta entrega.
     */
    async function axe(seletor?: string): Promise<string[]> {
      await page.mouse.move(0, 0);
      if (!(await page.evaluate(() => 'axe' in window))) {
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
      }
      return page.evaluate(async (s) => {
        const achados: string[] = [];
        for (const q of s ? [s] : ['#lateral', '#menu-topo', '#conteudo', '#pasta']) {
          const raiz = document.querySelector(q) as HTMLElement | null;
          if (!raiz || raiz.getClientRects().length === 0) continue;
          const res = await (window as unknown as AxeNaPagina).axe.run(raiz, {});
          for (const v of res.violations)
            achados.push(
              `${q} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
            );
        }
        return achados;
      }, seletor);
    }
    const rolaH = (): Promise<boolean> =>
      page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
    const modo = (): Promise<string> =>
      page.evaluate(() => {
        const c = document.documentElement.classList;
        return c.contains('menu-gaveta')
          ? 'gaveta'
          : c.contains('menu-icones')
            ? 'icones'
            : 'completo';
      });
    const larguraDoMenu = (): Promise<number> =>
      page.evaluate(() => {
        const l = document.getElementById('lateral')!;
        const r = l.getBoundingClientRect();
        // Fora da tela (gaveta fechada) não ocupa largura nenhuma do layout.
        return getComputedStyle(l).position === 'fixed' ? 0 : Math.round(r.width);
      });
    /** A gaveta terminou de abrir (ou de fechar): a animação é curta, espera-se o estado, não o relógio. */
    async function gaveta(aberta: boolean): Promise<void> {
      await page.waitForFunction((a) => {
        const l = document.getElementById('lateral')!;
        const r = l.getBoundingClientRect();
        return a
          ? Math.round(r.left) === 0 && getComputedStyle(l).visibility === 'visible'
          : getComputedStyle(l).visibility === 'hidden';
      }, aberta);
    }
    async function captura(nome: string): Promise<void> {
      if (CAPTURAS) await page.screenshot({ path: join(CAPTURAS, nome + '.png') });
    }

    for (const w of LARGURAS) {
      for (const escuro of [false, true]) {
        const tema = escuro ? 'escuro' : 'claro';
        it(`${w}px, tema ${tema}: fora da Pasta e na Pasta (gaveta fechada e aberta), sem rolagem horizontal e axe limpo`, async () => {
          await abrirConsole(w, w >= 1024 ? 800 : 900, { escuro });
          const esperado = w <= 900 ? 'gaveta' : w < 1280 ? 'icones' : 'completo';
          expect(await modo()).toBe(esperado);
          expect(await larguraDoMenu()).toBe(
            esperado === 'gaveta' ? 0 : esperado === 'icones' ? 60 : 256,
          );
          expect(await page.locator('#menu-topo').isVisible()).toBe(
            esperado === 'gaveta',
          );
          expect(await rolaH()).toBe(false);
          expect(await axe()).toEqual([]);
          await captura(`fora-${w}-${tema}`);

          await abrirPasta();
          // O menu não está no layout: a Pasta começa na borda esquerda e ocupa a janela.
          expect(await modo()).toBe('gaveta');
          expect(await larguraDoMenu()).toBe(0);
          const caixa = await page.locator('#pasta').boundingBox();
          expect(Math.round(caixa!.x)).toBe(0);
          expect(Math.round(caixa!.width)).toBe(w);
          await gaveta(false);
          expect(await page.locator('#lateral').isVisible()).toBe(false);
          expect(await page.locator('#menu-topo').isVisible()).toBe(false);
          expect(await rolaH()).toBe(false);
          expect(await axe()).toEqual([]);
          await captura(`pasta-${w}-${tema}-fechada`);

          const hamb = page.locator('#pasta-menu');
          expect(await hamb.getAttribute('aria-label')).toBe('Menu');
          expect(await hamb.getAttribute('aria-controls')).toBe('lateral');
          expect(await hamb.getAttribute('aria-expanded')).toBe('false');
          await hamb.click();
          await gaveta(true);
          expect(await hamb.getAttribute('aria-expanded')).toBe('true');
          expect(await page.evaluate(() => document.activeElement?.id)).toBe(
            'menu-fechar',
          );
          expect(await rolaH()).toBe(false);
          expect((await axe('#lateral')).join('\n')).toBe('');
          await captura(`pasta-${w}-${tema}-aberta`);
          await page.keyboard.press('Escape');
          await gaveta(false);
          expect(await page.evaluate(() => document.activeElement?.id)).toBe(
            'pasta-menu',
          );
          // O Esc da gaveta não fechou a Pasta.
          expect(await page.locator('#pasta').count()).toBe(1);
          expect(erros).toEqual([]);
        });
      }
    }

    it('gaveta na Pasta: ☰ à esquerda de "Fechar a pasta", foco preso, fundo e botão fecham, a bolha de novidades aparece no ☰', async () => {
      await abrirConsole(1366, 768);
      await abrirPasta();
      const ordem = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#pasta .topo > *'))
          .slice(0, 2)
          .map((e) => e.id),
      );
      expect(ordem).toEqual(['pasta-menu', 'pasta-fechar']);
      expect((await page.textContent('#pasta-fechar'))?.trim()).toBe('← Fechar a pasta');

      // Sem novidade, sem bolha; com o contador da lateral, a mesma contagem no ☰.
      expect(await page.locator('#pasta-menu .menu-ponto').isVisible()).toBe(false);
      await page.evaluate(() => {
        const b = document.getElementById('bolha')!;
        b.textContent = '99+';
        b.classList.remove('oculto');
      });
      await page.waitForFunction(
        () => document.querySelector('#pasta-menu .menu-ponto')?.textContent === '99+',
      );
      expect(await page.locator('#pasta-menu .menu-ponto').isVisible()).toBe(true);

      await page.click('#pasta-menu');
      await gaveta(true);
      expect(await page.getAttribute('#lateral', 'role')).toBe('dialog');
      // Tab não sai da gaveta: do primeiro, para trás, cai no último; do último, para a frente, no primeiro.
      await page.keyboard.press('Shift+Tab');
      const ultimo = await page.evaluate(
        () => document.activeElement?.closest('#lateral') !== null,
      );
      expect(ultimo).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).not.toBe(
        'menu-fechar',
      );
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('menu-fechar');
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        expect(
          await page.evaluate(() => document.activeElement?.closest('#lateral') !== null),
        ).toBe(true);
      }
      // Versão e "estado das fontes" continuam no fim da gaveta.
      expect(await page.locator('#lateral .versao a').isVisible()).toBe(true);
      expect(await page.textContent('#lateral .versao')).toMatch(
        /^v\d+\.\d+\.\d+ · estado das fontes$/,
      );

      // Clique no fundo fecha e devolve o foco ao ☰.
      await page.mouse.click(1100, 400);
      await gaveta(false);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pasta-menu');
      // Botão de fechar, dentro da gaveta.
      await page.click('#pasta-menu');
      await gaveta(true);
      await page.click('#menu-fechar');
      await gaveta(false);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pasta-menu');
      expect(await page.locator('#pasta').count()).toBe(1);
      expect(erros).toEqual([]);
    });

    it('escolher um item na gaveta sai da Pasta e vai para a tela escolhida', async () => {
      await abrirConsole(1366, 768);
      await abrirPasta();
      await page.click('#pasta-menu');
      await gaveta(true);
      await page.click('#nav-processos');
      await page.waitForFunction(() => location.hash === '#/processos');
      expect(await page.locator('#pasta').count()).toBe(0);
      expect(await page.getAttribute('#nav-processos', 'class')).toContain('ativo');
      // Fora da Pasta, em 1366 px, o menu volta a ser o completo, no layout.
      expect(await modo()).toBe('completo');
      expect(await larguraDoMenu()).toBe(256);
      expect(
        await page.evaluate(() =>
          document.documentElement.classList.contains('menu-aberto'),
        ),
      ).toBe(false);
      expect(erros).toEqual([]);
    });

    it('fora da Pasta: ícones em 1024 px e completo em 1366 px; expandir e recolher persiste ao recarregar', async () => {
      await abrirConsole(1024, 768);
      expect(await modo()).toBe('icones');
      const alt = page.locator('#menu-alternar');
      expect(await alt.getAttribute('aria-label')).toBe('Expandir menu');
      expect(await alt.getAttribute('aria-expanded')).toBe('false');
      await alt.click();
      expect(await modo()).toBe('completo');
      expect(await larguraDoMenu()).toBe(256);
      expect(await alt.getAttribute('aria-label')).toBe('Recolher menu');
      expect(await rolaH()).toBe(false);
      await page.reload();
      await esperarConsolePronto(page);
      expect(await modo()).toBe('completo');
      await page.click('#menu-alternar');
      expect(await modo()).toBe('icones');

      // Em janela larga o padrão é o completo, e a escolha de recolher também persiste.
      await page.evaluate(() => localStorage.removeItem('processovivo.menu'));
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.reload();
      await esperarConsolePronto(page);
      await page.waitForFunction(
        () => !document.documentElement.classList.contains('menu-icones'),
      );
      expect(await larguraDoMenu()).toBe(256);
      await page.click('#menu-alternar');
      expect(await larguraDoMenu()).toBe(60);
      await page.reload();
      await esperarConsolePronto(page);
      expect(await modo()).toBe('icones');
      expect(erros).toEqual([]);
    });

    it('com o armazenamento do navegador falhando, a escolha vale na sessão e o padrão da largura volta ao recarregar, sem erro', async () => {
      await abrirConsole(1024, 768, { armazenamentoFalha: true });
      expect(await modo()).toBe('icones');
      await page.click('#menu-alternar');
      expect(await modo()).toBe('completo');
      await page.reload();
      await esperarConsolePronto(page);
      expect(await modo()).toBe('icones');
      expect(erros).toEqual([]);
    });

    it('barra de ícones: nome acessível, dica no mouse e no foco, contador sobre o ícone, item ativo, versão e "estado das fontes" ao alcance', async () => {
      await abrirConsole(1024, 768);
      const nomes = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#lateral .nav button'))
          .filter((b) => b.getClientRects().length > 0)
          .map((b) => (b.querySelector('span')?.textContent ?? '').trim()),
      );
      expect(nomes.slice(0, 7)).toEqual([
        'Atualizações',
        'Meus processos',
        'Calendário',
        'Custos',
        'Buscar',
        'Vigilância',
        'Meus acessos',
      ]);
      // O rótulo está no DOM (leitor de tela) e não ocupa lugar na barra.
      const rotulo = await page.locator('#nav-calendario span').first().boundingBox();
      expect(rotulo!.width).toBeLessThanOrEqual(1);

      const dica = page.locator('#menu-dica');
      expect(await dica.isVisible()).toBe(false);
      await page.hover('#nav-calendario');
      expect(await dica.isVisible()).toBe(true);
      expect(await dica.textContent()).toBe('Calendário');
      expect(await dica.getAttribute('role')).toBe('tooltip');
      // A dica fica à direita da barra, dentro da janela.
      const cd = await dica.boundingBox();
      expect(cd!.x).toBeGreaterThanOrEqual(60);
      expect(cd!.x + cd!.width).toBeLessThanOrEqual(1024);
      await page.mouse.move(600, 500);
      expect(await dica.isVisible()).toBe(false);

      await page.focus('#nav-custos');
      expect(await dica.isVisible()).toBe(true);
      expect(await dica.textContent()).toBe('Custos');
      expect(await page.getAttribute('#nav-custos', 'aria-describedby')).toBe(
        'menu-dica',
      );
      // Esc fecha a dica sem tirar o foco.
      await page.keyboard.press('Escape');
      expect(await dica.isVisible()).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('nav-custos');

      // O "46" de Meus processos sai da barra e aparece na dica; a bolha fica sobre o ícone.
      await page.evaluate(() => {
        document.getElementById('cont-processos')!.textContent = '46';
        const b = document.getElementById('bolha')!;
        b.textContent = '99+';
        b.classList.remove('oculto');
      });
      expect(await page.locator('#cont-processos').isVisible()).toBe(false);
      await page.focus('#nav-processos');
      expect(await dica.textContent()).toBe('Meus processos · 46');
      await page.focus('#nav-novidades');
      expect(await dica.textContent()).toBe('Atualizações · 99+ não lidas');
      const bolha = await page.locator('#bolha').boundingBox();
      const botao = await page.locator('#nav-novidades').boundingBox();
      expect(bolha!.x).toBeGreaterThanOrEqual(botao!.x);
      expect(bolha!.x + bolha!.width).toBeLessThanOrEqual(60);
      expect(bolha!.y).toBeLessThan(botao!.y + botao!.height / 2);

      // Item ativo destacado; tema e sair por ícone; versão e fontes ao alcance.
      expect(await page.getAttribute('#nav-novidades', 'class')).toContain('ativo');
      expect(await page.locator('#tema').isVisible()).toBe(true);
      expect(await page.locator('#sair').isVisible()).toBe(true);
      expect(await page.locator('#usuario-iniciais').isVisible()).toBe(true);
      const fontes = page.locator('#lateral .versao a');
      expect(await fontes.isVisible()).toBe(true);
      expect(await fontes.getAttribute('href')).toBe('/ready');
      await fontes.focus();
      expect(await dica.textContent()).toMatch(/^v\d+\.\d+\.\d+ · estado das fontes$/);
      expect(await axe()).toEqual([]);
      expect(erros).toEqual([]);
    });

    it('celular (390 px), fora da Pasta: o ☰ da barra de cima abre a gaveta e o item escolhido navega', async () => {
      await abrirConsole(390, 844);
      expect(await page.locator('#menu-topo').isVisible()).toBe(true);
      expect(await page.locator('#lateral').isVisible()).toBe(false);
      await page.click('#menu-abrir');
      await gaveta(true);
      expect(await page.getAttribute('#menu-abrir', 'aria-expanded')).toBe('true');
      // Na gaveta o menu é o completo: os nomes por extenso.
      expect(await page.locator('#nav-calendario span').first().isVisible()).toBe(true);
      await page.click('#nav-calendario');
      await page.waitForFunction(() => location.hash === '#/calendario');
      await gaveta(false);
      expect(await rolaH()).toBe(false);
      expect(erros).toEqual([]);
    });

    it('prefers-reduced-motion: a gaveta abre sem animação', async () => {
      await abrirConsole(1366, 768, { semMovimento: true });
      await abrirPasta();
      const duracao = () =>
        page.evaluate(() => [
          getComputedStyle(document.getElementById('lateral')!).transitionDuration,
          getComputedStyle(document.getElementById('menu-fundo')!).transitionDuration,
        ]);
      expect((await duracao()).join()).toMatch(/^(0s(, )?)+,(0s(, )?)+$/);
      await page.click('#pasta-menu');
      expect((await duracao()).join()).toMatch(/^(0s(, )?)+,(0s(, )?)+$/);
      // Sem animação, já está no lugar no mesmo instante.
      expect(Math.round((await page.locator('#lateral').boundingBox())!.x)).toBe(0);
    });

    it('com movimento, a animação da gaveta dura no máximo 200 ms', async () => {
      await abrirConsole(1366, 768);
      await abrirPasta();
      const ms = await page.evaluate(() =>
        getComputedStyle(document.getElementById('lateral')!)
          .transitionDuration.split(',')
          .map((d) => parseFloat(d) * (d.trim().endsWith('ms') ? 1 : 1000)),
      );
      expect(Math.max(...ms)).toBeLessThanOrEqual(200);
    });

    it('aviso do topo em uma linha, com data e hora da lista; "Detalhes" abre o texto completo de antes', async () => {
      await abrirConsole(1366, 768);
      await abrirPasta();
      const linha = (await page.textContent('#pasta-aviso-linha')) ?? '';
      expect(linha).toMatch(
        /^Lista de \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2} · não é consulta ao vivo · numeração calculada, pode ficar abaixo do Projudi$/,
      );
      const det = page.locator('#pasta-aviso-det');
      expect(await det.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
      expect(await page.locator('#pasta-aviso .proc').isVisible()).toBe(false);
      expect(await page.locator('#pasta-aviso-num').isVisible()).toBe(false);
      // Uma linha só: a faixa do aviso não passa de 32 px.
      expect(
        (await page.locator('#pasta-aviso').boundingBox())!.height,
      ).toBeLessThanOrEqual(32);

      // Pelo teclado: o resumo é focável e Enter abre.
      await page.focus('#pasta-aviso-det summary');
      await page.keyboard.press('Enter');
      expect(await det.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
      const data = /^Lista de (\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2})/.exec(linha)![1];
      expect(await page.textContent('#pasta-aviso .proc')).toBe(
        `Lista obtida do tribunal em ${data} — não é consulta ao vivo. Peça nova só aparece quando as peças do ` +
          'processo são recarregadas (botão "Atualizar" do cartão das peças).',
      );
      const total = await page.evaluate(
        () => document.querySelector('#pasta-aviso-num strong')?.textContent ?? '',
      );
      expect(await page.textContent('#pasta-aviso-num')).toBe(
        `Numeração das movimentações calculada pelo Processo Vivo a partir de ${total} atos recebidos do ` +
          `tribunal. Se o último número que você vê no Projudi for maior que ${total}, há atos bloqueados que não ` +
          'recebemos e os números mais recentes podem estar abaixo dos do Projudi. Use "Conferir numeração com o ' +
          'Projudi" para corrigir.',
      );
      expect(await axe('#pasta')).toEqual([]);
      // O recolhível da calibração continua lá, igual.
      expect(await page.locator('#pasta-cal summary').isVisible()).toBe(true);
      expect(await page.textContent('#pasta-cal summary')).toContain(
        'Conferir numeração com o Projudi',
      );
      await page.keyboard.press('Enter');
      expect(await det.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
      expect(erros).toEqual([]);
    });

    it('calibração anterior invalidada: o aviso de numeração aparece ABERTO e a linha diz o alerta', async () => {
      await abrirConsole(1366, 768);
      // A resposta do nosso servidor, com o único estado de alerta que o sistema detecta.
      await page.route('**/v1/processos/*/pasta', async (rota) => {
        const r = await rota.fetch();
        const j = (await r.json()) as Record<string, unknown>;
        j['calibracao'] = {
          ancoras: [],
          invalidadas: 1,
          atos: { exatos: 0, faixas: 0, estimados: 0 },
        };
        await rota.fulfill({ response: r, json: j });
      });
      await abrirPasta();
      expect(
        await page
          .locator('#pasta-aviso-det')
          .evaluate((d) => (d as HTMLDetailsElement).open),
      ).toBe(true);
      expect(await page.textContent('#pasta-aviso-linha')).toContain(
        'calibração anterior invalidada',
      );
      expect(await page.locator('#pasta-aviso-num').isVisible()).toBe(true);
      expect(await page.textContent('#pasta-aviso-num')).toContain(
        'Calibração anterior invalidada.',
      );
      expect(await axe('#pasta')).toEqual([]);
    });

    it('filtros: os tipos ficam em uma linha que rola por dentro; marcar por tipo e "Sem peça" contam como antes', async () => {
      await abrirConsole(1024, 768);
      await abrirPasta();
      const chips = page.locator('#pasta-atalhos .chip');
      const n = await chips.count();
      expect(n).toBeGreaterThanOrEqual(4);
      const tops = await chips.evaluateAll((cs) =>
        cs.map((c) => Math.round(c.getBoundingClientRect().top)),
      );
      expect(new Set(tops).size).toBe(1);
      const medida = () =>
        page.$eval('#pasta-atalhos', (e) => ({
          rola: e.scrollWidth > e.clientWidth,
          mais: e.classList.contains('tem-mais'),
          x: getComputedStyle(e).overflowX,
          esq: e.scrollLeft,
        }));
      // Com a lista no mínimo, os tipos não cabem: rolam DENTRO do contêiner, com o sinal de "há mais".
      await page.focus('#pasta-divisor');
      for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft');
      const m = await medida();
      expect(m.x).toBe('auto');
      expect(m.rola).toBe(true);
      expect(m.mais).toBe(true);
      expect(await rolaH()).toBe(false);
      // No fim da rolagem o sinal some.
      await page.$eval('#pasta-atalhos', (e) => (e.scrollLeft = e.scrollWidth));
      await page.waitForFunction(
        () => !document.getElementById('pasta-atalhos')!.classList.contains('tem-mais'),
      );

      // Regressão: o chip do tipo marca todas as peças daquele tipo, e a contagem continua à vista.
      // (o último tipo, que está à vista no fim da rolagem: clicar no primeiro rolaria de volta sozinho)
      const primeiro = page.locator('#pasta-atalhos [data-grupo]').last();
      const rotulo = (await primeiro.textContent()) ?? '';
      const qtd = Number(/\((\d+)\)$/.exec(rotulo)![1]);
      await primeiro.click();
      expect(await page.textContent('#pasta-contagem')).toContain(
        `${qtd} ${qtd === 1 ? 'marcada' : 'marcadas'} · mostrando`,
      );
      expect((await page.textContent('#pasta-baixar-pdf'))?.trim()).toBe(
        `Baixar PDF (${qtd})`,
      );
      expect(
        await page
          .locator('#pasta-atalhos [data-grupo]')
          .last()
          .getAttribute('aria-pressed'),
      ).toBe('true');
      // Redesenhar a lista não devolve a rolagem dos tipos para o começo.
      expect((await medida()).esq).toBeGreaterThan(0);
      await page.click('#pasta-nenhuma');
      expect(await page.textContent('#pasta-contagem')).toContain('0 marcadas');

      // "Sem peça (N)" filtra, não marca.
      const sem = page.locator('#pasta-chip-sem');
      const nSem = Number(/\((\d+)\)$/.exec((await sem.textContent()) ?? '')![1]);
      await sem.click();
      expect(await page.locator('#pasta .linha').count()).toBe(nSem);
      expect(await page.textContent('#pasta-contagem')).toMatch(
        new RegExp(
          `0 marcadas · mostrando ${nSem} de \\d+ linhas · \\d+ peças · ${nSem} sem peça`,
        ),
      );
      expect(await page.locator('#pasta-contagem').isVisible()).toBe(true);
      expect(await axe('#pasta')).toEqual([]);
      expect(erros).toEqual([]);
    });

    it('divisor lista × peça: separador com nome e valores, setas, limites, arrasto, duplo clique e Enter voltam ao padrão, preferência persiste', async () => {
      await abrirConsole(1366, 768);
      await abrirPasta();
      const d = page.locator('#pasta-divisor');
      const lista = async (): Promise<number> =>
        Math.round((await page.locator('#pasta-lista').boundingBox())!.width);
      const visor = async (): Promise<number> =>
        Math.round((await page.locator('#pasta-visor').boundingBox())!.width);
      expect(await d.getAttribute('role')).toBe('separator');
      expect(await d.getAttribute('aria-orientation')).toBe('vertical');
      expect(await d.getAttribute('aria-label')).toBe('Redimensionar lista');
      expect(await d.getAttribute('aria-valuemin')).toBe('320');
      expect(await d.getAttribute('aria-valuemax')).toBe(String(1366 - 360));
      const padrao = await lista();
      expect(padrao).toBe(492); // clamp(440px, 36vw, 620px) em 1366 px
      expect(await d.getAttribute('aria-valuenow')).toBe(String(padrao));

      // Teclado: 24 px por seta.
      await d.focus();
      await page.keyboard.press('ArrowRight');
      expect(await lista()).toBe(padrao + 24);
      expect(await d.getAttribute('aria-valuenow')).toBe(String(padrao + 24));
      // Limites: a lista não fica menor que 320 px nem o painel da peça menor que 360 px.
      for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft');
      expect(await lista()).toBe(320);
      for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
      expect(await lista()).toBe(1366 - 360);
      expect(await visor()).toBeGreaterThanOrEqual(355);
      expect(await rolaH()).toBe(false);
      // Enter volta à divisão padrão.
      await page.keyboard.press('Enter');
      expect(await lista()).toBe(padrao);
      expect(
        await page.evaluate(() => localStorage.getItem('processovivo.pasta.lista')),
      ).toBeNull();

      // Arrasto com o mouse.
      const c = (await d.boundingBox())!;
      await page.mouse.move(c.x + c.width / 2, c.y + 200);
      await page.mouse.down();
      await page.mouse.move(600, c.y + 200, { steps: 4 });
      await page.mouse.up();
      expect(Math.abs((await lista()) - 600)).toBeLessThanOrEqual(2);
      const escolhida = await lista();

      // A preferência persiste: recarrega, abre a Pasta de novo, mesma largura.
      // (o endereço é o da Pasta: ela reabre sozinha ao recarregar)
      await page.reload();
      await esperarConsolePronto(page);
      await page.waitForSelector('#pasta .linha');
      expect(await lista()).toBe(escolhida);
      // Duplo clique volta ao padrão e esquece a preferência.
      await page.locator('#pasta-divisor').dblclick();
      expect(await lista()).toBe(padrao);
      expect(
        await page.evaluate(() => localStorage.getItem('processovivo.pasta.lista')),
      ).toBeNull();
      expect(erros).toEqual([]);
    });

    it('na lista no mínimo (320 px) a linha mostra número, tipo e data numa linha e o resumo em até duas, sem cortar palavra', async () => {
      await abrirConsole(1024, 768);
      await abrirPasta();
      await page.focus('#pasta-divisor');
      for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft');
      const r = await page.evaluate(() => {
        const l = Array.from(document.querySelectorAll('#pasta .linha')).find((x) =>
          x.querySelector('.mov-t'),
        ) as HTMLElement;
        const ord = l.querySelector('.ord') as HTMLElement;
        const rot = l.querySelector('.rot') as HTMLElement;
        const meta = l.querySelector('.meta') as HTMLElement;
        const mov = l.querySelector('.mov-t') as HTMLElement;
        const alt = (e: HTMLElement) => e.getBoundingClientRect().height;
        const lh = parseFloat(getComputedStyle(mov).lineHeight) || 16;
        return {
          largura: Math.round(
            document.getElementById('pasta-lista')!.getBoundingClientRect().width,
          ),
          numeroInteiro: ord.scrollWidth <= ord.clientWidth + 1,
          mesmaLinha:
            Math.abs(ord.getBoundingClientRect().top - rot.getBoundingClientRect().top) <
            12,
          metaUmaLinha: alt(meta) <= 28,
          resumoLinhas: Math.round(alt(mov) / lh),
          quebra: getComputedStyle(mov).overflowWrap,
        };
      });
      expect(r.largura).toBe(320);
      expect(r.numeroInteiro).toBe(true);
      expect(r.mesmaLinha).toBe(true);
      expect(r.metaUmaLinha).toBe(true);
      expect(r.resumoLinhas).toBeLessThanOrEqual(2);
      expect(r.quebra).toBe('anywhere');
      expect(await rolaH()).toBe(false);
    });

    it('regressão da Pasta: marcar, "Baixar PDF (N)", "Todas", "Montar pasta completa", "Ver tudo seguido", "Peças baixadas" e "Fechar a pasta" continuam iguais', async () => {
      await abrirConsole(1366, 768);
      await abrirPasta();
      for (const [id, texto] of [
        ['pasta-montar', 'Montar pasta completa'],
        ['pasta-tudo', 'Ver tudo seguido'],
        ['pasta-baixadas-bt', 'Peças baixadas'],
        ['pasta-nenhuma', 'Nenhuma'],
      ] as const) {
        expect((await page.textContent('#' + id))?.trim()).toBe(texto);
        expect(await page.locator('#' + id).isVisible()).toBe(true);
      }
      expect((await page.textContent('#pasta-todas'))?.trim()).toMatch(/^Todas \(\d+\)$/);
      expect(await page.isDisabled('#pasta-baixar-pdf')).toBe(true);
      const cx = page.locator(
        '#pasta .linha:not([data-sem-peca]):not([aria-disabled=true]) .cx',
      );
      await cx.nth(0).click();
      await cx.nth(1).click();
      expect((await page.textContent('#pasta-baixar-pdf'))?.trim()).toBe(
        'Baixar PDF (2)',
      );
      expect(await page.isDisabled('#pasta-baixar-pdf')).toBe(false);
      expect(await page.textContent('#pasta-contagem')).toContain('2 marcadas');
      // "Fechar a pasta" leva de volta à tela do processo, e o menu volta ao layout.
      await page.click('#pasta-fechar');
      await page.waitForFunction(() => !document.getElementById('pasta'));
      expect(await page.locator('#pasta-abrir').isVisible()).toBe(true);
      expect(await modo()).toBe('completo');
      expect(await larguraDoMenu()).toBe(256);
      expect(erros).toEqual([]);
    });
  },
);
