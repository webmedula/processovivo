/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { DestinoFalso } from '../helpers/drive.js';
import {
  OUTRO_PROCESSO,
  PNG_1X1,
  PROCESSO_TJGO,
  pdfSintetico,
} from '../helpers/leitor.js';
import { CODIGO_DO_GOOGLE } from '../helpers/transporteDoDrive.js';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';

/*
 * v0.49.0 NUM NAVEGADOR: a tela "Custos" por cliente (menu, filtros aviso de "Sem cliente", PDF e
 * CSV), o aviso de "Deixar de acompanhar" e os comprovantes no Drive. Servidor e console REAIS; o
 * Google é um dublê em memória; dados e arquivos SINTÉTICOS.
 */
const sem = CHROMIUM === undefined;
const WS = workspaceDaChave(CHAVE);
const CHAVE_AZUL = 'cliente azul';

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

describe.skipIf(sem)(
  'Custos por cliente e comprovantes — no navegador',
  { timeout: 120_000 },
  () => {
    let browser: Browser;
    let amb: Ambiente | undefined;
    let ctx: BrowserContext | undefined;
    let page: Page;
    let destino: DestinoFalso;
    let dialogos: string[] = [];

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
      amb = undefined;
      ctx = undefined;
    });

    async function abrir(
      o: { largura?: number; escuro?: boolean; plano?: string; semDrive?: boolean } = {},
    ): Promise<void> {
      destino = new DestinoFalso();
      amb = await iniciar(
        o.semDrive ? {} : { drive: { destino, ...(o.plano ? { plano: o.plano } : {}) } },
      );
      ctx = await browser.newContext({
        viewport: { width: o.largura ?? 1360, height: 900 },
        colorScheme: o.escuro ? 'dark' : 'light',
        acceptDownloads: true,
        extraHTTPHeaders: { 'x-api-key': CHAVE },
      });
      await ctx.addInitScript((c) => {
        try {
          localStorage.setItem('processovivo.chave', c);
        } catch {
          /* sem armazenamento: o teste falharia adiante, com a causa à vista */
        }
      }, CHAVE);
      dialogos = [];
      page = await ctx.newPage();
      page.setDefaultTimeout(30_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      await page.goto(`${amb.url}/`);
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { __pv?: { abrir?: unknown } }).__pv?.abrir ===
          'function',
      );
    }

    const novo = (
      descricao: string,
      valorCentavos: number,
      extra: Record<string, unknown> = {},
    ) => ({
      data: '2026-09-10',
      descricao,
      categoria: 'CUS-020',
      valorCentavos,
      reembolsavel: true,
      ...extra,
    });

    /** Cliente Azul (PROCESSO_TJGO, acompanhado e rotulado) e um processo solto, sem rótulo. */
    async function massa(): Promise<void> {
      const app = amb!.app;
      await app.acompanhamento.acompanhar(WS, PROCESSO_TJGO);
      await app.acompanhamento.rotular(WS, PROCESSO_TJGO, 'Cliente Azul');
      await app.custos.criar(WS, PROCESSO_TJGO, novo('Guia do Azul', 10_000));
      await app.custos.registrarRecebimento(WS, PROCESSO_TJGO, {
        data: '2026-09-20',
        valorCentavos: 4_000,
        observacao: 'Pix',
      });
      await app.custos.criar(WS, OUTRO_PROCESSO, novo('Despesa solta', 2_500));
    }

    async function irParaCustos(): Promise<void> {
      await page.locator('#nav-custos').click();
      await page.waitForSelector('#cc');
      await page.waitForFunction(
        () => !document.querySelector('#cc-corpo')?.textContent?.includes('Carregando'),
      );
    }

    const celulas = async (): Promise<string[][]> =>
      page
        .locator('#cc-corpo .cc-tab tbody tr')
        .evaluateAll((trs) =>
          trs.map((t) =>
            Array.from(t.querySelectorAll('td')).map((c) =>
              (c as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
            ),
          ),
        );

    it('o menu "Custos" fica logo depois de "Calendário"; a tela vazia é honesta', async () => {
      await abrir();
      const ordem = await page
        .locator('nav.nav button')
        .evaluateAll((bs) => bs.map((b) => b.id));
      expect(ordem.slice(0, 4)).toEqual([
        'nav-novidades',
        'nav-processos',
        'nav-calendario',
        'nav-custos',
      ]);
      await irParaCustos();
      expect(await page.locator('#nav-custos').getAttribute('class')).toContain('ativo');
      expect(await page.locator('#cc-tit').innerText()).toBe('Custos');
      expect(await page.locator('#cc-corpo').innerText()).toContain(
        'Nenhum custo lançado ainda',
      );
      expect(await page.locator('.cc-aviso').count()).toBe(0);
    });

    it('lista os clientes com os totais, avisa dos processos "Sem cliente" e diz "Mostrando X de Y"', async () => {
      await abrir();
      await massa();
      await irParaCustos();
      expect(await page.locator('#cc-aviso').innerText()).toContain(
        '1 processo com custos está sem cliente',
      );
      expect(await page.locator('#cc-aviso').innerText()).toContain(
        'Os custos não se perdem',
      );
      expect(await page.locator('#cc-conta').innerText()).toBe(
        'Mostrando 2 de 2 clientes · 2 processos com custos no total.',
      );
      const l = await celulas();
      expect(l[0]).toEqual([
        'Cliente Azul',
        '1',
        'R$ 100,00',
        'R$ 100,00',
        'R$ 40,00',
        'R$ 60,00',
        'R$ 0,00',
        'Abrir',
      ]);
      expect(l[1]![0]).toContain('Sem cliente');
      expect(l[1]!.slice(2, 6)).toEqual(['R$ 25,00', 'R$ 25,00', 'R$ 0,00', 'R$ 25,00']);
    });

    it('filtros: cliente, período e "somente com saldo a cobrar" — e a contagem sempre diz o total sem filtro', async () => {
      await abrir();
      await massa();
      await amb!.app.custos.criar(
        WS,
        PROCESSO_TJGO,
        novo('Antiga', 777, { data: '2026-06-01' }),
      );
      await irParaCustos();
      await page.locator('#cc-f-cliente').selectOption({ value: CHAVE_AZUL });
      expect(await page.locator('#cc-conta').innerText()).toContain(
        'Mostrando 1 de 2 clientes',
      );
      await page.locator('#cc-f-cliente').selectOption({ value: '' });

      await page.locator('#cc-f-de').fill('2026-09-01');
      await page.locator('#cc-f-ate').fill('2026-09-30');
      await page.waitForFunction(() =>
        document.querySelector('#cc-conta')?.textContent?.includes('2 de 2'),
      );
      // A despesa antiga (junho) ficou de fora do período.
      expect((await celulas())[0]![2]).toBe('R$ 100,00');
      await page.locator('#cc-f-de').fill('');
      await page.locator('#cc-f-ate').fill('');
      await page.waitForFunction(() => {
        const t = document.querySelector(
          '#cc-corpo .cc-tab tbody tr td:nth-child(3)',
        ) as HTMLElement | null;
        return t?.innerText.trim() === 'R$ 107,77';
      });

      await amb!.app.custos.registrarRecebimento(WS, OUTRO_PROCESSO, {
        data: '2026-09-20',
        valorCentavos: 2_500,
      });
      await page.locator('#cc-f-saldo').check();
      await page.waitForFunction(() =>
        document.querySelector('#cc-conta')?.textContent?.includes('1 de 2'),
      );
      expect((await celulas()).map((c) => c[0])).toEqual(['Cliente Azul']);
      await page.locator('#cc-f-de').fill('2030-01-01');
      await page.waitForFunction(() =>
        document
          .querySelector('#cc-corpo')
          ?.textContent?.includes('Nenhum cliente neste filtro'),
      );
      // Período invertido: a tela avisa sem chamar o servidor.
      await page.locator('#cc-f-de').fill('2026-10-10');
      await page.locator('#cc-f-ate').fill('2026-10-01');
      expect(await page.locator('#cc-msg').innerText()).toBe(
        'A data inicial não pode ser depois da data final.',
      );
    });

    it('abre o cliente: processos com totais, atalho para o painel de custos do processo, e volta', async () => {
      await abrir();
      await massa();
      await irParaCustos();
      await page
        .getByRole('button', { name: /Abrir os processos de Cliente Azul/ })
        .click();
      await page.waitForSelector('#cc-tit-cliente');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        'cc-tit-cliente',
      );
      expect(await page.locator('#cc-tit-cliente').innerText()).toBe('Cliente Azul');
      const t = await page
        .locator('.cc-tot')
        .evaluateAll((es) =>
          Object.fromEntries(
            es.map((e) => [
              e.querySelector('dt')!.textContent!,
              e.querySelector('dd')!.textContent!,
            ]),
          ),
        );
      expect(t['Saldo a cobrar']).toBe('R$ 60,00');
      expect(t['Recebido do cliente']).toBe('R$ 40,00');
      expect(await page.locator('.cc-conta').innerText()).toBe(
        'Mostrando 1 de 1 processo deste cliente.',
      );
      const linha = (await celulas())[0]!;
      expect(linha[0]).toBe(PROCESSO_TJGO);
      expect(linha[1]).toBe('TJGO');
      // O atalho abre o processo e já deixa o painel de custos aberto.
      await page
        .getByRole('button', { name: /Abrir o painel de custos do processo/ })
        .click();
      await page.waitForSelector('#cust-painel');
      expect(await page.locator('#cust-lista').innerText()).toContain('Guia do Azul');
      // Voltar à tela de Custos mostra a lista de novo.
      await page.locator('#nav-custos').click();
      await page.waitForSelector('#cc');
      await page.waitForSelector('#cc-corpo .cc-tab');
    });

    it('"Sem cliente" abre como os outros e explica por que o processo está lá', async () => {
      await abrir();
      await massa();
      await irParaCustos();
      await page
        .getByRole('button', { name: /Abrir os processos de Sem cliente/ })
        .click();
      await page.waitForSelector('#cc-tit-cliente');
      expect(await page.locator('#cc-corpo .cc-nota').first().innerText()).toContain(
        'deixaram de ser acompanhados',
      );
      expect((await celulas())[0]![0]).toBe(OUTRO_PROCESSO);
      await page.locator('#cc-voltar').click();
      await page.waitForSelector('#cc-conta');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('cc-tit');
    });

    it('gera o PDF consolidado e a planilha CSV do cliente (download de verdade)', async () => {
      await abrir();
      await massa();
      const id = (
        await amb!.app.custos.criar(
          WS,
          PROCESSO_TJGO,
          novo('Cancelada no relatório', 999),
        )
      ).id;
      await amb!.app.custos.cancelar(WS, id);
      await irParaCustos();
      await page
        .getByRole('button', { name: /Abrir os processos de Cliente Azul/ })
        .click();
      await page.waitForSelector('#cc-pdf');

      const [pdf] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#cc-pdf').click(),
      ]);
      expect(pdf.suggestedFilename()).toMatch(
        /^prestacao-de-contas-por-cliente-\d{4}-\d{2}-\d{2}\.pdf$/,
      );
      const caminho = await pdf.path();
      expect(readFileSync(caminho).subarray(0, 5).toString()).toBe('%PDF-');
      const t = execFileSync('pdftotext', ['-raw', caminho, '-'], {
        encoding: 'utf8',
      }).replace(/\s+/g, ' ');
      expect(t).toContain('Prestação de contas — Cliente Azul');
      expect(t).toContain('Guia do Azul');
      expect(t).toContain('Saldo a cobrar R$ 60,00');
      expect(t).not.toContain('Cancelada no relatório');
      expect(t).not.toContain('Despesa solta');

      const [csv] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#cc-csv').click(),
      ]);
      expect(csv.suggestedFilename()).toMatch(
        /^custos-por-cliente-\d{4}-\d{2}-\d{2}\.csv$/,
      );
      const bruto = readFileSync((await csv.path())!);
      expect([...bruto.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const corpo = bruto.toString('utf8');
      expect(corpo).toContain('Guia do Azul');
      expect(corpo).toContain('Recebimento');
      expect(corpo).not.toContain('Cancelada no relatório');
      expect(corpo).not.toContain('Despesa solta');

      // Com "incluir cancelados", a linha volta MARCADA.
      await page.locator('#cc-csv-canc').check();
      const [csv2] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#cc-csv').click(),
      ]);
      const corpo2 = readFileSync((await csv2.path())!).toString('utf8');
      expect(corpo2).toContain('Cancelada no relatório');
      expect(corpo2).toMatch(
        /Cancelado;[^\r\n]*Cancelada no relatório|Despesa;Cancelado;/,
      );
    });

    it('o CSV do painel do processo também baixa, com a opção de incluir cancelados', async () => {
      await abrir();
      await massa();
      await page.evaluate(
        (n) => (window as unknown as { __pv: { abrir(n: string): void } }).__pv.abrir(n),
        PROCESSO_TJGO,
      );
      await page.waitForSelector('#cust-abrir');
      await page.locator('#cust-abrir').click();
      await page.waitForSelector('#cust-painel');
      const [csv] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#cust-csv').click(),
      ]);
      expect(csv.suggestedFilename()).toMatch(/^custos-.*\.csv$/);
      expect(readFileSync((await csv.path())!).toString('utf8')).toContain(
        'Guia do Azul',
      );
    });

    describe('"Deixar de acompanhar"', () => {
      async function abrirAcompanhado(): Promise<void> {
        await abrir();
        await amb!.app.acompanhamento.acompanhar(WS, PROCESSO_TJGO);
        await amb!.app.acompanhamento.rotular(WS, PROCESSO_TJGO, 'Cliente Azul');
        page.on('dialog', (d) => {
          dialogos.push(d.message());
          void (aceitar ? d.accept() : d.dismiss());
        });
        await page.evaluate(
          (n) =>
            (window as unknown as { __pv: { abrir(n: string): void } }).__pv.abrir(n),
          PROCESSO_TJGO,
        );
        await page.waitForSelector('#parar');
      }
      let aceitar = false;

      it('com custos lançados, avisa que o rótulo se perde e o processo vira "Sem cliente"; cancelar não faz nada', async () => {
        aceitar = false;
        await abrirAcompanhado();
        await amb!.app.custos.criar(WS, PROCESSO_TJGO, novo('Guia', 1_000));
        await page.locator('#parar').click();
        await page.waitForFunction(() => true);
        await expect.poll(() => dialogos.length).toBe(1);
        expect(dialogos[0]).toContain('o rótulo de cliente se perde');
        expect(dialogos[0]).toContain('"Sem cliente"');
        expect(dialogos[0]).toContain('Os custos não se perdem');
        // Dispensou: segue acompanhado, com o rótulo.
        expect(
          await amb!.app.acompanhamento.rotular(WS, PROCESSO_TJGO, 'Cliente Azul'),
        ).toBe(true);
        expect(await page.locator('#parar').count()).toBe(1);
      });

      it('confirmando, deixa de acompanhar, o rótulo some e o custo continua (agora em "Sem cliente")', async () => {
        aceitar = true;
        await abrirAcompanhado();
        await amb!.app.custos.criar(WS, PROCESSO_TJGO, novo('Guia que fica', 1_000));
        await page.locator('#parar').click();
        await expect.poll(() => dialogos.length).toBe(1);
        await page.waitForFunction(() =>
          document.querySelector('#nav-processos')?.classList.contains('ativo'),
        );
        expect(await amb!.app.acompanhamento.rotular(WS, PROCESSO_TJGO, 'x')).toBe(false);
        expect(
          (await amb!.app.custos.listar(WS, PROCESSO_TJGO)).lancamentos,
        ).toHaveLength(1);
        await irParaCustos();
        expect((await celulas())[0]![0]).toContain('Sem cliente');
      });

      it('sem custos lançados, não pergunta nada', async () => {
        aceitar = true;
        await abrirAcompanhado();
        await page.locator('#parar').click();
        await page.waitForFunction(() =>
          document.querySelector('#nav-processos')?.classList.contains('ativo'),
        );
        expect(dialogos).toEqual([]);
      });
    });

    describe('comprovantes', () => {
      async function painel(): Promise<void> {
        await page.evaluate(
          (n) =>
            (window as unknown as { __pv: { abrir(n: string): void } }).__pv.abrir(n),
          PROCESSO_TJGO,
        );
        await page.waitForSelector('#cust-abrir');
        await page.locator('#cust-abrir').click();
        await page.waitForSelector('#cust-painel');
        await page.waitForFunction(
          () =>
            !document.querySelector('#cust-lista')?.textContent?.includes('Carregando'),
        );
      }
      async function conectar(): Promise<void> {
        const drive = amb!.app.drive!;
        const { url } = await drive.iniciarConexao(WS);
        const estado = new URL(url).searchParams.get('state') as string;
        const r = await drive.concluirConexao({ codigo: CODIGO_DO_GOOGLE, estado });
        if (!r.ok) throw new Error('conexão de teste falhou');
      }
      async function anexar(
        nome: string,
        mimeType: string,
        buffer: Buffer,
      ): Promise<void> {
        const [seletor] = await Promise.all([
          page.waitForEvent('filechooser'),
          page
            .getByRole('button', { name: /^Anexar comprovante/ })
            .first()
            .click(),
        ]);
        await seletor.setFiles({ name: nome, mimeType, buffer });
      }

      it('sem o Drive conectado: explica o caminho (Meus acessos) e leva até lá, sem erro técnico', async () => {
        await abrir();
        await amb!.app.custos.criar(WS, PROCESSO_TJGO, novo('Guia', 1_000));
        await painel();
        await page
          .getByRole('button', { name: /^Anexar comprovante/ })
          .first()
          .click();
        await page.waitForFunction(
          () =>
            (document.querySelector('#cust-comp-aviso') as HTMLElement).innerText.length >
            0,
        );
        expect(await page.locator('#cust-comp-aviso').innerText()).toContain(
          'Conecte o Google Drive em Meus acessos para anexar comprovantes.',
        );
        await page.getByRole('button', { name: 'Abrir Meus acessos' }).click();
        await page.waitForFunction(() =>
          document.querySelector('#nav-credenciais')?.classList.contains('ativo'),
        );
        expect(destino.chamadas).toEqual([]);
      });

      it('sem o recurso no plano, ou com o Drive desligado no servidor: a mesma explicação gentil', async () => {
        await abrir({ plano: 'acompanhamento' });
        await amb!.app.custos.criar(WS, PROCESSO_TJGO, novo('Guia', 1_000));
        await painel();
        await page
          .getByRole('button', { name: /^Anexar comprovante/ })
          .first()
          .click();
        await page.waitForFunction(
          () =>
            (document.querySelector('#cust-comp-aviso') as HTMLElement).innerText.length >
            0,
        );
        expect(await page.locator('#cust-comp-aviso').innerText()).toBe(
          'Anexar comprovantes ao Google Drive faz parte dos planos Peças e IA.',
        );
        await ctx!.close();
        await amb!.encerrar();
        await abrir({ semDrive: true });
        await amb!.app.custos.criar(WS, PROCESSO_TJGO, novo('Guia', 1_000));
        await painel();
        await page
          .getByRole('button', { name: /^Anexar comprovante/ })
          .first()
          .click();
        await page.waitForFunction(
          () =>
            (document.querySelector('#cust-comp-aviso') as HTMLElement).innerText.length >
            0,
        );
        expect(await page.locator('#cust-comp-aviso').innerText()).toBe(
          'O envio de comprovantes ao Google Drive não está ativado neste servidor.',
        );
      });

      it('anexa um PDF: contador, "Abrir no Drive" em nova aba, histórico — e remove só o vínculo', async () => {
        await abrir();
        await conectar();
        await amb!.app.custos.criar(WS, PROCESSO_TJGO, novo('Guia', 1_000));
        await painel();
        await anexar(
          'Guia 01.pdf',
          'application/pdf',
          Buffer.from(await pdfSintetico(1, 'G')),
        );
        await page.waitForSelector('.cust-comp');
        expect(await page.locator('#cust-comp-aviso').innerText()).toBe(
          'Comprovante anexado. O arquivo ficou no seu Google Drive.',
        );
        expect(await page.locator('.cust-comp-n').innerText()).toContain('1');
        expect(await page.locator('.cust-comp-nome').innerText()).toBe('Guia 01.pdf');
        const link = page.getByRole('link', { name: /Abrir no Drive/ });
        expect(await link.getAttribute('target')).toBe('_blank');
        expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(await link.getAttribute('href')).toMatch(
          /^https:\/\/drive\.google\.com\//,
        );
        // O arquivo está no Drive de mentira, na pasta Custos.
        expect(destino.envios).toHaveLength(1);

        await page.getByRole('button', { name: 'Histórico do lançamento' }).click();
        await page.waitForSelector('.cust-hist-lista');
        expect(await page.locator('.cust-hist-lista').innerText()).toContain(
          'Comprovante anexado',
        );
        await page.getByRole('button', { name: 'Fechar histórico' }).click();

        await page
          .getByRole('button', { name: /Remover comprovante: Guia 01.pdf/ })
          .click();
        expect(await page.locator('.cust-conf').first().innerText()).toContain(
          'O arquivo continua no seu Google Drive.',
        );
        // Voltar não remove.
        await page
          .locator('.cust-comp-lista')
          .getByRole('button', { name: 'Voltar' })
          .click();
        expect(await page.locator('.cust-comp-nome').count()).toBe(1);
        await page
          .getByRole('button', { name: /Remover comprovante: Guia 01.pdf/ })
          .click();
        await page.getByRole('button', { name: 'Remover vínculo' }).click();
        await page.waitForFunction(
          () => document.querySelectorAll('.cust-comp').length === 0,
        );
        expect(await page.locator('#cust-comp-aviso').innerText()).toBe(
          'Comprovante removido do lançamento. O arquivo continua no seu Google Drive.',
        );
        // O Drive não foi tocado pela remoção.
        expect(destino.envios[0]!.trashed).toBe(false);
        expect(destino.contar('enviarArquivo')).toBe(1);
      });

      it('recusa o que não é PDF/JPEG/PNG de verdade (o servidor confere os bytes) e o que passa de 5 MB — com frases claras', async () => {
        await abrir();
        await conectar();
        await amb!.app.custos.criar(WS, PROCESSO_TJGO, novo('Guia', 1_000));
        await painel();
        const recusado = (): Promise<unknown> =>
          page.waitForResponse(
            (r) => r.url().includes('/comprovantes') && r.status() === 415,
          );
        await Promise.all([
          recusado(),
          anexar(
            'recibo.pdf',
            'application/pdf',
            Buffer.from('MZ isto é um executável disfarçado'),
          ),
        ]);
        await page.waitForFunction(() =>
          (document.querySelector('#cust-comp-aviso') as HTMLElement).innerText.includes(
            'PDF',
          ),
        );
        expect(await page.locator('#cust-comp-aviso').innerText()).toBe(
          'Anexe um PDF, uma imagem JPEG ou uma imagem PNG.',
        );
        // PNG de mentira: o conteúdo é de um PDF, a extensão e o tipo dizem PNG.
        await Promise.all([
          recusado(),
          anexar('foto.png', 'image/png', Buffer.from(await pdfSintetico(1, 'X'))),
        ]);
        // Acima de 5 MB: a própria tela recusa antes de enviar (nenhum byte sai do navegador).
        await anexar(
          'enorme.pdf',
          'application/pdf',
          Buffer.alloc(5 * 1024 * 1024 + 1, 0x25),
        );
        await page.waitForFunction(() =>
          (document.querySelector('#cust-comp-aviso') as HTMLElement).innerText.includes(
            '5 MB',
          ),
        );
        expect(await page.locator('#cust-comp-aviso').innerText()).toBe(
          'O comprovante pode ter até 5 MB.',
        );
        expect(destino.contar('enviarArquivo')).toBe(0);
        expect(await page.locator('.cust-comp').count()).toBe(0);
      });

      it('JPEG e PNG entram; o 6º é recusado e o botão fica desabilitado', async () => {
        await abrir();
        await conectar();
        await amb!.app.custos.criar(WS, PROCESSO_TJGO, novo('Guia', 1_000));
        await painel();
        for (let i = 0; i < 5; i++) {
          await anexar(`c${i}.png`, 'image/png', Buffer.from(PNG_1X1));
          await page.waitForFunction(
            (n) => document.querySelectorAll('.cust-comp-lista li').length === n,
            i + 1,
          );
        }
        expect(await page.locator('.cust-comp-n').innerText()).toContain('5');
        const botao = page.getByRole('button', { name: /^Anexar comprovante/ }).first();
        expect(await botao.isDisabled()).toBe(true);
        // v0.49.1: o motivo mora na dica (aria-describedby), não mais em `title`.
        expect(
          await botao.evaluate(
            (el) => document.getElementById(el.getAttribute('aria-describedby')!)?.textContent,
          ),
        ).toContain('5 comprovantes');
      });

      it('Drive cheio: a frase é nossa, e nada fica anexado', async () => {
        await abrir();
        await conectar();
        await amb!.app.custos.criar(WS, PROCESSO_TJGO, novo('Guia', 1_000));
        await painel();
        const { DestinoSemEspacoError } =
          await import('../../src/domain/errors/index.js');
        destino.falhasDeEnvio = [new DestinoSemEspacoError()];
        await anexar('g.pdf', 'application/pdf', Buffer.from(await pdfSintetico(1, 'G')));
        await page.waitForFunction(() =>
          (document.querySelector('#cust-comp-aviso') as HTMLElement).innerText.includes(
            'sem espaço',
          ),
        );
        expect(await page.locator('#cust-comp-aviso').innerText()).toBe(
          'O seu Google Drive está sem espaço. Libere espaço e tente de novo.',
        );
        expect(await page.locator('.cust-comp').count()).toBe(0);
      });
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações na tela Custos (lista e cliente) e no painel com comprovantes (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        await abrir({ escuro });
        await massa();
        const drive = amb!.app.drive!;
        const { url } = await drive.iniciarConexao(WS);
        await drive.concluirConexao({
          codigo: CODIGO_DO_GOOGLE,
          estado: new URL(url).searchParams.get('state') as string,
        });
        await irParaCustos();
        const axe = async (raiz: string[][]): Promise<string[]> => {
          await page.addScriptTag({
            content: (AxeBuilder as unknown as { source: string }).source,
          });
          const r = await page.evaluate(
            (include) =>
              (window as unknown as AxeNaPagina).axe.run(
                { include } as unknown as Element,
                {
                  rules: { 'color-contrast': { enabled: true } },
                },
              ),
            raiz,
          );
          return r.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          );
        };
        expect(await axe([['#cc']])).toEqual([]);
        await page
          .getByRole('button', { name: /Abrir os processos de Cliente Azul/ })
          .click();
        await page.waitForSelector('#cc-tit-cliente');
        expect(await axe([['#cc']])).toEqual([]);

        await page.evaluate(
          (n) =>
            (window as unknown as { __pv: { abrir(n: string): void } }).__pv.abrir(n),
          PROCESSO_TJGO,
        );
        await page.waitForSelector('#cust-abrir');
        await page.locator('#cust-abrir').click();
        await page.waitForSelector('#cust-painel');
        const [seletor] = await Promise.all([
          page.waitForEvent('filechooser'),
          page
            .getByRole('button', { name: /^Anexar comprovante/ })
            .first()
            .click(),
        ]);
        await seletor.setFiles({
          name: 'a.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(await pdfSintetico(1, 'A')),
        });
        await page.waitForSelector('.cust-comp');
        await page.getByRole('button', { name: /Remover comprovante/ }).click();
        expect(await axe([['#cust-raiz'], ['.capa']].map((x) => x))).toEqual([]);
      });
    }

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${largura}px na tela Custos, no cliente e no painel com comprovante`, async () => {
        await abrir({ largura });
        await massa();
        await amb!.app.acompanhamento.rotular(
          WS,
          PROCESSO_TJGO,
          'Cliente com um nome bastante comprido para testar a quebra de linha ' +
            'X'.repeat(80),
        );
        const drive = amb!.app.drive!;
        const { url } = await drive.iniciarConexao(WS);
        await drive.concluirConexao({
          codigo: CODIGO_DO_GOOGLE,
          estado: new URL(url).searchParams.get('state') as string,
        });
        const sobra = async (): Promise<string[]> =>
          page.evaluate(() => {
            const cw = document.documentElement.clientWidth;
            const fora = Array.from(document.querySelectorAll('#conteudo *'))
              .filter((e) => e.getBoundingClientRect().right > cw + 1)
              .slice(0, 5)
              .map((e) => `${e.tagName}#${e.id}.${String(e.className)}`);
            return document.documentElement.scrollWidth > cw ? ['scroll', ...fora] : fora;
          });
        await irParaCustos();
        expect(await sobra()).toEqual([]);
        await page
          .getByRole('button', { name: /Abrir os processos de Cliente/ })
          .first()
          .click();
        await page.waitForSelector('#cc-tit-cliente');
        expect(await sobra()).toEqual([]);
        await page.evaluate(
          (n) =>
            (window as unknown as { __pv: { abrir(n: string): void } }).__pv.abrir(n),
          PROCESSO_TJGO,
        );
        await page.waitForSelector('#cust-abrir');
        await page.locator('#cust-abrir').click();
        await page.waitForSelector('#cust-painel');
        const [seletor] = await Promise.all([
          page.waitForEvent('filechooser'),
          page
            .getByRole('button', { name: /^Anexar comprovante/ })
            .first()
            .click(),
        ]);
        await seletor.setFiles({
          name: 'nome-muito-comprido-'.repeat(8) + '.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(await pdfSintetico(1, 'A')),
        });
        await page.waitForSelector('.cust-comp');
        expect(await sobra()).toEqual([]);
      });
    }

    it('regressão: Atualizações, Calendário e Meus processos continuam abrindo; o menu ativo acompanha a aba', async () => {
      await abrir();
      for (const aba of [
        'novidades',
        'processos',
        'calendario',
        'custos',
        'buscar',
        'vigilancia',
        'credenciais',
      ]) {
        await page.locator(`#nav-${aba}`).click();
        await page.waitForFunction(
          (a) => document.querySelector(`#nav-${a}`)?.classList.contains('ativo'),
          aba,
        );
        expect(await page.locator('#conteudo').innerText()).not.toContain(
          'ReferenceError',
        );
      }
      // Só a aba Custos fala com a API de custos por cliente.
      await page.locator('#nav-novidades').click();
      expect(await page.locator('#cc').count()).toBe(0);
    });
  },
);
