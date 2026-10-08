import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { rotasDeAcompanhamento } from '../../src/main/http/rotas/acompanhamentos.js';
import { ProviderFalso, NUMERO_TJSP_A, NUMERO_TJSP_B } from '../helpers/fabricas.js';

/**
 * v0.37.3 — Atualizações lista TODOS os processos acompanhados. O processo sem
 * novidade registrada vem em `semNovidade`, lido do retrato que o acompanhamento
 * já guarda; os campos que já existiam continuam como estavam.
 */
const AGORA = new Date('2026-10-08T12:00:00Z');
const WS = 'ws-a';
const OUTRO = 'ws-b';
const dia = (n: number): Date => new Date(AGORA.getTime() - n * 86_400_000);

interface Resposta {
  total: number;
  acompanhados: number;
  janelaDias: number | null;
  foraDaJanela: number;
  processosForaDaJanela: number;
  grupos: Array<{ numero: string }>;
  novidades: unknown[];
  semNovidade: Array<{
    numero: string;
    segredoJustica: boolean;
    ultimaMovimentacao: { data: string; titulo: string; conteudo: string | null } | null;
    processo: { pedeProvidencia: boolean; tribunal: string | null };
  }>;
}

function processo(
  numero: string,
  movs: Array<{ dias: number; titulo: string; conteudo?: string }>,
  segredo = false,
): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal: 'TJSP',
    classe: 'Procedimento Comum Cível',
    segredoJustica: segredo,
    movimentacoes: movs.map((m) => ({
      data: dia(m.dias),
      titulo: m.titulo,
      ...(m.conteudo ? { conteudo: m.conteudo } : {}),
    })),
    procedencia: { provider: 't', consultadoEm: AGORA, deCache: false },
  });
}

