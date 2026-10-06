import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
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
const ID = (posicao: number): number => 900_000_000 + posicao;

let dir: ReturnType<typeof pastaTemporaria>;
let servidor: FastifyInstance;
let provedor: ProvedorDeLoteFalso;

/** 385 atos sintéticos recebidos (o "bloqueado 368" não veio); peças só em parte deles. */
async function montar(sigilo = 0): Promise<void> {
  dir = pastaTemporaria();
  provedor = new ProvedorDeLoteFalso([
    { id: 'p384', rotulo: 'Petição sintética', movimento: ID(384) },
    { id: 'p382a', rotulo: 'Laudo sintético', movimento: ID(382) },
    { id: 'p382b', rotulo: 'Anexo sintético 1', movimento: ID(382) },
    { id: 'p382c', rotulo: 'Anexo sintético 2', movimento: ID(382) },
    { id: 'p100', rotulo: 'Contestação sintética', movimento: ID(100) },
  ]);
  provedor.nivelSigiloDoProcesso = sigilo;
  const movimentos: Movimentacao[] = Array.from({ length: 385 }, (_, k) => ({
    data: new Date(Date.UTC(2024, 0, 1) + k * 86_400_000),
    titulo: `Ato sintético ${k + 1}`,
    ...(k === 372 ? { complementos: ['complemento sintético'] } : {}),
    fonte: 'mni' as const,
    idExterno: `mni:${ID(k + 1)}`,
  }));
  provedor.movimentos = movimentos;
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
  }
}

beforeEach(async () => {
  await montar();
});
afterEach(async () => {
  await servidor.close();
  dir.apagar();
});

interface Numero {
  tipo: string;
  n?: number;
}
interface Corpo {
  todasAsMovimentacoes: boolean;
  totalAtosRecebidos: number | null;
  atosSemPeca: Array<{
    posicao: number;
    numero: Numero;
    descricao: string;
    complemento: string | null;
  }>;
  lacunas: Array<{ depoisDaPosicao: number; de: number; ate: number }>;
  linhas: Array<{
    tipo: string;
    pecaId?: string;
    posicao?: number;
    depoisDaPosicao?: number;
  }>;
  totais: { pecas: number; atosSemPeca: number };
  listagem: { processoSigiloso: boolean } | null;
  pecas: Array<{ pecaId: string; estado: string }>;
}
async function ler(h = A): Promise<Corpo> {
  const r = await servidor.inject({ url: PASTA, headers: h });
  expect(r.statusCode).toBe(200);
  return r.json() as Corpo;
}
const carregar = async (h = A): Promise<void> => {
  const r = await servidor.inject({
    url: `/v1/processos/${PROCESSO_TJGO}/pecas`,
    headers: h,
  });
  expect(r.statusCode).toBe(200);
};
const calibrar = async (
  posicao: number | undefined,
  numeroProjudi: number,
): Promise<void> => {
  const r = await servidor.inject({
    method: 'PUT',
    url: `${PASTA}/calibracao`,
    headers: A,
    payload: { numeroProjudi, ...(posicao !== undefined ? { posicao } : {}) },
  });
  expect(r.statusCode).toBe(200);
};

