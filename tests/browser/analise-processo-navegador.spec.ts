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
 * "Analisar processo com IA" NUM NAVEGADOR (v0.66.0). Servidor, console e Pasta digital são os reais (tribunal
 * falso, peças sintéticas); só as rotas da análise do processo são simuladas com o contrato da API (que tem
 * teste próprio em tests/http/analise-do-processo.spec.ts). Nenhuma chamada a modelo, nenhuma rede.
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

const fonte = (rotulo: string, pagina: number, trecho: string) => ({
  pecaId: 'p01',
  rotulo,
  data: '2026-03-02T12:00:00.000Z',
  pagina,
  trecho,
});
const PECAS_DO_JOB = [
  {
    pecaId: 'p01',
    rotulo: 'Petição - inicial',
    data: null,
    estado: 'lida',
    motivo: null,
  },
  {
    pecaId: 'p05',
    rotulo: 'Petição - contestação',
    data: null,
    estado: 'lida',
    motivo: null,
  },
  { pecaId: 'p09', rotulo: 'Sentença', data: null, estado: 'fora', motivo: 'sem_texto' },
];
const CONCLUIDA = {
  id: 'job-1',
  fase: 'concluida',
  motivo: null,
  total: 3,
  concluidas: 3,
  pecas: PECAS_DO_JOB,
  resultado: {
    sintese: {
      id: 'sintese-1',
      estado: 'verificada',
      reaproveitada: false,
      objeto: {
        texto: 'Discute-se a restituição de valores cobrados.',
        fontes: [fonte('Petição - inicial', 1, 'restituição dos valores')],
      },
      pedidos: [
        {
          texto: 'A parte autora pede a restituição dos valores.',
          fontes: [fonte('Petição - inicial', 2, 'pede a restituição')],
          defesa: {
            texto: 'A parte ré alega que a cobrança foi regular.',
            fontes: [fonte('Petição - contestação', 1, 'a cobrança foi regular')],
          },
          decisao: null,
        },
      ],
      linhaDoTempo: [
        {
          texto: 'A parte autora pede a restituição.',
          fontes: [fonte('Petição - inicial', 2, 'pede a restituição')],
        },
      ],
      controvertidos: [
        {
          texto: 'As partes divergem sobre a regularidade da cobrança.',
          fontes: [
            fonte('Petição - inicial', 2, 'cobrança indevida'),
            fonte('Petição - contestação', 1, 'a cobrança foi regular'),
          ],
        },
      ],
      criadaEm: '2026-10-29T12:00:00.000Z',
      avaliacao: null,
    },
    semSintese: null,
    classe: 'Procedimento Comum Cível',
    partes: { autores: ['Fulana de Teste'], reus: ['Empresa Fictícia S.A.'] },
    determinacoes: [
      {
        quem: 'A parte ré',
        texto: 'determina que se manifeste',
        prazo: '15 (quinze) dias',
        fonte: fonte('Despacho - inicial', 1, 'manifeste-se em 15 (quinze) dias'),
      },
    ],
    documentos: [
      { nome: 'Contrato', fonte: fonte('Petição - inicial', 3, 'contrato anexo') },
    ],
    valores: [
      {
        valor: 'R$ 1.000,00',
        contexto: 'valor cobrado',
        fonte: fonte('Petição - inicial', 2, 'R$ 1.000,00'),
      },
    ],
  },
};
const LARGURAS = [1920, 1366, 1280, 1024, 768, 390];

