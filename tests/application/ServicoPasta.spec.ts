import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuardaDePecas } from '../../src/application/services/GuardaDePecas.js';
import { ServicoLeitor } from '../../src/application/services/ServicoLeitor.js';
import type { ConfiguracaoLeitor } from '../../src/application/services/ServicoLeitor.js';
import { ServicoPasta } from '../../src/application/services/ServicoPasta.js';
import type { VisaoDaPeca } from '../../src/application/services/ServicoPasta.js';
import type { JobLeitor } from '../../src/domain/entities/JobLeitor.js';
import {
  CredencialTribunalInvalidaError,
  ListagemDaPastaAusenteError,
  MniBloqueadoError,
  PastaSemPecasParaJuntarError,
  PecaDaPastaNaoEncontradaError,
  PecaSigilosaNaoGuardadaError,
  ProviderIndisponivelError,
  SegredoDeJusticaNaoGuardadoError,
  SemHabilitacaoNosAutosError,
} from '../../src/domain/errors/index.js';
import type { Logger } from '../../src/domain/ports/Logger.js';
import type { BuscarProcessoPorNumero } from '../../src/domain/usecases/BuscarProcessoPorNumero.js';
import { ArmazemEmDisco } from '../../src/infrastructure/arquivos/ArmazemEmDisco.js';
import { QpdfMontador } from '../../src/infrastructure/pdf/QpdfMontador.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { FilaDeJobsSqlite } from '../../src/infrastructure/persistencia/sqlite/FilaDeJobsSqlite.js';
import { RepositorioCredenciaisSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioCredenciaisSqlite.js';
import { RepositorioDaPastaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDaPastaSqlite.js';
import { Cofre } from '../../src/infrastructure/seguranca/cofre.js';
import { CONFIG_LEITOR_DE_TESTE } from '../helpers/aplicacao.js';
import {
  ClockFalso,
  HTML_SINTETICO,
  MARCADOR_ATRIBUTO,
  MARCADOR_SCRIPT,
  PNG_1X1,
  PROCESSO_TJGO,
  PROCESSO_TJGO_DIGITOS,
  ProvedorDeLoteFalso,
  marcasDasPaginas,
  pastaTemporaria,
  pdfPesado,
  pdfSintetico,
  textoDoPdf,
} from '../helpers/leitor.js';
import type { PecaFalsa } from '../helpers/leitor.js';

const A = 'ws-advogada-a';
const B = 'ws-advogado-b';
const SENHA = 'senha-do-projudi-123';

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
  readonly pasta: ServicoPasta;
  readonly leitor: ServicoLeitor;
  readonly guarda: GuardaDePecas;
  readonly provedor: ProvedorDeLoteFalso;
  readonly clock: ClockFalso;
  readonly credenciais: RepositorioCredenciaisSqlite;
  readonly fila: FilaDeJobsSqlite;
  readonly armazem: ArmazemEmDisco;
  readonly repositorio: RepositorioDaPastaSqlite;
  readonly db: ReturnType<typeof abrirBanco>;
  readonly logger: LoggerGravador;
  /** As esperas do debounce (em ms), na ordem. */
  readonly debounces: number[];
  /** Fecha o portão: o debounce só termina quando `abrir()` for chamado. */
  fecharPortao(): void;
  abrir(): void;
  registrarListagem(ws?: string): Promise<void>;
  visao(ws?: string): Promise<readonly VisaoDaPeca[]>;
  peca(id: string, ws?: string): Promise<VisaoDaPeca>;
}

let dir: ReturnType<typeof pastaTemporaria>;
beforeEach(() => {
  dir = pastaTemporaria();
});
afterEach(() => {
  dir.apagar();
});

async function montar(
  pecas: PecaFalsa[],
  config: Partial<ConfiguracaoLeitor> = {},
  opcoes: { processos?: BuscarProcessoPorNumero } = {},
): Promise<Montagem> {
  const db = abrirBanco(':memory:');
  const clock = new ClockFalso();
  const credenciais = new RepositorioCredenciaisSqlite(
    db,
    Cofre.comChaveBase64(Cofre.gerarChaveBase64()),
  );
  for (const ws of [A, B]) {
    await credenciais.salvar(ws, {
      tribunal: 'TJGO',
      identificacao: '00000000000',
      senha: SENHA,
    });
  }
  const provedor = new ProvedorDeLoteFalso(pecas, clock);
  const fila = new FilaDeJobsSqlite(db);
  const armazem = new ArmazemEmDisco(dir.caminho);
  const repositorio = new RepositorioDaPastaSqlite(db);
  const logger = new LoggerGravador();
  const montador = new QpdfMontador();
  const cfg = { ...CONFIG_LEITOR_DE_TESTE, ...config };
  const guarda = new GuardaDePecas({
    repositorio,
    armazem,
    montador,
    logger,
    clock,
    ttlMs: cfg.ttlMs,
  });
  let seq = 0;
  const leitor = new ServicoLeitor({
    provedor,
    credenciais,
    fila,
    armazem,
    montador,
    guarda,
    logger,
    clock,
    // A pausa entre chamadas é medida no relógio falso.
    esperar: async (ms) => clock.avancar(ms),
    gerarId: () => (++seq).toString(16).padStart(32, 'a'),
    identificarCredencial: () => 'cred1234',
    config: cfg,
    ...(opcoes.processos ? { processos: opcoes.processos } : {}),
  });

  const debounces: number[] = [];
  let portao: Promise<void> = Promise.resolve();
  let abrir: () => void = () => {};
  const pasta = new ServicoPasta({
    leitor,
    guarda,
    repositorio,
    fila,
    armazem,
    logger,
    clock,
    debounceMs: 400,
    esperar: async (ms) => {
      debounces.push(ms);
      await portao;
      clock.avancar(ms);
    },
  });

  const m: Montagem = {
    pasta,
    leitor,
    guarda,
    provedor,
    clock,
    credenciais,
    fila,
    armazem,
    repositorio,
    db,
    logger,
    debounces,
    fecharPortao: () => {
      portao = new Promise<void>((r) => {
        abrir = r;
      });
    },
    abrir: () => abrir(),
    // O que a tela do processo faz ao carregar as peças: o tribunal lista, e a
    // listagem é registrada na Pasta.
    registrarListagem: async (ws = A) => {
      await pasta.registrarListagem(ws, PROCESSO_TJGO, await provedor.listarAtos());
    },
    visao: async (ws = A) => (await pasta.visao(ws, PROCESSO_TJGO)).pecas,
    peca: async (id, ws = A) => {
      const p = (await pasta.visao(ws, PROCESSO_TJGO)).pecas.find((x) => x.pecaId === id);
      if (!p) throw new Error(`peça ${id} fora da visão`);
      return p;
    },
  };
  return m;
}

/** O que o tribunal falso entrega: três PDFs, um HTML, uma imagem, uma sem teor, uma sigilosa. */
async function pecasPadrao(): Promise<PecaFalsa[]> {
  return [
    {
      id: 'a',
      rotulo: 'Petição inicial',
      bytes: await pdfSintetico(2, 'A'),
      movimento: 1,
    },
    { id: 'b', rotulo: 'Procuração', bytes: await pdfSintetico(1, 'B'), movimento: 1 },
    {
      id: 'h',
      rotulo: 'Certidão',
      mimetype: 'text/html',
      bytes: new TextEncoder().encode(HTML_SINTETICO),
      movimento: 2,
    },
    { id: 'i', rotulo: 'Foto', mimetype: 'image/png', bytes: PNG_1X1, movimento: 3 },
    { id: 'c', rotulo: 'Contestação' },
    {
      id: 's',
      rotulo: 'Laudo sigiloso',
      bytes: await pdfSintetico(1, 'S'),
      nivelSigilo: 1,
    },
  ];
}

function lotes(m: Montagem): Array<readonly string[]> {
  return m.provedor.lotes();
}

function arquivosEmDisco(): string[] {
  const saida: string[] = [];
  const andar = (d: string): void => {
    for (const e of readdirSync(d)) {
      const c = join(d, e);
      if (statSync(c).isDirectory()) andar(c);
      else saida.push(c);
    }
  };
  andar(dir.caminho);
  return saida;
}

async function lerTudo(arquivo: {
  tamanho: number;
  ler(i: number, f: number): AsyncIterable<Uint8Array>;
}): Promise<Uint8Array> {
  const partes: Uint8Array[] = [];
  if (arquivo.tamanho > 0) {
    for await (const p of arquivo.ler(0, arquivo.tamanho - 1)) partes.push(p);
  }
  return Buffer.concat(partes);
}

describe('ServicoPasta — a lista', () => {
  it('sem listagem do tribunal, a visão diz isso e o pedido de peça não é aceito', async () => {
    const m = await montar(await pecasPadrao());
    const v = await m.pasta.visao(A, PROCESSO_TJGO);
    expect(v.listagem).toBeUndefined();
    expect(v.pecas).toEqual([]);
    await expect(m.pasta.solicitar(A, PROCESSO_TJGO, 'a')).rejects.toBeInstanceOf(
      ListagemDaPastaAusenteError,
    );
    expect(lotes(m)).toEqual([]);
  });

  it('lista todas as peças na ordem dos autos, com o estado de cada uma, sem consultar o tribunal', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    const chamadasAntes = m.provedor.chamadas.length;

    const v = await m.pasta.visao(A, PROCESSO_TJGO);
    expect(v.pecas.map((p) => p.pecaId)).toEqual(['a', 'b', 'h', 'i', 'c', 's']);
    expect(v.pecas.map((p) => p.estado)).toEqual([
      'nao_baixada',
      'nao_baixada',
      'nao_baixada',
      'nao_baixada',
      'nao_baixada',
      'sigilo',
    ]);
    expect(v.pecas[5]?.motivo).toBe('sigilosa');
    expect(v.listagem?.tribunal).toBe('TJGO');
    // Abrir a lista não custa uma consulta ao tribunal.
    expect(m.provedor.chamadas.length).toBe(chamadasAntes);
  });

  it('pendura cada peça no ato do tribunal pelo identificador, e a listagem gravada antes (sem ato) segue como era', async () => {
    const m = await montar(await pecasPadrao());
    m.provedor.movimentos = [
      {
        data: new Date('2026-09-28T13:00:00Z'),
        titulo: 'Juntada de documento (ev. 382)',
        complementos: ['  tipo: x  ', ' '],
        idExterno: 'mni:1',
        fonte: 'mni',
      },
      // Sem identificador: conta na posição dos outros, mas não se liga a peça.
      { data: new Date('2026-09-29T13:00:00Z'), titulo: 'Sem número', fonte: 'mni' },
    ];
    await m.registrarListagem();
    const v = await m.pasta.visao(A, PROCESSO_TJGO);
    const a = v.pecas.find((p) => p.pecaId === 'a');
    expect(a?.movimentacao).toEqual({
      numero: 1,
      posicao: 1,
      data: new Date('2026-09-28T13:00:00Z'),
      descricao: 'Juntada de documento (ev. 382)',
      complemento: 'tipo: x',
    });
    expect(v.pecas.find((p) => p.pecaId === 'b')?.movimentacao?.numero).toBe(1);
    expect(v.totalAtosRecebidos).toBe(2);
    // Peça sem `movimento` na ficha: sem bloco, nada inventado.
    expect(v.pecas.find((p) => p.pecaId === 'c')?.movimentacao).toBeUndefined();

    // Listagem sem ato (como as gravadas antes da 0.33.2): a visão não muda.
    m.provedor.movimentos = [];
    await m.registrarListagem();
    const depois = await m.pasta.visao(A, PROCESSO_TJGO);
    expect(depois.pecas.every((p) => p.movimentacao === undefined)).toBe(true);
    expect(depois.pecas.map((p) => p.pecaId)).toEqual(v.pecas.map((p) => p.pecaId));
    expect(depois.totalAtosRecebidos).toBeUndefined();
  });

  it('listagem gravada antes da 0.34.0 (sem posição nem total) lê sem erro e some os campos novos', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    // Retrato como a 0.33.3 gravou: ato com identificador e sem `posicao`, coluna nula.
    const antigo = JSON.stringify([
      {
        pecaId: 'a',
        ordem: 0,
        rotulo: 'Petição',
        sigilosa: false,
        movimento: 1,
        movimentacao: { numero: 1, data: '2026-09-28T13:00:00.000Z', descricao: 'Ato' },
      },
    ]);
    m.db
      .prepare(
        'UPDATE pasta_listagens SET pecas = ?, total_atos_recebidos = NULL WHERE workspace = ?',
      )
      .run(antigo, A);
    const v = await m.pasta.visao(A, PROCESSO_TJGO);
    expect(v.totalAtosRecebidos).toBeUndefined();
    expect(v.pecas[0]?.movimentacao?.posicao).toBeUndefined();
    expect(v.pecas[0]?.movimentacao?.descricao).toBe('Ato');
  });

  it('informa a pausa do tribunal (403) sem bater na porta fechada', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    m.provedor.pausa = new Date('2026-10-01T12:30:00.000Z');
    const v = await m.pasta.visao(A, PROCESSO_TJGO);
    expect(v.pausadoAte?.toISOString()).toBe('2026-10-01T12:30:00.000Z');
  });
});