describe('GET /v1/novidades — processos acompanhados sem novidade', () => {
  let db: DatabaseSync;
  let servidor: FastifyInstance;
  let repo: RepositorioAcompanhamentosSqlite;
  let ws = WS;
  const dA = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
  const dB = NumeroCNJ.criar(NUMERO_TJSP_B).digitos;

  beforeEach(async () => {
    ws = WS;
    db = abrirBanco(':memory:');
    repo = new RepositorioAcompanhamentosSqlite(db);
    const servico = new ServicoAcompanhamento({
      repositorio: repo,
      provider: new ProviderFalso({ nome: 'falso' }),
      logger: loggerSilencioso,
    });
    servidor = Fastify();
    servidor.decorateRequest('workspace', undefined);
    servidor.addHook('onRequest', async (req) => {
      req.workspace = ws;
    });
    await servidor.register(
      rotasDeAcompanhamento(
        servico,
        { novidadesJanelaDias: 15, pendenciaJanelaDias: 10 },
        () => AGORA,
      ),
    );
  });
  afterEach(async () => {
    await servidor.close();
    db.close();
  });

  async function ler(query = ''): Promise<Resposta> {
    const r = await servidor.inject({ method: 'GET', url: `/v1/novidades${query}` });
    expect(r.statusCode).toBe(200);
    return r.json() as Resposta;
  }

  /** O 1º retrato: guarda o processo e NÃO cria novidade (regra de detectarNovidades). */
  const primeiroRetrato = (w: string, d: string, p: Processo) =>
    repo
      .acompanhar(w, d)
      .then(() => repo.registrarSincronizacao(w, d, p, []));

  it('o processo recém-acompanhado aparece em semNovidade, sem criar novidade no banco', async () => {
    await primeiroRetrato(
      WS,
      dA,
      processo(NUMERO_TJSP_A, [
        { dias: 40, titulo: 'Distribuição' },
        { dias: 3, titulo: 'Juntada de Petição', conteudo: 'Texto do ato.' },
      ]),
    );
    const r = await ler();

    expect(r.acompanhados).toBe(1);
    expect(r.grupos).toHaveLength(0);
    expect(r.novidades).toHaveLength(0);
    expect(r.semNovidade).toHaveLength(1);
    const linha = r.semNovidade[0]!;
    expect(linha.numero).toBe(dA);
    expect(linha.ultimaMovimentacao?.titulo).toBe('Juntada de Petição');
    expect(linha.ultimaMovimentacao?.conteudo).toBe('Texto do ato.');
    expect(linha.ultimaMovimentacao?.data).toBe(dia(3).toISOString());
    expect((db.prepare('SELECT COUNT(*) AS n FROM novidades').get() as { n: number }).n).toBe(0);
  });

  it('com 2 acompanhados e 1 com novidade: 1 grupo, 1 semNovidade; os campos antigos intactos', async () => {
    await primeiroRetrato(WS, dA, processo(NUMERO_TJSP_A, [{ dias: 30, titulo: 'Distribuição' }]));
    await primeiroRetrato(WS, dB, processo(NUMERO_TJSP_B, [{ dias: 30, titulo: 'Distribuição' }]));
    await repo.registrarSincronizacao(
      WS,
      dB,
      processo(NUMERO_TJSP_B, [
        { dias: 30, titulo: 'Distribuição' },
        { dias: 1, titulo: 'Sentença' },
      ]),
      [{ data: dia(1), titulo: 'Sentença' }],
    );
    const r = await ler('?janela=todas');
    expect(r.grupos.map((g) => g.numero)).toEqual([dB]);
    expect(r.semNovidade.map((s) => s.numero)).toEqual([dA]);
    expect(r.acompanhados).toBe(2);
    expect(r.novidades).toHaveLength(1); // a lista plana segue só com novidades reais
    expect(r.processosForaDaJanela).toBe(0); // "Todas": nada fica de fora
  });

  it('com a janela de 15 dias diz quantos PROCESSOS ficaram fora (sem novidade e com novidade antiga)', async () => {
    await primeiroRetrato(WS, dA, processo(NUMERO_TJSP_A, [{ dias: 5, titulo: 'X' }]));
    await primeiroRetrato(WS, dB, processo(NUMERO_TJSP_B, [{ dias: 5, titulo: 'X' }]));
    await repo.registrarSincronizacao(
      WS,
      dB,
      processo(NUMERO_TJSP_B, [{ dias: 5, titulo: 'X' }, { dias: 30, titulo: 'Velha' }]),
      [{ data: dia(30), titulo: 'Velha' }],
    );
    db.prepare('UPDATE novidades SET detectada_em = ?').run(dia(30).toISOString());

    const janela = await ler();
    expect(janela.janelaDias).toBe(15);
    expect(janela.grupos).toHaveLength(0);
    expect(janela.foraDaJanela).toBe(1); // atualizações: o campo antigo continua contando isso
    expect(janela.processosForaDaJanela).toBe(2); // processos: o campo novo
    // O processo com novidade antiga NÃO é "sem novidade": ele está em "Todas" como grupo.
    expect(janela.semNovidade.map((s) => s.numero)).toEqual([dA]);
    const todas = await ler('?janela=todas');
    expect(todas.grupos.map((g) => g.numero)).toEqual([dB]);
  });

  it('processo sem nenhuma movimentação conhecida vem com ultimaMovimentacao nula', async () => {
    await primeiroRetrato(WS, dA, processo(NUMERO_TJSP_A, []));
    const r = await ler();
    expect(r.semNovidade).toHaveLength(1);
    expect(r.semNovidade[0]!.ultimaMovimentacao).toBeNull();
  });

  it('acompanhado que nunca sincronizou (sem retrato) também aparece, sem movimentação', async () => {
    await repo.acompanhar(WS, dA);
    const r = await ler();
    expect(r.semNovidade.map((s) => s.numero)).toEqual([dA]);
    expect(r.semNovidade[0]!.ultimaMovimentacao).toBeNull();
    expect(r.semNovidade[0]!.processo.tribunal).toBeNull();
  });

  it('segredo de justiça: rótulo e data, nunca o texto do ato', async () => {
    await primeiroRetrato(
      WS,
      dA,
      processo(NUMERO_TJSP_A, [{ dias: 2, titulo: 'Decisão', conteudo: 'TEXTO RESERVADO' }], true),
    );
    const corpo = (await servidor.inject({ method: 'GET', url: '/v1/novidades' })).body;
    expect(corpo).not.toContain('TEXTO RESERVADO');
    const r = JSON.parse(corpo) as Resposta;
    expect(r.semNovidade[0]!.segredoJustica).toBe(true);
    expect(r.semNovidade[0]!.ultimaMovimentacao?.titulo).toBe('Decisão');
    expect(r.semNovidade[0]!.ultimaMovimentacao?.conteudo).toBeNull();
  });

  it('"pede providência" segue a regra do selo da carteira também para quem não tem novidade', async () => {
    await primeiroRetrato(WS, dA, processo(NUMERO_TJSP_A, [{ dias: 2, titulo: 'Intimação para manifestação' }]));
    await primeiroRetrato(WS, dB, processo(NUMERO_TJSP_B, [{ dias: 60, titulo: 'Intimação para manifestação' }]));
    const r = await ler();
    const por = new Map(r.semNovidade.map((s) => [s.numero, s.processo.pedeProvidencia]));
    expect(por.get(dA)).toBe(true);
    expect(por.get(dB)).toBe(false);
  });

  it('isolamento: a lista de uma conta nunca traz o processo de outra', async () => {
    await primeiroRetrato(WS, dA, processo(NUMERO_TJSP_A, [{ dias: 2, titulo: 'A' }]));
    await primeiroRetrato(OUTRO, dB, processo(NUMERO_TJSP_B, [{ dias: 2, titulo: 'B' }]));
    expect((await ler()).semNovidade.map((s) => s.numero)).toEqual([dA]);
    ws = OUTRO;
    const b = await ler();
    expect(b.semNovidade.map((s) => s.numero)).toEqual([dB]);
    expect(b.acompanhados).toBe(1);
  });

  it('naoVistas=true não afirma "sem novidade" sobre ninguém', async () => {
    await primeiroRetrato(WS, dA, processo(NUMERO_TJSP_A, [{ dias: 2, titulo: 'A' }]));
    const r = await ler('?naoVistas=true');
    expect(r.semNovidade).toEqual([]);
    expect(r.processosForaDaJanela).toBe(0);
  });

  it('filtro de tribunal vale para os processos sem novidade', async () => {
    await primeiroRetrato(WS, dA, processo(NUMERO_TJSP_A, [{ dias: 2, titulo: 'A' }]));
    expect((await ler('?tribunal=TJSP')).semNovidade).toHaveLength(1);
    expect((await ler('?tribunal=TJGO')).semNovidade).toHaveLength(0);
  });
});

