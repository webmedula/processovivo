/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROCESSO_TJGO } from '../helpers/leitor.js';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';
import { DestinoFalso } from '../helpers/drive.js';
import {
  AutorizacaoDoDestinoRevogadaError,
  DestinoLimitouError,
  DestinoSemEspacoError,
} from '../../src/domain/errors/index.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { CODIGO_DO_GOOGLE } from '../helpers/transporteDoDrive.js';

/*
 * O envio ao Google Drive NUM NAVEGADOR (v0.42.0): o cartão em "Meus acessos" em cada estado, o
 * botão e o progresso na Pasta digital, cancelar, o resumo, o teclado, os temas, o axe, a
 * responsividade — e a regressão de que Atualizações e Calendário não mudaram nem falam com o
 * Drive. Servidor e console REAIS; o Google é um dublê em memória (nenhuma rede). Peças,
 * números e tokens são SINTÉTICOS (o repositório é público).
 */
const sem = CHROMIUM === undefined;
const WS = workspaceDaChave(CHAVE);

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

describe.skipIf(sem)('Google Drive — no navegador', { timeout: 90_000 }, () => {
  let browser: Browser;
  let amb: Ambiente | undefined;
  let ctx: BrowserContext | undefined;
  let page: Page;
  let destino: DestinoFalso;
  let requisicoesAoDrive: string[] = [];

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
    opcoes: {
      drive?: { plano?: string } | false;
      largura?: number;
      escuro?: boolean;
      aoProcesso?: boolean;
    } = {},
  ): Promise<void> {
    destino = new DestinoFalso();
    amb = await iniciar(
      opcoes.drive === false
        ? {}
        : {
            drive: {
              destino,
              ...(opcoes.drive?.plano ? { plano: opcoes.drive.plano } : {}),
            },
          },
    );
    ctx = await browser.newContext({
      viewport: { width: opcoes.largura ?? 1360, height: 900 },
      colorScheme: opcoes.escuro ? 'dark' : 'light',
      // A volta do Google é uma NAVEGAÇÃO: o teste a autentica pela chave, como o console faz.
      extraHTTPHeaders: { 'x-api-key': CHAVE },
    });
    await ctx.addInitScript((c) => {
      try {
        localStorage.setItem('processovivo.chave', c);
      } catch {
        /* sem armazenamento: o teste falharia adiante, com a causa à vista */
      }
    }, CHAVE);
    requisicoesAoDrive = [];
    page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    page.on('request', (r) => {
      if (r.url().includes('/v1/drive'))
        requisicoesAoDrive.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    page.on('pageerror', (e) => {
      throw e;
    });
    await page.goto(`${amb.url}/`);
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __pv?: { abrir?: unknown } }).__pv?.abrir ===
        'function',
    );
    if (opcoes.aoProcesso) {
      await page.evaluate(
        (n) => (window as unknown as { __pv: { abrir(n: string): void } }).__pv.abrir(n),
        PROCESSO_TJGO,
      );
      await page.waitForSelector('#pasta-abrir');
    }
  }

  /** Sem passar pela tela do Google: conecta pelo serviço, como se o retorno já tivesse voltado. */
  async function conectarPeloServico(): Promise<void> {
    const drive = amb?.app.drive;
    if (!drive) throw new Error('Drive não está ligado neste ambiente');
    const { url } = await drive.iniciarConexao(WS);
    const estado = new URL(url).searchParams.get('state') as string;
    const r = await drive.concluirConexao({
      workspace: WS,
      codigo: CODIGO_DO_GOOGLE,
      estado,
    });
    if (!r.ok) throw new Error(`conexão de teste falhou: ${r.motivo}`);
  }

  /** Guarda as peças (uma de cada vez: o clique da Pasta troca o pedido pendente). */
  async function guardar(ids: string[]): Promise<void> {
    const pasta = amb?.app.pasta;
    if (!pasta) throw new Error('Pasta digital não está ligada');
    for (const id of ids) {
      await pasta.solicitar(WS, PROCESSO_TJGO, id);
      await pasta.aguardarOciosa();
    }
  }

  /**
   * O operador tira "Salvar no Google Drive" do plano Peças pelo /admin: a conta segue com as
   * peças (e com "Meus acessos"), mas sem o recurso. É o caso real de "sem plano" para o Drive —
   * quem não tem Peças nem chega ao cartão.
   */
  async function tirarODriveDoPlano(): Promise<void> {
    await amb?.app.planos.atualizar('pecas', {
      recursos: ['consulta', 'acompanhamento', 'vigilancia', 'calendario', 'pecas'],
    });
  }

  async function abrirAcessos(): Promise<void> {
    await page.click('#nav-credenciais');
    await page.waitForSelector('#conteudo h2:has-text("Meus acessos")');
  }

  async function abrirPasta(): Promise<void> {
    await page.click('#pasta-abrir');
    await page.waitForSelector('#pasta .linha');
  }

  const texto = async (seletor: string): Promise<string> =>
    ((await page.locator(seletor).first().innerText()) ?? '').replace(/\s+/g, ' ').trim();

  async function esperarFimDoEnvio(): Promise<string> {
    await page.waitForSelector('#pdrive-fim');
    return texto('#pdrive-fim');
  }

  // -------------------------------------------------------------------------
  describe('recurso desligado', () => {
    it('nada aparece: sem cartão em "Meus acessos" e sem botão na Pasta', async () => {
      await abrir({ drive: false, aoProcesso: true });
      await abrirPasta();
      expect(await page.locator('#pasta-drive-bt').isVisible()).toBe(false);
      expect(await page.locator('#pasta-drive-bt').getAttribute('hidden')).not.toBeNull();
      await page.evaluate(() =>
        (window as unknown as { __processovivo_ir(a: string): void }).__processovivo_ir(
          'credenciais',
        ),
      );
      await page.waitForSelector('#conteudo h2:has-text("Meus acessos")');
      expect(await page.locator('.drive-cartao').count()).toBe(0);
      expect(await page.locator('#conteudo').innerText()).not.toContain('Google Drive');
    });
  });

  describe('o cartão em "Meus acessos"', () => {
    it('sem o recurso no plano: só o aviso fixo — sem botão de conectar e sem chamada ao Google', async () => {
      await abrir();
      await tirarODriveDoPlano();
      await abrirAcessos();
      await page.waitForSelector('#drive-sem-plano');
      expect(await texto('#drive-sem-plano')).toBe(
        'Salvar no Drive faz parte dos planos Peças e IA. Faça upgrade do plano para usar.',
      );
      expect(await page.locator('#drive-conectar').count()).toBe(0);
      expect(destino.chamadas).toEqual([]);
    });

    it('desconectado: botão "Conectar ao Google Drive" e a linha do que o sistema acessa', async () => {
      await abrir();
      await abrirAcessos();
      await page.waitForSelector('#drive-conectar');
      expect(await texto('#drive-conectar')).toBe('Conectar ao Google Drive');
      expect(await texto('#drive-cartao')).toContain(
        'só acessa a pasta que ele mesmo cria',
      );
      expect(destino.chamadas).toEqual([]);
    });

    it('conectar: vai ao Google, volta pelo retorno e mostra "conectado" — sem código nem state na barra de endereço', async () => {
      await abrir();
      await page.route('https://accounts.google.com/**', async (rota) => {
        const estado = new URL(rota.request().url()).searchParams.get('state') as string;
        await rota.fulfill({
          status: 302,
          headers: {
            location: `${amb?.url}/v1/drive/retorno?code=${CODIGO_DO_GOOGLE}&state=${encodeURIComponent(estado)}`,
          },
        });
      });
      await abrirAcessos();
      await page.click('#drive-conectar');
      await page.waitForSelector('#drive-abrir');
      expect(await texto('.drive-msg.ok')).toContain('Google Drive conectado');
      expect(await page.locator('#drive-abrir').getAttribute('href')).toMatch(
        /^https:\/\/drive\.google\.com\//,
      );
      expect(await page.locator('#drive-abrir').getAttribute('rel')).toContain(
        'noopener',
      );
      expect(page.url()).not.toContain('drive=');
      expect(page.url()).not.toContain('code=');
      expect(page.url()).not.toContain('state=');
      expect(await texto('#drive-cartao')).toContain('conectado');
    });

    it('o advogado cancelou no Google: mensagem curta e nada conectado', async () => {
      await abrir();
      await page.goto(`${amb?.url}/v1/drive/retorno?error=access_denied&state=inventado`);
      await page.waitForSelector('.drive-msg.falha');
      expect(await texto('.drive-msg.falha')).toContain('cancelada');
      expect(await page.locator('#drive-conectar').count()).toBe(1);
      expect(page.url()).not.toContain('motivo=');
    });

    it('conectado: "Abrir pasta no Drive" e "Desconectar" em dois passos, sem alert nem confirm', async () => {
      await abrir();
      await conectarPeloServico();
      await abrirAcessos();
      await page.waitForSelector('#drive-desconectar');
      let dialogo = false;
      page.on('dialog', (d) => {
        dialogo = true;
        void d.dismiss();
      });
      await page.click('#drive-desconectar');
      expect(await texto('#drive-conf')).toContain(
        'As peças já salvas continuam no seu Drive',
      );
      await page.click('#drive-desconectar-nao');
      expect(await page.locator('#drive-desconectar').count()).toBe(1);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        'drive-desconectar',
      );
      await page.click('#drive-desconectar');
      await page.click('#drive-desconectar-sim');
      await page.waitForSelector('#drive-conectar');
      expect(dialogo).toBe(false);
      expect(destino.contar('desconectar')).toBe(1);
    });

    it('precisa reconectar: texto claro e botão "Reconectar"', async () => {
      await abrir({ aoProcesso: true });
      // O token nasce JÁ vencido (relógio do dublê no passado) e a renovação volta `invalid_grant`.
      destino.agora = () => new Date(Date.now() - 2 * 3_600_000);
      await conectarPeloServico();
      destino.falhaNaRenovacao = new AutorizacaoDoDestinoRevogadaError('revogada', 'x');
      await amb?.app.drive?.iniciarEnvio({
        workspace: WS,
        numeroProcesso: PROCESSO_TJGO,
        pecas: ['p01'],
      });
      await amb?.app.drive?.aguardarOcioso();

      await abrirAcessos();
      await page.waitForSelector('#drive-reconectar-msg');
      expect(await texto('#drive-reconectar-msg')).toContain('expirou ou foi retirada');
      expect(await texto('#drive-conectar')).toBe('Reconectar');
      expect(await page.locator('#drive-abrir').count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('o botão na Pasta digital', () => {
    it('sem o recurso no plano: o clique mostra o aviso fixo e o Google não é chamado', async () => {
      await abrir({ aoProcesso: true });
      await tirarODriveDoPlano();
      await abrirPasta();
      await page.waitForSelector('#pasta-drive-bt:not([hidden])');
      await page.click('#pasta-drive-bt');
      expect(await texto('#pdrive-sem-plano')).toBe(
        'Salvar no Drive faz parte dos planos Peças e IA. Faça upgrade do plano para usar.',
      );
      expect(destino.chamadas).toEqual([]);
    });

    it('desconectado: o botão leva ao cartão de conexão', async () => {
      await abrir({ aoProcesso: true });
      await abrirPasta();
      await page.waitForSelector('#pasta-drive-bt:not([hidden])');
      await page.click('#pasta-drive-bt');
      await page.waitForSelector('#drive-conectar');
      expect(await page.locator('#pasta').count()).toBe(0);
      expect(destino.chamadas).toEqual([]);
    });

    it('o rótulo diz o número: "todas" sem seleção, "(N)" com seleção', async () => {
      await abrir({ aoProcesso: true });
      await conectarPeloServico();
      await abrirPasta();
      await page.waitForSelector('#pasta-drive-bt:not([hidden])');
      expect(await texto('#pasta-drive-bt')).toBe('Salvar todas no Drive');
      await page.locator('#pf-p01 [data-cx]').click();
      await page.locator('#pf-p02 [data-cx]').click();
      expect(await texto('#pasta-drive-bt')).toBe('Salvar no Drive (2)');
      await page.click('#pasta-nenhuma');
      expect(await texto('#pasta-drive-bt')).toBe('Salvar todas no Drive');
    });

    it('envia as marcadas: progresso, resumo "N enviadas" e "Abrir no Drive"; de novo, "já estavam"', async () => {
      await abrir({ aoProcesso: true });
      await conectarPeloServico();
      await guardar(['p01', 'p02']);
      await abrirPasta();
      await page.waitForSelector('#pasta-drive-bt:not([hidden])');
      await page.locator('#pf-p01 [data-cx]').click();
      await page.locator('#pf-p02 [data-cx]').click();
      await page.click('#pasta-drive-bt');
      const fim = await esperarFimDoEnvio();
      expect(fim).toContain('Envio concluído.');
      expect(fim).toContain('2 enviadas');
      expect(await page.locator('#pdrive-abrir').getAttribute('href')).toMatch(
        /^https:\/\/drive\.google\.com\//,
      );
      expect(destino.envios).toHaveLength(2);

      await page.click('#pasta-drive-bt');
      await page.waitForFunction(() =>
        document.querySelector('#pdrive-resumo')?.textContent?.includes('já estavam'),
      );
      expect(await texto('#pdrive-resumo')).toBe('2 já estavam');
      expect(destino.envios).toHaveLength(2);
    });

    it('sem seleção salva "todas": as sigilosas ficam de fora, e o que não veio do tribunal é dito', async () => {
      await abrir({ aoProcesso: true });
      await conectarPeloServico();
      // Todas guardadas, menos p10 (o tribunal lista e não entrega) e p11 (sigilosa).
      await guardar([
        'p01',
        'p02',
        'p03',
        'p04',
        'p05',
        'p06',
        'p07',
        'p08',
        'p09',
        'p12',
      ]);
      await abrirPasta();
      await page.waitForSelector('#pasta-drive-bt:not([hidden])');
      await page.click('#pasta-drive-bt');
      const fim = await esperarFimDoEnvio();
      expect(await texto('#pdrive-resumo')).toBe(
        '10 enviadas · 1 sigilosa ficou de fora · 1 falhou',
      );
      expect(fim).toContain('Peças sob sigilo não vão para o Drive.');
      expect(fim).toContain('1 peça não veio do tribunal');
      expect(destino.envios.some((e) => e.nome.includes('sigiloso'))).toBe(false);
      expect(await page.locator('#pdrive-repetir').count()).toBe(1);
    });

    it('cancelar: o envio para, o resumo diz que foi cancelado e o que foi enviado fica', async () => {
      await abrir({ aoProcesso: true });
      await conectarPeloServico();
      await guardar(['p01', 'p02', 'p03']);
      await abrirPasta();
      await page.waitForSelector('#pasta-drive-bt:not([hidden])');
      let liberar!: () => void;
      destino.segurarEnvio = new Promise<void>((r) => (liberar = r));
      await page.locator('#pf-p01 [data-cx]').click();
      await page.locator('#pf-p02 [data-cx]').click();
      await page.locator('#pf-p03 [data-cx]').click();
      await page.click('#pasta-drive-bt');
      await page.waitForSelector('#pdrive-cancelar');
      expect(await page.locator('#pasta-drive-bt').isDisabled()).toBe(true);
      await page.click('#pdrive-cancelar');
      liberar();
      const fim = await esperarFimDoEnvio();
      expect(fim).toContain('Envio cancelado.');
      expect(fim).toContain('O que já foi enviado continua no Drive.');
      expect(destino.envios.length).toBeLessThan(3);
      expect(await page.locator('#pasta-drive-bt').isDisabled()).toBe(false);
    });

    it('Drive cheio: mensagem própria, e o lote para', async () => {
      await abrir({ aoProcesso: true });
      await conectarPeloServico();
      await guardar(['p01', 'p02']);
      destino.falhasDeEnvio = [new DestinoSemEspacoError()];
      await abrirPasta();
      await page.waitForSelector('#pasta-drive-bt:not([hidden])');
      await page.locator('#pf-p01 [data-cx]').click();
      await page.locator('#pf-p02 [data-cx]').click();
      await page.click('#pasta-drive-bt');
      const fim = await esperarFimDoEnvio();
      expect(fim).toContain('O envio parou.');
      expect(fim).toContain('sem espaço');
      expect(await page.locator('#pdrive-repetir').count()).toBe(1);
    });

    it('limite de uso do Google: mensagem própria', async () => {
      await abrir({ aoProcesso: true });
      await conectarPeloServico();
      await guardar(['p01']);
      destino.falhasDeEnvio = [new DestinoLimitouError(3_600_000)];
      await abrirPasta();
      await page.waitForSelector('#pasta-drive-bt:not([hidden])');
      await page.locator('#pf-p01 [data-cx]').click();
      await page.click('#pasta-drive-bt');
      expect(await esperarFimDoEnvio()).toContain('O Google limitou o uso por agora');
    });

    it('autorização expirada no meio: mensagem própria e botão "Reconectar" que leva ao cartão', async () => {
      await abrir({ aoProcesso: true });
      destino.agora = () => new Date(Date.now() - 2 * 3_600_000);
      await conectarPeloServico();
      destino.falhaNaRenovacao = new AutorizacaoDoDestinoRevogadaError('revogada', 'x');
      await guardar(['p01']);
      await abrirPasta();
      await page.waitForSelector('#pasta-drive-bt:not([hidden])');
      await page.locator('#pf-p01 [data-cx]').click();
      await page.click('#pasta-drive-bt');
      expect(await esperarFimDoEnvio()).toContain(
        'A autorização do Google Drive expirou',
      );
      await page.click('#pdrive-reconectar');
      await page.waitForSelector('#drive-reconectar-msg');
    });

    it('teclado: Enter no botão envia, o foco acompanha o fim do envio e a região viva anuncia', async () => {
      await abrir({ aoProcesso: true });
      await conectarPeloServico();
      await guardar(['p01']);
      await abrirPasta();
      await page.waitForSelector('#pasta-drive-bt:not([hidden])');
      await page.locator('#pf-p01').focus();
      await page.keyboard.press('Space');
      await page.focus('#pasta-drive-bt');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#pdrive-cancelar');
      await page.focus('#pdrive-cancelar');
      await page.waitForSelector('#pdrive-fim');
      // O foco estava dentro da caixa: vai para o resumo, não se perde no <body>.
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pdrive-fim');
      const vivo = page.locator('#drive-vivo');
      expect(await vivo.getAttribute('aria-live')).toBe('polite');
      expect(await vivo.getAttribute('role')).toBe('status');
      expect(await vivo.innerText()).toContain('Envio concluído.');
      // O resumo tem "Fechar", e fechar devolve o foco ao botão.
      await page.keyboard.press('Tab');
      await page.click('#pdrive-fechar');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        'pasta-drive-bt',
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('temas, axe e responsividade', () => {
    for (const escuro of [false, true]) {
      it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): o cartão em cada estado e a Pasta com o resumo`, async () => {
        await abrir({ escuro, aoProcesso: true });
        const rodar = async (raiz: string): Promise<string> => {
          // O reload apaga o axe da página: injeta de novo quando faltar.
          if (!(await page.evaluate(() => 'axe' in window))) {
            await page.addScriptTag({
              content: (AxeBuilder as unknown as { source: string }).source,
            });
          }
          const r = await page.evaluate(
            (sel) =>
              (window as unknown as AxeNaPagina).axe.run(document.querySelector(sel)!, {
                rules: { 'color-contrast': { enabled: true } },
              }),
            raiz,
          );
          return r.violations
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
            .join('\n');
        };

        await page.evaluate(() =>
          (window as unknown as { __processovivo_ir(a: string): void }).__processovivo_ir(
            'credenciais',
          ),
        );
        await page.waitForSelector('#drive-conectar');
        expect(await rodar('#drive-cartao'), 'desconectado').toBe('');

        await conectarPeloServico();
        await page.reload();
        await page.waitForSelector('#nav-credenciais');
        await page.click('#nav-credenciais');
        await page.waitForSelector('#drive-desconectar');
        expect(await rodar('#drive-cartao'), 'conectado').toBe('');
        await page.click('#drive-desconectar');
        expect(await rodar('#drive-cartao'), 'confirmando').toBe('');

        await page.evaluate(
          (n) =>
            (window as unknown as { __pv: { abrir(n: string): void } }).__pv.abrir(n),
          PROCESSO_TJGO,
        );
        await page.waitForSelector('#pasta-abrir');
        await guardar(['p01']);
        await abrirPasta();
        await page.waitForSelector('#pasta-drive-bt:not([hidden])');
        await page.locator('#pf-p01 [data-cx]').click();
        await page.click('#pasta-drive-bt');
        await esperarFimDoEnvio();
        expect(await rodar('#pasta'), 'Pasta com o resumo').toBe('');
      });
    }

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal em ${largura}px: o cartão (conectado e confirmando) e a Pasta com o resumo`, async () => {
        await abrir({ largura, aoProcesso: true });
        const medir = () =>
          page.evaluate(() => ({
            sw: document.documentElement.scrollWidth,
            cw: document.documentElement.clientWidth,
          }));
        await conectarPeloServico();
        await guardar(['p01', 'p02']);
        await abrirPasta();
        await page.waitForSelector('#pasta-drive-bt:not([hidden])');
        await page.locator('#pf-p01 [data-cx]').click();
        await page.locator('#pf-p02 [data-cx]').click();
        await page.click('#pasta-drive-bt');
        await esperarFimDoEnvio();
        let m = await medir();
        expect(m.sw, 'Pasta').toBeLessThanOrEqual(m.cw);
        // O botão do Drive cabe na janela, quebrando de linha se preciso.
        const caixa = await page.locator('#pasta-drive-bt').boundingBox();
        expect((caixa?.x ?? 0) + (caixa?.width ?? 0)).toBeLessThanOrEqual(largura);
        await page.click('#pasta-fechar');
        await page.evaluate(() =>
          (window as unknown as { __processovivo_ir(a: string): void }).__processovivo_ir(
            'credenciais',
          ),
        );
        await page.waitForSelector('#drive-desconectar');
        m = await medir();
        expect(m.sw, 'cartão conectado').toBeLessThanOrEqual(m.cw);
        await page.click('#drive-desconectar');
        m = await medir();
        expect(m.sw, 'cartão confirmando').toBeLessThanOrEqual(m.cw);
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('regressão: o que NÃO mudou', () => {
    it('Atualizações e Calendário não pedem nada ao Drive nem mostram nada dele', async () => {
      await abrir();
      await conectarPeloServico();
      await page.reload();
      await page.waitForSelector('#nav-novidades');
      requisicoesAoDrive = [];
      for (const aba of [
        '#nav-novidades',
        '#nav-processos',
        '#nav-calendario',
        '#nav-buscar',
        '#nav-vigilancia',
      ]) {
        await page.click(aba);
        await page.waitForTimeout(150);
        expect(await page.locator('#conteudo').innerText(), aba).not.toContain('Drive');
        expect(await page.locator('.drive-cartao').count(), aba).toBe(0);
      }
      expect(requisicoesAoDrive).toEqual([]);
    });

    it('a Pasta digital segue com as ações de sempre, na ordem de sempre', async () => {
      await abrir({ aoProcesso: true });
      await abrirPasta();
      const botoes = await page.locator('#pasta .acoes button').allInnerTexts();
      expect(botoes.slice(0, 3)).toEqual(['Todas (11)', 'Nenhuma', 'Baixar PDF (0)']);
      expect(await texto('#pasta-montar')).toBe('Montar pasta completa');
      expect(await page.locator('#pasta-baixadas-bt').count()).toBe(1);
    });
  });
});