describe('ServicoPasta — abrir UMA peça', () => {
  it('baixa só aquela peça (lote de 1), guarda como PDF e abre', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();

    const r = await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    expect(r.estado).toBe('na_fila');
    await m.pasta.aguardarOciosa();

    expect(lotes(m)).toEqual([['a']]);
    const p = await m.peca('a');
    expect(p).toMatchObject({
      estado: 'disponivel',
      paginasDaPeca: 2,
      conversao: 'nenhuma',
    });
    expect(p.obtidaEm).toEqual(m.clock.agora());
    expect(p.expiraEm?.getTime()).toBe(p.obtidaEm!.getTime() + 24 * 3_600_000);

    const arq = await m.pasta.abrirPeca(A, PROCESSO_TJGO, 'a');
    expect(arq.baixadoEm).toEqual(p.obtidaEm);
    expect(await marcasDasPaginas(await lerTudo(arq))).toEqual(['A-p1', 'A-p2']);
    // O resto da lista não mexeu.
    expect((await m.peca('b')).estado).toBe('nao_baixada');
  });

  it('peça já guardada abre sem nenhuma chamada ao tribunal', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    const chamadas = m.provedor.chamadas.length;

    const de_novo = await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();

    expect(de_novo.estado).toBe('disponivel');
    expect(m.provedor.chamadas.length).toBe(chamadas);
  });

  it('cliques em sequência rápida: os intermediários morrem antes do tribunal e só o último vai', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();

    m.fecharPortao();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'b');
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'h');
    // Os dois primeiros já foram trocados: a lista diz isso.
    expect((await m.peca('a')).substituida).toBe(true);
    expect((await m.peca('a')).estado).toBe('nao_baixada');
    expect((await m.peca('h')).estado).toBe('na_fila');

    m.abrir();
    await m.pasta.aguardarOciosa();

    expect(lotes(m)).toEqual([['h']]);
    expect((await m.peca('h')).estado).toBe('disponivel');
    expect((await m.peca('a')).estado).toBe('nao_baixada');
    expect((await m.peca('b')).estado).toBe('nao_baixada');
    // O debounce reiniciou quando o pedido mudou.
    expect(m.debounces.every((ms) => ms === 400)).toBe(true);
  });

  it('o mesmo clique repetido não vira pedido novo nem reinicia a janela', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    m.fecharPortao();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    m.abrir();
    await m.pasta.aguardarOciosa();
    expect(lotes(m)).toEqual([['a']]);
    expect(m.debounces).toEqual([400]);
  });

  it('no máximo uma chamada por janela de 3 s, mesmo com um clique atrás do outro', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();

    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'b');
    await m.pasta.aguardarOciosa();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'h');
    await m.pasta.aguardarOciosa();

    const instantes = m.provedor.chamadas
      .filter((c) => c.tipo === 'lote')
      .map((c) => c.em);
    expect(instantes).toHaveLength(3);
    expect(instantes[1]! - instantes[0]!).toBeGreaterThanOrEqual(3000);
    expect(instantes[2]! - instantes[1]!).toBeGreaterThanOrEqual(3000);
  });

  it('um clique no meio de um job do leitor respeita a MESMA pausa: nenhuma chamada colada na outra', async () => {
    const m = await montar(await pecasPadrao(), { inicial: 1, maximo: 1 });
    await m.registrarListagem();
    await m.pasta.montar(A, PROCESSO_TJGO);

    // O job anda (um lote por peça) e, ao mesmo tempo, a pessoa clica numa peça
    // que o job ainda não buscou: as duas fontes de chamada dividem a fila.
    let clicou = false;
    m.provedor.aoLote = async (n) => {
      if (n === 1 && !clicou) {
        clicou = true;
        await m.pasta.solicitar(A, PROCESSO_TJGO, 'i');
      }
    };
    await m.leitor.processarFila();
    await m.pasta.aguardarOciosa();

    const instantes = m.provedor.chamadas
      .filter((c) => c.tipo === 'lote' || c.tipo === 'listar' || c.tipo === 'alteracao')
      .map((c) => c.em);
    for (let i = 1; i < instantes.length; i += 1) {
      expect(instantes[i]! - instantes[i - 1]!).toBeGreaterThanOrEqual(0);
    }
    const dosLotes = m.provedor.chamadas
      .filter((c) => c.tipo === 'lote')
      .map((c) => c.em);
    for (let i = 1; i < dosLotes.length; i += 1) {
      expect(dosLotes[i]! - dosLotes[i - 1]!).toBeGreaterThanOrEqual(3000);
    }
  });

  it('clique no meio de um job: espera a vez ("na fila"), só vira "baixando" quando a consulta sai, e a peça não é baixada duas vezes', async () => {
    const m = await montar(await pecasPadrao(), { inicial: 1, maximo: 1 });
    await m.registrarListagem();
    await m.pasta.montar(A, PROCESSO_TJGO);

    let soltar: () => void = () => {};
    const portao = new Promise<void>((r) => {
      soltar = r;
    });
    m.provedor.aoLote = async (n) => {
      if (n === 1) await portao; // o 1º lote do job fica no ar até o teste soltar
    };
    const job = m.leitor.processarFila();
    while (lotes(m).length < 1) await new Promise((r) => setTimeout(r, 5));

    await m.pasta.solicitar(A, PROCESSO_TJGO, 'i');
    await new Promise((r) => setTimeout(r, 30)); // o despacho já tentou sair
    // Pedido despachado, mas a consulta espera a do job: NÃO é "baixando".
    expect((await m.peca('i')).estado).toBe('na_fila');
    expect(lotes(m)).toEqual([['a']]);

    soltar();
    await job;
    await m.pasta.aguardarOciosa();
    expect((await m.peca('i')).estado).toBe('disponivel');
    // "i" foi ao tribunal UMA vez, por um dos dois caminhos.
    expect(
      lotes(m)
        .flat()
        .filter((id) => id === 'i'),
    ).toHaveLength(1);
  });

  it('403 do tribunal: a peça fica pausada com a hora de volta, e não há nova tentativa sozinha', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    const volta = new Date('2026-10-01T12:45:00.000Z');
    m.provedor.falharNoLote = { n: 1, erro: new MniBloqueadoError('mni', volta) };

    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();

    const p = await m.peca('a');
    expect(p.estado).toBe('nao_obtida');
    expect(p.motivo).toBe('bloqueio_do_tribunal');
    expect(p.retomarEm?.toISOString()).toBe(volta.toISOString());
    expect(lotes(m)).toHaveLength(1);

    // Quem decide tentar de novo é a pessoa, com outro clique.
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    expect(lotes(m)).toHaveLength(2);
    expect((await m.peca('a')).estado).toBe('disponivel');
  });

  it('peça que o tribunal lista e não entrega: sem_teor, com o motivo; omitida: ausente_no_lote', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    m.provedor.omitir.set('b', 1);

    await m.pasta.solicitar(A, PROCESSO_TJGO, 'c');
    await m.pasta.aguardarOciosa();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'b');
    await m.pasta.aguardarOciosa();

    const c = await m.peca('c');
    expect(c.estado).toBe('nao_obtida');
    expect(c.motivo).toBe('sem_teor');
    expect(c.descricaoDoMotivo).toMatch(/procuração/);
    expect((await m.peca('b')).motivo).toBe('ausente_no_lote');
    // Sem segunda tentativa escondida: um lote por clique.
    expect(lotes(m)).toEqual([['c'], ['b']]);
  });

  it('credencial recusada: marca a recusa e as próximas tentativas nem saem do servidor', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    m.provedor.falharNoLote = {
      n: 1,
      erro: new CredencialTribunalInvalidaError('mni', 'senha vencida'),
    };

    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    expect((await m.peca('a')).motivo).toBe('credencial_recusada');
    const cred = (await m.credenciais.listar(A)).find((c) => c.tribunal === 'TJGO');
    expect(cred?.recusadaEm).toBeDefined();

    await expect(m.pasta.solicitar(A, PROCESSO_TJGO, 'b')).rejects.toBeInstanceOf(
      CredencialTribunalInvalidaError,
    );
    expect(lotes(m)).toHaveLength(1);
  });

  it('sem habilitação nos autos e indisponibilidade viram o motivo da peça, sem vazar mensagem interna', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    m.provedor.falharNoLote = {
      n: 1,
      erro: new SemHabilitacaoNosAutosError(PROCESSO_TJGO),
    };
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    expect((await m.peca('a')).motivo).toBe('sem_habilitacao');

    m.provedor.falharNoLote = {
      n: 2,
      erro: new Error('ECONNRESET em /var/segredo/caminho'),
    };
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'b');
    await m.pasta.aguardarOciosa();
    const b = await m.peca('b');
    expect(b.estado).toBe('nao_obtida');
    expect(b.motivo).toBe('interrompido');
    expect(JSON.stringify(b)).not.toContain('/var/segredo');

    m.provedor.falharNoLote = {
      n: 3,
      erro: new ProviderIndisponivelError('mni', 'tribunal fora do ar'),
    };
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'h');
    await m.pasta.aguardarOciosa();
    expect((await m.peca('h')).motivo).toBe('interrompido');
  });

  it('HTML do tribunal vira texto no servidor: o original não fica e nada de marcação chega ao PDF', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'h');
    await m.pasta.aguardarOciosa();

    const p = await m.peca('h');
    expect(p.estado).toBe('disponivel');
    expect(p.conversao).toBe('html');
    expect(p.observacao).toMatch(/tabela|imagem/);

    const texto = textoDoPdf(
      await lerTudo(await m.pasta.abrirPeca(A, PROCESSO_TJGO, 'h')),
    );
    expect(texto).toContain('CERTIDÃO');
    for (const proibido of [
      MARCADOR_SCRIPT,
      MARCADOR_ATRIBUTO,
      '<script',
      '<p',
      'data:image',
    ]) {
      expect(texto).not.toContain(proibido);
    }
    // Só PDF em disco: nem o HTML bruto nem temporário sobrou.
    const nomes = arquivosEmDisco();
    expect(nomes).toHaveLength(1);
    expect(nomes[0]).toMatch(/\.pdf$/);
  });

  it('imagem do tribunal vira uma página de PDF', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'i');
    await m.pasta.aguardarOciosa();
    const p = await m.peca('i');
    expect(p).toMatchObject({
      estado: 'disponivel',
      conversao: 'imagem',
      paginasDaPeca: 1,
    });
  });

  it('peça sob sigilo nunca é pedida nem guardada', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await expect(m.pasta.solicitar(A, PROCESSO_TJGO, 's')).rejects.toBeInstanceOf(
      PecaSigilosaNaoGuardadaError,
    );
    await m.pasta.aguardarOciosa();
    expect(m.provedor.chamadas).toHaveLength(1); // só a listagem do registrarListagem
    expect(arquivosEmDisco()).toEqual([]);
    expect(await m.armazem.usoDoWorkspace(A)).toBe(0);
  });

  it('processo em segredo de justiça (pela listagem) não guarda nada: nem peça, nem pasta, nem seleção', async () => {
    const m = await montar(await pecasPadrao());
    m.provedor.nivelSigiloDoProcesso = 2;
    await m.registrarListagem();
    await expect(m.pasta.solicitar(A, PROCESSO_TJGO, 'a')).rejects.toBeInstanceOf(
      SegredoDeJusticaNaoGuardadoError,
    );
    await expect(m.pasta.montar(A, PROCESSO_TJGO)).rejects.toBeInstanceOf(
      SegredoDeJusticaNaoGuardadoError,
    );
    await expect(m.pasta.baixarSelecao(A, PROCESSO_TJGO, ['a'])).rejects.toBeInstanceOf(
      SegredoDeJusticaNaoGuardadoError,
    );
    const v = await m.pasta.visao(A, PROCESSO_TJGO);
    expect(v.pecas.every((p) => p.estado === 'sigilo')).toBe(true);
    expect(arquivosEmDisco()).toEqual([]);
  });

  it('segredo apontado só pelas fontes públicas: a peça não é guardada e vira "sigilosa"', async () => {
    const processos = {
      executar: async () => ({ segredoJustica: true }),
    } as unknown as BuscarProcessoPorNumero;
    const m = await montar(await pecasPadrao(), {}, { processos });
    await m.registrarListagem();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    expect((await m.peca('a')).motivo).toBe('sigilosa');
    expect(lotes(m)).toEqual([]);
    expect(arquivosEmDisco()).toEqual([]);
  });

  it('id que a listagem não tem: não existe', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await expect(m.pasta.solicitar(A, PROCESSO_TJGO, 'inventado')).rejects.toBeInstanceOf(
      PecaDaPastaNaoEncontradaError,
    );
    expect(lotes(m)).toEqual([]);
  });
});

