import { beforeEach, describe, expect, it } from 'vitest';
import { ServicoInstrucoesDeIa } from '../../src/application/services/ServicoInstrucoesDeIa.js';
import { ServicoModelosDeIa } from '../../src/application/services/ServicoModelosDeIa.js';
import { ServicoTesteDeModelo } from '../../src/application/services/ServicoTesteDeModelo.js';
import { ServicoVerificacaoDeInstrucoes } from '../../src/application/services/ServicoVerificacaoDeInstrucoes.js';
import { avisosDePiora } from '../../src/domain/entities/VerificacaoDeInstrucoes.js';
import {
  InstrucaoDeIaRecusadaError,
  ModeloDeIaRecusadoError,
} from '../../src/domain/errors/index.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import type { FuncaoDeIa } from '../../src/domain/entities/ControleDaIa.js';
import type { ExecutorDaVerificacaoDeInstrucoes } from '../../src/domain/ports/InstrucoesDeIa.js';
import type {
  EstimativaDoTeste,
  PrecoPorTokenDoModelo,
  ResultadoDaExecucaoDoTeste,
} from '../../src/domain/ports/ModelosDeIa.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDeInstrucoesDeIaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeInstrucoesDeIaSqlite.js';
import {
  RepositorioDeModelosDeIaSqlite,
  RepositorioDeTestesDeModeloSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDeModelosDeIaSqlite.js';
import {
  LeitorDeUsoDeIaSqlite,
  RegistroDeOcorrenciasDeIaSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';
import { LoggerColetor } from '../helpers/analiseIa.js';
import {
  ATUAL,
  NOVO,
  catalogoDeTeste,
  metricas,
  ExecutorFalso,
} from '../helpers/modelosDeIa.js';

/*
 * O conjunto de verificação das instruções (Fase C): OPCIONAL e SEM bloquear. Estimativa e confirmação antes
 * de enviar, um por vez (junto com o teste de modelo da Fase B), cancelável, só números gravados, e a Fase B
 * não enxerga este teste.
 */

class Relogio implements Clock {
  ms = new Date('2026-10-26T12:00:00.000Z').getTime();
  agora(): Date {
    return new Date(this.ms);
  }
  monotonico(): number {
    return this.ms;
  }
}

class ExecutorDeInstrucoesFalso implements ExecutorDaVerificacaoDeInstrucoes {
  readonly execucoes: Array<{
    funcao: FuncaoDeIa;
    modelo: string;
    publicada: string;
    rascunho: string;
    tetoUsd: number;
  }> = [];
  readonly estimativas: Array<{ funcao: FuncaoDeIa; modelo: string }> = [];
  chamadas = 40;
  custoEstimadoUsd: number | null = 0.1;
  resultado: ResultadoDaExecucaoDoTeste = {
    tipo: 'ok',
    candidato: metricas({ modelo: ATUAL }),
    referencia: metricas({ modelo: ATUAL }),
    gastoUsd: 0.08,
    tetoAtingido: false,
  };
  portao: Promise<void> | undefined;
  falhar = false;

  estimarInstrucoes(
    funcao: FuncaoDeIa,
    modelo: string,
    _p: ReadonlyMap<string, PrecoPorTokenDoModelo>,
  ): EstimativaDoTeste {
    this.estimativas.push({ funcao, modelo });
    return { chamadas: this.chamadas, custoEstimadoUsd: this.custoEstimadoUsd };
  }

  async executarInstrucoes(p: {
    funcao: FuncaoDeIa;
    modelo: string;
    publicada: string;
    rascunho: string;
    tetoUsd: number;
    sinal: AbortSignal;
    aoChamar: () => void;
  }): Promise<ResultadoDaExecucaoDoTeste> {
    this.execucoes.push({
      funcao: p.funcao,
      modelo: p.modelo,
      publicada: p.publicada,
      rascunho: p.rascunho,
      tetoUsd: p.tetoUsd,
    });
    p.aoChamar();
    p.aoChamar();
    if (this.portao) await this.portao;
    if (this.falhar) throw new Error('falha interna com texto SEGREDO-NAO-VAZAR');
    return this.resultado;
  }
}

const OP = 'ab12cd34';
let relogio: Relogio;
let db: ReturnType<typeof abrirBanco>;
let logger: LoggerColetor;
let executor: ExecutorDeInstrucoesFalso;
let instrucoes: ServicoInstrucoesDeIa;
let modelos: ServicoModelosDeIa;
let testes: RepositorioDeTestesDeModeloSqlite;
let verificacao: ServicoVerificacaoDeInstrucoes;
let n = 0;

function criar(comExecutor = true, tetoUsd?: number): ServicoVerificacaoDeInstrucoes {
  return new ServicoVerificacaoDeInstrucoes({
    executor: comExecutor ? executor : undefined,
    instrucoes,
    modelos,
    testes,
    clock: relogio,
    logger,
    novoId: () => `v-${++n}`,
    ...(tetoUsd !== undefined ? { tetoUsd } : {}),
  });
}

const recusa = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof InstrucaoDeIaRecusadaError || e instanceof ModeloDeIaRecusadoError)
      return e.motivo;
    throw e;
  }
  return 'nao_recusou';
};

