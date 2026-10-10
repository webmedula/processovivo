import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
  ZdrIndisponivelError,
} from '../../src/domain/errors/index.js';
import {
  exigirZdr,
  PREFERENCIAS_DE_PROVEDOR,
  TransporteOpenRouter,
  type ChamadaAoSdk,
  type DetalheDeErro,
  type ExecutorDoSdk,
} from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';

const PEDIDO = { modelo: 'fab/modelo-falso', sistema: 'sistema', usuario: 'usuario' };
const CHAVE = 'sk-or-chave-de-teste-123456';

const erroHttp = (status: number, corpo = '{"error":{"message":"x"}}'): APICallError =>
  new APICallError({
    message: `eco: TEXTO-SECRETO-DO-ATO ${corpo}`,
    url: 'https://x',
    requestBodyValues: {},
    statusCode: status,
    responseBody: corpo,
  });

function executorSequencial(passos: Array<() => ReturnType<ExecutorDoSdk>>): {
  executar: ExecutorDoSdk;
  chamadas: ChamadaAoSdk[];
} {
  const chamadas: ChamadaAoSdk[] = [];
  let i = 0;
  return {
    chamadas,
    executar: (c) => {
      chamadas.push(c);
      const f = passos[Math.min(i++, passos.length - 1)];
      if (!f) throw new Error('sem passo dublado');
      return f();
    },
  };
}

const ok = (): ReturnType<ExecutorDoSdk> =>
  Promise.resolve({
    objeto: { parece_pedir: 'indeterminado' },
    provedor: 'Provedor Alfa',
    tokensEntrada: 100,
    tokensSaida: 20,
    custoUsd: 0.0012,
  });
const falha = (e: Error) => (): ReturnType<ExecutorDoSdk> => Promise.reject(e);

function transporte(
  passos: Array<() => ReturnType<ExecutorDoSdk>>,
  extra: { aoFalhar?: (d: DetalheDeErro) => void } = {},
) {
  const { executar, chamadas } = executorSequencial(passos);
  const esperas: number[] = [];
  const t = new TransporteOpenRouter({
    chave: CHAVE,
    executar,
    dormir: async (ms) => void esperas.push(ms),
    ...extra,
  });
  return { t, chamadas, esperas };
}

