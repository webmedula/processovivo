/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';
import { PROCESSO_TJGO } from '../helpers/leitor.js';
import { esperarConsolePronto } from './console.js';

/*
 * "Resumir este processo com IA" NUM NAVEGADOR (v0.40.1). O servidor e o console são os
 * reais; a rota do processo, a disponibilidade da IA e as rotas do resumo são simuladas com
 * dados SINTÉTICOS e o mesmo contrato da API (a API tem teste próprio em
 * tests/http/resumo-ia.spec.ts). Nenhuma chamada a modelo, nenhuma rede.
 */
const sem = CHROMIUM === undefined;
const DIA = 86_400_000;
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
interface Console_ {
  __pv?: { abrir(numero: string): void };
}

const TEXTO_INTIMACAO =
  'Intime-se a parte autora para que se manifeste sobre o laudo pericial juntado aos autos.';
const MOVS = [
  {
    data: iso(1),
    titulo: 'Intimação',
    conteudo: TEXTO_INTIMACAO,
    exigeAcao: true,
    fonte: 'djen',
  },
  {
    data: iso(8),
    titulo: 'Ato ordinatório',
    conteudo: 'Expeça-se ofício ao banco informado, que deverá responder em quinze dias.',
    fonte: 'djen',
  },
  {
    data: iso(40),
    titulo: 'Sentença',
    conteudo: 'Julgo parcialmente procedentes os pedidos formulados.',
    fonte: 'djen',
  },
];
const PROCESSO = {
  numero: PROCESSO_TJGO,
  tribunal: 'TJGO',
  classe: 'Procedimento Comum Cível',
  vara: '1ª Vara Cível',
  dataDistribuicao: iso(900),
  partes: [],
  movimentacoes: MOVS,
  procedencia: { provider: 'datajud+djen', consultadoEm: iso(0), deCache: false },
};

const ATO_1 = {
  chaveDoAto: 'chave-1',
  data: MOVS[0]!.data,
  rotulo: 'Intimação',
  tipoDaComunicacao: 'Intimação',
};
const ATO_2 = {
  chaveDoAto: 'chave-2',
  data: MOVS[1]!.data,
  rotulo: 'Ato ordinatório',
  tipoDaComunicacao: 'Intimação',
};
const ATUALIDADE_LIDO = {
  maisRecente: {
    data: MOVS[0]!.data,
    rotulo: 'Intimação',
    tipoDaComunicacao: 'Intimação',
    lido: true,
  },
  providenciasNaoLidas: [],
  providenciasNaoLidasTotal: 0,
  tribunalMaisNovo: null,
};
const RESULTADO = {
  estado: 'verificado',
  id: 'resumo-1',
  atualidade: ATUALIDADE_LIDO,
  situacao: [
    {
      texto: 'A parte autora foi intimada a se pronunciar sobre o laudo pericial.',
      trecho: 'se manifeste sobre o laudo pericial',
      ato: ATO_1,
    },
    {
      texto: 'Antes, foi determinado oficiar o banco informado.',
      trecho: 'Expeça-se ofício ao banco informado',
      ato: ATO_2,
    },
  ],
  pendencias: [
    {
      texto: 'Parte autora: apresentar manifestação sobre o laudo, em quinze dias',
      trecho: 'se manifeste sobre o laudo pericial',
      ato: ATO_1,
    },
  ],
  pontosDeAtencao: ['texto_incompleto'],
  contagens: {
    atosNoProcesso: 60,
    atosComTexto: 10,
    atosSoTitulo: 40,
    foraDoResumo: 10,
    itensDescartados: 2,
    providenciasDoSistema: 3,
    providenciasNaoCitadas: 2,
  },
  modelo: 'modelo/teste',
  versaoPrompt: 'resumo-1.2.0',
  provedor: 'provedor-teste',
  criadaEm: '2026-10-05T12:00:00.000Z',
  avaliacao: null,
};
const AVISO_FIXO =
  'Resumo automático, apoio à leitura. Confira os atos e conte os prazos você mesmo.';

