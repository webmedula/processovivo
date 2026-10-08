import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { mapearErro } from '../../src/main/http/erros.js';
import { rotasDeAcompanhamento } from '../../src/main/http/rotas/acompanhamentos.js';
import { NUMERO_TJSP_A, NUMERO_TJSP_B, ProviderFalso } from '../helpers/fabricas.js';

/*
 * v0.37.5 — "Marcar como cumprido": rotas, isolamento por workspace, validação
 * e o campo novo e aditivo `processo.providencia` em GET /v1/novidades. Relógio
 * fixo e dados sintéticos.
 */
const AGORA = new Date('2026-10-08T12:00:00Z');
const dia = (n: number): Date => new Date(AGORA.getTime() - n * 86_400_000);
const WS_A = 'ws-a';
const WS_B = 'ws-b';
const DIG_A = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
const DIG_B = NumeroCNJ.criar(NUMERO_TJSP_B).digitos;

const INTIMACAO: Movimentacao = {
  data: dia(12),
  titulo: 'Ato ordinatório',
  idExterno: 'djen:101',
  tipoComunicacao: 'Intimação',
};
const JUNTADA: Movimentacao = { data: dia(2), titulo: 'Juntada de petição' };

function processo(numero: string, movs: Movimentacao[]): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal: 'TJSP',
    classe: 'Procedimento Comum Cível',
    movimentacoes: movs,
    procedencia: { provider: 'djen', consultadoEm: AGORA, deCache: false },
  });
}

interface Info {
  pedeProvidencia: boolean;
  providencia: null | {
    situacao: 'pede' | 'cumprida' | 'venceu';
    motivo: { rotulo: string; data: string; chave: string; tipo: string };
    cumpridoEm: string | null;
  };
}