beforeEach(() => {
  relogio = new Relogio();
  db = abrirBanco(':memory:');
  logger = new LoggerColetor();
  executor = new ExecutorDeInstrucoesFalso();
  n = 0;
  testes = new RepositorioDeTestesDeModeloSqlite(db);
  instrucoes = new ServicoInstrucoesDeIa({
    repositorio: new RepositorioDeInstrucoesDeIaSqlite(db),
    textosFixos: {
      ato: { fixa: 'F', formato: '' },
      resumo: { fixa: 'F', formato: '' },
      peca: { fixa: 'F', formato: '' },
    },
    clock: relogio,
    logger,
    validadeDoCacheMs: 0,
  });
  modelos = new ServicoModelosDeIa({
    repositorio: new RepositorioDeModelosDeIaSqlite(db),
    testes,
    catalogo: catalogoDeTeste(),
    doAmbiente: { ato: ATUAL, resumo: ATUAL, peca: ATUAL },
    leitor: new LeitorDeUsoDeIaSqlite(
      db,
      new RegistroDeOcorrenciasDeIaSqlite(db, relogio, logger),
    ),
    clock: relogio,
    logger,
    validadeDoCacheMs: 0,
  });
  verificacao = criar();
  instrucoes.salvarRascunho(OP, 'ato', 'Rascunho de estilo.', '');
});

describe('estimar e confirmar antes de enviar', () => {
  it('estima as chamadas e o custo no modelo em uso, sem rodar nada', () => {
    const e = verificacao.estimar('ato');
    expect(e).toMatchObject({
      funcao: 'ato',
      modelo: ATUAL,
      chamadas: 40,
      custoEstimadoUsd: 0.1,
      tetoUsd: 1,
      acimaDoTeto: false,
    });
    expect(executor.execucoes).toHaveLength(0);
  });

  it('sem confirmação nada é criado nem enviado', () => {
    expect(recusa(() => verificacao.iniciar(OP, 'ato', undefined, false))).toBe(
      'confirmacao_necessaria',
    );
    expect(executor.execucoes).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ia_testes_modelo').get()).toEqual({
      n: 0,
    });
  });

  it('estimativa acima do teto da rodada (US$ 1,00): recusa, e nada é enviado', () => {
    executor.custoEstimadoUsd = 1.5;
    expect(verificacao.estimar('ato').acimaDoTeto).toBe(true);
    expect(recusa(() => verificacao.iniciar(OP, 'ato', undefined, true))).toBe(
      'estimativa_acima_do_teto',
    );
    expect(executor.execucoes).toHaveLength(0);
  });

  it('sem chave do provedor (sem executor): indisponível', () => {
    const sem = criar(false);
    expect(sem.disponivel).toBe(false);
    expect(recusa(() => sem.estimar('ato'))).toBe('verificacao_indisponivel');
    expect(recusa(() => sem.iniciar(OP, 'ato', undefined, true))).toBe(
      'verificacao_indisponivel',
    );
  });

  it('função desconhecida e texto acima do limite são recusados sem repetir o valor', () => {
    expect(recusa(() => verificacao.estimar('forjada'))).toBe('funcao_desconhecida');
    expect(recusa(() => verificacao.estimar('ato', 'a'.repeat(4001)))).toBe(
      'texto_grande',
    );
  });
});

