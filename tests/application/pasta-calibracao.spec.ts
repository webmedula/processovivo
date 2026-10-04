import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServicoPasta } from '../../src/application/services/ServicoPasta.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import {
  CalibracaoDeNumeracaoInvalidaError,
  ListagemDaPastaAusenteError,
} from '../../src/domain/errors/index.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDaPastaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDaPastaSqlite.js';
import { Peca } from '../../src/domain/entities/Peca.js';
import { ClockFalso, PROCESSO_TJGO, PROCESSO_TJGO_DIGITOS } from '../helpers/leitor.js';
import type { Logger } from '../../src/domain/ports/Logger.js';

const A = 'ws-a';
const B = 'ws-b';
const SEM_LOG: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return SEM_LOG;
  },
};

/** 385 atos sintéticos, um por dia; o ato de posição `i` tem identificador 900000000 + i. */
function atos(total: number, deslocarDataDe?: number): Movimentacao[] {
  const base = Date.UTC(2025, 0, 1);
  return Array.from({ length: total }, (_, k) => {
    const i = k + 1;
    // Meio dia a mais: a data muda e a ordem dos atos não.
    const dia = i === deslocarDataDe ? i + 0.5 : i;
    return {
      data: new Date(base + dia * 86_400_000),
      titulo: `Ato sintético ${i}`,
      fonte: 'mni' as const,
      idExterno: `mni:${900000000 + i}`,
    };
  });
}
const pecaDoAto = (i: number): Peca =>
  new Peca({
    id: `p${i}`,
    tipo: '57',
    descricao: `Petição sintética ${i}`,
    mimetype: 'application/pdf',
    movimento: 900000000 + i,
  });

let pasta: ServicoPasta;
let repo: RepositorioDaPastaSqlite;

beforeEach(() => {
  const db = abrirBanco(':memory:');
  repo = new RepositorioDaPastaSqlite(db);
  // Só a parte da Pasta que não usa o leitor, a guarda nem a fila.
  pasta = new ServicoPasta({
    repositorio: repo,
    logger: SEM_LOG,
    clock: new ClockFalso(),
    debounceMs: 0,
    leitor: {
      pausadoAte: () => undefined,
      estimar: () => ({ minimoSegundos: 0, maximoSegundos: 0, confirmarAcimaDe: 150 }),
    },
    guarda: { doProcesso: async () => new Map() },
    fila: { doProcesso: async () => [] },
    armazem: {},
  } as unknown as ConstructorParameters<typeof ServicoPasta>[0]);
});
afterEach(() => undefined);

async function listar(total: number, ws = A, deslocarDataDe?: number): Promise<void> {
  await pasta.registrarListagem(ws, PROCESSO_TJGO, {
    pecas: [380, 381, 385, 300].filter((i) => i <= total).map(pecaDoAto),
    movimentos: atos(total, deslocarDataDe),
  });
}
async function numeros(ws = A): Promise<Record<string, unknown>> {
  const v = await pasta.visao(ws, PROCESSO_TJGO);
  return Object.fromEntries(v.pecas.map((p) => [p.pecaId, p.numeroNoProjudi]));
}

