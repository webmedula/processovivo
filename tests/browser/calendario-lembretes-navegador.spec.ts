/// <reference lib="dom" />
import AxeBuilder from 'axe-core';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHROMIUM } from './ambiente.js';
import { NotificadorEspiao } from '../helpers/aplicacao.js';
import { SENHA, montarCenarioDePagamento } from '../helpers/pagamentos.js';
import type { CenarioDePagamento } from '../helpers/pagamentos.js';

/*
 * v0.51.0 NUM NAVEGADOR: no painel "Assinar no meu calendário", as opções de lembrete, o texto sobre o
 * Google Agenda e a opção do resumo por e-mail. Servidor e console reais, contas sintéticas, nenhum e-mail.
 */
const sem = CHROMIUM === undefined;
const EMAIL = 'ana@exemplo.test';
const GOOGLE =
  'O Google Agenda pode ignorá-los em calendários assinados por URL; se precisar, configure notificações dele em Configurações do calendário > Notificações.';
interface AxeNaPagina {
  axe: {
    run(
      raiz: Element,
      o: object,
    ): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }>;
  };
}

describe.skipIf(sem)(
  'Lembretes e resumo no painel do calendário, no navegador',
  { timeout: 90_000 },
  () => {
    let browser: Browser;
    let cenario: CenarioDePagamento;
    let ctx: BrowserContext;
    let page: Page;
    let url = '';
    const chamadas: Array<{ metodo: string; caminho: string; corpo: string }> = [];

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
      await cenario?.servidor.close();
    });

    async function subir(
      opcoes: { largura?: number; escuro?: boolean; resumo?: boolean } = {},
    ): Promise<void> {
      cenario = montarCenarioDePagamento({
        comPagamento: false,
        ...(opcoes.resumo === false
          ? {}
          : {
              resumoDoCalendario: {
                habilitado: true,
                notificador: new NotificadorEspiao(),
              },
            }),
      });
      await cenario.servidor.listen({ host: '127.0.0.1', port: 0 });
      const addr = cenario.servidor.server.address();
      url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      ctx = await browser.newContext({
        viewport: { width: opcoes.largura ?? 1280, height: 900 },
        colorScheme: opcoes.escuro ? 'dark' : 'light',
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      chamadas.length = 0;
      page.on('request', (r) => {
        if (r.url().includes('/v1/calendario/') && r.method() !== 'GET') {
          chamadas.push({
            metodo: r.method(),
            caminho: new URL(r.url()).pathname,
            corpo: r.postData() ?? '',
          });
        }
      });
    }

    /** Cadastra, entra e abre o painel "Assinar no meu calendário". */
    async function abrirPainel(): Promise<void> {
      await page.goto(url);
      await page.getByRole('tab', { name: 'Criar conta' }).click();
      await page.fill('#c-nome', 'Pessoa Sintética');
      await page.fill('#c-email', EMAIL);
      await page.fill('#c-senha', SENHA);
      await page.click('#c-enviar');
      await page.locator('#nav-calendario').click();
      await page.locator('#cal-assinar').click();
      await page.locator('#cal-lem-dia').waitFor();
    }

    const sobreRodagem = () =>
      page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

    it('mostra as opções (desmarcadas), o texto sobre o Google Agenda e o resumo (marcado por padrão)', async () => {
      await subir();
      await abrirPainel();
      expect(await page.locator('#cal-lem-dia').isChecked()).toBe(false);
      expect(await page.locator('#cal-lem-hora').isChecked()).toBe(false);
      expect(await page.locator('#cal-resumo').isChecked()).toBe(true);
      const nota = (await page.locator('#cal-lem-nota').textContent()) ?? '';
      expect(nota).toContain(
        'Apple Calendário e Outlook costumam mostrar estes lembretes.',
      );
      expect(nota).toContain(GOOGLE);
      expect(await page.locator('#cal-lem-nota').isVisible()).toBe(true);
      expect(await page.locator('.cal-lembretes legend').textContent()).toBe(
        'Lembretes nos eventos confirmados',
      );
      expect(await page.locator('.cal-resumo legend').textContent()).toBe(
        'Resumo por e-mail',
      );
    });

    it('sem a chave global do resumo (ou sem SMTP) a opção do resumo não aparece', async () => {
      await subir({ resumo: false });
      await abrirPainel();
      expect(await page.locator('#cal-resumo').count()).toBe(0);
      expect(await page.locator('#cal-lem-dia').count()).toBe(1);
    });

    it('teclado: Tab chega nas caixas e Espaço salva o lembrete (PATCH) — e a escolha sobrevive a recarregar', async () => {
      await subir();
      await abrirPainel();
      await page.locator('#cal-criar').click();
      await page.locator('#cal-url-i').waitFor();
      chamadas.length = 0;
      await page.locator('#cal-lem-dia').focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('cal-lem-hora');
      await page.keyboard.press('Space');
      await page.waitForFunction(() =>
        document.getElementById('cal-copiado')?.textContent?.includes('Lembretes salvos'),
      );
      const patches = chamadas.filter((c) => c.metodo === 'PATCH');
      expect(patches.length).toBe(2);
      expect(JSON.parse(patches[1]?.corpo ?? '{}')).toEqual({
        lembretes: { umDiaAntes: true, umaHoraAntes: true },
      });
      await page.reload();
      await page.locator('#nav-calendario').click();
      await page.locator('#cal-assinar').click();
      await page.locator('#cal-lem-dia').waitFor();
      expect(await page.locator('#cal-lem-dia').isChecked()).toBe(true);
      expect(await page.locator('#cal-lem-hora').isChecked()).toBe(true);
    });

    it('o resumo liga e desliga (PUT) e a escolha sobrevive a recarregar', async () => {
      await subir();
      await abrirPainel();
      chamadas.length = 0;
      await page.locator('#cal-resumo').uncheck();
      await page.waitForFunction(() =>
        document
          .getElementById('cal-resumo-nota')
          ?.textContent?.includes('Resumo desligado'),
      );
      expect(chamadas).toEqual([
        {
          metodo: 'PUT',
          caminho: '/v1/calendario/resumo',
          corpo: JSON.stringify({ ativo: false }),
        },
      ]);
      await page.reload();
      await page.locator('#nav-calendario').click();
      await page.locator('#cal-assinar').click();
      await page.locator('#cal-resumo').waitFor();
      expect(await page.locator('#cal-resumo').isChecked()).toBe(false);
    });

    it('antes de criar a URL, as escolhas de lembrete vão junto do POST que cria o feed', async () => {
      await subir();
      await abrirPainel();
      await page.locator('#cal-lem-hora').check();
      chamadas.length = 0;
      await page.locator('#cal-criar').click();
      await page.locator('#cal-url-i').waitFor();
      const post = chamadas.find((c) => c.metodo === 'POST');
      expect(JSON.parse(post?.corpo ?? '{}')).toMatchObject({
        lembretes: { umDiaAntes: false, umaHoraAntes: true },
      });
      expect(await page.locator('#cal-lem-hora').isChecked()).toBe(true);
    });

    it('o link do e-mail (?calendario=resumo) abre o Calendário com o painel e a opção, e some da barra', async () => {
      await subir();
      await abrirPainel();
      await page.goto(`${url}/?calendario=resumo`);
      await page.locator('#cal-resumo').waitFor();
      expect(await page.locator('#cal-resumo').isVisible()).toBe(true);
      expect(await page.evaluate(() => location.search)).toBe('');
      // Qualquer outro valor é ignorado: o console abre na tela de sempre.
      await page.goto(`${url}/?calendario=qualquer`);
      await page.locator('#nav-calendario').waitFor();
      expect(await page.locator('#cal-resumo').count()).toBe(0);
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações no painel, com e sem a URL criada (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        await subir({ escuro });
        await abrirPainel();
        const axe = async (): Promise<string[]> => {
          await page.addScriptTag({
            content: (AxeBuilder as unknown as { source: string }).source,
          });
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(
              { include: [['#cal-feed']] } as unknown as Element,
              { rules: { 'color-contrast': { enabled: true } } },
            ),
          );
          return r.violations.map(
            (v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).join(' | ')}`,
          );
        };
        expect(await axe()).toEqual([]);
        await page.locator('#cal-criar').click();
        await page.locator('#cal-url-i').waitFor();
        expect(await axe()).toEqual([]);
      });
    }

    for (const w of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${w}px com o painel aberto`, async () => {
        await subir({ largura: w });
        await abrirPainel();
        expect(await sobreRodagem()).toBe(false);
        await page.locator('#cal-criar').click();
        await page.locator('#cal-url-i').waitFor();
        expect(await sobreRodagem()).toBe(false);
      });
    }

    it('regressão: criar, regenerar e revogar a URL e a opção de sugestões seguem funcionando', async () => {
      await subir();
      await abrirPainel();
      page.on('dialog', (d) => void d.accept());
      await page.locator('#cal-sug').check();
      await page.locator('#cal-criar').click();
      await page.locator('#cal-url-i').waitFor();
      const primeira = await page.locator('#cal-url-i').inputValue();
      expect(primeira).toMatch(/\/calendario\/feed\/[A-Za-z0-9_-]{43}\.ics$/);
      await page.locator('#cal-regenerar').click();
      await page.waitForFunction((anterior) => {
        const i = document.getElementById('cal-url-i') as HTMLInputElement | null;
        return !!i && i.value !== anterior;
      }, primeira);
      await page.locator('#cal-revogar').click();
      await page.locator('#cal-criar').waitFor();
    });
  },
);
