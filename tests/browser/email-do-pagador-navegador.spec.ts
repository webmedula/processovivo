/// <reference lib="dom" />
import AxeBuilder from 'axe-core';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHROMIUM } from './ambiente.js';
import {
  SENHA,
  configDePagamento,
  montarCenarioDePagamento,
  precificar,
} from '../helpers/pagamentos.js';
import type { CenarioDePagamento } from '../helpers/pagamentos.js';
import { construirServidor } from '../../src/main/http/servidor.js';

/*
 * v0.49.5 NUM NAVEGADOR: o e-mail de quem vai pagar no Mercado Pago é confirmado na tela (pré-preenchido com o da conta,
 * editável) e, com uma assinatura pendente, a conta ganha o aviso e o "Tentar de novo". Servidor e console reais,
 * gateway falso (sem rede), contas e e-mails sintéticos.
 */
const sem = CHROMIUM === undefined;
const CHECKOUT_FALSO = 'https://pagamento-falso.exemplo.invalid/**';
const EMAIL = 'ana@exemplo.test';
const EMAIL_DO_MP = 'ana.pagadora@exemplo.test';
interface AxeNaPagina {
  axe: {
    run(
      raiz: Element,
      o: object,
    ): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }>;
  };
}

describe.skipIf(sem)(
  'E-mail do pagador e nova tentativa, no navegador',
  { timeout: 90_000 },
  () => {
    let browser: Browser;
    let cenario: CenarioDePagamento;
    let ctx: BrowserContext;
    let page: Page;
    let url = '';
    const pedidosAoCheckout: string[] = [];

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

    async function subir(largura = 1280, escuro = false): Promise<void> {
      cenario = montarCenarioDePagamento({ comPagamento: true, comAssinaturas: true });
      const servidor = construirServidor(
        cenario.app,
        configDePagamento({ PROCESSOVIVO_TERMOS_URL: 'https://exemplo.test/termos' }),
      );
      await cenario.servidor.close();
      cenario = { ...cenario, servidor };
      await precificar(cenario, 'pecas', 4990);
      await servidor.listen({ host: '127.0.0.1', port: 0 });
      const addr = servidor.server.address();
      url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      ctx = await browser.newContext({
        viewport: { width: largura, height: 900 },
        colorScheme: escuro ? 'dark' : 'light',
      });
      await ctx.route(CHECKOUT_FALSO, (r) =>
        r.fulfill({ contentType: 'text/html', body: '<title>checkout falso</title>' }),
      );
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      pedidosAoCheckout.length = 0;
      page.on('request', (r) => {
        if (r.url().endsWith('/v1/assinatura/checkout'))
          pedidosAoCheckout.push(r.method());
      });
    }

    const painel = () => page.getByRole('group', { name: 'Confirmar assinatura' });
    const pendente = () =>
      page.getByRole('group', { name: 'Seu pagamento não foi concluído?' });
    const sobreRodagem = () =>
      page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

    /** Conta nova pelo link do site (`?plano=…&assinar=1`) até a confirmação. */
    async function abrirConfirmacao(): Promise<void> {
      await page.goto(`${url}/?plano=pecas&assinar=1&conta=1`);
      await page.fill('#c-nome', 'Pessoa Sintética');
      await page.fill('#c-email', EMAIL);
      await page.fill('#c-senha', SENHA);
      await page.click('#c-enviar');
      await painel().waitFor();
    }

    async function pagarCom(email: string): Promise<void> {
      await painel().getByLabel('E-mail para o pagamento').fill(email);
      await painel().getByRole('checkbox').check();
      await painel().getByRole('button', { name: 'Continuar para o pagamento' }).click();
      await page.waitForURL(/pagamento-falso\.exemplo\.invalid\/checkout\//);
    }

    /** Checkout feito e voltando à conta: a assinatura fica pendente ("processando"). */
    async function voltarComPendente(): Promise<void> {
      await page.goto(`${url}/?assinatura=retorno`);
      await pendente().waitFor();
    }

    it('o campo vem pré-preenchido com o e-mail da conta, com rótulo, ajuda e aceite dos Termos junto do botão', async () => {
      await subir();
      await abrirConfirmacao();
      const campo = painel().getByLabel('E-mail para o pagamento');
      expect(await campo.inputValue()).toBe(EMAIL);
      expect(await campo.getAttribute('type')).toBe('email');
      expect(await campo.getAttribute('required')).not.toBeNull();
      const ajuda = await page
        .locator(
          '#' + ((await campo.getAttribute('aria-describedby')) ?? '').split(' ')[0]!,
        )
        .innerText();
      expect(ajuda).toBe(
        // v0.49.6: o texto não sugere mais que é preciso ter conta no Mercado Pago.
        'Use o e-mail que você vai digitar na página de pagamento. Você não precisa ter conta no Mercado Pago para pagar com cartão. Se já tiver conta, use o e-mail dela.',
      );
      expect(await painel().getByRole('checkbox').isChecked()).toBe(false);
      expect(
        await painel()
          .getByRole('button', { name: 'Continuar para o pagamento' })
          .isDisabled(),
      ).toBe(true);
      // A frase antiga ("o e-mail dela pode ser diferente…") não existe mais.
      expect(await page.locator('body').innerText()).not.toContain(
        'pode ser diferente do e-mail',
      );
    });

    it('trocar o e-mail e pagar envia o novo valor ao gateway; a conta continua com o e-mail dela', async () => {
      await subir();
      await abrirConfirmacao();
      await pagarCom(EMAIL_DO_MP);
      expect(cenario.gateway.pedidos.map((p) => p.emailDoPagador)).toEqual([EMAIL_DO_MP]);
      expect((await cenario.app.usuarios.porEmail(EMAIL))!.usuario.email).toBe(EMAIL);
    });

    it('e-mail sem forma de e-mail: erro curto ligado ao campo por aria-describedby, foco no campo e NENHUM pedido', async () => {
      await subir();
      await abrirConfirmacao();
      const campo = painel().getByLabel('E-mail para o pagamento');
      await campo.fill('isto-nao-e-email');
      await painel().getByRole('checkbox').check();
      await painel().getByRole('button', { name: 'Continuar para o pagamento' }).click();
      const erro = page.locator('#pgto-email-erro');
      await erro.waitFor();
      expect(await erro.innerText()).toBe(
        'Informe um e-mail válido, como nome@exemplo.com.br.',
      );
      expect(await erro.getAttribute('role')).toBe('alert');
      expect(await campo.getAttribute('aria-invalid')).toBe('true');
      expect(await campo.getAttribute('aria-describedby')).toContain('pgto-email-erro');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pgto-email');
      // O texto digitado e o aceite sobrevivem ao redesenho.
      expect(await campo.inputValue()).toBe('isto-nao-e-email');
      expect(await painel().getByRole('checkbox').isChecked()).toBe(true);
      expect(pedidosAoCheckout).toEqual([]);
      expect(cenario.gateway.pedidos).toHaveLength(0);
      // Corrigir e seguir funciona.
      await campo.fill(EMAIL_DO_MP);
      await painel().getByRole('button', { name: 'Continuar para o pagamento' }).click();
      await page.waitForURL(/pagamento-falso/);
      expect(cenario.gateway.pedidos[0]!.emailDoPagador).toBe(EMAIL_DO_MP);
    });

    it('teclado: do e-mail ao aceite, ao link dos Termos e ao botão; Espaço marca; Enter no botão paga', async () => {
      await subir();
      await abrirConfirmacao();
      await painel().getByLabel('E-mail para o pagamento').focus();
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pgto-aceite');
      await page.keyboard.press('Space');
      expect(await painel().getByRole('checkbox').isChecked()).toBe(true);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('A');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        'pgto-continuar',
      );
      await page.keyboard.press('Enter');
      await page.waitForURL(/pagamento-falso/);
      expect(cenario.gateway.pedidos[0]!.emailDoPagador).toBe(EMAIL);
    });

    it('com assinatura pendente: aviso sem culpa, o mesmo campo e "Tentar de novo"; a tentativa SUBSTITUI a pendente', async () => {
      await subir();
      await abrirConfirmacao();
      await pagarCom('errado@exemplo.test');
      const primeira = (await cenario.app.pagamentos!.cobrancaDe(
        (await cenario.app.usuarios.porEmail(EMAIL))!.usuario.workspace,
      ))!;
      await voltarComPendente();
      expect(await page.locator('#pv-pagamento').innerText()).toContain(
        'Processando o pagamento',
      );
      expect(await pendente().innerText()).toContain(
        // v0.49.6: texto novo, sem "conta do Mercado Pago".
        'Se a página de pagamento avisou que o e-mail não corresponde, confirme abaixo o e-mail que você usou e tente de novo.',
      );
      // O mesmo campo, pré-preenchido com o e-mail da conta; sem lista de planos nem "Assinar" enquanto há pendente.
      const campo = pendente().getByLabel('E-mail para o pagamento');
      expect(await campo.inputValue()).toBe(EMAIL);
      expect(await page.locator('[data-assinar]').count()).toBe(0);
      // v0.49.6: o rótulo e a ajuda novos também aparecem no aviso da pendente.
      expect(await pendente().innerText()).toContain(
        'Você não precisa ter conta no Mercado Pago para pagar com cartão.',
      );
      expect(await pendente().innerText()).not.toContain('conta do Mercado Pago');
      const botao = pendente().getByRole('button', { name: 'Tentar de novo' });
      expect(await botao.isDisabled()).toBe(true);
      await campo.fill(EMAIL_DO_MP);
      await pendente().getByRole('checkbox').check();
      await botao.click();
      await page.waitForURL(
        /pagamento-falso\.exemplo\.invalid\/checkout\/fake-assinatura-2/,
      );
      expect(cenario.gateway.pedidos.map((p) => p.emailDoPagador)).toEqual([
        'errado@exemplo.test',
        EMAIL_DO_MP,
      ]);
      expect(cenario.gateway.cancelamentos).toEqual([primeira.gatewayId]);
    });

    it('o aviso da pendente não rouba o foco nem apaga o que a pessoa digita enquanto a tela confere sozinha', async () => {
      await subir();
      await abrirConfirmacao();
      await pagarCom('errado@exemplo.test');
      await voltarComPendente();
      const campo = pendente().getByLabel('E-mail para o pagamento');
      await campo.fill(EMAIL_DO_MP);
      await campo.focus();
      // A conferência automática (a cada 4 s) refaz a tela quando ninguém digita; com o foco no campo, espera.
      await page.waitForTimeout(4600);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pgto-email');
      expect(await campo.inputValue()).toBe(EMAIL_DO_MP);
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações na confirmação, com o erro do e-mail e no aviso da pendente (tema ${escuro ? 'escuro' : 'claro'})`, async () => {
        await subir(1280, escuro);
        await abrirConfirmacao();
        const axe = async (): Promise<string[]> => {
          await page.addScriptTag({
            content: (AxeBuilder as unknown as { source: string }).source,
          });
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(
              { include: [['#pv-pagamento']] } as unknown as Element,
              { rules: { 'color-contrast': { enabled: true } } },
            ),
          );
          return r.violations.map(
            (v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).join(' | ')}`,
          );
        };
        expect(await axe()).toEqual([]);
        await painel().getByLabel('E-mail para o pagamento').fill('xx');
        await painel().getByRole('checkbox').check();
        await painel()
          .getByRole('button', { name: 'Continuar para o pagamento' })
          .click();
        await page.locator('#pgto-email-erro').waitFor();
        expect(await axe()).toEqual([]);
        await painel().getByLabel('E-mail para o pagamento').fill('errado@exemplo.test');
        await painel()
          .getByRole('button', { name: 'Continuar para o pagamento' })
          .click();
        await page.waitForURL(/pagamento-falso/);
        await voltarComPendente();
        expect(await axe()).toEqual([]);
      });
    }

    for (const w of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${w}px na confirmação (com erro) e no aviso da pendente`, async () => {
        await subir(w);
        await abrirConfirmacao();
        await painel().getByLabel('E-mail para o pagamento').fill('x'.repeat(150));
        await painel().getByRole('checkbox').check();
        await painel()
          .getByRole('button', { name: 'Continuar para o pagamento' })
          .click();
        await page.locator('#pgto-email-erro').waitFor();
        expect(await sobreRodagem()).toBe(false);
        await painel().getByLabel('E-mail para o pagamento').fill(EMAIL_DO_MP);
        await painel()
          .getByRole('button', { name: 'Continuar para o pagamento' })
          .click();
        await page.waitForURL(/pagamento-falso/);
        await voltarComPendente();
        expect(await sobreRodagem()).toBe(false);
      });
    }
  },
);