describe('o fluxo', () => {
  it('roda com o texto publicado e o do rascunho, no modelo em uso, e guarda SÓ números (tipo instrucoes)', async () => {
    const a = instrucoes.salvarRascunho(OP, 'resumo', 'Publicada de estilo.', '');
    instrucoes.publicar(OP, 'resumo', { versao: a.versao, confirmado: true });
    instrucoes.salvarRascunho(OP, 'resumo', 'Novo rascunho de estilo.', '');
    const t = verificacao.iniciar(OP, 'resumo', undefined, true);
    expect(t).toMatchObject({
      tipo: 'instrucoes',
      funcao: 'resumo',
      estado: 'na_fila',
      candidato: ATUAL,
      referencia: ATUAL,
    });
    await verificacao.aguardarFim();
    expect(executor.execucoes).toEqual([
      {
        funcao: 'resumo',
        modelo: ATUAL,
        publicada: 'Publicada de estilo.',
        rascunho: 'Novo rascunho de estilo.',
        tetoUsd: 1,
      },
    ]);
    const fim = verificacao.consultar(t.id);
    expect(fim).toMatchObject({
      estado: 'concluido',
      chamadasFeitas: 2,
      gastoUsd: 0.08,
      instrucaoVersao: 2,
    });
    expect(fim.metricasDoCandidato).toBeDefined();
    // nenhum texto de instrução, de fixture ou de resposta na linha do banco
    const linha = JSON.stringify(db.prepare('SELECT * FROM ia_testes_modelo').all());
    expect(linha).not.toContain('estilo');
  });

  it('usa o texto da tela (ainda não salvo) quando vem, e o rascunho salvo quando não vem', async () => {
    verificacao.iniciar(OP, 'ato', 'Texto digitado na tela.', true);
    await verificacao.aguardarFim();
    verificacao.iniciar(OP, 'ato', undefined, true);
    await verificacao.aguardarFim();
    expect(executor.execucoes.map((e) => e.rascunho)).toEqual([
      'Texto digitado na tela.',
      'Rascunho de estilo.',
    ]);
  });

  it('piora é AVISO, nunca bloqueio: com violações e citação baixa o operador ainda publica', async () => {
    executor.resultado = {
      tipo: 'ok',
      candidato: metricas({ modelo: ATUAL, violacoes: 3, citacaoVerificada: 0.8 }),
      referencia: metricas({ modelo: ATUAL }),
      gastoUsd: 0.08,
      tetoAtingido: false,
    };
    const t = verificacao.iniciar(OP, 'ato', undefined, true);
    await verificacao.aguardarFim();
    const fim = verificacao.consultar(t.id);
    const piora = avisosDePiora(fim.metricasDoCandidato!, fim.metricasDaReferencia!);
    expect(piora.semPiora).toBe(false);
    expect(piora.avisos.some((a) => a.gravidade === 'grave')).toBe(true);
    // o veredito de troca de modelo NÃO é gravado: a verificação não decide nada
    expect(fim.veredito).toBeUndefined();
    // e a publicação segue livre
    const r = instrucoes.estado('ato').rascunho!;
    expect(() =>
      instrucoes.publicar(OP, 'ato', { versao: r.versao, confirmado: true }),
    ).not.toThrow();
  });

  it('um por vez: com uma verificação em andamento, outra é recusada; terminou, passa', async () => {
    let liberar: () => void = () => undefined;
    executor.portao = new Promise<void>((r) => {
      liberar = r;
    });
    verificacao.iniciar(OP, 'ato', undefined, true);
    expect(recusa(() => verificacao.iniciar(OP, 'ato', undefined, true))).toBe(
      'verificacao_em_andamento',
    );
    expect(verificacao.emAndamento()?.tipo).toBe('instrucoes');
    liberar();
    await verificacao.aguardarFim();
    expect(recusa(() => verificacao.iniciar(OP, 'ato', undefined, true))).toBe(
      'nao_recusou',
    );
    await verificacao.aguardarFim();
  });

  it('cancelar aborta e marca cancelado', async () => {
    let liberar: () => void = () => undefined;
    executor.portao = new Promise<void>((r) => {
      liberar = r;
    });
    const t = verificacao.iniciar(OP, 'ato', undefined, true);
    verificacao.cancelar(t.id);
    liberar();
    await verificacao.aguardarFim();
    expect(verificacao.consultar(t.id).estado).toBe('cancelado');
  });

  it('falha interna: o teste vira "falhou" (erro interno) sem a mensagem do erro em lugar nenhum', async () => {
    executor.falhar = true;
    const t = verificacao.iniciar(OP, 'ato', undefined, true);
    await verificacao.aguardarFim();
    expect(verificacao.consultar(t.id)).toMatchObject({
      estado: 'falhou',
      falha: 'erro_interno',
    });
    expect(logger.linhas.join('\n')).not.toContain('SEGREDO-NAO-VAZAR');
    expect(
      JSON.stringify(db.prepare('SELECT * FROM ia_testes_modelo').all()),
    ).not.toContain('SEGREDO');
  });

  it('sem ZDR do modelo: concluído com o bloqueio "sem_zdr" (informativo) e nada enviado', async () => {
    executor.resultado = { tipo: 'sem_zdr' };
    const t = verificacao.iniciar(OP, 'ato', undefined, true);
    await verificacao.aguardarFim();
    expect(verificacao.consultar(t.id)).toMatchObject({
      estado: 'concluido',
      bloqueios: ['sem_zdr'],
    });
  });

  it('o reinício do servidor marca o que estava rodando como falhou (reiniciado), como na Fase B', async () => {
    let liberar: () => void = () => undefined;
    executor.portao = new Promise<void>((r) => {
      liberar = r;
    });
    const t = verificacao.iniciar(OP, 'ato', undefined, true);
    testes.marcarInterrompidos(relogio.agora());
    expect(verificacao.consultar(t.id)).toMatchObject({
      estado: 'falhou',
      falha: 'reiniciado',
    });
    liberar();
    await verificacao.aguardarFim();
  });

  it('consultar o id de um teste de MODELO não devolve nada (outra tela)', () => {
    const t: Parameters<RepositorioDeTestesDeModeloSqlite['criar']>[0] = {
      id: 'modelo-1',
      funcao: 'ato',
      candidato: NOVO,
      referencia: ATUAL,
      estado: 'concluido',
      autor: OP,
      criadoEm: relogio.agora(),
      chamadasPrevistas: 1,
      chamadasFeitas: 1,
      estimativaUsd: null,
      gastoUsd: null,
      bloqueios: [],
      ressalvas: [],
    };
    testes.criar(t);
    expect(recusa(() => verificacao.consultar('modelo-1'))).toBe(
      'verificacao_nao_encontrada',
    );
    expect(recusa(() => verificacao.consultar('nao-existe'))).toBe(
      'verificacao_nao_encontrada',
    );
  });
});

