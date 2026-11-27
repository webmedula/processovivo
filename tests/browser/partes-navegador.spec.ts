/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CHAVE, CHROMIUM } from './ambiente.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Peca } from '../../src/domain/entities/Peca.js';
import type { ConteudoPeca } from '../../src/domain/entities/Peca.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import type {
  AtosDoProcesso,
  ProvedorDePecas,
} from '../../src/domain/ports/ProvedorDePecas.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';
import { esperarConsolePronto } from './console.js';

/*
 * v0.71.0 NUM NAVEGADOR: o cartão "Partes" usa as partes dos AUTOS quando a consulta ao tribunal
 * as traz, e diz que a lista do Diário pode estar incompleta quando não. O caso real que motivou:
 * cumprimento de sentença em que o Diário só trazia o exequente intimado e o executado sumia.
 * Servidor e console reais; nomes SINTÉTICOS (repositório público).
 */
const sem = CHROMIUM === undefined;
const NO_TJGO = numeroValido(7201, '09', '0011');
const NO_TJSP = numeroValido(7202, '26', '0100');

interface ConsolePv {
  __pv?: { abrir(n: string): unknown };
}
interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

class TribunalComPartes implements ProvedorDePecas {
  readonly nome = 'mni-falso';
  readonly tribunais = ['TJGO'];
  async listarAtos(): Promise<AtosDoProcesso> {
    return {
      movimentos: [
        {
          data: new Date('2026-09-01T10:00:00'),
          titulo: 'Juntada de petição',
          idExterno: 'mni:1',
          fonte: 'mni',
        },
      ],
      pecas: [
        new Peca({
          id: 'doc-1',
          tipo: '57',
          descricao: 'Petição',
          mimetype: 'application/pdf',
          movimento: 1,
        }),
      ],
      partes: [
        {
          nome: 'BANCO SINTETICO S.A',
          polo: 'ATIVO',
          tipoPessoa: 'JURIDICA',
          advogados: [{ nome: 'ADVOGADA SINTETICA', oab: '99999', ufOab: 'GO' }],
        },
        {
          nome: 'ADVOGADA SINTETICA',
          polo: 'ATIVO',
          tipoPessoa: 'FISICA',
          advogados: [{ nome: 'ADVOGADA SINTETICA', oab: '99999', ufOab: 'GO' }],
        },
        {
          nome: 'EXECUTADO SINTETICO',
          polo: 'PASSIVO',
          tipoPessoa: 'FISICA',
          advogados: [],
        },
      ],
    };
  }
  async listarPecas(): Promise<Peca[]> {
    return [...(await this.listarAtos()).pecas];
  }
  async obterConteudo(): Promise<ConteudoPeca> {
    return {
      id: 'doc-1',
      mimetype: 'application/pdf',
      nomeArquivo: 'p.pdf',
      bytes: new Uint8Array([0x25]),
    };
  }
}

/** O retrato do Diário: só quem foi intimado. */
function doDiario(numero: string, tribunal: string): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal,
    classe: 'Cumprimento de Sentença',
    partes: [
      {
        nome: 'ADVOGADA SINTETICA',
        polo: 'ATIVO',
        tipoPessoa: 'DESCONHECIDO',
        advogados: [{ nome: 'ADVOGADA SINTETICA', oab: '99999', ufOab: 'GO' }],
      },
    ],
    movimentacoes: [
      {
        data: new Date('2026-09-02T00:00:00'),
        titulo: 'Intimação',
        idExterno: 'djen:1',
        fonte: 'djen',
      },
    ],
    procedencia: { provider: 'djen', consultadoEm: new Date(), deCache: false },
  });
}

