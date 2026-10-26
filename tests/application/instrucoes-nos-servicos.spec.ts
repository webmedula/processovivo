import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  INSTRUCAO_DO_SISTEMA,
  VERSAO_PROMPT,
} from '../../src/application/politicas/entradaDoModelo.js';
import {
  INSTRUCAO_DA_PECA,
  VERSAO_PROMPT_DA_PECA,
} from '../../src/application/politicas/entradaDaPeca.js';
import {
  INSTRUCAO_DO_RESUMO,
  VERSAO_PROMPT_DO_RESUMO,
} from '../../src/application/politicas/entradaDoResumo.js';
import { LimiteDeAnalises } from '../../src/application/politicas/limiteDeAnalises.js';
import { ServicoAnaliseDePeca } from '../../src/application/services/ServicoAnaliseDePeca.js';
import { ServicoAnaliseDoAto } from '../../src/application/services/ServicoAnaliseDoAto.js';
import { ServicoInstrucoesDeIa } from '../../src/application/services/ServicoInstrucoesDeIa.js';
import { ServicoResumoDoProcesso } from '../../src/application/services/ServicoResumoDoProcesso.js';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import { montarSistema } from '../../src/domain/entities/InstrucoesDeIa.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import type { RepositorioDeInstrucoesDeIa } from '../../src/domain/ports/InstrucoesDeIa.js';
import { PdftotextExtrator } from '../../src/infrastructure/pdf/PdftotextExtrator.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioAnalisesDePecaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAnalisesDePecaSqlite.js';
import { RepositorioAnalisesSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAnalisesSqlite.js';
import { RepositorioDeInstrucoesDeIaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeInstrucoesDeIaSqlite.js';
import { RepositorioResumosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioResumosSqlite.js';
import { AnalisadorDePecaFalso, PAGINAS_DA_PECA } from '../helpers/analiseDePeca.js';
import {
  AnalisadorFalso,
  LoggerColetor,
  NOME_DA_PARTE,
  TEXTO_DO_ATO,
} from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';
import { ClockFalso } from '../helpers/leitor.js';
import { pdfComPaginas } from '../helpers/pdfDePecas.js';
import { ATOS_DO_RESUMO, ResumidorFalso } from '../helpers/resumoIa.js';

/*
 * As instruções publicadas chegam às TRÊS funções: a próxima análise de qualquer conta já usa a versão nova
 * (e grava `+eN`), reverter devolve EXATAMENTE o prompt anterior, o reaproveitamento da peça não mistura
 * versões e uma leitura que falha cai em +e0 sem erro para quem usa.
 */

const WS = 'ws-a';
const NUMERO = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
const DATA = new Date('2026-10-05T12:00:00Z');
const OP = 'ab12cd34';
const ATO: Movimentacao = {
  data: DATA,
  titulo: 'Despacho',
  idExterno: 'djen:900',
  conteudo: TEXTO_DO_ATO,
};
const BLOCO_UM = 'Destaque sempre o prazo escrito no ato.';
const BLOCO_DOIS = 'Escreva em no máximo duas frases curtas.';

function processo(movs: Movimentacao[], tribunal = 'TJGO'): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(NUMERO_TJSP_A),
    tribunal,
    classe: 'Procedimento Comum Cível',
    segredoJustica: false,
    partes: [{ nome: NOME_DA_PARTE, polo: 'ATIVO', tipoPessoa: 'FISICA', advogados: [] }],
    movimentacoes: movs,
    procedencia: { provider: 'djen', consultadoEm: DATA, deCache: false },
  });
}

let db: DatabaseSync;
let repo: RepositorioAcompanhamentosSqlite;
let relogio: ClockFalso;
let log: LoggerColetor;
let instrucoes: ServicoInstrucoesDeIa;

function servicoDeInstrucoes(
  repositorio?: RepositorioDeInstrucoesDeIa,
): ServicoInstrucoesDeIa {
  return new ServicoInstrucoesDeIa({
    repositorio: repositorio ?? new RepositorioDeInstrucoesDeIaSqlite(db),
    textosFixos: {
      ato: { fixa: INSTRUCAO_DO_SISTEMA, formato: '' },
      resumo: { fixa: INSTRUCAO_DO_RESUMO, formato: '' },
      peca: { fixa: INSTRUCAO_DA_PECA, formato: '' },
    },
    clock: relogio,
    logger: log,
    validadeDoCacheMs: 60_000, // o cache REAL: publicar tem de limpá-lo
  });
}