describe('ServicoPasta — montar a pasta completa', () => {
  it('busca só o que não está em guarda, atualiza o estado a cada lote e entrega o PDF com intervalos', async () => {
    const m = await montar(await pecasPadrao(), { inicial: 2, maximo: 2 });
    await m.registrarListagem();
    // "a" já foi aberta antes.
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    m.provedor.chamadas.length = 0;

    const r = await m.pasta.montar(A, PROCESSO_TJGO);
    expect(r.jaExistia).toBe(false);
    expect(r.job.finalidade).toBe('pasta_completa');
    // 6 peças: "a" em guarda, "s" sigilosa → 4 vão ao tribunal.
    expect(r.estimativa).toMatchObject({
      total: 6,
      emGuarda: 1,
      sigilosas: 1,
      abuscar: 4,
    });

    // O meio do job: no 2º lote, as do 1º já estão disponíveis; as do 2º, no ar.
    const fotos: Array<Record<string, string>> = [];
    m.provedor.aoLote = async (n) => {
      const v = await m.visao();
      fotos.push({
        n: String(n),
        ...Object.fromEntries(v.map((p) => [p.pecaId, p.estado])),
      });
    };
    await m.leitor.processarFila();

    expect(lotes(m)).toEqual([
      ['b', 'h'],
      ['i', 'c'],
    ]);
    expect(fotos[0]).toMatchObject({
      a: 'disponivel',
      b: 'baixando',
      h: 'baixando',
      i: 'na_fila',
      c: 'na_fila',
      s: 'sigilo',
    });
    expect(fotos[1]).toMatchObject({
      a: 'disponivel',
      b: 'disponivel',
      h: 'disponivel',
      i: 'baixando',
      c: 'baixando',
    });

    const v = await m.pasta.visao(A, PROCESSO_TJGO);
    expect(v.montagem?.estado).toBe('parcial'); // "c" sem teor e "s" sigilosa → avisos
    const intervalos = v.pecas.map((p) => [
      p.pecaId,
      p.intervalo?.inicial,
      p.intervalo?.final,
    ]);
    expect(intervalos).toEqual([
      ['a', 1, 2],
      ['b', 3, 3],
      ['h', 4, 4],
      ['i', 5, 5],
      ['c', 6, 6],
      ['s', 7, 7],
    ]);
    expect(v.pecas.find((p) => p.pecaId === 'c')).toMatchObject({
      estado: 'nao_obtida',
      motivo: 'sem_teor',
    });
    // As peças ficam abríveis uma a uma depois da montagem.
    expect((await m.peca('b')).estado).toBe('disponivel');
    // O índice diz que "h" foi convertida, e o que ficou de fora.
    const h = v.montagem?.indice?.find((e) => e.pecaId === 'h');
    expect(h?.situacao).toBe('html_convertida');
    expect(h?.motivo).toBeDefined();
    // PDF do combinado: mesmas páginas do índice.
    expect(v.montagem?.arquivo?.paginas).toBe(7);
  });

  it('é idempotente: montagem em andamento ou já pronta devolve a mesma, sem job novo', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    const um = await m.pasta.montar(A, PROCESSO_TJGO);
    const dois = await m.pasta.montar(A, PROCESSO_TJGO);
    expect(dois.jaExistia).toBe(true);
    expect(dois.job.id).toBe(um.job.id);

    await m.leitor.processarFila();
    const tres = await m.pasta.montar(A, PROCESSO_TJGO);
    expect(tres.jaExistia).toBe(true);
    expect(tres.job.id).toBe(um.job.id);
    expect((await m.fila.doProcesso(A, PROCESSO_TJGO_DIGITOS)).length).toBe(1);
  });

  it('com tudo em guarda, remontar não consulta o tribunal (nem a listagem)', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await m.pasta.montar(A, PROCESSO_TJGO);
    await m.leitor.processarFila();
    m.provedor.chamadas.length = 0;

    // O combinado sai do disco; as peças continuam em guarda.
    const antigo = (await m.fila.doProcesso(A, PROCESSO_TJGO_DIGITOS))[0]!;
    await m.armazem.apagarArquivo(A, antigo.arquivo!.localizador);
    const r = await m.pasta.montar(A, PROCESSO_TJGO);
    expect(r.jaExistia).toBe(false);
    expect(r.estimativa.abuscar).toBe(1); // só "c", que o tribunal nunca entregou
    await m.leitor.processarFila();
    expect(lotes(m)).toEqual([['c']]);
    expect(m.provedor.chamadas.some((c) => c.tipo === 'listar')).toBe(false);
  });

  it('403 no meio da montagem: o job pausa com a hora e retoma sozinho sem rebaixar o que veio', async () => {
    const m = await montar(await pecasPadrao(), { inicial: 1, maximo: 1 });
    await m.registrarListagem();
    await m.pasta.montar(A, PROCESSO_TJGO);
    const volta = new Date(m.clock.agora().getTime() + 30 * 60_000);
    m.provedor.falharNoLote = { n: 2, erro: new MniBloqueadoError('mni', volta) };

    await m.leitor.processarFila();
    let v = await m.pasta.visao(A, PROCESSO_TJGO);
    expect(v.montagem?.estado).toBe('pausado_por_bloqueio');
    expect(v.montagem?.retomarEm?.toISOString()).toBe(volta.toISOString());
    expect((await m.peca('a')).estado).toBe('disponivel');

    m.clock.avancar(31 * 60_000);
    await m.leitor.processarFila();
    v = await m.pasta.visao(A, PROCESSO_TJGO);
    expect(v.montagem?.estado).toBe('parcial');
    // "a" não foi pedida de novo.
    expect(lotes(m).filter((l) => l.includes('a'))).toHaveLength(1);
  });

  it('sem peça nenhuma que se possa juntar, diz isso em vez de montar PDF vazio', async () => {
    const m = await montar([
      {
        id: 's',
        rotulo: 'Só sigilosa',
        bytes: await pdfSintetico(1, 'S'),
        nivelSigilo: 1,
      },
    ]);
    await m.registrarListagem();
    await expect(m.pasta.montar(A, PROCESSO_TJGO)).rejects.toBeInstanceOf(
      PastaSemPecasParaJuntarError,
    );
    await expect(m.pasta.baixarSelecao(A, PROCESSO_TJGO, ['s'])).rejects.toBeInstanceOf(
      PastaSemPecasParaJuntarError,
    );
  });
});

