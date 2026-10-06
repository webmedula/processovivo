import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { rotasDeAcompanhamento } from '../../src/main/http/rotas/acompanhamentos.js';
import { ProviderFalso, NUMERO_TJSP_A, NUMERO_TJSP_B } from '../helpers/fabricas.js';

const AGORA = new Date('2026-10-02T12:00:00Z');
const WS = 'ws-a';
interface NovidadeJson {
  titulo: string;
  exigeAcao: boolean;
}
interface GrupoJson {
  numero: string;
  maisRecente: NovidadeJson;
  quantidade: number;
  anteriores?: unknown;
  naoVistas: number;
}
interface RespostaNovidades {
  grupos: GrupoJson[];
  janelaDias: number | null;
  foraDaJanela: number;
  naoVistas: number;
}

const dia = (n: number): string =>
  new Date(AGORA.getTime() - n * 86_400_000).toISOString();

function mov(iso: string, titulo: string, conteudo?: string): Movimentacao {
  return { data: new Date(iso), titulo, ...(conteudo ? { conteudo } : {}) };
}

function processo(numero: string, movs: Movimentacao[]): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal: 'TJSP',
    classe: 'Procedimento Comum Cível',
    movimentacoes: movs,
    procedencia: { provider: 'teste', consultadoEm: AGORA, deCache: false },
  });
}

