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
import { ProviderFalso } from '../helpers/fabricas.js';
import { CHROMIUM } from './ambiente.js';

/*
 * O /admin com administradores restritos NUM NAVEGADOR (v0.62.0): a tela "Administradores" do dono, o /admin como o
 * restrito o vê (só as abas liberadas, sem nenhum sinal das outras), a tela "nenhuma área liberada", a coluna "Por",
 * os temas claro e escuro, axe e as seis larguras sem rolagem horizontal. Usuários e senhas FICTÍCIOS.
 */
const sem = CHROMIUM === undefined;
const DONO = { usuario: 'joao', senha: 'uma-senha-administrativa-bem-forte' };
const ANA = { usuario: 'ana', senha: 'senha-ficticia-da-ana-0123456789' };
const BETO = { usuario: 'beto', senha: 'senha-ficticia-do-beto-9876543210' };
const LARGURAS = [1920, 1366, 1280, 1024, 768, 390];

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

const basic = (u: string, s: string): string =>
  'Basic ' + Buffer.from(`${u}:${s}`).toString('base64');

describe.skipIf(sem)(
  '/admin com administradores restritos, no navegador',
  { timeout: 120_000 },
  () => {
    let browser: Browser;
    let servidor: FastifyInstance;
    let app: Aplicacao;
    let url: string;
    let ctx: BrowserContext;
    let page: Page;
    let requisicoes: string[];

    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath: CHROMIUM as string,
        args: ['--no-sandbox'],
      });
    });
    afterAll(async () => {
      await browser?.close();
    });
    beforeEach(async () => {
      app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
        admin: { ...DONO, restritos: [ANA, BETO] },
      });
      servidor = construirServidor(
        app,
        carregarConfig({
          PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
          LOG_LEVEL: 'silent',
          CACHE_ENABLED: 'false',
          PROCESSOVIVO_API_KEYS: 'chave-de-teste-1234567890',
          RATE_LIMIT_MAX: '100000',
        } as NodeJS.ProcessEnv),
      );
      await servidor.listen({ host: '127.0.0.1', port: 0 });
      const addr = servidor.server.address();
      url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    });
    afterEach(async () => {
      await ctx?.close();
      await servidor.close();
    });

    async function liberar(usuario: string, abas: string[]): Promise<void> {
      const r = await servidor.inject({
        method: 'PUT',
        url: `/admin/api/administradores/${usuario}/abas`,
        headers: { authorization: basic(DONO.usuario, DONO.senha) },
        payload: { abas, confirmado: true },
      });
      expect(r.statusCode).toBe(200);
    }

    async function abrir(
      quem: { usuario: string; senha: string },
      opcoes: { largura?: number; escuro?: boolean } = {},
    ): Promise<void> {
      requisicoes = [];
      ctx = await browser.newContext({
        viewport: { width: opcoes.largura ?? 1280, height: 900 },
        colorScheme: opcoes.escuro ? 'dark' : 'light',
        httpCredentials: { username: quem.usuario, password: quem.senha },
      });
      page = await ctx.newPage();
      page.on('request', (r) => {
        if (r.url().startsWith(url))
          requisicoes.push(`${r.method()} ${new URL(r.url()).pathname}`);
      });
      await page.goto(`${url}/admin`);
    }

    const abrirAdministradores = async (): Promise<void> => {
      await page.getByRole('button', { name: 'Administradores', exact: true }).click();
      await page.locator('#adm-lista-t').waitFor();
    };
    const cartaoDe = (u: string): Locator => page.locator(`[data-adm-usuario="${u}"]`);
    const live = (): Locator => page.locator('#adm-live');

    async function axe(escopo: string[]): Promise<string> {
      await page.addScriptTag({
        content: (AxeBuilder as unknown as { source: string }).source,
      });
      const r = await page.evaluate(
        (seletores) =>
          (window as unknown as AxeNaPagina).axe.run(
            { include: seletores.map((s) => [s]) } as unknown as Element,
            { rules: { 'color-contrast': { enabled: true } } },
          ),
        escopo,
      );
      return r.violations
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
        .join('\n');
    }

    const medir = (): Promise<{ doc: number; janela: number }> =>
      page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        janela: window.innerWidth,
      }));

    it('dono: a tela lista o dono numa linha fixa e cada restrito com uma caixa por aba, e mostra com que usuário entrou', async () => {
      await abrir(DONO);
      expect(await page.locator('#usuario-admin').innerText()).toContain('joao');
      await abrirAdministradores();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('adm-titulo');
      const corpo = await page.locator('#conteudo').innerText();
      expect(corpo).toContain('Todas as abas');
      expect(corpo).toContain('ana');
      expect(corpo).toContain('beto');
      // O dono não tem caixas; cada restrito tem quatro, todas desmarcadas (começa sem nenhuma aba).
      expect(
        await page
          .locator('section.adm-cartao', { has: page.locator('#adm-dono-t') })
          .locator('input')
          .count(),
      ).toBe(0);
      for (const u of ['ana', 'beto']) {
        expect(await cartaoDe(u).locator('input[type=checkbox]').count()).toBe(4);
        expect(await cartaoDe(u).locator('input:checked').count()).toBe(0);
        expect(await cartaoDe(u).innerText()).toContain('Último acesso: —');
      }
      for (const nome of ['Assinaturas', 'Planos', 'Chaves de API', 'IA']) {
        expect(await cartaoDe('ana').getByLabel(nome, { exact: true }).count()).toBe(1);
      }
      // Nenhuma senha aparece.
      expect(await page.content()).not.toContain(ANA.senha);
    });

    it('salvar pede confirmação (teclado, foco, Esc), grava no histórico com "Por" e avisa discretamente', async () => {
      await abrir(DONO);
      await abrirAdministradores();
      const salvar = cartaoDe('ana').getByRole('button', { name: 'Salvar' });
      expect(await salvar.isDisabled()).toBe(true);
      await cartaoDe('ana').getByLabel('IA', { exact: true }).focus();
      await page.keyboard.press('Space');
      expect(await salvar.isDisabled()).toBe(false);
      await salvar.focus();
      await page.keyboard.press('Enter');
      // Confirmação: foco no botão de confirmar; nada foi enviado ainda.
      await textoContem(cartaoDe('ana'), 'ana passa a usar: IA');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('adm-confirmar');
      expect(requisicoes.filter((r) => r.startsWith('PUT'))).toEqual([]);
      // Esc cancela e devolve o foco ao Salvar.
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        'adm-salvar-ana',
      );
      expect(requisicoes.filter((r) => r.startsWith('PUT'))).toEqual([]);

      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter'); // sobre "Confirmar"
      await esperar(async () =>
        expect(await live().textContent()).toBe('Permissões salvas.'),
      );
      expect(requisicoes).toContain('PUT /admin/api/administradores/ana/abas');
      expect(await cartaoDe('ana').getByLabel('IA', { exact: true }).isChecked()).toBe(
        true,
      );
      const historico = (await page.locator('.adm-historico').textContent()) ?? '';
      expect(historico).toContain('Por');
      const linhaDoHistorico = (
        await page.locator('.adm-historico tbody tr').first().innerText()
      ).split('\t');
      expect(linhaDoHistorico.slice(1)).toEqual(['dono', 'ana', 'IA', 'liberou']);
      // O servidor passou a deixar a ana na aba.
      const r = await servidor.inject({
        method: 'GET',
        url: '/admin/api/ia/alerta',
        headers: { authorization: basic(ANA.usuario, ANA.senha) },
      });
      expect(r.statusCode).toBe(200);
    });

    it('restrito só com a aba IA: cai direto nela, o menu é só o título e nenhum sinal das outras abas aparece', async () => {
      await liberar('ana', ['ia']);
      await abrir(ANA);
      await page.getByRole('heading', { level: 1, name: 'IA' }).waitFor();
      expect(await page.locator('nav.nav button').count()).toBe(0);
      expect(await page.locator('nav.nav').innerText()).toBe('IA');
      expect(await page.locator('#usuario-admin').innerText()).toContain('ana');
      const tudo = (await page.content()) + (await page.locator('body').innerText());
      for (const nome of [
        'Assinaturas',
        'Planos',
        'Chaves de API',
        'Administradores',
        'Mercado Pago',
        'TESTE',
        '/admin/api/assinaturas',
        '/admin/api/planos',
        '/admin/api/chaves',
        '/admin/api/pagamento',
        '/admin/api/administradores',
      ]) {
        expect(tudo, nome).not.toContain(nome);
      }
      // Só as rotas da IA foram chamadas.
      for (const r of requisicoes) {
        if (r.startsWith('GET /admin/api/')) expect(r).toMatch(/^GET \/admin\/api\/ia/);
      }
      // O endereço de outra aba é negado, com a mesma resposta de uma aba que nem existe.
      const negada = await page.evaluate(async () => {
        const a = await fetch('/admin/api/chaves');
        const b = await fetch('/admin/api/inexistente');
        return { a: a.status, b: b.status, ta: await a.text(), tb: await b.text() };
      });
      expect(negada.a).toBe(403);
      expect(negada.b).toBe(403);
      expect(negada.ta).toBe(negada.tb);
    });

    it('a ação do restrito na aba IA aparece na coluna "Por" com o nome dele, e a do dono como "dono"', async () => {
      await liberar('ana', ['ia']);
      await abrir(ANA);
      await page.getByRole('heading', { level: 1, name: 'IA' }).waitFor();
      await page.locator('#ia-alerta').waitFor();
      await page.locator('#ia-alerta').fill('7');
      await page.getByRole('button', { name: 'Salvar limite' }).click();
      await esperar(async () =>
        expect(await page.locator('#ia-live').textContent()).toBe('Alteração salva.'),
      );
      const tabela = page.locator('.ia-historico');
      await textoContem(tabela, 'ana');
      expect((await tabela.locator('thead').textContent()) ?? '').toContain('Por');
      await ctx.close();

      await abrir(DONO);
      await page.getByRole('button', { name: 'IA', exact: true }).click();
      await page.locator('.ia-historico').waitFor();
      expect(await page.locator('.ia-historico').innerText()).toMatch(/ana/);
    });

    it('restrito com duas abas: menu com as duas, na ordem do menu, e abre na primeira', async () => {
      await liberar('beto', ['ia', 'chaves']);
      await abrir(BETO);
      const botoes = await page.locator('nav.nav button').allInnerTexts();
      expect(botoes).toEqual(['Chaves de API', 'IA']);
      await page.getByRole('heading', { name: 'Chaves de API' }).first().waitFor();
      expect(await page.locator('nav.nav button.ativo').innerText()).toBe(
        'Chaves de API',
      );
      await page.getByRole('button', { name: 'IA', exact: true }).click();
      await page.getByRole('heading', { level: 1, name: 'IA' }).waitFor();
    });

    it('restrito sem nenhuma aba: tela curta, sem menu', async () => {
      await abrir(ANA);
      await page.locator('#sem-area').waitFor();
      expect(await page.locator('#sem-area').innerText()).toBe(
        'Nenhuma área liberada para o seu acesso. Fale com o administrador.',
      );
      expect(await page.locator('nav').count()).toBe(0);
      expect(await page.locator('#conteudo').count()).toBe(0);
    });

    it('tirar a única aba pela tela vale na recarga seguinte do restrito', async () => {
      await liberar('ana', ['ia']);
      await abrir(ANA);
      await page.getByRole('heading', { level: 1, name: 'IA' }).waitFor();
      await liberar('ana', []);
      const r = await page.evaluate(async () => (await fetch('/admin/api/ia')).status);
      expect(r).toBe(403);
      await page.reload();
      await page.locator('#sem-area').waitFor();
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): tela Administradores, confirmação aberta, restrito e tela sem área`, async () => {
        await liberar('beto', ['ia']);
        await abrir(DONO, { escuro });
        await abrirAdministradores();
        expect(await axe(['#conteudo']), 'tela').toBe('');
        await cartaoDe('ana').getByLabel('Planos', { exact: true }).check();
        await cartaoDe('ana').getByRole('button', { name: 'Salvar' }).click();
        expect(await axe(['#conteudo']), 'confirmação').toBe('');
        await ctx.close();

        await abrir(BETO, { escuro });
        await page.getByRole('heading', { level: 1, name: 'IA' }).waitFor();
        expect(await axe(['#conteudo']), 'restrito').toBe('');
        await ctx.close();

        await abrir(ANA, { escuro });
        await page.locator('#sem-area').waitFor();
        expect(await axe(['#sem-area']), 'sem área').toBe('');
      });
    }

    for (const largura of LARGURAS) {
      it(`${largura}px: sem rolagem horizontal na tela Administradores, no restrito e na tela sem área`, async () => {
        await liberar('beto', ['ia']);
        await abrir(DONO, { largura });
        await abrirAdministradores();
        await cartaoDe('ana').getByLabel('IA', { exact: true }).check();
        await cartaoDe('ana').getByRole('button', { name: 'Salvar' }).click();
        let m = await medir();
        expect(m.doc, 'administradores').toBeLessThanOrEqual(m.janela);
        const estourou = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.adm-cartao')).some(
            (e) => e.getBoundingClientRect().right > window.innerWidth + 1,
          ),
        );
        expect(estourou).toBe(false);
        await ctx.close();

        await abrir(BETO, { largura });
        await page.getByRole('heading', { level: 1, name: 'IA' }).waitFor();
        m = await medir();
        expect(m.doc, 'restrito').toBeLessThanOrEqual(m.janela);
        await ctx.close();

        await abrir(ANA, { largura });
        await page.locator('#sem-area').waitFor();
        m = await medir();
        expect(m.doc, 'sem área').toBeLessThanOrEqual(m.janela);
      });
    }
  },
);
