/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';
import { PROCESSO_TJGO } from '../helpers/leitor.js';

/*
 * "Analisar peça com IA" NUM NAVEGADOR (v0.55.0; polegares e Pasta digital na v0.56.0). Servidor, console, linha do tempo e Pasta digital são
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
  conversao: null,
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
      acompanhado?: boolean;
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
    if (o.acompanhado === false) {
      await ctx.route(
        (u) => u.pathname === `/v1/acompanhamentos/${PROCESSO_TJGO}`,
        (rota) =>
          rota.request().method() === 'GET'
            ? json(rota, 404, { erro: 'ACOMPANHAMENTO_NAO_ENCONTRADO', mensagem: 'x' })
            : rota.fallback(),
      );
    }
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
  const cima = () => painel().getByRole('button', { name: 'Resultado útil' });
  const baixo = () => painel().getByRole('button', { name: 'Resultado com problema' });
  const grupoDoMotivo = () =>
    painel().getByRole('group', { name: 'Qual foi o problema? (opcional)' });

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

  // v0.56.0: o modo de avaliação (três botões) e o link "Reportar problema" saíram; qualquer conta liberada vê os
  // mesmos polegares, e o modo que o servidor informa não muda a tela.
  for (const modo of ['avaliacao', 'geral'] as const) {
    it(`polegares no fim do resultado, iguais com o modo "${modo}": para cima grava "util"; para baixo, "errado" e motivo opcional`, async () => {
      await abrir({ modo });
      await analisar();
      expect(await painel().locator('.pvpe-av, #pvpe-reportar').count()).toBe(0);
      expect(await painel().getByText('Reportar problema').count()).toBe(0);
      expect(
        await painel()
          .getByRole('button', { name: /^(Útil|Errado|Perigoso)$/ })
          .count(),
      ).toBe(0);
      expect(
        await painel().evaluate(
          (el) =>
            el.querySelector('.pvpol')!.getBoundingClientRect().top >
            el.querySelector('.pvpe-aviso-fixo')!.getBoundingClientRect().top,
        ),
      ).toBe(true);
      await cima().click();
      await painel().getByText('Obrigado pelo retorno.').waitFor();
      await baixo().click();
      await grupoDoMotivo().waitFor();
      await grupoDoMotivo()
        .getByRole('button', { name: 'Pode causar prejuízo se seguido' })
        .click();
      await page.waitForFunction(
        () => document.querySelector('.pvpol-m[aria-pressed="true"]') !== null,
      );
      expect(avaliacoes).toEqual([
        { avaliacao: 'util' },
        { avaliacao: 'errado' },
        { avaliacao: 'errado', motivo: 'pode_causar_prejuizo' },
      ]);
      expect(await painel().locator('textarea, input[type="text"]').count()).toBe(0);
    });
  }

  it('peça convertida do HTML do tribunal: o botão existe e o resultado avisa que imagens e tabelas podem não ter entrado', async () => {
    await abrir();
    responder = (rota) => json(rota, 200, { ...RESULTADO, conversao: 'html' });
    await analisar('p04');
    expect(await painel().innerText()).toContain(
      'Peça convertida do HTML do tribunal em texto: imagens e tabelas podem não ter entrado na leitura.',
    );
    await painel().getByRole('button', { name: 'Fechar' }).click();
    responder = (rota) => json(rota, 200, RESULTADO);
    await analisar('p01');
    expect(await painel().innerText()).not.toContain('convertida do HTML');
  });

  it('processo que a conta não acompanha: os botões existem, DESLIGADOS, com a razão', async () => {
    await abrir({ acompanhado: false });
    await botao('p01').waitFor();
    expect(await botao('p01').isDisabled()).toBe(true);
    expect(await botao('p01').getAttribute('title')).toBe(
      'Acompanhe este processo para poder analisar as peças dele com IA.',
    );
    expect(await botao('p01').getAttribute('aria-label')).toContain('indisponível');
    expect(analises).toHaveLength(0);
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

  describe('visualizador da Pasta digital (v0.56.0)', () => {
    async function abrirPasta(id: string): Promise<void> {
      await page.click('#pasta-abrir');
      await page.waitForSelector('#pasta .linha');
      await page.click(`#pf-${id}`);
    }
    const botaoPasta = () => page.locator('#pasta-ia [data-pvpe="analisar"]');
    const pronto = () =>
      page.waitForFunction(() => {
        const b = document.querySelector('#pasta-ia [data-pvpe="analisar"]');
        return !!b && !(b as HTMLButtonElement).disabled;
      });

    it('peça disponível: o botão do visor fica ligado, um clique analisa e o resultado (com polegares) mora no visor', async () => {
      await abrir();
      await abrirPasta('p01');
      await botaoPasta().waitFor();
      await pronto();
      expect(await botaoPasta().textContent()).toBe('Analisar peça com IA');
      await botaoPasta().click();
      await page.locator('#pasta-ia #pvpe-painel .pvpe-tipo').waitFor();
      expect(await page.locator('#pasta-ia #pvpe-painel').innerText()).toContain(
        'Leitura automática, pode omitir pontos. Confira a peça inteira.',
      );
      expect(await page.locator('#pasta-ia .pvpol-b').count()).toBe(2);
      expect(analises).toHaveLength(1);
      // O visualizador continua: o PDF abre ao lado, e o resultado rola dentro do próprio espaço.
      expect(
        await page.locator('#pasta-ia').evaluate((e) => getComputedStyle(e).overflowY),
      ).toBe('auto');
    });

    it('peça convertida do HTML do tribunal: botão ligado, resultado com o aviso da conversão', async () => {
      await abrir();
      responder = (rota) => json(rota, 200, { ...RESULTADO, conversao: 'html' });
      await abrirPasta('p04');
      await pronto();
      await botaoPasta().click();
      await page.locator('#pasta-ia #pvpe-painel .pvpe-tipo').waitFor();
      expect(await page.locator('#pasta-ia #pvpe-painel').innerText()).toContain(
        'Peça convertida do HTML do tribunal',
      );
    });

    it('outro tribunal que não o TJGO: desligado, com a razão em português (o servidor também recusa)', async () => {
      await abrir();
      await abrirPasta('p01');
      await botaoPasta().waitFor();
      await page.evaluate(() =>
        (
          window as unknown as {
            __pvPecaIA: {
              pasta(o: { numero: string; peca: { id: string; estado: string } }): void;
            };
          }
        ).__pvPecaIA.pasta({
          numero: '00000000020208260100',
          peca: { id: 'p01', estado: 'disponivel' },
        }),
      );
      await page.waitForFunction(
        () =>
          (
            document.querySelector(
              '#pasta-ia [data-pvpe="analisar"]',
            ) as HTMLButtonElement
          )?.disabled,
      );
      expect(await botaoPasta().getAttribute('title')).toContain(
        'Tribunal de Justiça de Goiás',
      );
    });

    it('peça ainda não baixada, na fila, não obtida ou sigilosa: desligado, com a razão, em vez de sumir', async () => {
      await abrir();
      await abrirPasta('p01');
      await botaoPasta().waitFor();
      for (const [estado, trecho] of [
        ['na_fila', 'ainda está sendo baixada'],
        ['nao_obtida', 'não foi obtida'],
        ['nao_baixada', 'Baixe a peça primeiro'],
        // A Pasta não abre peça sigilosa no visor, mas se um dia abrisse o botão diria por que não vale.
        ['sigilo', 'Peça sob sigilo'],
      ] as const) {
        await page.evaluate(
          (e) =>
            (
              window as unknown as {
                __pvPecaIA: {
                  pasta(o: {
                    numero: string;
                    peca: { id: string; estado: string };
                  }): void;
                };
              }
            ).__pvPecaIA.pasta({
              numero: '99999019620268099999',
              peca: { id: 'p01', estado: e },
            }),
          estado,
        );
        await page.waitForFunction(
          (t) =>
            (
              document.querySelector(
                '#pasta-ia [data-pvpe="analisar"]',
              ) as HTMLButtonElement
            )?.title.includes(t),
          trecho,
        );
        expect(await botaoPasta().isDisabled()).toBe(true);
      }
    });

    it('conta não liberada: nenhum botão no visor', async () => {
      await abrir({ liberado: false });
      await abrirPasta('p01');
      await page.waitForFunction(() => true);
      expect(await page.locator('#pasta-ia [data-pvpe="analisar"]').count()).toBe(0);
    });

    it('mudar de peça no visor troca o botão; fechar a Pasta apaga o resultado e a linha do tempo volta a funcionar', async () => {
      await abrir();
      await abrirPasta('p01');
      await pronto();
      await botaoPasta().click();
      await page.locator('#pasta-ia #pvpe-painel .pvpe-tipo').waitFor();
      await page.click('#pf-p05');
      await page.waitForFunction(
        () => document.querySelector('#pasta-ia [data-pvpe-id="p05"]') !== null,
      );
      expect(await page.locator('#pasta-ia #pvpe-painel').count()).toBe(0);
      await page.click('#pasta-fechar');
      expect(await page.locator('#pvpe-raiz').count()).toBe(0);
      await analisar('p01');
      expect(await painel().count()).toBe(1);
    });

    for (const largura of LARGURAS) {
      it(`sem rolagem horizontal com o resultado no visor em ${largura} px`, async () => {
        await abrir({ largura });
        await abrirPasta('p01');
        await pronto();
        await botaoPasta().click();
        await page.locator('#pasta-ia #pvpe-painel .pvpe-tipo').waitFor();
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          iw: window.innerWidth,
          ia: document.getElementById('pasta-ia')!.getBoundingClientRect().right,
        }));
        expect(m.sw).toBeLessThanOrEqual(m.iw);
        expect(m.ia).toBeLessThanOrEqual(m.iw);
      });
    }

    for (const escuro of [false, true]) {
      it(`axe sem violações no visor com o resultado e os motivos (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        await abrir({ escuro });
        await abrirPasta('p01');
        await pronto();
        await botaoPasta().click();
        await page.locator('#pasta-ia #pvpe-painel .pvpe-tipo').waitFor();
        await baixo().click();
        await grupoDoMotivo().getByRole('button', { name: 'Outro' }).click();
        await page.waitForFunction(
          () => document.querySelector('.pvpol-m[aria-pressed="true"]') !== null,
        );
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const r = await page.evaluate(() =>
          (window as unknown as AxeNaPagina).axe.run(
            document.getElementById('pasta-ia')!,
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
});