describe('ServicoPasta — baixar as marcadas', () => {
  it('a prévia diz quantas peças irão ao tribunal, sem criar nada nem chamar nada', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    const chamadas = m.provedor.chamadas.length;

    const e = await m.pasta.previaDaSelecao(A, PROCESSO_TJGO, ['h', 'a', 'b', 's']);
    expect(e).toMatchObject({ total: 4, emGuarda: 1, sigilosas: 1, abuscar: 2 });
    expect(e.maximoSegundos).toBeGreaterThan(0);
    expect(m.provedor.chamadas.length).toBe(chamadas);
    expect(await m.fila.doProcesso(A, PROCESSO_TJGO_DIGITOS)).toEqual([]);
  });

  it('junta na ordem dos autos, com índice próprio, usando a guarda e buscando só o que falta', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'b');
    await m.pasta.aguardarOciosa();
    m.provedor.chamadas.length = 0;

    // Marcadas fora de ordem; "s" (sigilosa) é ignorada.
    const r = await m.pasta.baixarSelecao(A, PROCESSO_TJGO, ['h', 's', 'b', 'a']);
    expect(r.job.finalidade).toBe('selecionadas');
    expect(r.estimativa).toMatchObject({ abuscar: 2, emGuarda: 1, sigilosas: 1 });
    await m.leitor.processarFila();

    // "b" não voltou ao tribunal; a listagem também não.
    expect(lotes(m)).toEqual([['a', 'h']]);
    expect(m.provedor.chamadas.some((c) => c.tipo === 'listar')).toBe(false);

    const job = await m.leitor.consultar(A, PROCESSO_TJGO, r.job.id);
    expect(job.estado).toBe('pronto');
    expect(job.indice?.map((e) => [e.pecaId, e.paginaInicial, e.paginaFinal])).toEqual([
      ['a', 1, 2],
      ['b', 3, 3],
      ['h', 4, 4],
    ]);
    const pdf = await m.leitor.abrirPdf(A, PROCESSO_TJGO, r.job.id);
    expect(pdf.nomeArquivo).toBe(
      `processo-${PROCESSO_TJGO_DIGITOS}-pecas-selecionadas.pdf`,
    );
    const marcas = await marcasDasPaginas(await lerTudo(pdf));
    expect(marcas.slice(0, 3)).toEqual(['A-p1', 'A-p2', 'B-p1']);
    expect(marcas).toHaveLength(4);
    // Linearizado, como o do leitor.
    expect(Buffer.from(await lerTudo(pdf)).toString('latin1')).toContain('/Linearized');
  });

  it('com a seleção inteira em guarda, baixar não custa uma única consulta ao tribunal', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    for (const id of ['a', 'b']) {
      await m.pasta.solicitar(A, PROCESSO_TJGO, id);
      await m.pasta.aguardarOciosa();
    }
    m.provedor.chamadas.length = 0;

    const r = await m.pasta.baixarSelecao(A, PROCESSO_TJGO, ['b', 'a']);
    expect(r.estimativa.abuscar).toBe(0);
    await m.leitor.processarFila();

    expect(m.provedor.chamadas).toEqual([]);
    expect((await m.leitor.consultar(A, PROCESSO_TJGO, r.job.id)).estado).toBe('pronto');
  });

  it('o "Baixar PDF" não conta como a pasta montada: os intervalos só vêm da montagem completa', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await m.pasta.baixarSelecao(A, PROCESSO_TJGO, ['a', 'b']);
    await m.leitor.processarFila();
    const v = await m.pasta.visao(A, PROCESSO_TJGO);
    expect(v.selecionadas?.estado).toBe('pronto');
    expect(v.montagem).toBeUndefined();
    expect(v.pecas.every((p) => p.intervalo === undefined)).toBe(true);
  });

  it('seleção com id que a listagem não tem é recusada', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await expect(
      m.pasta.baixarSelecao(A, PROCESSO_TJGO, ['a', 'fantasma']),
    ).rejects.toBeInstanceOf(PecaDaPastaNaoEncontradaError);
  });
});

