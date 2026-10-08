/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';
import {
  carteira,
  grupo,
  infoProcesso,
  novidade,
  numeroValido,
  respostaNovidades,
  semNovidade,
} from '../helpers/atualizacoesSinteticas.js';
import type { GrupoSintetico, SemNovidadeSintetico } from '../helpers/atualizacoesSinteticas.js';

/*
 * A página inicial (v0.37.0) NUM NAVEGADOR: tabela de uma linha por processo,
 * filtros com contador, ordenação, paginação, copiar número. Sem "+N anteriores" (v0.37.1).
 * O servidor e o console são os reais; só as respostas de /v1/novidades e
 * /v1/facetas recebem dados SINTÉTICOS por cima (números com DV válido mas
 * inventados, partes e classes fictícias), sem nada de tela real.
 */
const sem = CHROMIUM === undefined;
const TEXTO_FIM = 'FIM-DO-TEXTO-DA-DECISAO';
const DECISAO =
  'Julgo procedente o pedido formulado na inicial para condenar a parte ré. '.repeat(40) +
  TEXTO_FIM;

interface Cenario {
  grupos: GrupoSintetico[];
  /** Só entram em "Todas" (fora da janela de 15 dias). */
  antigos?: GrupoSintetico[];
  foraDaJanela?: number;
  /** Processos acompanhados sem novidade registrada (v0.37.3): só a API os manda em `semNovidade`. */
  semNovidade?: SemNovidadeSintetico[];
  /** Atraso artificial da resposta, para ver o esqueleto. */
  atrasoMs?: number;
  /** Respostas de erro antes de acertar (para o "Tentar de novo"). */
  falhas?: number;
}

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}
interface Espiao {
  abertos: string[];
  pastas: string[];
}

