/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';
import { PROCESSO_TJGO } from '../helpers/leitor.js';

/*
 * "Analisar peça com IA" NUM NAVEGADOR (v0.55.0). Servidor, console, linha do tempo e Pasta digital são
 * os reais (tribunal falso, peças sintéticas); só as rotas da análise são simuladas com o contrato da API
 * (que tem teste próprio em tests/http/analise-de-peca.spec.ts). Nenhuma chamada a modelo, nenhuma rede.
 */
const sem = CHROMIUM === undefined;

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

const RESULTADO = {
  estado: 'verificada',
  id: 'analise-1',
  modo: 'avaliacao',
  reaproveitada: false,
  avaliacao: null,
  criadaEm: '2026-10-05T12:00:00.000Z',
  expiraEm: '2026-11-04T12:00:00.000Z',
  resultado: {
    tipo: 'peticao_inicial',
    emUmaFrase:
      'A parte autora pede a condenação da parte ré ao pagamento de indenização.',
    pedidos: [
      {
        texto: 'Condenação ao pagamento de indenização',
        trecho: 'condenar a ré ao pagamento',
        pagina: 2,
      },
    ],
    alegacoes: [
      {
        texto: 'Alega falha na prestação do serviço',
        trecho: 'houve falha na prestação',
        pagina: 1,
      },
    ],
    preliminares: [],
    documentos: [{ nome: 'Contrato de prestação de serviços', pagina: 1 }],
    valores: [
      {
        valor: 'R$ 10.000,00',
        contexto: 'valor da causa',
        trecho: 'R$ 10.000,00',
        pagina: 2,
      },
    ],
    pontosDeAtencao: ['conferir_peca_inteira'],
  },
};
const LARGURAS = [1920, 1366, 1280, 1024, 768, 390];