function publicar(funcao: 'ato' | 'resumo' | 'peca', texto: string): number {
  const r = instrucoes.salvarRascunho(OP, funcao, texto, '');
  instrucoes.publicar(OP, funcao, { versao: r.versao, confirmado: true });
  return r.versao;
}

beforeEach(async () => {
  db = abrirBanco(':memory:');
  repo = new RepositorioAcompanhamentosSqlite(db);
  relogio = new ClockFalso();
  log = new LoggerColetor();
  instrucoes = servicoDeInstrucoes();
  await repo.acompanhar(WS, NUMERO);
});

describe('análise de ato', () => {
  let analisador: AnalisadorFalso;
  let n = 0;
  const servico = (
    inst: ServicoInstrucoesDeIa | undefined = instrucoes,
  ): ServicoAnaliseDoAto =>
    new ServicoAnaliseDoAto({
      repositorio: repo,
      analises: new RepositorioAnalisesSqlite(db),
      assinaturas: { temRecursoSemExcecao: async () => true },
      analisador,
      limite: new LimiteDeAnalises({
        porHora: 100,
        simultaneasNoTotal: 10,
        clock: relogio,
      }),
      clock: relogio,
      logger: log,
      novoId: () => `a-${++n}`,
      ...(inst ? { instrucoes: inst } : {}),
    });
  const pedido = {
    workspace: WS,
    numero: NUMERO_TJSP_A,
    chaveDoAto: chaveDaMovimentacao(ATO),
  };
  const gravada = (): string =>
    (
      db
        .prepare('SELECT versao_prompt FROM analises_ia ORDER BY rowid DESC LIMIT 1')
        .get() as {
        versao_prompt: string;
      }
    ).versao_prompt;

  beforeEach(async () => {
    analisador = new AnalisadorFalso();
    await repo.registrarSincronizacao(WS, NUMERO, processo([ATO]), []);
  });

  it('sem instrução publicada: o prompt é o de sempre e a versão gravada não ganha sufixo (+e0)', async () => {
    const r = await servico().analisar(pedido);
    expect(analisador.pedidos[0]?.sistema).toBe(INSTRUCAO_DO_SISTEMA);
    expect(gravada()).toBe(VERSAO_PROMPT);
    expect(r).toMatchObject({ versaoPrompt: VERSAO_PROMPT });
  });

  it('publicar: a PRÓXIMA análise já usa o bloco e grava ato-1.2.0+e1; reverter restaura o prompt anterior', async () => {
    const s = servico();
    await s.analisar(pedido); // enche o cache de 60 s com o vazio
    publicar('ato', BLOCO_UM);

    const r = await s.analisar(pedido);
    expect(analisador.pedidos[1]?.sistema).toBe(
      montarSistema('ato', INSTRUCAO_DO_SISTEMA, BLOCO_UM),
    );
    expect(r).toMatchObject({ versaoPrompt: `${VERSAO_PROMPT}+e1` });
    expect(gravada()).toBe(`${VERSAO_PROMPT}+e1`);

    publicar('ato', BLOCO_DOIS);
    await s.analisar(pedido);
    expect(analisador.pedidos[2]?.sistema).toBe(
      montarSistema('ato', INSTRUCAO_DO_SISTEMA, BLOCO_DOIS),
    );
    expect(gravada()).toBe(`${VERSAO_PROMPT}+e2`);

    instrucoes.reverter(OP, 'ato', true);
    await s.analisar(pedido);
    expect(analisador.pedidos[3]?.sistema).toBe(
      montarSistema('ato', INSTRUCAO_DO_SISTEMA, BLOCO_UM),
    );
    expect(gravada()).toBe(`${VERSAO_PROMPT}+e1`);

    instrucoes.reverter(OP, 'ato', true);
    await s.analisar(pedido);
    expect(analisador.pedidos[4]?.sistema).toBe(INSTRUCAO_DO_SISTEMA);
    expect(gravada()).toBe(VERSAO_PROMPT);
  });

  it('o bloco só orienta: a mensagem do caso (o ato redigido) é a mesma com e sem instrução', async () => {
    const s = servico();
    await s.analisar(pedido);
    publicar('ato', BLOCO_UM);
    await s.analisar(pedido);
    expect(analisador.pedidos[1]?.usuario).toBe(analisador.pedidos[0]?.usuario);
  });

  it('a leitura das instruções falha: cai em +e0 e a análise SAI normalmente, sem erro', async () => {
    publicar('ato', BLOCO_UM);
    const real = new RepositorioDeInstrucoesDeIaSqlite(db);
    const quebrado: RepositorioDeInstrucoesDeIa = {
      emProducao: () => {
        throw new Error('banco fora do ar');
      },
      buscar: real.buscar.bind(real),
      rascunho: real.rascunho.bind(real),
      historico: real.historico.bind(real),
      salvarRascunho: real.salvarRascunho.bind(real),
      publicar: real.publicar.bind(real),
      reverter: real.reverter.bind(real),
    };
    const r = await servico(servicoDeInstrucoes(quebrado)).analisar(pedido);
    expect(r.estado).not.toBe('erro');
    expect(analisador.pedidos[0]?.sistema).toBe(INSTRUCAO_DO_SISTEMA);
    expect(gravada()).toBe(VERSAO_PROMPT);
  });

  it('o texto da instrução não vai ao log nem ao banco da análise', async () => {
    publicar('ato', 'Instrução sintética secreta do operador.');
    await servico().analisar(pedido);
    expect(log.linhas.join('\n')).not.toContain('secreta');
    expect(JSON.stringify(db.prepare('SELECT * FROM analises_ia').all())).not.toContain(
      'secreta',
    );
  });
});

