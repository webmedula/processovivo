import { beforeEach, describe, expect, it } from 'vitest';
import {
  ServicoModelosDeIa,
  type PedidoDePublicacao,
} from '../../src/application/services/ServicoModelosDeIa.js';
import { ModeloDeIaRecusadoError } from '../../src/domain/errors/index.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import type {
  RepositorioDeModelosDeIa,
  TesteDeModelo,
} from '../../src/domain/ports/ModelosDeIa.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import {
  RepositorioDeConfigDeIaSqlite,
  RegistroDeOcorrenciasDeIaSqlite,
  LeitorDeUsoDeIaSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';
import {
  RepositorioDeModelosDeIaSqlite,
  RepositorioDeTestesDeModeloSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDeModelosDeIaSqlite.js';
import { LoggerColetor } from '../helpers/analiseIa.js';
import {
  ATUAL,
  DESCONTINUADO,
  NOVO,
  PENDENTE,
  catalogoDeTeste,
  item,
  metricas,
} from '../helpers/modelosDeIa.js';
import { criarCatalogo } from '../../src/domain/entities/ModelosDeIa.js';

/*
 * O modelo por função (Fase B): precedência painel → ambiente, falha segura, publicar só com teste válido
 * do MESMO par e dentro de 24 h, ressalva com confirmação digitada e motivo, reverter restaura o anterior,
 * registro sem dado pessoal. Banco em memória, relógio falso.
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
let repo: RepositorioDeModelosDeIaSqlite;
let testes: RepositorioDeTestesDeModeloSqlite;
let logger: LoggerColetor;

function servico(
  sobre: Partial<ConstructorParameters<typeof ServicoModelosDeIa>[0]> = {},
): ServicoModelosDeIa {
  return new ServicoModelosDeIa({
    repositorio: repo,
    testes,
    catalogo: catalogoDeTeste(),
    doAmbiente: { ato: ATUAL, resumo: ATUAL, peca: ATUAL },
    leitor: new LeitorDeUsoDeIaSqlite(
      db,
      new RegistroDeOcorrenciasDeIaSqlite(db, relogio, logger),
    ),
    clock: relogio,
    logger,
    ocorrencias: new RegistroDeOcorrenciasDeIaSqlite(db, relogio, logger),
    validadeDoCacheMs: 0,
    ...sobre,
  });
}

/** Grava um teste concluído do par (funcao, NOVO) × ATUAL, terminado há `haMinutos`. */
function testeConcluido(
  id: string,
  sobre: Partial<TesteDeModelo> = {},
  haMinutos = 10,
): TesteDeModelo {
  const terminado = new Date(relogio.ms - haMinutos * 60_000);
  const t: TesteDeModelo = {
    id,
    funcao: 'ato',
    candidato: NOVO,
    referencia: ATUAL,
    estado: 'concluido',
    autor: 'ab12cd34',
    criadoEm: new Date(terminado.getTime() - 60_000),
    terminadoEm: terminado,
    chamadasPrevistas: 20,
    chamadasFeitas: 20,
    estimativaUsd: 0.05,
    gastoUsd: 0.05,
    metricasDoCandidato: metricas({ modelo: NOVO }),
    metricasDaReferencia: metricas(),
    veredito: 'aprovado',
    bloqueios: [],
    ressalvas: [],
    ...sobre,
  };
  testes.criar(t);
  testes.atualizar(id, {
    estado: t.estado,
    terminadoEm: t.terminadoEm!,
    ...(t.metricasDoCandidato ? { metricasDoCandidato: t.metricasDoCandidato } : {}),
    ...(t.metricasDaReferencia ? { metricasDaReferencia: t.metricasDaReferencia } : {}),
    ...(t.veredito ? { veredito: t.veredito } : {}),
    bloqueios: t.bloqueios,
    ressalvas: t.ressalvas,
  });
  return t;
}

const publicarOk = (id: string): PedidoDePublicacao => ({
  testeId: id,
  confirmado: true,
});

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
  logger = new LoggerColetor();
  db = abrirBanco(':memory:');
  repo = new RepositorioDeModelosDeIaSqlite(db);
  testes = new RepositorioDeTestesDeModeloSqlite(db);
});

