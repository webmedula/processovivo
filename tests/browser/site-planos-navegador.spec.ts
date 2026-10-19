/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHROMIUM } from './ambiente.js';

/*
 * O trecho de planos do SITE (`site/planos-v0.45.0.html`) NUM NAVEGADOR. O site e o app são simulados por
 * rotas do Playwright (nenhuma rede): o "site" é servido em https://site-exemplo.test e o app responde
 * em https://app.processovivo.com.br/v1/planos. Planos e textos sintéticos.
 */
const sem = CHROMIUM === undefined;
const CAMINHO = resolve(__dirname, '../../site/planos-v0.45.0.html');
const HTML = readFileSync(CAMINHO, 'utf8');
const SITE = 'https://site-exemplo.test';
const APP = 'https://app.processovivo.com.br';

const PLANOS = {
  pagamentoDisponivel: true,
  planos: [
    {
      slug: 'acompanhamento',
      nome: 'Acompanhamento',
      resumo: 'Consulta, carteira e vigilância.',
      recursos: ['Consulta', 'Acompanhamento'],
      preco: null,
      assinavel: false,
    },
    {
      slug: 'pecas',
      nome: 'Peças',
      resumo: 'Tudo do Acompanhamento, mais as peças.',
      recursos: ['Consulta', 'Peças do processo'],
      preco: { valorCentavos: 4990, ciclo: 'mensal' },
      assinavel: true,
    },
  ],
};

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

