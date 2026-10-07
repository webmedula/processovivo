import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { ESTILOS_PASTA } from '../../src/main/http/ui/estilosPasta.js';
import { paginaConsole } from '../../src/main/http/ui/pagina.js';
import { SCRIPT } from '../../src/main/http/ui/script.js';
import { SCRIPT_PASTA } from '../../src/main/http/ui/scriptPasta.js';
import { SCRIPT_PASTA_CALIBRACAO } from '../../src/main/http/ui/scriptPastaCalibracao.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import {
  PROCESSO_TJGO,
  ProvedorDeLoteFalso,
  pastaTemporaria,
  pdfSintetico,
} from '../helpers/leitor.js';

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };

let pasta: ReturnType<typeof pastaTemporaria>;
let servidor: FastifyInstance;
let app: Aplicacao;

beforeEach(async () => {
  pasta = pastaTemporaria();
  app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    provedorDePecas: new ProvedorDeLoteFalso([
      { id: 'a', bytes: await pdfSintetico(1, 'A') },
    ]),
    leitor: { pasta: pasta.caminho },
  });
  servidor = construirServidor(
    app,
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      CACHE_ENABLED: 'false',
      PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
    } as NodeJS.ProcessEnv),
  );
  for (const h of [A, B]) {
    await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: h,
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
  }
});
afterEach(async () => {
  await servidor.close();
  pasta.apagar();
});