describe('GET /v1/sincronizacao e POST /v1/sincronizar — por conta', () => {
  it('o status da conta A não vê a fila da conta B, e o POST não responde 409 por causa dos outros', async () => {
    const db = abrirBanco(':memory:');
    const repo = new RepositorioAcompanhamentosSqlite(db);
    const dA = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
    const dB = NumeroCNJ.criar(NUMERO_TJSP_B).digitos;
    await repo.acompanhar('ws-a', dA);
    await repo.acompanhar('ws-b', dB);
    let solta: (() => void) | undefined;
    const servico = new ServicoAcompanhamento({
      repositorio: repo,
      provider: new ProviderFalso({
        nome: 'travado',
        porNumero: (n) =>
          new Promise((r) => {
            solta = () => r(processo(n, []));
          }),
      }),
      logger: loggerSilencioso,
      pausaEntreConsultasMs: 0,
    });
    let atual = 'ws-a';
    const servidor = Fastify();
    servidor.decorateRequest('workspace', undefined);
    servidor.addHook('onRequest', async (req) => {
      req.workspace = atual;
    });
    await servidor.register(
      rotasDeAcompanhamento(servico, { novidadesJanelaDias: 15, pendenciaJanelaDias: 10 }),
    );

    // A varredura global é do sistema: roda para as duas contas.
    const global = servico.sincronizar();
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));

    const sa = (await servidor.inject({ method: 'GET', url: '/v1/sincronizacao' })).json() as Record<string, unknown>;
    expect(sa['emAndamento']).toBe(true);
    expect(sa['pendentes']).toBe(1); // nunca 2: a fila global não sai
    expect(Object.keys(sa).sort()).toEqual(['demorando', 'desde', 'emAndamento', 'pendentes']);

    // Uma conta sem nada na fila não herda o "verificando" dos outros.
    atual = 'ws-sem-processos';
    const sc = (await servidor.inject({ method: 'GET', url: '/v1/sincronizacao' })).json() as Record<string, unknown>;
    expect(sc['emAndamento']).toBe(false);

    // Segundo clique da conta A: não dispara outra verificação, não é 409.
    atual = 'ws-a';
    const clique = await servidor.inject({ method: 'POST', url: '/v1/sincronizar' });
    expect(clique.statusCode).toBe(202);
    expect(clique.json()).toMatchObject({ jaEmAndamento: true, iniciada: false });

    solta?.();
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    solta?.();
    await global;
    await servidor.close();
    db.close();
  });
});