describe.skipIf(sem)(
  'Analisar processo com IA, no navegador',
  { timeout: 180_000 },
  () => {
    let browser: Browser;
    let amb: Ambiente;
    let ctx: BrowserContext;
    let page: Page;
    let inicios: unknown[];
    let cancelamentos: number;
    let consultas: number;

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
        largura?: number;
        escuro?: boolean;
        iniciar?: (rota: Route) => Promise<void>;
        andamento?: boolean;
      } = {},
    ): Promise<void> {
      inicios = [];
      cancelamentos = 0;
      consultas = 0;
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
      await ctx.route('**/v1/analises-do-processo/disponibilidade', (rota) =>
        json(rota, 200, { liberado: o.liberado !== false }),
      );
      await ctx.route(
        '**/v1/processos/*/analise-do-processo/estimativa',
        async (rota) => {
          const n = (rota.request().postDataJSON() as { pecas: string[] }).pecas.length;
          await json(rota, 200, {
            total: n,
            sigilosas: 0,
            aBuscarNoTribunal: n,
            jaAnalisadas: 0,
            pesoMaximo: n * 5 + 5,
          });
        },
      );
      await ctx.route('**/v1/processos/*/analise-do-processo', async (rota) => {
        inicios.push(rota.request().postDataJSON() as unknown);
        if (o.iniciar) return o.iniciar(rota);
        await json(rota, 202, {
          ...CONCLUIDA,
          fase: 'pecas',
          concluidas: 0,
          resultado: null,
          pecas: PECAS_DO_JOB.map((p) => ({ ...p, estado: 'aguardando', motivo: null })),
        });
      });
      await ctx.route('**/v1/analises-do-processo/job-1', async (rota) => {
        if (rota.request().method() === 'DELETE') {
          cancelamentos++;
          return json(rota, 200, { ...CONCLUIDA, fase: 'cancelada', resultado: null });
        }
        consultas++;
        await json(
          rota,
          200,
          o.andamento
            ? { ...CONCLUIDA, fase: 'pecas', concluidas: 1, resultado: null }
            : CONCLUIDA,
        );
      });
      await ctx.route('**/v1/sinteses-do-processo/*/avaliacao', (rota) =>
        json(rota, 200, { id: 'sintese-1' }),
      );
      page = await ctx.newPage();
      page.setDefaultTimeout(20_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      const facetas = page.waitForResponse('**/v1/facetas');
      await page.goto(amb.url + '/');
      await esperarConsolePronto(page);
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
      await page.click('#pasta-abrir');
      await page.waitForSelector('#pasta .linha');
    }

    const botao = () => page.locator('#pasta-proc-ia-bt');
    const dialogo = () =>
      page.getByRole('dialog', { name: 'Análise do processo com IA' });
    const marcarPrincipais = async (): Promise<void> => {
      await botao().waitFor();
      await botao().click();
      await dialogo().getByRole('button', { name: 'Marcar peças principais' }).click();
      await dialogo()
        .getByRole('button', { name: /^Analisar \d+ peças$/ })
        .waitFor();
    };
    const ateOResultado = async (): Promise<void> => {
      await marcarPrincipais();
      await dialogo()
        .getByRole('button', { name: /^Analisar \d+ peças$/ })
        .click();
      await dialogo().getByRole('heading', { name: 'Quadro do caso' }).waitFor();
    };

    it('conta fora da lista: o botão não aparece', async () => {
      await abrir({ liberado: false });
      await page
        .waitForResponse('**/v1/analises-do-processo/disponibilidade')
        .catch(() => {});
      expect(await botao().isHidden()).toBe(true);
    });

    it('o atalho marca as peças principais na lista, sem laudo, e nada sai sem confirmar', async () => {
      await abrir();
      await marcarPrincipais();
      expect(await botao().textContent()).toBe('Analisar processo com IA (6)');
      const marcadas = await page.$$eval('#pasta .linha[aria-selected="true"]', (ls) =>
        ls.map((l) => l.id),
      );
      expect(marcadas).toEqual([
        'pf-p01',
        'pf-p05',
        'pf-p06',
        'pf-p08',
        'pf-p09',
        'pf-p12',
      ]);
      const t = await dialogo().innerText();
      expect(t).toContain('6 peças marcadas');
      expect(t).toContain('Conta até 35 no limite de análises de hoje.');
      expect(inicios).toHaveLength(0);
    });

    it('confirma, acompanha e mostra os sete blocos, com trecho e página de cada item', async () => {
      await abrir();
      await ateOResultado();
      expect(inicios).toEqual([{ pecas: ['p01', 'p05', 'p06', 'p08', 'p09', 'p12'] }]);
    // O resultado chega pela consulta do job, não pela resposta do início.
    expect(consultas).toBeGreaterThan(0);
      const d = dialogo();
      for (const titulo of [
        'Quadro do caso',
        'Pedidos, defesa e decisões',
        'Linha do tempo das teses',
        'Pontos controvertidos',
        'O que o juízo determinou',
        'Documentos e valores',
        'O que ficou de fora',
      ]) {
        expect(await d.getByRole('heading', { name: titulo }).count()).toBe(1);
      }
      const t = await d.innerText();
      expect(t).toContain('Fulana de Teste × Empresa Fictícia S.A.');
      expect(t).toContain('Prazo escrito no ato: 15 (quinze) dias');
      expect(t).toContain('Sentença: sem texto pesquisável');
      expect(t).toContain(
        'Análise automática das peças escolhidas, apoio à leitura. Não avalia mérito nem conta prazo. Confira nas peças.',
      );
      const cit = d.locator('details.pvpr-cit').first();
      expect(await cit.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
      expect(await cit.locator('summary').innerText()).toContain('pág. 1');
      expect(await d.locator('.pvpol-b').count()).toBe(2);
    });

    it('Esc fecha o diálogo sem fechar a Pasta e devolve o foco ao botão; o foco abre no título', async () => {
      await abrir();
      await botao().waitFor();
      await botao().focus();
      await page.keyboard.press('Enter');
      await dialogo().waitFor();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pvpr-tit');
      await page.keyboard.press('Escape');
      expect(await dialogo().count()).toBe(0);
      expect(await page.locator('#pasta').isVisible()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        'pasta-proc-ia-bt',
      );
    });

    it('em andamento mostra a peça da vez e Cancelar chama o DELETE', async () => {
      await abrir({ andamento: true });
      await marcarPrincipais();
      await dialogo()
        .getByRole('button', { name: /^Analisar \d+ peças$/ })
        .click();
      await dialogo().getByText('Lendo as peças: ').waitFor();
      await dialogo().getByRole('button', { name: 'Cancelar' }).click();
      await dialogo().getByText('Análise cancelada.').waitFor();
      expect(cancelamentos).toBe(1);
    });

    it('recusa do servidor vira frase fixa, nunca o texto dele', async () => {
      await abrir({
        iniciar: (rota) =>
          json(rota, 429, {
            erro: 'ANALISE_DO_PROCESSO_RECUSADA',
            mensagem: 'TEXTO DO SERVIDOR',
            detalhes: { motivo: 'limite_de_uso' },
          }),
      });
      await marcarPrincipais();
      await dialogo()
        .getByRole('button', { name: /^Analisar \d+ peças$/ })
        .click();
      await dialogo().getByRole('alert').waitFor();
      const t = await dialogo().innerText();
      expect(t).toContain('Já há uma análise em andamento');
      expect(t).not.toContain('TEXTO DO SERVIDOR');
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações no resultado (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        await abrir({ escuro });
        await ateOResultado();
        await dialogo().locator('details.pvpr-cit summary').first().click();
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const r = await page.evaluate(() =>
          (window as unknown as AxeNaPagina).axe.run(document.getElementById('pvpr')!, {
            rules: { 'color-contrast': { enabled: true } },
          }),
        );
        expect(
          r.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          ),
        ).toEqual([]);
      });
    }

    for (const largura of LARGURAS) {
      it(`sem rolagem horizontal com o resultado em ${largura} px`, async () => {
        await abrir({ largura });
        await ateOResultado();
        const m = await page.evaluate(() => {
          const d = document.querySelector('#pvpr .pvpr')!;
          return {
            sw: document.documentElement.scrollWidth,
            iw: window.innerWidth,
            direita: d.getBoundingClientRect().right,
            dentro: d.scrollWidth - d.clientWidth,
          };
        });
        expect(m.sw).toBeLessThanOrEqual(m.iw);
        expect(m.direita).toBeLessThanOrEqual(m.iw);
        expect(m.dentro).toBeLessThanOrEqual(0);
      });
    }
  },
);
