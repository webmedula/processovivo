import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServicoLeitor } from '../../src/application/services/ServicoLeitor.js';
import type { ConfiguracaoLeitor } from '../../src/application/services/ServicoLeitor.js';
import type { JobLeitor } from '../../src/domain/entities/JobLeitor.js';
import {
  CredencialTribunalInvalidaError,
  JobDoLeitorNaoEncontradoError,
  LimiteDeArmazenamentoExcedidoError,
  MniBloqueadoError,
  PdfDoLeitorExpiradoError,
  PecasForaDoPdfError,
  ProviderIndisponivelError,
} from '../../src/domain/errors/index.js';
import type { Logger } from '../../src/domain/ports/Logger.js';
import { ArmazemEmDisco } from '../../src/infrastructure/arquivos/ArmazemEmDisco.js';
import { QpdfMontador } from '../../src/infrastructure/pdf/QpdfMontador.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { FilaDeJobsSqlite } from '../../src/infrastructure/persistencia/sqlite/FilaDeJobsSqlite.js';
import { RepositorioCredenciaisSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioCredenciaisSqlite.js';
import { Cofre } from '../../src/infrastructure/seguranca/cofre.js';
import { CONFIG_LEITOR_DE_TESTE } from '../helpers/aplicacao.js';
import {
  ClockFalso,
  PNG_1X1,
  OUTRO_PROCESSO,
  PROCESSO_TJGO,
  PROCESSO_TJGO_DIGITOS,
  ProvedorDeLoteFalso,
  HTML_SINTETICO,
  MARCADOR_ATRIBUTO,
  MARCADOR_SCRIPT,
  marcasDasPaginas,
  pastaTemporaria,
  textoDoPdf,
  pdfPesado,
  pdfSintetico,
} from '../helpers/leitor.js';
import type { PecaFalsa } from '../helpers/leitor.js';

const WS = 'ws-advogada-a';
const OUTRO_PROCESSO_DIGITOS = OUTRO_PROCESSO.replace(/\D/g, '');
const SENHA = 'senha-do-projudi-123';

/** Logger que guarda tudo, para provar o que NÃO aparece nele. */
class LoggerGravador implements Logger {
  readonly linhas: string[] = [];
  private registrar(nivel: string, m: string, c?: Record<string, unknown>): void {
    this.linhas.push(`${nivel} ${m} ${JSON.stringify(c ?? {})}`);
  }
  debug(m: string, c?: Record<string, unknown>): void {
    this.registrar('debug', m, c);
  }
  info(m: string, c?: Record<string, unknown>): void {
    this.registrar('info', m, c);
  }
  warn(m: string, c?: Record<string, unknown>): void {
    this.registrar('warn', m, c);
  }
  error(m: string, c?: Record<string, unknown>): void {
    this.registrar('error', m, c);
  }
  child(): Logger {
    return this;
  }
}

interface Montagem {
  readonly servico: ServicoLeitor;
  readonly provedor: ProvedorDeLoteFalso;
  readonly clock: ClockFalso;
  readonly credenciais: RepositorioCredenciaisSqlite;
  readonly fila: FilaDeJobsSqlite;
  readonly armazem: ArmazemEmDisco;
  readonly logger: LoggerGravador;
  readonly esperas: number[];
  novoServico(config?: Partial<ConfiguracaoLeitor>): ServicoLeitor;
}

let pasta: ReturnType<typeof pastaTemporaria>;
beforeEach(() => {
  pasta = pastaTemporaria();
});
afterEach(() => {
  pasta.apagar();
});

async function montar(
  pecas: PecaFalsa[],
  config: Partial<ConfiguracaoLeitor> = {},
): Promise<Montagem> {
  const db = abrirBanco(':memory:');
  const clock = new ClockFalso();
  const credenciais = new RepositorioCredenciaisSqlite(
    db,
    Cofre.comChaveBase64(Cofre.gerarChaveBase64()),
  );
  await credenciais.salvar(WS, {
    tribunal: 'TJGO',
    identificacao: '00000000000',
    senha: SENHA,
  });
  const provedor = new ProvedorDeLoteFalso(pecas, clock);
  const fila = new FilaDeJobsSqlite(db);
  const armazem = new ArmazemEmDisco(pasta.caminho);
  const logger = new LoggerGravador();
  const esperas: number[] = [];
  let seq = 0;
  const novoServico = (extra: Partial<ConfiguracaoLeitor> = {}): ServicoLeitor =>
    new ServicoLeitor({
      provedor,
      credenciais,
      fila,
      armazem,
      montador: new QpdfMontador(),
      logger,
      clock,
      // A pausa entre chamadas é medida no relógio falso: esperar avança o
      // relógio, e o teste confere os instantes das chamadas.
      esperar: async (ms) => {
        esperas.push(ms);
        clock.avancar(ms);
      },
      gerarId: () => (++seq).toString(16).padStart(32, 'a'),
      identificarCredencial: () => 'cred1234',
      config: { ...CONFIG_LEITOR_DE_TESTE, ...config, ...extra },
    });
  return {
    servico: novoServico(),
    provedor,
    clock,
    credenciais,
    fila,
    armazem,
    logger,
    esperas,
    novoServico,
  };
}

async function rodar(m: Montagem, ids: string[]): Promise<JobLeitor> {
  const job = await m.servico.criar(WS, PROCESSO_TJGO, ids);
  await m.servico.processarFila();
  return m.servico.consultar(WS, PROCESSO_TJGO, job.id);
}

async function bytesDoPdf(m: Montagem, job: JobLeitor): Promise<Buffer> {
  const pdf = await m.servico.abrirPdf(WS, PROCESSO_TJGO, job.id);
  const pedacos: Buffer[] = [];
  for await (const p of pdf.ler(0, pdf.tamanho - 1)) pedacos.push(Buffer.from(p));
  return Buffer.concat(pedacos);
}

describe('ServicoLeitor — montagem', () => {
  it('monta na ordem dos AUTOS, não na ordem em que as peças foram marcadas', async () => {
    const m = await montar([
      { id: 'a', bytes: await pdfSintetico(1, 'PECA-A') },
      { id: 'b', bytes: await pdfSintetico(1, 'PECA-B') },
      { id: 'c', bytes: await pdfSintetico(1, 'PECA-C') },
    ]);
    const job = await rodar(m, ['c', 'a', 'b']);

    expect(job.estado).toBe('pronto');
    expect(job.indice?.map((e) => e.pecaId)).toEqual(['a', 'b', 'c']);
    expect(await marcasDasPaginas(await bytesDoPdf(m, job))).toEqual([
      'PECA-A-p1',
      'PECA-B-p1',
      'PECA-C-p1',
    ]);
  });

  it('grava a peça PDF com extensão .pdf (no Ubuntu 26.04 o qpdf só abre *.pdf)', async () => {
    const m = await montar([
      { id: 'a', bytes: await pdfSintetico(1, 'A') },
      { id: 'b', bytes: new Uint8Array([1, 2, 3]), mimetype: 'image/png' },
    ]);
    const original = m.armazem.gravarPeca.bind(m.armazem);
    const extensoes: (string | undefined)[] = [];
    m.armazem.gravarPeca = (ws, job, ordem, bytes, extensao) => {
      extensoes.push(extensao);
      return original(ws, job, ordem, bytes, extensao);
    };
    await rodar(m, ['a', 'b']);
    expect(extensoes).toEqual(['pdf', 'png']);
  });

  it('o índice traz as páginas exatas de cada peça, contadas do arquivo gerado', async () => {
    const m = await montar([
      { id: 'a', bytes: await pdfSintetico(1, 'A'), movimento: 10 },
      { id: 'b', bytes: await pdfSintetico(3, 'B'), movimento: 11 },
      { id: 'c', bytes: await pdfSintetico(2, 'C'), movimento: 12 },
    ]);
    const job = await rodar(m, ['a', 'b', 'c']);
    const { indice } = await m.servico.indice(WS, PROCESSO_TJGO, job.id);

    expect(
      indice.map((e) => [e.pecaId, e.paginaInicial, e.paginaFinal, e.movimento]),
    ).toEqual([
      ['a', 1, 1, 10],
      ['b', 2, 4, 11],
      ['c', 5, 6, 12],
    ]);
    const conferido = await new QpdfMontador().inspecionarPdf(
      await m.armazem.caminhoLocal(WS, job.arquivo?.localizador ?? ''),
    );
    expect(conferido).toEqual({ valido: true, paginas: 6 });
  });

  it('peça que o tribunal não entregou aparece como não obtida, com página de aviso — nunca some', async () => {
    const m = await montar([
      { id: 'a', bytes: await pdfSintetico(2, 'A') },
      { id: 'b' }, // listada, sem teor
      { id: 'c', bytes: await pdfSintetico(1, 'C') },
    ]);
    const job = await rodar(m, ['a', 'b', 'c']);

    expect(job.estado).toBe('parcial');
    const b = job.indice?.find((e) => e.pecaId === 'b');
    expect(b).toMatchObject({ situacao: 'nao_obtida', paginaInicial: 3, paginaFinal: 3 });
    expect(b?.motivo).toContain('procuração');
    expect(job.arquivo?.paginas).toBe(4);
  });

  it('converte imagem em página', async () => {
    const m = await montar([{ id: 'foto', mimetype: 'image/png', bytes: PNG_1X1 }]);
    const job = await rodar(m, ['foto']);
    expect(job.estado).toBe('pronto');
    expect(job.indice?.[0]).toMatchObject({
      situacao: 'convertida',
      paginaInicial: 1,
      paginaFinal: 1,
    });
  });

  it('arquivo vazio e PDF corrompido viram página de aviso', async () => {
    const m = await montar([
      { id: 'vazio', bytes: new Uint8Array() },
      {
        id: 'quebrado',
        bytes: new Uint8Array(Buffer.from('%PDF-1.4 isto não é um pdf')),
      },
      { id: 'bom', bytes: await pdfSintetico(1, 'OK') },
    ]);
    const job = await rodar(m, ['vazio', 'quebrado', 'bom']);
    expect(job.indice?.map((e) => [e.pecaId, e.situacao])).toEqual([
      ['vazio', 'nao_obtida'],
      ['quebrado', 'nao_obtida'],
      ['bom', 'incorporada'],
    ]);
    expect(job.arquivo?.paginas).toBe(3);
  });

  it('HTML do tribunal vira páginas de TEXTO (html_convertida), com o que ficou de fora no índice', async () => {
    const m = await montar([
      { id: 'a', bytes: await pdfSintetico(1, 'A') },
      {
        id: 'certidao',
        mimetype: 'text/html',
        bytes: new Uint8Array(Buffer.from(HTML_SINTETICO, 'utf8')),
      },
    ]);
    const job = await rodar(m, ['a', 'certidao']);

    expect(job.estado).toBe('pronto');
    const html = job.indice?.find((e) => e.pecaId === 'certidao');
    expect(html).toMatchObject({ situacao: 'html_convertida', paginaInicial: 2 });
    expect(html?.motivo).toContain('1 imagem não incluída');
    expect(html?.motivo).toContain('havia tabela');
    expect(html?.motivo).toContain(
      '1 caractere sem equivalente na fonte trocado por "?"',
    );
    expect(html?.motivo).toContain('elementos descartados: script');

    const texto = textoDoPdf(await bytesDoPdf(m, job));
    expect(texto).toContain('CERTIDÃO');
    expect(texto).toContain('decisão');
    expect(texto).toContain('art. 5º — ato nº 12 & seguintes');
    expect(texto).toContain('ação é válida');
    expect(texto).toContain('Prazo | 15 dias');
    expect(texto).toContain('Diferença ? zero.');
    expect(texto).toContain('tinha 1 imagem que não foi incluída');
  });

  it('o HTML cru nunca vai para o PDF, a resposta, o índice nem o log', async () => {
    const m = await montar([
      {
        id: 'certidao',
        mimetype: 'text/html',
        bytes: new Uint8Array(Buffer.from(HTML_SINTETICO, 'utf8')),
      },
    ]);
    const job = await rodar(m, ['certidao']);
    const texto = textoDoPdf(await bytesDoPdf(m, job));
    const bruto = (await bytesDoPdf(m, job)).toString('latin1');
    const json = JSON.stringify(job);
    const log = m.logger.linhas.join('\n');

    for (const proibido of [
      MARCADOR_SCRIPT,
      MARCADOR_ATRIBUTO,
      'iVBORw0KGgo',
      '<strong>',
      '&atilde;',
      'style=',
    ]) {
      expect(texto).not.toContain(proibido);
      expect(bruto).not.toContain(proibido);
      expect(json).not.toContain(proibido);
      expect(log).not.toContain(proibido);
    }
    // O texto VISÍVEL do ato também não vai para o índice nem para o log —
    // só para o PDF, que é onde ele deve estar.
    expect(json).not.toContain('Certifico');
    expect(log).not.toContain('Certifico');
    // E o arquivo de trabalho com o HTML não fica no disco depois da montagem.
    expect(await m.armazem.usoDoWorkspace(WS)).toBe(job.arquivo?.bytes);
  });

  it('HTML em windows-1252 (byte inválido em UTF-8) sai com o acento certo', async () => {
    const m = await montar([
      {
        id: 'antigo',
        mimetype: 'text/html',
        bytes: new Uint8Array(Buffer.from('<p>Certidão de intimação — ok</p>', 'latin1')),
      },
    ]);
    const job = await rodar(m, ['antigo']);
    expect(job.indice?.[0]?.situacao).toBe('html_convertida');
    expect(textoDoPdf(await bytesDoPdf(m, job))).toContain('Certidão de intimação');
  });

  it('peça sob sigilo não é baixada nem guardada', async () => {
    const m = await montar([
      { id: 'a', bytes: await pdfSintetico(1, 'A') },
      { id: 's', nivelSigilo: 5, bytes: await pdfSintetico(1, 'S') },
    ]);
    const job = await rodar(m, ['a', 's']);
    expect(m.provedor.lotes().flat()).not.toContain('s');
    expect(job.indice?.find((e) => e.pecaId === 's')?.situacao).toBe('nao_obtida');
  });

  it('processo em segredo de justiça não é guardado: o job falha sem arquivo', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'A') }]);
    m.provedor.nivelSigiloDoProcesso = 1;
    const job = await rodar(m, ['a']);
    expect(job.estado).toBe('falhou');
    expect(job.mensagem).toContain('segredo de justiça');
    expect(m.provedor.lotes()).toHaveLength(0);
    expect(await m.armazem.usoDoWorkspace(WS)).toBe(0);
  });

  it('peça pedida que sumiu da listagem fica no índice como não listada', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'A') }]);
    const job = await rodar(m, ['a', 'fantasma']);
    expect(job.indice?.map((e) => [e.pecaId, e.situacao])).toEqual([
      ['a', 'incorporada'],
      ['fantasma', 'nao_obtida'],
    ]);
  });
});

