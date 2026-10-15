import { describe, expect, it } from 'vitest';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
} from '../../src/domain/errors/index.js';
import type { EndpointZdr } from '../../src/infrastructure/adapters/modelo/endpointsZdr.js';
import { lerRespostaDoResumo } from '../../src/infrastructure/adapters/modelo/esquemaDoResumo.js';
import { ModeloComZdr } from '../../src/infrastructure/adapters/modelo/ModeloComZdr.js';
import { OpenRouterResumidorDeProcesso } from '../../src/infrastructure/adapters/modelo/OpenRouterResumidorDeProcesso.js';
import { TransporteOpenRouter } from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { LoggerColetor } from '../helpers/analiseIa.js';
import { ClockFalso } from '../helpers/leitor.js';
import { respostaDoResumo } from '../helpers/resumoIa.js';

const MODELO = 'fab/modelo-falso';
const SEGREDO = 'TEXTO-SECRETO-DO-ATO';
const LISTA: EndpointZdr[] = [
  { modelo: MODELO, provedor: 'Alfa', tag: 'alfa/fp8' },
  { modelo: MODELO, provedor: 'Beta', tag: 'beta' },
];

const json = (corpo: unknown): Response =>
  new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const corpoOk = (provider: string, conteudo: unknown = respostaDoResumo()): unknown => ({
  id: 'g-1',
  model: MODELO,
  provider,
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify(conteudo) },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, cost: 0.0004 },
});

function montar(
  lista: () => Promise<readonly EndpointZdr[]> = async () => LISTA,
  resposta: () => Response = () => json(corpoOk('Alfa')),
) {
  const corpos: Array<Record<string, unknown>> = [];
  const f = (async (_u: string, init: RequestInit) => {
    corpos.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return resposta();
  }) as unknown as typeof fetch;
  const log = new LoggerColetor();
  const modeloZdr = new ModeloComZdr({
    transporte: new TransporteOpenRouter({
      chave: 'sk-or-chave-de-teste-123456',
      fetch: f,
      esperasEntreTentativasMs: [0, 0],
      dormir: async () => {},
    }),
    modelo: MODELO,
    buscarListaZdr: lista,
    clock: new ClockFalso(),
    logger: log,
  });
  const resumidor = new OpenRouterResumidorDeProcesso({
    modeloZdr,
    maxTokens: 1500,
    timeoutMs: 120000,
  });
  return { resumidor, corpos, log };
}

const PEDIDO = { sistema: 'sistema', usuario: `ato: ${SEGREDO}` };

describe('OpenRouterResumidorDeProcesso', () => {
  it('sai com as mesmas travas ZDR da análise e com o formato do resumo em texto', async () => {
    const m = montar();
    const r = await m.resumidor.resumir(PEDIDO);
    const corpo = m.corpos[0]!;
    expect(corpo['provider']).toMatchObject({
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: false,
      only: ['alfa', 'beta'],
    });
    expect(corpo['provider']).not.toHaveProperty('require_parameters');
    expect(corpo).not.toHaveProperty('response_format');
    expect(corpo['max_tokens']).toBe(1500);
    expect(JSON.stringify(corpo['messages'])).toContain('pendencias');
    expect(r.provedor).toBe('Alfa');
    expect(r.resposta.situacao).toHaveLength(2);
    expect(r.tokensEntrada).toBe(100);
  });

  it('lista ZDR inalcançável: falha fechada, nenhuma chamada ao modelo', async () => {
    const m = montar(async () => {
      throw new Error('sem rede');
    });
    await expect(m.resumidor.resumir(PEDIDO)).rejects.toBeInstanceOf(
      ProviderIndisponivelError,
    );
    expect(m.corpos).toHaveLength(0);
  });

  it('resposta de provedor fora do conjunto ZDR é descartada', async () => {
    const m = montar(undefined, () => json(corpoOk('Intruso')));
    await expect(m.resumidor.resumir(PEDIDO)).rejects.toBeInstanceOf(
      ProviderIndisponivelError,
    );
  });

  it('resposta fora do esquema fechado vira RespostaInvalidaError, sem o texto no erro', async () => {
    const m = montar(undefined, () =>
      json(corpoOk('Alfa', { ...respostaDoResumo(), extra: SEGREDO })),
    );
    const erro = await m.resumidor.resumir(PEDIDO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(RespostaInvalidaError);
    expect((erro as Error).message).not.toContain(SEGREDO);
    expect(m.log.linhas.join('\n')).not.toContain(SEGREDO);
  });
});

describe('lerRespostaDoResumo', () => {
  it('aceita a forma certa e recusa campo a mais, item sem trecho e ponto fora do vocabulário', () => {
    expect(lerRespostaDoResumo(respostaDoResumo())).toBeDefined();
    expect(lerRespostaDoResumo({ ...respostaDoResumo(), x: 1 })).toBeUndefined();
    expect(
      lerRespostaDoResumo({
        situacao: [{ texto: 'a', ato: 'A1' }],
        pendencias: [],
        pontos_de_atencao: [],
      }),
    ).toBeUndefined();
    expect(
      lerRespostaDoResumo({ ...respostaDoResumo(), pontos_de_atencao: ['inventado'] }),
    ).toBeUndefined();
    expect(lerRespostaDoResumo('texto')).toBeUndefined();
  });
});