describe('precedência e falha segura', () => {
  it('sem nada no painel, vale o modelo do ambiente', () => {
    expect(servico().efetivo('ato')).toEqual({
      modelo: ATUAL,
      origem: 'ambiente',
      painelInvalido: false,
    });
  });

  it('um modelo publicado vale só para a função publicada: trocar uma não mexe nas outras', () => {
    const s = servico();
    testeConcluido('t1');
    s.publicar('op', 'ato', publicarOk('t1'));
    expect(s.efetivo('ato').modelo).toBe(NOVO);
    expect(s.efetivo('resumo').modelo).toBe(ATUAL);
    expect(s.efetivo('peca').modelo).toBe(ATUAL);
  });

  it('leitura do banco que falha devolve o ambiente, sem lançar, e avisa no log sem a mensagem do erro', () => {
    const quebrado: RepositorioDeModelosDeIa = {
      ler: () => {
        throw new Error('caminho /dados/segredo.db travado');
      },
      publicar: () => undefined,
      registrar: () => undefined,
    };
    const s = servico({ repositorio: quebrado });
    expect(s.efetivo('ato').modelo).toBe(ATUAL);
    expect(s.modeloParaChamada('resumo')).toBe(ATUAL);
    const log = logger.linhas.join('\n');
    expect(log).toContain('modelos do painel de IA indisponíveis');
    expect(log).not.toContain('segredo.db');
  });

  it('modelo do painel que saiu da lista cai no ambiente, sem erro, avisa e CONTA uma ocorrência por chamada', () => {
    testeConcluido('t1');
    servico().publicar('op', 'ato', publicarOk('t1'));
    // A lista do código muda (modelo removido): o painel guarda um id que não vale mais.
    const s = servico({ catalogo: criarCatalogo([item(ATUAL)]) });
    expect(s.efetivo('ato')).toEqual({
      modelo: ATUAL,
      origem: 'ambiente',
      painelInvalido: true,
    });
    expect(s.modeloParaChamada('ato')).toBe(ATUAL);
    expect(s.modeloParaChamada('ato')).toBe(ATUAL);
    const conta = db
      .prepare(
        "SELECT SUM(contagem) AS c FROM ia_ocorrencias_dia WHERE funcao='ato' AND motivo='modelo_do_painel_invalido'",
      )
      .get() as { c: number };
    expect(conta.c).toBe(2);
  });

  it('modelo descontinuado no painel cai no padrão', () => {
    db.prepare(
      "INSERT INTO ia_config (chave, modelo, atualizado_em) VALUES ('ato', ?, 'x')",
    ).run(DESCONTINUADO);
    expect(servico().efetivo('ato')).toEqual({
      modelo: ATUAL,
      origem: 'ambiente',
      painelInvalido: true,
    });
  });

  it('o liga/desliga e os tetos da Fase A não apagam o modelo, nem o contrário', () => {
    testeConcluido('t1');
    const s = servico();
    s.publicar('op', 'ato', publicarOk('t1'));
    new RepositorioDeConfigDeIaSqlite(db).gravar(
      {
        funcoes: {
          ato: { ligada: false, tetoPorConta: 10 },
          resumo: { ligada: true, tetoPorConta: null },
          peca: { ligada: true, tetoPorConta: null },
        },
        tetoGlobal: null,
        alertaCustoDiaUsd: 3,
      },
      {
        em: relogio.agora(),
        autor: 'op',
        funcao: 'ato',
        tipo: 'ligada',
        anterior: 'ligada',
        novo: 'desligada',
      },
      relogio.agora(),
    );
    expect(s.efetivo('ato').modelo).toBe(NOVO);
    expect(new RepositorioDeConfigDeIaSqlite(db).ler().funcoes.ato.ligada).toBe(false);
  });

  it('função desconhecida é recusada', () => {
    expect(motivoDa(() => servico().publicar('op', 'inventada', publicarOk('t')))).toBe(
      'funcao_desconhecida',
    );
    expect(motivoDa(() => servico().reverter('op', 'inventada', true))).toBe(
      'funcao_desconhecida',
    );
  });
});

