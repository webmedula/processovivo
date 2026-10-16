/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHROMIUM } from './ambiente.js';
import {
  avisar,
  cadastrar,
  configDePagamento,
  montarCenarioDePagamento,
  precificar,
} from '../helpers/pagamentos.js';
import type { CenarioDePagamento } from '../helpers/pagamentos.js';
import { construirServidor } from '../../src/main/http/servidor.js';

/*
 * A tela "Assinatura online" (v0.44.0) NUM NAVEGADOR: o servidor e o console são os reais, o gateway é o
 * `GatewayFalso` (sem rede) e a conta é uma conta de verdade com e-mail (sintético). Nada espera tempo
 * real: o "processando" confere pelo botão ou pelo relógio falso do Playwright.
 */
const sem = CHROMIUM === undefined;
const CHECKOUT_FALSO = 'https://pagamento-falso.exemplo.invalid/**';

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

describe.skipIf(sem)('Assinatura online, no navegador', { timeout: 90_000 }, () => {
  let browser: Browser;
  let cenario: CenarioDePagamento;
  let ctx: BrowserContext;
  let page: Page;
  let url = '';
  let workspace = '';
  const dialogos: string[] = [];

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

  async function abrir(
    opcoes: {
      largura?: number;
      escuro?: boolean;
      comPagamento?: boolean;
      termos?: boolean;
      preco?: number | null;
      antes?: (c: CenarioDePagamento, ws: string) => Promise<void>;
      relogio?: boolean;
      caminho?: string;
    } = {},
  ): Promise<void> {
    cenario = montarCenarioDePagamento({ comPagamento: opcoes.comPagamento ?? true });
    // Servidor novo com a configuração do teste (Termos de Uso configurados, se pedido).
    const servidor = construirServidor(
      cenario.app,
      configDePagamento(
        opcoes.termos ? { PROCESSOVIVO_TERMOS_URL: 'https://exemplo.test/termos' } : {},
      ),
    );
    await cenario.servidor.close();
    cenario = { ...cenario, servidor };
    await precificar(cenario, 'pecas', opcoes.preco === undefined ? 4990 : opcoes.preco);
    // Plano sem preço: nunca ganha botão.
    await precificar(cenario, 'acompanhamento', null);
    const conta = await cadastrar(cenario, 'ana@exemplo.test');
    workspace = conta.workspace;
    await opcoes.antes?.(cenario, workspace);
    await servidor.listen({ host: '127.0.0.1', port: 0 });
    const addr = servidor.server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    ctx = await browser.newContext({
      viewport: { width: opcoes.largura ?? 1280, height: 900 },
      colorScheme: opcoes.escuro ? 'dark' : 'light',
    });
    const [nome, valor] = conta.cookie.split('=');
    await ctx.addCookies([{ name: nome!, value: valor!, url }]);
    // O "checkout" do gateway falso: uma página qualquer, sem rede.
    await ctx.route(CHECKOUT_FALSO, (r) =>
      r.fulfill({ contentType: 'text/html', body: '<title>checkout falso</title>' }),
    );
    page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e) => {
      throw e;
    });
    page.on('dialog', async (d) => {
      dialogos.push(d.message());
      await d.dismiss();
    });
    dialogos.length = 0;
    if (opcoes.relogio) await page.clock.install();
    await page.goto(url + (opcoes.caminho ?? '/'));
    await page.locator('#nav-conta').click();
  }

  const cartao = () => page.locator('#pv-pagamento .pgto');

  /** Põe a conta com renovação automática ativa, como o gateway diria (sem pular pelo navegador). */
  async function ativarRenovacao(): Promise<string> {
    const cob = (await cenario.app.pagamentos!.cobrancaDe(workspace))!;
    cenario.gateway.definirEstado(
      cob.gatewayId!,
      'autorizada',
      new Date('2026-11-20T12:00:00.000Z'),
    );
    cenario.gateway.registrarPagamento(
      cob.gatewayId!,
      {
        id: 'pg:900',
        pagamentoId: '900',
        resultado: 'aprovado',
        valorEmCentavos: 4990,
        meio: 'cartao',
      },
      '4455',
    );
    expect(
      (await avisar(cenario, { topico: 'subscription_authorized_payment', id: '4455' }))
        .statusCode,
    ).toBe(200);
    // O gateway também avisa da assinatura (próxima cobrança, estado): dois avisos, como na vida real.
    expect(
      (await avisar(cenario, { topico: 'subscription_preapproval', id: cob.gatewayId! }))
        .statusCode,
    ).toBe(200);
    return cob.gatewayId!;
  }

  it('mostra "Assinar" só no plano COM preço, com valor, ciclo, a frase da renovação e o aviso da conta do gateway', async () => {
    await abrir({ termos: true });
    await cartao().waitFor();

    expect(
      await cartao().getByRole('button', { name: 'Assinar o plano Peças' }).count(),
    ).toBe(1);
    // Sem preço, sem botão: nenhum outro plano ganha "Assinar".
    expect(
      await cartao()
        .getByRole('button', { name: /^Assinar/ })
        .count(),
    ).toBe(1);
    expect(await cartao().locator('.pgto-plano .tt').allInnerTexts()).toEqual(['Peças']);

    const texto = await cartao().innerText();
    expect(texto).toMatch(/R\$\s49,90 por mês/);
    expect(texto).toContain('Renovação automática. Você pode cancelar quando quiser.');
    expect(texto).toContain('conta de quem vai pagar');
    const termos = cartao().getByRole('link', { name: 'Termos de Uso' });
    expect(await termos.getAttribute('href')).toBe('https://exemplo.test/termos');
    expect(await termos.getAttribute('rel')).toContain('noopener');
    // Com o gateway falso, o cartão avisa que é TESTE.
    expect(texto).toContain('MODO DE TESTE');
    // Frase de prazo: nada de "prazo" aqui.
    expect(texto).not.toMatch(/prazo/i);
  });

  it('sem preço publicado em NENHUM plano, o cartão não oferece botão', async () => {
    await abrir({ preco: null });
    await cartao().waitFor();
    expect(
      await cartao()
        .getByRole('button', { name: /Assinar/ })
        .count(),
    ).toBe(0);
    expect(await cartao().innerText()).not.toContain('R$');
  });

  it('com a cobrança desligada, nada aparece na conta', async () => {
    await abrir({ comPagamento: false });
    await page.waitForSelector('#pv-pagamento', { state: 'attached' });
    // Sai e volta à conta esperando a resposta de /v1/assinatura, para o cartão já ter sido desenhado.
    await page.locator('#nav-processos').click();
    const resposta = page.waitForResponse((r) => r.url().endsWith('/v1/assinatura'));
    await page.locator('#nav-conta').click();
    await resposta;
    expect(await page.locator('#pv-pagamento').innerHTML()).toBe('');
    expect(await page.getByRole('button', { name: /Assinar/ }).count()).toBe(0);
  });

  it('clicar em "Assinar" cria o checkout e leva à página HOSPEDADA do gateway (o pedido leva só o código do plano)', async () => {
    await abrir();
    await cartao().waitFor();
    const pedido = page.waitForRequest(
      (r) => r.url().endsWith('/v1/assinatura/checkout') && r.method() === 'POST',
    );
    await cartao().getByRole('button', { name: 'Assinar o plano Peças' }).click();
    expect(JSON.parse((await pedido).postData() ?? '{}')).toEqual({ plano: 'pecas' });
    await page.waitForURL(
      /pagamento-falso\.exemplo\.invalid\/checkout\/fake-assinatura-1/,
    );
    expect(cenario.gateway.pedidos).toHaveLength(1);
    expect(cenario.gateway.pedidos[0]!.valorEmCentavos).toBe(4990);
    expect(dialogos).toEqual([]);
  });

  it('erro do servidor no checkout: frase fixa na tela, o botão volta e nada é redirecionado', async () => {
    await abrir();
    await cartao().waitFor();
    cenario.gateway.falharProximaChamada = 'indisponivel';
    await cartao().getByRole('button', { name: 'Assinar o plano Peças' }).click();
    const erro = page.locator('.pgto-erro[role="alert"]');
    await erro.waitFor();
    expect((await erro.innerText()).trim()).toBe(
      'Não foi possível concluir agora. Tente de novo em instantes.',
    );
    expect(page.url()).toContain(url);
    expect(
      await cartao().getByRole('button', { name: 'Assinar o plano Peças' }).isEnabled(),
    ).toBe(true);
  });

  it('o RETORNO do checkout abre a conta e mostra "processando" até o servidor confirmar (botão "Conferir agora")', async () => {
    await abrir({
      caminho: '/?assinatura=retorno',
      antes: async (c, ws) => {
        const conta = await c.app.usuarios.porWorkspace(ws);
        expect(conta).toBeDefined();
      },
    });
    // O retorno sozinho NÃO decide nada: sem checkout confirmado, a tela diz "processando".
    const status = page.locator('.pgto-estado[role="status"]');
    await status.waitFor();
    expect(await status.innerText()).toContain('Processando o pagamento');
    // O parâmetro saiu da barra de endereço.
    expect(new URL(page.url()).search).toBe('');
    expect(
      await cartao()
        .getByRole('button', { name: /^Assinar/ })
        .count(),
    ).toBe(0);
  });

  it('"processando" vira "ativa" quando o servidor confirma: pelo botão "Conferir agora"', async () => {
    await abrir({ caminho: '/?assinatura=retorno' });
    await page.locator('.pgto-estado').waitFor();
    // Cria o checkout de verdade pela API (a mesma que o botão usa) e confirma como o webhook faria.
    const r = await page.evaluate(async () => {
      const x = await fetch('/v1/assinatura/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plano: 'pecas' }),
      });
      return x.status;
    });
    expect(r).toBe(200);
    await ativarRenovacao();
    await cartao().getByRole('button', { name: 'Conferir agora' }).click();
    await page.getByText('Renovação automática ativa').waitFor();
    expect(await page.locator('.pgto-estado').count()).toBe(0);
    expect(await cartao().innerText()).toContain('Próxima cobrança em 20/11/2026');
    expect(await cartao().innerText()).toContain('Pagamento por cartão');
    // Com renovação ativa, não se oferece outra assinatura.
    expect(
      await cartao()
        .getByRole('button', { name: /^Assinar/ })
        .count(),
    ).toBe(0);
  });

  it('a tela confere SOZINHA enquanto processa (relógio falso, sem espera real)', async () => {
    await abrir({ caminho: '/?assinatura=retorno', relogio: true });
    await page.locator('.pgto-estado').waitFor();
    await page.evaluate(() =>
      fetch('/v1/assinatura/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plano: 'pecas' }),
      }),
    );
    await ativarRenovacao();
    await page.clock.runFor(4_100);
    await page.getByText('Renovação automática ativa').waitFor();
  });

  it('cancelar a renovação: confirmação NA tela (sem alert), foco certo, o plano segue e a mensagem diz até quando', async () => {
    await abrir({
      antes: async (c, ws) => {
        const conta = await c.app.usuarios.porWorkspace(ws);
        void conta;
      },
    });
    await cartao().waitFor();
    await page.evaluate(() =>
      fetch('/v1/assinatura/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plano: 'pecas' }),
      }),
    );
    await ativarRenovacao();
    await page.locator('#nav-processos').click();
    await page.locator('#nav-conta').click();
    await page.getByText('Renovação automática ativa').waitFor();

    // Confirmação na própria tela: o foco vai para "Sim", e "Voltar" devolve o foco ao botão.
    await page.getByRole('button', { name: 'Cancelar renovação automática' }).click();
    const grupo = page.getByRole('group', { name: /Confirmar o cancelamento/ });
    await grupo.waitFor();
    expect(await grupo.innerText()).toMatch(
      /Seu plano continua valendo até \d{2}\/\d{2}\/\d{4}/,
    );
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      'pgto-cancelar-sim',
    );
    await page.getByRole('button', { name: 'Voltar' }).click();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('pgto-cancelar');
    expect(cenario.gateway.cancelamentos).toHaveLength(0);

    await page.getByRole('button', { name: 'Cancelar renovação automática' }).click();
    await page.getByRole('button', { name: 'Sim, cancelar a renovação' }).click();
    await page.getByText('A renovação automática está encerrada').waitFor();
    expect(cenario.gateway.cancelamentos).toHaveLength(1);
    expect(await cartao().innerText()).toMatch(/Seu plano vale até \d{2}\/\d{2}\/\d{4}/);
    expect(dialogos).toEqual([]);
    // O plano segue valendo de verdade (servidor): a vigência não mudou.
    const a = (await cenario.app.repositorioAssinaturas.porWorkspace(workspace))!;
    expect(a.estaVigenteEm(cenario.relogio.agora)).toBe(true);
    // Encerrada, volta a oferecer "Assinar" para quem quiser voltar.
    expect(
      await cartao().getByRole('button', { name: 'Assinar o plano Peças' }).count(),
    ).toBe(1);
  });

  for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
    it(`sem rolagem horizontal em ${largura}px; alvos de toque de 44px no celular`, async () => {
      await abrir({ largura, termos: true });
      await cartao().waitFor();
      const medir = (): Promise<{ sw: number; cw: number }> =>
        page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        }));
      let m = await medir();
      expect(m.sw).toBeLessThanOrEqual(m.cw);

      const botao = cartao().getByRole('button', { name: 'Assinar o plano Peças' });
      const caixa = (await botao.boundingBox())!;
      expect(caixa.height).toBeGreaterThanOrEqual(44);

      await page.evaluate(() =>
        fetch('/v1/assinatura/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ plano: 'pecas' }),
        }),
      );
      await ativarRenovacao();
      await page.locator('#nav-processos').click();
      await page.locator('#nav-conta').click();
      await page.getByRole('button', { name: 'Cancelar renovação automática' }).click();
      m = await medir();
      expect(m.sw).toBeLessThanOrEqual(m.cw);
    });
  }

  for (const escuro of [false, true]) {
    it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): planos, processando, ativa e confirmação`, async () => {
      await abrir({ escuro, termos: true });
      await cartao().waitFor();
      await page.addScriptTag({
        content: (AxeBuilder as unknown as { source: string }).source,
      });
      const rodar = async (): Promise<string> => {
        const r = await page.evaluate(() =>
          (window as unknown as AxeNaPagina).axe.run(
            document.querySelector('#pv-pagamento')!,
            { rules: { 'color-contrast': { enabled: true } } },
          ),
        );
        return r.violations
          .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
          .join('\n');
      };
      expect(await rodar(), 'planos').toBe('');

      await page.evaluate(() =>
        fetch('/v1/assinatura/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ plano: 'pecas' }),
        }),
      );
      await page.locator('#nav-processos').click();
      await page.locator('#nav-conta').click();
      await page
        .locator('.pgto-estado')
        .waitFor()
        .catch(() => undefined);
      // "processando" só aparece com o retorno; sem ele o cartão volta aos planos. Confere as duas telas.
      expect(await rodar(), 'depois do checkout').toBe('');

      await ativarRenovacao();
      await page.locator('#nav-processos').click();
      await page.locator('#nav-conta').click();
      await page.getByText('Renovação automática ativa').waitFor();
      expect(await rodar(), 'ativa').toBe('');
      await page.getByRole('button', { name: 'Cancelar renovação automática' }).click();
      expect(await rodar(), 'confirmação').toBe('');
    });
  }

  it('axe no estado "processando" (retorno do checkout), tema claro e escuro', async () => {
    for (const escuro of [false, true]) {
      await abrir({ escuro, caminho: '/?assinatura=retorno' });
      await page.locator('.pgto-estado').waitFor();
      await page.addScriptTag({
        content: (AxeBuilder as unknown as { source: string }).source,
      });
      const r = await page.evaluate(() =>
        (window as unknown as AxeNaPagina).axe.run(
          document.querySelector('#pv-pagamento')!,
          {
            rules: { 'color-contrast': { enabled: true } },
          },
        ),
      );
      expect(
        r.violations.map((v) => v.id),
        escuro ? 'escuro' : 'claro',
      ).toEqual([]);
      await ctx.close();
      await cenario.servidor.close();
    }
  });
});
