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
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { AnalisadorFalso, NOME_DA_PARTE, respostaValida } from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A, ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import {
  AGORA_DO_RESUMO,
  ATOS_DO_RESUMO,
  INTIMACAO,
  ResumidorFalso,
} from '../helpers/resumoIa.js';
import { CHROMIUM } from './ambiente.js';

/*
 * A tela "IA" do /admin NUM NAVEGADOR (v0.58.0): o servidor, o /admin e o painel são os reais;
 * analisador e resumidor são dublês e todos os dados são SINTÉTICOS. Mede teclado, foco, confirmação,
 * temas claro e escuro, axe, seis larguras sem rolagem horizontal, o aviso de custo em qualquer aba e
 * que o resto do /admin continua funcionando.
 */
const sem = CHROMIUM === undefined;
const CHAVE = 'chave-do-teste-do-admin-1234567890';
const WS = workspaceDaChave(CHAVE);
const ADMIN_USUARIO = 'joao';
const ADMIN_SENHA = 'uma-senha-administrativa-bem-forte';
const DIGITOS = NUMERO_TJSP_A.replace(/\D/g, '');
const LARGURAS = [1920, 1366, 1280, 1024, 768, 390];

/** O Playwright não traz `expect` aqui: espera-se por sondagem, com o `expect` do Vitest. */
const esperar = (f: () => Promise<void>): Promise<void> =>
  vi.waitFor(f, { timeout: 8000, interval: 50 });
const textoIgual = (l: Locator, t: string): Promise<void> =>
  esperar(async () => expect(((await l.textContent()) ?? '').trim()).toBe(t));
const textoContem = (l: Locator, t: string): Promise<void> =>
  esperar(async () => expect(await l.innerText()).toContain(t));
const valorIgual = (l: Locator, v: string): Promise<void> =>
  esperar(async () => expect(await l.inputValue()).toBe(v));

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