describe('publicar', () => {
  it('aprovado: um clique mais a confirmação; grava o modelo, o anterior, o instante e o registro', () => {
    testeConcluido('t1');
    const s = servico();
    s.publicar('ab12cd34', 'ato', publicarOk('t1'));
    const g = repo.ler().ato;
    expect(g.modelo).toBe(NOVO);
    expect(g.anterior).toBe(ATUAL);
    expect(g.desde).toEqual(relogio.agora());
    const reg = db
      .prepare('SELECT * FROM ia_alteracoes ORDER BY id DESC LIMIT 1')
      .get() as Record<string, string | null>;
    expect(reg).toMatchObject({
      autor: 'ab12cd34',
      funcao: 'ato',
      tipo: 'modelo_publicado',
      valor_anterior: ATUAL,
      valor_novo: NOVO,
      teste_id: 't1',
      aprovacao: null,
    });
  });

  it('sem a confirmação no pedido, não publica', () => {
    testeConcluido('t1');
    expect(
      motivoDa(() =>
        servico().publicar('op', 'ato', { testeId: 't1', confirmado: false }),
      ),
    ).toBe('confirmacao_necessaria');
    expect(repo.ler().ato.modelo).toBeNull();
  });

  it.each([
    ['teste que não existe', () => undefined, 'teste_nao_encontrado'],
    [
      'teste de outra função',
      () => testeConcluido('t1', { funcao: 'resumo' }),
      'teste_de_outro_modelo',
    ],
    [
      'teste ainda em andamento',
      () => testeConcluido('t1', { estado: 'executando' }),
      'teste_nao_concluido',
    ],
    [
      'teste que falhou',
      () => testeConcluido('t1', { estado: 'falhou' }),
      'teste_nao_concluido',
    ],
    [
      'teste cancelado',
      () => testeConcluido('t1', { estado: 'cancelado' }),
      'teste_nao_concluido',
    ],
    [
      'teste com mais de 24 horas',
      () => testeConcluido('t1', {}, 24 * 60 + 1),
      'teste_antigo',
    ],
    [
      'teste bloqueado',
      () =>
        testeConcluido('t1', {
          veredito: 'bloqueado',
          metricasDoCandidato: metricas({ modelo: NOVO, violacoes: 3 }),
        }),
      'veredito_bloqueado',
    ],
    [
      'candidato que saiu da lista',
      () => testeConcluido('t1', { candidato: 'fabrica-z/sumiu' }),
      'modelo_fora_da_lista',
    ],
    [
      'candidato descontinuado',
      () => testeConcluido('t1', { candidato: DESCONTINUADO }),
      'modelo_fora_da_lista',
    ],
    [
      'candidato pendente de confirmação',
      () => testeConcluido('t1', { candidato: PENDENTE }),
      'modelo_fora_da_lista',
    ],
    [
      'referência que não é mais o modelo em uso',
      () => testeConcluido('t1', { referencia: 'fabrica-y/outro' }),
      'modelo_atual_mudou',
    ],
  ])('recusa %s', (_n, preparar, esperado) => {
    preparar();
    expect(motivoDa(() => servico().publicar('op', 'ato', publicarOk('t1')))).toBe(
      esperado,
    );
    expect(repo.ler().ato.modelo).toBeNull();
  });

  it('teste com 23h59 ainda vale; o de 24h01 não', () => {
    testeConcluido('novo', {}, 24 * 60 - 1);
    expect(motivoDa(() => servico().publicar('op', 'ato', publicarOk('novo')))).toBe(
      'nao-recusou',
    );
  });

  it('o veredito é recalculado das métricas: um "aprovado" gravado a mais não afrouxa a regra', () => {
    testeConcluido('t1', {
      veredito: 'aprovado',
      metricasDoCandidato: metricas({ modelo: NOVO, citacaoVerificada: 0.9 }),
    });
    expect(motivoDa(() => servico().publicar('op', 'ato', publicarOk('t1')))).toBe(
      'veredito_bloqueado',
    );
  });

  it('violação a mais bloqueia MESMO com a aprovação digitada', () => {
    testeConcluido('t1', {
      veredito: 'aprovado_com_ressalva',
      metricasDoCandidato: metricas({ modelo: NOVO, violacoes: 1 }),
    });
    const pedido = { ...publicarOk('t1'), palavra: 'PUBLICAR', motivo: 'outro' };
    expect(motivoDa(() => servico().publicar('op', 'ato', pedido))).toBe(
      'veredito_bloqueado',
    );
  });

  describe('com ressalvas', () => {
    beforeEach(() => {
      testeConcluido('r1', {
        veredito: 'aprovado_com_ressalva',
        ressalvas: ['custo_maior'],
        metricasDoCandidato: metricas({ modelo: NOVO, custoMedioUsd: 0.01 }),
      });
    });

    it('exige a confirmação digitada e um motivo', () => {
      expect(motivoDa(() => servico().publicar('op', 'ato', publicarOk('r1')))).toBe(
        'ressalva_exige_aprovacao',
      );
      for (const pedido of [
        { ...publicarOk('r1'), palavra: 'publicar', motivo: 'custo_aceitavel' },
        { ...publicarOk('r1'), palavra: 'PUBLICAR' },
        { ...publicarOk('r1'), palavra: 'PUBLICAR', motivo: 'motivo_inventado' },
        {
          ...publicarOk('r1'),
          palavra: 'PUBLICAR',
          motivo: 'outro',
          observacao: 'fale com a@b.test',
        },
      ]) {
        expect(motivoDa(() => servico().publicar('op', 'ato', pedido))).toBe(
          'aprovacao_invalida',
        );
      }
      expect(repo.ler().ato.modelo).toBeNull();
    });

    it('publica com a palavra, o motivo e a observação, e grava a aprovação no registro', () => {
      servico().publicar('op', 'ato', {
        ...publicarOk('r1'),
        palavra: 'PUBLICAR',
        motivo: 'custo_aceitavel',
        observacao: 'Vale pela qualidade',
      });
      expect(repo.ler().ato.modelo).toBe(NOVO);
      const reg = db
        .prepare('SELECT aprovacao, teste_id FROM ia_alteracoes ORDER BY id DESC LIMIT 1')
        .get() as Record<string, string>;
      expect(reg).toEqual({
        aprovacao: 'custo_aceitavel: Vale pela qualidade',
        teste_id: 'r1',
      });
    });
  });

  it('o registro não carrega e-mail, nome, número de processo nem texto de ato', () => {
    testeConcluido('t1');
    servico().publicar('ab12cd34', 'ato', publicarOk('t1'));
    const tudo = JSON.stringify(db.prepare('SELECT * FROM ia_alteracoes').all());
    expect(tudo).not.toMatch(/@/);
    expect(tudo).not.toMatch(/\d{7}-\d{2}/);
  });
});