describe('Pasta digital — todas as movimentações (v0.36.0)', () => {
  it('lista todos os atos: os com peça ficam nas linhas de peça, os 380 sem peça ganham linha própria', async () => {
    await carregar();
    const c = await ler();
    expect(c.todasAsMovimentacoes).toBe(true);
    expect(c.totalAtosRecebidos).toBe(385);
    // 385 atos, 3 com peça (384, 382, 100).
    expect(c.atosSemPeca).toHaveLength(382);
    expect(c.totais).toMatchObject({ pecas: 5, atosSemPeca: 382 });
    expect(c.linhas.filter((l) => l.tipo === 'ato')).toHaveLength(382);
    expect(c.linhas.filter((l) => l.tipo === 'peca')).toHaveLength(5);
    // Os números 383–386 aparecem (sem peça ou com): posições 383, 385 sem peça.
    const posicoes = c.atosSemPeca.map((a) => a.posicao);
    expect(posicoes).toContain(385);
    expect(posicoes).toContain(383);
    expect(posicoes).not.toContain(384);
    expect(posicoes).not.toContain(382);
  });

  it('a ordem é a da lista de hoje: mais recente primeiro, atos de mesma posição juntos', async () => {
    await carregar();
    const c = await ler();
    const rotulo = (l: Corpo['linhas'][number]): string =>
      l.tipo === 'peca' ? (l.pecaId as string) : `ato${l.posicao}`;
    expect(c.linhas.slice(0, 8).map(rotulo)).toEqual([
      'ato385',
      'p384',
      'ato383',
      'p382a',
      'p382b',
      'p382c',
      'ato381',
      'ato380',
    ]);
    expect(rotulo(c.linhas[c.linhas.length - 1] as Corpo['linhas'][number])).toBe('ato1');
  });

  it('sem calibração os números são posições, sem lacuna; o identificador interno nunca sai', async () => {
    await carregar();
    const c = await ler();
    expect(c.lacunas).toEqual([]);
    expect(c.atosSemPeca.find((a) => a.posicao === 385)?.numero).toEqual({
      tipo: 'posicao',
      n: 385,
    });
    expect(JSON.stringify([c.atosSemPeca, c.lacunas, c.linhas])).not.toContain('900000');
    const ato373 = c.atosSemPeca.find((a) => a.posicao === 373);
    expect(ato373?.complemento).toBe('complemento sintético');
    expect(ato373?.descricao).toBe('Ato sintético 373');
  });

  it('com âncoras 386, 367 e 369: números exatos 383–386 e a lacuna do 368 provada', async () => {
    await carregar();
    await calibrar(undefined, 386); // o último ato recebido (posição 385)
    await calibrar(367, 367);
    await calibrar(368, 369);
    const c = await ler();
    const numero = (p: number): Numero | undefined =>
      c.atosSemPeca.find((a) => a.posicao === p)?.numero;
    expect(numero(385)).toEqual({ tipo: 'exato', n: 386 });
    expect(numero(383)).toEqual({ tipo: 'exato', n: 384 });
    expect(numero(367)).toEqual({ tipo: 'exato', n: 367 });
    expect(numero(368)).toEqual({ tipo: 'exato', n: 369 });
    expect(c.lacunas).toEqual([{ depoisDaPosicao: 367, de: 368, ate: 368 }]);
    // A lacuna fica entre o ato 368 e o 367 (do mais recente para o mais antigo).
    const i = c.linhas.findIndex((l) => l.tipo === 'lacuna');
    expect(c.linhas[i - 1]).toEqual({ tipo: 'ato', posicao: 368 });
    expect(c.linhas[i + 1]).toEqual({ tipo: 'ato', posicao: 367 });
    // Antes da primeira âncora (posição < 367) o número é faixa ou exato 0-deslocado:
    // 367 tem d=0, então 1–366 são exatos e nunca geram lacuna.
    expect(c.lacunas).toHaveLength(1);
  });

  it('segredo de justiça: a mesma política da listagem (guarda os metadados, peças em sigilo)', async () => {
    await servidor.close();
    dir.apagar();
    await montar(1);
    await carregar();
    const c = await ler();
    expect(c.listagem?.processoSigiloso).toBe(true);
    expect(c.atosSemPeca).toHaveLength(382);
    expect(c.pecas.every((p) => p.estado === 'sigilo')).toBe(true);
  });

  it('isolamento: o outro workspace não vê atos nem linhas do primeiro', async () => {
    await carregar(A);
    const b = await ler(B);
    expect(b.listagem).toBeNull();
    expect(b.atosSemPeca).toEqual([]);
    expect(b.linhas).toEqual([]);
    expect(b.todasAsMovimentacoes).toBe(false);
  });

  it('clicar numa movimentação sem peça não existe como pedido: a rota de peça recusa o id', async () => {
    await carregar();
    const r = await servidor.inject({
      method: 'POST',
      url: `${PASTA}/pecas/ato-385`,
      headers: A,
    });
    expect(r.statusCode).toBe(404);
    expect(provedor.chamadas.filter((c) => c.tipo === 'lote')).toHaveLength(0);
  });
});
