/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROCESSO_TJGO, PROCESSO_TJGO_DIGITOS } from '../helpers/leitor.js';
import { CHAVE, CHROMIUM, TEXTO_LONGO, iniciar } from './ambiente.js';
import type { Ambiente } from './ambiente.js';

/*
 * A Pasta digital NUM NAVEGADOR de verdade (Chromium headless), contra o
 * servidor real e um tribunal falso. Nenhum dado real: peças e números são
 * sintéticos. Não entra no CI sem Chromium — sem ele, o arquivo se pula e diz
 * por quê.
 */
const sem = CHROMIUM === undefined;
interface Console_ {
  __pv?: { abrir(numero: string): void };
}
interface ViolacaoAxe {
  id: string;
  impact: string;
  nodes: Array<{ target: string[]; any: Array<{ message: string }> }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}
describe.skipIf(sem)('Pasta digital — no navegador', { timeout: 60_000 }, () => {
  let browser: Browser;
  let amb: Ambiente;
  let ctx: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: CHROMIUM as string,
      args: ['--no-sandbox'],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function abrirTela(
    opcoes: { viewport?: { width: number; height: number }; escuro?: boolean } = {},
  ) {
    amb = await iniciar();
    ctx = await browser.newContext({
      viewport: opcoes.viewport ?? { width: 1360, height: 860 },
      colorScheme: opcoes.escuro ? 'dark' : 'light',
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
    await page.goto(amb.url + '/');
    await page.waitForFunction(
      () => typeof (window as unknown as Console_).__pv?.abrir === 'function',
    );
    await page.evaluate(
      (n) => (window as unknown as Console_).__pv!.abrir(n),
      PROCESSO_TJGO,
    );
    await page.waitForSelector('#pasta-abrir');
  }
  afterEach(async () => {
    await ctx?.close();
    await amb?.encerrar();
  });

  const lotes = (): string[][] => amb.provedor.lotes().map((l) => [...l]);
  async function abrirPasta(): Promise<void> {
    await page.click('#pasta-abrir');
    await page.waitForSelector('#pasta .linha');
  }
  const linha = (id: string) => page.locator(`#pf-${id}`);

  it('sem abrir a Pasta, a tela do processo é a de antes — e fechar a devolve igual', async () => {
    await abrirTela();
    expect(await page.locator('#pasta').count()).toBe(0);
    expect(await page.locator('body.com-pasta').count()).toBe(0);
    const antes = await page.locator('#conteudo').innerHTML();
    expect(await page.textContent('#pasta-abrir')).toBe('Pasta digital');
    expect(await page.locator('#leitor-abrir').count()).toBe(0);
    await abrirPasta();
    await page.click('#pasta-fechar');
    expect(await page.locator('#pasta').count()).toBe(0);
    expect(await page.locator('#conteudo').innerHTML()).toBe(antes);
    // E abrir a Pasta não custou nenhuma consulta ao tribunal além das peças do processo.
    expect(lotes()).toEqual([]);
  });

  it('lista todas as peças na ordem dos autos, com o estado e os totais sem filtro', async () => {
    await abrirTela();
    await abrirPasta();
    const rotulos = await page.locator('#pasta .linha .rot').allTextContents();
    expect(rotulos[0]).toBe('Petição - inicial');
    expect(rotulos).toHaveLength(12);
    expect(rotulos[11]).toBe('Recurso');
    expect(await linha('p11').getAttribute('aria-disabled')).toBe('true');
    expect(await linha('p11').textContent()).toContain('Sob sigilo');
    expect(await linha('p01').textContent()).toContain('Não baixada');
    expect(await page.textContent('#pasta-contagem')).toContain('mostrando 12 de 12');
    expect(await page.textContent('#pasta-aviso')).toContain('não é consulta ao vivo');
    // Busca e filtro dizem quantas esconderam.
    await page.fill('#pasta-busca', 'peticao');
    expect(await page.locator('#pasta .linha').count()).toBe(3);
    expect(await page.textContent('#pasta-contagem')).toContain(
      '9 escondidas pelos filtros',
    );
    await page.fill('#pasta-busca', '');
    await page.check('#pasta-so-disp');
    expect(await page.locator('#pasta .linha').count()).toBe(0);
    expect(await page.textContent('#pasta-contagem')).toContain(
      '12 escondidas pelos filtros',
    );
  });

  it('cada peça mostra o ato a que pertence: "mov. N" é a POSIÇÃO do ato, o texto é do tribunal, e nada onde não há vínculo', async () => {
    await abrirTela();
    await abrirPasta();
    // A resposta do tribunal chega em ordem invertida: a posição é cronológica.
    const posicoes: Record<string, string> = {
      p01: '1', p02: '1', p03: '1', p04: '2', p05: '3', p06: '4', p07: '5',
      p08: '6', p09: '7',
    };
    for (const [id, n] of Object.entries(posicoes)) {
      expect(await linha(id).locator('.mov-n').textContent()).toBe(`mov. ${n}`);
      expect(await linha(id).locator('.mov-n').getAttribute('title')).toBe(
        'Número calculado pela ordem dos atos recebidos do tribunal. ' +
          'Pode ficar abaixo do número do Projudi se o processo tiver atos bloqueados.',
      );
    }
    // O identificador interno do tribunal (516017864 etc.) nunca aparece (v0.33.2).
    expect(await page.locator('#pasta-lista').textContent()).not.toMatch(/5160178\d\d/);
    // O aviso fixo diz de quantos atos a numeração saiu (7 recebidos).
    const aviso = (await page.textContent('#pasta-aviso-num')) ?? '';
    expect(aviso).toContain('calculada pelo Processo Vivo a partir de 7 atos');
    expect(aviso).toContain('maior que 7');
    expect(aviso).toContain('atos bloqueados');
    expect(await linha('p06').locator('.mov-t').textContent()).toBe(
      'Juntada de manifestação sobre o ev. 382 (movimentação nº 5000)',
    );
    // O complemento vem junto, como veio.
    expect(await linha('p04').locator('.mov-t').textContent()).toBe(
      'Conclusos para despacho — prioridade: normal',
    );
    // Várias peças do mesmo ato repetem a descrição (sem agrupar).
    for (const id of ['p01', 'p02', 'p03']) {
      expect(await linha(id).locator('.mov').textContent()).toContain(
        'Juntada de documentos iniciais',
      );
    }
    // Número citado no texto é texto: nada vira link.
    expect(await page.locator('#pasta .linha .mov a').count()).toBe(0);
    // Sem vínculo: a linha é a de antes, sem bloco vazio.
    for (const id of ['p10', 'p11', 'p12']) {
      expect(await linha(id).locator('.mov').count()).toBe(0);
    }
    expect(await linha('p10').textContent()).not.toContain('mov.');
    // O leitor de tela lê rótulo, data, estado e descrição (nome do option vem do conteúdo).
    const lido = (await linha('p06').textContent()) ?? '';
    for (const parte of ['Petição - réplica', 'Não baixada', 'Juntada de manifestação']) {
      expect(lido).toContain(parte);
    }
    // Nenhuma consulta ao tribunal para mostrar isso.
    expect(lotes()).toEqual([]);
  });

  it('sem posição nenhuma na listagem (gravada antes da 0.34.0), a tela é a de antes: sem "mov." e sem aviso de numeração', async () => {
    await abrirTela();
    // Simula a resposta de uma listagem antiga: atos sem `posicao` e sem total.
    await page.route('**/v1/processos/*/pasta', async (rota) => {
      const resposta = await rota.fetch();
      const corpo = (await resposta.json()) as {
        totalAtosRecebidos: number | null;
        pecas: Array<{ movimentacao: { posicao?: number | null } | null }>;
      };
      corpo.totalAtosRecebidos = null;
      for (const p of corpo.pecas) if (p.movimentacao) delete p.movimentacao.posicao;
      await rota.fulfill({ response: resposta, json: corpo });
    });
    await abrirPasta();
    expect(await page.locator('#pasta .linha .mov-n').count()).toBe(0);
    expect(await page.locator('#pasta-aviso-num').count()).toBe(0);
    expect(await page.locator('#pasta-lista').textContent()).not.toContain('mov.');
    // O texto do ato continua lá.
    expect(await linha('p06').locator('.mov-t').count()).toBe(1);
  });

  it('lacuna: com 7 atos recebidos, a tela mostra as posições e o aviso diz 7 — mesmo se o Projudi tiver mais', async () => {
    await abrirTela();
    await abrirPasta();
    expect(await linha('p09').locator('.mov-n').textContent()).toBe('mov. 7');
    const aviso = (await page.textContent('#pasta-aviso-num')) ?? '';
    expect(aviso).toContain('a partir de 7 atos recebidos');
    expect(aviso).toContain('podem estar abaixo');
    expect(aviso).not.toMatch(/oficial/i);
    // O aviso permanece enquanto a lista é refeita (busca/filtro não o esconde).
    await page.fill('#pasta-busca', 'nada-disto-existe');
    expect(await page.locator('#pasta-aviso-num').isVisible()).toBe(true);
  });

  it('descrição longa: até 2 linhas, texto inteiro no mouse, no foco e no cabeçalho do visualizador — sem estourar a lista', async () => {
    await abrirTela();
    await abrirPasta();
    const mov = linha('p05').locator('.mov-t');
    const medidas = await mov.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        alturaLinha: parseFloat(cs.lineHeight),
        altura: el.getBoundingClientRect().height,
        rolagem: el.scrollHeight,
      };
    });
    expect(medidas.altura).toBeLessThanOrEqual(medidas.alturaLinha * 2 + 1);
    expect(medidas.rolagem).toBeGreaterThan(medidas.altura + 1); // truncada de verdade
    expect(await linha('p05').locator('.mov').getAttribute('title')).toContain(
      'FIM-DO-TEXTO-LONGO',
    );
    // A lista não ganha rolagem horizontal.
    expect(
      await page
        .locator('#pasta-itens')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    // Foco (teclado): o texto se abre inteiro.
    await linha('p04').focus();
    await page.keyboard.press('ArrowDown'); // por teclado: :focus-visible
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('pf-p05');
    const aberto = await mov.evaluate((el) => el.getBoundingClientRect().height);
    expect(aberto).toBeGreaterThan(medidas.altura + 1);
    // Cabeçalho do visualizador, depois de abrir a peça.
    await linha('p05').click();
    await page.waitForSelector('#pasta .pagina canvas');
    const cab = (await page.textContent('#pasta-mov')) ?? '';
    expect(cab).toContain('Movimentação nº 3 · ');
    expect(cab).toContain('número calculado');
    expect(cab).not.toMatch(/5160178\d\d/);
    expect(await page.locator('#pasta-mov .mov-aviso').getAttribute('title')).toContain(
      'atos bloqueados',
    );
    expect(cab).toContain(TEXTO_LONGO);
    // Peça sem vínculo: o cabeçalho some em vez de ficar um vão em branco.
    await linha('p12').click();
    await page.waitForFunction(
      () => document.getElementById('pasta-mov')?.textContent === '',
    );
    expect(await page.locator('#pasta-mov').isVisible()).toBe(false);
  });

  it('a busca acha pela descrição (e NÃO pelo identificador interno), e o contador diz quantas escondeu', async () => {
    await abrirTela();
    await abrirPasta();
    // Pela descrição (sem acento, como ninguém digita).
    await page.fill('#pasta-busca', 'conclusos');
    expect(await page.locator('#pasta .linha').count()).toBe(2); // p04 (mov 2) e p08 (mov 6)
    expect(await page.textContent('#pasta-contagem')).toContain(
      '10 escondidas pelos filtros',
    );
    // O identificador interno não é buscável: nem inteiro, nem pedaço.
    for (const termo of ['516017864', '516017']) {
      await page.fill('#pasta-busca', termo);
      expect(await page.locator('#pasta .linha').count()).toBe(0);
    }
    // O número casa por IGUALDADE sobre a posição: "mov. 3" não acha o 38.
    await page.fill('#pasta-busca', 'mov. 4');
    expect(await page.locator('#pasta .linha').count()).toBe(1);
    expect(await linha('p06').count()).toBe(1);
    await page.fill('#pasta-busca', 'nº 3');
    expect(await page.locator('#pasta .linha').count()).toBe(1);
    expect(await linha('p05').count()).toBe(1);
    await page.fill('#pasta-busca', 'mov. 38');
    expect(await page.locator('#pasta .linha').count()).toBe(0);
    // Texto livre se acha como texto: "382" aparece na descrição de p06.
    await page.fill('#pasta-busca', '382');
    expect(await linha('p06').count()).toBe(1);
    // O rótulo continua valendo.
    await page.fill('#pasta-busca', 'peticao');
    expect(await page.locator('#pasta .linha').count()).toBe(3);
    await page.fill('#pasta-busca', 'nada-disto-existe');
    expect(await page.textContent('#pasta-contagem')).toContain(
      '12 escondidas pelos filtros',
    );
  });

  it('CLIQUES RÁPIDOS: cinco peças em sequência, o tribunal recebe UM lote só, com a última', async () => {
    await abrirTela();
    await abrirPasta();
    for (const id of ['p01', 'p02', 'p03', 'p05', 'p06']) await linha(id).click();
    // A última é a que abre.
    await page.waitForSelector('#pasta .pagina canvas');
    expect(await page.textContent('#pasta-nome')).toContain('Petição - réplica');
    expect(lotes()).toEqual([['p06']]);
    // As intermediárias nunca foram ao tribunal e seguem "não baixadas".
    expect(await linha('p01').textContent()).toContain('Não baixada');
    expect(await linha('p06').textContent()).toContain('Disponível');
    // O que o tribunal falso recebeu: UMA consulta de lote (nenhuma outra de peça).
    expect(amb.provedor.chamadas.filter((c) => c.tipo === 'lote')).toHaveLength(1);
    expect(await page.textContent('#pasta-estado')).toContain('não é consulta ao vivo');
  });

  it('peça já guardada abre sem consultar o tribunal; HTML abre como texto', async () => {
    await abrirTela();
    await abrirPasta();
    await linha('p04').click();
    await page.waitForSelector('#pasta .pagina canvas');
    expect(await page.textContent('#pasta-estado')).toContain(
      'Convertida do HTML do tribunal',
    );
    expect(lotes()).toEqual([['p04']]);
    await linha('p01').click();
    await page.waitForFunction(
      () =>
        document.getElementById('pasta-nome')?.textContent?.includes('inicial') &&
        document.getElementById('pasta-pg')?.textContent === 'p. 1 de 2',
    );
    expect(lotes()).toEqual([['p04'], ['p01']]);
    await linha('p04').click(); // de volta: guardada, nenhuma chamada nova
    await page.waitForFunction(() =>
      document.getElementById('pasta-nome')?.textContent?.includes('Despacho'),
    );
    await page.waitForTimeout(700);
    expect(lotes()).toHaveLength(2);
  });

  it('com uma montagem andando, o clique diz "aguardando a fila do tribunal" e depois abre — nunca gira sem fim', async () => {
    await abrirTela();
    await abrirPasta();
    // O tribunal falso segura o primeiro lote da montagem até o teste soltar.
    let soltar: () => void = () => {};
    const portao = new Promise<void>((r) => {
      soltar = r;
    });
    amb.provedor.aoLote = async (n) => {
      if (n === 1) await portao;
    };
    page.on('dialog', (d) => void d.accept());
    await page.click('#pasta-montar');
    await page.waitForFunction(() =>
      /Montando a pasta|Montagem na fila/.test(
        document.getElementById('pasta-aviso')?.textContent ?? '',
      ),
    );
    await linha('p12').click();
    await page.waitForFunction(() =>
      /Aguardando a fila do tribunal/.test(
        document.getElementById('pasta-estado')?.textContent ?? '',
      ),
    );
    // Enquanto espera, a tela explica por quê — não é "carregando".
    expect(await page.textContent('#pasta-estado')).toContain('montagem em andamento');
    expect(await page.textContent('#pasta-estado')).toContain('pausa de 3 s');
    soltar();
    await page.waitForSelector('#pasta .pagina canvas');
    expect(await page.textContent('#pasta-nome')).toContain('Recurso');
    // A montagem terminou e a pasta completa está disponível.
    await page.waitForFunction(
      () => !(document.getElementById('pasta-tudo') as HTMLButtonElement).disabled,
    );
    // A peça clicada foi pedida UMA vez (ou veio da montagem, nunca duas).
    const todas = lotes().flat();
    expect(todas.filter((i) => i === 'p12').length).toBeLessThanOrEqual(1);
    expect(todas.filter((i) => i === 'p11').length).toBe(0); // sigilosa nunca
    for (const id of todas) expect(todas.filter((i) => i === id).length).toBe(1);
  });

  it('montar pasta completa: progresso, leitura enquanto monta, intervalos de página e "ver tudo seguido"', async () => {
    await abrirTela();
    await abrirPasta();
    page.on('dialog', (d) => void d.accept());
    await page.click('#pasta-montar');
    await page.waitForFunction(
      () => !(document.getElementById('pasta-tudo') as HTMLButtonElement).disabled,
    );
    expect(await linha('p01').textContent()).toContain('p. 1–2');
    expect(await linha('p05').textContent()).toMatch(/p\. \d+–\d+/);
    expect(await page.textContent('#pasta-aviso')).toContain('Pasta montada com falhas'); // p10 sem teor
    await page.click('#pasta-tudo');
    await page.waitForSelector('#pasta .pagina canvas');
    expect(await page.textContent('#pasta-tudo')).toBe('Voltar a uma peça por vez');
    const total = await page.locator('#pasta .pagina').count();
    expect(total).toBeGreaterThanOrEqual(15);
    // Clicar numa peça com "p. N" leva até a página dela.
    await linha('p09').click();
    await page.waitForFunction(() =>
      /Sentença/.test(document.getElementById('pasta-onde')?.textContent ?? ''),
    );
    // O tribunal recebeu cada peça guardável uma única vez.
    const todas = lotes().flat();
    expect(new Set(todas).size).toBe(todas.length);
    expect(todas).not.toContain('p11');
  });

  it('403 do tribunal: a tela mostra "Pausado pelo tribunal até HH:MM" e não deixa insistir antes da hora', async () => {
    await abrirTela();
    await abrirPasta();
    const volta = new Date(Date.now() + 25 * 60_000);
    const { MniBloqueadoError } = await import('../../src/domain/errors/index.js');
    amb.provedor.falharNoLote = { n: 1, erro: new MniBloqueadoError('mni', volta) };
    amb.provedor.pausa = volta;
    await linha('p02').click();
    await page.waitForFunction(() =>
      /Pausado pelo tribunal até/.test(
        document.getElementById('pasta-estado')?.textContent ?? '',
      ),
    );
    expect(await page.locator('#pasta-refazer').isDisabled()).toBe(true);
    expect(await page.textContent('#pasta-aviso')).toContain('Tribunal em pausa até');
    expect(lotes()).toHaveLength(1);
  });

  it('peça sem teor e peça sob sigilo: motivo claro, sem pedido', async () => {
    await abrirTela();
    await abrirPasta();
    await linha('p10').click();
    await page.waitForFunction(() =>
      /não pôde ser obtida/.test(
        document.getElementById('pasta-estado')?.textContent ?? '',
      ),
    );
    expect(await page.textContent('#pasta-estado')).toContain('procuração');
    await linha('p11').click({ force: true });
    await page.waitForFunction(() =>
      /Peça sob sigilo/.test(document.getElementById('pasta-estado')?.textContent ?? ''),
    );
    expect(lotes()).toEqual([['p10']]);
  });

  it('listagem ausente (409): mensagem clara e "tentar de novo", que carrega as peças e repete', async () => {
    await abrirTela();
    await abrirPasta();
    let falhou = false;
    await page.route('**/pasta/pecas/p02', async (rota) => {
      if (!falhou) {
        falhou = true;
        await rota.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            erro: 'LISTAGEM_DA_PASTA_AUSENTE',
            mensagem:
              'A lista de peças deste processo ainda não foi carregada do tribunal.',
          }),
        });
      } else await rota.continue();
    });
    await linha('p02').click();
    await page.waitForSelector('#pasta-tentar-pedido');
    expect(await page.textContent('#pasta-estado')).toContain(
      'ainda não foi carregada do tribunal',
    );
    expect(lotes()).toEqual([]);
    await page.click('#pasta-tentar-pedido');
    await page.waitForSelector('#pasta .pagina canvas');
    expect(lotes()).toEqual([['p02']]);
  });

  it('teclado: setas navegam, Enter abre, Espaço marca; foco visível', async () => {
    await abrirTela();
    await abrirPasta();
    await linha('p01').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('pf-p02');
    await page.keyboard.press('Space');
    expect(await linha('p02').getAttribute('aria-selected')).toBe('true');
    expect(await page.textContent('#pasta-contagem')).toContain('1 marcada');
    await page.keyboard.press('End');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('pf-p12');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#pasta .pagina canvas');
    expect(await page.textContent('#pasta-nome')).toContain('Petição - inicial');
    // O foco continua na linha (o redesenho da lista não o perdeu).
    await linha('p03').focus();
    const contorno = await linha('p03').evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(contorno).not.toBe('none');
    // Sigilo não marca.
    await linha('p11').focus();
    await page.keyboard.press('Space');
    expect(await linha('p11').getAttribute('aria-selected')).toBe('false');
  });

  it('"Baixar PDF" das marcadas avisa quantas serão buscadas e entrega o arquivo com o nome certo', async () => {
    await abrirTela();
    await abrirPasta();
    await linha('p01').click();
    await page.waitForSelector('#pasta .pagina canvas');
    await linha('p01').focus();
    for (const id of ['p01', 'p02', 'p07']) await linha(id).locator('[data-cx]').click();
    expect(await page.textContent('#pasta-baixar-pdf')).toBe('Baixar PDF (3)');
    await page.click('#pasta-baixar-pdf');
    await page.waitForSelector('#pasta-confirmar-baixar');
    const previa = (await page.textContent('#pasta-baixar-caixa')) ?? '';
    expect(previa).toContain('Serão buscadas');
    expect(previa).toMatch(/2 peças/);
    expect(previa).toContain('1 já estão guardadas');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#pasta-confirmar-baixar'),
    ]);
    expect(download.suggestedFilename()).toBe(
      `processo-${PROCESSO_TJGO_DIGITOS}-pecas-selecionadas.pdf`,
    );
    // p01 estava guardada: só p02 e p07 foram ao tribunal, num lote.
    expect(lotes().slice(1)).toEqual([['p02', 'p07']]);
  });

  it('atalhos por tipo, Todas e Nenhuma dizem o número e agem sobre o que está na tela', async () => {
    await abrirTela();
    await abrirPasta();
    const chip = page.locator('#pasta-atalhos .chip', { hasText: 'Petição' });
    expect(await chip.textContent()).toContain('(3)');
    await chip.click();
    expect(await page.textContent('#pasta-contagem')).toContain('3 marcadas');
    await page.click('#pasta-nenhuma');
    expect(await page.textContent('#pasta-contagem')).toContain('0 marcadas');
    await page.fill('#pasta-busca', 'laudo');
    expect(await page.textContent('#pasta-todas')).toBe('Todas (1)'); // o sigiloso não conta
    await page.click('#pasta-todas');
    await page.fill('#pasta-busca', '');
    expect(await page.textContent('#pasta-contagem')).toContain('1 marcada');
  });

  it('o divisor arrasta, a largura é lembrada e a lista nunca passa da janela', async () => {
    await abrirTela();
    await abrirPasta();
    const larg = async () => (await page.locator('#pasta .lista').boundingBox())!.width;
    const antes = await larg();
    const d = (await page.locator('#pasta-divisor').boundingBox())!;
    await page.mouse.move(d.x + 5, d.y + 100);
    await page.mouse.down();
    await page.mouse.move(d.x + 205, d.y + 100, { steps: 5 });
    await page.mouse.up();
    expect(await larg()).toBeGreaterThan(antes + 150);
    await page.mouse.move(d.x + 205, d.y + 100);
    // Teclado também.
    await page.locator('#pasta-divisor').focus();
    await page.keyboard.press('ArrowLeft');
    // Janela menor: a lista encolhe e nada vaza para a direita.
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(400);
    const caixa = (await page.locator('#pasta .lista').boundingBox())!;
    expect(caixa.x + caixa.width).toBeLessThanOrEqual(1000 - 320 + 1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    // Recarregada, a preferência vale (ainda cortada pela janela).
    expect(
      await page.evaluate(() => localStorage.getItem('processovivo.pasta.lista')),
    ).toMatch(/px$/);
  });

  it('celular: lista em tela cheia; a peça abre em tela cheia, com "voltar"', async () => {
    await abrirTela({ viewport: { width: 390, height: 800 } });
    await abrirPasta();
    expect(await page.locator('#pasta .lista').isVisible()).toBe(true);
    expect(await page.locator('#pasta .visor').isVisible()).toBe(false);
    const w = (await page.locator('#pasta .lista').boundingBox())!.width;
    expect(w).toBeGreaterThanOrEqual(388);
    await linha('p05').click();
    await page.waitForSelector('#pasta .pagina canvas');
    expect(await page.locator('#pasta .visor').isVisible()).toBe(true);
    expect(await page.locator('#pasta .lista').isVisible()).toBe(false);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    // No celular o cabeçalho do visualizador traz o ato, sem passar da tela.
    expect(await page.textContent('#pasta-mov')).toContain('Movimentação nº 3 · ');
    expect(await page.textContent('#pasta-mov')).not.toMatch(/5160178\d\d/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.click('#pasta-voltar');
    expect(await page.locator('#pasta .lista').isVisible()).toBe(true);
    // A lista, com os atos, também cabe na largura do celular.
    expect(await page.locator('#pasta .linha .mov').count()).toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(await page.locator('#pasta .visor').isVisible()).toBe(false);
  });

  for (const escuro of [false, true]) {
    it(`acessibilidade (axe) e contraste no tema ${escuro ? 'escuro' : 'claro'}`, async () => {
      await abrirTela({ escuro });
      await abrirPasta();
      await linha('p01').click();
      await page.waitForSelector('#pasta .pagina canvas');
      await linha('p10').click();
      await page.waitForFunction(() =>
        /não pôde ser obtida/.test(
          document.getElementById('pasta-estado')?.textContent ?? '',
        ),
      );
      const fundo = await page.evaluate(
        () => getComputedStyle(document.getElementById('pasta')!).backgroundColor,
      );
      expect(fundo).toBe(escuro ? 'rgb(17, 27, 46)' : 'rgb(255, 255, 255)');
      await page.addScriptTag({
        content: (AxeBuilder as unknown as { source: string }).source,
      });
      const resultado = await page.evaluate(async () => {
        const r = await (window as unknown as AxeNaPagina).axe.run(
          document.getElementById('pasta')!,
          {
            rules: { 'color-contrast': { enabled: true } },
          },
        );
        return r.violations.map((v) => ({
          id: v.id,
          impacto: v.impact,
          nos: v.nodes
            .map((n) => n.target.join(' ') + ' :: ' + (n.any[0]?.message ?? ''))
            .slice(0, 4),
        }));
      });
      expect(resultado).toEqual([]);
    });
  }
});