describe.skipIf(sem)('tela "IA" do /admin, no navegador', { timeout: 120_000 }, () => {
  let browser: Browser;
  let servidor: FastifyInstance;
  let app: Aplicacao;
  let analisador: AnalisadorFalso;
  let url: string;
  let ctx: BrowserContext;
  let page: Page;
  let posts: string[];

  async function subir(): Promise<void> {
    analisador = new AnalisadorFalso();
    app = aplicacaoDeTeste(
      [
        new ProviderFalso({
          nome: 'falso',
          porNumero: async () =>
            umProcesso({
              partes: [
                {
                  nome: NOME_DA_PARTE,
                  polo: 'ATIVO',
                  tipoPessoa: 'FISICA',
                  advogados: [],
                },
              ],
              movimentacoes: ATOS_DO_RESUMO,
            }),
        }),
      ],
      {
        agora: () => AGORA_DO_RESUMO,
        analiseIa: { analisador },
        resumoIa: { resumidor: new ResumidorFalso() },
        admin: { usuario: ADMIN_USUARIO, senha: ADMIN_SENHA },
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
    await app.acompanhamento.acompanhar(WS, NUMERO_TJSP_A);
    await app.acompanhamento.sincronizar({ workspace: WS });
    await app.assinaturas.liberar({ workspace: WS, plano: 'ia', meses: 1 });
    await servidor.listen({ host: '127.0.0.1', port: 0 });
    const addr = servidor.server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }

  /** Dados sintéticos para a tela ter o que mostrar: 3 análises (uma com polegar para baixo e motivo). */
  async function semear(custo = 0.0004): Promise<void> {
    analisador.resposta = async () => ({
      resposta: respostaValida(),
      modelo: 'modelo/teste',
      provedor: 'prov',
      custoUsd: custo,
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await servidor.inject({
        method: 'POST',
        url: `/v1/acompanhamentos/${DIGITOS}/analise`,
        headers: { 'x-api-key': CHAVE },
        payload: { chaveDoAto: chaveDaMovimentacao(INTIMACAO) },
      });
      ids.push(r.json().id as string);
    }
    await servidor.inject({
      method: 'POST',
      url: `/v1/analises/${ids[0]}/avaliacao`,
      headers: { 'x-api-key': CHAVE },
      payload: { avaliacao: 'errado', motivo: 'erro_de_fato' },
    });
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
  beforeEach(async () => {
    await subir();
  });
  afterEach(async () => {
    await ctx?.close();
    await servidor.close();
  });

  async function abrir(
    opcoes: { largura?: number; escuro?: boolean; hash?: string } = {},
  ): Promise<void> {
    posts = [];
    ctx = await browser.newContext({
      viewport: { width: opcoes.largura ?? 1280, height: 900 },
      colorScheme: opcoes.escuro ? 'dark' : 'light',
      httpCredentials: { username: ADMIN_USUARIO, password: ADMIN_SENHA },
    });
    page = await ctx.newPage();
    page.on('request', (r) => {
      if (r.method() !== 'GET') posts.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await page.goto(`${url}/admin${opcoes.hash ?? ''}`);
  }
  const abrirIa = async (): Promise<void> => {
    await page.getByRole('button', { name: 'IA', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'IA' }).waitFor();
    await page.locator('[data-funcao="ato"]').waitFor();
  };
  const cartao = (f: string) => page.locator(`[data-funcao="${f}"]`);
  const live = () => page.locator('#ia-live');
  const painelDoServidor = async (f: string) =>
    (
      await servidor.inject({
        url: '/admin/api/ia',
        headers: {
          authorization:
            'Basic ' + Buffer.from(`${ADMIN_USUARIO}:${ADMIN_SENHA}`).toString('base64'),
        },
      })
    )
      .json()
      .funcoes.find((x: { funcao: string }) => x.funcao === f);

  it('abre pela aba "IA", leva o foco ao título e mostra os números de hoje por função, sem texto de ato', async () => {
    await semear();
    await abrir();
    await abrirIa();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('ia-titulo');
    await cartao('ato').getByText('Análise de ato').waitFor({ state: 'visible' });
    await cartao('resumo').getByText('Resumo do processo').waitFor({ state: 'visible' });
    await cartao('peca').getByText('Análise de peça').waitFor({ state: 'visible' });
    const ato = await cartao('ato').innerText();
    expect(ato).toMatch(/Análises\s*3/);
    expect(ato).toMatch(/Polegar para baixo\s*1 de 1 avaliadas/);
    expect(ato).toContain('erro de fato 1');
    expect(ato).toMatch(/Custo total\s*US\$ 0,0012/);
    expect(ato).toMatch(/Custo médio por análise\s*US\$ 0,0004/);
    expect(ato).toContain('Ligada');
    expect(await cartao('peca').innerText()).toContain(
      'Desligada pelo ambiente do servidor',
    );
    // Ambiente desligou a peça: o botão de ligar existe, mas não pode ser usado.
    expect(await cartao('peca').getByRole('button', { name: 'Ligar' }).isDisabled()).toBe(
      true,
    );
    const corpo = await page.locator('#conteudo').innerText();
    for (const proibido of [NOME_DA_PARTE, 'laudo pericial', NUMERO_TJSP_A, DIGITOS]) {
      expect(corpo).not.toContain(proibido);
    }
    expect(corpo).toContain(WS.slice(0, 8));
    expect(corpo).not.toContain(WS);
  });

  it('o período muda os números: "Hoje", "7 dias" e "30 dias" (aria-pressed)', async () => {
    await semear();
    await abrir();
    await abrirIa();
    const sete = page.getByRole('button', { name: '7 dias' });
    await sete.click();
    expect(await sete.getAttribute('aria-pressed')).toBe('true');
    expect(
      await page.getByRole('button', { name: 'Hoje' }).getAttribute('aria-pressed'),
    ).toBe('false');
    await cartao('ato').locator('.ia-dl').waitFor({ state: 'visible' });
    expect(await cartao('ato').innerText()).toMatch(/Análises\s*3/);
  });

  it('desligar pela tela: confirmação na tela, teclado, foco, aviso discreto; outra conta vê a função indisponível; ligar restaura', async () => {
    await abrir();
    await abrirIa();
    const desligar = cartao('ato').getByRole('button', { name: 'Desligar' });
    await desligar.focus();
    await page.keyboard.press('Enter');
    const grupo = cartao('ato').getByRole('group');
    await textoContem(grupo, 'Desligar "Análise de ato"?');
    // O foco vai ao botão de confirmar; nada foi enviado ainda.
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
      'Sim, desligar',
    );
    expect(posts).toEqual([]);
    // Cancelar devolve o foco ao botão de antes e não envia nada.
    await cartao('ato').getByRole('button', { name: 'Cancelar' }).click();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      'ia-f-ato-alternar',
    );
    expect(posts).toEqual([]);
    expect((await painelDoServidor('ato')).painelLigado).toBe(true);

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // sobre "Sim, desligar"
    await cartao('ato').getByText('Desligada no painel').waitFor({ state: 'visible' });
    await textoIgual(live(), 'Alteração salva.');
    expect(posts).toContain('PUT /admin/api/ia/funcoes/ato');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      'ia-f-ato-alternar',
    );
    expect((await painelDoServidor('ato')).painelLigado).toBe(false);

    // Em OUTRA conta (chave de API), o botão da análise some: a disponibilidade já diz isso.
    const outra = await servidor.inject({
      url: '/v1/analises/disponibilidade',
      headers: { 'x-api-key': CHAVE },
    });
    expect(outra.json()).toMatchObject({
      habilitada: true,
      funcoes: { ato: false, resumo: true },
    });

    await cartao('ato').getByRole('button', { name: 'Ligar' }).click();
    await cartao('ato')
      .getByText('Ligada', { exact: true })
      .waitFor({ state: 'visible' });
    expect((await painelDoServidor('ato')).painelLigado).toBe(true);

    // O histórico mostra as duas mudanças, da mais recente para a mais antiga, sem nome de operador.
    const historico = await page.locator('.ia-historico').innerText();
    expect(historico.indexOf('desligada → ligada')).toBeGreaterThan(-1);
    expect(historico.indexOf('ligada → desligada')).toBeGreaterThan(
      historico.indexOf('desligada → ligada'),
    );
    expect(historico).not.toContain(ADMIN_USUARIO);
  });

  it('o teto por função: valor inválido não envia nada e avisa; valor válido grava e mostra o efetivo', async () => {
    await abrir();
    await abrirIa();
    const campo = page.locator('#ia-f-ato-teto');
    await campo.fill('0');
    await cartao('ato').getByRole('button', { name: 'Salvar teto' }).click();
    await textoIgual(live(), 'Informe um número inteiro de 1 a 100.000.');
    expect(posts).toEqual([]);
    await campo.fill('40');
    await cartao('ato').getByRole('button', { name: 'Salvar teto' }).click();
    await textoIgual(live(), 'Alteração salva.');
    await valorIgual(page.locator('#ia-f-ato-teto'), '40');
    expect((await painelDoServidor('ato')).tetoDoPainel).toBe(40);
    expect(await cartao('ato').innerText()).toMatch(/Teto efetivo agora:\s*40/);
  });

  it('limite do alerta e teto global: valida, grava e mostra', async () => {
    await abrir();
    await abrirIa();
    await page.locator('#ia-alerta').fill('0');
    await page.getByRole('button', { name: 'Salvar limite' }).click();
    await textoIgual(live(), 'Informe um valor em dólares entre 0,01 e 10.000.');
    await page.locator('#ia-alerta').fill('5,5');
    await page.getByRole('button', { name: 'Salvar limite' }).click();
    await textoIgual(live(), 'Alteração salva.');
    await valorIgual(page.locator('#ia-alerta'), '5.50');
    await page.locator('#ia-global').fill('300');
    await page.getByRole('button', { name: 'Salvar teto global' }).click();
    await textoIgual(live(), 'Alteração salva.');
    await valorIgual(page.locator('#ia-global'), '300');
  });

  it('o aviso de custo aparece em QUALQUER aba do /admin e leva ao painel; some ao subir o limite', async () => {
    await semear(4);
    await abrir();
    const aviso = page.locator('#aviso-ia');
    await aviso.waitFor({ state: 'visible' });
    await textoContem(aviso, 'Custo da IA acima do limite de hoje.');
    await textoContem(aviso, 'US$ 12,00');
    await textoContem(aviso, 'US$ 3,00');
    expect(await page.getByRole('heading', { level: 1, name: 'IA' }).count()).toBe(0);
    await aviso.getByRole('link', { name: 'Ver o painel de IA' }).click();
    await page.getByRole('heading', { level: 1, name: 'IA' }).waitFor();
    await page.locator('#ia-alerta').fill('20');
    await page.getByRole('button', { name: 'Salvar limite' }).click();
    await textoIgual(live(), 'Alteração salva.');
    await aviso.waitFor({ state: 'hidden' });
  });

  it('o link do e-mail (/admin#ia) abre direto a tela "IA"', async () => {
    await abrir({ hash: '#ia' });
    await page.getByRole('heading', { level: 1, name: 'IA' }).waitFor();
    expect(
      await page.getByRole('button', { name: 'IA', exact: true }).getAttribute('class'),
    ).toMatch(/ativo/);
  });

  it('o resto do /admin continua funcionando: Assinaturas, Planos e Chaves de API', async () => {
    await abrir();
    expect(
      await page.getByRole('button', { name: 'Assinaturas' }).getAttribute('class'),
    ).toMatch(/ativo/);
    await page
      .locator('#conteudo')
      .getByText(/assinatura/i)
      .first()
      .waitFor();
    await page.getByRole('button', { name: 'Planos' }).click();
    expect(
      await page.getByRole('button', { name: 'Planos' }).getAttribute('class'),
    ).toMatch(/ativo/);
    await page.locator('#conteudo').getByText(/plano/i).first().waitFor();
    await page.getByRole('button', { name: 'Chaves de API' }).click();
    await page.locator('#conteudo').getByText(/chave/i).first().waitFor();
    expect(await page.locator('#conteudo .cartao[style*="--erro"]').count()).toBe(0);
  });

  for (const escuro of [false, true]) {
    it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): tela, confirmação aberta e aviso de custo`, async () => {
      await semear(4);
      await abrir({ escuro });
      await abrirIa();
      await page.addScriptTag({
        content: (AxeBuilder as unknown as { source: string }).source,
      });
      const rodar = async (): Promise<string> => {
        const r = await page.evaluate(() =>
          // Só a área do painel: o contraste do rodapé da lateral do /admin (tema escuro) é anterior a esta tela.
          (window as unknown as AxeNaPagina).axe.run(
            { include: [['#aviso-ia'], ['#conteudo']] } as unknown as Element,
            { rules: { 'color-contrast': { enabled: true } } },
          ),
        );
        return r.violations
          .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
          .join('\n');
      };
      expect(await rodar(), 'tela').toBe('');
      await cartao('ato').getByRole('button', { name: 'Desligar' }).click();
      expect(await rodar(), 'confirmação').toBe('');
    });
  }

  for (const largura of LARGURAS) {
    it(`${largura}px: sem rolagem horizontal na tela "IA" (com e sem confirmação aberta)`, async () => {
      await semear(4);
      await abrir({ largura });
      await abrirIa();
      const medir = (): Promise<{ doc: number; janela: number }> =>
        page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          janela: window.innerWidth,
        }));
      let m = await medir();
      expect(m.doc, 'tela').toBeLessThanOrEqual(m.janela);
      await cartao('resumo').getByRole('button', { name: 'Desligar' }).click();
      m = await medir();
      expect(m.doc, 'confirmação').toBeLessThanOrEqual(m.janela);
      // Nenhum cartão passa da largura da janela.
      const estourou = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ia-cartao')).some(
          (e) => e.getBoundingClientRect().right > window.innerWidth + 1,
        ),
      );
      expect(estourou).toBe(false);
    });
  }
});