describe('resumo do processo', () => {
  let resumidor: ResumidorFalso;
  let n = 0;
  const servico = (
    inst: ServicoInstrucoesDeIa | undefined = instrucoes,
  ): ServicoResumoDoProcesso =>
    new ServicoResumoDoProcesso({
      repositorio: repo,
      resumos: new RepositorioResumosSqlite(db),
      resumidor,
      exigirPlanoIa: async () => undefined,
      limite: new LimiteDeAnalises({
        porHora: 100,
        simultaneasNoTotal: 10,
        clock: relogio,
      }),
      clock: relogio,
      logger: log,
      novoId: () => `r-${++n}`,
      janelaDePendenciaDias: 10,
      ...(inst ? { instrucoes: inst } : {}),
    });
  const pedido = { workspace: WS, numero: NUMERO_TJSP_A };
  const gravada = (): string =>
    (
      db
        .prepare('SELECT versao_prompt FROM resumos_ia ORDER BY rowid DESC LIMIT 1')
        .get() as {
        versao_prompt: string;
      }
    ).versao_prompt;

  beforeEach(async () => {
    resumidor = new ResumidorFalso();
    relogio.ms = new Date('2026-10-06T15:00:00.000Z').getTime();
    await repo.registrarSincronizacao(WS, NUMERO, processo(ATOS_DO_RESUMO), []);
  });

  it('publicar → a próxima chamada usa o bloco e grava resumo-1.2.0+e1; reverter → o prompt de antes', async () => {
    const s = servico();
    await s.resumir(pedido);
    expect(resumidor.pedidos[0]?.sistema).toBe(INSTRUCAO_DO_RESUMO);
    expect(gravada()).toBe(VERSAO_PROMPT_DO_RESUMO);

    publicar('resumo', BLOCO_UM);
    await s.resumir(pedido);
    expect(resumidor.pedidos[1]?.sistema).toBe(
      montarSistema('resumo', INSTRUCAO_DO_RESUMO, BLOCO_UM),
    );
    expect(gravada()).toBe(`${VERSAO_PROMPT_DO_RESUMO}+e1`);

    instrucoes.reverter(OP, 'resumo', true);
    await s.resumir(pedido);
    expect(resumidor.pedidos[2]?.sistema).toBe(INSTRUCAO_DO_RESUMO);
    expect(gravada()).toBe(VERSAO_PROMPT_DO_RESUMO);
  });

  it('instrução de uma função não vai a outra', async () => {
    publicar('ato', BLOCO_UM);
    await servico().resumir(pedido);
    expect(resumidor.pedidos[0]?.sistema).toBe(INSTRUCAO_DO_RESUMO);
  });
});