describe('TransporteOpenRouter — ZDR falha fechada', () => {
  it('TODA chamada leva provider.zdr: true e data_collection: deny, temperatura 0 e nenhuma repetição do SDK', async () => {
    const { t, chamadas } = transporte([ok]);
    await t.gerar(PEDIDO);
    await t.gerar({ ...PEDIDO, modelo: 'outro/modelo' });
    expect(chamadas).toHaveLength(2);
    for (const c of chamadas) {
      expect(c.provider).toMatchObject({
        zdr: true,
        data_collection: 'deny',
        require_parameters: true,
      });
      expect(c.temperatura).toBe(0);
      expect(c.tentativasAutomaticas).toBe(0);
    }
    expect(Object.isFrozen(PREFERENCIAS_DE_PROVEDOR)).toBe(true);
  });

  it('chamada sem zdr é recusada ANTES de qualquer rede', async () => {
    const { t, chamadas } = transporte([ok]);
    (t as unknown as { montarChamada: () => unknown }).montarChamada = () => ({
      ...PEDIDO,
      temperatura: 0,
      tentativasAutomaticas: 0,
      timeoutMs: 1,
      provider: { data_collection: 'deny' },
    });
    await expect(t.gerar(PEDIDO)).rejects.toBeInstanceOf(ProviderIndisponivelError);
    expect(chamadas).toHaveLength(0);
  });

  it('exigirZdr recusa objeto de provedor ausente, sem zdr ou sem data_collection', () => {
    const base = {
      ...PEDIDO,
      temperatura: 0 as const,
      tentativasAutomaticas: 0 as const,
      timeoutMs: 1,
    };
    for (const provider of [
      undefined,
      {},
      { zdr: false, data_collection: 'deny' },
      { zdr: true },
      { zdr: true, data_collection: 'allow' },
    ]) {
      expect(() => exigirZdr({ ...base, provider } as unknown as ChamadaAoSdk)).toThrow(
        ProviderIndisponivelError,
      );
    }
    expect(() =>
      exigirZdr({ ...base, provider: PREFERENCIAS_DE_PROVEDOR }),
    ).not.toThrow();
  });

  it.each([
    [
      404,
      '{"error":{"message":"No endpoints found matching your data policy (Zero data retention)","code":404}}',
    ],
    [
      400,
      '{"error":{"message":"No allowed providers are available for the selected model."}}',
    ],
  ])(
    'HTTP %i "sem provedor" vira ZdrIndisponivelError e NÃO gera segunda chamada',
    async (status, corpo) => {
      const { t, chamadas, esperas } = transporte([falha(erroHttp(status, corpo)), ok]);
      const erro = await t.gerar(PEDIDO).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ZdrIndisponivelError);
      expect(erro).toBeInstanceOf(ProviderIndisponivelError);
      expect(chamadas).toHaveLength(1);
      expect(esperas).toEqual([]);
    },
  );

  it('404 que não fala de provedor, 401, 402 e 400 comum: erro de indisponibilidade, sem repetir', async () => {
    for (const [status, padrao] of [
      [404, /404/],
      [401, /recusada/],
      [402, /402/],
      [400, /400/],
    ] as const) {
      const { t, chamadas } = transporte([
        falha(erroHttp(status, '{"error":{"message":"modelo inexistente"}}')),
        ok,
      ]);
      const erro = await t.gerar(PEDIDO).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ProviderIndisponivelError);
      expect(erro).not.toBeInstanceOf(ZdrIndisponivelError);
      expect((erro as Error).message).toMatch(padrao);
      expect(chamadas).toHaveLength(1);
    }
  });

  it('429 gera nova tentativa COM zdr: true, esperando 1 s', async () => {
    const { t, chamadas, esperas } = transporte([falha(erroHttp(429)), ok]);
    const r = await t.gerar(PEDIDO);
    expect(r.provedor).toBe('Provedor Alfa');
    expect(chamadas).toHaveLength(2);
    expect(chamadas.every((c) => c.provider.zdr === true)).toBe(true);
    expect(esperas).toEqual([1000]);
  });

  it('5xx: no máximo 2 repetições, esperas crescentes (1 s, 3 s), todas com zdr; depois, erro', async () => {
    const { t, chamadas, esperas } = transporte([falha(erroHttp(503))]);
    const erro = await t.gerar(PEDIDO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProviderIndisponivelError);
    expect(chamadas).toHaveLength(3);
    expect(
      chamadas.every(
        (c) => c.provider.zdr === true && c.provider.data_collection === 'deny',
      ),
    ).toBe(true);
    expect(esperas).toEqual([1000, 3000]);
  });

  it('falha de rede (sem status) também repete, e a esquema inválido não', async () => {
    const rede = transporte([falha(new Error('socket')), ok]);
    await rede.t.gerar(PEDIDO);
    expect(rede.chamadas).toHaveLength(2);

    const { NoObjectGeneratedError } = await import('ai');
    const invalido = transporte([
      falha(
        new NoObjectGeneratedError({
          message: 'x',
          text: 'y',
          response: { id: 'r', timestamp: new Date(), modelId: 'm' },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never,
          finishReason: 'stop',
        }),
      ),
      ok,
    ]);
    await expect(invalido.t.gerar(PEDIDO)).rejects.toBeInstanceOf(RespostaInvalidaError);
    expect(invalido.chamadas).toHaveLength(1);
  });

  it('a mensagem do erro traduzido nunca copia o texto nem o corpo que vieram do serviço', async () => {
    const { t } = transporte([
      falha(erroHttp(500, '{"error":{"message":"TEXTO-SECRETO-DO-ATO"}}')),
    ]);
    const erro = await t.gerar(PEDIDO).catch((e: unknown) => e);
    expect((erro as Error).message).not.toContain('TEXTO-SECRETO');
    expect((erro as Error).message).not.toContain(CHAVE);
  });

  it('aoFalhar recebe status e corpo (só o teste de falha fechada o liga)', async () => {
    const vistos: DetalheDeErro[] = [];
    const { t } = transporte(
      [falha(erroHttp(404, '{"error":{"message":"No endpoints found"}}'))],
      { aoFalhar: (d) => vistos.push(d) },
    );
    await t.gerar(PEDIDO).catch(() => undefined);
    expect(vistos).toEqual([
      { status: 404, corpo: '{"error":{"message":"No endpoints found"}}' },
    ]);
  });
});

