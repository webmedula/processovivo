import { describe, expect, it } from 'vitest';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
  ZdrIndisponivelError,
} from '../../src/domain/errors/index.js';
import {
  exigirZdr,
  TransporteGateway,
  type ChamadaAoSdk,
  type ExecutorDoSdk,
} from '../../src/infrastructure/adapters/modelo/TransporteGateway.js';

const PEDIDO = { modelo: 'modelo/falso-1', sistema: 'sistema', usuario: 'usuario' };

function executorQueGrava(respostas: Array<() => ReturnType<ExecutorDoSdk>>): {
  executar: ExecutorDoSdk;
  chamadas: ChamadaAoSdk[];
} {
  const chamadas: ChamadaAoSdk[] = [];
  let i = 0;
  return {
    chamadas,
    executar: (c) => {
      chamadas.push(c);
      const f = respostas[Math.min(i++, respostas.length - 1)];
      if (!f) throw new Error('sem resposta dublada');
      return f();
    },
  };
}

const ok = (): ReturnType<ExecutorDoSdk> =>
  Promise.resolve({
    objeto: { parece_pedir: 'indeterminado' },
    tokensEntrada: 100,
    tokensSaida: 20,
    metadadosDoGateway: {
      cost: 0.0012,
      generationId: 'gen_1',
      routing: { finalProvider: 'provedor-x' },
    },
  });

class ErroDoGateway extends Error {
  constructor(
    mensagem: string,
    readonly statusCode: number,
    readonly type = 'invalid_request_error',
  ) {
    super(mensagem);
  }
}

describe('TransporteGateway — ZDR falha fechado', () => {
  it('TODA chamada leva zeroDataRetention: true, temperatura 0 e nenhuma repetição automática', async () => {
    const { executar, chamadas } = executorQueGrava([ok]);
    const t = new TransporteGateway({ chave: 'chave-de-teste', executar });
    await t.gerar(PEDIDO);
    await t.gerar({ ...PEDIDO, modelo: 'outro/modelo' });
    expect(chamadas).toHaveLength(2);
    for (const c of chamadas) {
      expect(c.providerOptions).toEqual({ gateway: { zeroDataRetention: true } });
      expect(c.temperatura).toBe(0);
      expect(c.tentativasAutomaticas).toBe(0);
    }
  });

  it('no_providers_available (HTTP 400) vira ZdrIndisponivelError e NÃO gera segunda chamada', async () => {
    const { executar, chamadas } = executorQueGrava([
      () =>
        Promise.reject(
          new ErroDoGateway('{"error":{"type":"no_providers_available"}}', 400),
        ),
      ok,
    ]);
    const t = new TransporteGateway({ chave: 'chave-de-teste', executar });
    const erro = await t.gerar(PEDIDO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ZdrIndisponivelError);
    expect(erro).toBeInstanceOf(ProviderIndisponivelError);
    expect(chamadas).toHaveLength(1);
  });

  it('a mensagem do erro traduzido não copia o texto que veio do gateway', async () => {
    const { executar } = executorQueGrava([
      () => Promise.reject(new ErroDoGateway('eco do pedido: TEXTO-SECRETO-DO-ATO', 500)),
    ]);
    const t = new TransporteGateway({ chave: 'chave-de-teste', executar });
    const erro = await t.gerar(PEDIDO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProviderIndisponivelError);
    expect((erro as Error).message).not.toContain('TEXTO-SECRETO');
  });

  it.each([
    [401, /recusada/],
    [429, /limite/],
    [503, /503/],
  ])('HTTP %i vira ProviderIndisponivelError sem repetir', async (status, padrao) => {
    const { executar, chamadas } = executorQueGrava([
      () => Promise.reject(new ErroDoGateway('x', status)),
    ]);
    const t = new TransporteGateway({ chave: 'chave-de-teste', executar });
    const erro = await t.gerar(PEDIDO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProviderIndisponivelError);
    expect((erro as Error).message).toMatch(padrao);
    expect(chamadas).toHaveLength(1);
  });

  it('400 comum (sem ser falta de provedor ZDR) é indisponibilidade, não ZDR', async () => {
    const { executar } = executorQueGrava([
      () => Promise.reject(new ErroDoGateway('modelo inexistente', 400)),
    ]);
    const t = new TransporteGateway({ chave: 'chave-de-teste', executar });
    const erro = await t.gerar(PEDIDO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProviderIndisponivelError);
    expect(erro).not.toBeInstanceOf(ZdrIndisponivelError);
  });

  it('devolve tokens, custo e roteamento do gateway', async () => {
    const { executar } = executorQueGrava([ok]);
    const r = await new TransporteGateway({ chave: 'chave-de-teste', executar }).gerar(
      PEDIDO,
    );
    expect(r).toMatchObject({
      tokensEntrada: 100,
      tokensSaida: 20,
      custoUsd: 0.0012,
      roteamento: { provedorFinal: 'provedor-x', idDaGeracao: 'gen_1' },
    });
  });

  it('exigirZdr recusa uma chamada sem a opção, ainda que montada à força', () => {
    const forjada = {
      ...PEDIDO,
      temperatura: 0,
      tentativasAutomaticas: 0,
      timeoutMs: 1,
      providerOptions: { gateway: {} },
    } as unknown as ChamadaAoSdk;
    expect(() => exigirZdr(forjada)).toThrow(ProviderIndisponivelError);
  });

  it('saída fora do esquema do SDK vira RespostaInvalidaError', async () => {
    const { NoObjectGeneratedError } = await import('ai');
    const { executar } = executorQueGrava([
      () =>
        Promise.reject(
          new NoObjectGeneratedError({
            message: 'x',
            text: 'y',
            response: { id: 'r', timestamp: new Date(), modelId: 'm' },
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never,
            finishReason: 'stop',
          }),
        ),
    ]);
    const erro = await new TransporteGateway({ chave: 'chave-de-teste', executar })
      .gerar(PEDIDO)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(RespostaInvalidaError);
  });
});