describe('calibração do número com o Projudi (cenário sintético: 385 atos, bloqueado na posição 368)', () => {
  it('sem calibração cada ato mostra a posição', async () => {
    await listar(385);
    expect(await numeros()).toMatchObject({
      p385: { tipo: 'posicao', n: 385 },
      p381: { tipo: 'posicao', n: 381 },
    });
    expect((await pasta.visao(A, PROCESSO_TJGO)).calibracao?.ancoras).toEqual([]);
  });

  it('o último número (386) deixa os anteriores em faixa; o do ato 381 (382) torna 381–385 exatos', async () => {
    await listar(385);
    await pasta.calibrarPeloUltimoNumero(A, PROCESSO_TJGO, 386);
    expect(await numeros()).toMatchObject({
      p385: { tipo: 'exato', n: 386 },
      p381: { tipo: 'faixa', min: 381, max: 382 },
      p380: { tipo: 'faixa', min: 380, max: 381 },
    });

    await pasta.calibrar(A, PROCESSO_TJGO, 381, 382);
    expect(await numeros()).toMatchObject({
      p385: { tipo: 'exato', n: 386 },
      p381: { tipo: 'exato', n: 382 },
      // Antes da primeira âncora (d = 1): ainda pode ter 0 bloqueado antes.
      p380: { tipo: 'faixa', min: 380, max: 381 },
    });

    // Uma âncora com d = 0 antes do bloqueado: abaixo dela tudo é exato.
    await pasta.calibrar(A, PROCESSO_TJGO, 300, 300);
    expect(await numeros()).toMatchObject({
      p300: { tipo: 'exato', n: 300 },
      p380: { tipo: 'faixa', min: 380, max: 381 },
    });
    const v = await pasta.visao(A, PROCESSO_TJGO);
    expect(v.calibracao?.ancoras.map((x) => [x.posicao, x.numeroProjudi])).toEqual([
      [300, 300],
      [381, 382],
      [385, 386],
    ]);
    // 1–300 exatos (antes da primeira, d=0) + 381–385 exatos; 301–380 faixa.
    expect(v.calibracao?.atos).toEqual({
      exatos: 305,
      faixas: 80,
      estimados: 0,
      total: 385,
    });
  });

  it('recusa âncora incompatível com as outras', async () => {
    await listar(385);
    await pasta.calibrar(A, PROCESSO_TJGO, 381, 382);
    await expect(pasta.calibrar(A, PROCESSO_TJGO, 385, 385)).rejects.toBeInstanceOf(
      CalibracaoDeNumeracaoInvalidaError,
    );
    await expect(pasta.calibrar(A, PROCESSO_TJGO, 300, 305)).rejects.toThrow(
      /não é compatível/,
    );
    expect((await pasta.calibracao(A, PROCESSO_TJGO)).ancoras).toHaveLength(1);
  });

  it('aceita no máximo 50 âncoras por processo', async () => {
    await listar(385);
    for (let i = 1; i <= 50; i++) await pasta.calibrar(A, PROCESSO_TJGO, i, i);
    await expect(pasta.calibrar(A, PROCESSO_TJGO, 51, 51)).rejects.toThrow(/já tem 50/);
    await pasta.calibrar(A, PROCESSO_TJGO, 50, 50); // substituir cabe
  });

  it('descarta a âncora cujo ato mudou de data numa listagem nova, e avisa', async () => {
    await listar(385);
    await pasta.calibrar(A, PROCESSO_TJGO, 381, 382);
    await pasta.calibrar(A, PROCESSO_TJGO, 385, 386);

    await listar(385, A, 381);
    const c = await pasta.calibracao(A, PROCESSO_TJGO);
    expect(c.ancoras.map((x) => x.posicao)).toEqual([385]);
    expect(c.invalidadas).toBe(1);
    // O aviso continua até a pessoa agir sobre a calibração.
    await listar(385, A, 381);
    expect((await pasta.calibracao(A, PROCESSO_TJGO)).invalidadas).toBe(1);
    await pasta.calibrar(A, PROCESSO_TJGO, 380, 381);
    expect((await pasta.calibracao(A, PROCESSO_TJGO)).invalidadas).toBe(0);
  });

  it('listagem sem datas (anterior à 0.35.0) ou ausente não aceita âncora', async () => {
    await expect(pasta.calibrar(A, PROCESSO_TJGO, 1, 1)).rejects.toBeInstanceOf(
      ListagemDaPastaAusenteError,
    );
    await listar(5);
    // Simula a listagem gravada antes da 0.35.0: coluna sem as datas.
    (repo as unknown as { db: { exec(s: string): void } }).db.exec(
      'UPDATE pasta_listagens SET datas_dos_atos = NULL',
    );
    await expect(pasta.calibrar(A, PROCESSO_TJGO, 1, 1)).rejects.toBeInstanceOf(
      ListagemDaPastaAusenteError,
    );
  });

  it('remove uma âncora, limpa tudo e isola por workspace (A × B)', async () => {
    await listar(385);
    await listar(385, B);
    await pasta.calibrar(A, PROCESSO_TJGO, 381, 382);
    await pasta.calibrar(A, PROCESSO_TJGO, 385, 386);

    expect((await pasta.calibracao(B, PROCESSO_TJGO)).ancoras).toEqual([]);
    expect(await numeros(B)).toMatchObject({ p381: { tipo: 'posicao', n: 381 } });
    expect(await repo.ancorasDoProcesso(B, PROCESSO_TJGO_DIGITOS)).toEqual([]);

    // B apagar não alcança as de A.
    await pasta.limparCalibracao(B, PROCESSO_TJGO);
    await pasta.removerAncora(B, PROCESSO_TJGO, 381);
    expect((await pasta.calibracao(A, PROCESSO_TJGO)).ancoras).toHaveLength(2);

    await pasta.removerAncora(A, PROCESSO_TJGO, 381);
    expect(
      (await pasta.calibracao(A, PROCESSO_TJGO)).ancoras.map((x) => x.posicao),
    ).toEqual([385]);
    await pasta.limparCalibracao(A, PROCESSO_TJGO);
    expect((await pasta.calibracao(A, PROCESSO_TJGO)).ancoras).toEqual([]);
  });

  it('a exclusão da conta apaga as âncoras do workspace', async () => {
    await listar(385);
    await pasta.calibrar(A, PROCESSO_TJGO, 381, 382);
    await repo.apagarDoWorkspace(A);
    expect(await repo.ancorasDoProcesso(A, PROCESSO_TJGO_DIGITOS)).toEqual([]);
  });
});
