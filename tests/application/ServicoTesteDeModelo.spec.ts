import { beforeEach, describe, expect, it } from 'vitest';
import { ServicoModelosDeIa } from '../../src/application/services/ServicoModelosDeIa.js';
import { ServicoTesteDeModelo } from '../../src/application/services/ServicoTesteDeModelo.js';
import { ModeloDeIaRecusadoError } from '../../src/domain/errors/index.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import {
  LeitorDeUsoDeIaSqlite,
  RegistroDeOcorrenciasDeIaSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';
import {
  RepositorioDeModelosDeIaSqlite,
  RepositorioDeTestesDeModeloSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDeModelosDeIaSqlite.js';
import { LoggerColetor } from '../helpers/analiseIa.js';
import {
  ATUAL,
  DESCONTINUADO,
  ExecutorFalso,
  NOVO,
  PENDENTE,
  SO_RESUMO,
  catalogoDeTeste,
  metricas,
} from '../helpers/modelosDeIa.js';

/*
 * O teste obrigatório de modelo (Fase B): job em segundo plano com estado no banco. Um por vez, cancelamento,
 * teto de gasto, reinício marca "falhou", estimativa ANTES de enviar e nada de texto de fixture ou de resposta
 * gravado. Executor dublê; nenhuma rede, nenhum relógio real.
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

let relogio: Relogio;
let db: ReturnType<typeof abrirBanco>;
let testes: RepositorioDeTestesDeModeloSqlite;
let executor: ExecutorFalso;
let modelos: ServicoModelosDeIa;
let servico: ServicoTesteDeModelo;
let contador = 0;

function montar(
  opcoes: { executor?: ExecutorFalso | undefined; tetoUsd?: number } = {},
): ServicoTesteDeModelo {
  const repoModelos = new RepositorioDeModelosDeIaSqlite(db);
  const ocorrencias = new RegistroDeOcorrenciasDeIaSqlite(
    db,
    relogio,
    new LoggerColetor(),
  );
  modelos = new ServicoModelosDeIa({
    repositorio: repoModelos,
    testes,
    catalogo: catalogoDeTeste(),
    doAmbiente: { ato: ATUAL, resumo: ATUAL, peca: ATUAL },
    leitor: new LeitorDeUsoDeIaSqlite(db, ocorrencias),
    clock: relogio,
    logger: new LoggerColetor(),
    validadeDoCacheMs: 0,
  });
  return new ServicoTesteDeModelo({
    executor: 'executor' in opcoes ? opcoes.executor : executor,
    modelos,
    testes,
    registro: repoModelos,
    clock: relogio,
    logger: new LoggerColetor(),
    novoId: () => `teste-${++contador}`,
    ...(opcoes.tetoUsd !== undefined ? { tetoUsd: opcoes.tetoUsd } : {}),
  });
}

function motivoDa(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof ModeloDeIaRecusadoError) return e.motivo;
    throw e;
  }
  return 'nao-recusou';
}

beforeEach(() => {
  relogio = new Relogio();
  db = abrirBanco(':memory:');
  testes = new RepositorioDeTestesDeModeloSqlite(db);
  executor = new ExecutorFalso();
  servico = montar();
});

describe('antes de rodar', () => {
  it('mostra a estimativa de chamadas e de custo SEM enviar nada ao modelo', () => {
    executor.chamadas = 96;
    executor.custoEstimadoUsd = 0.12;
    const e = servico.estimar('ato', NOVO);
    expect(e).toMatchObject({
      funcao: 'ato',
      candidato: NOVO,
      referencia: ATUAL,
      chamadas: 96,
      custoEstimadoUsd: 0.12,
      tetoUsd: 1,
      acimaDoTeto: false,
    });
    expect(executor.execucoes).toHaveLength(0);
    expect(executor.estimativas[0]?.modelos).toEqual([ATUAL, NOVO]);
  });

  it('o teto padrão da rodada é US$ 1,00', () => {
    expect(servico.teto).toBe(1);
  });

  it('só testa com a confirmação da estimativa', () => {
    expect(motivoDa(() => servico.iniciar('op', 'ato', NOVO, false))).toBe(
      'confirmacao_necessaria',
    );
    expect(executor.execucoes).toHaveLength(0);
  });

  it('estimativa acima do teto da rodada recusa, sem enviar nada', () => {
    executor.custoEstimadoUsd = 1.01;
    expect(servico.estimar('ato', NOVO).acimaDoTeto).toBe(true);
    expect(motivoDa(() => servico.iniciar('op', 'ato', NOVO, true))).toBe(
      'estimativa_acima_do_teto',
    );
    expect(executor.execucoes).toHaveLength(0);
  });

  it.each([
    ['id forjado', 'fabrica-z/inventado'],
    ['modelo descontinuado', DESCONTINUADO],
    ['modelo pendente de confirmação', PENDENTE],
    ['modelo de outra função', SO_RESUMO],
    ['id com apelido', '~fabrica/modelo-latest'],
  ])('recusa %s como candidato, sem enviar nada', (_n, id) => {
    expect(motivoDa(() => servico.estimar('ato', id))).toBe('modelo_fora_da_lista');
    expect(motivoDa(() => servico.iniciar('op', 'ato', id, true))).toBe(
      'modelo_fora_da_lista',
    );
    expect(executor.execucoes).toHaveLength(0);
  });

  it('recusa testar o modelo que já está em uso, e função desconhecida', () => {
    expect(motivoDa(() => servico.iniciar('op', 'ato', ATUAL, true))).toBe(
      'modelo_igual_ao_atual',
    );
    expect(motivoDa(() => servico.iniciar('op', 'inventada', NOVO, true))).toBe(
      'funcao_desconhecida',
    );
  });

  it('sem executor (IA desligada no ambiente) o teste é indisponível, mas a consulta segue', () => {
    const sem = montar({ executor: undefined });
    expect(sem.disponivel).toBe(false);
    expect(motivoDa(() => sem.estimar('ato', NOVO))).toBe('teste_indisponivel');
    expect(motivoDa(() => sem.iniciar('op', 'ato', NOVO, true))).toBe(
      'teste_indisponivel',
    );
    expect(sem.ultimoDaFuncao('ato')).toBeUndefined();
  });
});

describe('o job', () => {
  it('roda candidato e atual na mesma rodada e conclui com o veredito pelas regras', async () => {
    const t = servico.iniciar('ab12cd34', 'ato', NOVO, true);
    expect(t.estado).toBe('na_fila');
    await servico.aguardarFim();
    const final = servico.consultar(t.id);
    expect(final.estado).toBe('concluido');
    expect(final.veredito).toBe('aprovado');
    expect(final.metricasDoCandidato?.modelo).toBe(NOVO);
    expect(final.metricasDaReferencia?.modelo).toBe(ATUAL);
    expect(executor.execucoes[0]).toMatchObject({
      candidato: NOVO,
      referencia: ATUAL,
      tetoUsd: 1,
    });
  });

  it('veredito com ressalva e bloqueios saem das regras, com os códigos', async () => {
    executor.resultado = {
      tipo: 'ok',
      candidato: metricas({ modelo: NOVO, violacoes: 2, custoMedioUsd: 0.5 }),
      referencia: metricas(),
      gastoUsd: 0.1,
      tetoAtingido: false,
    };
    const t = servico.iniciar('op', 'ato', NOVO, true);
    await servico.aguardarFim();
    const f = servico.consultar(t.id);
    expect(f.veredito).toBe('bloqueado');
    expect(f.bloqueios).toContain('violacao_acima_da_referencia');
    expect(f.ressalvas).toContain('custo_maior');
  });

  it('só um teste por vez no sistema inteiro', async () => {
    let soltar!: () => void;
    executor.portao = new Promise<void>((r) => (soltar = r));
    servico.iniciar('op', 'ato', NOVO, true);
    expect(motivoDa(() => servico.iniciar('op', 'resumo', NOVO, true))).toBe(
      'teste_em_andamento',
    );
    soltar();
    await servico.aguardarFim();
    expect(motivoDa(() => servico.iniciar('op', 'resumo', NOVO, true))).toBe(
      'nao-recusou',
    );
    await servico.aguardarFim();
  });

  it('um teste em andamento de outra instância (banco) também barra', () => {
    testes.criar({
      id: 'fora',
      funcao: 'peca',
      candidato: NOVO,
      referencia: ATUAL,
      estado: 'executando',
      autor: 'x',
      criadoEm: relogio.agora(),
      chamadasPrevistas: 1,
      chamadasFeitas: 0,
      estimativaUsd: null,
      gastoUsd: null,
      bloqueios: [],
      ressalvas: [],
    });
    expect(motivoDa(() => servico.iniciar('op', 'ato', NOVO, true))).toBe(
      'teste_em_andamento',
    );
  });

  it('o progresso é gravado a cada chamada e o estado vira "executando"', async () => {
    let soltar!: () => void;
    executor.portao = new Promise<void>((r) => (soltar = r));
    executor.chamarAntes = 7;
    executor.chamadas = 20;
    const t = servico.iniciar('op', 'ato', NOVO, true);
    expect(servico.consultar(t.id)).toMatchObject({
      estado: 'executando',
      chamadasFeitas: 7,
      chamadasPrevistas: 20,
    });
    soltar();
    await servico.aguardarFim();
  });

  it('cancelar aborta e marca "cancelado", sem veredito', async () => {
    let soltar!: () => void;
    executor.portao = new Promise<void>((r) => (soltar = r));
    const t = servico.iniciar('op', 'ato', NOVO, true);
    const sinal = executor.execucoes.length;
    expect(sinal).toBe(1);
    servico.cancelar(t.id);
    soltar();
    await servico.aguardarFim();
    const f = servico.consultar(t.id);
    expect(f.estado).toBe('cancelado');
    expect(f.veredito).toBeUndefined();
    // depois de cancelado, outro teste pode rodar
    expect(motivoDa(() => servico.iniciar('op', 'ato', NOVO, true))).toBe('nao-recusou');
    await servico.aguardarFim();
  });

  it('teto de gasto atingido interrompe: marca "falhou" com o motivo, sem veredito e sem métricas', async () => {
    executor.resultado = {
      tipo: 'ok',
      candidato: metricas({ modelo: NOVO }),
      referencia: metricas(),
      gastoUsd: 1.02,
      tetoAtingido: true,
    };
    const t = servico.iniciar('op', 'ato', NOVO, true);
    await servico.aguardarFim();
    const f = servico.consultar(t.id);
    expect(f).toMatchObject({ estado: 'falhou', falha: 'teto_de_gasto', gastoUsd: 1.02 });
    expect(f.veredito).toBeUndefined();
    expect(f.metricasDoCandidato).toBeUndefined();
  });

  it('modelo sem ZDR na lista oficial: nada enviado, bloqueio duro registrado', async () => {
    executor.resultado = { tipo: 'sem_zdr' };
    const t = servico.iniciar('op', 'ato', NOVO, true);
    await servico.aguardarFim();
    expect(servico.consultar(t.id)).toMatchObject({
      estado: 'concluido',
      veredito: 'bloqueado',
      bloqueios: ['sem_zdr'],
    });
  });

  it('lista ZDR inalcançável: falha, sem veredito', async () => {
    executor.resultado = { tipo: 'zdr_indisponivel' };
    const t = servico.iniciar('op', 'ato', NOVO, true);
    await servico.aguardarFim();
    expect(servico.consultar(t.id)).toMatchObject({
      estado: 'falhou',
      falha: 'zdr_indisponivel',
    });
  });

  it('erro inesperado do executor vira "falhou" sem copiar a mensagem do erro', async () => {
    executor.falhar = true;
    const t = servico.iniciar('op', 'ato', NOVO, true);
    await servico.aguardarFim();
    const f = servico.consultar(t.id);
    expect(f).toMatchObject({ estado: 'falhou', falha: 'erro_interno' });
    expect(
      JSON.stringify(db.prepare('SELECT * FROM ia_testes_modelo').all()),
    ).not.toContain('SEGREDO-NAO-VAZAR');
  });
});

describe('reinício do servidor', () => {
  it('marca "falhou" o que estava rodando, sem retomar sozinho', () => {
    for (const [id, estado] of [
      ['a', 'executando'],
      ['b', 'na_fila'],
      ['c', 'concluido'],
    ] as const) {
      testes.criar({
        id,
        funcao: 'ato',
        candidato: NOVO,
        referencia: ATUAL,
        estado,
        autor: 'x',
        criadoEm: relogio.agora(),
        chamadasPrevistas: 1,
        chamadasFeitas: 0,
        estimativaUsd: null,
        gastoUsd: null,
        bloqueios: [],
        ressalvas: [],
      });
    }
    expect(servico.recuperarNoArranque()).toBe(2);
    expect(testes.buscar('a')).toMatchObject({ estado: 'falhou', falha: 'reiniciado' });
    expect(testes.buscar('b')).toMatchObject({ estado: 'falhou', falha: 'reiniciado' });
    expect(testes.buscar('c')?.estado).toBe('concluido');
    expect(executor.execucoes).toHaveLength(0);
    expect(testes.emAndamento()).toBeUndefined();
  });
});

describe('o que fica gravado', () => {
  it('só ids, números e rótulos de lista fechada: nenhum texto de fixture ou de resposta do modelo', async () => {
    const t = servico.iniciar('ab12cd34', 'ato', NOVO, true);
    await servico.aguardarFim();
    const linha = JSON.stringify(
      db.prepare('SELECT * FROM ia_testes_modelo WHERE id = ?').get(t.id),
    );
    const colunas = (
      db.prepare('PRAGMA table_info(ia_testes_modelo)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(colunas).toEqual([
      'id',
      'funcao',
      'candidato',
      'referencia',
      'estado',
      'autor',
      'criado_em',
      'iniciado_em',
      'terminado_em',
      'chamadas_previstas',
      'chamadas_feitas',
      'estimativa_usd',
      'gasto_usd',
      'metricas_candidato',
      'metricas_referencia',
      'veredito',
      'bloqueios',
      'ressalvas',
      'falha',
      // Fase C (v0.61.0): o conjunto de verificação das instruções reaproveita esta tabela. As duas
      // colunas são rótulo fechado e número da edição — continua sem texto de fixture ou de resposta.
      'tipo',
      'instrucao_versao',
    ]);
    expect(linha).not.toMatch(/@/);
    const reg = db
      .prepare("SELECT * FROM ia_alteracoes WHERE tipo = 'teste_modelo_iniciado'")
      .get() as Record<string, string>;
    expect(reg).toMatchObject({
      funcao: 'ato',
      valor_anterior: ATUAL,
      valor_novo: NOVO,
      teste_id: t.id,
    });
  });
});