describe('marcar como cumprido — HTTP', () => {
  let db: DatabaseSync;
  let servidor: FastifyInstance;
  let repo: RepositorioAcompanhamentosSqlite;
  let ws = WS_A;

  async function semear(w: string, numero: string, movs: Movimentacao[]): Promise<void> {
    await repo.acompanhar(w, NumeroCNJ.criar(numero).digitos);
    await repo.registrarSincronizacao(
      w,
      NumeroCNJ.criar(numero).digitos,
      processo(numero, movs),
      [],
    );
  }

  const url = (d: string): string => `/v1/acompanhamentos/${d}/cumprido`;
  const chaveDaIntimacao = chaveDaMovimentacao(INTIMACAO);

  async function novidades(): Promise<{
    pendenciaIntimacaoJanelaDias: number;
    naoVistas: number;
    semNovidade: Array<{ numero: string; processo: Info }>;
  }> {
    return (await servidor.inject({ method: 'GET', url: '/v1/novidades' })).json();
  }

  beforeEach(async () => {
    ws = WS_A;
    db = abrirBanco(':memory:');
    repo = new RepositorioAcompanhamentosSqlite(db);
    const servico = new ServicoAcompanhamento({
      repositorio: repo,
      provider: new ProviderFalso({ nome: 'falso' }),
      logger: loggerSilencioso,
      agora: () => AGORA,
    });
    servidor = Fastify();
    servidor.decorateRequest('workspace', undefined);
    servidor.decorateRequest('identidadeDaChave', undefined);
    servidor.addHook('onRequest', async (req) => {
      req.workspace = ws;
      req.identidadeDaChave = 'u:pessoa-1';
    });
    servidor.setErrorHandler((erro, _req, resposta) => {
      const m = mapearErro(erro);
      void resposta.code(m.status).send(m.corpo);
    });
    await servidor.register(
      rotasDeAcompanhamento(
        servico,
        { novidadesJanelaDias: 15, pendenciaJanelaDias: 10 },
        () => AGORA,
      ),
    );
    await semear(WS_A, NUMERO_TJSP_A, [INTIMACAO, JUNTADA]);
  });
  afterEach(async () => {
    await servidor.close();
    db.close();
  });

  it('GET /v1/novidades traz o ATO que gera a providência (campo aditivo) e a janela do servidor', async () => {
    const r = await novidades();

    expect(r.pendenciaIntimacaoJanelaDias).toBe(30);
    const linha = r.semNovidade.find((x) => x.numero === DIG_A);
    expect(linha?.processo.pedeProvidencia).toBe(true);
    expect(linha?.processo.providencia).toMatchObject({
      situacao: 'pede',
      cumpridoEm: null,
      motivo: {
        rotulo: 'Ato ordinatório',
        data: INTIMACAO.data.toISOString(),
        tipo: 'intimacao',
        chave: chaveDaIntimacao,
      },
    });
  });

  it('marca: o selo some para aquele ato e a resposta já traz o processo recalculado', async () => {
    const r = await servidor.inject({
      method: 'POST',
      url: url(DIG_A),
      payload: { chaveDoAto: chaveDaIntimacao },
    });

    expect(r.statusCode).toBe(200);
    const info = r.json().processo as Info;
    expect(info.pedeProvidencia).toBe(false);
    expect(info.providencia?.situacao).toBe('cumprida');
    expect(info.providencia?.cumpridoEm).toBe(AGORA.toISOString());

    const lista = await novidades();
    expect(
      lista.semNovidade.find((x) => x.numero === DIG_A)?.processo.pedeProvidencia,
    ).toBe(false);
  });

  it('guarda quem marcou, o ato e a data — e não toca a "não lida"', async () => {
    await repo.registrarSincronizacao(
      WS_A,
      DIG_A,
      processo(NUMERO_TJSP_A, [INTIMACAO, JUNTADA]),
      [JUNTADA],
    );
    const antes = (await novidades()).naoVistas;

    await servidor.inject({
      method: 'POST',
      url: url(DIG_A),
      payload: { chaveDoAto: chaveDaIntimacao },
    });

    const guardado = await repo.buscar(WS_A, DIG_A);
    expect(guardado?.cumprido).toEqual({
      chave: chaveDaIntimacao,
      ate: INTIMACAO.data,
      em: AGORA,
      por: 'u:pessoa-1',
    });
    // Ler não é cumprir, e cumprir não é ler.
    expect((await novidades()).naoVistas).toBe(antes);
    expect(await repo.contarNaoVistas(WS_A)).toBe(1);
  });

  it('desfazer devolve o selo (reversível)', async () => {
    await servidor.inject({
      method: 'POST',
      url: url(DIG_A),
      payload: { chaveDoAto: chaveDaIntimacao },
    });

    const r = await servidor.inject({ method: 'DELETE', url: url(DIG_A) });

    expect(r.statusCode).toBe(200);
    expect((r.json().processo as Info).pedeProvidencia).toBe(true);
    expect((await repo.buscar(WS_A, DIG_A))?.cumprido).toBeUndefined();
  });

  it('desfazer sem marca é um no-op, não um erro', async () => {
    const r = await servidor.inject({ method: 'DELETE', url: url(DIG_A) });
    expect(r.statusCode).toBe(200);
    expect((r.json().processo as Info).pedeProvidencia).toBe(true);
  });

  it('a marca cobre só até o ato: ato novo que exige ação volta a pedir providência', async () => {
    await servidor.inject({
      method: 'POST',
      url: url(DIG_A),
      payload: { chaveDoAto: chaveDaIntimacao },
    });
    const nova: Movimentacao = {
      data: dia(1),
      titulo: 'Ato ordinatório',
      idExterno: 'djen:102',
      tipoComunicacao: 'Intimação',
    };
    await repo.registrarSincronizacao(
      WS_A,
      DIG_A,
      processo(NUMERO_TJSP_A, [INTIMACAO, JUNTADA, nova]),
      [nova],
    );

    const r = await servidor.inject({ method: 'GET', url: '/v1/novidades' });
    const grupo = (r.json().grupos as Array<{ numero: string; processo: Info }>).find(
      (g) => g.numero === DIG_A,
    );
    expect(grupo?.processo.providencia?.situacao).toBe('pede');
    expect(grupo?.processo.providencia?.motivo.chave).toBe(chaveDaMovimentacao(nova));
  });

  it('intimação sem marca depois de 30 dias sai do filtro e é contada como "venceu"', async () => {
    const velha: Movimentacao = { ...INTIMACAO, data: dia(31), idExterno: 'djen:7' };
    await semear(WS_A, NUMERO_TJSP_B, [velha]);

    const r = await novidades();

    const linha = r.semNovidade.find((x) => x.numero === DIG_B);
    expect(linha?.processo.pedeProvidencia).toBe(false);
    expect(linha?.processo.providencia?.situacao).toBe('venceu');
  });

  it('um workspace não vê nem altera a marca do outro (404 igual a "não existe")', async () => {
    await servidor.inject({
      method: 'POST',
      url: url(DIG_A),
      payload: { chaveDoAto: chaveDaIntimacao },
    });

    ws = WS_B;
    const marcar = await servidor.inject({
      method: 'POST',
      url: url(DIG_A),
      payload: { chaveDoAto: chaveDaIntimacao },
    });
    const desfazer = await servidor.inject({ method: 'DELETE', url: url(DIG_A) });
    expect(marcar.statusCode).toBe(404);
    expect(desfazer.statusCode).toBe(404);
    expect((await novidades()).semNovidade).toEqual([]);

    // A marca do A continua de pé.
    expect((await repo.buscar(WS_A, DIG_A))?.cumprido).toBeDefined();
  });

  it('o mesmo número em duas contas tem marcas independentes', async () => {
    await semear(WS_B, NUMERO_TJSP_A, [INTIMACAO, JUNTADA]);
    await servidor.inject({
      method: 'POST',
      url: url(DIG_A),
      payload: { chaveDoAto: chaveDaIntimacao },
    });

    expect((await repo.buscar(WS_B, DIG_A))?.cumprido).toBeUndefined();
  });

  it('corpo fora do contrato é 400 (Zod)', async () => {
    for (const payload of [{}, { chaveDoAto: '' }, { chaveDoAto: 12 }]) {
      const r = await servidor.inject({ method: 'POST', url: url(DIG_A), payload });
      expect(r.statusCode).toBe(400);
    }
  });

  it('número CNJ inválido é 400', async () => {
    const r = await servidor.inject({
      method: 'POST',
      url: url('123'),
      payload: { chaveDoAto: 'x' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('ato que não está no retrato é 409; ato que não pede providência também', async () => {
    const inexistente = await servidor.inject({
      method: 'POST',
      url: url(DIG_A),
      payload: { chaveDoAto: 'nao-existe' },
    });
    expect(inexistente.statusCode).toBe(409);

    const naoPede = await servidor.inject({
      method: 'POST',
      url: url(DIG_A),
      payload: { chaveDoAto: chaveDaMovimentacao(JUNTADA) },
    });
    expect(naoPede.statusCode).toBe(409);
    expect((await repo.buscar(WS_A, DIG_A))?.cumprido).toBeUndefined();
  });

  it('marcar um ato já coberto não faz a marca recuar', async () => {
    const mais: Movimentacao = {
      data: dia(5),
      titulo: 'Ato ordinatório',
      idExterno: 'djen:150',
      tipoComunicacao: 'Intimação',
    };
    await repo.registrarSincronizacao(
      WS_A,
      DIG_A,
      processo(NUMERO_TJSP_A, [INTIMACAO, JUNTADA, mais]),
      [],
    );
    await servidor.inject({
      method: 'POST',
      url: url(DIG_A),
      payload: { chaveDoAto: chaveDaMovimentacao(mais) },
    });
    await servidor.inject({
      method: 'POST',
      url: url(DIG_A),
      payload: { chaveDoAto: chaveDaIntimacao },
    });

    expect((await repo.buscar(WS_A, DIG_A))?.cumprido?.chave).toBe(
      chaveDaMovimentacao(mais),
    );
  });
});
