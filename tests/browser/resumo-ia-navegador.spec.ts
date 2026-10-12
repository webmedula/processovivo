/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAVE, CHROMIUM, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';
import { PROCESSO_TJGO } from '../helpers/leitor.js';

/*
 * "Resumir este processo com IA" NUM NAVEGADOR (v0.40.1). O servidor e o console são os
 * reais; a rota do processo, a disponibilidade da IA e as rotas do resumo são simuladas com
 * dados SINTÉTICOS e o mesmo contrato da API (a API tem teste próprio em
 * tests/http/resumo-ia.spec.ts). Nenhuma chamada a modelo, nenhuma rede.
 */
const sem = CHROMIUM === undefined;
const DIA = 86_400_000;
const AGORA = Date.now();
const iso = (diasAtras: number): string =>
  new Date(AGORA - diasAtras * DIA).toISOString();

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}
interface Console_ {
  __pv?: { abrir(numero: string): void };
}

const TEXTO_INTIMACAO =
  'Intime-se a parte autora para que se manifeste sobre o laudo pericial juntado aos autos.';
const MOVS = [
  {
    data: iso(1),
    titulo: 'Intimação',
    conteudo: TEXTO_INTIMACAO,
    exigeAcao: true,
    fonte: 'djen',
  },
  {
    data: iso(8),
    titulo: 'Ato ordinatório',
    conteudo: 'Expeça-se ofício ao banco informado, que deverá responder em quinze dias.',
    fonte: 'djen',
  },
  {
    data: iso(40),
    titulo: 'Sentença',
    conteudo: 'Julgo parcialmente procedentes os pedidos formulados.',
    fonte: 'djen',
  },
];
const PROCESSO = {
  numero: PROCESSO_TJGO,
  tribunal: 'TJGO',
  classe: 'Procedimento Comum Cível',
  vara: '1ª Vara Cível',
  dataDistribuicao: iso(900),
  partes: [],
  movimentacoes: MOVS,
  procedencia: { provider: 'datajud+djen', consultadoEm: iso(0), deCache: false },
};

const ATO_1 = {
  chaveDoAto: 'chave-1',
  data: MOVS[0]!.data,
  rotulo: 'Intimação',
  tipoDaComunicacao: 'Intimação',
};
const ATO_2 = {
  chaveDoAto: 'chave-2',
  data: MOVS[1]!.data,
  rotulo: 'Ato ordinatório',
  tipoDaComunicacao: 'Intimação',
};
const RESULTADO = {
  estado: 'verificado',
  id: 'resumo-1',
  situacao: [
    {
      texto: 'A parte autora foi intimada a se pronunciar sobre o laudo pericial.',
      trecho: 'se manifeste sobre o laudo pericial',
      ato: ATO_1,
    },
    {
      texto: 'O juízo mandou oficiar o banco informado.',
      trecho: 'Expeça-se ofício ao banco informado',
      ato: ATO_2,
    },
  ],
  pendencias: [
    {
      texto: 'Parte autora: apresentar manifestação sobre o laudo',
      trecho: 'se manifeste sobre o laudo pericial',
      ato: ATO_1,
    },
  ],
  pontosDeAtencao: ['texto_incompleto'],
  contagens: {
    atosNoProcesso: 60,
    atosComTexto: 10,
    atosSoTitulo: 40,
    foraDoResumo: 10,
    itensDescartados: 2,
    providenciasDoSistema: 3,
    providenciasNaoCitadas: 2,
  },
  modelo: 'modelo/teste',
  versaoPrompt: 'resumo-1.0.0',
  provedor: 'provedor-teste',
  criadaEm: '2026-10-05T12:00:00.000Z',
  avaliacao: null,
};
const AVISO_FIXO =
  'Apoio à leitura, não substitui a leitura dos atos nem a contagem de prazo.';

