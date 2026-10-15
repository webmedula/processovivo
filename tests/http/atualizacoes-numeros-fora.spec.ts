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
import { ProviderFalso } from '../helpers/fabricas.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';

/**
 * v0.41.0 — `numerosForaDaJanela` e `numerosEmOutroTribunal`: só os NÚMEROS dos
 * processos que o Período ou o Tribunal deixaram fora de `GET /v1/novidades`,
 * para a busca por número da tela contar o que casa fora dos filtros sem outra
 * requisição. Números sintéticos, com dígito verificador válido.
 */
const AGORA = new Date('2026-10-08T12:00:00Z');
const dia = (n: number): Date => new Date(AGORA.getTime() - n * 86_400_000);

const SP_RECENTE = numeroValido(1101, '26');
const SP_ANTIGO = numeroValido(1102, '26');
const SP_SEM_NOVIDADE = numeroValido(1103, '26');
const GO_RECENTE = numeroValido(2201, '09');
const GO_ANTIGO = numeroValido(2202, '09');
const DE_OUTRA_CONTA = numeroValido(3301, '09');

interface Resposta {
  numerosForaDaJanela: string[];
  numerosEmOutroTribunal: string[];
  processosForaDaJanela: number;
}

function processo(numero: string, tribunal: string): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal,
    classe: 'Procedimento Comum Cível',
    segredoJustica: false,
    movimentacoes: [{ data: dia(40), titulo: 'Distribuição' }],
    procedencia: { provider: 't', consultadoEm: AGORA, deCache: false },
  });
}

describe('GET /v1/novidades — números fora do Período e do Tribunal', () => {
  let db: DatabaseSync;
  let servidor: FastifyInstance;
  let ws = 'ws-a';

  beforeEach(async () => {
    ws = 'ws-a';
    db = abrirBanco(':memory:');
    const repo = new RepositorioAcompanhamentosSqlite(db);
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
    const cadastrar = async (
      w: string,
      numero: string,
      tribunal: string,
      diasDetectada: number | null,
    ): Promise<void> => {
      await repo.acompanhar(w, numero);
      await repo.registrarSincronizacao(w, numero, processo(numero, tribunal), []);
      if (diasDetectada === null) return;
      await repo.registrarSincronizacao(w, numero, processo(numero, tribunal), [
        { data: dia(diasDetectada), titulo: 'Despacho' },
      ]);
      db.prepare('UPDATE novidades SET detectada_em = ? WHERE numero = ?').run(
        dia(diasDetectada).toISOString(),
        numero,
      );
    };
    await cadastrar('ws-a', SP_RECENTE, 'TJSP', 2);
    await cadastrar('ws-a', SP_ANTIGO, 'TJSP', 40);
    await cadastrar('ws-a', SP_SEM_NOVIDADE, 'TJSP', null);
    await cadastrar('ws-a', GO_RECENTE, 'TJGO', 3);
    await cadastrar('ws-a', GO_ANTIGO, 'TJGO', 50);
    await cadastrar('ws-b', DE_OUTRA_CONTA, 'TJGO', 50);
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

  it('sem Período e sem Tribunal (o padrão da aba) as duas listas vêm vazias', async () => {
    const r = await ler('?janela=todas');
    expect(r.numerosForaDaJanela).toEqual([]);
    expect(r.numerosEmOutroTribunal).toEqual([]);
  });

  it('com o Período ligado, lista os processos sem atualização nele — com novidade antiga ou sem novidade nenhuma', async () => {
    const r = await ler();
    expect([...r.numerosForaDaJanela].sort()).toEqual(
      [SP_ANTIGO, SP_SEM_NOVIDADE, GO_ANTIGO].sort(),
    );
    expect(r.numerosEmOutroTribunal).toEqual([]);
    expect(r.processosForaDaJanela).toBe(3);
  });

  it('com o Tribunal escolhido, lista os de outro tribunal, tenham ou não atualização', async () => {
    const r = await ler('?janela=todas&tribunal=TJSP');
    expect([...r.numerosEmOutroTribunal].sort()).toEqual([GO_RECENTE, GO_ANTIGO].sort());
    expect(r.numerosForaDaJanela).toEqual([]);
  });

  it('Período e Tribunal juntos: o de outro tribunal fora do período conta nas DUAS listas (a tela escolhe o motivo)', async () => {
    const r = await ler('?tribunal=TJSP');
    expect([...r.numerosForaDaJanela].sort()).toEqual(
      [SP_ANTIGO, SP_SEM_NOVIDADE, GO_ANTIGO].sort(),
    );
    expect([...r.numerosEmOutroTribunal].sort()).toEqual([GO_RECENTE, GO_ANTIGO].sort());
    // O campo antigo continua falando só do tribunal escolhido.
    expect(r.processosForaDaJanela).toBe(2);
  });

  it('nunca traz o número de processo de outra conta', async () => {
    const corpo = (
      await servidor.inject({ method: 'GET', url: '/v1/novidades?tribunal=TJSP' })
    ).body;
    expect(corpo).not.toContain(DE_OUTRA_CONTA);
    ws = 'ws-b';
    const b = await ler();
    expect(b.numerosForaDaJanela).toEqual([DE_OUTRA_CONTA]);
  });

  it('só números: nada de texto, parte ou ato dentro das duas listas', async () => {
    const r = await ler('?tribunal=TJSP');
    for (const n of [...r.numerosForaDaJanela, ...r.numerosEmOutroTribunal])
      expect(n).toMatch(/^\d{20}$/);
  });

  it('naoVistas=true e consulta por número não afirmam "fora": as listas vêm vazias', async () => {
    const a = await ler('?naoVistas=true&tribunal=TJSP');
    expect(a.numerosForaDaJanela).toEqual([]);
    expect(a.numerosEmOutroTribunal).toEqual([]);
    const b = await ler(`?numero=${SP_RECENTE}&tribunal=TJSP`);
    expect(b.numerosForaDaJanela).toEqual([]);
    expect(b.numerosEmOutroTribunal).toEqual([]);
  });
});