describe('GET /v1/novidades — uma linha por processo, com janela', () => {
  let db: DatabaseSync;
  let servidor: FastifyInstance;
  let repo: RepositorioAcompanhamentosSqlite;

  beforeEach(async () => {
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
      req.workspace = WS;
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

  /** Grava a novidade e fixa a hora em que ela foi "percebida". */
  async function semear(
    numero: string,
    diasAtras: number,
    titulo: string,
  ): Promise<void> {
    const digitos = NumeroCNJ.criar(numero).digitos;
    await repo.acompanhar(WS, digitos);
    await repo.registrarSincronizacao(WS, digitos, processo(numero, []), [
      mov(dia(diasAtras), titulo),
    ]);
    db.prepare('UPDATE novidades SET detectada_em = ? WHERE titulo = ?').run(
      dia(diasAtras),
      titulo,
    );
  }

  async function ler(query = ''): Promise<RespostaNovidades> {
    const r = await servidor.inject({ method: 'GET', url: `/v1/novidades${query}` });
    expect(r.statusCode).toBe(200);
    return r.json() as RespostaNovidades;
  }

  it('devolve uma linha por processo e a janela padrão de 15 dias', async () => {
    await semear(NUMERO_TJSP_A, 1, 'Sentença');
    await semear(NUMERO_TJSP_A, 4, 'Despacho');
    await semear(NUMERO_TJSP_B, 2, 'Juntada');

    const r = await ler();
    expect(r.grupos).toHaveLength(2);
    expect(r.janelaDias).toBe(15);
    const a = r.grupos.find((g) => g.maisRecente.titulo === 'Sentença');
    expect(a?.quantidade).toBe(2);
    expect(a?.anteriores).toBeUndefined();
    expect(a?.naoVistas).toBe(2);
  });

  it('diz quantas atualizações ficaram fora da janela, e "Todas" as traz de volta', async () => {
    await semear(NUMERO_TJSP_A, 1, 'Recente');
    await semear(NUMERO_TJSP_A, 20, 'Antiga');
    await semear(NUMERO_TJSP_B, 60, 'Muito antiga');

    const janela = await ler();
    expect(janela.foraDaJanela).toBe(2);
    expect(janela.grupos).toHaveLength(1);

    const todas = await ler('?janela=todas');
    expect(todas.janelaDias).toBeNull();
    expect(todas.foraDaJanela).toBe(0);
    expect(todas.grupos).toHaveLength(2);
  });

  it('a contagem de não vistas continua sendo de atualizações, não de linhas', async () => {
    await semear(NUMERO_TJSP_A, 1, 'Um');
    await semear(NUMERO_TJSP_A, 2, 'Dois');
    await semear(NUMERO_TJSP_A, 30, 'Fora da janela');

    const r = await ler();
    // Três atualizações não vistas num processo só (uma delas fora da janela):
    // o menu e o painel contam o que o assinante ainda não leu, não as linhas.
    expect(r.grupos).toHaveLength(1);
    expect(r.naoVistas).toBe(3);
  });

  it('não trafega as atualizações anteriores: só a mais recente e a contagem do período', async () => {
    for (let i = 1; i <= 30; i++) await semear(NUMERO_TJSP_A, i % 14 || 1, `Ato ${i}`);

    const r = await ler();
    const g = r.grupos[0];
    expect(r.grupos).toHaveLength(1);
    expect(g?.quantidade).toBe(30);
    expect(g?.anteriores).toBeUndefined();
    // O achatado também vem enxuto: um item por processo, e o total continua contando atos.
    const achatado = (r as unknown as { novidades: unknown[]; total: number }).novidades;
    expect(achatado).toHaveLength(1);
    expect((r as unknown as { total: number }).total).toBe(30);
    expect(r.naoVistas).toBe(30);
  });

  it('o ato anterior que pede providência continua sem filtrar nem aparecer como linha', async () => {
    const digitos = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
    await repo.acompanhar(WS, digitos);
    await repo.registrarSincronizacao(WS, digitos, processo(NUMERO_TJSP_A, []), [
      mov(
        dia(5),
        'Despacho',
        'Intime-se a parte autora para manifestar-se no prazo de 5 dias.',
      ),
      mov(dia(1), 'Juntada'),
    ]);
    db.prepare('UPDATE novidades SET detectada_em = data').run();

    const r = await ler();
    const g = r.grupos[0];
    expect(g?.maisRecente.titulo).toBe('Juntada');
    expect(g?.maisRecente.exigeAcao).toBe(false);
    expect(g?.quantidade).toBe(2);
  });

  it('a janela de pendência chega à tela pelas facetas — um valor só', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/v1/facetas' });
    expect(r.json().pendenciaJanelaDias).toBe(10);
  });
});

interface InfoDoProcessoJson {
  tribunal: string | null;
  classe: string | null;
  partes: {
    ativo: { nomes: string[]; total: number };
    passivo: { nomes: string[]; total: number };
  };
  pedeProvidencia: boolean;
  motivoProvidencia: string | null;
}
interface GrupoComProcesso {
  numero: string;
  processo: InfoDoProcessoJson | null;
}

describe('GET /v1/novidades — o que a tabela mostra do processo (v0.37.0)', () => {
  let db: DatabaseSync;
  let servidor: FastifyInstance;
  let repo: RepositorioAcompanhamentosSqlite;

  beforeEach(async () => {
    db = abrirBanco(':memory:');
    repo = new RepositorioAcompanhamentosSqlite(db);
    const servico = new ServicoAcompanhamento({
      repositorio: repo,
      provider: new ProviderFalso({ nome: 'falso' }),
      logger: loggerSilencioso,
    });
    servidor = Fastify();
    servidor.decorateRequest('workspace', undefined);
    // O workspace de cada chamada vem do cabeçalho de teste, como viria da chave.
    servidor.addHook('onRequest', async (req) => {
      req.workspace = String(req.headers['x-ws'] ?? WS);
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

  const parte = (nome: string, polo: 'ATIVO' | 'PASSIVO') => ({
    nome,
    polo,
    tipoPessoa: 'DESCONHECIDO' as const,
    advogados: [],
  });

  async function semear(
    ws: string,
    numero: string,
    movs: Movimentacao[],
    partes: ReturnType<typeof parte>[] = [],
    classe: string | null = 'Procedimento Comum Cível',
  ): Promise<void> {
    const digitos = NumeroCNJ.criar(numero).digitos;
    await repo.acompanhar(ws, digitos);
    await repo.registrarSincronizacao(
      ws,
      digitos,
      new Processo({
        numero: NumeroCNJ.criar(numero),
        tribunal: 'TJSP',
        ...(classe ? { classe } : {}),
        partes,
        movimentacoes: movs,
        procedencia: { provider: 'teste', consultadoEm: AGORA, deCache: false },
      }),
      movs,
    );
    db.prepare('UPDATE novidades SET detectada_em = data').run();
  }

  async function ler(
    ws: string,
  ): Promise<{ grupos: GrupoComProcesso[]; pendenciaJanelaDias: number }> {
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/novidades',
      headers: { 'x-ws': ws },
    });
    expect(r.statusCode).toBe(200);
    return r.json();
  }

  it('entrega tribunal, classe e partes do retrato já guardado, por polo', async () => {
    await semear(
      WS,
      NUMERO_TJSP_A,
      [mov(dia(1), 'Juntada')],
      [parte('Autora Sintética', 'ATIVO'), parte('Empresa Fictícia Ltda', 'PASSIVO')],
    );
    const r = await ler(WS);
    expect(r.grupos[0]?.processo).toMatchObject({
      tribunal: 'TJSP',
      classe: 'Procedimento Comum Cível',
      partes: {
        ativo: { nomes: ['Autora Sintética'], total: 1 },
        passivo: { nomes: ['Empresa Fictícia Ltda'], total: 1 },
      },
    });
    expect(r.pendenciaJanelaDias).toBe(10);
  });

  it('fonte sem partes nem classe devolve vazio — nada é deduzido', async () => {
    await semear(WS, NUMERO_TJSP_A, [mov(dia(1), 'Juntada')], [], null);
    const p = (await ler(WS)).grupos[0]?.processo;
    expect(p?.classe).toBeNull();
    expect(p?.partes.ativo).toEqual({ nomes: [], total: 0 });
    expect(p?.partes.passivo).toEqual({ nomes: [], total: 0 });
  });

  it('corta a lista de nomes no teto e diz o total real', async () => {
    const muitas = Array.from({ length: 30 }, (_, i) => parte(`Parte ${i}`, 'ATIVO'));
    await semear(WS, NUMERO_TJSP_A, [mov(dia(1), 'Juntada')], muitas);
    const ativo = (await ler(WS)).grupos[0]?.processo?.partes.ativo;
    expect(ativo?.total).toBe(30);
    expect(ativo?.nomes).toHaveLength(20);
  });

  it('"pede providência" é a regra do selo da carteira: ato recente que exige ação, dentro da janela de 10 dias', async () => {
    const intimacao = 'Intime-se a parte autora para manifestar-se no prazo de 5 dias.';
    await semear(WS, NUMERO_TJSP_A, [mov(dia(2), 'Despacho', intimacao)]);
    await semear(WS, NUMERO_TJSP_B, [mov(dia(14), 'Despacho', intimacao)]);
    const grupos = (await ler(WS)).grupos;
    const a = grupos.find((g) => g.numero === NumeroCNJ.criar(NUMERO_TJSP_A).digitos);
    const b = grupos.find((g) => g.numero === NumeroCNJ.criar(NUMERO_TJSP_B).digitos);
    expect(a?.processo?.pedeProvidencia).toBe(true);
    expect(a?.processo?.motivoProvidencia).toContain('nos últimos 10 dias');
    // O mesmo ato, fora da janela de pendência: não marca (a marca da linha do tempo continua).
    expect(b?.processo?.pedeProvidencia).toBe(false);
    expect(b?.processo?.motivoProvidencia).toBeNull();
  });

  it('isolamento: partes, classe e estado do processo de outro workspace nunca aparecem', async () => {
    await semear(
      'ws-a',
      NUMERO_TJSP_A,
      [mov(dia(1), 'Juntada')],
      [parte('Parte do A', 'ATIVO')],
    );
    await semear(
      'ws-b',
      NUMERO_TJSP_A,
      [mov(dia(1), 'Juntada')],
      [parte('Parte do B', 'ATIVO')],
      'Classe do B',
    );
    const a = await ler('ws-a');
    const b = await ler('ws-b');
    expect(JSON.stringify(a)).not.toContain('Parte do B');
    expect(JSON.stringify(a)).not.toContain('Classe do B');
    expect(JSON.stringify(b)).not.toContain('Parte do A');
    expect(b.grupos[0]?.processo?.classe).toBe('Classe do B');
    // Um workspace sem nenhum acompanhamento recebe tela vazia, não a carteira alheia.
    expect((await ler('ws-c')).grupos).toEqual([]);
  });
});
