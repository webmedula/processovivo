import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import { ServicoVigilanciaOab } from '../../src/application/services/ServicoVigilanciaOab.js';
import type { BuscaPorOabComPeriodo } from '../../src/application/services/ServicoVigilanciaOab.js';
import { fundirProcessos } from '../../src/domain/entities/fusaoProcessos.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioVigilanciasSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioVigilanciasSqlite.js';
import { ProviderFalso, NUMERO_TJSP_A } from '../helpers/fabricas.js';

/*
 * O caminho real da avalanche, de ponta a ponta e com relógio fixo: a vigilância
 * por OAB descobre o processo (retrato só do DJEN) e a varredura regular passa a
 * trazê-lo completo (DataJud + DJEN). Sintético; nenhuma rede.
 */
const WS = 'workspace-a';
const NUM = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
const T_VIGILANCIA = new Date('2026-09-05T15:00:00Z');
const T_VARREDURA_1 = new Date('2026-09-06T15:00:00Z');
const T_VARREDURA_2 = new Date('2026-09-08T15:00:00Z');

const djen = (): Processo =>
  new Processo({
    numero: NumeroCNJ.criar(NUMERO_TJSP_A),
    tribunal: 'TJSP',
    partes: [
      { nome: 'FULANO', polo: 'ATIVO', tipoPessoa: 'DESCONHECIDO', advogados: [] },
    ],
    movimentacoes: [
      {
        data: new Date('2026-09-01T00:00:00-03:00'),
        titulo: 'Decisão',
        idExterno: 'djen:1',
      },
    ],
    procedencia: { provider: 'djen', consultadoEm: T_VIGILANCIA, deCache: false },
  });

function datajud(extra: Movimentacao[], consultadoEm: Date): Processo {
  const base = new Date('2024-02-01T13:00:00Z').getTime();
  const historico = Array.from({ length: 60 }, (_, i) => ({
    data: new Date(base + i * 10 * 86_400_000),
    titulo: `Andamento ${i}`,
  }));
  return new Processo({
    numero: NumeroCNJ.criar(NUMERO_TJSP_A),
    tribunal: 'TJSP',
    movimentacoes: [...historico, ...extra],
    procedencia: { provider: 'datajud', consultadoEm, deCache: false },
  });
}

class BuscaFalsa implements BuscaPorOabComPeriodo {
  async buscarPorOabNoPeriodo(): Promise<Processo[]> {
    return [djen()];
  }
}

describe('vigilância descobre → varredura regular completa → zero novidades herdadas', () => {
  let db: DatabaseSync;
  let repo: RepositorioAcompanhamentosSqlite;
  let respostaDaCadeia: Processo;
  let agora: Date;
  let acompanhamento: ServicoAcompanhamento;

  beforeEach(async () => {
    db = abrirBanco(':memory:');
    repo = new RepositorioAcompanhamentosSqlite(db);
    const vigilancia = new ServicoVigilanciaOab({
      vigilancias: new RepositorioVigilanciasSqlite(db),
      acompanhamentos: repo,
      busca: new BuscaFalsa(),
      logger: loggerSilencioso,
      pausaMs: 0,
      agora: () => T_VIGILANCIA,
    });
    await vigilancia.vigiar(WS, '47383', 'GO');
    await vigilancia.varrer();

    respostaDaCadeia = fundirProcessos(datajud([], T_VARREDURA_1), djen());
    agora = T_VARREDURA_1;
    acompanhamento = new ServicoAcompanhamento({
      repositorio: repo,
      provider: new ProviderFalso({
        nome: 'cadeia',
        porNumero: async () => respostaDaCadeia,
      }),
      logger: loggerSilencioso,
      pausaEntreConsultasMs: 0,
      agora: () => agora,
    });
  });
  afterEach(() => db.close());

  it('a vigilância grava só o DJEN, sem novidade', async () => {
    const a = await repo.buscar(WS, NUM);
    expect(a?.processo?.procedencia.provider).toBe('djen');
    expect(a?.processo?.movimentacoes).toHaveLength(1);
    expect(await repo.contarNaoVistas(WS)).toBe(0);
  });

  it('a primeira varredura regular traz as 60+ linhas do DataJud e NÃO as avisa', async () => {
    const r = await acompanhamento.sincronizar({ workspace: WS });

    expect(r.novidades).toBe(0);
    expect(await repo.contarNaoVistas(WS)).toBe(0);
    const a = await repo.buscar(WS, NUM);
    // O retrato novo é o completo: o histórico entrou como linha de base.
    expect(a?.processo?.movimentacoes.length).toBeGreaterThan(60);
    expect(a?.processo?.procedencia.provider).toBe('datajud+djen');
  });

  it('e um ato realmente novo, depois disso, gera exatamente UMA novidade', async () => {
    await acompanhamento.sincronizar({ workspace: WS });

    respostaDaCadeia = fundirProcessos(
      datajud(
        [{ data: new Date('2026-09-07T12:00:00Z'), titulo: 'Sentença nova' }],
        T_VARREDURA_2,
      ),
      djen(),
    );
    agora = T_VARREDURA_2;
    const r = await acompanhamento.sincronizar({ workspace: WS });

    expect(r.novidades).toBe(1);
    expect(await repo.contarNaoVistas(WS)).toBe(1);
    const [n] = await repo.listarNovidades(WS);
    expect(n?.titulo).toBe('Sentença nova');
  });
});