describe('análise de peça', () => {
  let analisador: AnalisadorDePecaFalso;
  let n = 0;
  let pdf: Uint8Array;
  const servico = (
    inst: ServicoInstrucoesDeIa | undefined = instrucoes,
  ): ServicoAnaliseDePeca => {
    const real = new PdftotextExtrator();
    return new ServicoAnaliseDePeca({
      repositorio: repo,
      analises: new RepositorioAnalisesDePecaSqlite(db),
      assinaturas: { temRecursoSemExcecao: async () => true },
      fonte: {
        pecaParaAnalise: async () => ({
          tribunal: 'TJGO',
          arquivo: {
            tamanho: pdf.byteLength,
            async *ler(inicio: number, fim: number) {
              yield pdf.slice(inicio, fim + 1);
            },
          },
        }),
      },
      extrator: {
        extrair: (b, o) => {
          return real.extrair(b, o);
        },
      },
      analisador,
      limite: new LimiteDeAnalises({
        porHora: 100,
        simultaneasNoTotal: 10,
        clock: relogio,
      }),
      liberacao: { habilitada: false, workspaces: [WS] },
      tribunais: ['TJGO'],
      modelo: 'modelo/pedido',
      resultadoDias: 30,
      clock: relogio,
      logger: log,
      novoId: () => `p-${++n}`,
      ...(inst ? { instrucoes: inst } : {}),
    });
  };
  const pedido = { workspace: WS, numero: NUMERO_TJSP_A, pecaId: 'p1' };
  const gravada = (): string[] =>
    (
      db
        .prepare('SELECT versao_prompt FROM analises_pecas_ia ORDER BY rowid')
        .all() as Array<{
        versao_prompt: string;
      }>
    ).map((l) => l.versao_prompt);

  beforeEach(async () => {
    analisador = new AnalisadorDePecaFalso();
    pdf = await pdfComPaginas(PAGINAS_DA_PECA);
    await repo.registrarSincronizacao(WS, NUMERO, processo([ATO]), []);
  });

  it('publicar: a próxima análise usa o bloco; o resultado guardado de OUTRA versão não é servido (o cache respeita a versão)', async () => {
    const s = servico();
    await s.analisar(pedido); // +e0
    const igual = await s.analisar(pedido); // mesma peça, mesmo prompt, mesmo modelo: reaproveitada
    expect(analisador.chamadas).toBe(1);
    expect(igual).toMatchObject({ reaproveitada: true });

    publicar('peca', BLOCO_UM);
    const nova = await s.analisar(pedido);
    expect(analisador.chamadas).toBe(2); // NÃO reaproveitou a de +e0
    expect(analisador.pedidos[1]?.sistema).toBe(
      montarSistema('peca', INSTRUCAO_DA_PECA, BLOCO_UM),
    );
    expect(nova).toMatchObject({
      reaproveitada: false,
      versaoPrompt: `${VERSAO_PROMPT_DA_PECA}+e1`,
    });

    // com a e1 publicada, repetir reaproveita a e1
    const outra = await s.analisar(pedido);
    expect(analisador.chamadas).toBe(2);
    expect(outra).toMatchObject({
      reaproveitada: true,
      versaoPrompt: `${VERSAO_PROMPT_DA_PECA}+e1`,
    });

    // reverter ao +e0: volta a servir o resultado de +e0 que ainda está guardado, sem chamar o modelo
    instrucoes.reverter(OP, 'peca', true);
    const volta = await s.analisar(pedido);
    expect(analisador.chamadas).toBe(2);
    expect(volta).toMatchObject({
      reaproveitada: true,
      versaoPrompt: VERSAO_PROMPT_DA_PECA,
    });
    expect(gravada()).toEqual([VERSAO_PROMPT_DA_PECA, `${VERSAO_PROMPT_DA_PECA}+e1`]);
  });

  it('uma análise +e0 gravada ANTES da Fase C (versão sem sufixo) continua sendo reaproveitada no deploy', async () => {
    // Exatamente o que a v0.60.0 gravava: a versão do código, sem sufixo.
    await servico(servicoDeInstrucoes()).analisar(pedido);
    expect(gravada()).toEqual([VERSAO_PROMPT_DA_PECA]);
    const depois = await servico(servicoDeInstrucoes()).analisar(pedido);
    expect(depois).toMatchObject({ reaproveitada: true });
    expect(analisador.chamadas).toBe(1);
  });

  it('a leitura das instruções falha: cai em +e0, a análise sai e o prompt é o de sempre', async () => {
    const real = new RepositorioDeInstrucoesDeIaSqlite(db);
    const quebrado: RepositorioDeInstrucoesDeIa = {
      emProducao: () => {
        throw new Error('banco fora do ar');
      },
      buscar: real.buscar.bind(real),
      rascunho: real.rascunho.bind(real),
      historico: real.historico.bind(real),
      salvarRascunho: real.salvarRascunho.bind(real),
      publicar: real.publicar.bind(real),
      reverter: real.reverter.bind(real),
    };
    const r = await servico(servicoDeInstrucoes(quebrado)).analisar(pedido);
    expect(r.estado).not.toBe('erro');
    expect(analisador.pedidos[0]?.sistema).toBe(INSTRUCAO_DA_PECA);
    expect(gravada()).toEqual([VERSAO_PROMPT_DA_PECA]);
  });
});