describe('ServicoPasta — isolamento entre workspaces', () => {
  it('B não vê a listagem, o estado, o arquivo nem a guarda de A — e a resposta é a mesma de "não existe"', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem(A);
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();

    // B nem carregou a lista: nada aparece.
    const vb = await m.pasta.visao(B, PROCESSO_TJGO);
    expect(vb.listagem).toBeUndefined();
    await expect(m.pasta.solicitar(B, PROCESSO_TJGO, 'a')).rejects.toBeInstanceOf(
      ListagemDaPastaAusenteError,
    );
    await expect(m.pasta.abrirPeca(B, PROCESSO_TJGO, 'a')).rejects.toBeInstanceOf(
      PecaDaPastaNaoEncontradaError,
    );
    // O erro de "id de A" é o mesmo de "id que não existe".
    const aDeA = await m.pasta.abrirPeca(B, PROCESSO_TJGO, 'a').catch((e: Error) => e);
    const inexistente = await m.pasta
      .abrirPeca(B, PROCESSO_TJGO, 'zzz')
      .catch((e: Error) => e);
    expect((aDeA as Error).constructor).toBe((inexistente as Error).constructor);

    // Mesmo com a MESMA listagem registrada, a guarda de A não serve a B.
    await m.registrarListagem(B);
    expect((await m.peca('a', B)).estado).toBe('nao_baixada');
    await expect(m.pasta.abrirPeca(B, PROCESSO_TJGO, 'a')).rejects.toBeInstanceOf(
      PecaDaPastaNaoEncontradaError,
    );
    expect(await m.armazem.usoDoWorkspace(B)).toBe(0);
    expect(await m.armazem.usoDoWorkspace(A)).toBeGreaterThan(0);

    // E B montando a própria pasta vai ao tribunal por "a": não reaproveita a de A.
    m.provedor.chamadas.length = 0;
    await m.pasta.montar(B, PROCESSO_TJGO);
    await m.leitor.processarFila();
    expect(lotes(m).flat()).toContain('a');
  });

  it('o job de montagem de A não aparece na visão de B', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem(A);
    await m.registrarListagem(B);
    await m.pasta.montar(A, PROCESSO_TJGO);
    const vb = await m.pasta.visao(B, PROCESSO_TJGO);
    expect(vb.montagem).toBeUndefined();
    expect(vb.pecas.every((p) => p.estado !== 'na_fila')).toBe(true);
  });
});

