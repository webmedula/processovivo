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
 * A coluna "Cumprido" (antes "Situação") e a caixa NUM NAVEGADOR (v0.37.5; refeita na v0.43.0 e na v0.46.0,
 * quando o texto de estado saiu e ficou só a caixa com a dica). O servidor e
 * o console são os reais; /v1/novidades, /v1/facetas e as rotas de cumprido são simuladas aqui com
 * dados SINTÉTICOS, com o mesmo contrato da API (a API tem teste próprio em
 * tests/http/cumprido.spec.ts). Nenhum teste espera tempo real: o aviso de 6 s corre no relógio
 * falso do Playwright.
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
    // Toda chamada de cumprido que a tela fez, na ordem (o contrato é o do botão antigo: POST com
    // { chaveDoAto } e DELETE sem corpo).
    const chamadas: Array<{ metodo: string; numero: string; corpo: unknown }> = [];
    // Com `segurar`, a resposta do servidor só sai quando o teste a libera.
    let liberar: (() => void) | null = null;

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
      opcoes: {
        largura?: number;
        escuro?: boolean;
        falhaNaMarca?: boolean;
        falha500?: boolean;
        segurar?: boolean;
        toque?: boolean;
      } = {},
    ): Promise<void> {
      reiniciar();
      dialogos.length = 0;
      chamadas.length = 0;
      liberar = null;
      ctx = await browser.newContext({
        viewport: { width: opcoes.largura ?? 1280, height: 900 },
        colorScheme: opcoes.escuro ? 'dark' : 'light',
        hasTouch: opcoes.toque ?? false,
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
        if (opcoes.falha500) {
          return rota.fulfill({ status: 500, json: { erro: 'INTERNO', mensagem: 'x' } });
        }
        chamadas.push({
          metodo: req.method(),
          numero: dig(numero),
          corpo: req.postData() ? JSON.parse(req.postData()!) : null,
        });
        if (opcoes.segurar) {
          await new Promise<void>((ok) => {
            liberar = ok;
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
    const caixa = (n: string) => ao(n).getByRole('checkbox', { name: /^Cumprido/ });
    const aviso = () => page.locator('#nvt-desfazer');
    const focoAtual = () =>
      page.evaluate(() => document.activeElement?.getAttribute('data-foco'));
    const aguardarLinhas = (n: number) =>
      page.waitForFunction(
        (esperado) =>
          document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === esperado,
        n,
      );
    // check()/uncheck() do Playwright conferem o estado DEPOIS do clique, e aqui a linha pode sair da lista (ou ser
    // redesenhada) antes dessa conferência; por isso, nesses casos, o teste clica.
    const todas = () => page.getByRole('button', { name: /^Todas \(/ }).click();

    it('abre só com as intimações/citações pendentes, com o selo do tipo e a segunda linha quando o ato é outro', async () => {
      await abrir();

      expect(await linhas().count()).toBe(2);
      const a = ao(NA);
      // (v0.37.6) O selo mora junto do rótulo do ato que gera a providência.
      expect(await a.locator('.c-atu .selo.int').textContent()).toBe('Intimação');
      expect(await ao(NB).locator('.c-atu .selo.int').textContent()).toBe('Citação');

      // A: a linha é sobre o "Ato ordinatório" (o que gera a providência); a
      // "Juntada de petição", que é o último andamento, vai numa segunda linha.
      expect(((await a.locator('.nvt-tit').textContent()) ?? '').trim()).toMatch(
        /^Ato ordinatório\s*Intimação$/,
      );
      const ult = ((await a.locator('.nvt-ult').textContent()) ?? '').replace(
        /\s+/g,
        ' ',
      );
      expect(ult).toMatch(/^Último andamento: Juntada de petição · \d{2}\/\d{2}\/\d{4}$/);
      expect(await a.locator('.nvt-por').count()).toBe(0);
      expect(await a.innerText()).not.toContain('Pede providência por');
      // B: é o mesmo ato — nada de segunda linha.
      expect(await ao(NB).locator('.nvt-ult').count()).toBe(0);

      // O que ficou de fora é dito: nada de "prazo" no texto novo.
      const texto = await resumo();
      expect(texto).toContain('1 sem marca há mais de 30 dias');
      expect(texto).not.toMatch(/prazo/i);
      expect(texto).not.toContain('marcado');
    });

    it('não há coluna "Cumprido": a caixa é o PRIMEIRO controle da coluna Ações, sem texto visível ao lado e sem caixa nas linhas sem providência (0.46.1)', async () => {
      await abrir();
      await todas();

      // Reescrito na 0.46.1: antes afirmava a coluna "Cumprido" (th.h-sit, td.c-sit); agora a coluna não existe.
      expect(await page.locator('th.h-sit, td.c-sit').count()).toBe(0);
      expect(await page.locator('thead th', { hasText: /^Cumprido$/ }).count()).toBe(0);

      // Linha que pede providência: a caixa DESMARCADA, na célula Ações, antes dos botões.
      const celula = ao(NA).locator('.c-acoes');
      expect(await celula.locator('input[type="checkbox"]').count()).toBe(1);
      expect(await caixa(NA).isChecked()).toBe(false);
      const ordem = await celula.evaluate((td) =>
        Array.from(td.querySelectorAll('.nvt-acoes input, .nvt-acoes button')).map(
          (e) => e.getAttribute('data-cx') ?? e.getAttribute('data-acao'),
        ),
      );
      expect(ordem).toEqual(['cumprido', 'abrir', 'pasta']);
      // Tabulação lógica: caixa, abrir, pasta (e depois o "Analisar com IA", que fica abaixo no mesmo grupo).
      await caixa(NA).focus();
      for (const esperado of ['abrir', 'pasta']) {
        await page.keyboard.press('Tab');
        expect(
          await page.evaluate(() => document.activeElement?.getAttribute('data-acao')),
        ).toBe(esperado);
      }
      // No desktop o rótulo "Cumprido" não aparece (só o empilhado o mostra): nada de texto ao lado da caixa.
      expect((await ao(NA).locator('.sit-cx').innerText()).trim()).toBe('');
      expect(
        await page.getByRole('button', { name: 'Marcar como cumprido' }).count(),
      ).toBe(0);

      // Sem providência: nenhuma caixa, mas a vaga reserva o lugar (ícones alinhados com os das outras linhas).
      expect(await ao(ND).locator('.c-acoes input').count()).toBe(0);
      expect(await ao(NC).locator('.c-acoes input').count()).toBe(0);
      const x = (n: string) =>
        ao(n)
          .locator('.c-acoes [data-acao="abrir"]')
          .evaluate((e) => Math.round(e.getBoundingClientRect().left));
      expect(await x(ND)).toBe(await x(NA));
      // O "sem marca há mais de 30 dias" segue como selo, agora na célula Atualização.
      expect(await ao(NC).locator('.c-atu .nvt-venceu').textContent()).toContain(
        'sem marca há mais de 30 dias',
      );
    });

    it('a dica: aparece com o mouse e com o foco (sem clique), diz o texto certo, não tapa a própria linha, não recebe o mouse e fecha com Esc', async () => {
      await abrir();
      await todas();
      // v0.49.2: a linha tem uma dica por ícone (copiar, abrir, pasta, IA); aqui a que importa é a da caixa "Cumprido".
      const dica = (n: string) => ao(n).locator('[id^="dica-cumprido-"]');
      // Escondida por padrão e ligada à caixa: role=tooltip + aria-describedby.
      expect(await dica(NA).getAttribute('role')).toBe('tooltip');
      expect(await dica(NA).isVisible()).toBe(false);
      const id = await dica(NA).getAttribute('id');
      expect(await caixa(NA).getAttribute('aria-describedby')).toBe(id);
      expect(await caixa(NA).getAttribute('title')).toBeNull();

      // Mouse: passar por cima, sem clicar.
      await ao(NA).locator('.sit-cx').hover();
      await dica(NA).waitFor({ state: 'visible' });
      expect(((await dica(NA).textContent()) ?? '').trim()).toBe(
        'Pede providência. Marque quando cumprida.',
      );
      expect(chamadas).toEqual([]);
      // Fica abaixo da caixa (não cobre a caixa nem a própria linha) e não recebe o mouse.
      const rc = (await ao(NA).locator('.sit-cx').boundingBox())!;
      const rd = (await dica(NA).boundingBox())!;
      expect(rd.y).toBeGreaterThanOrEqual(rc.y + rc.height - 1);
      expect(await dica(NA).evaluate((e) => getComputedStyle(e).pointerEvents)).toBe(
        'none',
      );
      // Esc fecha sem tirar o foco nem mudar nada.
      await page.mouse.move(0, 0);
      await caixa(NA).focus();
      await dica(NA).waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await dica(NA).waitFor({ state: 'hidden' });
      expect(await caixa(NA).evaluate((e) => document.activeElement === e)).toBe(true);
      expect(await caixa(NA).isChecked()).toBe(false);
      expect(chamadas).toEqual([]);
      // Sair do foco rearma a dica.
      await page.keyboard.press('Tab');
      await caixa(NA).focus();
      await dica(NA).waitFor({ state: 'visible' });

      // Foco pelo teclado também a mostra; e o aviso fixo da Pasta/IA não é tocado.
      await caixa(NB).focus();
      await dica(NB).waitFor({ state: 'visible' });
      expect(await dica(NA).isVisible()).toBe(false);
    });

    it('a dica da linha cumprida diz "Cumprida. Clique para desmarcar." e a da desmarcada volta ao texto de antes', async () => {
      await abrir();
      await todas();
      await caixa(NA).click();
      await aviso().getByRole('button', { name: 'Desfazer' }).waitFor();
      await page.mouse.move(0, 0);
      await ao(NA).locator('.sit-cx').hover();
      await ao(NA).locator('[id^="dica-cumprido-"]').waitFor({ state: 'visible' });
      expect(
        ((await ao(NA).locator('[id^="dica-cumprido-"]').textContent()) ?? '').trim(),
      ).toBe('Cumprida. Clique para desmarcar.');
      await caixa(NA).click();
      await page.waitForFunction(
        () => document.querySelector('#nvt-live')?.textContent === 'Desmarcado.',
      );
      expect(
        ((await ao(NA).locator('[id^="dica-cumprido-"]').textContent()) ?? '').trim(),
      ).toBe('Pede providência. Marque quando cumprida.');
    });

    it('em tela de toque a dica aparece depois de marcar (o foco volta à caixa) e o rótulo "Cumprido" fica VISÍVEL ao lado da caixa, no início do grupo de ações', async () => {
      await abrir({ largura: 390, toque: true });
      // Empilhado (0.46.1): a caixa abre o grupo de ações e a palavra "Cumprido" está à vista ao lado dela.
      expect((await ao(NA).locator('.sit-cx').innerText()).trim()).toBe('Cumprido');
      const alvo = (await ao(NA).locator('.sit-cx').boundingBox())!;
      expect(alvo.height).toBeGreaterThanOrEqual(44);
      await todas();
      await caixa(NA).tap();
      await aviso().getByRole('button', { name: 'Desfazer' }).waitFor();
      await ao(NA).locator('[id^="dica-cumprido-"]').waitFor({ state: 'visible' });
      expect(
        ((await ao(NA).locator('[id^="dica-cumprido-"]').textContent()) ?? '').trim(),
      ).toBe('Cumprida. Clique para desmarcar.');
      // Não estoura a janela.
      const r = (await ao(NA).locator('[id^="dica-cumprido-"]').boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(390);
    });

    it('marcar com o mouse faz a MESMA chamada do botão antigo, tira o processo da lista, avisa e leva o foco ao vizinho', async () => {
      await abrir();

      await ao(NA).locator('.sit-cx').click();
      await aguardarLinhas(1);

      // A chamada é a de sempre: POST com a chave opaca do ato que a tela mostrou.
      expect(chamadas).toEqual([
        {
          metodo: 'POST',
          numero: NA.replace(/\D/g, ''),
          corpo: { chaveDoAto: 'chave-Ato ordinatório-12' },
        },
      ]);
      expect(await numeros()).toHaveLength(1);
      const texto = await resumo();
      expect(texto).toContain('1 marcado como cumprido');
      expect(texto).toContain('1 sem marca há mais de 30 dias');
      expect(
        await page.getByRole('button', { name: 'Pedem providência (1)' }).count(),
      ).toBe(1);
      expect(await page.locator('#nvt-live').textContent()).toBe(
        '1 processo ainda pede providência.',
      );
      // O aviso: discreto, em role=status, com "Desfazer" focável — e FORA da tabela.
      expect(await aviso().getAttribute('role')).toBe('status');
      expect(((await aviso().innerText()) ?? '').replace(/\s+/g, ' ')).toBe(
        'Marcado como cumprido. Desfazer',
      );
      expect(await page.locator('.nvt-wrap #nvt-desfazer').count()).toBe(0);
      // Foco coerente: a caixa do processo que sobrou (o foco NÃO é roubado pelo aviso).
      expect(await focoAtual()).toBe(`cumprir-${NB}`);
      expect(dialogos).toEqual([]);
    });

    it('funciona só com o teclado: Tab chega à caixa, Espaço marca, Tab seguinte vai às ações da linha', async () => {
      await abrir();
      await caixa(NA).focus();
      // Foco visível na caixa (navegação por teclado liga :focus-visible).
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const contorno = await caixa(NA).evaluate((el) => {
        const c = getComputedStyle(el);
        return { estilo: c.outlineStyle, largura: parseFloat(c.outlineWidth) };
      });
      expect(contorno.estilo).not.toBe('none');
      expect(contorno.largura).toBeGreaterThanOrEqual(2);

      // Ordem de tabulação: caixa → ações da linha (abrir, pasta, IA fica fora quando desligada).
      await page.keyboard.press('Tab');
      expect(await focoAtual()).toBe(`abrir-${NA}`);
      await page.keyboard.press('Shift+Tab');

      await page.keyboard.press('Space');
      await aguardarLinhas(1);
      expect(chamadas.map((c) => c.metodo)).toEqual(['POST']);
      expect(await focoAtual()).toBe(`cumprir-${NB}`);
    });

    it('em "Todas", a linha marcada fica: caixa marcada, mais apagada, e desmarcar volta ao estado anterior', async () => {
      await abrir();
      await todas();
      expect(await linhas().count()).toBe(4);

      await caixa(NA).click();
      // Espera o servidor confirmar (o aviso nasce na confirmação): uma segunda mudança DURANTE o salvamento
      // é ignorada de propósito.
      await aviso().getByRole('button', { name: 'Desfazer' }).waitFor();
      await page.waitForFunction(() =>
        document.activeElement?.getAttribute('data-foco')?.startsWith('cumprir-'),
      );
      // Cumprida: só a caixa MARCADA (nenhum texto de estado), e a linha mais apagada.
      expect(await caixa(NA).isChecked()).toBe(true);
      expect((await ao(NA).locator('.sit-cx').innerText()).trim()).toBe('');
      expect(await ao(NA).getAttribute('class')).toContain('nvt-cumprida');
      // O conteúdo da linha segue à vista: só o título perde o peso.
      expect(await ao(NA).locator('.nvt-tit').isVisible()).toBe(true);
      // A caixa continua com o foco: dá para desmarcar sem procurar.
      expect(await focoAtual()).toBe(`cumprir-${NA}`);
      // A venceu-por-tempo aparece em Todas, dita, sem caixa.
      expect(await ao(NC).locator('.nvt-venceu').textContent()).toContain(
        'sem marca há mais de 30 dias',
      );

      await page.keyboard.press('Space');
      // O estado em texto muda antes (otimista); a chamada só está registrada quando o servidor confirma.
      await page.waitForFunction(
        () => document.querySelector('#nvt-live')?.textContent === 'Desmarcado.',
      );
      await page.waitForFunction(
        (n) =>
          !document
            .querySelector(`tr[data-processo="${n}"]`)
            ?.classList.contains('nvt-cumprida'),
        NA,
      );
      expect(chamadas.map((c) => c.metodo)).toEqual(['POST', 'DELETE']);
      expect(chamadas[1]).toEqual({
        metodo: 'DELETE',
        numero: NA.replace(/\D/g, ''),
        corpo: null,
      });
      expect(await caixa(NA).isChecked()).toBe(false);
      expect(await ao(NA).getAttribute('class')).not.toContain('nvt-cumprida');
      expect(await page.locator('#nvt-live').textContent()).toBe('Desmarcado.');
      expect(await focoAtual()).toBe(`cumprir-${NA}`);
    });

    it('a linha muda NA HORA, antes de o servidor responder (atualização otimista)', async () => {
      await abrir({ segurar: true });
      await todas();

      await caixa(NA).click();
      // O servidor ainda não respondeu: a chamada saiu e está presa.
      await page.waitForFunction(() => document.querySelector('tr.nvt-cumprida'));
      expect(await caixa(NA).isChecked()).toBe(true);
      expect(await caixa(NA).getAttribute('aria-busy')).toBe('true');
      expect(
        ((await ao(NA).locator('[id^="dica-cumprido-"]').textContent()) ?? '').trim(),
      ).toBe('Cumprida. Clique para desmarcar.');
      // Os contadores só mudam com a confirmação do servidor.
      expect(
        await page.getByRole('button', { name: 'Pedem providência (2)' }).count(),
      ).toBe(1);
      // Uma segunda mudança na mesma linha durante o salvamento é ignorada e a caixa volta ao que está sendo salvo.
      await caixa(NA).evaluate((el) => (el as HTMLInputElement).click());
      expect(await caixa(NA).isChecked()).toBe(true);

      liberar!();
      await page.getByRole('button', { name: 'Pedem providência (1)' }).waitFor();
      expect(chamadas).toHaveLength(1);
    });

    it('falha do servidor: a linha volta ao estado anterior e a tela diz "Não foi possível salvar. Tente de novo."', async () => {
      await abrir({ falha500: true });
      await ao(NA).locator('.sit-cx').click();
      await page.locator('.nvt-erro[role="alert"]').waitFor();
      expect(((await page.locator('.nvt-erro').textContent()) ?? '').trim()).toBe(
        'Não foi possível salvar. Tente de novo.',
      );
      expect(await linhas().count()).toBe(2);
      expect(await caixa(NA).isChecked()).toBe(false);
      expect(await caixa(NA).isEnabled()).toBe(true);
      expect(await ao(NA).getAttribute('class')).not.toContain('nvt-cumprida');
      expect(await aviso().innerText()).toBe('');
      expect(await focoAtual()).toBe(`cumprir-${NA}`);
    });

    it('409 (o ato saiu do retrato): a frase combinada e, junto, a explicação do servidor', async () => {
      await abrir({ falhaNaMarca: true });
      await caixa(NA).click();
      await page.locator('.nvt-erro[role="alert"]').waitFor();
      const txt = (await page.locator('.nvt-erro').textContent()) ?? '';
      expect(txt.startsWith('Não foi possível salvar. Tente de novo.')).toBe(true);
      expect(txt).toContain('Esse ato não está mais');
      expect(await linhas().count()).toBe(2);
      expect(await caixa(NA).isChecked()).toBe(false);
    });

    it('"Desfazer" do aviso desmarca (mesma chamada), devolve o processo à lista e fecha o aviso', async () => {
      await abrir();
      await ao(NA).locator('.sit-cx').click();
      await aguardarLinhas(1);

      await aviso().getByRole('button', { name: 'Desfazer' }).click();
      await aguardarLinhas(2);
      expect(chamadas.map((c) => c.metodo)).toEqual(['POST', 'DELETE']);
      expect(await ao(NA).getAttribute('class')).not.toContain('nvt-cumprida');
      expect(await caixa(NA).isChecked()).toBe(false);
      expect(await aviso().innerText()).toBe('');
      expect(await resumo()).not.toContain('marcado');
      expect(await page.locator('#nvt-live').textContent()).toBe('Desmarcado.');
      expect(await focoAtual()).toBe(`cumprir-${NA}`);
    });

    it('o aviso some sozinho em 6 s (relógio falso) e não prende o foco', async () => {
      await abrir();
      // Relógio PARADO: o aviso só envelhece quando o teste manda (nem a carga da máquina o faz expirar).
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 60_000));
      await ao(NA).locator('.sit-cx').click();
      await aguardarLinhas(1);
      expect(await aviso().innerText()).toContain('Marcado como cumprido.');

      // O foco entra no "Desfazer" pelo teclado; quando o aviso expira, ele não fica no vazio.
      await aviso().getByRole('button', { name: 'Desfazer' }).focus();
      await page.clock.runFor(5_900);
      expect(await aviso().innerText()).toContain('Marcado como cumprido.');
      await page.clock.runFor(200);
      expect(await aviso().innerText()).toBe('');
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(
        false,
      );
      // Nada foi desfeito pelo tempo.
      expect(chamadas.map((c) => c.metodo)).toEqual(['POST']);
      expect(await resumo()).toContain('1 marcado como cumprido');
    });

    it('Esc fecha o aviso quando o foco está nele', async () => {
      await abrir();
      await ao(NA).locator('.sit-cx').click();
      await aguardarLinhas(1);
      await aviso().getByRole('button', { name: 'Desfazer' }).focus();
      await page.keyboard.press('Escape');
      expect(await aviso().innerText()).toBe('');
      expect(chamadas.map((c) => c.metodo)).toEqual(['POST']);
    });

    it('"Ver" lista os marcados com a caixa marcada; desmarcar o último volta ao filtro de providência, sem confirmação nem alert', async () => {
      await abrir();
      await ao(NA).locator('.sit-cx').click();
      await aguardarLinhas(1);

      await page.getByRole('button', { name: 'Ver', exact: true }).click();
      expect(await linhas().count()).toBe(1);
      expect(await ao(NA).getAttribute('class')).toContain('nvt-cumprida');
      expect(await caixa(NA).isChecked()).toBe(true);
      expect(await resumo()).toContain('1 processo marcado como cumprido');

      // Sem a antiga confirmação "Sim, desfazer": a caixa é o desfazer.
      await caixa(NA).click();
      await aguardarLinhas(2);
      expect(await page.getByRole('button', { name: 'Sim, desfazer' }).count()).toBe(0);
      expect(await caixa(NA).isChecked()).toBe(false);
      expect(await resumo()).not.toContain('marcado');
      expect(dialogos).toEqual([]);
    });

    it('filtro, contagem e frases seguem coerentes depois de marcar e desmarcar', async () => {
      await abrir();
      const chip = (n: number) =>
        page.getByRole('button', { name: `Pedem providência (${n})` });
      expect(await chip(2).count()).toBe(1);
      await caixa(NA).click();
      await aguardarLinhas(1);
      expect(await chip(1).count()).toBe(1);
      await caixa(NB).click();
      await page.locator('.nvt-sem-prov').waitFor();
      expect(await chip(0).count()).toBe(1);
      expect(await page.locator('.nvt-sem-prov').innerText()).toContain(
        'Nenhum processo pede providência agora.',
      );
      await page.getByRole('button', { name: 'Ver', exact: true }).first().click();
      await caixa(NA).click();
      await aguardarLinhas(1);
      await page
        .getByRole('button', { name: 'Voltar aos que pedem providência' })
        .click();
      expect(await chip(1).count()).toBe(1);
      expect(await numeros()).toHaveLength(1);
    });

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${largura}px: com a caixa, com o aviso, em Todas e nos marcados`, async () => {
        await abrir({ largura });
        const medir = (): Promise<{ sw: number; cw: number }> =>
          page.evaluate(() => ({
            sw: document.documentElement.scrollWidth,
            cw: document.documentElement.clientWidth,
          }));
        let m = await medir();
        expect(m.sw).toBeLessThanOrEqual(m.cw);

        await ao(NA).locator('.sit-cx').click();
        await aguardarLinhas(1);
        expect(await aviso().innerText()).toContain('Desfazer');
        m = await medir();
        expect(m.sw).toBeLessThanOrEqual(m.cw);

        await page.getByRole('button', { name: 'Ver', exact: true }).click();
        m = await medir();
        expect(m.sw).toBeLessThanOrEqual(m.cw);

        await page
          .getByRole('button', { name: 'Voltar aos que pedem providência' })
          .click();
        await todas();
        m = await medir();
        expect(m.sw).toBeLessThanOrEqual(m.cw);

        // Com a dica aberta a página também não ganha rolagem horizontal.
        await ao(NB).locator('.sit-cx').hover();
        await ao(NB).locator('[id^="dica-cumprido-"]').waitFor({ state: 'visible' });
        await caixa(NB).focus();
        m = await medir();
        expect(m.sw, 'dica aberta').toBeLessThanOrEqual(m.cw);

        // Alvo da caixa: 24 px no mínimo em qualquer largura; 44 no empilhado (toque).
        const alvo = await ao(NB).locator('.sit-cx').boundingBox();
        expect(alvo!.height).toBeGreaterThanOrEqual(largura < 1024 ? 44 : 24);
        expect(alvo!.width).toBeGreaterThanOrEqual(24);
      });
    }

    it('a caixa em Ações tem alvo de toque de pelo menos 24 px e não aumenta a linha, nem com a dica aberta', async () => {
      await abrir({ largura: 1366 });
      const r0 = await ao(NB)
        .locator('td.c-acoes .sit-cx')
        .evaluate((el) => el.getBoundingClientRect());
      expect(r0.height).toBeGreaterThanOrEqual(24);
      expect(r0.width).toBeGreaterThanOrEqual(24);
      expect(r0.height).toBeLessThanOrEqual(34);
      // A dica é absoluta: não aumenta a linha.
      const linhaAntes = (await ao(NB).boundingBox())!.height;
      await ao(NB).locator('.sit-cx').hover();
      await ao(NB).locator('[id^="dica-cumprido-"]').waitFor({ state: 'visible' });
      expect((await ao(NB).boundingBox())!.height).toBe(linhaAntes);
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): caixas, dica, aviso, "Todas" com cumprido`, async () => {
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
        expect(await rodar(), 'padrão (caixas desmarcadas)').toBe('');

        // A dica visível (foco na caixa) também passa no contraste.
        await caixa(NA).focus();
        await ao(NA).locator('[id^="dica-cumprido-"]').waitFor({ state: 'visible' });
        expect(await rodar(), 'dica visível').toBe('');

        await ao(NA).locator('.sit-cx').click();
        await aguardarLinhas(1);
        expect(await rodar(), 'depois de marcar (com o aviso)').toBe('');

        await page.getByRole('button', { name: 'Ver', exact: true }).click();
        expect(await rodar(), 'Ver (linha cumprida)').toBe('');

        await page
          .getByRole('button', { name: 'Voltar aos que pedem providência' })
          .click();
        await todas();
        expect(await rodar(), 'Todas (pede, cumprido e sem providência)').toBe('');
        // A linha cumprida (mais apagada) segue com contraste de texto: o axe acima a conferiu em "Todas".
        expect(await ao(NA).getAttribute('class')).toContain('nvt-cumprida');
      });
    }
  },
);
