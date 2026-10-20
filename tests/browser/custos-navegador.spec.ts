/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
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

/*
 * v0.47.0 NUM NAVEGADOR: o centro de custos na tela do processo. Servidor e console reais; dados
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
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e) => {
      throw e;
    });
    await page.goto(url + '/');
    await page.waitForFunction(
      () => typeof (window as unknown as ConsolePv).__pv?.abrir === 'function',
    );
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
    data?: string;
  }): Promise<void> {
    await page.locator('#cust-novo').click();
    if (o.data) await page.locator('#cust-f-data').fill(o.data);
    await page.locator('#cust-f-desc').fill(o.descricao);
    if (o.categoria)
      await page.locator('#cust-f-cat').selectOption({ label: o.categoria });
    await page.locator('#cust-f-valor').fill(o.valor);
    if (o.cobrar) await page.locator('#cust-f-reemb').check();
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
  }

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
      .locator('#cust-lista tbody tr')
      .evaluateAll((trs) =>
        trs.map((t) => (t as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
      );

  it('o botão "Custos" tem nome acessível e dica; o painel abre vazio, com a frase combinada e totais zerados', async () => {
    await abrirDetalhe();
    const b = page.locator('#cust-abrir');
    expect(await b.getAttribute('aria-label')).toBe('Custos do processo');
    expect(await b.getAttribute('title')).toBe('Custos do processo');
    expect(await b.getAttribute('aria-expanded')).toBe('false');
    // Fechado, a tela do processo é a de antes: nada do painel no DOM.
    expect(await page.locator('#cust-raiz').count()).toBe(0);
    await abrirPainel();
    expect(await b.getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#cust-lista').innerText()).toBe(
      'Nenhum custo lançado neste processo. Adicione o primeiro.',
    );
    expect(await totais()).toEqual({
      'Total gasto': 'R$ 0,00',
      Reembolsável: 'R$ 0,00',
      'Já ressarcido': 'R$ 0,00',
      'Saldo a cobrar': 'R$ 0,00',
    });
    // O foco foi para o painel (leitor de tela lê o título), e o botão do processo segue no grupo da capa.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cust-painel');
    expect(await page.locator('.capa #cust-abrir').count()).toBe(1);
  });

  it('lança dois custos de categorias diferentes, aceita 1.234,56 e 1234,56 e mostra o valor em reais', async () => {
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

    await lancar({ descricao: 'Perícia contábil', valor: '500', categoria: 'Perícia' });

    expect(await totais()).toEqual({
      'Total gasto': 'R$ 1.734,56',
      Reembolsável: 'R$ 1.234,56',
      'Já ressarcido': 'R$ 0,00',
      'Saldo a cobrar': 'R$ 1.234,56',
    });
    const l = await linhas();
    expect(l).toHaveLength(2);
    expect(l.join('|')).toContain(
      'Guia de custas iniciais Custas judiciais R$ 1.234,56 Sim',
    );
    expect(l.join('|')).toContain('Perícia contábil Perícia R$ 500,00 Não');
    expect(await page.locator('.cust-subs').innerText()).toContain('Perícia');
    // Valor impossível não sai da tela: o servidor nem é chamado.
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

  it('marca "Ressarcido" na caixa (otimista), os totais mudam no servidor, e desmarca', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Cópias do processo', valor: '100,00', cobrar: true });
    await lancar({
      descricao: 'Diligência',
      valor: '50,00',
      cobrar: true,
      categoria: 'Diligência',
    });
    await lancar({ descricao: 'Gasto interno', valor: '10,00' });

    const caixa = page.locator('#cust-lista [data-cx="ressarcido"]').first();
    // 2 caixas (só reembolsável); o gasto interno mostra "—".
    expect(await page.locator('#cust-lista [data-cx="ressarcido"]').count()).toBe(2);
    expect(await caixa.getAttribute('aria-label')).toMatch(/^Ressarcido: /);
    // A dica: role=tooltip ligada por aria-describedby, e o texto depende do estado.
    const dica = page.locator(`#${await caixa.getAttribute('aria-describedby')}`);
    expect(await dica.getAttribute('role')).toBe('tooltip');
    expect(await dica.textContent()).toBe(
      'A cobrar do cliente. Marque quando ressarcido.',
    );

    await page
      .locator('#cust-lista tr', { hasText: 'Cópias do processo' })
      .locator('.sit-cx')
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('#cust-live')?.textContent === 'Marcado como ressarcido.',
    );
    expect(await totais()).toMatchObject({
      'Total gasto': 'R$ 160,00',
      Reembolsável: 'R$ 150,00',
      'Já ressarcido': 'R$ 100,00',
      'Saldo a cobrar': 'R$ 50,00',
    });
    const linhaCopias = page.locator('#cust-lista tr', { hasText: 'Cópias do processo' });
    expect(await linhaCopias.locator('.cust-em').innerText()).toMatch(
      /^em \d{2}\/\d{2}\/\d{4}$/,
    );
    expect(await linhaCopias.locator('[data-cx]').isChecked()).toBe(true);
    // O foco continua na caixa depois do redesenho.
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-cx')),
    ).toBe('ressarcido');

    await linhaCopias.locator('.sit-cx').click();
    await page.waitForFunction(
      () =>
        document.querySelector('#cust-live')?.textContent === 'Ressarcimento desmarcado.',
    );
    expect(await totais()).toMatchObject({
      'Já ressarcido': 'R$ 0,00',
      'Saldo a cobrar': 'R$ 150,00',
    });
  });

  it('se o servidor recusar, a caixa volta e a tela diz; nenhuma mudança fica pela metade', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Despesa X', valor: '20,00', cobrar: true });
    await page.route('**/ressarcimento', (r) =>
      r.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"mensagem":"x"}',
      }),
    );
    const caixa = page.locator('#cust-lista [data-cx="ressarcido"]');
    await page.locator('#cust-lista .sit-cx').click();
    await page.waitForFunction(() =>
      document
        .querySelector('#cust-msg')
        ?.textContent?.includes('Não foi possível salvar'),
    );
    expect(await caixa.isChecked()).toBe(false);
    expect(await caixa.getAttribute('aria-busy')).toBeNull();
    expect((await totais())['Já ressarcido']).toBe('R$ 0,00');
    await page.unroute('**/ressarcimento');
  });

  it('cria categoria própria por "Nova categoria…", usa no lançamento, e ela entra nos subtotais', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await page.locator('#cust-novo').click();
    await page.locator('#cust-f-desc').fill('Taxa do cartório');
    await page.locator('#cust-f-valor').fill('75,90');
    await page.locator('#cust-f-cat').selectOption({ label: 'Nova categoria…' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cust-f-nova');
    // Nome repetido da lista base: o servidor recusa e a tela mostra.
    await page.locator('#cust-f-nova').fill('perícia');
    await page.getByRole('button', { name: 'Criar categoria' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cust-f-erro')?.textContent?.includes('já existe'),
    );
    await page.locator('#cust-f-nova').fill('Cartório do 2º ofício');
    await page.getByRole('button', { name: 'Criar categoria' }).click();
    await page.waitForSelector('#cust-f-nova', { state: 'detached' });
    expect(await page.locator('#cust-f-cat').inputValue()).toMatch(/^c-/);
    // O que já foi digitado sobrevive à criação da categoria.
    expect(await page.locator('#cust-f-desc').inputValue()).toBe('Taxa do cartório');
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
    expect((await linhas())[0]).toContain('Cartório do 2º ofício');
    expect(await page.locator('.cust-subs').innerText()).toContain(
      'Cartório do 2º ofício',
    );
    // Disponível no próximo lançamento.
    await page.locator('#cust-novo').click();
    expect(await page.locator('#cust-f-cat option').allTextContents()).toContain(
      'Cartório do 2º ofício',
    );
  });

  it('edita um lançamento (só o que mudou) e os totais seguem o servidor', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Despesa original', valor: '10,00', cobrar: true });
    await page.getByRole('button', { name: 'Editar: Despesa original' }).click();
    expect(await page.locator('#cust-f-valor').inputValue()).toBe('10,00');
    expect(await page.locator('#cust-f-reemb').isChecked()).toBe(true);
    await page.locator('#cust-f-desc').fill('Despesa corrigida');
    await page.locator('#cust-f-valor').fill('25,5');
    await page.locator('#cust-f-reemb').uncheck();
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
    expect((await linhas())[0]).toContain(
      'Despesa corrigida Custas judiciais R$ 25,50 Não',
    );
    expect(await totais()).toMatchObject({
      'Total gasto': 'R$ 25,50',
      Reembolsável: 'R$ 0,00',
    });
  });

  it('excluir: confirmação na linha, definitivo, "Excluído. Desfazer" por 6 s (relógio falso) e desfazer recria', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Despesa a excluir', valor: '80,00', cobrar: true });
    await page.locator('#cust-lista .sit-cx').click();
    await page.waitForFunction(
      () =>
        document.querySelector('#cust-live')?.textContent === 'Marcado como ressarcido.',
    );

    await page.getByRole('button', { name: 'Excluir: Despesa a excluir' }).click();
    expect(await page.locator('#cust-lista').innerText()).toContain(
      'Excluir este lançamento?',
    );
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
      'Cancelar',
    );
    // Cancelar não exclui e devolve o foco ao botão.
    await page.getByRole('button', { name: 'Cancelar' }).click();
    expect((await linhas()).length).toBe(1);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-cust')),
    ).toBe('excluir');

    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await page.getByRole('button', { name: 'Excluir: Despesa a excluir' }).click();
    await page.getByRole('button', { name: 'Excluir', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cust-aviso')?.textContent?.includes('Excluído.'),
    );
    expect(await page.locator('#cust-lista').innerText()).toContain(
      'Nenhum custo lançado',
    );
    expect((await app.custos.listar(WS, numero)).lancamentos).toHaveLength(0);

    await page.getByRole('button', { name: 'Desfazer' }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('#cust-lista tbody tr').length === 1,
    );
    // Recriado como era, inclusive o ressarcimento.
    expect(await totais()).toMatchObject({
      'Total gasto': 'R$ 80,00',
      'Já ressarcido': 'R$ 80,00',
    });
    expect(await page.locator('#cust-aviso').innerText()).toBe('');

    // Sem desfazer, o aviso some sozinho em 6 s e o foco não fica no vazio.
    await page.getByRole('button', { name: 'Excluir: Despesa a excluir' }).click();
    await page.getByRole('button', { name: 'Excluir', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cust-aviso')?.textContent?.includes('Excluído.'),
    );
    await page.getByRole('button', { name: 'Desfazer' }).focus();
    await page.clock.runFor(5_900);
    expect(await page.locator('#cust-aviso').innerText()).toContain('Excluído.');
    await page.clock.runFor(200);
    expect(await page.locator('#cust-aviso').innerText()).toBe('');
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(
      false,
    );
    expect((await app.custos.listar(WS, numero)).lancamentos).toHaveLength(0);
  });

  it('gera a prestação de contas em PDF e baixa o arquivo com o conteúdo certo', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({ descricao: 'Guia para o PDF', valor: '300,00', cobrar: true });
    await lancar({ descricao: 'Gasto fora do filtro', valor: '9,00' });
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
    expect(t).toContain('Saldo a cobrar R$ 300,00');
    // Sem partes nem texto de ato, mesmo com o processo aberto na tela.
    expect(t).not.toContain('Autora Sintética');
    expect(t).not.toContain('Intime-se');
    // Período invertido: a tela avisa sem chamar o servidor.
    await page.locator('#cust-pdf-de').fill('2026-10-10');
    await page.locator('#cust-pdf-ate').fill('2026-10-01');
    await page.getByRole('button', { name: 'Gerar prestação de contas (PDF)' }).click();
    expect(await page.locator('#cust-pdf-msg').innerText()).toBe(
      'A data inicial não pode ser depois da data final.',
    );
  });

  it('teclado completo: abre com Enter, Esc fecha o formulário e depois o painel devolvendo o foco ao botão', async () => {
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
    // O campo de data tem segmentos (dia, mês, ano): a pessoa pula para a descrição pelo teclado.
    await page.locator('#cust-f-desc').focus();
    await page.keyboard.type('Despesa pelo teclado');
    await page.keyboard.press('Tab'); // categoria
    await page.keyboard.press('Tab'); // valor
    await page.keyboard.type('12,34');
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
    // A caixa Ressarcido responde ao Espaço.
    await page.locator('#cust-abrir').click();
    await page.waitForSelector('#cust-painel');
    await page.locator('#cust-novo').click();
    await page.locator('#cust-f-desc').fill('Reembolsável');
    await page.locator('#cust-f-valor').fill('1');
    await page.locator('#cust-f-reemb').check();
    await page.locator('#cust-f-salvar').click();
    await page.waitForSelector('#cust-form', { state: 'detached' });
    await page.locator('#cust-lista [data-cx="ressarcido"]').focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () =>
        document.querySelector('#cust-live')?.textContent === 'Marcado como ressarcido.',
    );
    expect((await totais())['Já ressarcido']).toBe('R$ 1,00');
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
    it(`sem rolagem horizontal em ${largura}px, com painel, formulário, nome longo e valor alto`, async () => {
      await abrirDetalhe(largura);
      await abrirPainel();
      await lancar({
        descricao:
          'D'.repeat(120) +
          ' descrição muito longa sem espaço no meio ' +
          'palavra'.repeat(12),
        valor: '999.999,99',
        cobrar: true,
        categoria: 'Cópias e impressões',
      });
      await lancar({ descricao: 'Outro', valor: '1,00' });
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
    it(`axe sem violações com painel, lista e formulário abertos (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
      await abrirDetalhe(1280, escuro);
      await abrirPainel();
      await lancar({ descricao: 'Primeira despesa', valor: '10,00', cobrar: true });
      await lancar({
        descricao: 'Segunda despesa',
        valor: '20,00',
        categoria: 'Perícia',
      });
      await page.locator('#cust-lista [data-cx="ressarcido"]').first().check();
      await page.waitForFunction(
        () =>
          document.querySelector('#cust-live')?.textContent ===
          'Marcado como ressarcido.',
      );
      await page.locator('#cust-novo').click();
      await page.locator('#cust-f-cat').selectOption({ label: 'Nova categoria…' });
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
    // Fechado: só o botão a mais na capa.
    const antes = await page.locator('#conteudo').innerHTML();
    expect(antes).not.toContain('id="cust-painel"');
    expect(await page.locator('#conteudo h3.sec').allTextContents()).toEqual(
      expect.arrayContaining(['Partes']),
    );
    // Abrir e fechar o painel devolve o HTML exato de antes.
    await abrirPainel();
    await page.keyboard.press('Escape');
    await page.waitForSelector('#cust-painel', { state: 'detached' });
    expect(await page.locator('#conteudo').innerHTML()).toBe(antes);

    // Atualizações: acompanha o processo e confere a caixa "Cumprido" e a ausência de custos.
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
    // Redesenho: a régua do tribunal chegando chama os ganchos de novo.
    await page.evaluate(() => {
      const w = window as unknown as { __pvCustos: { aposDesenhar(n: string): void } };
      w.__pvCustos.aposDesenhar(document.querySelector('.capa .num')!.textContent!);
    });
    expect(await page.locator('#cust-lista tbody tr').count()).toBe(1);
    await page.locator('#voltar').click();
    await page.waitForSelector('#cust-raiz', { state: 'detached' });
    // Abrir outro processo não herda lançamentos.
    numero = novoNumero();
    await page.evaluate((n) => (window as unknown as ConsolePv).__pv!.abrir(n), numero);
    await page.waitForSelector('#cust-abrir');
    await abrirPainel();
    expect(await page.locator('#cust-lista').innerText()).toContain(
      'Nenhum custo lançado',
    );
  });

  it('um texto com marcação é mostrado como texto (sem innerHTML com dado do usuário)', async () => {
    await abrirDetalhe();
    await abrirPainel();
    await lancar({
      descricao: '<img src=x onerror=window.__xss=1> <b>negrito</b>',
      valor: '1,00',
      cobrar: true,
    });
    expect(await page.locator('#cust-lista td.cust-desc').innerText()).toContain(
      '<img src=x onerror=window.__xss=1> <b>negrito</b>',
    );
    expect(await page.locator('#cust-lista img, #cust-lista b').count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
  });
});
