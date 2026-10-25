import { beforeEach, describe, expect, it } from 'vitest';
import { ServicoModelosDeIa } from '../../src/application/services/ServicoModelosDeIa.js';
import { ProviderIndisponivelError } from '../../src/domain/errors/index.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import type { EndpointZdr } from '../../src/infrastructure/adapters/modelo/endpointsZdr.js';
import { ModeloComZdr } from '../../src/infrastructure/adapters/modelo/ModeloComZdr.js';
import { ModeloDaFuncao } from '../../src/infrastructure/adapters/modelo/ModeloDaFuncao.js';
import { OpenRouterAnalisadorDeAto } from '../../src/infrastructure/adapters/modelo/OpenRouterAnalisadorDeAto.js';
import { OpenRouterResumidorDeProcesso } from '../../src/infrastructure/adapters/modelo/OpenRouterResumidorDeProcesso.js';
import { TransporteOpenRouter } from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import {
  LeitorDeUsoDeIaSqlite,
  RegistroDeOcorrenciasDeIaSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';
import {
  RepositorioDeModelosDeIaSqlite,
  RepositorioDeTestesDeModeloSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDeModelosDeIaSqlite.js';
import { LoggerColetor, respostaValida } from '../helpers/analiseIa.js';
import { ClockFalso } from '../helpers/leitor.js';
import { respostaDoResumo } from '../helpers/resumoIa.js';
import { ATUAL, NOVO, catalogoDeTeste, metricas } from '../helpers/modelosDeIa.js';

/*
 * ZDR HOSTIL: o modelo agora é escolhido a cada chamada pelo painel, e NENHUMA combinação de configuração
 * pode produzir uma chamada sem ZDR. Transporte e fio reais (fetch dublê); a lista ZDR e o painel mudam.
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

const SEGREDO = 'TEXTO-SECRETO-DO-ATO';
const lista = (...modelos: string[]): EndpointZdr[] =>
  modelos.map((modelo) => ({ modelo, provedor: 'Alfa', tag: 'alfa/fp8' }));

let relogio: Relogio;
let db: ReturnType<typeof abrirBanco>;
let corpos: Array<Record<string, unknown>>;
let listaZdr: () => Promise<readonly EndpointZdr[]>;
let resposta: (corpo: Record<string, unknown>) => Response;

const json = (c: unknown, status = 200): Response =>
  new Response(JSON.stringify(c), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const corpoOk = (modelo: string, conteudo: unknown): unknown => ({
  id: 'g-1',
  model: modelo,
  provider: 'Alfa',
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify(conteudo) },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, cost: 0.0004 },
});

function montar(doAmbiente = ATUAL) {
  const fetchDuble = (async (_u: string, init: RequestInit) => {
    const corpo = JSON.parse(String(init.body)) as Record<string, unknown>;
    corpos.push(corpo);
    return resposta(corpo);
  }) as unknown as typeof fetch;
  const transporte = new TransporteOpenRouter({
    chave: 'sk-or-chave-de-teste-123456',
    fetch: fetchDuble,
    esperasEntreTentativasMs: [0, 0],
    dormir: async () => {},
  });
  const modelos = new ServicoModelosDeIa({
    repositorio: new RepositorioDeModelosDeIaSqlite(db),
    testes: new RepositorioDeTestesDeModeloSqlite(db),
    catalogo: catalogoDeTeste(),
    doAmbiente: { ato: doAmbiente, resumo: doAmbiente, peca: doAmbiente },
    leitor: new LeitorDeUsoDeIaSqlite(
      db,
      new RegistroDeOcorrenciasDeIaSqlite(db, relogio, new LoggerColetor()),
    ),
    clock: relogio,
    logger: new LoggerColetor(),
    ocorrencias: new RegistroDeOcorrenciasDeIaSqlite(db, relogio, new LoggerColetor()),
    validadeDoCacheMs: 0,
  });
  const pecas = new Map<string, ModeloComZdr>();
  const daFuncao = (f: 'ato' | 'resumo' | 'peca'): ModeloDaFuncao =>
    new ModeloDaFuncao({
      escolher: () => modelos.modeloParaChamada(f),
      fabrica: (m) => {
        let p = pecas.get(m);
        if (!p) {
          p = new ModeloComZdr({
            transporte,
            modelo: m,
            buscarListaZdr: () => listaZdr(),
            clock: new ClockFalso(),
            logger: new LoggerColetor(),
          });
          pecas.set(m, p);
        }
        return p;
      },
    });
  return {
    modelos,
    ato: new OpenRouterAnalisadorDeAto({ modeloZdr: daFuncao('ato') }),
    resumo: new OpenRouterResumidorDeProcesso({
      modeloZdr: daFuncao('resumo'),
      maxTokens: 1500,
      timeoutMs: 120000,
    }),
  };
}

function publicar(
  modelos: ServicoModelosDeIa,
  funcao: 'ato' | 'resumo' | 'peca',
  candidato = NOVO,
): void {
  const t = new RepositorioDeTestesDeModeloSqlite(db);
  const id = `t-${funcao}`;
  t.criar({
    id,
    funcao,
    candidato,
    referencia: ATUAL,
    estado: 'concluido',
    autor: 'x',
    criadoEm: relogio.agora(),
    chamadasPrevistas: 1,
    chamadasFeitas: 1,
    estimativaUsd: null,
    gastoUsd: null,
    bloqueios: [],
    ressalvas: [],
  });
  t.atualizar(id, {
    terminadoEm: relogio.agora(),
    metricasDoCandidato: metricas({ modelo: candidato }),
    metricasDaReferencia: metricas(),
    veredito: 'aprovado',
  });
  modelos.publicar('op', funcao, { testeId: id, confirmado: true });
}

const PEDIDO = { sistema: 'sistema', usuario: `ato: ${SEGREDO}` };

beforeEach(() => {
  relogio = new Relogio();
  db = abrirBanco(':memory:');
  corpos = [];
  listaZdr = async () => lista(ATUAL, NOVO);
  resposta = (c) => json(corpoOk(String(c['model']), respostaValida()));
});

describe('o modelo da chamada é o efetivo, e o gravado no resultado é o servido', () => {
  it('antes de publicar a chamada vai ao modelo do ambiente; depois, ao do painel; ao reverter, volta', async () => {
    const m = montar();
    expect((await m.ato.analisar(PEDIDO)).modelo).toBe(ATUAL);
    publicar(m.modelos, 'ato');
    expect((await m.ato.analisar(PEDIDO)).modelo).toBe(NOVO);
    m.modelos.reverter('op', 'ato', true);
    expect((await m.ato.analisar(PEDIDO)).modelo).toBe(ATUAL);
    expect(corpos.map((c) => c['model'])).toEqual([ATUAL, NOVO, ATUAL]);
  });

  it('trocar o ato não troca o resumo', async () => {
    const m = montar();
    publicar(m.modelos, 'ato');
    resposta = (c) => json(corpoOk(String(c['model']), respostaDoResumo()));
    expect((await m.resumo.resumir(PEDIDO)).modelo).toBe(ATUAL);
  });

  it('o modelo gravado é o que a resposta diz ter servido, não o configurado', async () => {
    const m = montar();
    publicar(m.modelos, 'ato');
    resposta = () => json(corpoOk(NOVO, respostaValida()));
    const r = await m.ato.analisar(PEDIDO);
    expect(r.modelo).toBe(NOVO);
    // e um servido que a lista ZDR não confirma é descartado, nunca gravado
    resposta = () => json(corpoOk('fab-x/outro-que-nao-pedi', respostaValida()));
    await expect(m.ato.analisar(PEDIDO)).rejects.toBeInstanceOf(
      ProviderIndisponivelError,
    );
  });
});

describe('nenhuma configuração faz uma chamada sem ZDR', () => {
  function todasComZdr(): void {
    for (const c of corpos) {
      expect(c['provider']).toMatchObject({
        zdr: true,
        data_collection: 'deny',
        allow_fallbacks: false,
      });
      expect((c['provider'] as { only: string[] }).only.length).toBeGreaterThan(0);
    }
  }

  it('modelo do ambiente, do painel, do painel inválido e o padrão: toda chamada leva ZDR', async () => {
    const m = montar();
    await m.ato.analisar(PEDIDO);
    publicar(m.modelos, 'ato');
    await m.ato.analisar(PEDIDO);
    // o painel guarda um modelo que a lista removeu: cai no ambiente, ainda com ZDR
    db.prepare(
      "UPDATE ia_config SET modelo = 'fab-z/removido' WHERE chave = 'ato'",
    ).run();
    await m.ato.analisar(PEDIDO);
    expect(corpos).toHaveLength(3);
    todasComZdr();
  });

  it('modelo escolhido sem endpoint na lista ZDR: nenhuma chamada sai', async () => {
    const m = montar();
    publicar(m.modelos, 'ato');
    listaZdr = async () => lista(ATUAL); // o NOVO perdeu o ZDR
    await expect(m.ato.analisar(PEDIDO)).rejects.toBeInstanceOf(
      ProviderIndisponivelError,
    );
    expect(corpos).toHaveLength(0);
  });

  it('lista ZDR inalcançável ou vazia: nenhuma chamada sai, para nenhum modelo', async () => {
    const m = montar();
    listaZdr = async () => {
      throw new Error('sem rede');
    };
    await expect(m.ato.analisar(PEDIDO)).rejects.toBeInstanceOf(
      ProviderIndisponivelError,
    );
    listaZdr = async () => [];
    await expect(m.ato.analisar(PEDIDO)).rejects.toBeInstanceOf(
      ProviderIndisponivelError,
    );
    expect(corpos).toHaveLength(0);
  });

  it('"no_providers_available" não gera segunda chamada sem ZDR', async () => {
    const m = montar();
    resposta = () =>
      json(
        {
          error: {
            code: 404,
            message: 'No allowed providers are available',
            metadata: { failed_routing_step: 'data_policy' },
          },
        },
        404,
      );
    await expect(m.ato.analisar(PEDIDO)).rejects.toBeInstanceOf(
      ProviderIndisponivelError,
    );
    expect(corpos).toHaveLength(1);
    todasComZdr();
  });

  it('apelido e variante nunca viram chamada, mesmo se vierem do ambiente', async () => {
    for (const ruim of ['~fab/modelo-latest', 'fab/modelo:free']) {
      const m = montar(ruim);
      await expect(m.ato.analisar(PEDIDO)).rejects.toBeInstanceOf(
        ProviderIndisponivelError,
      );
    }
    expect(corpos).toHaveLength(0);
  });

  it('a recusa e o log nunca repetem o texto do ato', async () => {
    const m = montar();
    resposta = () => json({ error: { code: 404, message: `eco ${SEGREDO}` } }, 404);
    const erro = await m.ato.analisar(PEDIDO).catch((e: unknown) => e);
    expect(String((erro as Error).message)).not.toContain(SEGREDO);
  });
});