describe('TransporteGateway — no fio (SDK real, HTTP dublado)', () => {
  const corpoOk = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          parece_pedir: 'indeterminado',
          resumo: 'r',
          trecho_chave: '',
          acoes_possiveis: [],
          pontos_de_atencao: [],
        }),
      },
    ],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
    warnings: [],
    providerMetadata: {
      gateway: { cost: '0.0003', routing: { finalProvider: 'prov' }, generationId: 'g1' },
    },
  };

  function fetchDublado(resposta: () => Response): {
    fetch: typeof fetch;
    corpos: Array<Record<string, unknown>>;
  } {
    const corpos: Array<Record<string, unknown>> = [];
    return {
      corpos,
      fetch: (async (_url: string, init: RequestInit) => {
        corpos.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return resposta();
      }) as unknown as typeof fetch,
    };
  }

  it('o corpo que sai pela rede leva providerOptions.gateway.zeroDataRetention: true, temperatura 0 e o esquema fechado', async () => {
    const f = fetchDublado(
      () =>
        new Response(JSON.stringify(corpoOk), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const r = await new TransporteGateway({
      chave: 'chave-de-teste',
      fetch: f.fetch,
    }).gerar(PEDIDO);
    expect(f.corpos).toHaveLength(1);
    const corpo = f.corpos[0] as Record<string, unknown>;
    expect(corpo['providerOptions']).toEqual({ gateway: { zeroDataRetention: true } });
    expect(corpo['temperature']).toBe(0);
    expect(corpo['tools']).toBeUndefined();
    expect(JSON.stringify(corpo['responseFormat'])).toContain(
      '"additionalProperties":false',
    );
    expect(r).toMatchObject({ tokensEntrada: 10, tokensSaida: 5, custoUsd: 0.0003 });
    expect(r.objeto).toMatchObject({ parece_pedir: 'indeterminado' });
  });

  it('HTTP 400 no_providers_available vira ZdrIndisponivelError com UMA única requisição', async () => {
    const f = fetchDublado(
      () =>
        new Response(
          JSON.stringify({
            error: { message: 'No providers available', type: 'no_providers_available' },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const erro = await new TransporteGateway({ chave: 'chave-de-teste', fetch: f.fetch })
      .gerar(PEDIDO)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ZdrIndisponivelError);
    expect(f.corpos).toHaveLength(1);
  });

  it('HTTP 500 não é repetido pelo SDK (maxRetries 0)', async () => {
    const f = fetchDublado(
      () =>
        new Response(JSON.stringify({ error: { message: 'falhou' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const erro = await new TransporteGateway({ chave: 'chave-de-teste', fetch: f.fetch })
      .gerar(PEDIDO)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProviderIndisponivelError);
    expect(f.corpos).toHaveLength(1);
  });

  it('resposta que não cumpre o esquema vira RespostaInvalidaError', async () => {
    const f = fetchDublado(
      () =>
        new Response(
          JSON.stringify({
            ...corpoOk,
            content: [{ type: 'text', text: '{"parece_pedir":"transferir_dinheiro"}' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const erro = await new TransporteGateway({ chave: 'chave-de-teste', fetch: f.fetch })
      .gerar(PEDIDO)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(RespostaInvalidaError);
  });
});