describe('ServicoPasta — guarda: prazo, cota e limpeza', () => {
  it('a peça vence em 24 h: some da lista, e a limpeza do Agendador apaga o arquivo', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    expect(arquivosEmDisco()).toHaveLength(1);

    m.clock.avancar(24 * 3_600_000 + 1000);
    expect((await m.peca('a')).estado).toBe('nao_baixada');
    await expect(m.pasta.abrirPeca(A, PROCESSO_TJGO, 'a')).rejects.toBeInstanceOf(
      PecaDaPastaNaoEncontradaError,
    );
    await m.leitor.limparExpirados();
    expect(arquivosEmDisco()).toEqual([]);
    expect(await m.repositorio.doProcesso(A, PROCESSO_TJGO_DIGITOS)).toEqual([]);
  });

  it('arquivo que sumiu do disco não é anunciado como disponível', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    const e = (await m.repositorio.doProcesso(A, PROCESSO_TJGO_DIGITOS))[0]!;
    await m.armazem.apagarArquivo(A, e.localizador);
    expect((await m.peca('a')).estado).toBe('nao_baixada');
  });

  it('a cota é uma só, somada com a do PDF combinado: sai a peça mais antiga, nunca a recém-aberta', async () => {
    const pecas: PecaFalsa[] = [
      { id: 'p1', bytes: await pdfPesado(100_000, 'P1') },
      { id: 'p2', bytes: await pdfPesado(100_000, 'P2') },
      { id: 'p3', bytes: await pdfPesado(100_000, 'P3') },
    ];
    const m = await montar(pecas, { cotaPorWorkspaceBytes: 250_000 });
    await m.registrarListagem();
    for (const id of ['p1', 'p2', 'p3']) {
      await m.pasta.solicitar(A, PROCESSO_TJGO, id);
      await m.pasta.aguardarOciosa();
      m.clock.avancar(1000);
    }
    expect((await m.peca('p1')).estado).toBe('nao_baixada');
    expect((await m.peca('p2')).estado).toBe('disponivel');
    expect((await m.peca('p3')).estado).toBe('disponivel');
    expect(await m.armazem.usoDoWorkspace(A)).toBeLessThanOrEqual(250_000);
  });

  it('nunca sai a peça de que uma montagem em andamento ainda vai copiar páginas', async () => {
    const pecas: PecaFalsa[] = [
      { id: 'p1', bytes: await pdfPesado(100_000, 'P1') },
      { id: 'p2', bytes: await pdfPesado(100_000, 'P2') },
      { id: 'p3', bytes: await pdfPesado(100_000, 'P3') },
    ];
    const m = await montar(pecas, { cotaPorWorkspaceBytes: 250_000 });
    await m.registrarListagem();
    for (const id of ['p1', 'p2']) {
      await m.pasta.solicitar(A, PROCESSO_TJGO, id);
      await m.pasta.aguardarOciosa();
      m.clock.avancar(1000);
    }
    // Um job em andamento que já tem "p1" (a mais antiga) na mão.
    const entrada = (await m.repositorio.obterPeca(A, PROCESSO_TJGO_DIGITOS, 'p1'))!;
    const job: JobLeitor = {
      id: 'b'.repeat(32),
      workspace: A,
      numeroProcesso: PROCESSO_TJGO_DIGITOS,
      tribunal: 'TJGO',
      credencial: 'cred1234',
      estado: 'baixando',
      pedidas: ['p1'],
      pecas: [
        {
          pecaId: 'p1',
          ordem: 0,
          rotulo: 'p1',
          situacao: 'obtida',
          arquivo: entrada.localizador,
          bytes: entrada.bytes,
          deCache: { conversao: 'nenhuma' },
        },
      ],
      tamanhoLote: 5,
      loteTravado: false,
      chamadas: 0,
      bytesRecebidos: 0,
      criadoEm: m.clock.agora(),
      atualizadoEm: m.clock.agora(),
    };
    await m.fila.criar(job);

    await m.pasta.solicitar(A, PROCESSO_TJGO, 'p3');
    await m.pasta.aguardarOciosa();

    expect((await m.peca('p1')).estado).toBe('disponivel'); // protegida, mesmo sendo a mais antiga
    expect((await m.peca('p2')).estado).toBe('nao_baixada'); // saiu no lugar dela
    expect((await m.peca('p3')).estado).toBe('disponivel');
  });

  it('a limpeza pelo prazo também espera a montagem em andamento terminar de usar a peça', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    const e = (await m.repositorio.obterPeca(A, PROCESSO_TJGO_DIGITOS, 'a'))!;
    await m.fila.criar({
      id: 'c'.repeat(32),
      workspace: A,
      numeroProcesso: PROCESSO_TJGO_DIGITOS,
      tribunal: 'TJGO',
      credencial: 'x',
      estado: 'montando',
      pedidas: ['a'],
      pecas: [
        {
          pecaId: 'a',
          ordem: 0,
          rotulo: 'a',
          situacao: 'obtida',
          arquivo: e.localizador,
          deCache: { conversao: 'nenhuma' },
        },
      ],
      tamanhoLote: 5,
      loteTravado: false,
      chamadas: 0,
      bytesRecebidos: 0,
      criadoEm: m.clock.agora(),
      atualizadoEm: m.clock.agora(),
    });
    m.clock.avancar(25 * 3_600_000);
    await m.leitor.limparExpirados();
    expect(arquivosEmDisco()).toHaveLength(1); // ficou para a próxima limpeza
  });

  it('exclusão de conta apaga arquivos e linhas da guarda e da listagem', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem(A);
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.aguardarOciosa();
    await m.leitor.apagarDoWorkspace(A);
    expect(arquivosEmDisco()).toEqual([]);
    expect(await m.repositorio.doWorkspace(A)).toEqual([]);
    expect(await m.repositorio.obterListagem(A, PROCESSO_TJGO_DIGITOS)).toBeUndefined();
  });

  it('nome em disco é aleatório e não deriva do id da peça; só PDF, e nenhum .tmp sobra', async () => {
    const m = await montar(await pecasPadrao());
    await m.registrarListagem();
    for (const id of ['a', 'h', 'i']) {
      await m.pasta.solicitar(A, PROCESSO_TJGO, id);
      await m.pasta.aguardarOciosa();
    }
    const nomes = arquivosEmDisco();
    expect(nomes).toHaveLength(3);
    for (const n of nomes) {
      expect(n).toMatch(/\/[a-f0-9]{32}\.pdf$/);
      expect(n).not.toMatch(/\.tmp$/);
    }
  });

  it('sobra temporária de um processo que caiu é varrida pela limpeza', async () => {
    const m = await montar(await pecasPadrao());
    const pastaId = GuardaDePecas.pastaDoProcesso(PROCESSO_TJGO_DIGITOS);
    await m.armazem.gravarArquivo(A, pastaId, new Uint8Array([1, 2, 3]), 'tmp');
    expect(arquivosEmDisco()).toHaveLength(1);
    expect(await m.armazem.removerTemporarios(60 * 60_000)).toBe(0); // recente: fica
    expect(await m.armazem.removerTemporarios(-1000)).toBe(1);
    expect(arquivosEmDisco()).toEqual([]);
  });
});