describe('reverter', () => {
  it('restaura exatamente o modelo anterior, sem novo teste, e registra', () => {
    testeConcluido('t1');
    const s = servico();
    s.publicar('op', 'ato', publicarOk('t1'));
    expect(s.podeReverter('ato')).toBe(true);
    s.reverter('op', 'ato', true);
    expect(s.efetivo('ato').modelo).toBe(ATUAL);
    const reg = db
      .prepare('SELECT * FROM ia_alteracoes ORDER BY id DESC LIMIT 1')
      .get() as Record<string, string | null>;
    expect(reg).toMatchObject({
      tipo: 'modelo_revertido',
      valor_anterior: NOVO,
      valor_novo: ATUAL,
    });
    expect(s.podeReverter('ato')).toBe(false);
  });

  it('exige a confirmação e recusa quando não há anterior', () => {
    expect(motivoDa(() => servico().reverter('op', 'ato', true))).toBe(
      'sem_modelo_anterior',
    );
    testeConcluido('t1');
    const s = servico();
    s.publicar('op', 'ato', publicarOk('t1'));
    expect(motivoDa(() => s.reverter('op', 'ato', false))).toBe('confirmacao_necessaria');
    expect(s.efetivo('ato').modelo).toBe(NOVO);
  });

  it('reverter não mexe nas outras funções', () => {
    testeConcluido('t1');
    testeConcluido('t2', { funcao: 'resumo' });
    const s = servico();
    s.publicar('op', 'ato', publicarOk('t1'));
    s.publicar('op', 'resumo', publicarOk('t2'));
    s.reverter('op', 'ato', true);
    expect(s.efetivo('ato').modelo).toBe(ATUAL);
    expect(s.efetivo('resumo').modelo).toBe(NOVO);
  });

  it('voltar ao modelo do ambiente devolve a função a seguir o ambiente (nada fica fixado no painel)', () => {
    testeConcluido('t1');
    const s = servico();
    s.publicar('op', 'ato', publicarOk('t1'));
    s.reverter('op', 'ato', true);
    expect(s.efetivo('ato').origem).toBe('ambiente');
    expect(repo.ler().ato).toMatchObject({ modelo: null, anterior: null });
  });

  it('se o modelo anterior saiu da lista e não é o do ambiente, a reversão é recusada e nada muda', () => {
    testeConcluido('t1');
    servico().publicar('op', 'ato', publicarOk('t1'));
    // Depois: a lista do código perde o antigo e o ambiente passa a mandar outro modelo.
    const s = servico({
      catalogo: criarCatalogo([item(NOVO), item('fabrica-q/ambiente')]),
      doAmbiente: { ato: 'fabrica-q/ambiente', resumo: ATUAL, peca: ATUAL },
    });
    expect(s.podeReverter('ato')).toBe(false);
    expect(motivoDa(() => s.reverter('op', 'ato', true))).toBe(
      'modelo_anterior_indisponivel',
    );
    expect(repo.ler().ato.modelo).toBe(NOVO);
  });

  it('a referência pode ser o modelo de produção ainda PENDENTE de confirmação: ele só não é oferecido como troca', () => {
    const s = servico({
      catalogo: criarCatalogo([
        item(ATUAL, {
          confirmacao: 'pendente',
          zdrConfirmadoEm: null,
          zdrFonte: null,
          precoEntradaPorMTokens: null,
          precoSaidaPorMTokens: null,
        }),
        item(NOVO),
      ]),
    });
    expect(s.efetivo('ato').modelo).toBe(ATUAL);
    expect(s.candidatos('ato').map((c) => c.id)).toEqual([NOVO]);
    testeConcluido('t1');
    s.publicar('op', 'ato', publicarOk('t1'));
    s.reverter('op', 'ato', true);
    expect(s.efetivo('ato').modelo).toBe(ATUAL);
  });
});