describe.skipIf(sem)(
  'Resumir este processo com IA, no navegador',
  { timeout: 120_000 },
  () => {
    let browser: Browser;
    let amb: Ambiente;
    let ctx: BrowserContext;
    let page: Page;
    let pedidos: Array<{ metodo: string; url: string; temCorpo: boolean; tipo: string }>;
    let outrosPosts: string[];
    let avaliacoes: Array<{ id: string; corpo: unknown }>;
    let falhas: string[];
    let responder: (rota: Route) => Promise<void>;
    let avaliacaoFalha = false;
    /** Segura a rota das peças do tribunal até o teste soltar (força o redesenho da tela). */
    let liberarPecas: () => void;

    const json = (rota: Route, status: number, corpo: unknown): Promise<void> =>
      rota.fulfill({ status, json: corpo });

    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath: CHROMIUM as string,
        args: ['--no-sandbox'],
      });
      amb = await iniciar();
    });
    afterAll(async () => {
      await browser?.close();
      await amb?.encerrar();
    });
    afterEach(async () => {
      liberarPecas?.();
      await ctx?.close();
    });

    async function abrir(
      opcoes: {
        habilitada?: boolean;
        acompanhado?: boolean;
        largura?: number;
        escuro?: boolean;
        pecasReais?: boolean;
      } = {},
    ): Promise<void> {
      pedidos = [];
      outrosPosts = [];
      avaliacoes = [];
      falhas = [];
      avaliacaoFalha = false;
      // O portão existe desde já: soltar antes ou depois de o pedido chegar dá no mesmo.
      const portao = new Promise<void>((r) => (liberarPecas = r));
      responder = (rota) => json(rota, 200, RESULTADO);
      ctx = await browser.newContext({
        viewport: { width: opcoes.largura ?? 1280, height: 900 },
        colorScheme: opcoes.escuro ? 'dark' : 'light',
      });
      await ctx.addInitScript((c) => {
        try {
          localStorage.setItem('processovivo.chave', c);
        } catch {
          /* sem armazenamento: o teste falharia adiante, com a causa à vista */
        }
      }, CHAVE);
      await ctx.route('**/v1/analises/disponibilidade', (rota) =>
        json(rota, 200, { habilitada: opcoes.habilitada ?? true }),
      );
      if (opcoes.acompanhado ?? true) {
        await ctx.route(
          (u) => u.pathname === `/v1/acompanhamentos/${PROCESSO_TJGO}`,
          (rota) =>
            rota.request().method() === 'GET'
              ? json(rota, 200, { processo: PROCESSO, sincronizadoEm: iso(0) })
              : rota.fallback(),
        );
      } else {
        await ctx.route(
          (u) => u.pathname === `/v1/acompanhamentos/${PROCESSO_TJGO}`,
          (rota) =>
            rota.request().method() === 'GET'
              ? json(rota, 404, { erro: 'ACOMPANHAMENTO_NAO_ENCONTRADO', mensagem: 'x' })
              : rota.fallback(),
        );
      }
      // Sem a régua do tribunal, a linha do tempo é a do retrato (a que os testes conhecem);
      // com ela (`pecasReais`), o redesenho da tela acontece quando o teste soltar a resposta.
      await ctx.route('**/v1/processos/*/pecas', async (rota) => {
        if (!opcoes.pecasReais) return json(rota, 500, { erro: 'x', mensagem: 'x' });
        await portao;
        // Resposta sintética (a rota real do servidor está sujeita ao limite de requisições por
        // chave, que uma suíte inteira de navegador gasta): régua do tribunal, como no MNI.
        await json(rota, 200, {
          jaBaixadas: [],
          linhaDoTempo: {
            resumo: { espinha: 'tribunal', pecasAcopladas: 0 },
            eventos: MOVS,
            pecasSoltas: [],
          },
        });
      });
      await ctx.route('**/v1/acompanhamentos/*/resumo', async (rota) => {
        const req = rota.request();
        pedidos.push({
          metodo: req.method(),
          url: req.url(),
          temCorpo: req.postData() !== null,
          tipo: req.headers()['content-type'] ?? '',
        });
        await responder(rota);
      });
      await ctx.route('**/v1/resumos/*/avaliacao', async (rota) => {
        const id = rota.request().url().split('/v1/resumos/')[1]!.split('/')[0]!;
        avaliacoes.push({ id, corpo: rota.request().postDataJSON() as unknown });
        if (avaliacaoFalha) return json(rota, 500, { erro: 'x', mensagem: 'x' });
        const c = rota.request().postDataJSON() as { avaliacao: string };
        return json(rota, 200, { id, avaliacao: c.avaliacao });
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => {
        throw e;
      });
      page.on('requestfailed', (r) => falhas.push(r.url()));
      page.on('request', (r) => {
        if (
          r.method() === 'POST' &&
          !/\/resumo$|\/avaliacao$|marcar-vistas/.test(r.url())
        )
          outrosPosts.push(r.url());
      });
      const facetas = page.waitForResponse('**/v1/facetas');
      await page.goto(amb.url + '/');
      await page.waitForFunction(
        () => typeof (window as unknown as Console_).__pv?.abrir === 'function',
      );
      // A tela inicial termina de carregar ANTES de abrir o processo: abrir no meio da carga
      // deixa a resposta tardia dela pintar por cima (corrida que só aparece com a máquina ocupada).
      await facetas;
      await page.waitForFunction(() => {
        const c = document.getElementById('conteudo');
        return !!c && c.children.length > 0 && !c.querySelector('.gira, .nvt-esq');
      });
      await irAoProcesso();
    }

    async function irAoProcesso(): Promise<void> {
      await page.evaluate(
        (n) => (window as unknown as Console_).__pv!.abrir(n),
        PROCESSO_TJGO,
      );
      await page.waitForSelector('#conteudo .capa');
    }

    const botao = () => page.locator('#pvres-abrir');
    const painel = () => page.locator('#pvres-painel');
    const resumir = async (): Promise<void> => {
      await botao().click();
      await painel().getByText('Situação do processo').waitFor();
    };
    const SEM_PRAZO = (t: string): string =>
      t.replace(AVISO_FIXO, '').replace(/Conferir o prazo no processo\./g, '');

    it('IA desligada: nenhum botão na capa', async () => {
      await abrir({ habilitada: false });
      await page.waitForSelector('#parar');
      // Dá tempo de a pergunta de disponibilidade terminar.
      await page.waitForFunction(() => true);
      expect(await botao().count()).toBe(0);
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(
        'Resumir este processo com IA',
      );
    });

    it('processo que não é acompanhado (consulta avulsa): sem botão', async () => {
      await abrir({ acompanhado: false });
      await page.waitForSelector('#acompanhar');
      await page.waitForFunction(() => true);
      expect(await page.locator('#parar').count()).toBe(0);
      expect(await botao().count()).toBe(0);
    });

    it('processo acompanhado com a IA ligada: botão ao lado de "Deixar de acompanhar", fechado por padrão', async () => {
      await abrir();
      await botao().waitFor();
      expect(await botao().textContent()).toBe('Resumir este processo com IA');
      expect(await botao().getAttribute('aria-expanded')).toBe('false');
      expect(await botao().getAttribute('aria-controls')).toBe('pvres-painel');
      // Mesma fileira da capa, logo depois do "Deixar de acompanhar".
      expect(await botao().evaluate((e) => e.previousElementSibling?.id)).toBe('parar');
      expect(await painel().count()).toBe(0);
    });

    it('o pedido não leva corpo nem tipo de conteúdo: o texto é lido pelo servidor', async () => {
      await abrir();
      await resumir();
      expect(pedidos).toHaveLength(1);
      expect(pedidos[0]).toMatchObject({ metodo: 'POST', temCorpo: false, tipo: '' });
      expect(pedidos[0]!.url).toContain(
        `/v1/acompanhamentos/${encodeURIComponent(PROCESSO_TJGO.replace(/\D/g, ''))}/resumo`,
      );
    });

    it('resumindo: painel logo sob a capa, foco nele, aviso de até 2 minutos e Cancelar que aborta a requisição', async () => {
      await abrir();
      let solta: () => void = () => {};
      const segurar = new Promise<void>((r) => (solta = r));
      responder = async (rota) => {
        await segurar;
        await json(rota, 200, RESULTADO).catch(() => undefined);
      };
      await botao().click();
      await painel().waitFor();
      expect(
        await page
          .locator('#pvres-raiz')
          .evaluate((e) => e.previousElementSibling?.classList.contains('capa')),
      ).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pvres-painel');
      expect(await botao().getAttribute('aria-expanded')).toBe('true');
      expect(await painel().getAttribute('aria-busy')).toBe('true');
      expect(await painel().innerText()).toContain(
        'Resumindo o processo… isso pode levar até 2 minutos.',
      );
      await page.waitForFunction(() =>
        document.getElementById('pvres-live')?.textContent?.includes('2 minutos'),
      );

      await painel().getByRole('button', { name: 'Cancelar' }).click();
      await page.waitForFunction(() => !document.getElementById('pvres-painel'));
      expect(await botao().getAttribute('aria-expanded')).toBe('false');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pvres-abrir');
      await page.waitForFunction(
        () => document.getElementById('pvres-live')?.textContent === 'Resumo cancelado.',
      );
      solta();
      expect(falhas.some((u) => u.includes('/resumo'))).toBe(true);
    });

    it('resultado: situação com o ato de origem (rótulo, data, tipo) e o trecho citado, pendências em bloco próprio', async () => {
      await abrir();
      await resumir();
      const p = painel();
      expect(await p.getAttribute('aria-busy')).toBe('false');
      const itens = p.locator('section:has(h4:text("Situação do processo")) li');
      expect(await itens.count()).toBe(2);
      expect(await itens.nth(0).innerText()).toContain(
        'A parte autora foi intimada a se pronunciar sobre o laudo pericial.',
      );
      // Rótulo e data vêm do retrato; o tipo só aparece quando é diferente do rótulo.
      const ato1 = itens.nth(0).getByRole('button');
      expect(await ato1.textContent()).toMatch(/^Intimação · \d{2}\/\d{2}\/\d{4}$/);
      expect(await itens.nth(1).getByRole('button').textContent()).toMatch(
        /^Ato ordinatório · \d{2}\/\d{2}\/\d{4} · Intimação$/,
      );
      expect(await itens.nth(0).locator('mark').textContent()).toBe(
        'se manifeste sobre o laudo pericial',
      );
      const pend = p.locator('.pvres-pend');
      expect(await pend.locator('h4').textContent()).toBe('Pendências segundo a IA');
      expect(await pend.locator('li').count()).toBe(1);
      expect(await pend.innerText()).toContain(
        'Parte autora: apresentar manifestação sobre o laudo',
      );
      expect(await pend.innerText()).toContain('bloco “Pede providência” do sistema');
    });

    it('o bloco "Pede providência" do sistema não muda com o resumo', async () => {
      await abrir();
      const bloco = page.locator('#conteudo .cartao.alerta');
      await bloco.waitFor();
      const antes = await bloco.innerHTML();
      await resumir();
      expect(await bloco.count()).toBe(1);
      expect(await bloco.innerHTML()).toBe(antes);
      expect(await painel().locator('.alerta').count()).toBe(0);
    });

    it('diz quantos atos o sistema marca como pedem providência e a IA não citou, o que ficou de fora e quantos itens foram descartados', async () => {
      await abrir();
      await resumir();
      const t = await painel().innerText();
      expect(t).toContain(
        'O sistema marca 3 atos como pedem providência; 2 não foram citados neste resumo.',
      );
      expect(t).toContain(
        'Lidos com texto: 10. Só pelo título: 40. Ficaram de fora do resumo: 10.',
      );
      expect(t).toContain(
        'Itens descartados na verificação: 2 (o texto deles não é mostrado).',
      );
    });

    it('com todas as providências citadas, a frase muda; sem nenhuma marcada, também', async () => {
      await abrir();
      responder = (rota) =>
        json(rota, 200, {
          ...RESULTADO,
          contagens: {
            ...RESULTADO.contagens,
            providenciasDoSistema: 1,
            providenciasNaoCitadas: 0,
            itensDescartados: 0,
          },
        });
      await resumir();
      expect(await painel().innerText()).toContain(
        'O sistema marca 1 ato como pedem providência, e ele foi citado neste resumo.',
      );
      await painel().getByRole('button', { name: 'Fechar' }).click();
      responder = (rota) =>
        json(rota, 200, {
          ...RESULTADO,
          pendencias: [],
          contagens: {
            ...RESULTADO.contagens,
            providenciasDoSistema: 0,
            providenciasNaoCitadas: 0,
          },
        });
      await resumir();
      const t = await painel().innerText();
      expect(t).toContain(
        'O sistema não marca nenhum ato como pede providência neste momento.',
      );
      expect(t).toContain('A IA não indicou pendências nos atos lidos.');
    });

    it('rodapé com data e hora e sem o nome do modelo; aviso fixo; pontos de atenção; nenhuma palavra "prazo" fora dos avisos fixos', async () => {
      await abrir();
      await resumir();
      const t = await painel().innerText();
      expect(t).toMatch(/Gerado por IA em .+\. Confira nos atos\./);
      expect(t).not.toContain('modelo/teste');
      expect(t).not.toContain('provedor-teste');
      expect(t).toContain(AVISO_FIXO);
      expect(t).toContain('O texto de um ato pode estar incompleto.');
      expect(SEM_PRAZO(t)).not.toMatch(/prazo/i);
    });

    it('nada é criado: nenhum pedido além do resumo e da avaliação', async () => {
      await abrir();
      await resumir();
      await painel().getByRole('button', { name: 'Útil' }).click();
      await page.getByText('✓ Avaliação registrada.').waitFor();
      expect(outrosPosts).toEqual([]);
      expect(
        await painel()
          .getByRole('button', { name: /aviso|calendário|criar/i })
          .count(),
      ).toBe(0);
    });

    it('o link do ato leva à linha do tempo: rola, destaca e põe o foco no andamento', async () => {
      await abrir();
      await resumir();
      await painel().locator('.pvres-ato button').first().click();
      const alvo = page.locator('.ev.pvres-alvo');
      await alvo.waitFor();
      expect(await alvo.locator('.tt').first().textContent()).toContain('Intimação');
      expect(await alvo.getAttribute('data-quando')).toBe(MOVS[0]!.data);
      expect(
        await page.evaluate(() => document.activeElement?.classList.contains('ev')),
      ).toBe(true);
      // Sair do andamento tira o destaque.
      await page.keyboard.press('Tab');
      await page.waitForFunction(
        () => document.querySelectorAll('.ev.pvres-alvo').length === 0,
      );
    });

    it('ato que não está na linha do tempo (recolhido ou filtrado): a tela diz isso em vez de rolar para lugar nenhum', async () => {
      await abrir();
      responder = (rota) =>
        json(rota, 200, {
          ...RESULTADO,
          situacao: [
            {
              ...RESULTADO.situacao[0]!,
              ato: { ...ATO_1, data: iso(300), rotulo: 'Despacho antigo' },
            },
          ],
        });
      await resumir();
      await painel().locator('.pvres-ato button').first().click();
      await page.waitForFunction(() =>
        /não está visível na linha do tempo/.test(
          document.getElementById('pvres-nota-ato')?.textContent ?? '',
        ),
      );
      expect(await page.locator('.ev.pvres-alvo').count()).toBe(0);
    });

    it('avaliação: três botões, confirmação visível, dá para corrigir; sem texto livre', async () => {
      await abrir();
      await resumir();
      const p = painel();
      expect(
        await p.getByRole('button', { name: /^(Útil|Errado|Perigoso)$/ }).count(),
      ).toBe(3);
      expect(await p.locator('textarea, input[type="text"]').count()).toBe(0);
      await p.getByRole('button', { name: 'Útil' }).click();
      await p.getByText('✓ Avaliação registrada.').waitFor();
      expect(
        await p.getByRole('button', { name: 'Útil' }).getAttribute('aria-pressed'),
      ).toBe('true');
      await p.getByRole('button', { name: 'Perigoso' }).click();
      await page.waitForFunction(
        () =>
          document.getElementById('pvres-av-perigoso')?.getAttribute('aria-pressed') ===
          'true',
      );
      expect(avaliacoes).toEqual([
        { id: 'resumo-1', corpo: { avaliacao: 'util' } },
        { id: 'resumo-1', corpo: { avaliacao: 'perigoso' } },
      ]);
      expect(
        await p.getByRole('button', { name: 'Útil' }).getAttribute('aria-pressed'),
      ).toBe('false');
      // O foco continua no botão que a pessoa acabou de usar.
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        'pvres-av-perigoso',
      );
    });

    it('falha ao gravar a avaliação: diz isso, sem fingir que gravou', async () => {
      await abrir();
      await resumir();
      avaliacaoFalha = true;
      await painel().getByRole('button', { name: 'Errado' }).click();
      await painel().getByText('Não foi possível registrar. Tente de novo.').waitFor();
      expect(
        await painel()
          .getByRole('button', { name: 'Errado' })
          .getAttribute('aria-pressed'),
      ).toBe('false');
    });

    const ESTADOS: Array<{
      nome: string;
      status: number;
      corpo: unknown;
      texto: string;
    }> = [
      {
        nome: 'não verificado',
        status: 200,
        corpo: {
          ...RESULTADO,
          estado: 'nao_verificado',
          situacao: [],
          pendencias: [],
          pontosDeAtencao: [],
        },
        texto: 'Não foi possível resumir com segurança. Leia os atos.',
      },
      {
        nome: 'erro do modelo',
        status: 200,
        corpo: { estado: 'erro' },
        texto: 'Não foi possível resumir agora. Tente de novo em alguns minutos.',
      },
      {
        nome: 'erro inesperado do servidor',
        status: 500,
        corpo: { erro: 'x', mensagem: 'texto do servidor que não deve aparecer' },
        texto: 'Não foi possível resumir agora. Tente de novo em alguns minutos.',
      },
      {
        nome: 'processo que a conta não acompanha',
        status: 404,
        corpo: { erro: 'ACOMPANHAMENTO_NAO_ENCONTRADO', mensagem: 'x' },
        texto: 'Este processo não está entre os que você acompanha.',
      },
      ...(
        [
          [
            'sem_plano',
            403,
            'O resumo por IA faz parte do plano IA. Faça upgrade do plano para usar.',
          ],
          [
            'segredo_de_justica',
            403,
            'Processo em segredo de justiça: o resumo por IA não é feito. Leia os atos.',
          ],
          [
            'texto_insuficiente',
            422,
            'Este processo não tem atos com texto suficiente para resumir. Leia os atos.',
          ],
          [
            'limite_de_uso',
            429,
            'Há muitos resumos em andamento ou o limite por hora foi atingido. Tente novamente em instantes.',
          ],
        ] as const
      ).map(([motivo, status, texto]) => ({
        nome: `recusa: ${motivo}`,
        status,
        corpo: {
          erro: 'ENTRADA_NAO_ANALISAVEL',
          mensagem: 'texto do servidor',
          detalhes: { motivo },
        },
        texto,
      })),
    ];

    for (const e of ESTADOS) {
      it(`estado "${e.nome}": frase fixa, sem avaliação nem citação, só o aviso fixo fala em prazo`, async () => {
        await abrir();
        responder = (rota) => json(rota, e.status, e.corpo);
        await botao().click();
        const p = painel();
        await p.getByText(e.texto, { exact: true }).waitFor();
        expect(await p.getAttribute('aria-busy')).toBe('false');
        expect(await p.getByRole('button', { name: 'Útil' }).count()).toBe(0);
        expect(await p.locator('mark, li').count()).toBe(0);
        const t = await p.innerText();
        expect(t).not.toContain('texto do servidor');
        expect(t).toContain(AVISO_FIXO);
        expect(SEM_PRAZO(t)).not.toMatch(/prazo/i);
        await page.waitForFunction(
          (frase) => document.getElementById('pvres-live')?.textContent === frase,
          e.texto,
        );
      });
    }

    it('"Tentar de novo" depois do erro faz outro pedido', async () => {
      await abrir();
      responder = (rota) => json(rota, 200, { estado: 'erro' });
      await botao().click();
      await painel().getByText('Não foi possível resumir agora.').waitFor();
      responder = (rota) => json(rota, 200, RESULTADO);
      await painel().getByRole('button', { name: 'Tentar de novo' }).click();
      await painel().getByText('Situação do processo').waitFor();
      expect(pedidos).toHaveLength(2);
    });

    it('teclado: Enter abre, Tab percorre o painel, Esc fecha e devolve o foco ao botão', async () => {
      await abrir();
      await botao().focus();
      await page.keyboard.press('Enter');
      await painel().getByText('Situação do processo').waitFor();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pvres-painel');
      const visitados: string[] = [];
      for (let i = 0; i < 7; i++) {
        await page.keyboard.press('Tab');
        visitados.push(
          await page.evaluate(
            () =>
              (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? '',
          ),
        );
      }
      expect(visitados.slice(0, 1)).toEqual(['Fechar']);
      expect(visitados.slice(1, 4).every((v) => /\d{2}\/\d{2}\/\d{4}/.test(v))).toBe(
        true,
      );
      expect(visitados.slice(4)).toEqual(['Útil', 'Errado', 'Perigoso']);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('pvres-painel'));
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pvres-abrir');
      expect(await botao().getAttribute('aria-expanded')).toBe('false');
    });

    it('Esc durante o resumo cancela', async () => {
      await abrir();
      responder = () => new Promise<void>(() => undefined);
      await botao().click();
      await painel().waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('pvres-painel'));
      await page.waitForFunction(
        () => document.getElementById('pvres-live')?.textContent === 'Resumo cancelado.',
      );
    });

    it('não há reabrir: voltar e abrir o processo de novo começa sem resumo', async () => {
      await abrir();
      await resumir();
      await page.click('#voltar');
      await page.waitForFunction(() => !document.getElementById('pvres-raiz'));
      await irAoProcesso();
      await botao().waitFor();
      expect(await painel().count()).toBe(0);
      expect(await botao().getAttribute('aria-expanded')).toBe('false');
      expect(pedidos).toHaveLength(1);
    });

    it('a tela do processo é redesenhada com o resumo em curso (régua do tribunal): o painel e o resultado voltam', async () => {
      await abrir({ pecasReais: true });
      let solta: () => void = () => {};
      const segurar = new Promise<void>((r) => (solta = r));
      responder = async (rota) => {
        await segurar;
        await json(rota, 200, RESULTADO).catch(() => undefined);
      };
      await botao().click();
      await painel().waitFor();
      expect(await painel().innerText()).toContain('Resumindo o processo');
      // O tribunal responde e a tela inteira é redesenhada por cima: marca o botão antigo para provar.
      await page.evaluate(() =>
        document.getElementById('parar')!.setAttribute('data-antigo', '1'),
      );
      liberarPecas();
      await page.waitForFunction(() => {
        const parar = document.getElementById('parar');
        return !!parar && !parar.hasAttribute('data-antigo');
      });
      await page.waitForFunction(
        () =>
          document.querySelectorAll('#pvres-abrir').length === 1 &&
          !!document.getElementById('pvres-painel'),
      );
      expect(await page.locator('#pvres-painel').count()).toBe(1);
      expect(await botao().getAttribute('aria-expanded')).toBe('true');
      solta();
      await painel().getByText('Situação do processo').waitFor();
      expect(pedidos).toHaveLength(1);
    });

    for (const largura of [1920, 1366, 1280, 1024, 768, 390]) {
      it(`sem rolagem horizontal da página com o resumo aberto em ${largura} px`, async () => {
        await abrir({ largura });
        await resumir();
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          iw: window.innerWidth,
          painel: document.getElementById('pvres-painel')!.getBoundingClientRect().right,
        }));
        expect(m.sw).toBeLessThanOrEqual(m.iw);
        expect(m.painel).toBeLessThanOrEqual(m.iw);
      });
    }

    for (const escuro of [false, true]) {
      it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): botão, resumindo, resultado, avaliado, recusa`, async () => {
        await abrir({ escuro });
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        // Só o que esta versão acrescenta: a capa (com o botão novo) e o painel. O "voltar" da
        // página e o resto do console têm a própria conferência de contraste.
        const rodar = async (): Promise<string> => {
          const r = await page.evaluate(() => {
            const alvos = ['.capa', '#pvres-raiz'].filter((q) =>
              document.querySelector(q),
            );
            return (window as unknown as AxeNaPagina).axe.run(
              { include: alvos.map((q) => [q]) } as unknown as Element,
              { rules: { 'color-contrast': { enabled: true } } },
            );
          });
          return r.violations
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
            .join('\n');
        };
        await botao().waitFor();
        expect(await rodar(), 'botão').toBe('');

        let solta: () => void = () => {};
        const segurar = new Promise<void>((r) => (solta = r));
        responder = async (rota) => {
          await segurar;
          await json(rota, 200, RESULTADO).catch(() => undefined);
        };
        await botao().click();
        await painel().getByText('Resumindo o processo').waitFor();
        expect(await rodar(), 'resumindo').toBe('');
        solta();
        await painel().getByText('Situação do processo').waitFor();
        expect(await rodar(), 'resultado').toBe('');
        await painel().getByRole('button', { name: 'Útil' }).click();
        await page.getByText('✓ Avaliação registrada.').waitFor();
        expect(await rodar(), 'avaliado').toBe('');

        await painel().getByRole('button', { name: 'Fechar' }).click();
        responder = (rota) =>
          json(rota, 403, {
            erro: 'ENTRADA_NAO_ANALISAVEL',
            mensagem: 'x',
            detalhes: { motivo: 'sem_plano' },
          });
        await botao().click();
        await painel().getByText('plano IA').waitFor();
        expect(await rodar(), 'recusa').toBe('');
      });
    }
  },
);