describe('ServicoLeitor — lotes', () => {
  async function muitas(n: number): Promise<PecaFalsa[]> {
    const pdf = await pdfSintetico(1, 'X');
    return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, bytes: pdf }));
  }

  it('o primeiro lote é de 5 e só dobra (10, 20) depois de ver resposta leve', async () => {
    const m = await montar(await muitas(45));
    await rodar(
      m,
      (await muitas(45)).map((p) => p.id),
    );
    expect(m.provedor.lotes().map((l) => l.length)).toEqual([5, 10, 20, 10]);
  });

  it('resposta média no primeiro lote mantém o lote em 5', async () => {
    // 6 MB com 5 peças: dobrar daria ~12 MB, no limite. Fica onde está.
    const m = await montar(await muitas(15));
    m.provedor.pesoDaResposta = () => 6 * 1_048_576;
    await rodar(
      m,
      (await muitas(15)).map((p) => p.id),
    );
    expect(m.provedor.lotes().map((l) => l.length)).toEqual([5, 5, 5]);
  });

  it('corta o lote pela metade quando a resposta passa do limite em MB, e não volta a crescer', async () => {
    const m = await montar(await muitas(40));
    // Primeira resposta leve (cresce para 10), segunda pesada; as outras, levíssimas.
    let n = 0;
    m.provedor.pesoDaResposta = () => (++n === 2 ? 13 * 1_048_576 : 1000);
    await rodar(
      m,
      (await muitas(40)).map((p) => p.id),
    );
    expect(m.provedor.lotes().map((l) => l.length)).toEqual([5, 10, 5, 5, 5, 5, 5]);
  });

  it('peça ausente numa resposta com sucesso é pedida UMA vez sozinha no fim', async () => {
    const m = await montar(await muitas(12));
    m.provedor.omitir.set('p3', 1); // falta no lote, vem quando pedida sozinha
    const job = await rodar(
      m,
      (await muitas(12)).map((p) => p.id),
    );

    expect(m.provedor.lotes()).toEqual([
      ['p1', 'p2', 'p3', 'p4', 'p5'],
      ['p6', 'p7', 'p8', 'p9', 'p10'],
      ['p11', 'p12'],
      ['p3'],
    ]);
    expect(job.estado).toBe('pronto');
  });

  it('peça que continua ausente sozinha vira nao_obtida (ausente_no_lote), sem terceira tentativa', async () => {
    const m = await montar(await muitas(3));
    m.provedor.omitir.set('p2', 99);
    const job = await rodar(m, ['p1', 'p2', 'p3']);

    expect(m.provedor.lotes()).toEqual([['p1', 'p2', 'p3'], ['p2']]);
    expect(job.estado).toBe('parcial');
    const p2 = job.indice?.find((e) => e.pecaId === 'p2');
    expect(p2?.situacao).toBe('nao_obtida');
    expect(p2?.motivo).toContain('nem pedida sozinha');
  });

  it('o lote não cresce depois de uma resposta com peça ausente', async () => {
    const m = await montar(await muitas(40));
    m.provedor.omitir.set('p1', 1);
    await rodar(
      m,
      (await muitas(40)).map((p) => p.id),
    );
    expect(m.provedor.lotes().map((l) => l.length)).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 1]);
  });

  it('respeita a pausa mínima de 3 s entre chamadas ao tribunal', async () => {
    const m = await montar(await muitas(25));
    await rodar(
      m,
      (await muitas(25)).map((p) => p.id),
    );
    const instantes = m.provedor.chamadas.map((c) => c.em);
    expect(instantes.length).toBeGreaterThan(2);
    for (let i = 1; i < instantes.length; i++) {
      expect((instantes[i] ?? 0) - (instantes[i - 1] ?? 0)).toBeGreaterThanOrEqual(3000);
    }
  });
});