describe('convivência com o teste de modelo da Fase B', () => {
  it('as duas coisas dividem o "um por vez": teste de modelo rodando bloqueia a verificação, e vice-versa', async () => {
    const executorDeModelo = new ExecutorFalso();
    let liberar: () => void = () => undefined;
    executorDeModelo.portao = new Promise<void>((r) => {
      liberar = r;
    });
    const testeDeModelo = new ServicoTesteDeModelo({
      executor: executorDeModelo,
      modelos,
      testes,
      registro: new RepositorioDeModelosDeIaSqlite(db),
      clock: relogio,
      logger,
      novoId: () => `m-${++n}`,
    });
    testeDeModelo.iniciar(OP, 'ato', NOVO, true);
    expect(recusa(() => verificacao.iniciar(OP, 'ato', undefined, true))).toBe(
      'verificacao_em_andamento',
    );
    liberar();
    await testeDeModelo.aguardarFim();

    let liberar2: () => void = () => undefined;
    executor.portao = new Promise<void>((r) => {
      liberar2 = r;
    });
    verificacao.iniciar(OP, 'ato', undefined, true);
    expect(recusa(() => testeDeModelo.iniciar(OP, 'ato', NOVO, true))).toBe(
      'teste_em_andamento',
    );
    // a tela da Fase B não mostra a verificação das instruções como "teste em andamento"
    expect(testeDeModelo.emAndamento()).toBeUndefined();
    liberar2();
    await verificacao.aguardarFim();
  });

  it('a verificação de instruções nunca serve para publicar MODELO (e não aparece como o último teste do modelo)', async () => {
    const t = verificacao.iniciar(OP, 'ato', undefined, true);
    await verificacao.aguardarFim();
    expect(testes.ultimoDaFuncao('ato')).toBeUndefined();
    expect(testes.ultimoDeInstrucoes('ato')?.id).toBe(t.id);
    expect(
      recusa(() => modelos.publicar(OP, 'ato', { testeId: t.id, confirmado: true })),
    ).toBe('teste_nao_encontrado');
  });
});
