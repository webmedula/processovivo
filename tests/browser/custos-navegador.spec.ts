/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAVE, CHROMIUM } from './ambiente.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';
import type { FastifyInstance } from 'fastify';
import { esperarConsolePronto } from './console.js';

/*
 * v0.47.0/v0.48.0 NUM NAVEGADOR: o centro de custos na tela do processo (recebimentos, quem pagou, depósitos,
 * cancelar com histórico e catálogo em dois níveis). Servidor e console reais; dados
 * SINTÉTICOS (repositório público). Cada teste usa o próprio processo para não herdar lançamentos.
 */
const sem = CHROMIUM === undefined;
let proximo = 8100;
const novoNumero = (): string => numeroValido(proximo++, '26', '0100');

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}
interface ConsolePv {
  __pv?: { abrir(n: string): unknown };
}

describe.skipIf(sem)('Centro de custos, no navegador', { timeout: 120_000 }, () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let servidor: FastifyInstance | undefined;
  let app: Aplicacao;
  let url = '';
  let numero = '';
  const WS = workspaceDaChave(CHAVE);

  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: CHROMIUM as string,
      args: ['--no-sandbox'],
    });
    app = aplicacaoDeTeste([
      new ProviderFalso({
        nome: 'falso',
        porNumero: async (n) =>
          new Processo({
            numero: NumeroCNJ.criar(n),
            tribunal: 'TJSP',
            classe: 'Procedimento Comum Cível',
            partes: [
              {
                nome: 'Autora Sintética',
                polo: 'ATIVO',
                tipoPessoa: 'FISICA',
                advogados: [],
              },
            ],
            movimentacoes: [
              {
                data: new Date(Date.now() - 86_400_000),
                titulo: 'Ato ordinatório',
                conteudo:
                  'Intime-se a parte autora para manifestar-se no prazo de 5 dias.',
              },
            ],
            procedencia: { provider: 'falso', consultadoEm: new Date(), deCache: false },
          } as ConstructorParameters<typeof Processo>[0]),
      }),
    ]);
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
  });
  afterAll(async () => {
    await browser?.close();
    await servidor?.close();
  });
  afterEach(async () => {
    await ctx?.close();
  });

  async function abrirDetalhe(largura = 1280, escuro = false): Promise<void> {
    numero = novoNumero();
    ctx = await browser.newContext({
      viewport: { width: largura, height: 900 },
      colorScheme: escuro ? 'dark' : 'light',
      acceptDownloads: true,
    });
    await ctx.addInitScript((c) => {
      try {
        localStorage.setItem('processovivo.chave', c);
      } catch {
        /* sem armazenamento: o teste falharia adiante, com a causa à vista */
      }
    }, CHAVE);
    page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (e) => {
      throw e;
    });
    await page.goto(url + '/');
    await esperarConsolePronto(page);
    await page.evaluate((n) => (window as unknown as ConsolePv).__pv!.abrir(n), numero);
    await page.waitForSelector('#cust-abrir');
  }

  async function abrirPainel(): Promise<void> {
    await page.locator('#cust-abrir').click();
    await page.waitForSelector('#cust-painel');
    await page.waitForFunction(
      () => !document.querySelector('#cust-lista')?.textContent?.includes('Carregando'),
    );
  }

  async function lancar(o: {
    descricao: string;
    valor: string;
    categoria?: string;
    cobrar?: boolean;
    cliente?: boolean;
    data?: string;
  }): Promise<void> {
    await page.locator('#cust-novo').click();
    if (o.data) await page.locator('#cust-f-data').fill(o.data);
    await page.locator('#cust-f-desc').fill(o.descricao);
    if (o.categoria)
      await page.locator('#cust-f-cat').selectOption({ label: o.categoria });
    await page.locator('#cust-f-valor').fill(o.valor);
    if (o.cliente) await page.locator('#cust-f-pago-cliente').check();
    if (o.cobrar) await page.locator('#cust-f-reemb').check();
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
  }

  async function receber(o: {
    valor: string;
    data?: string;
    observacao?: string;
  }): Promise<void> {
    await page.locator('#cust-novo-rec').click();
    if (o.data) await page.locator('#cust-f-data').fill(o.data);
    await page.locator('#cust-f-valor').fill(o.valor);
    if (o.observacao) await page.locator('#cust-f-obs').fill(o.observacao);
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
  }

  /*
   * v0.49.1: as ações são ícones com nome acessível fixo ("Editar lançamento"), sem a descrição do lançamento;
   * a linha da tabela é que identifica de qual se fala. Antes os testes achavam o botão por "Editar: <descrição>".
   */
  const acao = (nome: string, texto: string): Locator =>
    page
      .locator('#cust-lista tbody tr')
      .filter({ hasText: texto })
      .getByRole('button', { name: nome });

  const totais = async (): Promise<Record<string, string>> =>
    page.evaluate(() => {
      const r: Record<string, string> = {};
      document.querySelectorAll('#cust-totais .cust-tot').forEach((e) => {
        r[e.querySelector('dt')!.textContent!] = e.querySelector('dd')!.textContent!;
      });
      return r;
    });

  const linhas = async (): Promise<string[]> =>
    page
      .locator('#cust-lista .cust-tab:not(.cust-tab-rec) tbody tr')
      .evaluateAll((trs) =>
        trs.map((t) => (t as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
      );

  const linhasDeRecebimento = async (): Promise<string[]> =>
    page
      .locator('#cust-lista .cust-tab-rec tbody tr')
      .evaluateAll((trs) =>
        trs.map((t) => (t as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
      );

  it('o botão "Custos" tem nome acessível; o painel abre vazio, com os totais novos zerados e a nota de classificação', async () => {
    await abrirDetalhe();
    const b = page.locator('#cust-abrir');
    expect(await b.getAttribute('aria-label')).toBe('Custos do processo');
    expect(await b.getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#cust-raiz').count()).toBe(0);
    await abrirPainel();
    expect(await b.getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#cust-lista').innerText()).toContain(
      'Nenhum custo lançado neste processo. Adicione o primeiro.',
    );
    expect(await page.locator('#cust-lista').innerText()).toContain(
      'Nenhum recebimento registrado.',
    );
    expect(await totais()).toEqual({
      'Total de despesas': 'R$ 0,00',
      'Pago pelo escritório': 'R$ 0,00',
      'Pago diretamente pelo cliente': 'R$ 0,00',
      Reembolsável: 'R$ 0,00',
      'Recebido do cliente': 'R$ 0,00',
      'Saldo a cobrar': 'R$ 0,00',
    });
    // Catálogo é organização, não afirmação de exigibilidade.
    expect(await page.locator('#cust-painel').innerText()).toContain(
      'não afirma que uma cobrança seja exigível no processo',
    );
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cust-painel');
  });

  it('lança custos em duas subcategorias, aceita 1.234,56 e 1234,56 e mostra o valor em reais', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await page.locator('#cust-novo').click();
    await page.locator('#cust-f-desc').fill('Guia de custas iniciais');
    await page.locator('#cust-f-valor').fill('1.234,56');
    expect(await page.locator('#cust-f-previa').innerText()).toBe('= R$ 1.234,56');
    await page.locator('#cust-f-valor').fill('1234,5');
    expect(await page.locator('#cust-f-previa').innerText()).toBe('= R$ 1.234,50');
    await page.locator('#cust-f-valor').fill('12.34');
    expect(await page.locator('#cust-f-previa').innerText()).toContain('Use o formato');
    await page.locator('#cust-f-valor').fill('1234,56');
    await page.locator('#cust-f-reemb').check();
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });

    await lancar({
      descricao: 'Perícia contábil',
      valor: '500',
      categoria: 'Honorários de perito judicial',
    });

    expect(await totais()).toMatchObject({
      'Total de despesas': 'R$ 1.734,56',
      'Pago pelo escritório': 'R$ 1.734,56',
      Reembolsável: 'R$ 1.234,56',
      'Saldo a cobrar': 'R$ 1.234,56',
    });
    const l = (await linhas()).join('|');
    expect(l).toContain(
      'Guia de custas iniciais Custas e taxas judiciais › Outras custas judiciais R$ 1.234,56 Escritório Sim',
    );
    expect(l).toContain(
      'Perícia contábil Perícias e avaliações › Honorários de perito judicial R$ 500,00 Escritório Não',
    );
    expect(await page.locator('.cust-subs').first().innerText()).toContain(
      'Perícias e avaliações › Honorários de perito judicial',
    );
    await page.locator('#cust-novo').click();
    await page.locator('#cust-f-desc').fill('Zero');
    await page.locator('#cust-f-valor').fill('0');
    await page.locator('#cust-f-salvar').click();
    expect(await page.locator('#cust-f-erro').innerText()).toBe(
      'O valor precisa ser maior que zero.',
    );
    await page.locator('#cust-f-valor').fill('1.000.000,01');
    await page.locator('#cust-f-salvar').click();
    expect(await page.locator('#cust-f-erro').innerText()).toContain('O valor máximo');
    await page.locator('#cust-f-valor').fill('abc');
    await page.locator('#cust-f-salvar').click();
    expect(await page.locator('#cust-f-erro').innerText()).toContain(
      'Informe o valor em reais',
    );
    expect((await linhas()).length).toBe(2);
  });

  it('item 2 — pago por: "Cliente" desliga e desabilita "Cobrar do cliente" com a explicação em texto; não gera saldo', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await page.locator('#cust-novo').click();
    await page.locator('#cust-f-desc').fill('Custas pagas pelo cliente');
    await page.locator('#cust-f-valor').fill('80,00');
    await page.locator('#cust-f-reemb').check();
    expect(await page.locator('#cust-f-pago-escritorio').isChecked()).toBe(true);
    await page.locator('#cust-f-pago-cliente').check();
    const caixa = page.locator('#cust-f-reemb');
    expect(await caixa.isChecked()).toBe(false);
    expect(await caixa.isDisabled()).toBe(true);
    expect(await page.locator('#cust-f-reemb-nota').innerText()).toBe(
      'Despesa paga pelo cliente não é cobrada de volta: não gera saldo.',
    );
    expect(await caixa.getAttribute('aria-describedby')).toBe('cust-f-reemb-nota');
    // Voltar para "Escritório" devolve a caixa.
    await page.locator('#cust-f-pago-escritorio').check();
    expect(await caixa.isDisabled()).toBe(false);
    await page.locator('#cust-f-pago-cliente').check();
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
    // "Pago por" é TEXTO na linha, não só cor; "Cobrar do cliente" não se aplica.
    expect((await linhas())[0]).toContain('Cliente');
    expect(await page.locator('#cust-lista td[data-rotulo="Pago por"]').innerText()).toBe(
      'Cliente',
    );
    expect(await totais()).toMatchObject({
      'Total de despesas': 'R$ 80,00',
      'Pago pelo escritório': 'R$ 0,00',
      'Pago diretamente pelo cliente': 'R$ 80,00',
      Reembolsável: 'R$ 0,00',
      'Saldo a cobrar': 'R$ 0,00',
    });
  });

  it('item 3 — depósito (Grupo 08): aviso no seletor, bloco separado, fora do total de despesas; cobrado, entra no saldo', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Despesa comum', valor: '100,00' });
    await page.locator('#cust-novo').click();
    expect(await page.locator('#cust-f-aviso-grupo').innerText()).toBe('');
    await page.locator('#cust-f-cat').selectOption({ label: 'Depósito judicial' });
    expect(await page.locator('#cust-f-aviso-grupo').innerText()).toBe(
      'Depósitos e garantias não entram no total de despesas.',
    );
    await page.locator('#cust-f-desc').fill('Depósito recursal adiantado');
    await page.locator('#cust-f-valor').fill('2.000,00');
    await page.locator('#cust-f-reemb').check();
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });

    const t = await totais();
    expect(t['Total de despesas']).toBe('R$ 100,00');
    expect(t['Total de depósitos e garantias']).toBe('R$ 2.000,00');
    expect(t['Reembolsável']).toBe('R$ 2.000,00');
    expect(t['Saldo a cobrar']).toBe('R$ 2.000,00');
    const texto = await page.locator('#cust-painel').innerText();
    expect(texto).toContain('R$ 2.000,00 são depósitos e garantias cobrados do cliente');
    // Duas tabelas: a das despesas só tem a despesa; o depósito mora no bloco próprio.
    const tabelas = page.locator('#cust-lista .cust-tab:not(.cust-tab-rec)');
    expect(await tabelas.count()).toBe(2);
    expect(await tabelas.nth(0).innerText()).toContain('Despesa comum');
    expect(await tabelas.nth(0).innerText()).not.toContain('Depósito recursal');
    expect(await tabelas.nth(1).innerText()).toContain('Depósito recursal adiantado');
  });

  it('item 1 — recebimentos: parcial, múltiplo, excedente vira "Crédito do cliente" (nunca saldo negativo); edição e data', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Despesa A', valor: '100,00', cobrar: true });
    await lancar({ descricao: 'Despesa B', valor: '50,00', cobrar: true });
    // Sem caixa "Ressarcido" por lançamento.
    expect(await page.locator('#cust-lista [data-cx]').count()).toBe(0);

    await receber({ valor: '40,00', data: '2026-10-10', observacao: 'Pix parcial' });
    expect(await totais()).toMatchObject({
      'Recebido do cliente': 'R$ 40,00',
      'Saldo a cobrar': 'R$ 110,00',
    });
    expect((await linhasDeRecebimento())[0]).toContain('10/10/2026 Pix parcial R$ 40,00');
    await receber({ valor: '110,00', data: '2026-10-11' });
    expect((await totais())['Saldo a cobrar']).toBe('R$ 0,00');
    expect(await page.locator('.cust-credito').count()).toBe(0);

    await receber({ valor: '12,34', data: '2026-10-12' });
    const t = await totais();
    expect(t['Saldo a cobrar']).toBe('R$ 0,00');
    expect(t['Crédito do cliente']).toBe('R$ 12,34');
    expect(JSON.stringify(t)).not.toContain('-');
    expect(await linhasDeRecebimento()).toHaveLength(3);

    await acao('Editar recebimento', '12/10/2026').click();
    expect(await page.locator('#cust-f-valor').inputValue()).toBe('12,34');
    await page.locator('#cust-f-valor').fill('2,00');
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
    expect((await totais())['Crédito do cliente']).toBe('R$ 2,00');
    // Valor inválido não sai da tela.
    await page.locator('#cust-novo-rec').click();
    await page.locator('#cust-f-valor').fill('0');
    await page.locator('#cust-f-salvar').click();
    expect(await page.locator('#cust-f-erro').innerText()).toBe(
      'O valor precisa ser maior que zero.',
    );
  });

  it('item 6 — escolher grupo e subcategoria: seletor com grupos como títulos, busca por texto e subcategoria nova em um grupo', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await page.locator('#cust-novo').click();
    const grupos = await page
      .locator('#cust-f-cat optgroup')
      .evaluateAll((os) => os.map((o) => (o as HTMLOptGroupElement).label));
    expect(grupos).toEqual([
      'Custas e taxas judiciais',
      'Recursos judiciais',
      'Diligências e comunicações',
      'Perícias e avaliações',
      'Execução e expropriação',
      'Cartórios e registros',
      'Pesquisas e certidões',
      'Depósitos e garantias',
      'Despesas administrativas',
      'Outras despesas',
    ]);
    // Busca simples por texto (sem acento): reduz a lista, e a escolha atual nunca some.
    await page.locator('#cust-f-busca').fill('citacao');
    const opcoes = await page.locator('#cust-f-cat option').allTextContents();
    expect(opcoes).toContain('Citação postal');
    expect(opcoes).not.toContain('Taxa judiciária');
    expect(opcoes).toContain('Outras custas judiciais');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cust-f-busca');
    await page.locator('#cust-f-busca').fill('');

    // Nova subcategoria dentro do Grupo 03; a tela mostra o aviso do grupo e o que foi digitado sobrevive.
    await page.locator('#cust-f-desc').fill('Despesa com cartório');
    await page.locator('#cust-f-valor').fill('75,90');
    await page.locator('#cust-f-cat').selectOption({ label: 'Nova subcategoria…' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cust-f-nova');
    await page.locator('#cust-f-grupo-novo').selectOption({ value: '03' });
    // Nome repetido de uma pré-cadastrada do MESMO grupo: o servidor recusa e a tela mostra.
    await page.locator('#cust-f-nova').fill('citação postal');
    await page.getByRole('button', { name: 'Criar subcategoria' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cust-f-erro')?.textContent?.includes('já existe'),
    );
    await page.locator('#cust-f-nova').fill('Cartório do 2º ofício');
    await page.getByRole('button', { name: 'Criar subcategoria' }).click();
    await page.waitForSelector('#cust-f-nova', { state: 'detached' });
    expect(await page.locator('#cust-f-cat').inputValue()).toMatch(/^c-/);
    expect(await page.locator('#cust-f-desc').inputValue()).toBe('Despesa com cartório');
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
    expect((await linhas())[0]).toContain(
      'Diligências e comunicações › Cartório do 2º ofício',
    );
    expect(await page.locator('.cust-subs').first().innerText()).toContain(
      'Cartório do 2º ofício',
    );
    // A nova aparece sob o grupo que o advogado escolheu.
    await page.locator('#cust-novo').click();
    const doGrupo = await page
      .locator('#cust-f-cat optgroup[label="Diligências e comunicações"] option')
      .allTextContents();
    expect(doGrupo).toContain('Cartório do 2º ofício');
    // Subcategoria nova no Grupo 08 avisa que não entra no total de despesas.
    await page.locator('#cust-f-cat').selectOption({ label: 'Nova subcategoria…' });
    await page.locator('#cust-f-grupo-novo').selectOption({ value: '08' });
    expect(await page.locator('#cust-f-aviso-grupo').innerText()).toBe(
      'Depósitos e garantias não entram no total de despesas.',
    );
  });

  it('edita um lançamento (só o que mudou), inclusive quem pagou, e os totais seguem o servidor', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Despesa original', valor: '10,00', cobrar: true });
    await acao('Editar lançamento', 'Despesa original').click();
    expect(await page.locator('#cust-f-valor').inputValue()).toBe('10,00');
    expect(await page.locator('#cust-f-reemb').isChecked()).toBe(true);
    await page.locator('#cust-f-desc').fill('Despesa corrigida');
    await page.locator('#cust-f-valor').fill('25,5');
    await page.locator('#cust-f-reemb').uncheck();
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
    expect((await linhas())[0]).toContain(
      'Despesa corrigida Custas e taxas judiciais › Outras custas judiciais R$ 25,50 Escritório Não',
    );
    expect(await totais()).toMatchObject({
      'Total de despesas': 'R$ 25,50',
      Reembolsável: 'R$ 0,00',
    });
  });

  it('item 5 — cancelar com motivo: confirmação na linha, "Cancelado. Desfazer" por 6 s (relógio falso) que só reativa; nada é excluído', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Despesa a cancelar', valor: '80,00', cobrar: true });
    await lancar({ descricao: 'Despesa que fica', valor: '20,00', cobrar: true });

    await acao('Cancelar lançamento', 'Despesa a cancelar').click();
    expect(await page.locator('#cust-lista').innerText()).toContain('Motivo (opcional)');
    expect(await page.evaluate(() => document.activeElement?.className)).toContain(
      'cust-motivo',
    );
    // Voltar não cancela e devolve o foco ao botão.
    await page.locator('#cust-lista').getByRole('button', { name: 'Voltar' }).click();
    expect((await linhas()).length).toBe(2);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-cust')),
    ).toBe('cancelar');

    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await acao('Cancelar lançamento', 'Despesa a cancelar').click();
    await page.locator('.cust-motivo').fill('Lançado no processo errado');
    await page.getByRole('button', { name: 'Confirmar cancelamento' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cust-aviso')?.textContent?.includes('Cancelado.'),
    );
    expect(await page.locator('#cust-aviso').innerText()).toContain('Desfazer');
    // Escondido da lista e dos totais, MAS guardado no servidor (cancelar não apaga).
    expect((await linhas()).length).toBe(1);
    expect(await totais()).toMatchObject({ 'Total de despesas': 'R$ 20,00' });
    const guardados = (await app.custos.listar(WS, numero, true)).lancamentos;
    expect(guardados).toHaveLength(2);
    expect(guardados.find((c) => c.canceladoEm)?.motivoDoCancelamento).toBe(
      'Lançado no processo errado',
    );
    expect(await page.locator('.cust-escondidos').innerText()).toBe(
      '1 registro cancelado escondido.',
    );

    await page.getByRole('button', { name: 'Desfazer' }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('#cust-lista .cust-tab tbody tr').length === 2,
    );
    expect(await totais()).toMatchObject({ 'Total de despesas': 'R$ 100,00' });
    expect(await page.locator('#cust-aviso').innerText()).toBe('');
    // O MESMO registro voltou (nada foi recriado): continua um só, sem cancelamento.
    expect((await app.custos.listar(WS, numero, true)).lancamentos).toHaveLength(2);
    expect((await app.custos.listar(WS, numero)).lancamentos).toHaveLength(2);

    // Sem desfazer, o aviso some sozinho em 6 s e o foco não fica no vazio.
    await acao('Cancelar lançamento', 'Despesa a cancelar').click();
    await page.getByRole('button', { name: 'Confirmar cancelamento' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cust-aviso')?.textContent?.includes('Cancelado.'),
    );
    await page.getByRole('button', { name: 'Desfazer' }).focus();
    await page.clock.runFor(5_900);
    expect(await page.locator('#cust-aviso').innerText()).toContain('Cancelado.');
    await page.clock.runFor(200);
    expect(await page.locator('#cust-aviso').innerText()).toBe('');
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(
      false,
    );
    expect((await app.custos.listar(WS, numero)).lancamentos).toHaveLength(1);
  });

  it('item 5 — "Mostrar cancelados": riscados, com o texto "Cancelado", fora dos totais, com "Reativar"; vale também para recebimentos', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Vai cancelar', valor: '30,00', cobrar: true });
    await lancar({ descricao: 'Fica ativa', valor: '10,00', cobrar: true });
    await receber({
      valor: '5,00',
      data: '2026-10-10',
      observacao: 'Recebimento errado',
    });

    await acao('Cancelar lançamento', 'Vai cancelar').click();
    await page.getByRole('button', { name: 'Confirmar cancelamento' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cust-aviso')?.textContent?.includes('Cancelado.'),
    );
    await acao('Cancelar recebimento', '10/10/2026').click();
    await page.locator('.cust-motivo').fill('Valor errado');
    await page.getByRole('button', { name: 'Confirmar cancelamento' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cust-lista')?.textContent?.includes('Nenhum recebimento'),
    );
    expect(await page.locator('.cust-escondidos').innerText()).toBe(
      '2 registros cancelados escondidos.',
    );
    const antes = await totais();
    expect(antes['Total de despesas']).toBe('R$ 10,00');
    expect(antes['Recebido do cliente']).toBe('R$ 0,00');

    await page.locator('#cust-f-mostrar-canc').check();
    await page.waitForFunction(
      () => document.querySelectorAll('#cust-lista .cust-cancelado').length === 2,
    );
    const riscada = page.locator('#cust-lista tr', { hasText: 'Vai cancelar' });
    expect(await riscada.locator('.cust-canc').innerText()).toMatch(
      /^Cancelado em \d{2}\/\d{2}\/\d{4}$/,
    );
    expect(
      await riscada
        .locator('td.cust-desc')
        .evaluate((e) => getComputedStyle(e).textDecorationLine),
    ).toBe('line-through');
    expect(await page.locator('#cust-lista').innerText()).toContain(
      'Motivo: Valor errado',
    );
    // Mostrar NÃO os põe nos totais.
    expect(await totais()).toEqual(antes);
    expect(await page.locator('.cust-escondidos').count()).toBe(0);

    await riscada.getByRole('button', { name: 'Reativar lançamento' }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('#cust-lista .cust-cancelado').length === 1,
    );
    expect((await totais())['Total de despesas']).toBe('R$ 40,00');
    await page
      .locator('#cust-lista .cust-tab-rec')
      .getByRole('button', { name: 'Reativar recebimento' })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll('#cust-lista .cust-cancelado').length === 0,
    );
    expect((await totais())['Recebido do cliente']).toBe('R$ 5,00');
  });

  it('item 5 — "Histórico": painel legível, em ordem cronológica, com o valor anterior e o novo', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Despesa com história', valor: '100,00', cobrar: true });
    await acao('Editar lançamento', 'Despesa com história').click();
    await page.locator('#cust-f-valor').fill('125,50');
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
    await acao('Cancelar lançamento', 'Despesa com história').click();
    await page.locator('.cust-motivo').fill('Engano');
    await page.getByRole('button', { name: 'Confirmar cancelamento' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cust-aviso')?.textContent?.includes('Cancelado.'),
    );
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('#cust-lista .cust-tab tbody tr').length === 1,
    );

    await acao('Histórico do lançamento', 'Despesa com história').click();
    await page.waitForSelector('#cust-hist-lista, .cust-hist-lista');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      'cust-hist-painel',
    );
    const itens = await page
      .locator('.cust-hist-lista > li')
      .evaluateAll((ls) =>
        ls.map((l) => (l as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
      );
    expect(itens).toHaveLength(4);
    expect(itens[0]).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} — Criado$/);
    expect(itens[1]).toContain('Editado');
    expect(itens[1]).toContain('Valor: R$ 100,00 → R$ 125,50');
    expect(itens[2]).toContain('Cancelado');
    expect(itens[2]).toContain('Motivo: Engano');
    expect(itens[3]).toContain('Reativado');
    // Fecha com o botão e com Esc; o foco volta ao link "Histórico" da linha.
    await page.getByRole('button', { name: 'Fechar histórico' }).click();
    expect(await page.locator('#cust-hist-painel').count()).toBe(0);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-cust')),
    ).toBe('historico');
    await acao('Histórico do lançamento', 'Despesa com história').click();
    await page.waitForSelector('#cust-hist-painel');
    await page.keyboard.press('Escape');
    expect(await page.locator('#cust-hist-painel').count()).toBe(0);
  });

  it('gera a prestação de contas em PDF: despesas, depósito à parte, recebimento e saldo; sem cancelado, parte ou texto de ato', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Guia para o PDF', valor: '300,00', cobrar: true });
    await lancar({ descricao: 'Gasto fora do filtro', valor: '9,00' });
    await lancar({
      descricao: 'Depósito para o PDF',
      valor: '100,00',
      categoria: 'Caução judicial',
      cobrar: true,
    });
    await lancar({ descricao: 'Cancelada no PDF', valor: '7,77' });
    await acao('Cancelar lançamento', 'Cancelada no PDF').click();
    await page.getByRole('button', { name: 'Confirmar cancelamento' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cust-aviso')?.textContent?.includes('Cancelado.'),
    );
    await receber({ valor: '150,00', data: '2026-10-10', observacao: 'Pix para o PDF' });
    await page.locator('#cust-pdf-cobrar').check();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Gerar prestação de contas (PDF)' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      new RegExp(
        `^prestacao-de-contas-${NumeroCNJ.criar(numero).formatado.replace(/\./g, '\\.')}-\\d{4}-\\d{2}-\\d{2}\\.pdf$`,
      ),
    );
    const caminho = await download.path();
    expect(readFileSync(caminho).subarray(0, 5).toString()).toBe('%PDF-');
    const t = execFileSync('pdftotext', ['-raw', caminho, '-'], {
      encoding: 'utf8',
    }).replace(/\s+/g, ' ');
    expect(t).toContain('Prestação de contas');
    expect(t).toContain('Guia para o PDF');
    expect(t).not.toContain('Gasto fora do filtro');
    expect(t).not.toContain('Cancelada no PDF');
    expect(t).toContain('Depósito para o PDF');
    expect(t).toContain('Pix para o PDF');
    expect(t).toContain('Total de despesas R$ 300,00');
    expect(t).toContain('Total recebido do cliente R$ 150,00');
    expect(t).toContain('Saldo a cobrar R$ 250,00');
    expect(t).not.toContain('Autora Sintética');
    expect(t).not.toContain('Intime-se');
    await page.locator('#cust-pdf-de').fill('2026-10-10');
    await page.locator('#cust-pdf-ate').fill('2026-10-01');
    await page.getByRole('button', { name: 'Gerar prestação de contas (PDF)' }).click();
    expect(await page.locator('#cust-pdf-msg').innerText()).toBe(
      'A data inicial não pode ser depois da data final.',
    );
  });

  it('teclado e leitor de tela: abre com Enter; rádios, caixa e seletor respondem; Esc fecha o formulário e depois o painel', async () => {
    await abrirDetalhe();
    await page.locator('#cust-abrir').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#cust-painel');
    await page.keyboard.press('Tab'); // Fechar
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Fechar');
    await page.keyboard.press('Tab'); // Novo lançamento
    await page.keyboard.press('Enter');
    await page.waitForSelector('#cust-form');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cust-f-data');
    await page.locator('#cust-f-desc').focus();
    await page.keyboard.type('Despesa pelo teclado');
    await page.keyboard.press('Tab'); // valor
    await page.keyboard.type('12,34');
    await page.keyboard.press('Tab'); // busca
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cust-f-busca');
    await page.keyboard.press('Tab'); // seletor Grupo › Subcategoria
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cust-f-cat');
    // Nomes acessíveis: cada controle tem rótulo visível associado.
    for (const [id, nome] of [
      ['cust-f-busca', 'Buscar subcategoria'],
      ['cust-f-cat', 'Grupo › Subcategoria'],
      ['cust-f-valor', 'Valor (R$)'],
    ] as const) {
      expect(await page.locator(`label[for="${id}"]`).innerText()).toBe(nome);
    }
    expect(await page.locator('fieldset.cust-pago legend').innerText()).toBe('Pago por');
    // Rádio com setas, caixa com Espaço.
    await page.locator('#cust-f-pago-escritorio').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.locator('#cust-f-pago-cliente').isChecked()).toBe(true);
    await page.keyboard.press('ArrowUp');
    expect(await page.locator('#cust-f-pago-escritorio').isChecked()).toBe(true);
    await page.locator('#cust-f-reemb').focus();
    await page.keyboard.press('Space');
    expect(await page.locator('#cust-f-reemb').isChecked()).toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#cust-form', { state: 'detached' });
    expect((await linhas())[0]).toContain('R$ 12,34');

    await page.locator('#cust-novo').click();
    await page.waitForSelector('#cust-form');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#cust-form', { state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cust-novo');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#cust-painel', { state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cust-abrir');
  });

  it('a lista vira cartões em tela estreita e é tabela em tela larga', async () => {
    await abrirDetalhe(1366);
    await abrirPainel();
    await lancar({ descricao: 'Item', valor: '1,00', cobrar: true });
    expect(
      await page
        .locator('#cust-lista tr')
        .first()
        .evaluate((e) => getComputedStyle(e).display),
    ).toBe('table-row');
    await page.setViewportSize({ width: 390, height: 900 });
    expect(
      await page
        .locator('#cust-lista tbody tr')
        .first()
        .evaluate((e) => getComputedStyle(e).display),
    ).toBe('block');
    expect(
      await page
        .locator('#cust-lista td[data-rotulo="Valor"]')
        .evaluate((e) => getComputedStyle(e, '::before').content),
    ).toContain('Valor');
  });

  for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
    it(`sem rolagem horizontal em ${largura}px, com painel, formulário, nome longo, histórico e valor alto`, async () => {
      await abrirDetalhe(largura);
      await abrirPainel();
      await lancar({
        descricao:
          'D'.repeat(120) +
          ' descrição muito longa sem espaço no meio ' +
          'palavra'.repeat(12),
        valor: '999.999,99',
        cobrar: true,
        categoria: 'Cópias e digitalizações',
      });
      await lancar({ descricao: 'Outro', valor: '1,00', categoria: 'Depósito judicial' });
      await receber({ valor: '1.000.000,00', observacao: 'O'.repeat(150) });
      await page.getByRole('button', { name: 'Histórico do lançamento' }).first().click();
      await page.locator('#cust-novo').click();
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        painel: document.querySelector('#cust-painel')!.scrollWidth,
        painelCw: document.querySelector('#cust-painel')!.clientWidth,
      }));
      const culpados = await page.evaluate(() => {
        const cw = document.documentElement.clientWidth;
        return Array.from(document.querySelectorAll('#conteudo *'))
          .filter((e) => e.getBoundingClientRect().right > cw + 1)
          .slice(0, 6)
          .map(
            (e) =>
              `${e.tagName}#${e.id}.${String(e.className)} ${Math.round(e.getBoundingClientRect().right)}`,
          );
      });
      expect(culpados).toEqual([]);
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      expect(m.painel).toBeLessThanOrEqual(m.painelCw);
    });
  }

  for (const escuro of [false, true]) {
    it(`axe sem violações com painel, lista, histórico, cancelados e formulário abertos (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
      await abrirDetalhe(1280, escuro);
      await abrirPainel();
      await lancar({ descricao: 'Primeira despesa', valor: '10,00', cobrar: true });
      await lancar({
        descricao: 'Segunda despesa',
        valor: '20,00',
        categoria: 'Honorários de perito judicial',
        cliente: true,
      });
      await lancar({
        descricao: 'Depósito',
        valor: '30,00',
        categoria: 'Fiança criminal',
      });
      await receber({ valor: '50,00', observacao: 'Pix' });
      await acao('Cancelar lançamento', 'Segunda despesa').click();
      await page.getByRole('button', { name: 'Confirmar cancelamento' }).click();
      await page.waitForFunction(() =>
        document.querySelector('#cust-aviso')?.textContent?.includes('Cancelado.'),
      );
      await page.locator('#cust-f-mostrar-canc').check();
      await page.waitForSelector('#cust-lista .cust-cancelado');
      await acao('Histórico do lançamento', 'Primeira despesa').click();
      await page.waitForSelector('.cust-hist-lista');
      await page.locator('#cust-novo').click();
      await page.locator('#cust-f-cat').selectOption({ label: 'Nova subcategoria…' });
      await page.addScriptTag({
        content: (AxeBuilder as unknown as { source: string }).source,
      });
      const r = await page.evaluate(() =>
        (window as unknown as AxeNaPagina).axe.run(
          // "← voltar" usa o --tinta3 global (4,2:1): problema anterior a esta versão (CLAUDE.md).
          {
            include: [['#cust-raiz'], ['.capa']],
            exclude: [['#voltar']],
          } as unknown as Element,
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

  it('não altera a tela do processo fechada nem a aba Atualizações (regressão)', async () => {
    await abrirDetalhe();
    const antes = await page.locator('#conteudo').innerHTML();
    expect(antes).not.toContain('id="cust-painel"');
    expect(await page.locator('#conteudo h3.sec').allTextContents()).toEqual(
      expect.arrayContaining(['Partes']),
    );
    await abrirPainel();
    await page.keyboard.press('Escape');
    await page.waitForSelector('#cust-painel', { state: 'detached' });
    expect(await page.locator('#conteudo').innerHTML()).toBe(antes);

    await page.evaluate(
      (n) =>
        fetch('/v1/acompanhamentos', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': localStorage.getItem('processovivo.chave') ?? '',
          },
          body: JSON.stringify({ numero: n }),
        }),
      numero,
    );
    await page.goto(url + '/');
    await page.waitForSelector('.nvt-tabela');
    expect(await page.locator('.nvt-tabela').innerText()).not.toContain('Custos');
    expect(await page.locator('#cust-abrir').count()).toBe(0);
  });

  it('o painel sobrevive ao redesenho da tela do processo e some ao sair dele', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Persistente', valor: '3,00' });
    await page.evaluate(() => {
      const w = window as unknown as { __pvCustos: { aposDesenhar(n: string): void } };
      w.__pvCustos.aposDesenhar(document.querySelector('.capa .num')!.textContent!);
    });
    expect(await page.locator('#cust-lista .cust-tab tbody tr').count()).toBe(1);
    await page.locator('#voltar').click();
    await page.waitForSelector('#cust-raiz', { state: 'detached' });
    numero = novoNumero();
    await page.evaluate((n) => (window as unknown as ConsolePv).__pv!.abrir(n), numero);
    await page.waitForSelector('#cust-abrir');
    await abrirPainel();
    expect(await page.locator('#cust-lista').innerText()).toContain(
      'Nenhum custo lançado',
    );
  });

  it('um texto com marcação é mostrado como texto (descrição, observação e motivo), sem innerHTML com dado do usuário', async () => {
    await abrirDetalhe();
    await abrirPainel();
    const perigo = '<img src=x onerror=window.__xss=1> <b>negrito</b>';
    await lancar({ descricao: perigo, valor: '1,00', cobrar: true });
    await receber({ valor: '1,00', observacao: perigo });
    expect(await page.locator('#cust-lista td.cust-desc').first().innerText()).toContain(
      perigo,
    );
    await page.getByRole('button', { name: 'Cancelar lançamento' }).first().click();
    await page.locator('.cust-motivo').fill(perigo);
    await page.getByRole('button', { name: 'Confirmar cancelamento' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cust-aviso')?.textContent?.includes('Cancelado.'),
    );
    await page.locator('#cust-f-mostrar-canc').check();
    await page.waitForSelector('#cust-lista .cust-cancelado');
    await page.getByRole('button', { name: 'Histórico do lançamento' }).first().click();
    await page.waitForSelector('.cust-hist-lista');
    expect(await page.locator('#cust-raiz img, #cust-raiz b').count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
  });
});