describe('ServicoLeitor — interrupções (sem retry)', () => {
  async function tres(): Promise<PecaFalsa[]> {
    return [
      { id: 'a', bytes: await pdfSintetico(1, 'A') },
      { id: 'b', bytes: await pdfSintetico(1, 'B') },
      { id: 'c', bytes: await pdfSintetico(1, 'C') },
    ];
  }

  it('bloqueio do tribunal (403) pausa o job, sem repetir, e ele retoma sozinho depois', async () => {
    const m = await montar(await tres(), { inicial: 1, maximo: 1 });
    const retomarEm = new Date(m.clock.ms + 30 * 60_000);
    m.provedor.falharNoLote = { n: 2, erro: new MniBloqueadoError('mni', retomarEm) };

    const criado = await m.servico.criar(WS, PROCESSO_TJGO, ['a', 'b', 'c']);
    await m.servico.processarFila();
    let job = await m.servico.consultar(WS, PROCESSO_TJGO, criado.id);
    expect(job.estado).toBe('pausado_por_bloqueio');
    expect(job.retomarEm).toEqual(retomarEm);
    expect(m.provedor.lotes()).toEqual([['a'], ['b']]);

    // Antes da hora, a fila não o pega.
    await m.servico.processarFila();
    expect(m.provedor.lotes()).toHaveLength(2);

    m.clock.avancar(31 * 60_000);
    m.provedor.falharNoLote = undefined;
    await m.servico.processarFila();
    job = await m.servico.consultar(WS, PROCESSO_TJGO, criado.id);
    expect(job.estado).toBe('pronto');
    // Retomou de onde parou: `a` não foi pedida de novo.
    expect(m.provedor.lotes()).toEqual([['a'], ['b'], ['b'], ['c']]);
  });

  it('credencial recusada interrompe, marca a recusa e entrega o que veio como parcial', async () => {
    const m = await montar(await tres(), { inicial: 1, maximo: 1 });
    m.provedor.falharNoLote = {
      n: 2,
      erro: new CredencialTribunalInvalidaError('mni', 'Usuário ou Senha inválida.'),
    };
    const job = await rodar(m, ['a', 'b', 'c']);

    expect(job.estado).toBe('parcial');
    expect(m.provedor.lotes()).toEqual([['a'], ['b']]);
    expect(job.indice?.map((e) => e.situacao)).toEqual([
      'incorporada',
      'nao_obtida',
      'nao_obtida',
    ]);
    const [cred] = await m.credenciais.listar(WS);
    expect(cred?.recusadaEm).toBeDefined();
    // E não sai job novo com a credencial recusada.
    await expect(m.servico.criar(WS, PROCESSO_TJGO, ['a'])).rejects.toBeInstanceOf(
      CredencialTribunalInvalidaError,
    );
  });

  it('timeout ou 5xx: nenhuma repetição, o job termina parcial', async () => {
    const m = await montar(await tres(), { inicial: 2, maximo: 2 });
    m.provedor.falharNoLote = {
      n: 1,
      erro: new ProviderIndisponivelError('mni', 'timeout'),
    };
    const job = await rodar(m, ['a', 'b', 'c']);
    expect(m.provedor.lotes()).toHaveLength(1);
    expect(job.estado).toBe('parcial');
    expect(job.mensagem).toContain('timeout');
  });

  it('retoma depois de redeploy sem baixar de novo o que já veio', async () => {
    const m = await montar(await tres(), { inicial: 1, maximo: 1 });
    // Para o job depois do primeiro lote, com os arquivos de trabalho no disco.
    m.provedor.falharNoLote = {
      n: 2,
      erro: new MniBloqueadoError('mni', new Date(m.clock.ms + 60_000)),
    };
    const criado = await m.servico.criar(WS, PROCESSO_TJGO, ['a', 'b', 'c']);
    await m.servico.processarFila();
    const parado = await m.fila.obter(WS, criado.id);
    if (!parado) throw new Error('job sumiu');

    // O que um contêiner novo encontra quando o anterior morreu no meio do
    // download: o job gravado como `baixando`, `a` obtida, o resto pendente.
    const { retomarEm: _r, ...semRetomada } = parado;
    await m.fila.salvar({ ...semRetomada, estado: 'baixando' });
    m.provedor.falharNoLote = undefined;

    const novo = m.novoServico();
    await novo.processarFila();
    const final = await novo.consultar(WS, PROCESSO_TJGO, criado.id);
    expect(final.estado).toBe('pronto');
    expect(m.provedor.lotes()).toEqual([['a'], ['b'], ['b'], ['c']]);
    expect(m.provedor.chamadas.filter((c) => c.tipo === 'listar')).toHaveLength(1);
  });
});

