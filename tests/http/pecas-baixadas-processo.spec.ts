import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Peca } from '../../src/domain/entities/Peca.js';
import type { ConteudoPeca } from '../../src/domain/entities/Peca.js';
import type { ProvedorDePecas } from '../../src/domain/ports/ProvedorDePecas.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';

/*
 * O histórico de peças baixadas vive DENTRO da Pasta digital (v0.37.0) e lê
 * `GET /v1/pecas-baixadas?numero=`: por processo e por workspace. Este arquivo fixa
 * as duas fronteiras, com dois assinantes e dois processos sintéticos.
 */
const CHAVE_A = 'chave-do-assinante-a-1234567890';
const CHAVE_B = 'chave-do-assinante-b-1234567890';
const PROCESSO_1 = numeroValido(4001);
const PROCESSO_2 = numeroValido(4002);

class ProvedorFalsoDePecas implements ProvedorDePecas {
  readonly nome = 'mni-falso';
  readonly tribunais = ['TJGO'];
  async listarPecas(): Promise<Peca[]> {
    return [
      new Peca({
        id: 'doc-1',
        tipo: '57',
        descricao: 'Contestação',
        mimetype: 'application/pdf',
      }),
    ];
  }
  async obterConteudo(): Promise<ConteudoPeca> {
    return {
      id: 'doc-1',
      mimetype: 'application/pdf',
      nomeArquivo: 'contestacao-sintetica.pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    };
  }
}

describe('histórico de peças baixadas por processo', () => {
  let servidor: FastifyInstance;

  beforeEach(() => {
    servidor = construirServidor(
      aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
        provedorDePecas: new ProvedorFalsoDePecas(),
      }),
      carregarConfig({
        PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
        LOG_LEVEL: 'silent',
        PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
        CACHE_ENABLED: 'false',
      } as NodeJS.ProcessEnv),
    );
  });
  afterEach(async () => {
    await servidor.close();
  });

  async function baixar(chave: string, numero: string): Promise<void> {
    await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: { 'x-api-key': chave },
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${numero}/pecas/doc-1`,
      headers: { 'x-api-key': chave },
    });
    expect(r.statusCode).toBe(200);
  }

  async function historico(
    chave: string,
    numero?: string,
  ): Promise<{ numero: string; rotulo: string; bytes: number; baixadaEm: string }[]> {
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/pecas-baixadas${numero ? `?numero=${encodeURIComponent(numero)}` : ''}`,
      headers: { 'x-api-key': chave },
    });
    expect(r.statusCode).toBe(200);
    return (
      r.json() as {
        pecas: { numero: string; rotulo: string; bytes: number; baixadaEm: string }[];
      }
    ).pecas;
  }

  it('só devolve as peças do processo pedido, com rótulo, tamanho e data e hora', async () => {
    await baixar(CHAVE_A, PROCESSO_1);
    await baixar(CHAVE_A, PROCESSO_2);
    await baixar(CHAVE_A, PROCESSO_2);

    const do1 = await historico(CHAVE_A, PROCESSO_1);
    const do2 = await historico(CHAVE_A, PROCESSO_2);
    expect(do1).toHaveLength(1);
    expect(do2).toHaveLength(2);
    expect(do1[0]).toMatchObject({ rotulo: 'contestacao-sintetica.pdf', bytes: 5 });
    expect(Number.isNaN(new Date(do1[0]?.baixadaEm ?? '').getTime())).toBe(false);
    // A pasta aberta usa o número com máscara: é o mesmo processo.
    expect(
      await historico(
        CHAVE_A,
        PROCESSO_1.replace(
          /^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$/,
          '$1-$2.$3.$4.$5.$6',
        ),
      ),
    ).toHaveLength(1);
    // Sem o filtro, é o workspace inteiro — o que a gaveta nunca pede.
    expect(await historico(CHAVE_A)).toHaveLength(3);
  });

  it('isolamento A × B: o histórico do outro assinante nunca aparece, nem do mesmo número', async () => {
    await baixar(CHAVE_A, PROCESSO_1);
    await baixar(CHAVE_B, PROCESSO_2);

    expect(await historico(CHAVE_B, PROCESSO_1)).toEqual([]);
    expect(await historico(CHAVE_A, PROCESSO_2)).toEqual([]);
    expect(await historico(CHAVE_A, PROCESSO_1)).toHaveLength(1);
    expect(await historico(CHAVE_B, PROCESSO_2)).toHaveLength(1);
  });

  it('processo sem download devolve lista vazia, não erro', async () => {
    expect(await historico(CHAVE_A, PROCESSO_1)).toEqual([]);
  });

  it('o registro continua sendo só metadado: nenhuma chave de conteúdo ou de caminho', async () => {
    await baixar(CHAVE_A, PROCESSO_1);
    const [p] = await historico(CHAVE_A, PROCESSO_1);
    expect(Object.keys(p ?? {}).sort()).toEqual([
      'baixadaEm',
      'bytes',
      'idPeca',
      'mimetype',
      'numero',
      'rotulo',
    ]);
  });
});