describe.skipIf(sem)(
  'Cartão "Partes": dos autos ou do Diário, no navegador',
  { timeout: 90_000 },
  () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    let servidor: FastifyInstance | undefined;
    let url = '';

    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath: CHROMIUM as string,
        args: ['--no-sandbox'],
      });
      const app = aplicacaoDeTeste(
        [
          new ProviderFalso({
            nome: 'falso',
            porNumero: async (n) =>
              NumeroCNJ.criar(n).digitos === NumeroCNJ.criar(NO_TJGO).digitos
                ? doDiario(n, 'TJGO')
                : doDiario(n, 'TJSP'),
          }),
        ],
        { provedorDePecas: new TribunalComPartes() },
      );
      servidor = construirServidor(
        app,
        carregarConfig({
          PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
          LOG_LEVEL: 'silent',
          CACHE_ENABLED: 'false',
          PROCESSOVIVO_API_KEYS: CHAVE,
          RATE_LIMIT_MAX: '100000',
        } as NodeJS.ProcessEnv),
      );
      const h = { 'x-api-key': CHAVE };
      const cred = await servidor.inject({
        method: 'PUT',
        url: '/v1/credenciais',
        headers: h,
        payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
      });
      if (cred.statusCode >= 300)
        throw new Error(`credencial: ${cred.statusCode} ${cred.body}`);
      for (const numero of [NO_TJGO, NO_TJSP]) {
        const r = await servidor.inject({
          method: 'POST',
          url: '/v1/acompanhamentos',
          headers: h,
          payload: { numero },
        });
        if (r.statusCode >= 300) throw new Error(`acompanhar: ${r.statusCode} ${r.body}`);
      }
      await servidor.listen({ host: '127.0.0.1', port: 0 });
      const addr = servidor.server.address();
      url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    });
    afterAll(async () => {
      await browser?.close();
      await servidor?.close();
    });
    afterEach(async () => {
      await ctx?.close();
    });

    async function abrir(numero: string, largura = 1280, escuro = false): Promise<void> {
      ctx = await browser.newContext({
        viewport: { width: largura, height: 900 },
        colorScheme: escuro ? 'dark' : 'light',
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
      page.on('pageerror', (e) => {
        throw e;
      });
      await page.goto(url + '/');
      await esperarConsolePronto(page);
      await page.evaluate((n) => (window as unknown as ConsolePv).__pv!.abrir(n), numero);
      await page.waitForSelector('#partes-cartao');
    }

    it('com o tribunal, mostra as partes dos AUTOS — inclusive o executado — e diz a origem', async () => {
      await abrir(NO_TJGO);
      await page.waitForSelector('#partes-cartao:has-text("Conforme os autos")');
      const texto = await page.locator('#partes-cartao').innerText();
      expect(texto).toContain('BANCO SINTETICO S.A');
      expect(texto).toContain('EXECUTADO SINTETICO');
      expect(texto).toContain('PASSIVO');
      expect(texto).toContain('OAB 99999/GO');
      expect(texto).not.toContain('Pelas publicações do Diário');
      expect(await page.locator('#partes-cartao .parte').count()).toBe(3);
    });

    it('sem o tribunal, mostra as do Diário e avisa que a lista pode estar incompleta', async () => {
      await abrir(NO_TJSP);
      // Espera a consulta de peças terminar (falha: TJSP não tem fonte de peças) e confere que nada mudou.
      await page.waitForSelector('#pecas-resumo .cartao');
      const texto = await page.locator('#partes-cartao').innerText();
      expect(texto).toContain('Pelas publicações do Diário');
      expect(texto).toContain('pode estar incompleta');
      expect(texto).toContain('ADVOGADA SINTETICA');
      expect(texto).not.toContain('Conforme os autos');
    });

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${largura}px`, async () => {
        await abrir(NO_TJGO, largura);
        await page.waitForSelector('#partes-cartao:has-text("Conforme os autos")');
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        }));
        expect(m.sw).toBeLessThanOrEqual(m.cw);
      });
    }

    for (const escuro of [false, true]) {
      it(`axe sem violações no cartão (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        for (const numero of [NO_TJGO, NO_TJSP]) {
          await abrir(numero, 1280, escuro);
          if (numero === NO_TJGO)
            await page.waitForSelector('#partes-cartao:has-text("Conforme os autos")');
          await page.addScriptTag({
            content: (AxeBuilder as unknown as { source: string }).source,
          });
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(
              { include: [['#partes-cartao']] } as unknown as Element,
              { rules: { 'color-contrast': { enabled: true } } },
            ),
          );
          expect(
            r.violations.map(
              (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
            ),
          ).toEqual([]);
          await ctx.close();
        }
      });
    }
  },
);