describe('ServicoLeitor — guarda, cota e isolamento', () => {
  it('o workspace B nunca chega ao job nem ao arquivo do workspace A', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'A') }]);
    const job = await rodar(m, ['a']);
    await expect(
      m.servico.consultar('ws-b', PROCESSO_TJGO, job.id),
    ).rejects.toBeInstanceOf(JobDoLeitorNaoEncontradoError);
    await expect(
      m.servico.abrirPdf('ws-b', PROCESSO_TJGO, job.id),
    ).rejects.toBeInstanceOf(JobDoLeitorNaoEncontradoError);
    await expect(m.servico.indice('ws-b', PROCESSO_TJGO, job.id)).rejects.toBeInstanceOf(
      JobDoLeitorNaoEncontradoError,
    );
    // Mesmo com o localizador em mãos, o armazém do B não acha o arquivo do A.
    expect(
      await m.armazem.tamanho('ws-b', job.arquivo?.localizador ?? ''),
    ).toBeUndefined();
  });

  it('o prazo de guarda apaga o arquivo e marca o job como expirado', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'A') }]);
    const job = await rodar(m, ['a']);
    expect(await m.armazem.usoDoWorkspace(WS)).toBeGreaterThan(0);

    await m.servico.limparExpirados();
    expect((await m.servico.consultar(WS, PROCESSO_TJGO, job.id)).estado).toBe('pronto');

    m.clock.avancar(24 * 3_600_000 + 1);
    await m.servico.limparExpirados();
    const expirado = await m.servico.consultar(WS, PROCESSO_TJGO, job.id);
    expect(expirado.estado).toBe('expirado');
    expect(expirado.arquivo).toBeUndefined();
    expect(await m.armazem.usoDoWorkspace(WS)).toBe(0);
  });

  it('a exclusão da conta apaga arquivos e jobs do workspace', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'A') }]);
    const job = await rodar(m, ['a']);
    await m.servico.apagarDoWorkspace(WS);
    expect(await m.armazem.usoDoWorkspace(WS)).toBe(0);
    await expect(m.servico.consultar(WS, PROCESSO_TJGO, job.id)).rejects.toBeInstanceOf(
      JobDoLeitorNaoEncontradoError,
    );
  });

  it('cota por PDF estourada interrompe o download com erro claro', async () => {
    // Peça grande o bastante para as páginas de aviso pesarem pouco perto dela.
    const pdf = await pdfPesado(200_000, 'A');
    const m = await montar(
      [
        { id: 'a', bytes: pdf },
        { id: 'b', bytes: pdf },
        { id: 'c', bytes: pdf },
      ],
      // Cabe uma peça e as páginas de aviso; não cabem duas.
      { cotaPorPdfBytes: Math.floor(pdf.length * 1.5), inicial: 1, maximo: 1 },
    );
    const job = await rodar(m, ['a', 'b', 'c']);
    expect(job.estado).toBe('parcial');
    expect(job.mensagem).toContain('limite por arquivo');
    // O lote que estourou é descartado, e o seguinte nem é pedido.
    expect(m.provedor.lotes()).toEqual([['a'], ['b']]);
    expect(job.indice?.map((e) => e.situacao)).toEqual([
      'incorporada',
      'nao_obtida',
      'nao_obtida',
    ]);
  });

  it('cota do workspace cheia: o PDF mais antigo sai para abrir espaço, e o novo é montado', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'A') }], {
      cotaPorWorkspaceBytes: 1,
    });
    const antigo = await rodar(m, ['a']);
    await m.servico.criar(WS, PROCESSO_TJGO, ['a']);
    const depois = await m.servico.consultar(WS, PROCESSO_TJGO, antigo.id);
    expect(depois.estado).toBe('expirado');
    expect(depois.mensagem).toContain('abrir espaço');
    expect(m.logger.linhas.join('\n')).toContain('cota da conta');
  });

  it('cota cheia sem nada que possa sair: recusa antes de consultar o tribunal', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'A') }], {
      cotaPorWorkspaceBytes: 1,
    });
    const pronto = await rodar(m, ['a']);
    // Uma atualização na fila vai copiar páginas do PDF pronto: ele não sai.
    m.provedor.hashDocumentos = 'hash-2';
    await m.servico.atualizar(WS, PROCESSO_TJGO, pronto.id);
    const chamadas = m.provedor.chamadas.length;
    await expect(m.servico.criar(WS, PROCESSO_TJGO, ['a'])).rejects.toBeInstanceOf(
      LimiteDeArmazenamentoExcedidoError,
    );
    expect(m.provedor.chamadas).toHaveLength(chamadas);
    expect((await m.servico.consultar(WS, PROCESSO_TJGO, pronto.id)).estado).not.toBe(
      'expirado',
    );
  });

  it('a limpeza por cota tira primeiro o PDF de OUTRO processo, mesmo mais novo', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'A') }]);
    const desteProcesso = await rodar(m, ['a']);
    const usoDeste = await m.armazem.usoDoWorkspace(WS);
    // Um PDF de outro processo, mais NOVO, com 1000 bytes no disco.
    const idOutro = 'f'.repeat(32);
    const outro: JobLeitor = {
      ...desteProcesso,
      id: idOutro,
      numeroProcesso: OUTRO_PROCESSO_DIGITOS,
      arquivo: {
        localizador: await m.armazem.gravarPeca(WS, idOutro, 0, new Uint8Array(1000)),
        bytes: 1000,
        paginas: 1,
      },
      criadoEm: new Date(m.clock.agora().getTime() + 1000),
      concluidoEm: new Date(m.clock.agora().getTime() + 1000),
    };
    await m.fila.criar(outro);

    const servico = m.novoServico({ cotaPorWorkspaceBytes: usoDeste + 500 });
    await servico.criar(WS, PROCESSO_TJGO, ['a']);
    expect((await m.fila.obter(WS, idOutro))?.estado).toBe('expirado');
    expect((await m.servico.consultar(WS, PROCESSO_TJGO, desteProcesso.id)).estado).toBe(
      'pronto',
    );
  });

  it('a senha do advogado e o conteúdo das peças nunca vão para o log', async () => {
    const m = await montar([
      { id: 'a', bytes: new Uint8Array(Buffer.from('%PDF-1.4 CONTEUDO-DA-PECA-XYZ')) },
    ]);
    m.provedor.falharNoLote = {
      n: 1,
      erro: new CredencialTribunalInvalidaError('mni', 'Usuário ou Senha inválida.'),
    };
    await rodar(m, ['a']);
    const log = m.logger.linhas.join('\n');
    expect(log).not.toContain(SENHA);
    expect(log).not.toContain('CONTEUDO-DA-PECA');
    expect(log).not.toContain('00000000000');
  });
});