describe('trecho de planos do site — o arquivo', () => {
  it('é um arquivo só, sem dependência externa, e NUNCA põe dado da rede em HTML', () => {
    expect(HTML).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/,
    );
    expect(HTML).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|url\(/i);
    expect(HTML).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  it('a URL do app é UMA constante no topo do script', () => {
    expect(HTML.match(/https:\/\/app\.processovivo\.com\.br/g)).toHaveLength(1);
    expect(HTML).toMatch(/var APP_URL = 'https:\/\/app\.processovivo\.com\.br';/);
  });

  it('não traz o rodapé legal (e diz onde ele entra): sem CNPJ nem razão social escritos', () => {
    expect(HTML).toContain('RODAPÉ LEGAL ENTRA AQUI');
    expect(HTML).not.toMatch(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|CNPJ:|Ltda/i);
  });
});

describe.skipIf(sem)(
  'trecho de planos do site, no navegador',
  { timeout: 60_000 },
  () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    const dialogos: string[] = [];
    const cabecalhos: Array<Record<string, string>> = [];

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
    });

    type Resposta = (r: Route) => Promise<void> | void;

    async function abrir(
      resposta: Resposta,
      opcoes: { largura?: number; escuro?: boolean; relogio?: boolean } = {},
    ): Promise<void> {
      ctx = await browser.newContext({
        viewport: { width: opcoes.largura ?? 1280, height: 900 },
        colorScheme: opcoes.escuro ? 'dark' : 'light',
      });
      // Um cookie do app existe no navegador: o site NÃO pode mandá-lo.
      await ctx.addCookies([{ name: 'sessao', value: 'valor-sintetico', url: APP }]);
      await ctx.route(`${SITE}/**`, (r) =>
        r.fulfill({ contentType: 'text/html', body: HTML }),
      );
      await ctx.route(`${APP}/v1/planos`, async (r) => {
        cabecalhos.push(r.request().headers());
        await resposta(r);
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(10_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      page.on('dialog', async (d) => {
        dialogos.push(d.message());
        await d.dismiss();
      });
      dialogos.length = 0;
      cabecalhos.length = 0;
      if (opcoes.relogio) await page.clock.install();
      await page.goto(`${SITE}/planos`);
    }

    const ok =
      (corpo: unknown): Resposta =>
      (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': SITE },
          body: JSON.stringify(corpo),
        });

    const cartoes = () => page.locator('#pv-planos .pv-cartao');

    it('desenha um cartão por plano: nome, preço, ciclo, recursos; links certos para o app', async () => {
      await abrir(ok(PLANOS));
      await cartoes().first().waitFor();
      expect(await cartoes().count()).toBe(2);
      const sem = cartoes().nth(0);
      const com = cartoes().nth(1);

      expect(await com.locator('.pv-nome').innerText()).toBe('Peças');
      expect(await com.locator('.pv-preco').innerText()).toMatch(/R\$\s49,90\s+por mês/);
      expect(await com.locator('.pv-recursos li').allInnerTexts()).toEqual([
        'Consulta',
        'Peças do processo',
      ]);
      expect(
        await com
          .getByRole('link', { name: 'Testar 14 dias grátis' })
          .getAttribute('href'),
      ).toBe(`${APP}/?plano=pecas&conta=1`);
      expect(
        await com
          .getByRole('link', { name: 'Assinar agora o plano Peças' })
          .getAttribute('href'),
      ).toBe(`${APP}/?plano=pecas&assinar=1&conta=1`);
      expect(await com.innerText()).toContain(
        'Renovação automática. Você pode cancelar quando quiser.',
      );

      // Plano sem preço: sem valor inventado, sem "Assinar agora", e o teste abre sem plano (o app o ignoraria).
      expect(await sem.locator('.pv-preco').innerText()).toBe('Valor sob consulta');
      expect(await sem.getByRole('link', { name: /Assinar/ }).count()).toBe(0);
      expect(
        await sem
          .getByRole('link', { name: 'Testar 14 dias grátis' })
          .getAttribute('href'),
      ).toBe(`${APP}/?conta=1`);
      expect(await page.locator('#pv-planos-estado').isHidden()).toBe(true);
    });

    it('a requisição é um GET simples, sem cookie nem credencial do app', async () => {
      await abrir(ok(PLANOS));
      await cartoes().first().waitFor();
      expect(cabecalhos).toHaveLength(1);
      expect(cabecalhos[0]!['cookie']).toBeUndefined();
      expect(cabecalhos[0]!['authorization']).toBeUndefined();
      expect(cabecalhos[0]!['x-api-key']).toBeUndefined();
    });

    it('`pagamentoDisponivel=false`: só o teste grátis, nunca "Assinar agora"', async () => {
      await abrir(ok({ ...PLANOS, pagamentoDisponivel: false }));
      await cartoes().first().waitFor();
      expect(await page.getByRole('link', { name: /Assinar/ }).count()).toBe(0);
      expect(
        await page.getByRole('link', { name: 'Testar 14 dias grátis' }).count(),
      ).toBe(2);
      expect(await page.locator('#pv-planos').innerText()).not.toContain(
        'Renovação automática',
      );
    });

    it('plano com `assinavel=false` (mesmo com preço) não ganha "Assinar agora"', async () => {
      await abrir(
        ok({
          pagamentoDisponivel: true,
          planos: [{ ...PLANOS.planos[1], assinavel: false }],
        }),
      );
      await cartoes().first().waitFor();
      expect(await page.getByRole('link', { name: /Assinar/ }).count()).toBe(0);
    });

    it('falha de rede: mensagem neutra e UM botão "Testar grátis", sem preço', async () => {
      await abrir((r) => r.abort('failed'));
      const estado = page.locator('#pv-planos-estado');
      await page.getByRole('link', { name: 'Testar grátis' }).waitFor();
      expect(await estado.innerText()).toMatch(
        /Não foi possível carregar os planos agora/,
      );
      expect(await page.locator('#pv-planos a').count()).toBe(1);
      expect(
        await page.getByRole('link', { name: 'Testar grátis' }).getAttribute('href'),
      ).toBe(`${APP}/?conta=1`);
      expect(await page.locator('#pv-planos').innerText()).not.toContain('R$');
      expect(await cartoes().count()).toBe(0);
    });

    it('tempo esgotado: depois do limite curto cai na mesma mensagem neutra (relógio falso, sem espera real)', async () => {
      await abrir(() => new Promise<void>(() => undefined), { relogio: true });
      expect(await page.locator('#pv-planos-estado').innerText()).toContain('Carregando');
      await page.clock.runFor(8_100);
      await page.getByRole('link', { name: 'Testar grátis' }).waitFor();
      expect(await page.locator('#pv-planos a').count()).toBe(1);
      expect(await cartoes().count()).toBe(0);
    });

    for (const [nome, resposta] of [
      ['erro 500', (r: Route) => r.fulfill({ status: 500, body: 'erro' })],
      [
        'corpo que não é JSON',
        (r: Route) =>
          r.fulfill({
            status: 200,
            headers: { 'access-control-allow-origin': SITE },
            body: '<html>',
          }),
      ],
      ['lista vazia', ok({ pagamentoDisponivel: true, planos: [] })],
      ['formato inesperado', ok({ planos: 'x' })],
    ] as Array<[string, Resposta]>) {
      it(`${nome}: cai na mensagem neutra com um único botão`, async () => {
        await abrir(resposta);
        await page.getByRole('link', { name: 'Testar grátis' }).waitFor();
        expect(await page.locator('#pv-planos a').count()).toBe(1);
        expect(await page.locator('#pv-planos').innerText()).not.toContain('R$');
      });
    }

    it('dado malicioso da rede entra como TEXTO: nada é interpretado, nenhum diálogo, slug fora do formato é descartado', async () => {
      const malicioso = '<img src=x onerror=alert(1)><script>alert(2)</script>';
      await abrir(
        ok({
          pagamentoDisponivel: true,
          planos: [
            {
              ...PLANOS.planos[1],
              nome: malicioso,
              resumo: malicioso,
              recursos: [malicioso],
            },
            {
              ...PLANOS.planos[1],
              slug: '"><script>alert(3)</script>',
              nome: 'Descartado',
            },
            { ...PLANOS.planos[1], slug: 'javascript:alert(4)', nome: 'Descartado 2' },
            { ...PLANOS.planos[1], slug: 'a'.repeat(300), nome: 'Descartado 3' },
            {
              ...PLANOS.planos[1],
              slug: 'valor-torto',
              nome: 'Torto',
              preco: { valorCentavos: -5, ciclo: 'mensal' },
              assinavel: true,
            },
          ],
        }),
      );
      await cartoes().first().waitFor();
      expect(await cartoes().count()).toBe(2);
      expect(await cartoes().first().locator('.pv-nome').innerText()).toBe(malicioso);
      expect(await page.locator('#pv-planos img, #pv-planos script').count()).toBe(0);
      expect(await page.locator('#pv-planos').innerText()).not.toContain('Descartado');
      // Preço inválido não vira valor: o cartão "Torto" não tem R$ nem "Assinar agora".
      const torto = cartoes().nth(1);
      expect(await torto.innerText()).not.toContain('R$');
      expect(await torto.getByRole('link', { name: /Assinar/ }).count()).toBe(0);
      expect(dialogos).toEqual([]);
      const hrefs = await page
        .locator('#pv-planos a')
        .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      for (const h of hrefs)
        expect(h).toMatch(/^https:\/\/app\.processovivo\.com\.br\/\?/);
    });

    it('teclado: dá para chegar a cada link com Tab e o foco é VISÍVEL', async () => {
      await abrir(ok(PLANOS));
      await cartoes().first().waitFor();
      await page.keyboard.press('Tab');
      const foco = await page.evaluate(() => {
        const e = document.activeElement as HTMLElement;
        const s = getComputedStyle(e);
        return {
          tag: e.tagName,
          href: e.getAttribute('href'),
          contorno: s.outlineStyle,
          largura: s.outlineWidth,
        };
      });
      expect(foco.tag).toBe('A');
      expect(foco.contorno).not.toBe('none');
      expect(parseFloat(foco.largura)).toBeGreaterThanOrEqual(2);
      const alcancados = new Set<string>();
      alcancados.add(
        (await page.evaluate(() => document.activeElement?.getAttribute('href'))) ?? '',
      );
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press('Tab');
        alcancados.add(
          (await page.evaluate(() => document.activeElement?.getAttribute('href'))) ?? '',
        );
      }
      expect(alcancados.size).toBe(3);
    });

    for (const largura of [320, 390, 768, 1024, 1366, 1920]) {
      it(`sem rolagem horizontal em ${largura}px; alvos de 44px`, async () => {
        await abrir(ok(PLANOS), { largura });
        await cartoes().first().waitFor();
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        }));
        expect(m.sw).toBeLessThanOrEqual(m.cw);
        for (const caixa of await page
          .locator('#pv-planos .pv-botao')
          .evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height))) {
          expect(caixa).toBeGreaterThanOrEqual(44);
        }
      });
    }

    for (const escuro of [false, true]) {
      it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): planos e mensagem neutra`, async () => {
        for (const [nome, resposta] of [
          ['planos', ok(PLANOS)],
          ['falha', (r: Route) => r.abort('failed')],
        ] as Array<[string, Resposta]>) {
          await abrir(resposta, { escuro });
          await page
            .locator(nome === 'planos' ? '#pv-planos .pv-cartao' : '#pv-planos a')
            .first()
            .waitFor();
          await page.addScriptTag({
            content: (AxeBuilder as unknown as { source: string }).source,
          });
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(
              document.querySelector('#pv-planos')!,
              {
                rules: { 'color-contrast': { enabled: true } },
              },
            ),
          );
          expect(
            r.violations.map(
              (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
            ),
            nome,
          ).toEqual([]);
          await ctx.close();
        }
      });
    }
  },
);