describe.skipIf(sem)(
  'Página inicial — tabela de atualizações, no navegador',
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
      cenario: Cenario,
      opcoes: {
        largura?: number;
        altura?: number;
        escuro?: boolean;
        espera?: string;
      } = {},
    ): Promise<void> {
      ctx = await browser.newContext({
        viewport: { width: opcoes.largura ?? 1280, height: opcoes.altura ?? 900 },
        colorScheme: opcoes.escuro ? 'dark' : 'light',
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      await ctx.addInitScript((c) => {
        try {
          localStorage.setItem('processovivo.chave', c);
        } catch {
          /* sem armazenamento: o teste falharia adiante, com a causa à vista */
        }
      }, CHAVE);
      let falhasRestantes = cenario.falhas ?? 0;
      await ctx.route('**/v1/novidades**', async (rota) => {
        const url = new URL(rota.request().url());
        if (url.searchParams.get('limite') === '1') {
          return rota.fulfill({ json: respostaNovidades(cenario.grupos) });
        }
        if (cenario.atrasoMs) await new Promise((r) => setTimeout(r, cenario.atrasoMs));
        if (falhasRestantes > 0) {
          falhasRestantes -= 1;
          return rota.fulfill({
            status: 500,
            json: { erro: 'ERRO_INTERNO', mensagem: 'Falha sintética.' },
          });
        }
        // O console pede "Todas" por padrão (v0.37.3); só a janela ligada pela pessoa vem sem o parâmetro.
        const todas = url.searchParams.get('janela') === 'todas';
        const tribunal = url.searchParams.get('tribunal');
        const sem = cenario.semNovidade ?? [];
        const antigos = cenario.antigos ?? [];
        const doTribunal = (t: string | null | undefined): boolean =>
          !tribunal || t === tribunal;
        let grupos = todas ? [...cenario.grupos, ...antigos] : cenario.grupos;
        grupos = grupos.filter((g) => doTribunal(g.processo?.tribunal));
        const semDoTribunal = sem.filter((x) => doTribunal(x.processo?.tribunal));
        const fora = antigos.filter((g) => doTribunal(g.processo?.tribunal)).length;
        return rota.fulfill({
          json: respostaNovidades(grupos, {
            acompanhados: cenario.grupos.length + antigos.length + sem.length,
            janelaDias: todas ? null : 15,
            foraDaJanela: todas ? 0 : (cenario.foraDaJanela ?? 0),
            semNovidade: semDoTribunal,
            processosForaDaJanela: todas ? 0 : fora + semDoTribunal.length,
          }),
        });
      });
      await ctx.route('**/v1/facetas', async (rota) => {
        const real = (await (await rota.fetch()).json()) as Record<string, unknown>;
        await rota.fulfill({
          json: { ...real, tribunais: ['TJGO', 'TJMG', 'TJSP'], classes: [] },
        });
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      await page.goto(amb.url + '/');
      await page.waitForSelector(opcoes.espera ?? '.nvt-tabela');
    }

    /** Liga o filtro "Últimos 15 dias" (nasce desligado) e espera a tabela recarregar. */
    async function ligarPeriodo(): Promise<void> {
      await page.getByRole('button', { name: 'Últimos 15 dias' }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-janela="padrao"]')
            ?.getAttribute('aria-pressed') === 'true',
      );
    }

    const linhas = () => page.locator('.nvt-tabela tr.nvt-linha');
    const numerosDasLinhas = () =>
      page.locator('.nvt-tabela tr.nvt-linha .nvt-num').allTextContents();
    async function espiar(): Promise<void> {
      await page.evaluate(() => {
        const w = window as unknown as {
          __pv: { abrir(n: string): void };
          __pvPasta?: { pedirAbertura(n: string): void };
          __espiao: { abertos: string[]; pastas: string[] };
        };
        w.__espiao = { abertos: [], pastas: [] };
        w.__pv.abrir = (n: string) => void w.__espiao.abertos.push(n);
        if (w.__pvPasta)
          w.__pvPasta.pedirAbertura = (n: string) => void w.__espiao.pastas.push(n);
      });
    }
    const espiao = (): Promise<Espiao> =>
      page.evaluate(() => (window as unknown as { __espiao: Espiao }).__espiao);

    /* ---------------------------------------------------------------- estrutura */

    it('a página não tem cartões nem coluna "Peças baixadas": só título, situação, filtros, tabela e paginação', async () => {
      await abrir({ grupos: carteira(8) });
      expect(
        await page.locator('.cards, .card, .trilho, .duas-colunas, .baixa').count(),
      ).toBe(0);
      const corpo = await page.locator('#conteudo').innerText();
      for (const fantasma of [
        'Peças baixadas',
        'Processos ativos',
        'Peças baixadas hoje',
      ]) {
        expect(corpo, fantasma).not.toContain(fantasma);
      }
      // O que fica: título, situação da sincronização, filtros, tabela, paginação.
      expect(await page.locator('h2').first().textContent()).toContain('atualizações');
      expect(await page.locator('#sincronizar').textContent()).toContain(
        'Verificar agora',
      );
      expect(await page.locator('.cabeca .sub').textContent()).toMatch(
        /8 processo\(s\) acompanhado\(s\)/,
      );
      expect(await page.locator('.nvt-filtros').count()).toBe(1);
      expect(await page.locator('table.nvt-tabela').count()).toBe(1);
      expect(await page.locator('nav.nvt-pag').count()).toBe(1);
    });

    it('é uma tabela de verdade: caption, nove colunas com <th scope="col"> e as colunas pedidas', async () => {
      await abrir({ grupos: carteira(5) });
      expect(await page.locator('table.nvt-tabela > caption').textContent()).toBe(
        'Processos acompanhados e a atualização mais recente de cada um',
      );
      const ths = page.locator('table.nvt-tabela thead th');
      expect(await ths.count()).toBe(9);
      for (let i = 0; i < 9; i++)
        expect(await ths.nth(i).getAttribute('scope')).toBe('col');
      const nomes = (await ths.allTextContents()).map((t) =>
        t.replace(/[↕↑↓]/g, '').trim(),
      );
      expect(nomes).toEqual([
        'Processo',
        'Partes',
        'Atualização',
        'Tribunal',
        'Classe',
        'Data do ato',
        'Detectado',
        'Situação',
        'Ações',
      ]);
    });

    it('cada linha traz número em fonte monoespaçada (link), partes, tribunal, classe, as duas datas rotuladas e as ações', async () => {
      const numero = numeroValido(2001);
      const g = grupo(
        numero,
        novidade(numero, 'Sentença', {
          diasDetectada: 1,
          diasAto: 4,
          conteudo: 'Texto curto do ato.',
          vista: false,
        }),
        [],
        infoProcesso(
          'TJGO',
          'Procedimento Comum Cível',
          ['Autora Sintética'],
          ['Empresa Fictícia Ltda'],
        ),
      );
      await abrir({ grupos: [g] });
      const l = linhas().first();
      const num = l.locator('.nvt-num');
      expect(await num.textContent()).toBe(
        numero.replace(/^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$/, '$1-$2.$3.$4.$5.$6'),
      );
      expect(await num.evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/mono/i);
      expect(await num.getAttribute('href')).toContain('processo=' + numero);
      expect(await l.locator('.c-partes').innerText()).toBe(
        'Autora Sintética × Empresa Fictícia Ltda',
      );
      expect(await l.locator('.c-trib').innerText()).toBe('TJGO');
      expect(await l.locator('.c-classe').innerText()).toBe('Procedimento Comum Cível');
      expect(await l.locator('.c-atu .nvt-tit').textContent()).toBe('Sentença');
      // As duas datas aparecem separadas, em colunas rotuladas, e não se confundem.
      expect(await l.locator('.c-data').getAttribute('data-rotulo')).toBe('Data do ato');
      expect(await l.locator('.c-det').getAttribute('data-rotulo')).toBe('Detectado');
      const dataAto = (await l.locator('.c-data').innerText()).trim();
      const detectado = (
        (await l.locator('.c-det [aria-hidden="true"]').textContent()) ?? ''
      ).trim();
      expect(dataAto).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
      // O cabeçalho já diz "Detectado": a célula só diz "há 1 dia" (v0.37.1).
      expect(detectado).toBe('há 1 dia');
      expect(await l.locator('.c-sit').innerText()).toContain('Não lida');
      // Ações com nome acessível.
      const nomesAcoes = await l
        .locator('.c-acoes button')
        .evaluateAll((bs) =>
          bs.map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim()),
        );
      expect(nomesAcoes[0]).toMatch(/^Abrir o processo /);
      expect(nomesAcoes[1]).toMatch(/^Abrir a pasta digital do processo /);
    });

    it('sem partes nem classe na fonte: "—", nada inventado; sem situação: célula sem selo vazio', async () => {
      const numero = numeroValido(2002);
      const g = grupo(
        numero,
        novidade(numero, 'Juntada', { vista: true }),
        [],
        infoProcesso('TJSP', null, [], []),
      );
      await abrir({ grupos: [g] });
      const l = linhas().first();
      expect((await l.locator('.c-partes').innerText()).trim()).toBe('—');
      expect((await l.locator('.c-classe').innerText()).trim()).toBe('—');
      expect(await l.locator('.c-sit .selo').count()).toBe(0);
    });

    it('mostra só o começo da decisão de ~3.000 caracteres, sem o fim, e abre o processo pelo botão', async () => {
      const numero = numeroValido(2003);
      const g = grupo(numero, novidade(numero, 'Sentença', { conteudo: DECISAO }), [
        novidade(numero, 'Decisão interlocutória', {
          conteudo: DECISAO,
          diasDetectada: 1,
        }),
        novidade(numero, 'Conclusos para despacho', {
          conteudo: null,
          diasDetectada: 11,
        }),
      ]);
      await abrir({ grupos: [g] });
      expect(DECISAO.length).toBeGreaterThan(2900);
      const texto = (
        await page.locator('.nvt-linha .nov-txt').first().innerText()
      ).trim();
      expect(texto.length).toBeLessThanOrEqual(222);
      expect(texto.endsWith('…')).toBe(true);
      expect(await page.locator('.nvt-tabela').innerText()).not.toContain(TEXTO_FIM);
      expect(
        await page.locator('.nov-txt > span[aria-hidden="true"]').first().textContent(),
      ).toBe('…');
      const linhasVisuais = await page
        .locator('.nvt-linha .nov-txt')
        .first()
        .evaluate((el) => {
          const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
          return Math.round(el.getBoundingClientRect().height / lh);
        });
      expect(linhasVisuais).toBeLessThanOrEqual(3);
      expect(await page.locator('.nvt-linha .nov-abrir').count()).toBe(1);
      // Sem texto, nenhum bloco vazio. Uma linha, a atualização mais recente e mais nada.
      expect(await page.locator('.nov-trecho:empty').count()).toBe(0);
      expect(await page.locator('.nvt-linha').count()).toBe(1);
    });

    it('coluna "Detectado" enxuta: "hoje", "há 1 dia", "há 11 dias"; a frase completa vai no title e no texto para leitor de tela', async () => {
      const gs = [
        { d: 0, curto: 'hoje', completo: 'detectado hoje' },
        { d: 1, curto: 'há 1 dia', completo: 'detectado há 1 dia' },
        { d: 11, curto: 'há 11 dias', completo: 'detectado há 11 dias' },
      ].map((c, i) => {
        const numero = numeroValido(2004 + i);
        return {
          c,
          g: grupo(numero, novidade(numero, 'A', { diasDetectada: c.d, diasAto: 12 })),
        };
      });
      await abrir({ grupos: gs.map((x) => x.g) });
      for (const [i, { c }] of gs.entries()) {
        const celula = linhas().nth(i).locator('.c-det');
        expect((await celula.locator('[aria-hidden="true"]').textContent())?.trim()).toBe(
          c.curto,
        );
        expect(await celula.locator('.nvt-sr').textContent()).toBe(c.completo);
        expect(await celula.locator('span[title]').first().getAttribute('title')).toContain(
          c.completo,
        );
      }
      // O que se VÊ nunca repete o cabeçalho: "detectado" só existe no texto para leitor de tela.
      const visiveis = await page
        .locator('.c-det [aria-hidden="true"]')
        .allTextContents();
      expect(visiveis.join(' ')).not.toMatch(/detectado/i);
    });

    /* --------------------------------------------------------- uma linha por processo */

    it('uma linha por processo, mesmo com 300 atualizações: sem "+N anteriores", sem aviso por linha e sem expansor', async () => {
      const numero = numeroValido(3001);
      const principal = novidade(numero, 'Sentença', { conteudo: 'Texto do ato.' });
      const anteriores = Array.from({ length: 300 }, (_, i) =>
        novidade(numero, `Movimento anterior ${i + 1}`, {
          diasDetectada: 1 + (i % 10),
          vista: i % 2 === 0,
          exigeAcao: i === 3,
        }),
      );
      await abrir({
        grupos: [grupo(numero, principal, anteriores), ...carteira(2).map((g) => g)],
      });
      expect(await linhas().count()).toBe(3);
      const tabela = await page.locator('.nvt-tabela').innerText();
      expect(tabela).not.toMatch(/\+\d+ anteriore/);
      expect(tabela).not.toContain('há anterior');
      expect(await page.locator('[data-acao="mais"], [data-acao="maisl"]').count()).toBe(0);
      expect(await page.locator('.nvt-ant, .nvt-item').count()).toBe(0);
      // A situação continua a regra de sempre: atualização não vista do processo.
      expect(await linhas().first().locator('.c-sit').innerText()).toContain(
        '151 não lidas',
      );
      expect(await linhas().first().locator('.c-sit .selo.am').count()).toBe(0);
    });

    it('a frase da regra de ouro é UMA, da página: aparece quando algum processo tem mais de uma atualização, sem contagem', async () => {
      const FRASE =
        "Cada processo mostra a atualização mais recente. As anteriores estão em 'Abrir processo'.";
      const numero = numeroValido(3002);
      await abrir({
        grupos: [
          grupo(numero, novidade(numero, 'A'), [
            novidade(numero, 'B', { diasDetectada: 2 }),
          ]),
          ...carteira(3),
        ],
      });
      expect(await page.locator('.nov-ant').count()).toBe(1);
      expect((await page.locator('.nov-ant').innerText()).trim()).toBe(FRASE);
      expect(await page.locator('.nov-ant').innerText()).not.toMatch(/\d/);
      // Abaixo dos filtros e acima da tabela.
      const [filtros, frase, tabela] = await page.evaluate(() =>
        ['.nvt-filtros', '.nov-ant', '.nvt-wrap'].map(
          (s) => document.querySelector(s)!.getBoundingClientRect().top,
        ),
      );
      expect(filtros).toBeLessThan(frase!);
      expect(frase).toBeLessThan(tabela!);
    });

    it('sem processo com mais de uma atualização no período, a frase não aparece', async () => {
      const unicos = [numeroValido(3005), numeroValido(3006)].map((n) =>
        grupo(n, novidade(n, 'Conclusos para decisão')),
      );
      await abrir({ grupos: unicos });
      expect(await page.locator('.nov-ant').count()).toBe(0);
    });

    it('a mensagem "N processos sem atualização nos últimos 15 dias" convive com a frase da página', async () => {
      const numero = numeroValido(3003);
      await abrir({
        grupos: [grupo(numero, novidade(numero, 'A'), [novidade(numero, 'B')])],
        antigos: carteira(1),
        foraDaJanela: 308,
      });
      await ligarPeriodo();
      expect(await page.locator('.nov-fora').innerText()).toContain(
        '1 processo sem atualização nos últimos 15 dias (há 308 atualizações mais antigas) · Ver todos',
      );
      expect(await page.locator('.nov-ant').count()).toBe(1);
    });

    it('Ações: só os dois botões, sem texto, dentro da linha em 1920, 1366, 1280 e 1024', async () => {
      for (const largura of [1920, 1366, 1280, 1024]) {
        await abrir({ grupos: carteira(3) }, { largura });
        const m = await page.evaluate(() => {
          const l = document.querySelector('.nvt-linha .c-acoes')!;
          const cel = l.getBoundingClientRect();
          const bs = Array.from(l.querySelectorAll('button')).map((b) =>
            b.getBoundingClientRect(),
          );
          return {
            n: bs.length,
            texto: l.textContent?.trim(),
            dentro: bs.every((b) => b.left >= cel.left - 0.5 && b.right <= cel.right + 0.5),
            mesmaLinha: new Set(bs.map((b) => Math.round(b.top))).size,
          };
        });
        expect(m).toEqual({ n: 2, texto: '', dentro: true, mesmaLinha: 1 });
        await ctx.close();
      }
    });

    it('descrição sem repetição: a linha mostra a versão enxuta e o title guarda a original', async () => {
      const numero = numeroValido(3004);
      const original = 'Juntada -> Petição — Juntada -> Petição - DOCUMENTO SINTÉTICO';
      await abrir({ grupos: [grupo(numero, novidade(numero, original))] });
      const tit = linhas().first().locator('.c-atu .nvt-tit');
      expect(await tit.textContent()).toBe('Juntada -> Petição - DOCUMENTO SINTÉTICO');
      expect(await tit.getAttribute('title')).toBe(original);
    });

    /* ---------------------------------------------------------------------- copiar */

    it('copiar o número: vai para a área de transferência, confirma sem alert e anuncia em região aria-live', async () => {
      const numero = numeroValido(3004);
      await abrir({ grupos: [grupo(numero, novidade(numero, 'A'))] });
      let alertou = false;
      page.on('dialog', (d) => {
        alertou = true;
        void d.dismiss();
      });
      const botao = page.locator('[data-acao="copiar"]');
      expect(await botao.getAttribute('aria-label')).toMatch(
        /^Copiar o número do processo \d{7}-/,
      );
      await botao.click();
      const mascarado = (await page.locator('.nvt-num').textContent()) ?? '';
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(mascarado);
      expect(await page.locator('#nvt-live').textContent()).toBe(
        `Número ${mascarado} copiado.`,
      );
      expect(await page.locator('#nvt-live').getAttribute('aria-live')).toBe('polite');
      expect(await page.locator('.nvt-copiado').textContent()).toBe('Copiado');
      expect(alertou).toBe(false);
    });

    /* ---------------------------------------------------------- filtros e contadores */

    function cenarioDeFiltros(): Cenario {
      const g = (
        n: number,
        tribunal: string,
        lida: boolean,
        providencia: boolean,
        extras = 0,
      ): GrupoSintetico => {
        const numero = numeroValido(5000 + n);
        return grupo(
          numero,
          novidade(numero, providencia ? 'Intimação' : 'Juntada', {
            diasDetectada: n % 9,
            vista: lida,
            exigeAcao: providencia,
          }),
          Array.from({ length: extras }, (_, i) =>
            novidade(numero, `Ant ${i}`, { diasDetectada: 10, vista: true }),
          ),
          infoProcesso(tribunal, 'Classe Sintética', ['Autor'], ['Réu'], providencia),
        );
      };
      return {
        grupos: [
          g(1, 'TJGO', false, true),
          g(2, 'TJGO', false, false),
          g(3, 'TJGO', true, true),
          g(4, 'TJSP', true, false),
          g(5, 'TJSP', false, false),
          g(6, 'TJMG', true, false, 2),
        ],
        antigos: [g(7, 'TJGO', false, true), g(8, 'TJSP', true, false)],
        foraDaJanela: 3,
      };
    }

    it('os filtros de situação têm contador de PROCESSOS e o texto nunca fala em prazo', async () => {
      await abrir(cenarioDeFiltros());
      await ligarPeriodo();
      const sit = page.locator(
        '[role="group"][aria-labelledby="nvt-rot-situacao"] button',
      );
      expect((await sit.allTextContents()).map((t) => t.trim())).toEqual([
        'Todas (6)',
        'Não lidas (3)',
        'Pedem providência (2)',
      ]);
      const textos = (
        await sit.evaluateAll((bs) =>
          bs.map((b) => `${b.textContent} ${b.getAttribute('title')}`),
        )
      ).join(' ');
      expect(textos.toLowerCase()).not.toContain('prazo');
      expect(textos).toContain('dos últimos 10 dias');
      // A página inteira também não anuncia prazo (nem "abre prazo").
      expect((await page.locator('body').innerText()).toLowerCase()).not.toContain(
        'prazo',
      );
    });

    it('"Não lidas" e "Pedem providência" filtram, dizem quantos ficaram de fora e se desligam com "Todas"', async () => {
      await abrir(cenarioDeFiltros());
      await ligarPeriodo();
      await page.getByRole('button', { name: /^Não lidas \(3\)/ }).click();
      expect(await linhas().count()).toBe(3);
      expect(await page.locator('.nvt-resumo').innerText()).toContain(
        'Mostrando 3 de 6 processos',
      );
      expect(await page.locator('.nvt-resumo').innerText()).toContain(
        'filtro: Não lidas',
      );
      expect(await page.locator('#nvt-live').textContent()).toBe(
        'Mostrando 1 a 3 de 3 processos',
      );
      expect(
        await page
          .getByRole('button', { name: /^Não lidas/ })
          .getAttribute('aria-pressed'),
      ).toBe('true');
      // Os contadores continuam sobre a MESMA base (período + tribunal), não sobre o filtro.
      expect(await page.getByRole('button', { name: /^Todas \(6\)/ }).count()).toBe(1);

      await page.getByRole('button', { name: /^Pedem providência \(2\)/ }).click();
      expect(await linhas().count()).toBe(2);
      expect(await page.locator('.nvt-resumo').innerText()).toContain(
        'Mostrando 2 de 6 processos',
      );
      expect(await page.locator('.c-sit .selo.am').count()).toBe(2);

      await page.getByRole('button', { name: /^Todas \(6\)/ }).click();
      expect(await linhas().count()).toBe(6);
      expect(await page.locator('.nvt-resumo').innerText()).not.toContain('Mostrando');
    });

    it('o tribunal recarrega a base e os contadores passam a contar só aquele tribunal', async () => {
      await abrir(cenarioDeFiltros());
      await ligarPeriodo();
      await page.selectOption('#nvt-trib', 'TJGO');
      await page.waitForFunction(
        () => document.querySelectorAll('tr.nvt-linha').length === 3,
      );
      const sit = page.locator(
        '[role="group"][aria-labelledby="nvt-rot-situacao"] button',
      );
      expect((await sit.allTextContents()).map((t) => t.trim())).toEqual([
        'Todas (3)',
        'Não lidas (2)',
        'Pedem providência (2)',
      ]);
      expect(await page.locator('#nvt-trib').inputValue()).toBe('TJGO');
      expect(await page.locator('.nvt-resumo').innerText()).toContain('em TJGO');
      // Com situação e tribunal juntos, "X de Y" é sobre a base do tribunal.
      await page.getByRole('button', { name: /^Não lidas/ }).click();
      expect(await page.locator('.nvt-resumo').innerText()).toContain(
        'Mostrando 2 de 3 processos em TJGO',
      );
    });

    it('o período nasce desligado ("Todas"); ligado, diz quantos processos tirou da lista, com "Ver todos"', async () => {
      await abrir(cenarioDeFiltros());
      // Padrão: todos os processos, nenhum aviso de ocultos.
      expect(await linhas().count()).toBe(8);
      expect(await page.locator('.nov-fora').count()).toBe(0);
      expect(
        await page
          .getByRole('button', { name: 'Todas', exact: true })
          .getAttribute('aria-pressed'),
      ).toBe('true');

      await ligarPeriodo();
      expect(await linhas().count()).toBe(6);
      const aviso = page.locator('.nov-fora');
      expect(await aviso.innerText()).toContain(
        '2 processos sem atualização nos últimos 15 dias (há 3 atualizações mais antigas) · Ver todos',
      );
      expect(await page.locator('.nvt-resumo').innerText()).toContain(
        '8 processos acompanhados · 6 com atualização detectada nos últimos 15 dias',
      );
      await aviso.getByRole('button', { name: 'Ver todos' }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('tr.nvt-linha').length === 8,
      );
      expect(await page.locator('.nov-fora').count()).toBe(0);
    });

    it('o foco do teclado sobrevive ao redesenho do filtro', async () => {
      await abrir(cenarioDeFiltros());
      await page.focus('[data-sit="naoLidas"]');
      await page.keyboard.press('Enter');
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute('data-foco')),
      ).toBe('sit-naoLidas');
    });

    /* ---------------------------------------------------------------- paginação */

    it('paginação: itens por página 10/25/50, "X–Y de Z processos", primeira/anterior/próxima/última e aria-live', async () => {
      await abrir({ grupos: carteira(60) });
      const faixa = () => page.locator('.nvt-faixa').innerText();
      expect(await faixa()).toBe('1–25 de 60 processos');
      expect(await linhas().count()).toBe(25);
      expect(await page.locator('#nvt-por, .nvt-por select').inputValue()).toBe('25');
      const nav = (nome: string) => page.getByRole('button', { name: nome, exact: true });
      expect(await nav('Primeira página').isDisabled()).toBe(true);
      expect(await nav('Página anterior').isDisabled()).toBe(true);

      await nav('Próxima página').click();
      expect(await faixa()).toBe('26–50 de 60 processos');
      expect(await page.locator('#nvt-live').textContent()).toBe(
        'Mostrando 26 a 50 de 60 processos',
      );
      expect(await page.locator('.nvt-pagina').innerText()).toBe('Página 2 de 3');
      await nav('Última página').click();
      expect(await faixa()).toBe('51–60 de 60 processos');
      expect(await linhas().count()).toBe(10);
      expect(await nav('Próxima página').isDisabled()).toBe(true);
      await nav('Página anterior').click();
      expect(await faixa()).toBe('26–50 de 60 processos');
      await nav('Primeira página').click();
      expect(await faixa()).toBe('1–25 de 60 processos');

      await page.selectOption('.nvt-por select', '10');
      expect(await faixa()).toBe('1–10 de 60 processos');
      expect(await linhas().count()).toBe(10);
      await page.selectOption('.nvt-por select', '50');
      expect(await faixa()).toBe('1–50 de 60 processos');
      expect(await linhas().count()).toBe(50);
    });

    it('mudar de página cobre todos os processos uma vez só, e a escolha vale só na sessão (nada em localStorage)', async () => {
      await abrir({ grupos: carteira(30) });
      await page.selectOption('.nvt-por select', '10');
      const vistos: string[] = [];
      for (let i = 0; i < 3; i++) {
        vistos.push(...(await numerosDasLinhas()));
        if (i < 2)
          await page.getByRole('button', { name: 'Próxima página', exact: true }).click();
      }
      expect(new Set(vistos).size).toBe(30);
      const guardado = await page.evaluate(() =>
        Object.keys(localStorage).filter((k) =>
          /pagina|porpagina|situacao|ordem/i.test(k),
        ),
      );
      expect(guardado).toEqual([]);
      // Recarregar a página volta ao padrão: 25 por página.
      await page.reload();
      await page.waitForSelector('.nvt-tabela');
      expect(await page.locator('.nvt-por select').inputValue()).toBe('25');
    });

    /* --------------------------------------------------------------- ordenação */

    it('ordenação por cabeçalho com aria-sort: Data do ato, Detectado, Tribunal e Processo; terceiro clique volta ao padrão', async () => {
      const g = (
        seq: number,
        tribunal: string,
        diasAto: number,
        diasDet: number,
      ): GrupoSintetico => {
        const numero = numeroValido(seq);
        return grupo(
          numero,
          novidade(numero, 'Ato ' + seq, { diasAto, diasDetectada: diasDet }),
          [],
          infoProcesso(tribunal, null, [], []),
        );
      };
      // Ordem de chegada (a atual da página): detectadas mais recentes primeiro.
      const grupos = [
        g(30, 'TJSP', 5, 0),
        g(10, 'TJGO', 2, 1),
        g(20, 'TJMG', 9, 2),
        g(40, 'TJGO', 1, 3),
      ];
      await abrir({ grupos });
      const ordem = async () =>
        (await page.locator('.c-atu .nvt-tit').allTextContents()).map((t) =>
          t.replace('Ato ', ''),
        );
      const cab = (nome: string) => page.locator('th', { hasText: nome });
      expect(await ordem()).toEqual(['30', '10', '20', '40']);
      for (const n of ['Processo', 'Tribunal', 'Data do ato', 'Detectado']) {
        expect(await cab(n).getAttribute('aria-sort')).toBe('none');
      }

      await cab('Data do ato').getByRole('button').click();
      expect(await cab('Data do ato').getAttribute('aria-sort')).toBe('descending');
      expect(await ordem()).toEqual(['40', '10', '30', '20']);
      expect(await cab('Data do ato').locator('.nvt-seta').textContent()).toBe('↓');
      await cab('Data do ato').getByRole('button').click();
      expect(await cab('Data do ato').getAttribute('aria-sort')).toBe('ascending');
      expect(await ordem()).toEqual(['20', '30', '10', '40']);
      await cab('Data do ato').getByRole('button').click();
      expect(await cab('Data do ato').getAttribute('aria-sort')).toBe('none');
      expect(await ordem()).toEqual(['30', '10', '20', '40']);

      await cab('Processo').getByRole('button').click();
      expect(await ordem()).toEqual(['10', '20', '30', '40']);
      await cab('Tribunal').getByRole('button').click();
      expect(await cab('Tribunal').getAttribute('aria-sort')).toBe('ascending');
      expect(await cab('Processo').getAttribute('aria-sort')).toBe('none');
      expect(await ordem()).toEqual(['10', '40', '20', '30']);
      await cab('Detectado').getByRole('button').click();
      expect(await ordem()).toEqual(['30', '10', '20', '40']);
      // Ordenar nunca escondeu linha.
      expect(await linhas().count()).toBe(4);
    });

    it('ordenar volta à primeira página e a lista continua inteira', async () => {
      await abrir({ grupos: carteira(60) });
      await page.getByRole('button', { name: 'Próxima página', exact: true }).click();
      await page.locator('th', { hasText: 'Processo' }).getByRole('button').click();
      expect(await page.locator('.nvt-faixa').innerText()).toBe('1–25 de 60 processos');
      expect(await page.locator('#nvt-live').textContent()).toBe(
        'Mostrando 1 a 25 de 60 processos',
      );
    });

    /* ------------------------------------------------------------------ estados */

    it('sem processos acompanhados: mensagem guia e ação para adicionar; nenhum bloco de tabela', async () => {
      await abrir({ grupos: [] }, { espera: '.nvt .vazio' });
      expect(await page.locator('.nvt .vazio h3').textContent()).toBe(
        'Nenhum processo acompanhado ainda',
      );
      expect(await page.getByRole('button', { name: 'Buscar processo' }).count()).toBe(1);
      expect(await page.locator('table, .nvt-filtros, .nvt-pag').count()).toBe(0);
      await page.getByRole('button', { name: 'Buscar processo' }).click();
      await page.waitForSelector('#nav-buscar.ativo');
    });

    it('sem resultado no filtro: "Nenhum processo com este filtro", quantos existem sem filtro e "Limpar filtros"', async () => {
      const numero = numeroValido(6001);
      const g = grupo(
        numero,
        novidade(numero, 'Juntada', { vista: true }),
        [],
        infoProcesso('TJGO', null, [], [], false),
      );
      await abrir({ grupos: [g] });
      await page.getByRole('button', { name: /^Pedem providência \(0\)/ }).click();
      expect(await page.locator('.nvt .vazio h3').textContent()).toBe(
        'Nenhum processo com este filtro',
      );
      expect(await page.locator('.nvt .vazio p').innerText()).toContain(
        'Há 1 processo acompanhado, sem o filtro',
      );
      expect(await page.locator('#nvt-live').textContent()).toBe(
        'Nenhum processo com este filtro',
      );
      expect(await page.locator('table').count()).toBe(0);
      await page
        .locator('.vazio')
        .getByRole('button', { name: 'Limpar filtros' })
        .click();
      expect(await linhas().count()).toBe(1);
    });

    it('carregando: esqueleto discreto e anunciado; depois a tabela', async () => {
      await abrir({ grupos: carteira(3), atrasoMs: 800 }, { espera: '.nvt-esq' });
      expect(await page.locator('.nvt-esq').getAttribute('aria-busy')).toBe('true');
      expect(await page.locator('.nvt-esq .nvt-sr').textContent()).toContain(
        'Carregando',
      );
      await page.waitForSelector('.nvt-tabela');
      expect(await page.locator('.nvt-esq').count()).toBe(0);
    });

    it('erro: mensagem do servidor e "Tentar de novo", que carrega de verdade', async () => {
      await abrir({ grupos: carteira(3), falhas: 1 }, { espera: '#nv-tentar' });
      expect(await page.locator('#conteudo').innerText()).toContain('Falha sintética');
      await page.click('#nv-tentar');
      await page.waitForSelector('.nvt-tabela');
      expect(await linhas().count()).toBe(3);
    });

    it('nenhum processo com atualização no período mas há acompanhados: diz isso e oferece "Ver todos", sem descartar nada', async () => {
      await abrir({ grupos: [], antigos: carteira(2), foraDaJanela: 4 });
      expect(await linhas().count()).toBe(2); // padrão "Todas"
      await ligarPeriodo();
      expect(await page.locator('.nvt .vazio h3').textContent()).toContain(
        'Nenhum processo com atualização nos últimos 15 dias',
      );
      expect(await page.locator('.nov-fora').innerText()).toContain(
        '2 processos sem atualização nos últimos 15 dias (há 4 atualizações mais antigas)',
      );
      await page.locator('.vazio').getByRole('button', { name: 'Ver todos' }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('tr.nvt-linha').length === 2,
      );
    });

    /* ------------------------------------------- processos sem novidade (v0.37.3) */

    /** 2 acompanhados: um com atualização detectada, um sem nenhuma novidade registrada. */
    function doisProcessos(): Cenario {
      const comNov = numeroValido(7001);
      const sem = numeroValido(7002);
      return {
        grupos: [
          grupo(
            comNov,
            novidade(comNov, 'Sentença', { diasDetectada: 1 }),
            [],
            infoProcesso('TJGO', 'Procedimento Comum Cível', ['Autor'], ['Réu']),
          ),
        ],
        semNovidade: [
          semNovidade(sem, 'Juntada de Petição — Juntada de Petição', {
            diasAto: 20,
            conteudo: 'Texto sintético do último ato conhecido.',
            processo: infoProcesso('TJGO', 'Execução Fiscal', [], []),
          }),
        ],
      };
    }

    it('2 processos acompanhados, 1 sem novidade: 2 linhas, o sem novidade com a última movimentação, sem detecção', async () => {
      await abrir(doisProcessos());
      expect(await linhas().count()).toBe(2);
      const sem = linhas().nth(1); // primeiro quem tem atualização detectada
      expect(await sem.locator('.nvt-num').textContent()).toContain('7002');
      expect(await sem.locator('.c-atu').innerText()).toContain(
        'Última movimentação conhecida · sem atualização detectada',
      );
      // Mesma regra de descrição: a repetição some só na exibição.
      expect(await sem.locator('.c-atu .nvt-tit').textContent()).toBe('Juntada de Petição');
      expect(await sem.locator('.c-atu .nvt-tit').getAttribute('title')).toBe(
        'Juntada de Petição — Juntada de Petição',
      );
      expect(await sem.locator('.c-atu .nov-txt').textContent()).toContain(
        'Texto sintético do último ato conhecido.',
      );
      // Data do ato = data da movimentação; Detectado = "—" com texto acessível.
      expect(await sem.locator('.c-data time').count()).toBe(1);
      expect(await sem.locator('.c-det').innerText()).toContain('—');
      expect(await sem.locator('.c-det .nvt-sr').textContent()).toBe(
        'sem detecção registrada',
      );
      // Situação vazia: nem "Não lida" nem providência sem base.
      expect(await sem.locator('.c-sit .selo').count()).toBe(0);
      // O resumo conta processos e nenhuma linha some.
      expect(await page.locator('.nvt-resumo').innerText()).toContain(
        '2 processos acompanhados',
      );
      const sit = page.locator('[role="group"][aria-labelledby="nvt-rot-situacao"] button');
      expect((await sit.allTextContents()).map((t) => t.trim())).toEqual([
        'Todas (2)',
        'Não lidas (1)',
        'Pedem providência (0)',
      ]);
    });

    it('período "Últimos 15 dias" esconde o sem novidade e diz "1 processo sem atualização…", com a saída', async () => {
      await abrir(doisProcessos());
      await ligarPeriodo();
      expect(await linhas().count()).toBe(1);
      expect(await page.locator('.nov-fora').innerText()).toBe(
        '1 processo sem atualização nos últimos 15 dias · Ver todos',
      );
      expect(await page.locator('.nvt-resumo').innerText()).toContain(
        '2 processos acompanhados · 1 com atualização detectada nos últimos 15 dias',
      );
      await page.locator('.nov-fora').getByRole('button', { name: 'Ver todos' }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('tr.nvt-linha').length === 2,
      );
    });

    it('os sem novidade vêm depois dos com atualização, pela data do ato mais recente; sem movimentação diz "Nenhuma movimentação conhecida"', async () => {
      const a = numeroValido(7101);
      const b = numeroValido(7102);
      const c = numeroValido(7103);
      const d = numeroValido(7104);
      await abrir({
        grupos: [grupo(a, novidade(a, 'Nova', { diasDetectada: 2 }))],
        semNovidade: [
          semNovidade(b, 'Antigo', { diasAto: 90 }),
          semNovidade(c, null),
          semNovidade(d, 'Recente', { diasAto: 5 }),
        ],
      });
      expect(
        (await numerosDasLinhas()).map((n) => n.replace(/\D/g, '').slice(0, 7)),
      ).toEqual(['0007101', '0007104', '0007102', '0007103']);
      const vazia = linhas().nth(3);
      expect(await vazia.locator('.c-atu').innerText()).toBe('Nenhuma movimentação conhecida');
      expect(await vazia.locator('.c-data').innerText()).toBe('—');
      expect(await vazia.locator('.c-det .nvt-sr').textContent()).toBe(
        'sem detecção registrada',
      );
    });

    it('segredo de justiça sem novidade: rótulo e data, nunca o texto do ato', async () => {
      const n = numeroValido(7201);
      await abrir({
        grupos: [],
        semNovidade: [semNovidade(n, 'Decisão', { segredo: true, conteudo: null })],
      });
      const linha = linhas().first();
      expect(await linha.locator('.c-atu').innerText()).toContain('segredo de justiça');
      expect(await linha.locator('.c-atu').innerText()).toContain(
        'O texto do ato não é exibido aqui.',
      );
      expect(await linha.locator('.nov-txt').count()).toBe(0);
    });

    it('"Pedem providência" e "Não lidas" continuam valendo: o sem novidade entra em "Todas" e só em "Pedem providência" se o servidor disser', async () => {
      const a = numeroValido(7301);
      const b = numeroValido(7302);
      await abrir({
        grupos: [],
        semNovidade: [
          semNovidade(a, 'Intimação', {
            diasAto: 2,
            processo: infoProcesso('TJGO', null, [], [], true),
          }),
          semNovidade(b, 'Juntada', { diasAto: 2, processo: infoProcesso('TJGO', null, [], [], false) }),
        ],
      });
      const sit = page.locator('[role="group"][aria-labelledby="nvt-rot-situacao"] button');
      expect((await sit.allTextContents()).map((t) => t.trim())).toEqual([
        'Todas (2)',
        'Não lidas (0)',
        'Pedem providência (1)',
      ]);
      await page.getByRole('button', { name: /^Pedem providência/ }).click();
      expect(await linhas().count()).toBe(1);
      expect(await page.locator('.c-sit .selo.am').count()).toBe(1);
    });

    /* ----------------------------------------------------------------- ações */

    it('"Abrir processo" abre o processo; "Abrir pasta" pede a Pasta digital e abre o mesmo processo', async () => {
      const numero = numeroValido(7001);
      await abrir({
        grupos: [grupo(numero, novidade(numero, 'A', { conteudo: DECISAO }))],
      });
      await espiar();
      await page.locator('[data-acao="abrir"].nvt-ic').click();
      await page.locator('.nvt-num').click();
      await page.locator('.nov-abrir').click();
      await page.locator('[data-acao="pasta"]').click();
      const e = await espiao();
      expect(e.abertos).toEqual([numero, numero, numero, numero]);
      expect(e.pastas).toEqual([numero]);
    });

    /* ---------------------------------------------------------------- teclado */

    it('ordem do teclado: filtros → tabela → paginação', async () => {
      await abrir({ grupos: carteira(30) });
      const posicao = (sel: string) =>
        page.evaluate((s) => {
          const el = document.querySelector(s) as HTMLElement;
          const todos = Array.from(
            document.querySelectorAll(
              '#conteudo button, #conteudo select, #conteudo a[href]',
            ),
          );
          return todos.indexOf(el);
        }, sel);
      const filtro = await posicao('[data-sit="providencia"]');
      const ordenar = await posicao('[data-chave="processo"]');
      const linha = await posicao('.nvt-linha .nvt-num');
      const pag = await posicao('[data-vai="proxima"]');
      expect(filtro).toBeLessThan(ordenar);
      expect(ordenar).toBeLessThan(linha);
      expect(linha).toBeLessThan(pag);
      // Tudo isso alcançável por Tab (nenhum tabindex negativo escondendo controle).
      expect(await page.locator('#conteudo [tabindex="-1"]').count()).toBe(0);
    });

    /* --------------------------------------------------- layout, rolagem e cabeçalho */

    const tamanhos = [1920, 1366, 1280, 1024, 768, 390];
    for (const largura of tamanhos) {
      it(`sem rolagem horizontal em ${largura}px, com texto longo e processo com 300 atualizações`, async () => {
        const longo = 'ArquivoOuNomeSemEspaco' + 'abcdefghij'.repeat(12);
        const numero = numeroValido(8001);
        const grupos = [
          grupo(
            numero,
            novidade(numero, longo, { conteudo: longo + ' ' + DECISAO }),
            Array.from({ length: 300 }, (_, i) =>
              novidade(numero, i === 0 ? longo : `Anterior ${i}`, {
                diasDetectada: 1 + (i % 12),
                conteudo: i % 3 ? null : DECISAO,
              }),
            ),
            infoProcesso('TJGO', longo, [longo], [longo + 'x'], true),
          ),
          ...carteira(24),
        ];
        const semNov = [
          semNovidade(numeroValido(8101), longo, {
            conteudo: longo + ' ' + DECISAO,
            processo: infoProcesso('TJGO', longo, [], []),
          }),
          semNovidade(numeroValido(8102), null),
          semNovidade(numeroValido(8103), 'Decisão', { segredo: true }),
        ];
        await abrir({ grupos, foraDaJanela: 3, semNovidade: semNov }, { largura });
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
          tabela: document.querySelector('.nvt-wrap')?.getBoundingClientRect().right ?? 0,
        }));
        expect(m.sw).toBeLessThanOrEqual(m.cw);
        expect(m.tabela).toBeLessThanOrEqual(m.cw);
        // Nenhum botão de ação ficou fora da janela.
        const fora = await page.evaluate(
          () =>
            Array.from(
              document.querySelectorAll('.nvt-acoes button, .nvt-copiar'),
            ).filter(
              (b) =>
                b.getBoundingClientRect().right >
                document.documentElement.clientWidth + 1,
            ).length,
        );
        expect(fora).toBe(0);
        // O texto longo continua inteiro na tela (quebrado, sem "…" de truncamento).
        expect(await page.locator('.nvt-linha .nvt-tit').first().textContent()).toBe(
          longo,
        );
      });
    }

    it('desktop: cabeçalho da tabela fixo ao rolar; processo e atualização com mais espaço que as colunas curtas', async () => {
      await abrir({ grupos: carteira(60) }, { largura: 1366, altura: 700 });
      await page.selectOption('.nvt-por select', '50');
      const largura = (sel: string) =>
        page.locator(sel).evaluate((e) => e.getBoundingClientRect().width);
      expect(await largura('th.h-processo')).toBeGreaterThan(
        await largura('th.h-tribunal'),
      );
      expect(await largura('th.h-atu')).toBeGreaterThan(await largura('th.h-tribunal'));
      expect(await largura('th.h-atu')).toBeGreaterThan(await largura('th.h-dataAto'));
      await page.evaluate(() => window.scrollTo(0, 1200));
      const topo = await page
        .locator('thead th')
        .first()
        .evaluate((e) => e.getBoundingClientRect().top);
      expect(topo).toBeGreaterThanOrEqual(0);
      expect(topo).toBeLessThan(2);
      // E há algo para ler embaixo dele.
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
    });

    for (const largura of [768, 390]) {
      it(`abaixo de 1024px (${largura}) cada processo vira um bloco empilhado, com rótulos e alvos de toque de 44px`, async () => {
        const numero = numeroValido(8101);
        const g = grupo(
          numero,
          novidade(numero, 'Sentença', {
            conteudo: 'Texto.',
            diasAto: 3,
            diasDetectada: 1,
          }),
          [novidade(numero, 'Despacho', { diasDetectada: 4 })],
          infoProcesso('TJGO', 'Classe Sintética', ['Autor'], ['Réu'], true),
        );
        await abrir({ grupos: [g, ...carteira(3)] }, { largura });
        expect(await page.locator('thead').isVisible()).toBe(false);
        const l = linhas().first();
        const rotulos = await l
          .locator('td')
          .evaluateAll((tds) => tds.map((td) => td.getAttribute('data-rotulo')));
        expect(rotulos).toEqual([
          'Processo',
          'Partes',
          'Atualização',
          'Tribunal',
          'Classe',
          'Data do ato',
          'Detectado',
          'Situação',
          'Ações',
        ]);
        // O rótulo é conteúdo gerado, visível ao leitor de tela e ao olho.
        expect(
          await l
            .locator('td.c-data')
            .evaluate((e) => getComputedStyle(e, '::before').content),
        ).toContain('Data do ato');
        const pequenos = await page
          .locator(
            '.nvt-linha button, .nvt-linha a.nvt-num, .nvt-filtros button, .nvt-filtros select, .nvt-pag button, .nvt-pag select',
          )
          .evaluateAll((els) =>
            els
              .map((e) => ({
                h: e.getBoundingClientRect().height,
                w: e.getBoundingClientRect().width,
                t: e.getAttribute('aria-label') ?? e.textContent?.trim(),
              }))
              .filter((x) => x.h > 0 && x.h < 43.5),
          );
        expect(JSON.stringify(pequenos)).toBe('[]');
        // Ordenar no celular: o seletor "Ordenar por" substitui os cabeçalhos.
        expect(await page.locator('#nvt-ordenar').isVisible()).toBe(true);
        await page.selectOption('#nvt-ordenar', 'processo:desc');
        const nums = await numerosDasLinhas();
        expect([...nums].sort().reverse()).toEqual(nums);
        // Filtros e paginação seguem utilizáveis.
        await page.getByRole('button', { name: /^Pedem providência/ }).click();
        expect(await linhas().count()).toBeGreaterThan(0);
      });
    }

    it('no desktop o seletor "Ordenar por" não existe (os cabeçalhos ordenam)', async () => {
      await abrir({ grupos: carteira(3) });
      expect(await page.locator('#nvt-ordenar').isVisible()).toBe(false);
    });

    /* --------------------------------------------------------------- temas e axe */

    for (const escuro of [false, true]) {
      for (const largura of [1280, 390]) {
        it(`axe sem violações no tema ${escuro ? 'escuro' : 'claro'}, layout de ${largura}px`, async () => {
          const numero = numeroValido(9001);
          const grupos = [
            grupo(
              numero,
              novidade(numero, 'Sentença', { conteudo: DECISAO }),
              [
                novidade(numero, 'Despacho', {
                  diasDetectada: 2,
                  exigeAcao: true,
                  conteudo: 'Texto.',
                }),
              ],
              infoProcesso(
                'TJGO',
                'Procedimento Comum Cível',
                ['Autora Sintética'],
                ['Empresa Fictícia Ltda'],
                true,
              ),
            ),
            ...carteira(6),
          ];
          const semNov = [
            semNovidade(numeroValido(9101), 'Juntada de Petição', {
              conteudo: 'Texto do último ato conhecido.',
              processo: infoProcesso('TJSP', 'Execução Fiscal', [], []),
            }),
            semNovidade(numeroValido(9102), null),
            semNovidade(numeroValido(9103), 'Decisão', { segredo: true }),
          ];
          await abrir({ grupos, foraDaJanela: 2, semNovidade: semNov }, { largura, escuro });
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

    it('respeita prefers-reduced-motion: o esqueleto não anima', async () => {
      ctx = await browser.newContext({ reducedMotion: 'reduce' });
      const p = await ctx.newPage();
      await p.setContent(
        '<div class="nvt-esq-linha"><span style="display:block;height:10px"></span></div>',
      );
      await p.addStyleTag({
        content: (await import('../../src/main/http/ui/estilosAtualizacoes.js'))
          .ESTILOS_TABELA_ATUALIZACOES,
      });
      const anim = await p
        .locator('.nvt-esq-linha span')
        .evaluate((e) => getComputedStyle(e).animationName);
      expect(anim).toBe('none');
    });
  },
);