describe('ServicoLeitor — atualizar', () => {
  it('sem mudança no tribunal (mesmo hash), não baixa nada', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'A') }]);
    const job = await rodar(m, ['a']);
    const antes = m.provedor.lotes().length;
    const r = await m.servico.atualizar(WS, PROCESSO_TJGO, job.id);
    expect(r.semMudanca).toBe(true);
    expect(r.job.id).toBe(job.id);
    expect(m.provedor.lotes()).toHaveLength(antes);
  });

  it('com peça nova, baixa SÓ a nova e reaproveita as páginas do PDF anterior', async () => {
    const m = await montar([
      { id: 'a', bytes: await pdfSintetico(2, 'PECA-A') },
      { id: 'b', bytes: await pdfSintetico(1, 'PECA-B') },
    ]);
    const primeiro = await rodar(m, ['a', 'b']);

    m.provedor.pecas.push({ id: 'c', bytes: await pdfSintetico(3, 'PECA-C') });
    m.provedor.hashDocumentos = 'hash-2';
    const { job: criado, semMudanca } = await m.servico.atualizar(
      WS,
      PROCESSO_TJGO,
      primeiro.id,
    );
    expect(semMudanca).toBe(false);
    await m.servico.processarFila();
    const novo = await m.servico.consultar(WS, PROCESSO_TJGO, criado.id);

    expect(m.provedor.lotes().at(-1)).toEqual(['c']);
    expect(novo.estado).toBe('pronto');
    expect(novo.indice?.map((e) => [e.pecaId, e.paginaInicial, e.paginaFinal])).toEqual([
      ['a', 1, 2],
      ['b', 3, 3],
      ['c', 4, 6],
    ]);
    expect(await marcasDasPaginas(await bytesDoPdf(m, novo))).toEqual([
      'PECA-A-p1',
      'PECA-A-p2',
      'PECA-B-p1',
      'PECA-C-p1',
      'PECA-C-p2',
      'PECA-C-p3',
    ]);
    // O PDF anterior foi substituído e saiu do disco.
    expect((await m.servico.consultar(WS, PROCESSO_TJGO, primeiro.id)).estado).toBe(
      'expirado',
    );
  });
});

