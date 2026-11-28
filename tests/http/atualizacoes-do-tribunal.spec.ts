import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { rotasDeAcompanhamento } from '../../src/main/http/rotas/acompanhamentos.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';

/**
 * v0.72.0 — a atualização lida no Projudi chega à tela marcada (`doTribunal`), tanto a novidade
 * quanto a última movimentação do processo sem novidade. Aditivo: nenhum campo antigo muda.
 * Números e títulos sintéticos.
 */
const AGORA = new Date('2026-11-28T12:00:00Z');
const WS = 'ws-a';
const A = NumeroCNJ.criar(numeroValido(7301)).digitos;
const B = NumeroCNJ.criar(numeroValido(7302)).digitos;
const dia = (n: number): Date => new Date(AGORA.getTime() - n * 86_400_000);

const daqui = (n: number, titulo: string, fonte: string): Movimentacao => ({
  data: dia(n),
  titulo,
  fonte,
  ...(fonte === 'mni' ? { idExterno: `mni:${n}`, codigoTpu: 11010 } : {}),
});

function processo(numero: string, movs: Movimentacao[]): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal: 'TJGO',
    movimentacoes: movs,
    procedencia: { provider: 'datajud+djen+mni', consultadoEm: AGORA, deCache: false },
  });
}

describe('GET /v1/novidades — o que veio do Projudi', () => {
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

  it('a novidade do tribunal leva doTribunal: true; a do Diário, false', async () => {
    const antes = processo(A, [daqui(20, 'Distribuição', 'datajud')]);
    await repo.acompanhar(WS, A);
    await repo.registrarSincronizacao(WS, A, antes, []);
    const doProjudi = daqui(2, 'Despacho -> Mero Expediente', 'mni');
    const doDiario = daqui(1, 'Despacho', 'djen');
    await repo.registrarSincronizacao(
      WS,
      A,
      processo(A, [daqui(20, 'Distribuição', 'datajud'), doProjudi, doDiario]),
      [doProjudi, doDiario],
    );

    const r = await servidor.inject({ method: 'GET', url: '/v1/novidades' });
    const corpo = r.json() as {
      grupos: Array<{ maisRecente: { titulo: string; doTribunal: boolean } }>;
      novidades: Array<{ titulo: string; doTribunal: boolean }>;
    };
    expect(corpo.grupos[0]?.maisRecente).toMatchObject({
      titulo: 'Despacho',
      doTribunal: false,
    });
    const fontes = (await repo.listarNovidades(WS)).map((n) => [n.titulo, n.fonte]);
    expect(fontes).toEqual(
      expect.arrayContaining([
        ['Despacho -> Mero Expediente', 'mni'],
        ['Despacho', 'djen'],
      ]),
    );
  });

  it('a atualização mais recente lida no Projudi chega com doTribunal: true', async () => {
    await repo.acompanhar(WS, A);
    await repo.registrarSincronizacao(
      WS,
      A,
      processo(A, [daqui(20, 'Distribuição', 'datajud')]),
      [],
    );
    const doProjudi = daqui(1, 'Despacho -> Mero Expediente', 'mni');
    await repo.registrarSincronizacao(
      WS,
      A,
      processo(A, [daqui(20, 'Distribuição', 'datajud'), doProjudi]),
      [doProjudi],
    );
    const r = await servidor.inject({ method: 'GET', url: '/v1/novidades' });
    const corpo = r.json() as { grupos: Array<{ maisRecente: { doTribunal: boolean } }> };
    expect(corpo.grupos[0]?.maisRecente.doTribunal).toBe(true);
  });

  it('o processo sem novidade cuja última movimentação é do tribunal também vem marcado', async () => {
    await repo.acompanhar(WS, B);
    await repo.registrarSincronizacao(
      WS,
      B,
      processo(B, [
        daqui(9, 'Distribuição', 'datajud'),
        daqui(3, 'Juntada -> Petição', 'mni'),
      ]),
      [],
    );

    const r = await servidor.inject({ method: 'GET', url: '/v1/novidades' });
    const corpo = r.json() as {
      semNovidade: Array<{ ultimaMovimentacao: { titulo: string; doTribunal: boolean } }>;
    };
    expect(corpo.semNovidade[0]?.ultimaMovimentacao).toMatchObject({
      titulo: 'Juntada -> Petição',
      doTribunal: true,
    });
  });
});