describe('ServicoPasta — o que NUNCA aparece no log', () => {
  it('nem conteúdo de peça, nem texto do HTML, nem a senha — só contagens', async () => {
    const m = await montar(await pecasPadrao(), { inicial: 2, maximo: 2 });
    await m.registrarListagem();
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'a');
    await m.pasta.solicitar(A, PROCESSO_TJGO, 'h');
    await m.pasta.aguardarOciosa();
    await m.pasta.montar(A, PROCESSO_TJGO);
    await m.leitor.processarFila();
    m.provedor.falharNoLote = { n: 99, erro: new Error('x') };

    const log = m.logger.linhas.join('\n');
    expect(log).not.toContain(SENHA);
    expect(log).not.toContain('A-p1');
    expect(log).not.toContain('CERTID');
    expect(log).not.toContain('Certifico');
    expect(log).not.toContain('Petição inicial');
    expect(log).not.toContain(MARCADOR_SCRIPT);
    expect(log.length).toBeGreaterThan(0);
  });
});

describe('ServicoPasta — um único limitador', () => {
  const ler = (rel: string): string =>
    readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

  it('a Pasta e a guarda não conhecem balde, adapter nem provedor: a única saída é ServicoLeitor.consultarLote', () => {
    for (const arquivo of [
      'src/application/services/ServicoPasta.ts',
      'src/application/services/GuardaDePecas.ts',
      'src/main/http/rotas/pasta.ts',
    ]) {
      const fonte = ler(arquivo);
      expect(fonte, arquivo).not.toMatch(
        /RateLimiter|TokenBucket|MniAdapter|ProvedorDePecas|obterConteudosEmLote|infrastructure\/adapters/,
      );
    }
    expect(ler('src/application/services/ServicoPasta.ts')).toContain(
      'leitor.consultarLote(',
    );
  });

  it('o composition root monta UM adapter, UM balde, UM leitor, UMA pasta e UMA guarda', () => {
    const raiz = ler('src/main/factories/makeProcessoSearchService.ts');
    expect(raiz.match(/new MniAdapter\(/g)).toHaveLength(1);
    expect(raiz.match(/new TokenBucketRateLimiter\(/g) ?? []).toHaveLength(0);
    expect(raiz.match(/new ServicoLeitor\(/g)).toHaveLength(1);
    expect(raiz.match(/new ServicoPasta\(/g)).toHaveLength(1);
    expect(raiz.match(/new GuardaDePecas\(/g)).toHaveLength(1);
    expect(raiz.match(/new ArmazemEmDisco\(/g)).toHaveLength(1);
  });
});