describe('ServicoLeitor — seleção nova (remarcar)', () => {
  it('peça que já está num PDF guardado NÃO volta ao tribunal: só a nova é baixada', async () => {
    const m = await montar([
      { id: 'a', bytes: await pdfSintetico(2, 'PECA-A') },
      { id: 'b', bytes: await pdfSintetico(1, 'PECA-B') },
      { id: 'c', bytes: await pdfSintetico(1, 'PECA-C') },
    ]);
    await rodar(m, ['a', 'b']);
    const lotesAntes = m.provedor.lotes().length;

    const novo = await rodar(m, ['b', 'c']);
    expect(m.provedor.lotes().slice(lotesAntes)).toEqual([['c']]);
    expect(novo.estado).toBe('pronto');
    expect(novo.indice?.map((e) => [e.pecaId, e.paginaInicial, e.paginaFinal])).toEqual([
      ['b', 1, 1],
      ['c', 2, 2],
    ]);
    expect(await marcasDasPaginas(await bytesDoPdf(m, novo))).toEqual([
      'PECA-B-p1',
      'PECA-C-p1',
    ]);
  });

  it('a seleção nova gera PDF NOVO e o anterior continua até o próprio prazo', async () => {
    const m = await montar([
      { id: 'a', bytes: await pdfSintetico(1, 'PECA-A') },
      { id: 'b', bytes: await pdfSintetico(1, 'PECA-B') },
    ]);
    const primeiro = await rodar(m, ['a', 'b']);
    const segundo = await rodar(m, ['a']);
    expect(segundo.id).not.toBe(primeiro.id);
    expect((await m.servico.consultar(WS, PROCESSO_TJGO, primeiro.id)).estado).toBe(
      'pronto',
    );
    expect(await marcasDasPaginas(await bytesDoPdf(m, primeiro))).toEqual([
      'PECA-A-p1',
      'PECA-B-p1',
    ]);
    const g = await m.servico.guardadosDoProcesso(WS, PROCESSO_TJGO);
    expect(g.pronto?.id).toBe(segundo.id);
    expect([...g.reaproveitaveis].sort()).toEqual(['a', 'b']);
  });

  it('PDF vencido não serve de origem: a peça é baixada de novo', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'PECA-A') }]);
    await rodar(m, ['a']);
    m.clock.avancar(24 * 3_600_000 + 1);
    const antes = m.provedor.lotes().length;
    await rodar(m, ['a']);
    expect(m.provedor.lotes().slice(antes)).toEqual([['a']]);
  });

  it('origem apagada entre a listagem e a montagem vira página de aviso, não erro', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'PECA-A') }]);
    const primeiro = await rodar(m, ['a']);
    const job = await m.servico.criar(WS, PROCESSO_TJGO, ['a']);
    // A origem some logo depois da listagem, antes da montagem.
    const salvar = m.fila.salvar.bind(m.fila);
    m.fila.salvar = async (j) => {
      await salvar(j);
      if (j.id === job.id && j.estado === 'baixando' && j.pecas.length > 0) {
        await m.armazem.apagarJob(WS, primeiro.id);
      }
    };
    await m.servico.processarFila();
    const novo = await m.servico.consultar(WS, PROCESSO_TJGO, job.id);
    expect(novo.estado).toBe('parcial');
    expect(novo.indice?.[0]).toMatchObject({ pecaId: 'a', situacao: 'nao_obtida' });
    expect(novo.indice?.[0]?.motivo).toContain('marque-a de novo');
  });

  it('a limpeza do prazo espera a combinação que ainda vai copiar páginas do PDF', async () => {
    const m = await montar([{ id: 'a', bytes: await pdfSintetico(1, 'PECA-A') }]);
    const primeiro = await rodar(m, ['a']);
    m.provedor.hashDocumentos = 'hash-2';
    await m.servico.atualizar(WS, PROCESSO_TJGO, primeiro.id);
    m.clock.avancar(24 * 3_600_000 + 1);
    await m.servico.limparExpirados();
    expect((await m.servico.consultar(WS, PROCESSO_TJGO, primeiro.id)).estado).toBe(
      'pronto',
    );
  });
});