describe.skipIf(sem)(
  'Resumir este processo com IA, no navegador',
  { timeout: 120_000 },
  () => {
    let browser: Browser;
    let amb: Ambiente;
    let ctx: BrowserContext;
    let page: Page;
    let pedidos: Array<{ metodo: string; url: string; temCorpo: boolean; tipo: string }>;
    let outrosPosts: string[];
    let avaliacoes: Array<{ id: string; corpo: unknown }>;
    let falhas: string[];
    let responder: (rota: Route) => Promise<void>;
    let avaliacaoFalha = false;
    /** Segura a rota das peças do tribunal até o teste soltar (força o redesenho da tela). */
    let liberarPecas: () => void;

    const json = (rota: Route, status: number, corpo: unknown): Promise<void> =>
      rota.fulfill({ status, json: corpo });

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
      liberarPecas?.();
      await ctx?.close();
    });

    async function abrir(
      opcoes: {
        habilitada?: boolean;
        acompanhado?: boolean;
        largura?: number;
        escuro?: boolean;
        pecasReais?: boolean;
      } = {},
    ): Promise<void> {
      pedidos = [];
      outrosPosts = [];
      avaliacoes = [];
      falhas = [];
      avaliacaoFalha = false;
      // O portão existe desde já: soltar antes ou depois de o pedido chegar dá no mesmo.
      const portao = new Promise<void>((r) => (liberarPecas = r));
      responder = (rota) => json(rota, 200, RESULTADO);
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
      await ctx.route('**/v1/analises/disponibilidade', (rota) =>
        json(rota, 200, { habilitada: opcoes.habilitada ?? true }),
      );
      if (opcoes.acompanhado ?? true) {
        await ctx.route(
          (u) => u.pathname === `/v1/acompanhamentos/${PROCESSO_TJGO}`,
          (rota) =>
            rota.request().method() === 'GET'
              ? json(rota, 200, { processo: PROCESSO, sincronizadoEm: iso(0) })
              : rota.fallback(),
        );
      } else {
        await ctx.route(
          (u) => u.pathname === `/v1/acompanhamentos/${PROCESSO_TJGO}`,
          (rota) =>
            rota.request().method() === 'GET'
              ? json(rota, 404, { erro: 'ACOMPANHAMENTO_NAO_ENCONTRADO', mensagem: 'x' })
              : rota.fallback(),
        );
      }
      // Sem a régua do tribunal, a linha do tempo é a do retrato (a que os testes conhecem);
      // com ela (`pecasReais`), o redesenho da tela acontece quando o teste soltar a resposta.
      await ctx.route('**/v1/processos/*/pecas', async (rota) => {
        if (!opcoes.pecasReais) return json(rota, 500, { erro: 'x', mensagem: 'x' });
        await portao;
        // Resposta sintética (a rota real do servidor está sujeita ao limite de requisições por
        // chave, que uma suíte inteira de navegador gasta): régua do tribunal, como no MNI.
        await json(rota, 200, {
          jaBaixadas: [],
          linhaDoTempo: {
            resumo: { espinha: 'tribunal', pecasAcopladas: 0 },
            eventos: MOVS,
            pecasSoltas: [],
          },
        });
      });
      await ctx.route('**/v1/acompanhamentos/*/resumo', async (rota) => {
        const req = rota.request();
        pedidos.push({
          metodo: req.method(),
          url: req.url(),
          temCorpo: req.postData() !== null,
          tipo: req.headers()['content-type'] ?? '',
        });
        await responder(rota);
      });
      await ctx.route('**/v1/resumos/*/avaliacao', async (rota) => {
        const id = rota.request().url().split('/v1/resumos/')[1]!.split('/')[0]!;
        avaliacoes.push({ id, corpo: rota.request().postDataJSON() as unknown });
        if (avaliacaoFalha) return json(rota, 500, { erro: 'x', mensagem: 'x' });
        const c = rota.request().postDataJSON() as { avaliacao: string };
        return json(rota, 200, { id, avaliacao: c.avaliacao });
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      page.on('requestfailed', (r) => falhas.push(r.url()));
      page.on('request', (r) => {
        if (
          r.method() === 'POST' &&
          !/\/resumo$|\/avaliacao$|marcar-vistas/.test(r.url())
        )
          outrosPosts.push(r.url());
      });
      const facetas = page.waitForResponse('**/v1/facetas');
      await page.goto(amb.url + '/');
      await esperarConsolePronto(page);
      // A tela inicial termina de carregar ANTES de abrir o processo: abrir no meio da carga
      // deixa a resposta tardia dela pintar por cima (corrida que só aparece com a máquina ocupada).
      await facetas;
      await page.waitForFunction(() => {
        const c = document.getElementById('conteudo');
        return !!c && c.children.length > 0 && !c.querySelector('.gira, .nvt-esq');
      });
      await irAoProcesso();
    }

    async function irAoProcesso(): Promise<void> {
      await page.evaluate(
        (n) => (window as unknown as Console_).__pv!.abrir(n),
        PROCESSO_TJGO,
      );
      await page.waitForSelector('#conteudo .capa');
    }

    const botao = () => page.locator('#pvres-abrir');
    const painel = () => page.locator('#pvres-painel');
    const resumir = async (): Promise<void> => {
      await botao().click();
      // O título da primeira seção muda quando o ato mais recente não foi lido (v0.54.0).
      await painel().locator('.pvres-sec').first().waitFor();
    };
    const SEM_PRAZO = (t: string): string =>
      t.replace(AVISO_FIXO, '').replace(/Conferir o prazo no processo\./g, '');

    it('IA desligada: nenhum botão na capa', async () => {
      await abrir({ habilitada: false });
      await page.waitForSelector('#parar');
      // Dá tempo de a pergunta de disponibilidade terminar.
      await page.waitForFunction(() => true);
      expect(await botao().count()).toBe(0);
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(
        'Resumir este processo com IA',
      );
    });

    it('processo que não é acompanhado (consulta avulsa): sem botão', async () => {
      await abrir({ acompanhado: false });
      await page.waitForSelector('#acompanhar');
      await page.waitForFunction(() => true);
      expect(await page.locator('#parar').count()).toBe(0);
      expect(await botao().count()).toBe(0);
    });

    it('processo acompanhado com a IA ligada: botão ao lado de "Deixar de acompanhar", fechado por padrão', async () => {
      await abrir();
      await botao().waitFor();
      expect(await botao().textContent()).toBe('Resumir este processo com IA');
      expect(await botao().getAttribute('aria-expanded')).toBe('false');
      expect(await botao().getAttribute('aria-controls')).toBe('pvres-painel');
      // Mesma fileira da capa, logo depois do "Deixar de acompanhar".
      expect(await botao().evaluate((e) => e.previousElementSibling?.id)).toBe('parar');
      expect(await painel().count()).toBe(0);
    });

    it('o pedido não leva corpo nem tipo de conteúdo: o texto é lido pelo servidor', async () => {
      await abrir();
      await resumir();
      expect(pedidos).toHaveLength(1);
      expect(pedidos[0]).toMatchObject({ metodo: 'POST', temCorpo: false, tipo: '' });
      expect(pedidos[0]!.url).toContain(
        `/v1/acompanhamentos/${encodeURIComponent(PROCESSO_TJGO.replace(/\D/g, ''))}/resumo`,
      );
    });

    it('resumindo: painel logo sob a capa, foco nele, aviso de até 2 minutos e Cancelar que aborta a requisição', async () => {
      await abrir();
      let solta: () => void = () => {};
      const segurar = new Promise<void>((r) => (solta = r));
      responder = async (rota) => {
        await segurar;
        await json(rota, 200, RESULTADO).catch(() => undefined);
      };
      await botao().click();
      await painel().waitFor();
      expect(
        await page
          .locator('#pvres-raiz')
          .evaluate((e) => e.previousElementSibling?.classList.contains('capa')),
      ).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pvres-painel');
      expect(await botao().getAttribute('aria-expanded')).toBe('true');
      expect(await painel().getAttribute('aria-busy')).toBe('true');
      expect(await painel().innerText()).toContain(
        'Resumindo o processo… isso pode levar até 2 minutos.',
      );
      await page.waitForFunction(() =>
        document.getElementById('pvres-live')?.textContent?.includes('2 minutos'),
      );

      await painel().getByRole('button', { name: 'Cancelar' }).click();
      await page.waitForFunction(() => !document.getElementById('pvres-painel'));
      expect(await botao().getAttribute('aria-expanded')).toBe('false');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pvres-abrir');
      await page.waitForFunction(
        () => document.getElementById('pvres-live')?.textContent === 'Resumo cancelado.',
      );
      solta();
      expect(falhas.some((u) => u.includes('/resumo'))).toBe(true);
    });

    const ABERTO = (): Promise<boolean> =>
      painel()
        .locator('details.pvres-det')
        .evaluate((e) => (e as HTMLDetailsElement).open);
    const polegar = (qual: 'cima' | 'baixo') =>
      painel().getByRole('button', {
        name: qual === 'cima' ? 'Resultado útil' : 'Resultado com problema',
      });

    it('resultado conciso: Situação, o que pede providência, Detalhes recolhido, aviso e polegares, nessa ordem e sem faixa quando o mais recente foi lido', async () => {
      await abrir();
      await resumir();
      const p = painel();
      expect(await p.getAttribute('aria-busy')).toBe('false');
      expect(await p.locator('.pvres-faixa').count()).toBe(0);
      const ordem = await p.evaluate((el) => {
        const marcas: Array<[string, string]> = [
          ['.pvres-sec:nth-of-type(1)', 'situacao'],
          ['.pvres-pend', 'providencia'],
          ['.pvres-det', 'detalhes'],
          ['.pvres-aviso', 'aviso'],
          ['.pvpol', 'polegares'],
        ];
        return marcas
          .map(([q, nome]) => {
            const n = el.querySelector(q);
            return n
              ? { nome, y: n.getBoundingClientRect().top }
              : { nome, y: Number.NaN };
          })
          .sort((a, b) => a.y - b.y)
          .map((x) => x.nome);
      });
      expect(ordem).toEqual([
        'situacao',
        'providencia',
        'detalhes',
        'aviso',
        'polegares',
      ]);
      expect(
        await p.locator('h4').evaluateAll((l) => l.map((h) => h.textContent)),
      ).toEqual(['Situação', 'O que pede providência']);
      expect(await ABERTO()).toBe(false);
    });

    it('situação: cada item com a data do ato (do sistema), a citação recolhida em "Ver trecho" e o caminho até o ato', async () => {
      await abrir();
      await resumir();
      const itens = painel().locator('.pvres-sec').first().locator('li');
      expect(await itens.count()).toBe(2);
      expect(await itens.nth(0).innerText()).toMatch(
        /^\d{2}\/\d{2}\/\d{4}\s+A parte autora foi intimada a se pronunciar sobre o laudo pericial\./,
      );
      const cit = itens.nth(0).locator('details.pvres-cit');
      expect(await cit.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
      await cit.locator('summary').click();
      expect(await cit.locator('mark').textContent()).toBe(
        'se manifeste sobre o laudo pericial',
      );
      expect(await cit.getByRole('button').textContent()).toMatch(
        /^\d{2}\/\d{2}\/\d{4} · Intimação$/,
      );
      // O tipo só aparece quando é diferente do rótulo.
      await itens.nth(1).locator('summary').click();
      expect(await itens.nth(1).getByRole('button').textContent()).toMatch(
        /^\d{2}\/\d{2}\/\d{4} · Ato ordinatório · Intimação$/,
      );
    });

    it('o que pede providência: uma linha por item com data e tipo do sistema; o prazo só aparece porque está escrito no texto', async () => {
      await abrir();
      await resumir();
      const pend = painel().locator('.pvres-pend');
      expect(await pend.locator('h4').textContent()).toBe('O que pede providência');
      const itens = pend.locator('ul.pvres-itens > li');
      expect(await itens.count()).toBe(1);
      expect(await itens.nth(0).locator('.pvres-texto').innerText()).toMatch(
        /^\d{2}\/\d{2}\/\d{4} · Intimação — Parte autora: apresentar manifestação sobre o laudo, em quinze dias$/,
      );
      expect(await pend.innerText()).not.toMatch(/vence|até \d/i);
    });

    it('sem pendência e sem providência do sistema: diz que nenhuma foi indicada nos atos lidos', async () => {
      await abrir();
      responder = (rota) => json(rota, 200, { ...RESULTADO, pendencias: [] });
      await resumir();
      expect(await painel().locator('.pvres-pend').innerText()).toContain(
        'Nenhuma providência indicada nos atos lidos.',
      );
    });

    it('a marcação de providência do sistema (linha do tempo) não muda com o resumo', async () => {
      await abrir();
      const marcas = page.locator('#conteudo .ev.pede');
      await marcas.first().waitFor();
      const antes = await marcas.evaluateAll((l) => l.map((e) => e.innerHTML));
      expect(antes.length).toBeGreaterThan(0);
      expect(await page.locator('#conteudo .cartao.alerta').count()).toBe(0);
      await resumir();
      expect(await marcas.evaluateAll((l) => l.map((e) => e.innerHTML))).toEqual(antes);
      expect(await painel().locator('.alerta').count()).toBe(0);
    });

    describe('Detalhes', () => {
      it('recolhido; abre por teclado e traz o que foi lido, as providências do sistema e a hora — sem a contagem de descartes', async () => {
        await abrir();
        await resumir();
        const resumo = painel().locator('details.pvres-det > summary');
        await resumo.focus();
        await page.keyboard.press('Enter');
        expect(await ABERTO()).toBe(true);
        const t = await painel().locator('details.pvres-det').innerText();
        expect(t).toMatch(
          /Este resumo usou o texto de 10 atos recentes, entre eles o mais recente \(\d{2}\/\d{2}\/\d{4}\)\. 40 atos têm só o título e 10 atos não foram lidos\./,
        );
        expect(t).toContain(
          'Atos que o sistema marca como pedem providência: 3 (1 citado neste resumo).',
        );
        expect(t).toMatch(/Gerado por IA em .+\./);
        expect(t).toContain(
          'Alguns pontos não puderam ser confirmados no texto e foram omitidos.',
        );
        expect(t).not.toMatch(/descartad/i);
        expect(t).not.toContain('modelo/teste');
        expect(t).not.toContain('provedor-teste');
        await page.keyboard.press('Space');
        expect(await ABERTO()).toBe(false);
      });

      it('sem descarte, nenhuma linha sobre omissão', async () => {
        await abrir();
        responder = (rota) =>
          json(rota, 200, {
            ...RESULTADO,
            contagens: { ...RESULTADO.contagens, itensDescartados: 0 },
          });
        await resumir();
        const t = await painel().locator('details.pvres-det').textContent();
        expect(t).not.toContain('omitidos');
      });

      it('a frase do que foi lido concorda em número (0, 1 e vários)', async () => {
        const rodar = async (c: object): Promise<string> => {
          await abrir();
          responder = (rota) =>
            json(rota, 200, {
              ...RESULTADO,
              contagens: { ...RESULTADO.contagens, ...c },
            });
          await resumir();
          return (
            (await painel().locator('details.pvres-det > p').first().textContent()) ?? ''
          );
        };
        expect(
          await rodar({ atosComTexto: 1, atosSoTitulo: 1, foraDoResumo: 1 }),
        ).toMatch(
          /Este resumo usou o texto de 1 ato recente, entre eles o mais recente \(\d{2}\/\d{2}\/\d{4}\)\. 1 ato tem só o título e 1 ato não foi lido\.$/,
        );
        await ctx.close();
        expect(
          await rodar({ atosComTexto: 3, atosSoTitulo: 0, foraDoResumo: 0 }),
        ).toMatch(
          /usou o texto de 3 atos recentes, entre eles o mais recente \(\d{2}\/\d{2}\/\d{4}\)\.$/,
        );
        await ctx.close();
        expect(
          await rodar({ atosComTexto: 2, atosSoTitulo: 2, foraDoResumo: 0 }),
        ).toMatch(/\. 2 atos têm só o título\.$/);
      });
    });

    describe('faixa do sistema e ato mais recente', () => {
      const NAO_LIDO = {
        maisRecente: {
          data: iso(1),
          rotulo: 'Despacho',
          tipoDaComunicacao: null,
          lido: false,
        },
        providenciasNaoLidas: [
          {
            data: iso(1),
            rotulo: 'Despacho',
            tipoDaComunicacao: null,
            motivo: 'teor_indisponivel',
          },
          {
            data: iso(6),
            rotulo: 'Intimação',
            tipoDaComunicacao: 'Intimação',
            motivo: 'sem_texto',
          },
        ],
        providenciasNaoLidasTotal: 2,
        tribunalMaisNovo: null,
      };
      const com = (atualidade: unknown, extra: object = {}) => ({
        ...RESULTADO,
        atualidade,
        pontosDoAto: [{ codigo: 'ato_depende_de_outro_documento', ato: ATO_2 }],
        ...extra,
      });

      it('mais recente NÃO lido: a faixa avisa, o resto vem de atos mais antigos, o título muda e a faixa vem antes da situação', async () => {
        await abrir();
        responder = (rota) => json(rota, 200, com(NAO_LIDO));
        await resumir();
        const faixa = painel().locator('.pvres-faixa');
        const t = await faixa.innerText();
        expect(t).toMatch(
          /O ato mais recente \(\d{2}\/\d{2}\/\d{4}, Despacho\) não foi lido; confira-o na linha do tempo\./,
        );
        expect(t).toContain('não é a situação atual');
        expect(
          await painel()
            .getByRole('heading', { name: 'O que os atos lidos mostram' })
            .count(),
        ).toBe(1);
        expect(await painel().getByRole('heading', { name: 'Situação' }).count()).toBe(0);
        const antes = await faixa.evaluate(
          (el) =>
            el.compareDocumentPosition(document.querySelector('.pvres-sec')!) ===
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
        expect(antes).toBe(true);
      });

      it('providência do sistema sem leitura: nunca "sem pendências"; a lista está nos Detalhes, com data, tipo e motivo', async () => {
        await abrir();
        responder = (rota) => json(rota, 200, com(NAO_LIDO, { pendencias: [] }));
        await resumir();
        const pend = await painel().locator('.pvres-pend').innerText();
        expect(pend).toContain(
          '2 atos que o sistema marca como pedem providência não foram lidos. Veja em Detalhes',
        );
        expect(pend).not.toContain('Nenhuma providência indicada');
        const det = await painel().locator('details.pvres-det').textContent();
        expect(det).toMatch(
          /\d{2}\/\d{2}\/\d{4} · Despacho \(o tribunal não liberou o texto\)/,
        );
        expect(det).toMatch(/\d{2}\/\d{2}\/\d{4} · Intimação \(sem texto\)/);
        expect(det).toMatch(/mas não o mais recente \(\d{2}\/\d{2}\/\d{4}\)/);
      });

      it('um ato sem leitura concorda no singular', async () => {
        await abrir();
        responder = (rota) =>
          json(
            rota,
            200,
            com(
              {
                ...NAO_LIDO,
                providenciasNaoLidas: NAO_LIDO.providenciasNaoLidas.slice(0, 1),
                providenciasNaoLidasTotal: 1,
              },
              { pendencias: [] },
            ),
          );
        await resumir();
        expect(await painel().locator('.pvres-pend').innerText()).toContain(
          '1 ato que o sistema marca como pede providência não foi lido.',
        );
      });

      it('mais recente lido e a Pasta digital com ato mais novo: faixa discreta, sem alerta', async () => {
        await abrir();
        responder = (rota) =>
          json(
            rota,
            200,
            com({
              ...ATUALIDADE_LIDO,
              tribunalMaisNovo: {
                data: iso(0),
                rotulo: 'Conclusos para decisão',
                listadaEm: iso(0),
              },
            }),
          );
        await resumir();
        const faixa = painel().locator('.pvres-faixa');
        expect(await faixa.innerText()).toMatch(
          /A Pasta digital \(carregada em \d{2}\/\d{2}\/\d{4}\) lista um ato mais novo, de \d{2}\/\d{2}\/\d{4}: Conclusos para decisão\. O resumo não o leu/,
        );
        expect(await painel().locator('.pvres-faixa-alerta').count()).toBe(0);
      });

      it('o ponto "depende de outro documento" diz de QUAL ato (data e tipo do sistema), nos Detalhes', async () => {
        await abrir();
        responder = (rota) => json(rota, 200, com(ATUALIDADE_LIDO));
        await resumir();
        const t = await painel().locator('details.pvres-det').textContent();
        expect(t).toMatch(
          /O ato de \d{2}\/\d{2}\/\d{4} · Ato ordinatório · Intimação depende de outro documento\./,
        );
      });

      it('resposta de servidor antigo (sem faixa): a tela continua inteira', async () => {
        await abrir();
        const { atualidade: _a, ...semFaixa } = RESULTADO;
        void _a;
        responder = (rota) => json(rota, 200, semFaixa);
        await resumir();
        expect(await painel().locator('.pvres-faixa').count()).toBe(0);
        expect(await painel().getByRole('heading', { name: 'Situação' }).count()).toBe(1);
      });
    });

    it('aviso fixo em uma linha, sem o nome do modelo, e a palavra "prazo" só no aviso fixo e no ponto de atenção', async () => {
      await abrir();
      await resumir();
      const t = await painel().innerText();
      expect(t).toContain(AVISO_FIXO);
      expect(t).not.toContain('modelo/teste');
      expect(SEM_PRAZO(t)).not.toMatch(/prazo/i);
      const nLinhas = await painel()
        .locator('.pvres-aviso')
        .evaluate((e) =>
          Math.round(
            e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight),
          ),
        );
      expect(nLinhas).toBeLessThanOrEqual(2);
    });

    it('nada é criado: nenhum pedido além do resumo e da avaliação', async () => {
      await abrir();
      await resumir();
      await polegar('cima').click();
      await page.waitForFunction(
        () => document.querySelector('.pvpol-b[aria-pressed="true"]') !== null,
      );
      expect(outrosPosts).toEqual([]);
      expect(
        await painel()
          .getByRole('button', { name: /aviso|calendário|criar/i })
          .count(),
      ).toBe(0);
    });

    it('o link do ato leva à linha do tempo: rola, destaca e põe o foco no andamento', async () => {
      await abrir();
      await resumir();
      await painel().locator('details.pvres-cit summary').first().click();
      await painel().locator('.pvres-ato button').first().click();
      const alvo = page.locator('.ev.pvres-alvo');
      await alvo.waitFor();
      expect(await alvo.locator('.tt').first().textContent()).toContain('Intimação');
      expect(await alvo.getAttribute('data-quando')).toBe(MOVS[0]!.data);
      expect(
        await page.evaluate(() => document.activeElement?.classList.contains('ev')),
      ).toBe(true);
      await page.keyboard.press('Tab');
      await page.waitForFunction(
        () => document.querySelectorAll('.ev.pvres-alvo').length === 0,
      );
    });

    it('ato que não está na linha do tempo (recolhido ou filtrado): a tela diz isso em vez de rolar para lugar nenhum', async () => {
      await abrir();
      responder = (rota) =>
        json(rota, 200, {
          ...RESULTADO,
          situacao: [
            {
              ...RESULTADO.situacao[0]!,
              ato: { ...ATO_1, data: iso(300), rotulo: 'Despacho antigo' },
            },
          ],
        });
      await resumir();
      await painel().locator('details.pvres-cit summary').first().click();
      await painel().locator('.pvres-ato button').first().click();
      await page.waitForFunction(() =>
        /não está visível na linha do tempo/.test(
          document.getElementById('pvres-nota-ato')?.textContent ?? '',
        ),
      );
      expect(await page.locator('.ev.pvres-alvo').count()).toBe(0);
    });

    describe('polegares (v0.56.0)', () => {
      const grupoDoMotivo = () =>
        painel().getByRole('group', { name: 'Qual foi o problema? (opcional)' });

      it('dois ícones no fim do resultado, com nome acessível; nada de Útil / Errado / Perigoso nem texto livre', async () => {
        await abrir();
        await resumir();
        const p = painel();
        expect(await polegar('cima').count()).toBe(1);
        expect(await polegar('baixo').count()).toBe(1);
        expect(
          await p.getByRole('button', { name: /^(Útil|Errado|Perigoso)$/ }).count(),
        ).toBe(0);
        expect(await p.getByText('Reportar problema').count()).toBe(0);
        expect(await p.locator('textarea, input[type="text"]').count()).toBe(0);
        const fim = await p.evaluate((el) => {
          const poleg = el.querySelector('.pvpol')!.getBoundingClientRect().top;
          const aviso = el.querySelector('.pvres-aviso')!.getBoundingClientRect().top;
          return poleg > aviso;
        });
        expect(fim).toBe(true);
      });

      it('para cima grava "util"; o aviso "Obrigado pelo retorno." fica visível e vai à região ao vivo; o foco fica no botão', async () => {
        await abrir();
        await resumir();
        await polegar('cima').click();
        await painel().getByText('Obrigado pelo retorno.').waitFor();
        expect(await polegar('cima').getAttribute('aria-pressed')).toBe('true');
        expect(await polegar('baixo').getAttribute('aria-pressed')).toBe('false');
        expect(avaliacoes).toEqual([{ id: 'resumo-1', corpo: { avaliacao: 'util' } }]);
        expect(await grupoDoMotivo().count()).toBe(0);
        await page.waitForFunction(
          () =>
            document.getElementById('pvpol-live')?.textContent ===
            'Obrigado pelo retorno.',
        );
        expect(
          await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        ).toBe('Resultado útil');
      });

      it('para baixo grava "errado" e abre a lista fechada de motivos sem sair da tela; o motivo é opcional e se desfaz', async () => {
        await abrir();
        await resumir();
        await polegar('baixo').click();
        await grupoDoMotivo().waitFor();
        expect(
          await grupoDoMotivo()
            .getByRole('button')
            .evaluateAll((l) => l.map((b) => b.textContent)),
        ).toEqual([
          'Erro de fato',
          'Citação inventada',
          'Concluiu prazo',
          'Deixou de fora algo importante',
          'Pode causar prejuízo se seguido',
          'Outro',
        ]);
        await grupoDoMotivo().getByRole('button', { name: 'Citação inventada' }).click();
        await page.waitForFunction(
          () => document.querySelector('.pvpol-m[aria-pressed="true"]') !== null,
        );
        await grupoDoMotivo().getByRole('button', { name: 'Citação inventada' }).click();
        await page.waitForFunction(
          () => document.querySelectorAll('.pvpol-m[aria-pressed="true"]').length === 0,
        );
        await grupoDoMotivo()
          .getByRole('button', { name: 'Pode causar prejuízo se seguido' })
          .click();
        await page.waitForFunction(
          () => document.querySelector('.pvpol-m[aria-pressed="true"]') !== null,
        );
        expect(avaliacoes.map((a) => a.corpo)).toEqual([
          { avaliacao: 'errado' },
          { avaliacao: 'errado', motivo: 'citacao_inventada' },
          { avaliacao: 'errado' },
          { avaliacao: 'errado', motivo: 'pode_causar_prejuizo' },
        ]);
        expect(await painel().locator('.pvpol input, .pvpol textarea').count()).toBe(0);
      });

      it('mudar de ideia: para cima depois de para baixo grava "util" e fecha os motivos', async () => {
        await abrir();
        await resumir();
        await polegar('baixo').click();
        await grupoDoMotivo().waitFor();
        await polegar('cima').click();
        await page.waitForFunction(() => !document.querySelector('.pvpol-motivos'));
        expect(avaliacoes.map((a) => a.corpo)).toEqual([
          { avaliacao: 'errado' },
          { avaliacao: 'util' },
        ]);
      });

      it('falha ao gravar: diz isso, sem fingir que gravou', async () => {
        await abrir();
        await resumir();
        avaliacaoFalha = true;
        await polegar('baixo').click();
        await painel().getByText('Não foi possível registrar. Tente de novo.').waitFor();
        expect(await polegar('baixo').getAttribute('aria-pressed')).toBe('false');
        expect(await grupoDoMotivo().count()).toBe(0);
      });

      it('o voto sobrevive a redesenhar o resultado (fechar e reabrir o Detalhes não o apaga) e é por resultado', async () => {
        await abrir();
        await resumir();
        await polegar('cima').click();
        await painel().getByText('Obrigado pelo retorno.').waitFor();
        await painel().locator('details.pvres-det > summary').click();
        expect(await polegar('cima').getAttribute('aria-pressed')).toBe('true');
        await painel().getByRole('button', { name: 'Fechar' }).click();
        await resumir();
        // Resultado novo (mesmo id no dublê, mas a tela nova parte do que o servidor diz: sem avaliação).
        expect(avaliacoes).toHaveLength(1);
      });

      it('teclado: Tab chega aos dois, Espaço avalia, o foco volta ao botão e os motivos são alcançáveis', async () => {
        await abrir();
        await resumir();
        await polegar('baixo').focus();
        await page.keyboard.press('Space');
        await grupoDoMotivo().waitFor();
        expect(
          await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        ).toBe('Resultado com problema');
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement?.id)).toMatch(
          /-m-erro_de_fato$/,
        );
        await page.keyboard.press('Space');
        await page.waitForFunction(
          () =>
            /-m-erro_de_fato$/.test(document.activeElement?.id ?? '') &&
            document.activeElement?.getAttribute('aria-pressed') === 'true',
        );
      });

      for (const escuro of [false, true]) {
        it(`axe sem violações com os motivos à vista e o Detalhes aberto (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
          await abrir({ escuro });
          await resumir();
          await painel().locator('details.pvres-det > summary').click();
          await painel().locator('details.pvres-cit summary').first().click();
          await polegar('baixo').click();
          await grupoDoMotivo().getByRole('button', { name: 'Outro' }).click();
          await page.waitForFunction(
            () => document.querySelector('.pvpol-m[aria-pressed="true"]') !== null,
          );
          await page.addScriptTag({
            content: (AxeBuilder as unknown as { source: string }).source,
          });
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(
              document.getElementById('pvres-painel')!,
              { rules: { 'color-contrast': { enabled: true } } },
            ),
          );
          expect(
            r.violations.map(
              (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
            ),
          ).toEqual([]);
        });
      }
    });

    const ESTADOS: Array<{
      nome: string;
      status: number;
      corpo: unknown;
      texto: string;
    }> = [
      {
        nome: 'não verificado',
        status: 200,
        corpo: {
          ...RESULTADO,
          estado: 'nao_verificado',
          situacao: [],
          pendencias: [],
          pontosDeAtencao: [],
        },
        texto: 'Não foi possível resumir com segurança. Leia os atos.',
      },
      {
        nome: 'erro do modelo',
        status: 200,
        corpo: { estado: 'erro' },
        texto: 'Não foi possível resumir agora. Tente de novo em alguns minutos.',
      },
      {
        nome: 'erro inesperado do servidor',
        status: 500,
        corpo: { erro: 'x', mensagem: 'texto do servidor que não deve aparecer' },
        texto: 'Não foi possível resumir agora. Tente de novo em alguns minutos.',
      },
      {
        nome: 'processo que a conta não acompanha',
        status: 404,
        corpo: { erro: 'ACOMPANHAMENTO_NAO_ENCONTRADO', mensagem: 'x' },
        texto: 'Este processo não está entre os que você acompanha.',
      },
      ...(
        [
          [
            'sem_plano',
            403,
            'O resumo por IA faz parte do plano IA. Faça upgrade do plano para usar.',
          ],
          [
            'segredo_de_justica',
            403,
            'Processo em segredo de justiça: o resumo por IA não é feito. Leia os atos.',
          ],
          [
            'texto_insuficiente',
            422,
            'Este processo não tem atos com texto suficiente para resumir. Leia os atos.',
          ],
          [
            'limite_de_uso',
            429,
            'Há muitos resumos em andamento ou o limite por hora foi atingido. Tente novamente em instantes.',
          ],
        ] as const
      ).map(([motivo, status, texto]) => ({
        nome: `recusa: ${motivo}`,
        status,
        corpo: {
          erro: 'ENTRADA_NAO_ANALISAVEL',
          mensagem: 'texto do servidor',
          detalhes: { motivo },
        },
        texto,
      })),
    ];

    for (const e of ESTADOS) {
      it(`estado "${e.nome}": frase fixa, sem polegares nem citação, só o aviso fixo fala em prazo`, async () => {
        await abrir();
        responder = (rota) => json(rota, e.status, e.corpo);
        await botao().click();
        const p = painel();
        await p.getByText(e.texto, { exact: true }).waitFor();
        expect(await p.getAttribute('aria-busy')).toBe('false');
        expect(await p.locator('.pvpol').count()).toBe(0);
        expect(await p.locator('mark, li').count()).toBe(0);
        const t = await p.innerText();
        expect(t).not.toContain('texto do servidor');
        expect(t).toContain(AVISO_FIXO);
        expect(SEM_PRAZO(t)).not.toMatch(/prazo/i);
        await page.waitForFunction(
          (frase) => document.getElementById('pvres-live')?.textContent === frase,
          e.texto,
        );
      });
    }

    it('"Tentar de novo" depois do erro faz outro pedido', async () => {
      await abrir();
      responder = (rota) => json(rota, 200, { estado: 'erro' });
      await botao().click();
      await painel().getByText('Não foi possível resumir agora.').waitFor();
      responder = (rota) => json(rota, 200, RESULTADO);
      await painel().getByRole('button', { name: 'Tentar de novo' }).click();
      await painel().locator('.pvres-sec').first().waitFor();
      expect(pedidos).toHaveLength(2);
    });

    it('teclado: Enter abre, Tab percorre Fechar, as citações, Detalhes e os polegares; Esc fecha e devolve o foco ao botão', async () => {
      await abrir();
      await botao().focus();
      await page.keyboard.press('Enter');
      await painel().locator('.pvres-sec').first().waitFor();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pvres-painel');
      const visitados: string[] = [];
      for (let i = 0; i < 7; i++) {
        await page.keyboard.press('Tab');
        visitados.push(
          await page.evaluate(() => {
            const a = document.activeElement as HTMLElement | null;
            return (a?.getAttribute('aria-label') ?? a?.textContent ?? '').trim();
          }),
        );
      }
      expect(visitados).toEqual([
        'Fechar',
        'Ver trecho',
        'Ver trecho',
        'Ver trecho',
        'Detalhes',
        'Resultado útil',
        'Resultado com problema',
      ]);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('pvres-painel'));
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pvres-abrir');
      expect(await botao().getAttribute('aria-expanded')).toBe('false');
    });

    it('Esc durante o resumo cancela', async () => {
      await abrir();
      responder = () => new Promise<void>(() => undefined);
      await botao().click();
      await painel().waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('pvres-painel'));
      await page.waitForFunction(
        () => document.getElementById('pvres-live')?.textContent === 'Resumo cancelado.',
      );
    });

    it('não há reabrir: voltar e abrir o processo de novo começa sem resumo', async () => {
      await abrir();
      await resumir();
      await page.click('#voltar');
      await page.waitForFunction(() => !document.getElementById('pvres-raiz'));
      await irAoProcesso();
      await botao().waitFor();
      expect(await painel().count()).toBe(0);
      expect(await botao().getAttribute('aria-expanded')).toBe('false');
      expect(pedidos).toHaveLength(1);
    });

    it('a tela do processo é redesenhada com o resumo em curso (régua do tribunal): o painel e o resultado voltam', async () => {
      await abrir({ pecasReais: true });
      let solta: () => void = () => {};
      const segurar = new Promise<void>((r) => (solta = r));
      responder = async (rota) => {
        await segurar;
        await json(rota, 200, RESULTADO).catch(() => undefined);
      };
      await botao().click();
      await painel().waitFor();
      expect(await painel().innerText()).toContain('Resumindo o processo');
      await page.evaluate(() =>
        document.getElementById('parar')!.setAttribute('data-antigo', '1'),
      );
      liberarPecas();
      await page.waitForFunction(() => {
        const parar = document.getElementById('parar');
        return !!parar && !parar.hasAttribute('data-antigo');
      });
      await page.waitForFunction(
        () =>
          document.querySelectorAll('#pvres-abrir').length === 1 &&
          !!document.getElementById('pvres-painel'),
      );
      expect(await page.locator('#pvres-painel').count()).toBe(1);
      expect(await botao().getAttribute('aria-expanded')).toBe('true');
      solta();
      await painel().locator('.pvres-sec').first().waitFor();
      expect(pedidos).toHaveLength(1);
    });

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal da página com o resumo e o Detalhes abertos em ${largura} px`, async () => {
        await abrir({ largura });
        await resumir();
        await painel().locator('details.pvres-det > summary').click();
        await painel().locator('details.pvres-cit summary').first().click();
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          iw: window.innerWidth,
          painel: document.getElementById('pvres-painel')!.getBoundingClientRect().right,
        }));
        expect(m.sw).toBeLessThanOrEqual(m.iw);
        expect(m.painel).toBeLessThanOrEqual(m.iw);
      });
    }

    it('conciso: no celular (390 × 844) o resumo típico cabe numa tela, sem rolar', async () => {
      await abrir({ largura: 390 });
      await resumir();
      const altura = await painel().evaluate((e) => e.getBoundingClientRect().height);
      expect(altura).toBeLessThanOrEqual(844);
    });

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`faixa de alerta e lista de providências sem rolagem horizontal em ${largura} px`, async () => {
        await abrir({ largura });
        responder = (rota) =>
          json(rota, 200, {
            ...RESULTADO,
            atualidade: {
              maisRecente: {
                data: iso(1),
                rotulo: 'Despacho',
                tipoDaComunicacao: null,
                lido: false,
              },
              providenciasNaoLidas: [
                {
                  data: iso(1),
                  rotulo: 'Despacho',
                  tipoDaComunicacao: null,
                  motivo: 'teor_indisponivel',
                },
              ],
              providenciasNaoLidasTotal: 1,
              tribunalMaisNovo: null,
            },
            pendencias: [],
          });
        await resumir();
        await painel().locator('details.pvres-det > summary').click();
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          iw: window.innerWidth,
          faixa: document.querySelector('.pvres-faixa')!.getBoundingClientRect().right,
        }));
        expect(m.sw).toBeLessThanOrEqual(m.iw);
        expect(m.faixa).toBeLessThanOrEqual(m.iw);
      });
    }

    for (const escuro of [false, true]) {
      it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): botão, resumindo, resultado, avaliado, recusa`, async () => {
        await abrir({ escuro });
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const rodar = async (): Promise<string> => {
          const r = await page.evaluate(() => {
            const alvos = ['.capa', '#pvres-raiz'].filter((q) =>
              document.querySelector(q),
            );
            return (window as unknown as AxeNaPagina).axe.run(
              { include: alvos.map((q) => [q]) } as unknown as Element,
              { rules: { 'color-contrast': { enabled: true } } },
            );
          });
          return r.violations
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
            .join('\n');
        };
        await botao().waitFor();
        expect(await rodar(), 'botão').toBe('');

        let solta: () => void = () => {};
        const segurar = new Promise<void>((r) => (solta = r));
        responder = async (rota) => {
          await segurar;
          await json(rota, 200, RESULTADO).catch(() => undefined);
        };
        await botao().click();
        await painel().getByText('Resumindo o processo').waitFor();
        expect(await rodar(), 'resumindo').toBe('');
        solta();
        await painel().locator('.pvres-sec').first().waitFor();
        expect(await rodar(), 'resultado').toBe('');
        await polegar('cima').click();
        await painel().getByText('Obrigado pelo retorno.').waitFor();
        expect(await rodar(), 'avaliado').toBe('');

        await painel().getByRole('button', { name: 'Fechar' }).click();
        responder = (rota) =>
          json(rota, 403, {
            erro: 'ENTRADA_NAO_ANALISAVEL',
            mensagem: 'x',
            detalhes: { motivo: 'sem_plano' },
          });
        await botao().click();
        await painel().getByText('plano IA').waitFor();
        expect(await rodar(), 'recusa').toBe('');
      });
    }
  },
);
