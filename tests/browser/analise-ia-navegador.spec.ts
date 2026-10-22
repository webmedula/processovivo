/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
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

/*
 * "Analisar com IA" NUM NAVEGADOR (v0.38.0). O servidor e o console são os reais; as
 * rotas da IA e /v1/novidades são simuladas aqui com dados SINTÉTICOS e o mesmo
 * contrato da API (a API tem teste próprio em tests/http/analise-ia.spec.ts). Nenhuma
 * chamada a modelo, nenhuma rede.
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

const NA = numeroValido(8001); // pede providência
const NB = numeroValido(8002); // atualização comum
const NC = numeroValido(8003); // sem novidade
const CHAVE_PROVIDENCIA = 'chave-da-providencia-8001';

const RESULTADO = {
  estado: 'verificada',
  id: 'analise-1',
  parecePedir: 'manifestar',
  resumo: 'A parte deve se manifestar sobre o laudo pericial juntado aos autos.',
  trechoChave: 'se manifeste sobre o laudo pericial',
  acoesPossiveis: [{ acao: 'Parte autora: apresentar manifestação sobre o laudo' }],
  pontosDeAtencao: ['conferir_prazo_no_processo', 'texto_incompleto'],
  modelo: 'modelo/teste',
  versaoPrompt: 'ato-1.2.0',
  provedor: 'provedor-teste',
  criadaEm: '2026-10-05T12:00:00.000Z',
  avaliacao: null,
};

const PREVIA = {
  analiseId: 'analise-1',
  dias: 15,
  tipo: 'uteis',
  tipoDoAto: true,
  titulo: 'Prazo de 15 dias úteis (a conferir)',
  dataDaPublicacao: '2026-10-06',
  inicioDaContagem: '2026-10-07',
  dataFinal: '2026-10-28',
  premissas: [
    'Disponibilização no Diário em 05/10/2026.',
    'Publicação no primeiro dia útil seguinte: 06/10/2026.',
  ],
  aviso:
    'Feriado local e suspensões não considerados. Data calculada pelo Processo Vivo: confira no processo.',
};
const COM_PRAZO = (prazo: object) => ({ ...RESULTADO, prazo });

describe.skipIf(sem)('Analisar com IA, no navegador', { timeout: 120_000 }, () => {
  let browser: Browser;
  let amb: Ambiente;
  let ctx: BrowserContext;
  let page: Page;
  let pedidos: Array<{ url: string; corpo: unknown }>;
  let avaliacoes: Array<{ id: string; corpo: unknown }>;
  let falhas: string[];
  /** Como a rota de análise responde: o teste troca e, se quiser, segura a resposta. */
  let responder: (rota: Route) => Promise<void>;
  let avaliacaoFalha = false;
  /** Pedidos ao aviso de prazo (v0.39.0): a prévia não grava; só a confirmação cria. */
  let previas: unknown[];
  let avisos: unknown[];
  let respostaDaPrevia: (rota: Route) => Promise<void>;

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
    opcoes: {
      habilitada?: boolean;
      largura?: number;
      escuro?: boolean;
      oferta?: 'ver_planos' | 'fale_conosco' | 'nenhuma';
    } = {},
  ): Promise<void> {
    pedidos = [];
    avaliacoes = [];
    falhas = [];
    avaliacaoFalha = false;
    previas = [];
    avisos = [];
    respostaDaPrevia = (rota) => json(rota, 200, PREVIA);
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
    await ctx.route('**/v1/novidades**', async (rota) => {
      if (new URL(rota.request().url()).searchParams.get('limite') === '1') {
        return rota.fulfill({ json: respostaNovidades([]) });
      }
      const gA = grupo(
        NA,
        novidade(NA, 'Juntada de petição', {
          diasDetectada: 1,
          chaveDoAto: 'chave-ultimo-8001',
        }),
        [],
        infoProcesso(
          'TJGO',
          'Procedimento Comum Cível',
          ['Autora Sintética'],
          ['Ré Fictícia'],
          true,
          {
            situacao: 'pede',
            motivo: {
              rotulo: 'Ato ordinatório',
              data: iso(3),
              chave: CHAVE_PROVIDENCIA,
              tipo: 'intimacao',
            },
            cumpridoEm: null,
          },
        ),
      );
      const gB = grupo(
        NB,
        novidade(NB, 'Despacho', { diasDetectada: 2 }),
        [],
        infoProcesso(
          'TJSP',
          'Execução Fiscal',
          ['Fazenda Fictícia'],
          ['Devedor Fictício'],
        ),
      );
      const sC = semNovidade(NC, 'Conclusos para decisão', {
        diasAto: 5,
        processo: infoProcesso('TJMG', 'Procedimento Comum Cível', [], []),
      });
      return rota.fulfill({
        json: respostaNovidades([gA, gB], {
          acompanhados: 3,
          janelaDias: null,
          semNovidade: [sC],
        }),
      });
    });
    await ctx.route('**/v1/facetas', async (rota) => {
      const real = (await (await rota.fetch()).json()) as Record<string, unknown>;
      await rota.fulfill({
        json: { ...real, tribunais: ['TJGO', 'TJMG', 'TJSP'], classes: [] },
      });
    });
    await ctx.route('**/v1/analises/disponibilidade', (rota) =>
      json(rota, 200, {
        habilitada: opcoes.habilitada ?? true,
        ...(opcoes.oferta ? { oferta: opcoes.oferta } : {}),
      }),
    );
    await ctx.route('**/v1/acompanhamentos/*/analise', async (rota) => {
      pedidos.push({
        url: rota.request().url(),
        corpo: rota.request().postDataJSON() as unknown,
      });
      await responder(rota);
    });
    await ctx.route('**/v1/analises/*/avaliacao', async (rota) => {
      const id = rota.request().url().split('/v1/analises/')[1]!.split('/')[0]!;
      avaliacoes.push({ id, corpo: rota.request().postDataJSON() as unknown });
      if (avaliacaoFalha) return json(rota, 500, { erro: 'x', mensagem: 'x' });
      const c = rota.request().postDataJSON() as { avaliacao: string };
      return json(rota, 200, { id, avaliacao: c.avaliacao });
    });
    await ctx.route('**/v1/analises/*/aviso/previa', async (rota) => {
      previas.push(rota.request().postDataJSON() as unknown);
      await respostaDaPrevia(rota);
    });
    await ctx.route('**/v1/analises/*/aviso', async (rota) => {
      const c = rota.request().postDataJSON() as { dataLocal?: string };
      avisos.push(c);
      return json(rota, 201, {
        id: 'ev-1',
        tipo: 'prazo',
        titulo: PREVIA.titulo,
        dataLocal: c.dataLocal,
        calculado: c.dataLocal === PREVIA.dataFinal,
      });
    });
    page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e) => {
      throw e;
    });
    page.on('requestfailed', (r) => falhas.push(r.url()));
    // `.nvt-tabela` é a tabela; o esqueleto some quando as linhas chegam.
    await page.goto(amb.url + '/');
    await page.waitForSelector('.nvt-tabela');
    // Abre em "Pedem providência"; os testes querem as três linhas.
    await page.getByRole('button', { name: /^Todas \(/ }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.nvt-tabela tr.nvt-linha').length === 3,
    );
  }

  const linha = (n: string) => page.locator(`tr.nvt-linha[data-processo="${n}"]`);
  const botao = (n: string) => linha(n).getByRole('button', { name: 'Analisar com IA' });
  const painel = (n: string) => page.locator(`#pvia-${n.replace(/\D/g, '')}`);
  const live = () => page.locator('#nvt-live');

  it('IA desligada (padrão): nenhum botão e nenhum painel na página', async () => {
    await abrir({ habilitada: false });
    expect(await page.locator('.pvia-btn').count()).toBe(0);
    expect(await page.locator('.pvia').count()).toBe(0);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(
      'Analisar com IA',
    );
  });

  it('IA ligada: botão discreto na coluna Ações de cada linha, fechado por padrão', async () => {
    await abrir();
    for (const n of [NA, NB, NC]) {
      const b = botao(n);
      expect(await b.count()).toBe(1);
      expect(await b.getAttribute('aria-expanded')).toBe('false');
      expect(await b.evaluate((e) => e.closest('td')?.className)).toBe('c-acoes');
    }
  });

  it('o pedido leva só a chave do ato; na linha de providência é o ato que a gera, nas outras o da linha', async () => {
    await abrir();
    await botao(NA).click();
    await painel(NA).getByText('Parece pedir:').waitFor();
    await botao(NB).click();
    await painel(NB).getByText('Parece pedir:').waitFor();
    await botao(NC).click();
    await painel(NC).getByText('Parece pedir:').waitFor();
    expect(pedidos.map((p) => p.corpo)).toEqual([
      { chaveDoAto: CHAVE_PROVIDENCIA },
      { chaveDoAto: `chave-ato-${NB}-Despacho` },
      { chaveDoAto: `chave-ato-${NC}-Conclusos para decisão` },
    ]);
    // Corpo com UMA chave: nunca texto de ato.
    for (const p of pedidos)
      expect(Object.keys(p.corpo as object)).toEqual(['chaveDoAto']);
  });

  it('abrir: painel logo abaixo da linha, foco nele, aria-expanded, "analisando" e Cancelar que aborta a requisição', async () => {
    await abrir();
    let solta: () => void = () => {};
    const segurar = new Promise<void>((r) => (solta = r));
    responder = async (rota) => {
      await segurar;
      await json(rota, 200, RESULTADO).catch(() => undefined);
    };
    await botao(NA).click();
    const p = painel(NA);
    await p.waitFor();
    expect(
      await p.evaluate((e) =>
        e.closest('tr')?.previousElementSibling?.getAttribute('data-processo'),
      ),
    ).toBe(NA);
    expect(await botao(NA).getAttribute('aria-expanded')).toBe('true');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      `pvia-${NA.replace(/\D/g, '')}`,
    );
    expect(await p.innerText()).toContain(
      'Analisando o ato… isso pode levar até um minuto.',
    );
    expect(await live().textContent()).toContain('Analisando o ato');

    await p.getByRole('button', { name: 'Cancelar' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.pvia').length === 0);
    expect(await botao(NA).getAttribute('aria-expanded')).toBe('false');
    expect(await live().textContent()).toContain('Análise cancelada.');
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-foco')),
    ).toBe(`ia-${NA.replace(/\D/g, '')}`);
    solta();
    // A requisição foi abortada pelo navegador: o servidor vê o cancelamento.
    await page.waitForFunction(() => true);
    expect(falhas.some((u) => u.includes('/analise'))).toBe(true);
  });

  it('resultado: parece pedir, resumo, citações destacadas, pontos de atenção, selo IA com procedência e aviso fixo', async () => {
    await abrir();
    await botao(NA).click();
    const p = painel(NA);
    await p.getByText('Parece pedir:').waitFor();
    const texto = await p.innerText();
    expect(texto).toContain('Manifestação da parte');
    expect(texto).toContain('A parte deve se manifestar sobre o laudo pericial');
    expect(texto).toContain('Conferir o prazo no processo.');
    expect(texto).toContain('O texto do ato pode estar incompleto.');
    expect(texto).toContain(
      'Apoio à leitura, não substitui a leitura do ato nem a contagem de prazo.',
    );
    const marcas = await p.locator('mark').allTextContents();
    // O trecho do ato aparece UMA vez, no próprio campo; a ação não tem bloco de citação.
    expect(marcas).toEqual(['se manifeste sobre o laudo pericial']);
    expect(await p.locator('.pvia-lista blockquote').count()).toBe(0);
    expect(texto).toContain('Parte autora: apresentar manifestação sobre o laudo');
    const selo = p.locator('.pvia-selo');
    expect(await selo.textContent()).toBe('IA');
    expect(await selo.getAttribute('title')).toMatch(
      /^Gerado por IA em .+\. Confira no ato\.$/,
    );
    // A tela não mostra o modelo (continua gravado em analises_ia).
    expect(texto).not.toContain('modelo/teste');
    expect(texto).toMatch(/Gerado por IA em .+\. Confira no ato\./);
    expect(await selo.getAttribute('aria-label')).not.toContain('modelo/teste');
    // Nenhuma outra menção a prazo no texto novo.
    const semFixos = texto
      .replace('Conferir o prazo no processo.', '')
      .replace('nem a contagem de prazo', '');
    expect(semFixos).not.toMatch(/prazo/i);
  });

  it('sem ação indicada pelo ato, mostra a frase fixa e nenhum item de lista', async () => {
    await abrir();
    responder = (rota) => json(rota, 200, { ...RESULTADO, acoesPossiveis: [] });
    await botao(NA).click();
    const p = painel(NA);
    await p.getByText('Parece pedir:').waitFor();
    expect(await p.innerText()).toContain('Sem providência indicada no ato.');
    expect(await p.locator('.pvia-lista li').count()).toBe(2); // só os dois pontos de atenção
  });

  it('avaliação: três botões, confirmação visível, e dá para corrigir; sem texto livre', async () => {
    await abrir();
    await botao(NA).click();
    const p = painel(NA);
    await p.getByText('Parece pedir:').waitFor();
    expect(
      await p.getByRole('button', { name: /^(Útil|Errado|Perigoso)$/ }).count(),
    ).toBe(3);
    expect(await p.locator('textarea, input[type="text"]').count()).toBe(0);

    await p.getByRole('button', { name: 'Útil' }).click();
    await p.getByText('✓ Avaliação registrada.').waitFor();
    expect(
      await p.getByRole('button', { name: 'Útil' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await p.getByRole('button', { name: 'Perigoso' }).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('.pvia-av[data-aval="perigoso"]')
          ?.getAttribute('aria-pressed') === 'true',
    );
    expect(avaliacoes).toEqual([
      { id: 'analise-1', corpo: { avaliacao: 'util' } },
      { id: 'analise-1', corpo: { avaliacao: 'perigoso' } },
    ]);
    expect(
      await p.getByRole('button', { name: 'Útil' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('falha ao gravar a avaliação: diz isso, sem fingir que gravou', async () => {
    await abrir();
    await botao(NA).click();
    const p = painel(NA);
    await p.getByText('Parece pedir:').waitFor();
    avaliacaoFalha = true;
    await p.getByRole('button', { name: 'Errado' }).click();
    await p.getByText('Não foi possível registrar. Tente de novo.').waitFor();
    expect(
      await p.getByRole('button', { name: 'Errado' }).getAttribute('aria-pressed'),
    ).toBe('false');
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
        estado: 'nao_verificada',
        id: 'x',
        acoesPossiveis: [],
        pontosDeAtencao: [],
      },
      texto: 'Não foi possível analisar com segurança. Leia o ato.',
    },
    {
      nome: 'erro do modelo',
      status: 200,
      corpo: { estado: 'erro' },
      texto: 'Não foi possível analisar agora. Tente de novo em alguns minutos.',
    },
    {
      nome: 'erro inesperado do servidor',
      status: 500,
      corpo: { erro: 'x', mensagem: 'x' },
      texto: 'Não foi possível analisar agora. Tente de novo em alguns minutos.',
    },
    ...(
      [
        [
          'sem_plano',
          403,
          'A análise por IA faz parte do plano IA. Faça upgrade do plano para usar.',
        ],
        [
          'segredo_de_justica',
          403,
          'Processo em segredo de justiça: a análise por IA não é feita. Leia o ato.',
        ],
        [
          'texto_insuficiente',
          422,
          'Este ato não traz texto suficiente para analisar. Leia o ato.',
        ],
        [
          'texto_indisponivel',
          422,
          'O tribunal não liberou o texto deste ato. Abra o processo no tribunal.',
        ],
        [
          'limite_de_uso',
          429,
          'Há muitas análises em andamento. Tente novamente em instantes.',
        ],
        [
          'limite_diario',
          429,
          'Muitas análises hoje. Tente de novo amanhã ou fale com a gente.',
        ],
      ] as const
    ).map(([motivo, status, texto]) => ({
      nome: `recusa: ${motivo}`,
      status,
      corpo: { erro: 'ENTRADA_NAO_ANALISAVEL', mensagem: 'x', detalhes: { motivo } },
      texto,
    })),
  ];

  for (const e of ESTADOS) {
    it(`estado "${e.nome}": frase fixa, sem avaliação, sem a palavra prazo fora do aviso fixo`, async () => {
      await abrir();
      responder = (rota) => json(rota, e.status, e.corpo);
      await botao(NA).click();
      const p = painel(NA);
      await p.getByText(e.texto, { exact: true }).waitFor();
      expect(await p.getByRole('button', { name: 'Útil' }).count()).toBe(0);
      expect(await p.locator('mark').count()).toBe(0);
      const txt = (await p.innerText()).replace('nem a contagem de prazo', '');
      expect(txt).not.toMatch(/prazo/i);
      expect(await p.innerText()).toContain(
        'Apoio à leitura, não substitui a leitura do ato',
      );
    });
  }

  it('"Tentar de novo" depois do erro faz outra análise', async () => {
    await abrir();
    responder = (rota) => json(rota, 200, { estado: 'erro' });
    await botao(NA).click();
    const p = painel(NA);
    await p.getByText('Não foi possível analisar agora.').waitFor();
    responder = (rota) => json(rota, 200, RESULTADO);
    await p.getByRole('button', { name: 'Tentar de novo' }).click();
    await p.getByText('Parece pedir:').waitFor();
    expect(pedidos).toHaveLength(2);
  });

  it('teclado: Enter abre, Esc fecha e devolve o foco ao botão; Tab percorre o painel', async () => {
    await abrir();
    await botao(NB).focus();
    await page.keyboard.press('Enter');
    const p = painel(NB);
    await p.getByText('Parece pedir:').waitFor();
    expect(await page.evaluate(() => document.activeElement?.className)).toContain(
      'pvia',
    );
    const visitados: string[] = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      visitados.push(
        await page.evaluate(
          () => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? '',
        ),
      );
    }
    // O selo "IA" é focável: o aviso de procedência também chega por teclado.
    expect(visitados).toEqual(['Fechar', 'IA', 'Útil', 'Errado', 'Perigoso']);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.pvia').length === 0);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-foco')),
    ).toBe(`ia-${NB.replace(/\D/g, '')}`);
    expect(await botao(NB).getAttribute('aria-expanded')).toBe('false');
  });

  it('a análise não muda contagens, ordem nem filtros da tela', async () => {
    await abrir();
    const antes = {
      ordem: await page.locator('.nvt-tabela tr.nvt-linha .nvt-num').allTextContents(),
      chips: await page.locator('.nvt-chips .chip').allTextContents(),
      resumo: await page.locator('.nvt-resumo').innerText(),
    };
    await botao(NA).click();
    await painel(NA).getByText('Parece pedir:').waitFor();
    await painel(NA).getByRole('button', { name: 'Útil' }).click();
    await page.getByText('✓ Avaliação registrada.').waitFor();
    expect({
      ordem: await page.locator('.nvt-tabela tr.nvt-linha .nvt-num').allTextContents(),
      chips: await page.locator('.nvt-chips .chip').allTextContents(),
      resumo: await page.locator('.nvt-resumo').innerText(),
    }).toEqual(antes);
  });

  it('o painel sobrevive a trocar de página/ordenação sem perder o estado da análise', async () => {
    await abrir();
    await botao(NA).click();
    await painel(NA).getByText('Parece pedir:').waitFor();
    await page
      .getByRole('button', { name: /^Processo/ })
      .first()
      .click();
    await painel(NA).getByText('Parece pedir:').waitFor();
    expect(await painel(NA).getByText('Parece pedir:').count()).toBe(1);
  });

  for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
    it(`sem rolagem horizontal da página com o painel aberto em ${largura} px`, async () => {
      await abrir({ largura });
      await botao(NA).click();
      await painel(NA).getByText('Parece pedir:').waitFor();
      await botao(NB).click();
      await painel(NB).getByText('Parece pedir:').waitFor();
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
        painel: Math.max(
          ...Array.from(document.querySelectorAll('.pvia')).map(
            (e) => e.getBoundingClientRect().right,
          ),
        ),
      }));
      expect(m.sw).toBeLessThanOrEqual(m.iw);
      expect(m.painel).toBeLessThanOrEqual(m.iw);
    });
  }

  for (const escuro of [false, true]) {
    it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): botão, analisando, resultado, recusa`, async () => {
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
      expect(await rodar(), 'botão').toBe('');

      await botao(NA).click();
      await painel(NA).getByText('Parece pedir:').waitFor();
      expect(await rodar(), 'resultado').toBe('');
      await painel(NA).getByRole('button', { name: 'Útil' }).click();
      await page.getByText('✓ Avaliação registrada.').waitFor();
      expect(await rodar(), 'avaliado').toBe('');

      responder = (rota) =>
        json(rota, 403, {
          erro: 'ENTRADA_NAO_ANALISAVEL',
          mensagem: 'x',
          detalhes: { motivo: 'sem_plano' },
        });
      await botao(NB).click();
      await painel(NB).getByText('plano IA').waitFor();
      expect(await rodar(), 'recusa').toBe('');
    });
  }

  describe('aviso de upgrade (v0.50.0)', () => {
    const SEM_PLANO =
      'A análise por IA faz parte do plano IA. Faça upgrade do plano para usar.';
    const recusarSemPlano = (rota: Route) =>
      json(rota, 403, {
        erro: 'ENTRADA_NAO_ANALISAVEL',
        mensagem: 'x',
        detalhes: { motivo: 'sem_plano' },
      });

    it('com o plano IA à venda: a frase de sempre e "Ver planos", que leva a Minha conta', async () => {
      await abrir({ oferta: 'ver_planos' });
      responder = recusarSemPlano;
      await botao(NA).click();
      const p = painel(NA);
      await p.getByText(SEM_PLANO, { exact: true }).waitFor();
      const ver = p.getByRole('button', { name: 'Ver planos' });
      expect(await ver.count()).toBe(1);
      expect(await p.innerText()).not.toMatch(/Fale com a gente/);
      await ver.click();
      // Conta de chave de API nesta página: a tela "Minha conta" diz que é chave. O que importa é ter ido.
      await page.waitForFunction(() => document.querySelectorAll('.pvia').length === 0);
      expect(await page.locator('#conteudo').innerText()).toMatch(
        /chave de API|Minha conta/,
      );
    });

    it('com o plano IA fora de venda: só a frase, sem link', async () => {
      await abrir({ oferta: 'nenhuma' });
      responder = recusarSemPlano;
      await botao(NA).click();
      const p = painel(NA);
      await p.getByText(SEM_PLANO, { exact: true }).waitFor();
      expect(await p.getByRole('button', { name: 'Ver planos' }).count()).toBe(0);
      expect(await p.locator('a').count()).toBe(0);
    });

    it('servidor antigo (sem `oferta`): igual a "fora de venda", sem link', async () => {
      await abrir();
      responder = recusarSemPlano;
      await botao(NA).click();
      await painel(NA).getByText(SEM_PLANO, { exact: true }).waitFor();
      expect(await painel(NA).getByRole('button', { name: 'Ver planos' }).count()).toBe(
        0,
      );
    });

    it('conta de chave de API: "Fale com a gente", sem link e sem "upgrade"', async () => {
      await abrir({ oferta: 'fale_conosco' });
      responder = recusarSemPlano;
      await botao(NA).click();
      const p = painel(NA);
      await p
        .getByText(
          'A análise por IA faz parte do plano IA. Fale com a gente para contratar.',
          {
            exact: true,
          },
        )
        .waitFor();
      expect(await p.getByRole('button', { name: 'Ver planos' }).count()).toBe(0);
      expect(await p.innerText()).not.toMatch(/upgrade/i);
      expect(await live().textContent()).toContain('Fale com a gente para contratar.');
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações no aviso com "Ver planos" (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        await abrir({ escuro, oferta: 'ver_planos' });
        responder = recusarSemPlano;
        await botao(NA).click();
        await painel(NA).getByRole('button', { name: 'Ver planos' }).waitFor();
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
          r.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          ),
        ).toEqual([]);
      });
    }
  });

  describe('aviso no calendário (v0.39.0)', () => {
    async function abrirAnalise(resultado: object): Promise<void> {
      await abrir();
      responder = (rota) => json(rota, 200, resultado);
      await botao(NA).click();
      await painel(NA).getByText('Parece pedir:').waitFor();
    }
    const criar = () =>
      painel(NA).getByRole('button', { name: 'Criar aviso no calendário' });

    it('sem prazo na análise: nenhum botão de aviso', async () => {
      await abrirAnalise(RESULTADO);
      expect(await criar().count()).toBe(0);
      expect(await painel(NA).innerText()).not.toContain('Prazo escrito no ato');
    });

    it('prazo em ato do Diário: o botão abre a prévia; sem clique de confirmar, nada é criado', async () => {
      await abrirAnalise(COM_PRAZO({ dias: 15, tipo: 'uteis', calculavel: true }));
      const p = painel(NA);
      expect(await p.innerText()).toContain('15 dias úteis');
      expect(await criar().count()).toBe(1);
      await criar().click();
      await p.getByText('Prévia do aviso — nada foi criado ainda').waitFor();
      const texto = await p.innerText();
      expect(texto).toContain('Prazo de 15 dias úteis (a conferir)');
      expect(texto).toContain('28/10/2026');
      expect(texto).toContain('(a conferir)');
      expect(texto).toContain('Disponibilização no Diário em 05/10/2026.');
      expect(texto).toContain('Feriado local e suspensões não considerados');
      expect(await p.locator('input[type="date"]').inputValue()).toBe('2026-10-28');
      expect(previas).toEqual([{}]);
      expect(avisos).toEqual([]); // prévia não cria
      // Cancelar não cria nada e volta ao botão.
      await p.getByRole('button', { name: 'Cancelar' }).click();
      await criar().waitFor();
      expect(avisos).toEqual([]);
    });

    it('confirmar cria o aviso com a data calculada; editar a data manda a editada', async () => {
      await abrirAnalise(COM_PRAZO({ dias: 15, tipo: 'uteis', calculavel: true }));
      const p = painel(NA);
      await criar().click();
      await p.getByRole('button', { name: 'Confirmar aviso' }).click();
      await p.getByText(/Aviso criado no calendário para 28\/10\/2026/).waitFor();
      expect(await p.innerText()).toContain('A data é calculada: confira no processo.');
      expect(avisos).toEqual([{ dataLocal: '2026-10-28' }]);

      // Outra rodada, com a data editada.
      await fecharEAbrir();
      await criar().click();
      await p.locator('input[type="date"]').fill('2026-10-30');
      await p.getByRole('button', { name: 'Confirmar aviso' }).click();
      await p.getByText(/Aviso criado no calendário para 30\/10\/2026/).waitFor();
      expect(avisos.at(-1)).toEqual({ dataLocal: '2026-10-30' });
      expect(await p.innerText()).toContain('A data foi editada por você.');
    });

    async function fecharEAbrir(): Promise<void> {
      await botao(NA).click(); // fecha
      await page.waitForFunction(() => document.querySelectorAll('.pvia').length === 0);
      await botao(NA).click(); // abre de novo (nova análise, mesmo dublê)
      await painel(NA).getByText('Parece pedir:').waitFor();
    }

    it('ato sem tipo: sem tipo padrão, pede a escolha antes de calcular', async () => {
      await abrirAnalise(COM_PRAZO({ dias: 10, tipo: null, calculavel: true }));
      const p = painel(NA);
      expect(await p.innerText()).toContain('o ato não diz se são úteis ou corridos');
      await criar().click();
      await p.getByText('O ato não diz se os dias são úteis ou corridos.').waitFor();
      // v0.40.1: nenhuma opção vem pré-marcada e "Calcular" só ativa depois da escolha.
      expect(await p.locator('input[type="radio"]').count()).toBe(2);
      expect(await p.locator('input[type="radio"]:checked').count()).toBe(0);
      expect(await p.getByLabel('Dias úteis').isChecked()).toBe(false);
      expect(await p.getByLabel('Dias corridos').isChecked()).toBe(false);
      expect(await p.getByRole('button', { name: 'Calcular' }).isDisabled()).toBe(true);
      expect(previas).toEqual([]); // nada foi pedido ainda
      await p.getByLabel('Dias corridos').check();
      expect(await p.getByRole('button', { name: 'Calcular' }).isEnabled()).toBe(true);
      expect(previas).toEqual([]); // escolher não calcula: só o clique em Calcular
      await p.getByRole('button', { name: 'Calcular' }).click();
      await p.getByText('Prévia do aviso — nada foi criado ainda').waitFor();
      expect(previas).toEqual([{ tipo: 'corridos' }]);
    });

    it('a escolha é da pessoa: o foco vai ao primeiro rádio, o teclado escolhe e Cancelar/reabrir volta sem nada marcado', async () => {
      await abrirAnalise(COM_PRAZO({ dias: 10, tipo: null, calculavel: true }));
      const p = painel(NA);
      await criar().click();
      await p.getByText('O ato não diz se os dias são úteis ou corridos.').waitFor();
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute('data-foco')),
      ).toBe(`iaavtipo-${NA.replace(/\D/g, '')}`);
      await page.keyboard.press('Space'); // marca "Dias úteis" no rádio focado
      expect(await p.getByLabel('Dias úteis').isChecked()).toBe(true);
      expect(await p.getByRole('button', { name: 'Calcular' }).isEnabled()).toBe(true);
      await p.getByRole('button', { name: 'Cancelar' }).click();
      await criar().click();
      await p.getByText('O ato não diz se os dias são úteis ou corridos.').waitFor();
      expect(await p.locator('input[type="radio"]:checked').count()).toBe(0);
      expect(await p.getByRole('button', { name: 'Calcular' }).isDisabled()).toBe(true);
      expect(previas).toEqual([]);
    });

    it('ato que já diz o tipo: não pergunta e calcula direto, sem opção a marcar', async () => {
      await abrirAnalise(COM_PRAZO({ dias: 15, tipo: 'uteis', calculavel: true }));
      const p = painel(NA);
      await criar().click();
      await p.getByText('Prévia do aviso — nada foi criado ainda').waitFor();
      expect(await p.locator('input[type="radio"]').count()).toBe(0);
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações no aviso (tema ${escuro ? 'escuro' : 'claro'}): botão, escolha e prévia`, async () => {
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
        responder = (rota) =>
          json(rota, 200, COM_PRAZO({ dias: 10, tipo: null, calculavel: true }));
        await botao(NA).click();
        await painel(NA).getByText('Parece pedir:').waitFor();
        expect(await rodar(), 'botão do aviso').toBe('');
        await criar().click();
        await painel(NA)
          .getByText('O ato não diz se os dias são úteis ou corridos.')
          .waitFor();
        expect(await rodar(), 'escolha').toBe('');
        await painel(NA).getByLabel('Dias úteis').check();
        await painel(NA).getByRole('button', { name: 'Calcular' }).click();
        await painel(NA).getByText('Prévia do aviso — nada foi criado ainda').waitFor();
        expect(await rodar(), 'prévia').toBe('');
      });
    }

    it('ato fora do Diário: não calcula e manda criar o aviso manualmente', async () => {
      await abrirAnalise(COM_PRAZO({ dias: 15, tipo: 'uteis', calculavel: false }));
      expect(await criar().count()).toBe(0);
      expect(await painel(NA).innerText()).toContain(
        'Este ato não é do Diário, então o prazo não é calculado. Crie o aviso manualmente no calendário.',
      );
      expect(previas).toEqual([]);
    });

    it('erro da prévia vira frase fixa com "Tentar de novo"; nada é criado', async () => {
      await abrirAnalise(COM_PRAZO({ dias: 15, tipo: 'uteis', calculavel: true }));
      respostaDaPrevia = (rota) =>
        json(rota, 422, {
          erro: 'PRAZO_NAO_CALCULAVEL',
          mensagem: 'texto do servidor que não deve aparecer',
          detalhes: { motivo: 'ato_fora_do_diario' },
        });
      await criar().click();
      const p = painel(NA);
      await p
        .getByText('Este ato não é do Diário, então o prazo não é calculado.')
        .first()
        .waitFor();
      expect(await p.innerText()).not.toContain('texto do servidor');
      await p.getByRole('button', { name: 'Tentar de novo' }).waitFor();
      expect(avisos).toEqual([]);
    });
  });
});