describe('ServicoLeitor — baixar só algumas (recorte)', () => {
  async function pronto(): Promise<{ m: Montagem; job: JobLeitor }> {
    const m = await montar([
      { id: 'a', bytes: await pdfSintetico(2, 'PECA-A') },
      { id: 'b', bytes: await pdfSintetico(1, 'PECA-B') },
      { id: 'c', bytes: await pdfSintetico(3, 'PECA-C') },
    ]);
    return { m, job: await rodar(m, ['a', 'b', 'c']) };
  }

  async function bytesDoExtrato(m: Montagem, jobId: string, id: string): Promise<Buffer> {
    const pdf = await m.servico.abrirExtrato(WS, PROCESSO_TJGO, jobId, id);
    const pedacos: Buffer[] = [];
    for await (const p of pdf.ler(0, pdf.tamanho - 1)) pedacos.push(Buffer.from(p));
    return Buffer.concat(pedacos);
  }

  it('recorta as páginas do PDF guardado, na ordem dos autos, sem consultar o tribunal', async () => {
    const { m, job } = await pronto();
    const chamadas = m.provedor.chamadas.length;
    const { extrato } = await m.servico.extrair(WS, PROCESSO_TJGO, job.id, ['c', 'a']);

    expect(m.provedor.chamadas).toHaveLength(chamadas);
    expect(extrato.paginas).toBe(5);
    expect(extrato.indice.map((e) => [e.pecaId, e.paginaInicial, e.paginaFinal])).toEqual(
      [
        ['a', 1, 2],
        ['c', 3, 5],
      ],
    );
    const bytes = await bytesDoExtrato(m, job.id, extrato.id);
    expect(await marcasDasPaginas(bytes)).toEqual([
      'PECA-A-p1',
      'PECA-A-p2',
      'PECA-C-p1',
      'PECA-C-p2',
      'PECA-C-p3',
    ]);
    // Linearizado, como o combinado: o PDF.js lê por trechos.
    expect(bytes.subarray(0, 1024).toString('latin1')).toContain('/Linearized');
    const pdf = await m.servico.abrirExtrato(WS, PROCESSO_TJGO, job.id, extrato.id);
    expect(pdf.nomeArquivo).toBe(
      `processo-${PROCESSO_TJGO_DIGITOS}-pecas-selecionadas.pdf`,
    );
  });

  it('o workspace B nunca recorta nem lê o recorte do workspace A', async () => {
    const { m, job } = await pronto();
    const { extrato } = await m.servico.extrair(WS, PROCESSO_TJGO, job.id, ['b']);
    await expect(
      m.servico.extrair('ws-b', PROCESSO_TJGO, job.id, ['b']),
    ).rejects.toBeInstanceOf(JobDoLeitorNaoEncontradoError);
    await expect(
      m.servico.abrirExtrato('ws-b', PROCESSO_TJGO, job.id, extrato.id),
    ).rejects.toBeInstanceOf(JobDoLeitorNaoEncontradoError);
    expect(await m.armazem.tamanho('ws-b', extrato.localizador)).toBeUndefined();
  });

  it('PDF original vencido: diz que expirou e NÃO baixa de novo', async () => {
    const { m, job } = await pronto();
    m.clock.avancar(24 * 3_600_000 + 1);
    await m.servico.limparExpirados();
    const chamadas = m.provedor.chamadas.length;
    await expect(
      m.servico.extrair(WS, PROCESSO_TJGO, job.id, ['a']),
    ).rejects.toBeInstanceOf(PdfDoLeitorExpiradoError);
    expect(m.provedor.chamadas).toHaveLength(chamadas);
  });

  it('o recorte sai do disco junto com o combinado, no fim do prazo', async () => {
    const { m, job } = await pronto();
    const { extrato } = await m.servico.extrair(WS, PROCESSO_TJGO, job.id, ['a']);
    m.clock.avancar(24 * 3_600_000 + 1);
    await m.servico.limparExpirados();
    expect(await m.armazem.tamanho(WS, extrato.localizador)).toBeUndefined();
    await expect(
      m.servico.abrirExtrato(WS, PROCESSO_TJGO, job.id, extrato.id),
    ).rejects.toBeInstanceOf(PdfDoLeitorExpiradoError);
    expect(await m.armazem.usoDoWorkspace(WS)).toBe(0);
  });

  it('peça que não está no PDF é recusada; a página de aviso de uma peça faltante vai junto', async () => {
    const m = await montar([
      { id: 'a', bytes: await pdfSintetico(1, 'PECA-A') },
      { id: 'b' }, // sem teor: página de aviso no combinado
    ]);
    const job = await rodar(m, ['a', 'b']);
    await expect(
      m.servico.extrair(WS, PROCESSO_TJGO, job.id, ['a', 'zzz']),
    ).rejects.toBeInstanceOf(PecasForaDoPdfError);
    const { extrato } = await m.servico.extrair(WS, PROCESSO_TJGO, job.id, ['b']);
    expect(extrato.indice).toEqual([
      expect.objectContaining({ pecaId: 'b', situacao: 'nao_obtida', paginaInicial: 1 }),
    ]);
  });

  it('cota do workspace vale para o recorte', async () => {
    const { m, job } = await pronto();
    const uso = await m.armazem.usoDoWorkspace(WS);
    const servico = m.novoServico({ cotaPorWorkspaceBytes: uso + 10 });
    await expect(
      servico.extrair(WS, PROCESSO_TJGO, job.id, ['a', 'b', 'c']),
    ).rejects.toBeInstanceOf(LimiteDeArmazenamentoExcedidoError);
    // O arquivo que estourou não fica no disco.
    expect(await m.armazem.usoDoWorkspace(WS)).toBe(uso);
  });

  it('guarda no máximo 3 recortes por PDF; o mais antigo sai do disco', async () => {
    const { m, job } = await pronto();
    const primeiro = (await m.servico.extrair(WS, PROCESSO_TJGO, job.id, ['a'])).extrato;
    for (const id of ['b', 'c', 'a'])
      await m.servico.extrair(WS, PROCESSO_TJGO, job.id, [id]);
    const salvo = await m.servico.consultar(WS, PROCESSO_TJGO, job.id);
    expect(salvo.extratos).toHaveLength(3);
    expect(await m.armazem.tamanho(WS, primeiro.localizador)).toBeUndefined();
    // O combinado continua lá.
    expect(await m.armazem.tamanho(WS, job.arquivo?.localizador ?? '')).toBeGreaterThan(
      0,
    );
  });
});