describe('TransporteOpenRouter — no fio (SDK real, HTTP dublado)', () => {
  const corpoOk = {
    id: 'gen-1',
    model: 'fab/modelo-falso',
    provider: 'Provedor Alfa',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            parece_pedir: 'indeterminado',
            resumo: 'r',
            trecho_chave: '',
            acoes_possiveis: [],
            pontos_de_atencao: [],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0003 },
  };

  function fio(respostas: Array<() => Response>) {
    const corpos: Array<Record<string, unknown>> = [];
    const cabecalhos: Array<Record<string, string>> = [];
    let i = 0;
    const f = (async (_url: string, init: RequestInit) => {
      corpos.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      cabecalhos.push(init.headers as Record<string, string>);
      return (respostas[Math.min(i++, respostas.length - 1)] as () => Response)();
    }) as unknown as typeof fetch;
    return { f, corpos, cabecalhos };
  }
  const json = (corpo: unknown, status = 200): Response =>
    new Response(JSON.stringify(corpo), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('o corpo que sai pela rede leva provider.zdr: true e data_collection: deny, esquema fechado e nenhuma ferramenta', async () => {
    const w = fio([() => json(corpoOk)]);
    const r = await new TransporteOpenRouter({ chave: CHAVE, fetch: w.f }).gerar(PEDIDO);
    const corpo = w.corpos[0] as Record<string, unknown>;
    expect(corpo['provider']).toMatchObject({
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect(corpo['model']).toBe('fab/modelo-falso');
    expect(corpo['temperature']).toBe(0);
    expect(corpo['tools']).toBeUndefined();
    expect(JSON.stringify(corpo['response_format'])).toContain(
      '"additionalProperties":false',
    );
    expect(r).toMatchObject({
      provedor: 'Provedor Alfa',
      tokensEntrada: 10,
      tokensSaida: 5,
      custoUsd: 0.0003,
    });
    expect(r.objeto).toMatchObject({ parece_pedir: 'indeterminado' });
  });

  it('a chave vai só no cabeçalho de autorização, nunca no corpo', async () => {
    const w = fio([() => json(corpoOk)]);
    await new TransporteOpenRouter({ chave: CHAVE, fetch: w.f }).gerar(PEDIDO);
    expect(JSON.stringify(w.corpos[0])).not.toContain(CHAVE);
    expect(w.cabecalhos[0]?.['authorization']).toBe(`Bearer ${CHAVE}`);
  });

  it('429 pela rede: nova tentativa, e a segunda também leva zdr: true', async () => {
    const w = fio([
      () => json({ error: { message: 'limite', code: 429 } }, 429),
      () => json(corpoOk),
    ]);
    await new TransporteOpenRouter({
      chave: CHAVE,
      fetch: w.f,
      dormir: async () => undefined,
    }).gerar(PEDIDO);
    expect(w.corpos).toHaveLength(2);
    expect(w.corpos.every((c) => (c['provider'] as { zdr?: boolean }).zdr === true)).toBe(
      true,
    );
  });

  it('404 "No endpoints found" vira ZdrIndisponivelError com UMA requisição', async () => {
    const w = fio([
      () =>
        json(
          {
            error: { message: 'No endpoints found matching your data policy', code: 404 },
          },
          404,
        ),
      () => json(corpoOk),
    ]);
    const erro = await new TransporteOpenRouter({
      chave: CHAVE,
      fetch: w.f,
      dormir: async () => undefined,
    })
      .gerar(PEDIDO)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ZdrIndisponivelError);
    expect(w.corpos).toHaveLength(1);
  });

  it('resposta que não cumpre o esquema vira RespostaInvalidaError, sem repetir', async () => {
    const w = fio([
      () =>
        json({
          ...corpoOk,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '{"parece_pedir":"transferir_dinheiro"}',
              },
            },
          ],
        }),
    ]);
    const erro = await new TransporteOpenRouter({ chave: CHAVE, fetch: w.f })
      .gerar(PEDIDO)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(RespostaInvalidaError);
    expect(w.corpos).toHaveLength(1);
  });

  it('resposta sem o campo provider chega com provedor ausente (a sonda trata como NÃO confirmado)', async () => {
    const { provider: _p, ...semProvedor } = corpoOk;
    const w = fio([() => json(semProvedor)]);
    const r = await new TransporteOpenRouter({ chave: CHAVE, fetch: w.f }).gerar(PEDIDO);
    expect(r.provedor === undefined || r.provedor === '').toBe(true);
  });
});
