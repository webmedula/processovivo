/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import type { FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import {
  ATUAL,
  ExecutorFalso,
  NOVO,
  catalogoDeTeste,
  metricas,
} from '../helpers/modelosDeIa.js';
import { CHROMIUM } from './ambiente.js';

/*
 * A parte "Modelo de IA" da tela "IA" do /admin NUM NAVEGADOR (Fase B, v0.60.0): o servidor, o /admin e os
 * serviços são os reais; o executor do teste é um dublê (nenhuma rede) e a lista de modelos é sintética.
 * Mede o fluxo inteiro (escolher, estimar, testar com progresso, publicar, reverter), a aprovação de ressalvas,
 * o bloqueio, teclado, foco, temas claro e escuro (axe) e as seis larguras sem rolagem horizontal.
 */
const sem = CHROMIUM === undefined;
const CHAVE = 'chave-do-teste-do-admin-modelos-1234567890';
const ADMIN_USUARIO = 'joao';
const ADMIN_SENHA = 'uma-senha-administrativa-bem-forte';
const LARGURAS = [1920, 1366, 1280, 1024, 768, 390];
const AGORA = new Date('2026-10-26T12:00:00.000Z');

const esperar = (f: () => Promise<void>): Promise<void> =>
  vi.waitFor(f, { timeout: 8000, interval: 50 });
const textoContem = (l: Locator, t: string): Promise<void> =>
  esperar(async () => expect(await l.innerText()).toContain(t));

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

describe.skipIf(sem)(
  'modelo de IA na tela "IA" do /admin, no navegador',
  { timeout: 120_000 },
  () => {
    let browser: Browser;
    let servidor: FastifyInstance;
    let app: Aplicacao;
    let executor: ExecutorFalso;
    let url: string;
    let ctx: BrowserContext;
    let page: Page;

    async function subir(): Promise<void> {
      executor = new ExecutorFalso();
      let n = 0;
      app = aplicacaoDeTeste(
        [new ProviderFalso({ nome: 'falso', porNumero: async () => umProcesso() })],
        {
          agora: () => AGORA,
          admin: { usuario: ADMIN_USUARIO, senha: ADMIN_SENHA },
          modelosDeIa: {
            catalogo: catalogoDeTeste(),
            doAmbiente: { ato: ATUAL, resumo: ATUAL, peca: ATUAL },
            executor,
            novoId: () => `teste-${++n}`,
          },
        },
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
      await servidor.listen({ host: '127.0.0.1', port: 0 });
      const addr = servidor.server.address();
      url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    }

    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath: CHROMIUM as string,
        args: ['--no-sandbox'],
      });
    });
    afterAll(async () => {
      await browser?.close();
    });
    beforeEach(subir);
    afterEach(async () => {
      await ctx?.close();
      await servidor.close();
    });

    async function abrir(
      opcoes: { largura?: number; escuro?: boolean } = {},
    ): Promise<void> {
      ctx = await browser.newContext({
        viewport: { width: opcoes.largura ?? 1280, height: 900 },
        colorScheme: opcoes.escuro ? 'dark' : 'light',
        httpCredentials: { username: ADMIN_USUARIO, password: ADMIN_SENHA },
      });
      page = await ctx.newPage();
      await page.goto(`${url}/admin`);
      await page.getByRole('button', { name: 'IA', exact: true }).click();
      await page.getByRole('heading', { level: 1, name: 'IA' }).waitFor();
      await page.locator('[data-funcao="ato"] .ia-mod').waitFor();
    }
    const ato = (): Locator => page.locator('[data-funcao="ato"]');
    const foco = (): Promise<string | undefined> =>
      page.evaluate(() => document.activeElement?.id);

    /** Escolhe o NOVO no seletor da função, estima e inicia o teste. */
    async function testarPelaTela(f = 'ato'): Promise<void> {
      await page.locator(`#ia-m-${f}-sel`).selectOption(NOVO);
      await page.locator(`#ia-m-${f}-testar`).click();
      await page.locator(`#ia-m-${f}-iniciar`).waitFor();
      await page.locator(`#ia-m-${f}-iniciar`).click();
    }

    it('mostra, por função, o modelo em uso e de onde vem, o seletor da lista com preço, janela e ZDR, e o aviso fixo', async () => {
      await abrir();
      const t = await ato().innerText();
      expect(t).toContain('Modelo em uso: Apelido modelo-atual');
      expect(t).toContain(ATUAL);
      expect(t).toContain('definido pelo ambiente do servidor');
      expect(await page.locator('#ia-m-ato-sel option').allInnerTexts()).toEqual([
        'Escolha um modelo',
        'Apelido modelo-novo',
      ]);
      expect(await page.locator('[data-ia-modelos-nota]').innerText()).toContain(
        'Para incluir um modelo novo na lista é preciso uma alteração de código e revisão da Política de Privacidade.',
      );
      await page.locator('#ia-m-ato-sel').selectOption(NOVO);
      const d = await ato().innerText();
      expect(d).toContain('US$ 0,20 entrada / US$ 0,40 saída por 1 milhão de tokens');
      expect(d).toContain('128.000 tokens');
      expect(d).toContain('2026-10-20');
      // o resumo tem a lista dele (inclui o modelo só-resumo) e a peça a dela
      expect(await page.locator('#ia-m-resumo-sel option').count()).toBe(3);
      await textoContem(
        page.locator('[data-ia-modelos-nota]'),
        'regras desta decisão'.replace('r', 'R'),
      );
      expect(await page.locator('#ia-m-ato-reverter').isDisabled()).toBe(true);
      expect(await ato().innerText()).toContain('Não há modelo anterior para voltar.');
    });

    it('fluxo completo: estimar, testar com progresso, ler o veredito, publicar e reverter', async () => {
      executor.chamadas = 20;
      executor.chamarAntes = 7;
      let soltar!: () => void;
      executor.portao = new Promise<void>((r) => (soltar = r));
      await abrir();
      await page.locator('#ia-m-ato-sel').selectOption(NOVO);
      await page.locator('#ia-m-ato-testar').click();
      // a estimativa vem ANTES de qualquer chamada
      await textoContem(ato(), 'Chamadas ao provedor: 20');
      await textoContem(ato(), 'Custo estimado: US$ 0,0500');
      await textoContem(ato(), 'teto da rodada: US$ 1,00');
      expect(executor.execucoes).toHaveLength(0);
      await page.locator('#ia-m-ato-iniciar').click();
      await textoContem(ato(), '7 de 20 chamadas');
      expect(
        await page.locator('[role="progressbar"]').getAttribute('aria-valuenow'),
      ).toBe('7');
      expect(await page.locator('#ia-m-ato-testar').isDisabled()).toBe(true);
      soltar();
      await textoContem(ato(), 'Veredito: Aprovado');
      const tabela = await ato().locator('.ia-m-tabela').innerText();
      expect(tabela).toContain('Citação verificada');
      expect(tabela).toContain('Tempo de resposta p95');
      expect(tabela).toContain('Custo médio por chamada');

      // publicar: um clique + confirmação
      await page.locator('#ia-m-ato-publicar').click();
      expect(await foco()).toBe('ia-m-ato-pub-ok');
      await page.locator('#ia-m-ato-pub-ok').click();
      await textoContem(ato(), 'Modelo em uso: Apelido modelo-novo');
      await textoContem(ato(), 'definido no painel');
      expect(await foco()).toBe('ia-m-ato-reverter');
      await textoContem(page.locator('#ia-live'), 'Modelo publicado.');
      const painel = (
        await servidor.inject({
          url: '/admin/api/ia/modelos',
          headers: {
            authorization:
              'Basic ' +
              Buffer.from(`${ADMIN_USUARIO}:${ADMIN_SENHA}`).toString('base64'),
          },
        })
      ).json();
      expect(painel.funcoes[0].efetivo.modelo).toBe(NOVO);
      // o histórico da Fase A mostra a troca
      await textoContem(page.locator('.ia-historico'), 'Modelo publicado');

      // reverter, um clique + confirmação
      await page.locator('#ia-m-ato-reverter').click();
      await page.locator('#ia-m-ato-rev-ok').click();
      await textoContem(ato(), 'Modelo em uso: Apelido modelo-atual');
      await textoContem(ato(), 'definido pelo ambiente do servidor');
      await textoContem(page.locator('.ia-historico'), 'Modelo revertido');
    });

    it('só um teste por vez, com cancelar', async () => {
      let soltar!: () => void;
      executor.portao = new Promise<void>((r) => (soltar = r));
      await abrir();
      await testarPelaTela('ato');
      await textoContem(ato(), 'Em andamento');
      // outra função: o botão de testar fica desabilitado, com a razão
      await page.locator('#ia-m-resumo-sel').selectOption(NOVO);
      expect(await page.locator('#ia-m-resumo-testar').isDisabled()).toBe(true);
      await textoContem(
        page.locator('[data-funcao="resumo"]'),
        'Só um teste roda por vez',
      );
      // O servidor precisa receber o cancelamento ANTES de o executor dublê terminar.
      const resposta = page.waitForResponse((r) => r.url().includes('/cancelar'));
      await page.locator('#ia-m-ato-cancelar').click();
      await resposta;
      soltar();
      await textoContem(ato(), 'Cancelado');
      await esperar(async () =>
        expect(await page.locator('#ia-m-resumo-testar').isDisabled()).toBe(false),
      );
    });

    it('teste com ressalva: o botão só habilita com a palavra digitada e o motivo, e a aprovação vai ao registro', async () => {
      executor.resultado = {
        tipo: 'ok',
        candidato: metricas({ modelo: NOVO, custoMedioUsd: 0.004, pontosCobertos: 88 }),
        referencia: metricas(),
        gastoUsd: 0.05,
        tetoAtingido: false,
      };
      await abrir();
      await testarPelaTela();
      await textoContem(ato(), 'Veredito: Aprovado com ressalvas');
      await textoContem(ato(), 'O custo médio por chamada ficou maior');
      await textoContem(ato(), 'impacto estimado de');
      await page.locator('#ia-m-ato-publicar').click();
      const ok = page.locator('#ia-m-ato-pub-ok');
      expect(await ok.isDisabled()).toBe(true);
      await page.locator('#ia-m-ato-palavra').fill('publicar');
      await page.locator('#ia-m-ato-motivo').selectOption('custo_aceitavel');
      expect(await ok.isDisabled()).toBe(true);
      await page.locator('#ia-m-ato-palavra').fill('PUBLICAR');
      expect(await ok.isDisabled()).toBe(false);
      await page.locator('#ia-m-ato-obs').fill('Vale pela qualidade');
      await ok.click();
      await textoContem(ato(), 'Modelo em uso: Apelido modelo-novo');
      await textoContem(
        page.locator('.ia-historico'),
        'aprovação: custo_aceitavel: Vale pela qualidade',
      );
    });

    it('teste bloqueado: publicar fica desabilitado, com o porquê em português', async () => {
      executor.resultado = {
        tipo: 'ok',
        candidato: metricas({ modelo: NOVO, violacoes: 2, citacaoVerificada: 0.9 }),
        referencia: metricas(),
        gastoUsd: 0.05,
        tetoAtingido: false,
      };
      await abrir();
      await testarPelaTela();
      await textoContem(ato(), 'Veredito: Bloqueado');
      await textoContem(ato(), 'mais violações');
      await textoContem(ato(), 'abaixo de 95%');
      expect(await page.locator('#ia-m-ato-publicar').isDisabled()).toBe(true);
      await textoContem(
        ato(),
        'O teste foi bloqueado. Este modelo não pode ser publicado.',
      );
    });

    it('teste que passa do teto de gasto: falha com a explicação e sem veredito', async () => {
      executor.resultado = {
        tipo: 'ok',
        candidato: metricas({ modelo: NOVO }),
        referencia: metricas(),
        gastoUsd: 1.01,
        tetoAtingido: true,
      };
      await abrir();
      await testarPelaTela();
      await textoContem(ato(), 'Falhou');
      await textoContem(ato(), 'passou do teto de gasto da rodada');
      expect(await ato().locator('.ia-m-veredito').count()).toBe(0);
      expect(await page.locator('#ia-m-ato-publicar').count()).toBe(0);
    });

    it('estimativa acima do teto: o botão de iniciar fica desabilitado', async () => {
      executor.custoEstimadoUsd = 2.5;
      await abrir();
      await page.locator('#ia-m-ato-sel').selectOption(NOVO);
      await page.locator('#ia-m-ato-testar').click();
      await textoContem(ato(), 'A estimativa passa do teto da rodada');
      expect(await page.locator('#ia-m-ato-iniciar').isDisabled()).toBe(true);
      expect(executor.execucoes).toHaveLength(0);
    });

    it('só pelo teclado: escolher, estimar, testar, publicar, e Esc/Cancelar devolvem o foco ao gatilho', async () => {
      await abrir();
      const sel = page.locator('#ia-m-ato-sel');
      await sel.focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Tab');
      expect(await foco()).toBe('ia-m-ato-testar');
      await page.keyboard.press('Enter');
      await page.locator('#ia-m-ato-iniciar').waitFor();
      await page.getByRole('button', { name: 'Cancelar' }).first().focus();
      await page.keyboard.press('Enter');
      expect(await foco()).toBe('ia-m-ato-testar');
      await page.keyboard.press('Enter');
      await page.locator('#ia-m-ato-iniciar').focus();
      await page.keyboard.press('Enter');
      await textoContem(ato(), 'Veredito: Aprovado');
      await page.locator('#ia-m-ato-publicar').focus();
      await page.keyboard.press('Enter');
      expect(await foco()).toBe('ia-m-ato-pub-ok');
      await page.keyboard.press('Enter');
      await textoContem(ato(), 'Modelo em uso: Apelido modelo-novo');
    });

    it('regressão: o resto da tela "IA" (liga/desliga, tetos, histórico) segue funcionando com o modelo publicado', async () => {
      await abrir();
      await testarPelaTela();
      await textoContem(ato(), 'Veredito: Aprovado');
      await page.locator('#ia-m-ato-publicar').click();
      await page.locator('#ia-m-ato-pub-ok').click();
      await textoContem(ato(), 'Modelo em uso: Apelido modelo-novo');
      await page.locator('#ia-f-ato-teto').fill('9');
      await ato().getByRole('button', { name: 'Salvar teto' }).click();
      await textoContem(ato(), 'Teto efetivo agora: 9');
      // a tela redesenhada continua mostrando o modelo publicado
      await textoContem(ato(), 'Modelo em uso: Apelido modelo-novo');
      await page.getByRole('button', { name: 'Assinaturas' }).click();
      await page.getByRole('button', { name: 'IA', exact: true }).click();
      await textoContem(
        page.locator('[data-funcao="ato"]'),
        'Modelo em uso: Apelido modelo-novo',
      );
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): seletor, estimativa, resultado e confirmações`, async () => {
        executor.resultado = {
          tipo: 'ok',
          candidato: metricas({ modelo: NOVO, custoMedioUsd: 0.004 }),
          referencia: metricas(),
          gastoUsd: 0.05,
          tetoAtingido: false,
        };
        await abrir({ escuro });
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const rodar = async (): Promise<string> => {
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(
              { include: [['#conteudo']] } as unknown as Element,
              { rules: { 'color-contrast': { enabled: true } } },
            ),
          );
          return r.violations
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
            .join('\n');
        };
        expect(await rodar(), 'inicial').toBe('');
        await page.locator('#ia-m-ato-sel').selectOption(NOVO);
        await page.locator('#ia-m-ato-testar').click();
        await page.locator('#ia-m-ato-iniciar').waitFor();
        expect(await rodar(), 'estimativa').toBe('');
        await page.locator('#ia-m-ato-iniciar').click();
        await textoContem(ato(), 'Veredito: Aprovado com ressalvas');
        expect(await rodar(), 'resultado').toBe('');
        await page.locator('#ia-m-ato-publicar').click();
        expect(await rodar(), 'confirmação de ressalva').toBe('');
        await page.getByRole('button', { name: 'Cancelar' }).first().click();
        await page.locator('#ia-m-resumo-sel').selectOption(NOVO);
        expect(await rodar(), 'outra função').toBe('');
      });
    }

    for (const largura of LARGURAS) {
      it(`${largura}px: sem rolagem horizontal com seletor, estimativa, resultado e confirmação abertos`, async () => {
        executor.resultado = {
          tipo: 'ok',
          candidato: metricas({ modelo: NOVO, custoMedioUsd: 0.004 }),
          referencia: metricas(),
          gastoUsd: 0.05,
          tetoAtingido: false,
        };
        await abrir({ largura });
        const medir = async (etapa: string): Promise<void> => {
          const m = await page.evaluate(() => ({
            doc: document.documentElement.scrollWidth,
            janela: window.innerWidth,
            estourou: Array.from(
              document.querySelectorAll('.ia-cartao, .ia-mod, .ia-m-tabela'),
            ).some((e) => e.getBoundingClientRect().right > window.innerWidth + 1),
          }));
          expect(m.doc, etapa).toBeLessThanOrEqual(m.janela);
          expect(m.estourou, `${etapa} (algum bloco passou da janela)`).toBe(false);
        };
        await medir('inicial');
        await page.locator('#ia-m-ato-sel').selectOption(NOVO);
        await page.locator('#ia-m-ato-testar').click();
        await page.locator('#ia-m-ato-iniciar').waitFor();
        await medir('estimativa');
        await page.locator('#ia-m-ato-iniciar').click();
        await textoContem(ato(), 'Veredito: Aprovado com ressalvas');
        await medir('resultado');
        await page.locator('#ia-m-ato-publicar').click();
        await medir('confirmação');
      });
    }
  },
);