describe('ServicoLeitor — um job por vez no processo inteiro', () => {
  it('dois jobs de credenciais diferentes nunca baixam ao mesmo tempo, nem em instâncias diferentes', async () => {
    // Duas montagens independentes (banco, credencial, fila e instância de
    // serviço próprios): só o MÓDULO é comum. Se a trava fosse da instância,
    // os dois lotes correriam juntos e os picos de memória somariam.
    let ativos = 0;
    let maximo = 0;
    const lento = (m: Montagem): void => {
      const original = m.provedor.obterConteudosEmLote.bind(m.provedor);
      m.provedor.obterConteudosEmLote = async (...args) => {
        ativos += 1;
        maximo = Math.max(maximo, ativos);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        ativos -= 1;
        return original(...args);
      };
    };
    const pdf = await pdfSintetico(1, 'X');
    const pecas = ['a', 'b', 'c'].map((id) => ({ id, bytes: pdf }));
    const m1 = await montar(pecas, { inicial: 1, maximo: 1 });
    const m2 = await montar(pecas, { inicial: 1, maximo: 1 });
    lento(m1);
    lento(m2);
    const j1 = await m1.servico.criar(WS, PROCESSO_TJGO, ['a', 'b', 'c']);
    const j2 = await m2.servico.criar(WS, PROCESSO_TJGO, ['a', 'b', 'c']);

    await Promise.all([m1.servico.processarFila(), m2.servico.processarFila()]);

    expect(maximo).toBe(1);
    expect((await m1.servico.consultar(WS, PROCESSO_TJGO, j1.id)).estado).toBe('pronto');
    expect((await m2.servico.consultar(WS, PROCESSO_TJGO, j2.id)).estado).toBe('pronto');
  });

  it('o composition root monta UMA instância do leitor', () => {
    const raiz = readFileSync(
      new URL('../../src/main/factories/makeProcessoSearchService.ts', import.meta.url),
      'utf8',
    );
    expect(raiz.match(/new ServicoLeitor\(/g)).toHaveLength(1);
  });
});

describe('ServicoLeitor — um único limitador', () => {
  it('não tem balde próprio: o código do leitor não conhece rate limiter', () => {
    // Se alguém der ao leitor um balde próprio, este teste falha. Dois baldes
    // somam acima do teto relatado do tribunal, e o bloqueio é do IP.
    const fonte = readFileSync(
      new URL('../../src/application/services/ServicoLeitor.ts', import.meta.url),
      'utf8',
    );
    expect(fonte).not.toMatch(/RateLimiter|TokenBucket/);
    const raiz = readFileSync(
      new URL('../../src/main/factories/makeProcessoSearchService.ts', import.meta.url),
      'utf8',
    );
    expect(raiz.match(/new MniAdapter\(/g)).toHaveLength(1);
    expect(raiz.match(/new TokenBucketRateLimiter\(/g) ?? []).toHaveLength(0);
  });
});