describe.skipIf(sem)('Analisar peça com IA, no navegador', { timeout: 180_000 }, () => {
  let browser: Browser;
  let amb: Ambiente;
  let ctx: BrowserContext;
  let page: Page;
  let analises: string[];
  let avaliacoes: unknown[];
  let responder: (rota: Route) => Promise<void>;

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
    await ctx?.close();
  });

  async function abrir(
    o: {
      liberado?: boolean;
      modo?: 'avaliacao' | 'geral';
      largura?: number;
      escuro?: boolean;
    } = {},
  ): Promise<void> {
    analises = [];
    avaliacoes = [];
    responder = (rota) => json(rota, 200, RESULTADO);
    ctx = await browser.newContext({
      viewport: { width: o.largura ?? 1280, height: 900 },
      colorScheme: o.escuro ? 'dark' : 'light',
    });
    await ctx.addInitScript((c) => {
      try {
        localStorage.setItem('processovivo.chave', c);
      } catch {
        /* sem armazenamento: o teste falharia adiante, com a causa à vista */
      }
    }, CHAVE);
    await ctx.route('**/v1/analises-de-peca/disponibilidade', (rota) =>
      json(
        rota,
        200,
        o.liberado === false
          ? { liberado: false }
          : { liberado: true, modo: o.modo ?? 'avaliacao' },
      ),
    );
    await ctx.route('**/v1/analises/disponibilidade', (rota) =>
      json(rota, 200, { habilitada: true }),
    );
    // O estado da guarda vem da rota nova (testada em tests/http); aqui a peça já foi pedida pela rota real da Pasta.
    await ctx.route('**/v1/processos/*/pasta/pecas/*/estado', (rota) =>
      json(rota, 200, { estado: 'disponivel' }),
    );
    await ctx.route('**/v1/processos/*/pecas/*/analise', async (rota) => {
      analises.push(rota.request().url());
      await responder(rota);
    });
    await ctx.route('**/v1/analises-de-peca/*/avaliacao', async (rota) => {
      avaliacoes.push(rota.request().postDataJSON() as unknown);
      await json(rota, 200, { id: 'analise-1' });
    });
    page = await ctx.newPage();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', (e) => {
      throw e;
    });
    const facetas = page.waitForResponse('**/v1/facetas');
    await page.goto(amb.url + '/');
    await page.waitForFunction(
      () => typeof (window as unknown as Console_).__pv?.abrir === 'function',
    );
    await facetas;
    await page.waitForFunction(() => {
      const c = document.getElementById('conteudo');
      return !!c && c.children.length > 0 && !c.querySelector('.gira, .nvt-esq');
    });
    await page.evaluate(
      (n) => (window as unknown as Console_).__pv!.abrir(n),
      PROCESSO_TJGO,
    );
    await page.waitForSelector('#conteudo .capa');
    await page.waitForSelector('#conteudo button[data-peca]');
  }

  const botao = (id: string) =>
    page.locator(`[data-pvpe="analisar"][data-pvpe-id="${id}"]`);
  const painel = () => page.locator('#pvpe-painel');
  const analisar = async (id = 'p01'): Promise<void> => {
    await botao(id).click();
    await painel().locator('.pvpe-tipo').waitFor();
  };

  it('conta não liberada: nenhum botão na tela', async () => {
    await abrir({ liberado: false });
    await page.waitForFunction(() => true);
    expect(await page.locator('[data-pvpe="analisar"]').count()).toBe(0);
  });

  it('conta liberada: um botão por peça, o da peça sigilosa desligado e com a razão', async () => {
    await abrir();
    await botao('p01').waitFor();
    expect(await botao('p01').textContent()).toBe('Analisar peça com IA');
    expect(await botao('p01').isDisabled()).toBe(false);
    const sig = botao('p11');
    await sig.waitFor();
    expect(await sig.isDisabled()).toBe(true);
    expect(await sig.getAttribute('title')).toContain('sigilo');
  });

  it('um clique baixa a peça, analisa e mostra o resultado conciso; o pedido não leva corpo', async () => {
    await abrir();
    await analisar();
    const t = await painel().innerText();
    expect(t).toContain('Petição inicial');
    expect(t.toLowerCase()).toContain('em uma frase'); // rótulos maiúsculos só por CSS
    expect(t.toLowerCase()).toContain('o que pede');
    expect(t.toLowerCase()).toContain('o que alega');
    expect(t).toContain(
      'Leitura automática, pode omitir pontos. Confira a peça inteira.',
    );
    expect(t).not.toMatch(/chance|mérito|tese/i);
    expect(analises).toHaveLength(1);
    // A citação nasce recolhida.
    const det = painel().locator('details.pvpe-cit').first();
    expect(await det.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
    await det.locator('summary').click();
    expect(await det.innerText()).toContain('condenar a ré ao pagamento');
    expect(await botao('p01').getAttribute('aria-expanded')).toBe('true');
  });

  it('modo avaliação: os três botões e o motivo de lista fechada; nada de texto livre', async () => {
    await abrir({ modo: 'avaliacao' });
    await analisar();
    expect(await painel().locator('.pvpe-av').count()).toBe(3);
    expect(await page.locator('#pvpe-reportar').count()).toBe(0);
    await page.locator('#pvpe-av-errado').click();
    await page.locator('#pvpe-mo-erro_de_fato').click();
    await page.waitForFunction(() =>
      document.querySelector('#pvpe-mo-erro_de_fato[aria-pressed="true"]'),
    );
    expect(avaliacoes.at(-1)).toEqual({ avaliacao: 'errado', motivo: 'erro_de_fato' });
    expect(await painel().locator('textarea, input[type="text"]').count()).toBe(0);
  });

  it('modo geral: só o link "Reportar problema", que registra "errado" com o motivo escolhido', async () => {
    await abrir({ modo: 'geral' });
    await analisar();
    expect(await painel().locator('#pvpe-av-util').count()).toBe(0);
    await page.locator('#pvpe-reportar').click();
    await page.locator('#pvpe-mo-citacao_inventada').click();
    await page.waitForFunction(() =>
      /registramos/.test(document.getElementById('pvpe-painel')?.innerText ?? ''),
    );
    expect(avaliacoes.at(-1)).toEqual({
      avaliacao: 'errado',
      motivo: 'citacao_inventada',
    });
  });

  it.each([
    ['sem_texto', 'não tem texto que possamos ler', 422],
    ['acima_de_40_paginas', 'mais de 40 páginas', 422],
    ['tribunal_nao_suportado', 'Tribunal de Justiça de Goiás', 422],
    ['limite_diario', 'cada peça conta como cinco', 429],
  ])(
    'recusa %s: frase fixa da tela, sem texto do servidor',
    async (motivo, trecho, status) => {
      await abrir();
      responder = (rota) =>
        json(rota, status, {
          erro: 'ANALISE_DE_PECA_RECUSADA',
          mensagem: 'TEXTO-DO-SERVIDOR',
          detalhes: { motivo },
        });
      await botao('p01').click();
      await expect
        .poll(() => painel().innerText(), { timeout: 15_000 })
        .toContain(trecho);
      const t = await painel().innerText();
      expect(t).not.toContain('TEXTO-DO-SERVIDOR');
    },
  );

  it('erro do servidor: mensagem genérica e "Tentar de novo"', async () => {
    await abrir();
    responder = (rota) => json(rota, 500, { erro: 'x', mensagem: 'x' });
    await botao('p01').click();
    await painel().locator('#pvpe-repetir').waitFor();
    expect(await painel().innerText()).toContain('Não foi possível analisar agora');
  });

  it('Esc fecha o painel e devolve o foco ao botão', async () => {
    await abrir();
    await analisar();
    await painel().focus();
    await page.keyboard.press('Escape');
    expect(await page.locator('#pvpe-painel').count()).toBe(0);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-pvpe-id')),
    ).toBe('p01');
  });

  it('teclado: Enter no botão abre; o painel recebe o foco e tem nome acessível', async () => {
    await abrir();
    await botao('p01').focus();
    await page.keyboard.press('Enter');
    await painel().locator('.pvpe-tipo').waitFor();
    expect(await painel().getAttribute('aria-label')).toBe('Análise da peça por IA');
    expect(await page.locator('#pvpe-live').count()).toBe(1);
  });

  for (const escuro of [false, true]) {
    it(`axe sem violações no tema ${escuro ? 'escuro' : 'claro'}`, async () => {
      await abrir({ escuro });
      await analisar();
      await painel().locator('details.pvpe-cit summary').first().click();
      await page.addScriptTag({ content: AxeBuilder.source });
      const r = await page.evaluate(() =>
        (window as unknown as AxeNaPagina).axe.run(
          document.getElementById('pvpe-raiz')!,
          {},
        ),
      );
      expect(
        r.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
        ),
      ).toEqual([]);
    });
  }

  for (const largura of LARGURAS) {
    it(`sem rolagem horizontal em ${largura} px`, async () => {
      await abrir({ largura });
      await analisar();
      const r = await page.evaluate(() => ({
        pagina:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        painel: (() => {
          const p = document.getElementById('pvpe-painel')!;
          return p.scrollWidth - p.clientWidth;
        })(),
      }));
      expect(r.pagina).toBeLessThanOrEqual(0);
      expect(r.painel).toBeLessThanOrEqual(0);
    });
  }

  it('regressão: o download da própria peça continua funcionando ao lado do botão novo', async () => {
    await abrir();
    const original = page.locator('#conteudo button[data-peca="p01"]').first();
    expect(await original.count()).toBe(1);
    expect(await original.getAttribute('data-pvpe')).toBeNull();
    expect(await page.locator('#conteudo .capa').count()).toBe(1);
  });
});
