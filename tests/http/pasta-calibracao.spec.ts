import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import {
  PROCESSO_TJGO,
  ProvedorDeLoteFalso,
  pastaTemporaria,
} from '../helpers/leitor.js';

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };
const PASTA = `/v1/processos/${PROCESSO_TJGO}/pasta`;
const CAL = `${PASTA}/calibracao`;

let dir: ReturnType<typeof pastaTemporaria>;
let servidor: FastifyInstance;

beforeEach(async () => {
  dir = pastaTemporaria();
  // 6 atos sintéticos; as peças p2 e p5 pertencem aos atos de posição 2 e 5.
  const provedor = new ProvedorDeLoteFalso([
    { id: 'p2', rotulo: 'Petição sintética', movimento: 900000002 },
    { id: 'p5', rotulo: 'Contestação sintética', movimento: 900000005 },
  ]);
  provedor.movimentos = Array.from({ length: 6 }, (_, k) => ({
    data: new Date(Date.UTC(2025, 0, k + 1)),
    titulo: `Ato sintético ${k + 1}`,
    fonte: 'mni' as const,
    idExterno: `mni:${900000001 + k}`,
  }));
  const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    provedorDePecas: provedor,
    leitor: { pasta: dir.caminho },
    comAssinaturas: true,
  });
  servidor = construirServidor(
    app,
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      CACHE_ENABLED: 'false',
      PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
    } as NodeJS.ProcessEnv),
  );
  for (const [chave, h] of [
    [CHAVE_A, A],
    [CHAVE_B, B],
  ] as const) {
    await app.assinaturas.liberar({
      workspace: workspaceDaChave(chave),
      plano: 'pecas',
      meses: 1,
    });
    await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: h,
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
    await servidor.inject({ url: `/v1/processos/${PROCESSO_TJGO}/pecas`, headers: h });
  }
});
afterEach(async () => {
  await servidor.close();
  dir.apagar();
});

interface Corpo {
  calibracao: {
    ancoras: Array<{ posicao: number; numeroProjudi: number }>;
    atos: { exatos: number; faixas: number; estimados: number; total: number };
    invalidadas: number;
  } | null;
  pecas: Array<{ pecaId: string; movimentacao: { numero: unknown } | null }>;
}
async function ler(h = A): Promise<Corpo> {
  const r = await servidor.inject({ url: PASTA, headers: h });
  expect(r.statusCode).toBe(200);
  return r.json() as Corpo;
}
const numeroDe = (c: Corpo, id: string): unknown =>
  c.pecas.find((p) => p.pecaId === id)?.movimentacao?.numero;

describe('rotas da calibração do número do Projudi', () => {
  it('sem calibração a Pasta traz a posição e o resumo vazio', async () => {
    const c = await ler();
    expect(numeroDe(c, 'p5')).toEqual({ tipo: 'posicao', n: 5 });
    expect(c.calibracao).toEqual({
      ancoras: [],
      atos: { exatos: 0, faixas: 0, estimados: 0, total: 6 },
      invalidadas: 0,
    });
  });

  it('o atalho "último número" ancora o último ato; a âncora na posição 5 torna 5 e 6 exatos', async () => {
    const r1 = await servidor.inject({
      method: 'PUT',
      url: CAL,
      headers: A,
      payload: { numeroProjudi: 7 },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().ancoras).toMatchObject([{ posicao: 6, numeroProjudi: 7 }]);
    expect(numeroDe(await ler(), 'p5')).toEqual({ tipo: 'faixa', min: 5, max: 6 });

    const r2 = await servidor.inject({
      method: 'PUT',
      url: CAL,
      headers: A,
      payload: { posicao: 5, numeroProjudi: 6 },
    });
    expect(r2.statusCode).toBe(200);
    const c = await ler();
    expect(numeroDe(c, 'p5')).toEqual({ tipo: 'exato', n: 6 });
    expect(numeroDe(c, 'p2')).toEqual({ tipo: 'faixa', min: 2, max: 3 });
    expect(c.calibracao?.atos).toEqual({ exatos: 2, faixas: 4, estimados: 0, total: 6 });
  });

  it('recusa número incompatível com 400 e mensagem clara; corpo inválido também', async () => {
    await servidor.inject({
      method: 'PUT',
      url: CAL,
      headers: A,
      payload: { posicao: 5, numeroProjudi: 6 },
    });
    const r = await servidor.inject({
      method: 'PUT',
      url: CAL,
      headers: A,
      payload: { posicao: 6, numeroProjudi: 6 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({
      erro: 'CALIBRACAO_DE_NUMERACAO_INVALIDA',
      mensagem: expect.stringContaining('não é compatível'),
    });
    const ruim = await servidor.inject({
      method: 'PUT',
      url: CAL,
      headers: A,
      payload: { numeroProjudi: 'sete' },
    });
    expect(ruim.statusCode).toBe(400);
  });

  it('isola por workspace: B não vê nem apaga a calibração de A', async () => {
    await servidor.inject({
      method: 'PUT',
      url: CAL,
      headers: A,
      payload: { posicao: 5, numeroProjudi: 6 },
    });
    expect((await ler(B)).calibracao?.ancoras).toEqual([]);
    expect(numeroDe(await ler(B), 'p5')).toEqual({ tipo: 'posicao', n: 5 });

    expect(
      (await servidor.inject({ method: 'DELETE', url: CAL, headers: B })).statusCode,
    ).toBe(200);
    expect(
      (await servidor.inject({ method: 'DELETE', url: `${CAL}/5`, headers: B }))
        .statusCode,
    ).toBe(200);
    expect((await ler(A)).calibracao?.ancoras).toHaveLength(1);
  });

  it('remove uma âncora e limpa todas; sem chave é 401', async () => {
    await servidor.inject({
      method: 'PUT',
      url: CAL,
      headers: A,
      payload: { posicao: 5, numeroProjudi: 6 },
    });
    await servidor.inject({
      method: 'PUT',
      url: CAL,
      headers: A,
      payload: { posicao: 2, numeroProjudi: 2 },
    });
    const um = await servidor.inject({ method: 'DELETE', url: `${CAL}/5`, headers: A });
    expect(um.json().ancoras).toMatchObject([{ posicao: 2 }]);
    const todas = await servidor.inject({ method: 'DELETE', url: CAL, headers: A });
    expect(todas.json().ancoras).toEqual([]);
    expect((await servidor.inject({ method: 'DELETE', url: CAL })).statusCode).toBe(401);
    expect(
      (await servidor.inject({ method: 'PUT', url: CAL, payload: {} })).statusCode,
    ).toBe(401);
  });
});
