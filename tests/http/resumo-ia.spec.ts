import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { NOME_DA_PARTE } from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A, ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import { AGORA_DO_RESUMO, ATOS_DO_RESUMO, ResumidorFalso } from '../helpers/resumoIa.js';

/* Rotas do resumo de processo por IA: texto sintético, resumidor dublê, nenhuma rede. */

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };
const WS_A = workspaceDaChave(CHAVE_A);
const WS_B = workspaceDaChave(CHAVE_B);
const DIGITOS_A = NUMERO_TJSP_A.replace(/\D/g, '');

let app: Aplicacao;
let servidor: FastifyInstance;
let resumidor: ResumidorFalso;

function config() {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    CACHE_ENABLED: 'false',
    PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
    RATE_LIMIT_MAX: '1000',
  } as NodeJS.ProcessEnv);
}

async function montar(comIa: boolean): Promise<void> {
  resumidor = new ResumidorFalso();
  app = aplicacaoDeTeste(
    [
      new ProviderFalso({
        nome: 'falso',
        porNumero: async () =>
          umProcesso({
            partes: [
              { nome: NOME_DA_PARTE, polo: 'ATIVO', tipoPessoa: 'FISICA', advogados: [] },
            ],
            movimentacoes: ATOS_DO_RESUMO,
          }),
      }),
    ],
    {
      agora: () => AGORA_DO_RESUMO,
      ...(comIa
        ? {
            resumoIa: {
              resumidor,
              clock: { agora: () => AGORA_DO_RESUMO, monotonico: () => 0 },
            },
          }
        : {}),
    },
  );
  servidor = construirServidor(app, config());
  await app.acompanhamento.acompanhar(WS_A, NUMERO_TJSP_A);
}

const resumir = (h: Record<string, string> = A, numero = DIGITOS_A) =>
  servidor.inject({
    method: 'POST',
    url: `/v1/acompanhamentos/${numero}/resumo`,
    headers: h,
  });

const avaliar = (id: string, corpo: unknown, h: Record<string, string> = A) =>
  servidor.inject({
    method: 'POST',
    url: `/v1/resumos/${id}/avaliacao`,
    headers: h,
    payload: corpo as Record<string, unknown>,
  });

afterEach(async () => {
  await servidor.close();
});

describe('IA desligada (padrão)', () => {
  beforeEach(() => montar(false));

  it('as rotas do resumo não existem', async () => {
    expect((await resumir()).statusCode).toBe(404);
    expect((await avaliar('x', { avaliacao: 'util' })).statusCode).toBe(404);
  });
});

describe('IA habilitada', () => {
  beforeEach(() => montar(true));

  it('exige autenticação', async () => {
    expect((await resumir({})).statusCode).toBe(401);
  });

  it('sem assinatura: 403 com a frase fixa e zero chamadas ao modelo', async () => {
    const r = await resumir();
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({
      erro: 'ENTRADA_NAO_ANALISAVEL',
      detalhes: { motivo: 'sem_plano' },
    });
    expect(resumidor.chamadas).toBe(0);
  });

  it('plano sem o recurso (Peças): 403 e zero chamadas', async () => {
    await app.assinaturas.liberar({ workspace: WS_A, plano: 'pecas', meses: 1 });
    expect((await resumir()).statusCode).toBe(403);
    expect(resumidor.chamadas).toBe(0);
  });

  describe('com o plano IA', () => {
    beforeEach(async () => {
      await app.assinaturas.liberar({ workspace: WS_A, plano: 'ia', meses: 1 });
      await app.assinaturas.liberar({ workspace: WS_B, plano: 'ia', meses: 1 });
      // O retrato só nasce na sincronização.
      await app.acompanhamento.sincronizar({ workspace: WS_A });
    });

    it('resume o processo: 200, com os itens ligados ao ato e as contagens', async () => {
      const r = await resumir();
      expect(r.statusCode).toBe(200);
      const j = r.json();
      expect(j.estado).toBe('verificado');
      expect(j.situacao[0].ato).toMatchObject({ rotulo: 'Intimação' });
      expect(j.situacao[0].texto).toContain(NOME_DA_PARTE);
      expect(j.contagens).toMatchObject({ atosNoProcesso: 6, providenciasDoSistema: 1 });
      expect(j.versaoPrompt).toBe('resumo-1.0.0');
      expect(resumidor.chamadas).toBe(1);
      // O pedido não leva texto de fora: o que foi ao modelo veio do retrato, redigido.
      expect(resumidor.pedidos[0]?.usuario).not.toContain(NOME_DA_PARTE);
    });

    it('processo que a conta não acompanha: 404', async () => {
      expect((await resumir(B)).statusCode).toBe(404);
      expect(resumidor.chamadas).toBe(0);
    });

    it('avalia com três valores e recusa qualquer outro (inclusive texto livre)', async () => {
      const id = (await resumir()).json().id as string;
      for (const v of ['util', 'errado', 'perigoso']) {
        expect((await avaliar(id, { avaliacao: v })).statusCode).toBe(200);
      }
      expect((await avaliar(id, { avaliacao: 'otimo' })).statusCode).toBe(400);
      expect(
        (await avaliar(id, { avaliacao: 'util', comentario: 'x' })).statusCode,
      ).toBeLessThan(500);
    });

    it('avaliar resumo de outra conta é 404, igual a "não existe"', async () => {
      const id = (await resumir()).json().id as string;
      const deOutro = await avaliar(id, { avaliacao: 'util' }, B);
      const inexistente = await avaliar('nao-existe', { avaliacao: 'util' });
      expect(deOutro.statusCode).toBe(404);
      expect(inexistente.statusCode).toBe(404);
      expect(deOutro.json()).toEqual(inexistente.json());
    });
  });
});