describe('PDF.js servido pelo próprio servidor', () => {
  it('serve o motor e o worker sem pedir chave — o navegador não manda x-api-key em import()', async () => {
    for (const arquivo of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
      const r = await servidor.inject({ url: `/ui/pdfjs/${arquivo}` });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/javascript');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('serve o build LEGACY, com o polyfill que navegador de escritório precisa', async () => {
    // O build padrão do pdfjs-dist 6 chama Map.prototype.getOrInsertComputed,
    // que o Chromium dos testes não tem: a página ficava em branco, sem erro.
    const r = await servidor.inject({ url: '/ui/pdfjs/pdf.min.mjs' });
    expect(r.body).toContain('getOrInsertComputed:function');
  });

  it('serve as fontes padrão do PDF e o decodificador de JBIG2', async () => {
    expect((await servidor.inject({ url: '/ui/pdfjs/FoxitSerif.pfb' })).statusCode).toBe(
      200,
    );
    expect(
      (await servidor.inject({ url: '/ui/pdfjs/jbig2.wasm' })).headers['content-type'],
    ).toBe('application/wasm');
  });

  it('lista fechada: nome desconhecido ou caminho com ".." é 404', async () => {
    for (const url of [
      '/ui/pdfjs/pdf.mjs',
      '/ui/pdfjs/..%2Fpackage.json',
      '/ui/pdfjs/LICENSE',
      '/ui/pdfjs/%2Fetc%2Fpasswd',
    ]) {
      expect((await servidor.inject({ url })).statusCode, url).toBe(404);
    }
  });
});

describe('API — apoio ao painel', () => {
  it('estima em faixa e diz quando pedir confirmação (acima de 150 peças)', async () => {
    const muitas = (
      await servidor.inject({ url: '/v1/leitor/estimativa?pecas=278', headers: A })
    ).json();
    expect(muitas).toMatchObject({
      pecas: 278,
      confirmarAcimaDe: 150,
      exigeConfirmacao: true,
    });
    expect(muitas.minimoSegundos).toBeLessThan(muitas.maximoSegundos);
    const poucas = (
      await servidor.inject({ url: '/v1/leitor/estimativa?pecas=10', headers: A })
    ).json();
    expect(poucas.exigeConfirmacao).toBe(false);
    expect(
      (await servidor.inject({ url: '/v1/leitor/estimativa?pecas=-1', headers: A }))
        .statusCode,
    ).toBe(400);
  });

  it('reabre o último PDF do processo — e só o do próprio workspace', async () => {
    const url = `/v1/processos/${PROCESSO_TJGO}/leitor`;
    const vazio = { job: null, pronto: null, reaproveitaveis: [] };
    expect((await servidor.inject({ url, headers: A })).json()).toEqual(vazio);

    const criado = await servidor.inject({
      method: 'POST',
      url,
      headers: A,
      payload: { pecas: ['a'] },
    });
    await app.leitor?.processarFila();

    const ultimo = (await servidor.inject({ url, headers: A })).json();
    expect(ultimo.job).toMatchObject({ jobId: criado.json().jobId, estado: 'pronto' });
    // "Reabrir o PDF já pronto" e as peças que uma seleção nova não pede de novo.
    expect(ultimo.pronto).toMatchObject({ jobId: criado.json().jobId });
    expect(ultimo.reaproveitaveis).toEqual(['a']);
    expect((await servidor.inject({ url, headers: B })).json()).toEqual(vazio);
  });
});

describe('console — a tela da Pasta digital', () => {
  it('vive em arquivo próprio: o script do console não carrega PDF.js', () => {
    expect(SCRIPT).not.toContain('getDocument');
    expect(SCRIPT).not.toContain('/ui/pdfjs/');
    expect(SCRIPT_PASTA).toContain('getDocument');
  });

  it('entra na página sem <script src> e sem nada de fora; o painel antigo saiu', () => {
    const html = paginaConsole('0.0.0');
    expect(html).toContain(SCRIPT_PASTA.trim().slice(0, 40));
    expect(html).toContain(ESTILOS_PASTA.trim().slice(0, 40));
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(SCRIPT_PASTA).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('Ler peças ao lado');
    expect(SCRIPT).toContain('id="pasta-abrir">Pasta digital');
  });

  it('sem abrir a Pasta, a tela do processo é a de antes: o gancho só liga o botão', () => {
    const inicio = SCRIPT_PASTA.indexOf('aposDesenhar:function');
    const corpo = SCRIPT_PASTA.slice(
      inicio,
      SCRIPT_PASTA.indexOf('trocouProcesso:', inicio),
    );
    // Nada de caixas na linha do tempo nem de DOM novo: bind do botão e, só com a Pasta aberta, recarregar.
    expect(corpo).toContain("addEventListener('click',abrirPasta)");
    expect(corpo).not.toContain('createElement');
    expect(corpo).not.toContain('insertBefore');
    expect(corpo).toContain('if(st.aberta)recarregar()');
    // O CSS só age dentro da Pasta ou sob as classes do corpo dela.
    for (const regra of ESTILOS_PASTA.split('}')) {
      const seletor = regra.split('{')[0]?.trim() ?? '';
      if (
        !seletor ||
        seletor.startsWith('/*') ||
        seletor.startsWith('@') ||
        seletor.startsWith(':root')
      )
        continue;
      for (const parte of seletor.split(',').map((x) => x.trim())) {
        expect(
          /^(#pasta|body\.com-pasta|body\.pasta-lendo)/.test(parte),
          `regra que vaza para a tela sem a Pasta: ${parte}`,
        ).toBe(true);
      }
    }
  });

  it('o clique não é uma chamada: debounce de 400 ms, o pedido agendado é trocado pelo seguinte', () => {
    expect(SCRIPT_PASTA).toContain('var DEBOUNCE_MS=400');
    const inicio = SCRIPT_PASTA.indexOf('function abrirPeca(');
    const corpo = SCRIPT_PASTA.slice(
      inicio,
      SCRIPT_PASTA.indexOf('function enviarPedido', inicio),
    );
    expect(corpo).toContain('clearTimeout(st.clique.timer)');
    expect(corpo).toContain(
      'setTimeout(function(){enviarPedido(id)},imediato?0:DEBOUNCE_MS)',
    );
    // Nenhuma pré-busca: o único POST de peça é o do clique.
    expect(
      SCRIPT_PASTA.match(/\/pecas\/'\+encodeURIComponent\(id\),\{method:'POST'\}/g),
    ).toHaveLength(1);
  });

  it('diz o estado com honestidade e nunca fica "carregando" sem fim', () => {
    for (const texto of [
      'Aguardando a fila do tribunal.',
      'Baixando esta peça…',
      'Pausado pelo tribunal',
      'Sem habilitação nos autos',
      'Esta peça não pôde ser obtida',
      'não é consulta ao vivo',
      'Esta peça está demorando mais do que o normal.',
      'O PDF está demorando para abrir.',
      'A lista de peças deste processo ainda não foi carregada',
      'Perdi o contato com o servidor.',
    ]) {
      expect(SCRIPT_PASTA, texto).toContain(texto);
    }
    // Limites: peça pedida, PDF aberto, e três falhas seguidas de consulta.
    expect(SCRIPT_PASTA).toContain('LIMITE_ESPERA_MS');
    expect(SCRIPT_PASTA).toContain('LIMITE_PDF_MS');
    expect(SCRIPT_PASTA).toContain('st.erroPoll>=3');
  });

  it('carrega as peças do processo quando a Pasta não tem listagem, e oferece tentar de novo no 409', () => {
    expect(SCRIPT_PASTA).toContain(
      "'/v1/processos/'+encodeURIComponent(st.numero)+'/pecas'",
    );
    expect(SCRIPT_PASTA).toContain("e.codigo==='LISTAGEM_DA_PASTA_AUSENTE'");
    expect(SCRIPT_PASTA).toContain('pasta-tentar-pedido');
    expect(SCRIPT_PASTA).toContain('pasta-tentar-listagem');
  });

  it('rótulo de botão em lote diz o NÚMERO, e o alvo é lido no clique', () => {
    expect(SCRIPT_PASTA).toContain("'Baixar PDF ('+n+')'");
    expect(SCRIPT_PASTA).toContain("'Todas ('+sel+')'");
    const inicio = SCRIPT_PASTA.indexOf("$('pasta-todas').addEventListener('click'");
    expect(SCRIPT_PASTA.slice(inicio, inicio + 200)).toContain('visiveis()');
  });

  it('a lista é um listbox acessível: teclado completo, foco visível, tamanho de alvo', () => {
    expect(SCRIPT_PASTA).toContain('role="listbox" aria-multiselectable="true"');
    expect(SCRIPT_PASTA).toContain('role="option"');
    for (const tecla of [
      "'ArrowDown'",
      "'ArrowUp'",
      "'Enter'",
      "' '",
      "'Home'",
      "'End'",
    ]) {
      expect(SCRIPT_PASTA).toContain(tecla);
    }
    expect(ESTILOS_PASTA).toContain('#pasta .linha:focus-visible');
    expect(ESTILOS_PASTA).toContain('min-height:48px');
    // O contraste do selo neutro foi corrigido dentro da Pasta (axe: 4,2:1).
    expect(ESTILOS_PASTA).toContain('#pasta .selo.neutro{color:var(--tinta2)}');
  });

  it('a lista nunca passa da largura da janela', () => {
    expect(ESTILOS_PASTA).toContain(
      'width:min(var(--pasta-lista-w),calc(100vw - 256px - 320px))',
    );
    expect(SCRIPT_PASTA).toContain("window.addEventListener('resize',st.redimensionar)");
    expect(SCRIPT_PASTA).toContain(
      "window.removeEventListener('resize',st.redimensionar)",
    );
  });

  it('lê o PDF por trechos e desenha só o que está perto da tela', () => {
    expect(SCRIPT_PASTA).toContain('disableAutoFetch:true');
    expect(SCRIPT_PASTA).toContain('disableStream:true');
    expect(SCRIPT_PASTA).toContain('IntersectionObserver');
    expect(SCRIPT_PASTA).toContain('MAX_DESENHADAS');
  });

  it('mostra a movimentação da peça: texto por esc(), nunca link, e só quando há o que mostrar', () => {
    // Passa por esc() — é texto do tribunal.
    expect(SCRIPT_PASTA).toContain("esc(textoEnxutoDaMov(p))+'</span>'");
    expect(SCRIPT_PASTA).toContain('esc(tituloDaMov(p))');
    // Sem bloco vazio: sem texto e sem posição, nada é desenhado.
    expect(SCRIPT_PASTA).toContain("if(!m)return '';");
    expect(SCRIPT_PASTA).toContain("if(!t&&pos===null)return '';");
    // O número vem do servidor com o grau de certeza (v0.35.0; a posição desde a
    // 0.34.0). Nenhum arquivo da tela lê o identificador interno (erro da 0.33.2).
    for (const codigo of [SCRIPT_PASTA, SCRIPT_PASTA_CALIBRACAO]) {
      expect(codigo).not.toMatch(/\.identificadorMovimento|\.movimento\b/);
    }
    expect(SCRIPT_PASTA_CALIBRACAO).toContain('m.posicao');
    expect(SCRIPT_PASTA_CALIBRACAO).toContain('m.numero');
    expect(SCRIPT_PASTA_CALIBRACAO).toContain('esc(curtoDe(p))');
    // Texto livre é texto: nenhum <a> nem href é montado a partir da descrição.
    expect(SCRIPT_PASTA).not.toMatch(/<a [^']*mov/);
    // Até 2 linhas, nunca estoura a lista.
    expect(ESTILOS_PASTA).toContain('-webkit-line-clamp:2');
    expect(ESTILOS_PASTA).toContain('#pasta .linha .ord');
    expect(ESTILOS_PASTA).toContain('overflow-wrap:anywhere');
    expect(ESTILOS_PASTA).toContain('#pasta .visor .mov-visor:empty{display:none}');
  });

  it('o número vem com o aviso de atos bloqueados: tooltip, cabeçalho e aviso fixo — nunca "oficial"', () => {
    expect(SCRIPT_PASTA).toContain(
      'Número calculado pela ordem dos atos recebidos do tribunal. ',
    );
    expect(SCRIPT_PASTA).toContain('Pode ficar abaixo do número do Projudi');
    expect(SCRIPT_PASTA_CALIBRACAO).toContain('Numeração das movimentações calculada');
    expect(SCRIPT_PASTA_CALIBRACAO).toContain('Calibrada por você com');
    expect(SCRIPT_PASTA_CALIBRACAO).toContain('Calibração anterior invalidada');
    expect(SCRIPT_PASTA).toContain('v.totalAtosRecebidos');
    // O aviso depende de haver número na lista, e de mais nada.
    expect(SCRIPT_PASTA).toContain(
      "if(haNumeros()&&typeof v.totalAtosRecebidos==='number')",
    );
    expect(SCRIPT_PASTA).not.toMatch(/n[úu]mero oficial/i);
    expect(SCRIPT_PASTA_CALIBRACAO).not.toMatch(/n[úu]mero oficial/i);
    // Com calibração o aviso não some: o texto muda, a condição não.
    expect(SCRIPT_PASTA).toContain('h+=cal.avisoHtml(v);');
  });

  it('a busca procura no rótulo, na descrição e no número (por igualdade sobre a posição)', () => {
    expect(SCRIPT_PASTA).toContain('function combinaComBusca(p,termo)');
    expect(SCRIPT_PASTA).toContain('Buscar rótulo, movimentação ou nº"');
    expect(SCRIPT_PASTA).toContain('pelo número da movimentação');
    expect(SCRIPT_PASTA).toContain('cal.combina(p,buscado)');
    // Faixa: o número buscado dentro dela também acha a linha.
    expect(SCRIPT_PASTA_CALIBRACAO).toContain('numero>=n.min&&numero<=n.max');
  });

  it('nenhum conteúdo de peça entra no DOM: só texto do sistema, por esc()', () => {
    expect(SCRIPT_PASTA).not.toMatch(/innerHTML\s*=\s*[a-z]*[Cc]onteudo/);
    // O rótulo (texto do tribunal) sempre passa por esc().
    expect(SCRIPT_PASTA).toContain('esc(p.rotulo)');
    expect(SCRIPT_PASTA).not.toContain('eval(');
  });
});
