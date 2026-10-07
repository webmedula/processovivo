/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROCESSO_TJGO, PROCESSO_TJGO_DIGITOS } from '../helpers/leitor.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';

/*
 * O histórico de PEÇAS BAIXADAS dentro da Pasta digital (v0.37.0), no navegador:
 * saiu da página inicial e vive aqui, por processo. Servidor real + tribunal
 * falso; os downloads avulsos são feitos de verdade pela API (registro real em
 * `pecas_baixadas`), e um segundo processo prova o isolamento por processo.
 * Dados sintéticos.
 */
const sem = CHROMIUM === undefined;
const OUTRO_PROCESSO = numeroValido(7777);
const NOME_LONGO =
  ('arquivosinteticosemespaco' + 'abcdefghij').repeat(3).slice(0, 120) + '.pdf';

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

describe.skipIf(sem)(
  'Pasta digital — histórico de peças baixadas, no navegador',
  { timeout: 60_000 },
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
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(async () => {
      await ctx?.close();
      await amb?.encerrar();
    });

    async function baixarAvulsa(numero: string, id: string): Promise<void> {
      // O tribunal falso só entrega peça em lote (o leitor); o download avulso usa a
      // chamada individual, que aqui devolve um PDF mínimo com o nome da peça.
      amb.provedor.obterConteudo = async (...args: unknown[]) => {
        const pecaId = String(args[1]);
        return {
          id: pecaId,
          mimetype: 'application/pdf',
          nomeArquivo: `peca-${pecaId}.pdf`,
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        };
      };
      const r = await amb.servidor.inject({
        method: 'GET',
        url: `/v1/processos/${numero}/pecas/${id}`,
        headers: { 'x-api-key': CHAVE },
      });
      expect(r.statusCode).toBe(200);
    }

    async function abrirPasta(
      opcoes: { largura?: number; escuro?: boolean; antes?: () => Promise<void> } = {},
    ): Promise<void> {
      amb = await iniciar();
      await opcoes.antes?.();
      ctx = await browser.newContext({
        viewport: { width: opcoes.largura ?? 1360, height: 860 },
        colorScheme: opcoes.escuro ? 'dark' : 'light',
      });
      await ctx.addInitScript((c) => {
        try {
          localStorage.setItem('processovivo.chave', c);
        } catch {
          /* sem armazenamento: o teste falharia adiante, com a causa à vista */
        }
      }, CHAVE);
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(amb.url + '/');
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { __pv?: { abrir: unknown } }).__pv?.abrir ===
          'function',
      );
      await page.evaluate(
        (n) => (window as unknown as { __pv: { abrir(n: string): void } }).__pv.abrir(n),
        PROCESSO_TJGO,
      );
      await page.waitForSelector('#pasta-abrir');
      await page.click('#pasta-abrir');
      await page.waitForSelector('#pasta .linha');
    }

    it('a gaveta nasce fechada, abre pelo botão "Peças baixadas" e mostra só o histórico DESTE processo', async () => {
      await abrirPasta({
        antes: async () => {
          await baixarAvulsa(PROCESSO_TJGO, 'p01');
          await baixarAvulsa(PROCESSO_TJGO, 'p05');
          await baixarAvulsa(OUTRO_PROCESSO, 'p07');
        },
      });
      const botao = page.locator('#pasta-baixadas-bt');
      expect(await botao.textContent()).toBe('Peças baixadas');
      expect(await botao.getAttribute('aria-expanded')).toBe('false');
      expect(await page.locator('#pasta-baixadas').isVisible()).toBe(false);

      const pedidos: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/v1/pecas-baixadas')) pedidos.push(r.url());
      });
      await botao.click();
      await page.waitForSelector('#pasta-baixadas .pbx-item');
      expect(await botao.getAttribute('aria-expanded')).toBe('true');
      expect(pedidos).toHaveLength(1);
      expect(
        new URL(pedidos[0] as string).searchParams.get('numero')?.replace(/\D/g, ''),
      ).toBe(PROCESSO_TJGO_DIGITOS);

      const itens = page.locator('#pasta-baixadas .pbx-item');
      expect(await itens.count()).toBe(2);
      const texto = await page.locator('#pasta-baixadas').innerText();
      // Rótulo, tamanho, data e hora e "hoje" — só do processo aberto.
      expect(texto).toMatch(/\d+ (B|KB|MB)/);
      expect(texto).toMatch(/\d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}/);
      expect(texto).toContain('hoje');
      expect(texto).toContain('2 peças baixadas');
      // O outro processo não aparece: nem o número, nem o item dele.
      expect(texto).not.toContain(OUTRO_PROCESSO);
      expect(await page.locator('#pasta-baixadas .pbx-item .pbx-rotulo').count()).toBe(2);

      // Fechar esconde e esvazia; abrir de novo relê o servidor.
      await botao.click();
      expect(await page.locator('#pasta-baixadas').isVisible()).toBe(false);
      expect(await botao.getAttribute('aria-expanded')).toBe('false');
    });

    it('diz que o arquivo não fica guardado aqui — é o registro do que já foi puxado — e não oferece baixar de novo', async () => {
      await abrirPasta({ antes: () => baixarAvulsa(PROCESSO_TJGO, 'p01') });
      await page.click('#pasta-baixadas-bt');
      await page.waitForSelector('#pasta-baixadas .pbx-item');
      const g = page.locator('#pasta-baixadas');
      expect(await g.innerText()).toContain('O arquivo não fica guardado aqui');
      expect(await g.innerText()).toContain('histórico do que já foi puxado');
      expect(await g.locator('button, a').count()).toBe(0);
    });

    it('processo sem download: mensagem clara, sem lista vazia', async () => {
      await abrirPasta({ antes: () => baixarAvulsa(OUTRO_PROCESSO, 'p01') });
      await page.click('#pasta-baixadas-bt');
      await page.waitForSelector('#pasta-baixadas .pbx-vazio');
      expect(await page.locator('#pasta-baixadas').innerText()).toContain(
        'Nenhuma peça baixada deste processo ainda.',
      );
      expect(await page.locator('#pasta-baixadas .pbx-lista').count()).toBe(0);
    });

    it('"há N dias": hoje, dias e meses vêm da data do download; nome de arquivo de 120 caracteres sem espaço não estoura a Pasta', async () => {
      await abrirPasta({ largura: 1100 });
      const agora = Date.now();
      await page.route('**/v1/pecas-baixadas**', (rota) =>
        rota.fulfill({
          json: {
            hoje: 1,
            total: 3,
            pecas: [
              {
                numero: PROCESSO_TJGO_DIGITOS,
                idPeca: 'a',
                rotulo: NOME_LONGO,
                mimetype: 'application/pdf',
                bytes: 1234,
                baixadaEm: new Date(agora).toISOString(),
              },
              {
                numero: PROCESSO_TJGO_DIGITOS,
                idPeca: 'b',
                rotulo: 'Petição - sintética',
                mimetype: 'application/pdf',
                bytes: 2_500_000,
                baixadaEm: new Date(agora - 3 * 86_400_000).toISOString(),
              },
              {
                numero: PROCESSO_TJGO_DIGITOS,
                idPeca: 'c',
                rotulo: 'Laudo sintético',
                mimetype: 'application/pdf',
                bytes: 40_000,
                baixadaEm: new Date(agora - 70 * 86_400_000).toISOString(),
              },
            ],
          },
        }),
      );
      await page.click('#pasta-baixadas-bt');
      await page.waitForSelector('#pasta-baixadas .pbx-item');
      const det = await page.locator('#pasta-baixadas .pbx-det').allInnerTexts();
      expect(det[0]).toContain('1 KB');
      expect(det[0]).toContain('hoje');
      expect(det[1]).toContain('2,4 MB');
      expect(det[1]).toContain('há 3 dias');
      expect(det[2]).toContain('há 2 meses');
      expect(
        await page.locator('#pasta-baixadas .pbx-rotulo').first().textContent(),
      ).toBe(NOME_LONGO);
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        pasta: document.querySelector('#pasta')!.scrollWidth,
        pastaCw: document.querySelector('#pasta')!.clientWidth,
      }));
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      expect(m.pasta).toBeLessThanOrEqual(m.pastaCw);
    });

    it('erro ao carregar: diz o que houve e "Tentar de novo" funciona', async () => {
      await abrirPasta({ antes: () => baixarAvulsa(PROCESSO_TJGO, 'p01') });
      let falhar = true;
      await page.route('**/v1/pecas-baixadas**', async (rota) => {
        if (falhar) {
          falhar = false;
          return rota.fulfill({
            status: 500,
            json: { erro: 'ERRO_INTERNO', mensagem: 'Falha sintética.' },
          });
        }
        return rota.continue();
      });
      await page.click('#pasta-baixadas-bt');
      await page.waitForSelector('#pasta-baixadas-tentar');
      expect(await page.locator('#pasta-baixadas').innerText()).toContain(
        'Não consegui carregar o histórico',
      );
      await page.click('#pasta-baixadas-tentar');
      await page.waitForSelector('#pasta-baixadas .pbx-item');
    });

    it('abrir a gaveta não consulta o tribunal nem mexe na lista da Pasta; a lista continua com a altura dela', async () => {
      await abrirPasta({ antes: () => baixarAvulsa(PROCESSO_TJGO, 'p01') });
      const lotesAntes = amb.provedor.lotes().length;
      const linhasAntes = await page.locator('#pasta .linha').count();
      await page.click('#pasta-baixadas-bt');
      await page.waitForSelector('#pasta-baixadas .pbx-item');
      expect(amb.provedor.lotes().length).toBe(lotesAntes);
      expect(await page.locator('#pasta .linha').count()).toBe(linhasAntes);
      // A Pasta continua sem rolagem da página, e a lista tem altura visível.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollHeight <= window.innerHeight + 1,
        ),
      ).toBe(true);
      const h = await page
        .locator('#pasta-itens')
        .evaluate((e) => e.getBoundingClientRect().height);
      expect(h).toBeGreaterThan(120);
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações na gaveta, tema ${escuro ? 'escuro' : 'claro'}`, async () => {
        await abrirPasta({ escuro, antes: () => baixarAvulsa(PROCESSO_TJGO, 'p01') });
        await page.click('#pasta-baixadas-bt');
        await page.waitForSelector('#pasta-baixadas .pbx-item');
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const r = await page.evaluate(() =>
          (window as unknown as AxeNaPagina).axe.run(document.querySelector('#pasta')!, {
            rules: { 'color-contrast': { enabled: true } },
          }),
        );
        expect(
          r.violations
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
            .join('\n'),
        ).toBe('');
      });
    }
  },
);

describe.skipIf(sem)(
  'Tabela de Atualizações → "Abrir pasta"',
  { timeout: 60_000 },
  () => {
    it('o botão da linha abre o processo e já abre a Pasta digital (e só dessa vez)', async () => {
      const browser = await chromium.launch({
        executablePath: CHROMIUM as string,
        args: ['--no-sandbox'],
      });
      const amb = await iniciar();
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
      try {
        await ctx.addInitScript((c) => {
          try {
            localStorage.setItem('processovivo.chave', c);
          } catch {
            /* sem armazenamento: o teste falharia adiante, com a causa à vista */
          }
        }, CHAVE);
        const agora = new Date().toISOString();
        const nov = {
          id: 1,
          numero: PROCESSO_TJGO_DIGITOS,
          data: agora,
          titulo: 'Sentença',
          codigoTpu: null,
          conteudo: null,
          detectadaEm: agora,
          exigeAcao: false,
          vista: false,
        };
        await ctx.route('**/v1/novidades**', async (rota) => {
          const real = (await (await rota.fetch()).json()) as Record<string, unknown>;
          await rota.fulfill({
            json: {
              ...real,
              acompanhados: 1,
              naoVistas: 1,
              janelaDias: 15,
              janelaPadraoDias: 15,
              pendenciaJanelaDias: 10,
              foraDaJanela: 0,
              grupos: [
                {
                  numero: PROCESSO_TJGO_DIGITOS,
                  processo: null,
                  maisRecente: nov,
                  quantidade: 1,
                  naoVistas: 1,
                },
              ],
            },
          });
        });
        const page = await ctx.newPage();
        page.setDefaultTimeout(15_000);
        await page.goto(amb.url + '/');
        await page.waitForSelector('.nvt-tabela');
        // "Abrir processo": só o processo, a Pasta continua fechada.
        await page.click('.nvt-ic[data-acao="abrir"]');
        await page.waitForSelector('#pasta-abrir');
        expect(await page.locator('#pasta').count()).toBe(0);
        await page.click('#voltar');
        await page.waitForSelector('.nvt-tabela');
        // "Abrir pasta": abre o processo e a Pasta com a lista de peças.
        await page.click('[data-acao="pasta"]');
        await page.waitForSelector('#pasta .linha');
        expect(await page.locator('#pasta-titulo-geral').textContent()).toContain(
          '9999901-96.2026.8.09.9999',
        );
        // O pedido é de uma vez: fechar a Pasta e reabrir o processo pelo link não a reabre.
        await page.click('#pasta-fechar');
        await page.click('#voltar');
        await page.waitForSelector('.nvt-tabela');
        await page.click('.nvt-ic[data-acao="abrir"]');
        await page.waitForSelector('#pasta-abrir');
        expect(await page.locator('#pasta').count()).toBe(0);
      } finally {
        await ctx.close();
        await browser.close();
        await amb.encerrar();
      }
    });
  },
);
