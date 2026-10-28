/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROCESSO_TJGO, PROCESSO_TJGO_DIGITOS } from '../helpers/leitor.js';
import { CHAVE, CHAVE_B, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';

/*
 * Navegação por HASH (v0.57.0) NUM NAVEGADOR de verdade: Voltar/Avançar, F5, link direto, outra conta, sair e Voltar,
 * foco, título, temas, axe e seis larguras. Peças e números sintéticos. Pula sem Chromium.
 */
const sem = CHROMIUM === undefined;
interface Console_ {
  __pv?: { abrir(numero: string): void };
  __pvNav?: { token(numero: string): string };
}
interface ViolacaoAxe {
  id: string;
  impact: string;
  nodes: Array<{ target: string[]; any: Array<{ message: string }> }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

const LARGURAS = [1920, 1366, 1280, 1024, 768, 390];
const CNJ_FORMATADO = PROCESSO_TJGO;

describe.skipIf(sem)('Navegação por hash — no navegador', { timeout: 90_000 }, () => {
  let browser: Browser;
  let amb: Ambiente;
  let ctx: BrowserContext | undefined;
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
    ctx = undefined;
    await amb?.encerrar();
  });

  async function abrirTela(
    opcoes: {
      viewport?: { width: number; height: number };
      escuro?: boolean;
      chave?: string | null;
      sal?: string;
    } = {},
  ): Promise<Page> {
    ctx = await browser.newContext({
      viewport: opcoes.viewport ?? { width: 1360, height: 860 },
      colorScheme: opcoes.escuro ? 'dark' : 'light',
    });
    const chave = opcoes.chave === undefined ? CHAVE : opcoes.chave;
    await ctx.addInitScript(
      ([c, s]) => {
        try {
          if (c) localStorage.setItem('processovivo.chave', c);
          if (s) localStorage.setItem('processovivo.nav', s);
        } catch {
          /* sem armazenamento: o teste falharia adiante, com a causa à vista */
        }
      },
      [chave, opcoes.sal ?? ''] as const,
    );
    page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    return page;
  }

  /** O que a barra de endereço mostra (sem o servidor): só a parte depois do #. */
  const hash = (): Promise<string> => page.evaluate(() => location.hash);
  const titulo = (): Promise<string> => page.title();
  const foco = (): Promise<string> =>
    page.evaluate(
      () =>
        `${document.activeElement?.tagName ?? ''}|${(document.activeElement?.textContent ?? '').trim().slice(0, 40)}`,
    );
  async function comEsperaDe(hashEsperado: RegExp): Promise<void> {
    await page.waitForFunction(
      (re) => new RegExp(re).test(location.hash),
      hashEsperado.source,
    );
  }
  async function ate(): Promise<void> {
    await page.waitForFunction(
      () => typeof (window as unknown as Console_).__pvNav?.token === 'function',
    );
  }
  async function listaDeProcessos(): Promise<void> {
    await page.click('#nav-processos');
    await page.waitForSelector('[data-abrir]');
  }
  async function abrirProcessoDaLista(): Promise<void> {
    await page.click('[data-abrir]');
    await page.waitForSelector('#pasta-abrir');
  }
  async function abrirPastaPeloBotao(): Promise<void> {
    await page.click('#pasta-abrir');
    await page.waitForSelector('#pasta .linha');
  }
  /**
   * Vai a um endereço que termina no aviso "Não encontramos esta página" e espera o aviso DESTE
   * endereço. Entre dois endereços só muda o `#`: a página não recarrega, o aviso anterior continua
   * na tela enquanto o novo endereço se resolve (pergunta à carteira), e um clique nele seria
   * desfeito pelo aviso novo chegando depois. O aviso antigo é marcado antes de navegar.
   */
  async function irAoAviso(endereco: string): Promise<void> {
    await page
      .evaluate(() =>
        document.getElementById('nav-aviso-lista')?.setAttribute('data-anterior', ''),
      )
      .catch(() => undefined);
    await page.goto(endereco);
    await page.waitForSelector('#nav-aviso-lista:not([data-anterior])');
  }
  /** Toda URL que o teste viu: nenhuma pode ter o número do processo (nem formatado, nem só os dígitos). */
  async function semNumeroNaUrl(): Promise<void> {
    const url = page.url();
    expect(url).not.toContain(PROCESSO_TJGO_DIGITOS);
    expect(url).not.toContain(CNJ_FORMATADO);
    expect(await titulo()).not.toContain(PROCESSO_TJGO_DIGITOS);
    expect(await titulo()).not.toMatch(/\d{7}-\d{2}\.\d{4}/);
  }

  it('lista → processo → Pasta → peça: o Voltar desfaz um passo por vez, só então sai do app, e o Avançar refaz', async () => {
    amb = await iniciar();
    await abrirTela();
    await page.goto(amb.url + '/');
    await page.waitForSelector('#nav-processos');
    await ate();
    await comEsperaDe(/^#\/atualizacoes$/);

    await listaDeProcessos();
    expect(await hash()).toBe('#/processos');
    await abrirProcessoDaLista();
    expect(await hash()).toMatch(/^#\/processo\/[a-z0-9]{6,20}$/);
    const processo = await hash();
    await abrirPastaPeloBotao();
    expect(await hash()).toBe(processo + '/pasta');
    await page.click('#pf-p01');
    await page.waitForSelector('#pasta .pagina canvas');
    expect(await hash()).toBe(processo + '/pasta/peca/p01');
    // Trocar de peça NÃO cria passo: substitui a entrada do visualizador.
    await page.click('#pf-p02');
    expect(await hash()).toBe(processo + '/pasta/peca/p02');
    await semNumeroNaUrl();

    // Voltar, passo a passo.
    await page.goBack();
    await comEsperaDe(/\/pasta$/);
    expect(await page.locator('#pasta').count()).toBe(1);
    await page.goBack();
    await comEsperaDe(/^#\/processo\/[a-z0-9]+$/);
    expect(await hash()).toBe(processo);
    expect(await page.locator('#pasta').count()).toBe(0);
    await page.waitForSelector('#pasta-abrir');
    await page.goBack();
    await comEsperaDe(/^#\/processos$/);
    await page.waitForSelector('[data-abrir]');
    expect(await page.locator('#conteudo h2').first().textContent()).toBe(
      'Meus processos',
    );
    await page.goBack();
    await comEsperaDe(/^#\/atualizacoes$/);
    // Só agora o Voltar sai do app.
    expect(page.url().startsWith(amb.url)).toBe(true);
    await page.goBack();
    expect(page.url()).toBe('about:blank');

    // Avançar refaz.
    await page.goForward();
    await page.waitForSelector('#nav-processos');
    await comEsperaDe(/^#\/atualizacoes$/);
    await page.goForward();
    await comEsperaDe(/^#\/processos$/);
    await page.goForward();
    await comEsperaDe(/^#\/processo\/[a-z0-9]+$/);
    await page.waitForSelector('#pasta-abrir');
    await page.goForward();
    await comEsperaDe(/\/pasta$/);
    await page.waitForSelector('#pasta .linha');
    expect(await page.locator('#pasta').count()).toBe(1);
  });

  it('F5 mantém a tela: lista, processo, Pasta e peça já guardada', async () => {
    amb = await iniciar();
    await abrirTela();
    await page.goto(amb.url + '/');
    await ate();
    await listaDeProcessos();
    await page.reload();
    await page.waitForSelector('[data-abrir]');
    expect(await hash()).toBe('#/processos');

    await abrirProcessoDaLista();
    const processo = await hash();
    await page.reload();
    await page.waitForSelector('#pasta-abrir');
    expect(await hash()).toBe(processo);
    expect(await page.locator('#conteudo .capa').count()).toBe(1);

    await abrirPastaPeloBotao();
    await page.reload();
    await page.waitForSelector('#pasta .linha');
    expect(await hash()).toBe(processo + '/pasta');

    await page.click('#pf-p01');
    await page.waitForSelector('#pasta .pagina canvas');
    await page.reload();
    await page.waitForSelector('#pasta .pagina canvas');
    expect(await hash()).toBe(processo + '/pasta/peca/p01');
  });

  it('F5 numa peça que ainda NÃO foi baixada não consulta o tribunal: fica na lista, e o endereço volta a ser o da Pasta', async () => {
    amb = await iniciar();
    await abrirTela();
    await page.goto(amb.url + '/');
    await ate();
    await listaDeProcessos();
    await abrirProcessoDaLista();
    const processo = await hash();
    // Endereço de peça nunca pedida (p03 não foi aberta): reabrir o link só mostra a lista.
    await page.goto(amb.url + '/' + processo + '/pasta/peca/p03');
    await page.waitForSelector('#pasta .linha');
    await comEsperaDe(/\/pasta$/);
    expect(amb.provedor.lotes()).toEqual([]);
  });

  it('link direto, logado: abre a tela pedida (processo e Pasta) numa aba nova', async () => {
    amb = await iniciar();
    await abrirTela();
    await page.goto(amb.url + '/');
    await ate();
    const tok = await page.evaluate(
      (n) => (window as unknown as Console_).__pvNav!.token(n),
      PROCESSO_TJGO_DIGITOS,
    );
    expect(tok).toMatch(/^[a-z0-9]{6,20}$/);
    const outra = await ctx!.newPage();
    outra.setDefaultTimeout(15_000);
    await outra.goto(`${amb.url}/#/processo/${tok}`);
    await outra.waitForSelector('#pasta-abrir');
    expect(await outra.locator('#conteudo .capa').count()).toBe(1);
    const direta = await ctx!.newPage();
    direta.setDefaultTimeout(15_000);
    await direta.goto(`${amb.url}/#/processo/${tok}/pasta`);
    await direta.waitForSelector('#pasta .linha');
    // Chegou por link: "Fechar a pasta" vai à tela do processo (não há origem no app para voltar).
    await direta.click('#pasta-fechar');
    await direta.waitForSelector('#pasta-abrir');
    expect(await direta.evaluate(() => location.hash)).toBe(`#/processo/${tok}`);
    expect(await direta.locator('#pasta').count()).toBe(0);
    // E "← voltar" do processo, sem origem no app, vai à lista de processos.
    await direta.click('#voltar');
    await direta.waitForSelector('[data-abrir]');
    expect(await direta.evaluate(() => location.hash)).toBe('#/processos');
    expect(direta.url()).not.toContain(PROCESSO_TJGO_DIGITOS);
  });

  it('link direto, deslogado: mostra a entrada, e depois do login leva à tela pedida — sem laço', async () => {
    amb = await iniciar();
    // O token é do navegador: gera numa aba logada e usa o mesmo sal na aba deslogada.
    await abrirTela();
    await page.goto(amb.url + '/');
    await ate();
    const tok = await page.evaluate(
      (n) => (window as unknown as Console_).__pvNav!.token(n),
      PROCESSO_TJGO_DIGITOS,
    );
    const sal = await page.evaluate(() => localStorage.getItem('processovivo.nav') ?? '');
    await ctx!.close();

    await abrirTela({ chave: null, sal });
    await page.goto(`${amb.url}/#/processo/${tok}`);
    await page.waitForSelector('#c-chave');
    expect(await page.locator('#lateral:not(.oculto)').count()).toBe(0);
    expect(await hash()).toBe(`#/processo/${tok}`);
    await page.click('#c-chave');
    await page.fill('#k', CHAVE);
    await page.click('#entrar');
    await page.waitForSelector('#pasta-abrir');
    expect(await hash()).toBe(`#/processo/${tok}`);
    expect(await page.locator('#conteudo .capa').count()).toBe(1);
    // O login não é uma entrada: Voltar leva para fora do app, nunca para a tela de entrada.
    await page.goBack();
    expect(
      page.url().startsWith('about:blank') || !(await page.locator('#c-chave').count()),
    ).toBe(true);
  });

  it('processo de OUTRA conta: tela de aviso neutra, sem dado nenhum do processo', async () => {
    amb = await iniciar();
    await abrirTela();
    await page.goto(amb.url + '/');
    await ate();
    const tok = await page.evaluate(
      (n) => (window as unknown as Console_).__pvNav!.token(n),
      PROCESSO_TJGO_DIGITOS,
    );
    const sal = await page.evaluate(() => localStorage.getItem('processovivo.nav') ?? '');
    await ctx!.close();

    // A conta B tem o MESMO sal (o pior caso: o endereço é exatamente o que o token do processo seria) e carteira vazia.
    await abrirTela({ chave: CHAVE_B, sal });
    for (const rota of [
      `#/processo/${tok}`,
      `#/processo/${tok}/pasta`,
      `#/processo/${tok}/pasta/peca/p01`,
    ]) {
      await irAoAviso(`${amb.url}/${rota}`);
      const corpo =
        (await page.locator('body').innerText()) +
        (await page.locator('#conteudo').innerHTML());
      expect(corpo).not.toContain(PROCESSO_TJGO);
      expect(corpo).not.toContain(PROCESSO_TJGO_DIGITOS);
      expect(await page.locator('#pasta').count()).toBe(0);
      expect(await page.locator('#conteudo .capa').count()).toBe(0);
    }
    // Endereço inventado também cai no aviso, e o aviso leva de volta à lista.
    await irAoAviso(`${amb.url}/#/processo/naoexiste1234`);
    await page.click('#nav-aviso-lista');
    await page.waitForSelector('text=Meus processos');
    await page.goto(`${amb.url}/#/qualquer-coisa`);
    await page.waitForSelector('#nav-aviso-lista');
  });

  it('sair e Voltar: o Voltar nunca reabre o app por dentro; a entrada continua à vista', async () => {
    amb = await iniciar();
    await abrirTela();
    await page.goto(amb.url + '/');
    await ate();
    await listaDeProcessos();
    await abrirProcessoDaLista();
    await page.click('#sair');
    await page.waitForSelector('#c-chave');
    expect(await hash()).toBe('#/entrar');
    await page.goBack();
    await page.waitForSelector('#c-chave');
    expect(await page.locator('[data-abrir]').count()).toBe(0);
    expect(await page.locator('#conteudo .capa').count()).toBe(0);
    expect(await hash()).toBe('#/entrar');
    // Sem laço: nenhuma troca contínua de entradas.
    const antes = await page.evaluate(() => history.length);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => history.length)).toBe(antes);
    // Depois de sair, o mapa de processos da aba é apagado.
    expect(
      await page.evaluate(() => sessionStorage.getItem('processovivo.nav.processos')),
    ).toBeNull();
  });

  it('abrir e fechar um painel (Custos do processo) NÃO cria passo no histórico', async () => {
    amb = await iniciar();
    await abrirTela();
    await page.goto(amb.url + '/');
    await ate();
    await listaDeProcessos();
    await abrirProcessoDaLista();
    const antes = await page.evaluate(() => history.length);
    const rota = await hash();
    await page.click('#cust-abrir');
    await page.waitForSelector('[data-cust="fechar"]');
    expect(await hash()).toBe(rota);
    await page.click('[data-cust="fechar"]');
    expect(await hash()).toBe(rota);
    expect(await page.evaluate(() => history.length)).toBe(antes);
    // E um Voltar depois do painel fechado volta à lista, não a um estado do painel.
    await page.goBack();
    await comEsperaDe(/^#\/processos$/);
  });

  it('foco no título da tela, document.title sem número de processo, e o número nunca aparece na URL', async () => {
    amb = await iniciar();
    await abrirTela();
    await page.goto(amb.url + '/');
    await ate();
    await listaDeProcessos();
    await page.waitForFunction(() => document.activeElement?.tagName === 'H2');
    expect(await foco()).toBe('H2|Meus processos');
    expect(await titulo()).toBe('Meus processos · Processo Vivo');
    await abrirProcessoDaLista();
    await page.waitForFunction(() => document.activeElement?.classList.contains('num'));
    expect(await titulo()).toBe('Processo · Processo Vivo');
    await semNumeroNaUrl();
    await abrirPastaPeloBotao();
    await page.waitForFunction(() => document.activeElement?.id === 'pasta-titulo-geral');
    expect(await titulo()).toBe('Pasta digital · Processo Vivo');
    await semNumeroNaUrl();
    await page.click('#pf-p01');
    expect(await titulo()).toBe('Peça · Processo Vivo');
    await semNumeroNaUrl();
    // Voltar da peça para a lista da Pasta já aberta não rouba o foco para o título.
    await page.goBack();
    await comEsperaDe(/\/pasta$/);
    await page.click('#nav-calendario').catch(() => undefined);
  });

  it('as abas principais têm endereço próprio e o F5 mantém cada uma', async () => {
    amb = await iniciar();
    await abrirTela();
    await page.goto(amb.url + '/');
    await ate();
    const abas: Array<[string, string, string]> = [
      ['#nav-calendario', '#/calendario', 'Calendário'],
      ['#nav-custos', '#/custos', 'Custos'],
      ['#nav-buscar', '#/buscar', 'Buscar processo'],
      ['#nav-vigilancia', '#/vigilancia', 'Vigilância por OAB'],
      ['#nav-credenciais', '#/acessos', 'Meus acessos'],
    ];
    for (const [botao, rota, titulo2] of abas) {
      await page.click(botao);
      await comEsperaDe(new RegExp(`^${rota}$`));
      await page.waitForFunction(
        (t) => (document.querySelector('#conteudo h2')?.textContent ?? '').includes(t),
        titulo2,
      );
      await page.reload();
      await page.waitForFunction(
        (t) => (document.querySelector('#conteudo h2')?.textContent ?? '').includes(t),
        titulo2,
      );
      expect(await hash()).toBe(rota);
    }
    // Voltar anda pelas abas na ordem inversa.
    await page.goBack();
    await comEsperaDe(/^#\/vigilancia$/);
  });

  for (const largura of LARGURAS) {
    for (const escuro of [false, true]) {
      it(`${largura}px, tema ${escuro ? 'escuro' : 'claro'}: sem rolagem horizontal e axe limpo na lista, no processo e na Pasta`, async () => {
        amb = await iniciar();
        await abrirTela({ viewport: { width: largura, height: 900 }, escuro });
        await page.goto(amb.url + '/');
        await ate();
        await listaDeProcessos();
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const axe = async (seletor: string) => {
          // O ponteiro fica onde o último clique foi: sem tirá-lo, o botão que surge debaixo dele é medido no estado de hover.
          await page.mouse.move(0, 0);
          return page.evaluate(async (s) => {
            const r = await (window as unknown as AxeNaPagina).axe.run(
              document.querySelector(s)!,
              { rules: { 'color-contrast': { enabled: true } } },
            );
            return r.violations.map((v) => ({
              id: v.id,
              nos: v.nodes
                .map((n) => n.target.join(' ') + ' :: ' + (n.any[0]?.message ?? ''))
                .slice(0, 3),
            }));
          }, seletor);
        };
        const rolagem = () =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
        expect(await rolagem()).toBeLessThanOrEqual(0);
        expect(await axe('#conteudo')).toEqual([]);
        await abrirProcessoDaLista();
        expect(await rolagem()).toBeLessThanOrEqual(0);
        expect(await axe('#conteudo')).toEqual([]);
        await abrirPastaPeloBotao();
        expect(await rolagem()).toBeLessThanOrEqual(0);
        expect(await axe('#pasta')).toEqual([]);
        // O Voltar do navegador funciona em todas as larguras.
        await page.goBack();
        await comEsperaDe(/^#\/processo\/[a-z0-9]+$/);
        await page.waitForSelector('#pasta-abrir');
        expect(await page.locator('#pasta').count()).toBe(0);
        await semNumeroNaUrl();
      });
    }
  }
});
