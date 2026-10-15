import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
  SemProvedorQueAtendaError,
  ZdrIndisponivelError,
} from '../../src/domain/errors/index.js';
import {
  exigirZdr,
  jsonDoTexto,
  INSTRUCAO_DE_FORMATO_EM_TEXTO,
  type Degrau,
  PREFERENCIAS_BASE_DE_PROVEDOR,
  TransporteOpenRouter,
  type ChamadaAoSdk,
  type DetalheDeErro,
  type ExecutorDoSdk,
} from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { lerRespostaDoModelo } from '../../src/infrastructure/adapters/modelo/esquemaDaAnalise.js';

const PEDIDO = {
  modelo: 'fab/modelo-falso',
  sistema: 'sistema',
  usuario: 'usuario',
  provedoresPermitidos: ['alfa', 'beta'],
};
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
        allow_fallbacks: false,
      });
      expect(c.provider.require_parameters).toBeUndefined();
      expect(c.saida).toBe('texto');
      expect(c.temperatura).toBe(0);
      expect(c.tentativasAutomaticas).toBe(0);
    }
    expect(Object.isFrozen(PREFERENCIAS_BASE_DE_PROVEDOR)).toBe(true);
    for (const c of chamadas) expect(c.provider.only).toEqual(['alfa', 'beta']);
  });

  it('chamada sem zdr é recusada ANTES de qualquer rede', async () => {
    const { t, chamadas } = transporte([ok]);
    (t as unknown as { montarChamada: () => unknown }).montarChamada = () => ({
      ...PEDIDO,
      temperatura: 0,
      tentativasAutomaticas: 0,
      timeoutMs: 1,
      provider: { data_collection: 'deny', only: ['alfa'] },
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
      saida: 'esquema' as const,
    };
    for (const provider of [
      undefined,
      {},
      { zdr: false, data_collection: 'deny', only: ['alfa'] },
      { zdr: true, only: ['alfa'] },
      { zdr: true, data_collection: 'allow', only: ['alfa'] },
      { zdr: true, data_collection: 'deny' },
      { zdr: true, data_collection: 'deny', only: [] },
      { zdr: true, data_collection: 'deny', only: [''] },
    ]) {
      expect(() => exigirZdr({ ...base, provider } as unknown as ChamadaAoSdk)).toThrow(
        ProviderIndisponivelError,
      );
    }
    expect(() =>
      exigirZdr({
        ...base,
        provider: { ...PREFERENCIAS_BASE_DE_PROVEDOR, only: ['alfa'] },
      }),
    ).not.toThrow();
  });

  it('sem provider.only (ou vazio) a chamada é recusada ANTES de qualquer rede — a restrição é preventiva', async () => {
    for (const permitidos of [[], ['']]) {
      const { t, chamadas } = transporte([ok]);
      await expect(
        t.gerar({ ...PEDIDO, provedoresPermitidos: permitidos }),
      ).rejects.toBeInstanceOf(ProviderIndisponivelError);
      expect(chamadas).toHaveLength(0);
    }
  });

  it.each(['~deepseek/deepseek-flash-latest', 'fab/modelo:free', 'fab/modelo:online'])(
    'apelido ou variante "%s" é recusado ANTES de qualquer rede',
    async (modelo) => {
      const { t, chamadas } = transporte([ok]);
      const erro = await t.gerar({ ...PEDIDO, modelo }).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ProviderIndisponivelError);
      expect((erro as Error).message).toMatch(/apelido ou variante/);
      expect(chamadas).toHaveLength(0);
    },
  );

  it.each([
    [
      404,
      '{"error":{"message":"No endpoints found matching your data policy (Zero data retention)","code":404,"metadata":{"failed_routing_step":"data_policy_filter","routing_funnel":{"total":7,"after_data_policy":0}}}}',
    ],
    [
      400,
      '{"error":{"message":"No allowed providers are available for the selected model.","metadata":{"failed_routing_step":"zdr","routing_funnel":[{"step":"zdr","remaining":0}]}}}',
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

  it('o passo NÃO é a política de dados: vira SemProvedorQueAtendaError com passo e funil, e NÃO "sem ZDR"', async () => {
    const corpo =
      '{"error":{"message":"No endpoints found","code":404,"metadata":{"failed_routing_step":"provider_only_filter","routing_funnel":{"total":7,"after_data_policy":3,"after_only":0}}}}';
    const { t, chamadas, esperas } = transporte([falha(erroHttp(404, corpo)), ok]);
    const erro = await t.gerar(PEDIDO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(SemProvedorQueAtendaError);
    expect(erro).not.toBeInstanceOf(ZdrIndisponivelError);
    expect(erro).toMatchObject({
      passo: 'provider_only_filter',
      funil: { total: 7, after_data_policy: 3, after_only: 0 },
    });
    expect((erro as Error).message).toContain('provider_only_filter');
    expect(chamadas).toHaveLength(1);
    expect(esperas).toEqual([]);
  });

  it('o passo é a política de dados: "sem ZDR", e o erro carrega o passo e o funil', async () => {
    const corpo =
      '{"error":{"message":"x","metadata":{"failed_routing_step":"data_policy_filter","routing_funnel":{"total":7,"after_data_policy":0}}}}';
    const erro = await transporte([falha(erroHttp(404, corpo))])
      .t.gerar(PEDIDO)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ZdrIndisponivelError);
    expect(erro).toMatchObject({
      passo: 'data_policy_filter',
      funil: { total: 7, after_data_policy: 0 },
    });
  });

  it('404 com a frase "No endpoints found" e SEM passo: não chama de "sem ZDR" — diz que o passo não veio', async () => {
    const corpo =
      '{"error":{"message":"No endpoints found matching your data policy","code":404}}';
    const erro = await transporte([falha(erroHttp(404, corpo))])
      .t.gerar(PEDIDO)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(SemProvedorQueAtendaError);
    expect(erro).not.toBeInstanceOf(ZdrIndisponivelError);
    expect((erro as Error).message).toMatch(/não informou o passo/);
  });

  it('o aoFalhar recebe o passo e o funil do erro', async () => {
    const vistos: DetalheDeErro[] = [];
    const corpo =
      '{"error":{"message":"x","metadata":{"failed_routing_step":"parametros","routing_funnel":{"total":3}}}}';
    await transporte([falha(erroHttp(404, corpo))], { aoFalhar: (d) => vistos.push(d) })
      .t.gerar(PEDIDO)
      .catch(() => undefined);
    expect(vistos[0]).toMatchObject({ passo: 'parametros', funil: { total: 3 } });
  });

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
    expect(vistos[0]).toMatchObject({
      status: 404,
      corpo: '{"error":{"message":"No endpoints found"}}',
    });
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
      only: ['alfa', 'beta'],
    });
    // 0.38.4: nem require_parameters nem response_format na chamada normal.
    expect(
      (corpo['provider'] as Record<string, unknown>)['require_parameters'],
    ).toBeUndefined();
    expect(corpo['response_format']).toBeUndefined();
    expect(JSON.stringify(corpo['messages'])).toContain('FORMATO DA RESPOSTA');
    expect(corpo['model']).toBe('fab/modelo-falso');
    expect(corpo['temperature']).toBe(0);
    expect(corpo['tools']).toBeUndefined();
    expect(r).toMatchObject({
      provedor: 'Provedor Alfa',
      tokensEntrada: 10,
      tokensSaida: 5,
      custoUsd: 0.0003,
    });
    expect(r.objeto).toMatchObject({ parece_pedir: 'indeterminado' });
  });

  const comTexto = (content: string): unknown => ({
    ...corpoOk,
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content } },
    ],
  });
  const JSON_VALIDO =
    '{"parece_pedir":"indeterminado","resumo":"r","trecho_chave":"","acoes_possiveis":[],"pontos_de_atencao":[]}';

  it('o corpo da chamada normal SEMPRE leva only, zdr e data_collection — também na repetição, e nunca require_parameters nem response_format', async () => {
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
    for (const c of w.corpos) {
      const prov = c['provider'] as Record<string, unknown>;
      expect(prov['zdr']).toBe(true);
      expect(prov['data_collection']).toBe('deny');
      expect(prov['allow_fallbacks']).toBe(false);
      expect(Array.isArray(prov['only']) && (prov['only'] as unknown[]).length > 0).toBe(
        true,
      );
      expect(prov['require_parameters']).toBeUndefined();
      expect(c['response_format']).toBeUndefined();
    }
  });

  it('resposta com cerca de código é lida (e validada depois pelo Zod do analisador)', async () => {
    const w = fio([() => json(comTexto('```json\n' + JSON_VALIDO + '\n```'))]);
    const r = await new TransporteOpenRouter({ chave: CHAVE, fetch: w.f }).gerar(PEDIDO);
    expect(r.objeto).toMatchObject({ parece_pedir: 'indeterminado' });
    expect(lerRespostaDoModelo(r.objeto)).toBeDefined();
  });

  it('resposta com chaves antes do JSON falha de forma segura: sem repetir e sem texto no erro nem no que vai ao log', async () => {
    const w = fio([
      () => json(comTexto('Veja {TEXTO-SECRETO-DO-ATO} e então: ' + JSON_VALIDO)),
    ]);
    const vistos: DetalheDeErro[] = [];
    const erro = await new TransporteOpenRouter({
      chave: CHAVE,
      fetch: w.f,
      dormir: async () => undefined,
      aoFalhar: (d) => void vistos.push(d),
    })
      .gerar(PEDIDO)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(RespostaInvalidaError);
    expect(w.corpos).toHaveLength(1);
    expect(JSON.stringify([(erro as Error).message, erro, vistos])).not.toContain(
      'TEXTO-SECRETO-DO-ATO',
    );
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
            error: {
              message: 'No endpoints found matching your data policy',
              code: 404,
              metadata: { failed_routing_step: 'data_policy_filter' },
            },
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

  it('resposta fora do esquema chega como objeto e o Zod strict do analisador a recusa, sem repetir', async () => {
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
    // Desde a 0.38.4 o transporte não valida o esquema (não há response_format): quem recusa é
    // o `lerRespostaDoModelo` do analisador, que vira RespostaInvalidaError lá.
    const r = await new TransporteOpenRouter({ chave: CHAVE, fetch: w.f }).gerar(PEDIDO);
    expect(w.corpos).toHaveLength(1);
    expect(lerRespostaDoModelo(r.objeto)).toBeUndefined();
  });

  it('resposta sem o campo provider chega com provedor ausente (a sonda trata como NÃO confirmado)', async () => {
    const { provider: _p, ...semProvedor } = corpoOk;
    const w = fio([() => json(semProvedor)]);
    const r = await new TransporteOpenRouter({ chave: CHAVE, fetch: w.f }).gerar(PEDIDO);
    expect(r.provedor === undefined || r.provedor === '').toBe(true);
  });

  it('o corpo enviado leva provider.only (a restrição aos provedores ZDR do modelo); a repetição por 429 restringe a UM provedor da lista (v0.38.3)', async () => {
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
    const only = (c: Record<string, unknown>): string[] | undefined =>
      (c['provider'] as { only?: string[] }).only;
    expect(only(w.corpos[0] as Record<string, unknown>)).toEqual(['alfa', 'beta']);
    expect(only(w.corpos[1] as Record<string, unknown>)).toEqual(['alfa']);
    for (const c of w.corpos)
      expect(c['provider']).toMatchObject({
        zdr: true,
        data_collection: 'deny',
        allow_fallbacks: false,
      });
  });

  it('devolve os campos model e provider DA RESPOSTA e o corpo enviado SEM texto e SEM chave', async () => {
    const w = fio([() => json({ ...corpoOk, model: 'fab/modelo-resolvido' })]);
    const r = await new TransporteOpenRouter({ chave: CHAVE, fetch: w.f }).gerar({
      ...PEDIDO,
      sistema: 'INSTRUCAO-FIXA-LONGA '.repeat(20),
      usuario: 'TEXTO-SINTETICO-DO-ATO '.repeat(10),
    });
    expect(r.modeloResolvido).toBe('fab/modelo-resolvido');
    expect(r.provedor).toBe('Provedor Alfa');
    expect(r.diagnostico).toMatchObject({
      modeloResolvido: 'fab/modelo-resolvido',
      provedorDaResposta: 'Provedor Alfa',
    });
    const enviado = JSON.stringify(r.diagnostico.corpoEnviado);
    expect(enviado).not.toContain('TEXTO-SINTETICO');
    expect(enviado).not.toContain('INSTRUCAO-FIXA');
    expect(enviado).not.toContain(CHAVE);
    expect(enviado).toContain('[omitido:');
    expect(r.diagnostico.corpoEnviado).toMatchObject({
      model: 'fab/modelo-falso',
      provider: {
        zdr: true,
        data_collection: 'deny',
        allow_fallbacks: false,
        only: ['alfa', 'beta'],
      },
    });
  });

  it('o erro devolve ao aoFalhar o corpo enviado saneado, e nunca o texto', async () => {
    const vistos: DetalheDeErro[] = [];
    const w = fio([
      () => json({ error: { message: 'No endpoints found', code: 404 } }, 404),
    ]);
    await new TransporteOpenRouter({
      chave: CHAVE,
      fetch: w.f,
      aoFalhar: (d) => vistos.push(d),
    })
      .gerar({ ...PEDIDO, usuario: 'TEXTO-SINTETICO-DO-ATO ' })
      .catch(() => undefined);
    expect(JSON.stringify(vistos[0]?.corpoEnviado)).not.toContain('TEXTO-SINTETICO');
    expect(vistos[0]?.corpoEnviado).toMatchObject({
      provider: { only: ['alfa', 'beta'] },
    });
  });

  describe('degraus do diagnóstico (zdr sempre)', () => {
    const corposDosDegraus = async (): Promise<
      Record<Degrau, Record<string, unknown>>
    > => {
      const saida = {} as Record<Degrau, Record<string, unknown>>;
      for (const degrau of ['A', 'B', 'C', 'D'] as const) {
        const w = fio([
          () =>
            json(
              degrau === 'C' || degrau === 'D'
                ? {
                    ...corpoOk,
                    choices: [
                      {
                        index: 0,
                        finish_reason: 'stop',
                        message: {
                          role: 'assistant',
                          content:
                            '```json\n{"parece_pedir":"indeterminado","resumo":"r","trecho_chave":"","acoes_possiveis":[],"pontos_de_atencao":[]}\n```',
                        },
                      },
                    ],
                  }
                : corpoOk,
            ),
        ]);
        const t = new TransporteOpenRouter({ chave: CHAVE, fetch: w.f });
        const r = await t.gerarDiagnostico(PEDIDO, degrau);
        expect(r.objeto).toMatchObject({ parece_pedir: 'indeterminado' });
        saida[degrau] = w.corpos[0] as Record<string, unknown>;
      }
      return saida;
    };

    it('todos os degraus levam zdr: true e data_collection: deny; cada um tira UMA coisa a mais', async () => {
      const c = await corposDosDegraus();
      const prov = (d: Degrau): Record<string, unknown> =>
        c[d]['provider'] as Record<string, unknown>;
      for (const d of ['A', 'B', 'C', 'D'] as const) {
        expect(prov(d)).toMatchObject({
          zdr: true,
          data_collection: 'deny',
          allow_fallbacks: false,
        });
      }
      // A: tudo.
      expect(prov('A')).toMatchObject({
        require_parameters: true,
        only: ['alfa', 'beta'],
      });
      expect(c.A['response_format']).toBeDefined();
      // B: sem require_parameters.
      expect(prov('B')['require_parameters']).toBeUndefined();
      expect(prov('B')['only']).toEqual(['alfa', 'beta']);
      expect(c.B['response_format']).toBeDefined();
      // C: sem esquema estrito (instrução no texto).
      expect(c.C['response_format']).toBeUndefined();
      expect(prov('C')['only']).toEqual(['alfa', 'beta']);
      // D: sem provider.only.
      expect(prov('D')['only']).toBeUndefined();
      expect(c.D['response_format']).toBeUndefined();
    });

    it('a instrução de formato vai no sistema só nos degraus em texto (C e D)', async () => {
      const w = fio([() => json(corpoOk)]);
      const executados: string[] = [];
      const t = new TransporteOpenRouter({
        chave: CHAVE,
        executar: async (c) => {
          executados.push(c.sistema);
          return { objeto: {} };
        },
      });
      void w;
      for (const d of ['A', 'B', 'C', 'D'] as const) await t.gerarDiagnostico(PEDIDO, d);
      expect(executados.map((s) => s.includes(INSTRUCAO_DE_FORMATO_EM_TEXTO))).toEqual([
        false,
        false,
        true,
        true,
      ]);
    });

    it('sem provider.only só o degrau D passa; a chamada normal (gerar) continua exigindo', async () => {
      const chamadas: ChamadaAoSdk[] = [];
      const t = new TransporteOpenRouter({
        chave: CHAVE,
        executar: async (c) => {
          chamadas.push(c);
          return { objeto: {} };
        },
      });
      await t.gerarDiagnostico({ ...PEDIDO, provedoresPermitidos: [] }, 'D');
      expect(chamadas).toHaveLength(1);
      expect(chamadas[0]?.provider.only).toBeUndefined();
      await expect(
        t.gerarDiagnostico({ ...PEDIDO, provedoresPermitidos: [] }, 'A'),
      ).rejects.toBeInstanceOf(ProviderIndisponivelError);
      await expect(
        t.gerar({ ...PEDIDO, provedoresPermitidos: [] }),
      ).rejects.toBeInstanceOf(ProviderIndisponivelError);
      expect(chamadas).toHaveLength(1);
    });

    it('nenhum degrau existe sem zdr: o D também recusa provider sem zdr', () => {
      const base = {
        ...PEDIDO,
        temperatura: 0 as const,
        tentativasAutomaticas: 0 as const,
        timeoutMs: 1,
        saida: 'texto' as const,
      };
      expect(() =>
        exigirZdr(
          { ...base, provider: { data_collection: 'deny' } } as unknown as ChamadaAoSdk,
          { admiteSemRestricao: true },
        ),
      ).toThrow(ProviderIndisponivelError);
    });

    it('apelido é recusado também no diagnóstico, antes de qualquer rede', async () => {
      const chamadas: ChamadaAoSdk[] = [];
      const t = new TransporteOpenRouter({
        chave: CHAVE,
        executar: async (c) => {
          chamadas.push(c);
          return { objeto: {} };
        },
      });
      await expect(
        t.gerarDiagnostico({ ...PEDIDO, modelo: '~x/y-latest' }, 'D'),
      ).rejects.toBeInstanceOf(ProviderIndisponivelError);
      expect(chamadas).toHaveLength(0);
    });

    it('jsonDoTexto tolera cerca de código e frase em volta; texto sem JSON é resposta inválida', () => {
      expect(jsonDoTexto('Claro:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
      expect(() => jsonDoTexto('sem json aqui')).toThrow(RespostaInvalidaError);
      expect(() => jsonDoTexto('{quebrado')).toThrow(RespostaInvalidaError);
    });
  });

  describe('raciocínio, max_tokens, custo e uso', () => {
    it.each([
      ['padrao', undefined],
      ['desligado', { enabled: false }],
      ['nenhum', { effort: 'none' }],
      ['minimo', { effort: 'minimal' }],
      ['baixo', { effort: 'low' }],
    ] as const)('raciocínio %s vai no corpo como %j', async (nivel, esperado) => {
      const w = fio([() => json(corpoOk)]);
      await new TransporteOpenRouter({
        chave: CHAVE,
        fetch: w.f,
        ajustes: { raciocinio: nivel },
      }).gerar(PEDIDO);
      expect(w.corpos[0]?.['reasoning']).toEqual(esperado);
      expect((w.corpos[0]?.['provider'] as { zdr?: boolean }).zdr).toBe(true);
    });

    it('max_tokens vai no corpo; sem o ajuste, não vai', async () => {
      const com = fio([() => json(corpoOk)]);
      await new TransporteOpenRouter({
        chave: CHAVE,
        fetch: com.f,
        ajustes: { maxTokens: 800 },
      }).gerar(PEDIDO);
      expect(com.corpos[0]?.['max_tokens']).toBe(800);
      const sem = fio([() => json(corpoOk)]);
      await new TransporteOpenRouter({ chave: CHAVE, fetch: sem.f }).gerar(PEDIDO);
      expect(sem.corpos[0]?.['max_tokens']).toBeUndefined();
    });

    it('o custo vem do usage.cost da resposta, e os NOMES dos campos do usage ficam no diagnóstico', async () => {
      const w = fio([
        () =>
          json({
            ...corpoOk,
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
              cost: 0.0042,
              cost_details: { upstream_inference_cost: 0.004 },
              completion_tokens_details: { reasoning_tokens: 3 },
            },
          }),
      ]);
      const r = await new TransporteOpenRouter({ chave: CHAVE, fetch: w.f }).gerar(
        PEDIDO,
      );
      expect(r.custoUsd).toBe(0.0042);
      expect(r.tokensRaciocinio).toBe(3);
      expect(r.diagnostico.camposDoUsage).toEqual([
        'completion_tokens',
        'completion_tokens_details',
        'cost',
        'cost_details',
        'prompt_tokens',
        'total_tokens',
      ]);
    });

    it('sem usage.cost na resposta: custo ausente (não inventado), e os campos recebidos aparecem', async () => {
      const w = fio([
        () =>
          json({
            ...corpoOk,
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      ]);
      const r = await new TransporteOpenRouter({ chave: CHAVE, fetch: w.f }).gerar(
        PEDIDO,
      );
      expect(r.custoUsd).toBeUndefined();
      expect(r.diagnostico.camposDoUsage).toEqual([
        'completion_tokens',
        'prompt_tokens',
        'total_tokens',
      ]);
    });

    it('a contabilização de uso é pedida (usage.include) e o corpo não leva texto nem chave', async () => {
      const w = fio([() => json(corpoOk)]);
      await new TransporteOpenRouter({ chave: CHAVE, fetch: w.f }).gerar(PEDIDO);
      expect(w.corpos[0]?.['usage']).toEqual({ include: true });
    });
  });
});

describe('TransporteOpenRouter — roteamento da falha (v0.38.2)', () => {
  it('429 esgotado: o erro leva o status HTTP e nenhum texto do corpo nem da mensagem', async () => {
    const { t } = transporte([
      falha(erroHttp(429, '{"error":{"message":"TEXTO-SECRETO-DO-ATO"}}')),
    ]);
    const erro = (await t
      .gerar(PEDIDO)
      .catch((e: unknown) => e)) as ProviderIndisponivelError;

    expect(erro).toBeInstanceOf(ProviderIndisponivelError);
    expect(erro.roteamento).toEqual({ status: 429 });
    expect(JSON.stringify(erro.roteamento)).not.toContain('TEXTO-SECRETO-DO-ATO');
    expect(erro.message).not.toContain('TEXTO-SECRETO-DO-ATO');
  });

  it('404 com passo e funil: status, passo e funil saneados vão no erro, na subclasse certa', async () => {
    const corpo = JSON.stringify({
      error: {
        message: 'No endpoints found',
        metadata: {
          failed_routing_step: 'require_parameters',
          routing_funnel: { inicial: 5, depois_do_only: 2, depois_dos_parametros: 0 },
        },
      },
    });
    const { t } = transporte([falha(erroHttp(404, corpo))]);
    const erro = (await t
      .gerar(PEDIDO)
      .catch((e: unknown) => e)) as SemProvedorQueAtendaError;

    expect(erro).toBeInstanceOf(SemProvedorQueAtendaError);
    expect(erro.roteamento).toEqual({
      status: 404,
      passo: 'require_parameters',
      funil: { inicial: 5, depois_do_only: 2, depois_dos_parametros: 0 },
    });
  });

  it('o funil sai saneado: string longa vira marcador e campo com nome de segredo vira "[omitido]"', async () => {
    const corpo = JSON.stringify({
      error: {
        metadata: {
          failed_routing_step: 'only',
          routing_funnel: { nota: 'x'.repeat(300), api_key: 'sk-or-segredo' },
        },
      },
    });
    const { t } = transporte([falha(erroHttp(404, corpo))]);
    const erro = (await t
      .gerar(PEDIDO)
      .catch((e: unknown) => e)) as ProviderIndisponivelError;

    const texto = JSON.stringify(erro.roteamento);
    expect(texto).not.toContain('sk-or-segredo');
    expect(texto).not.toContain('x'.repeat(300));
    expect(texto).toContain('[omitido');
  });
});

describe('TransporteOpenRouter — rodízio por provedor depois de 429/5xx (v0.38.3)', () => {
  const PERMITIDOS = ['alfa', 'beta', 'gama', 'delta'];
  const PEDIDO_4 = { ...PEDIDO, provedoresPermitidos: PERMITIDOS };
  const limite = (status = 429) =>
    falha(erroHttp(status, '{"error":{"message":"TEXTO-SECRETO-DO-ATO"}}'));
  const onlyDe = (c: ChamadaAoSdk): readonly string[] | undefined => c.provider.only;

  it('1ª tentativa leva TODOS os permitidos; o 429 leva a uma 2ª chamada com UM provedor da lista', async () => {
    const { t, chamadas } = transporte([limite(), ok]);
    await t.gerar(PEDIDO_4);

    expect(chamadas).toHaveLength(2);
    expect(onlyDe(chamadas[0] as ChamadaAoSdk)).toEqual(PERMITIDOS);
    const segunda = onlyDe(chamadas[1] as ChamadaAoSdk) ?? [];
    expect(segunda).toHaveLength(1);
    expect(PERMITIDOS).toContain(segunda[0]);
    // diferente do conjunto anterior: deixou de ser "todos"
    expect(segunda).not.toEqual(PERMITIDOS);
  });

  it('percorre a lista EM ORDEM, um provedor por tentativa, sem repetir nenhum', async () => {
    const { t, chamadas } = transporte([limite(), limite(503), limite(), ok]);
    await t.gerar(PEDIDO_4);

    expect(chamadas.map(onlyDe)).toEqual([PERMITIDOS, ['alfa'], ['beta'], ['gama']]);
  });

  it('esgotada a lista, falha: 1 + 4 chamadas, nenhuma fora da lista, sem texto no erro nem no roteamento', async () => {
    const { t, chamadas, esperas } = transporte([limite()]);
    const erro = (await t
      .gerar(PEDIDO_4)
      .catch((e: unknown) => e)) as ProviderIndisponivelError;

    expect(erro).toBeInstanceOf(ProviderIndisponivelError);
    expect(chamadas).toHaveLength(5);
    expect(chamadas.map(onlyDe)).toEqual([
      PERMITIDOS,
      ['alfa'],
      ['beta'],
      ['gama'],
      ['delta'],
    ]);
    for (const c of chamadas)
      for (const p of onlyDe(c) ?? []) expect(PERMITIDOS).toContain(p);
    // O log da 0.38.2 recebe o status, sem texto.
    expect(erro.roteamento).toEqual({ status: 429 });
    expect(erro.message).not.toContain('TEXTO-SECRETO-DO-ATO');
    expect(JSON.stringify(erro.roteamento)).not.toContain('TEXTO-SECRETO-DO-ATO');
    // As esperas atuais (1 s, 3 s) valem; as seguintes repetem a última.
    expect(esperas).toEqual([1_000, 3_000, 3_000, 3_000]);
  });

  it('zdr, data_collection e allow_fallbacks: false estão em TODA tentativa', async () => {
    const { t, chamadas } = transporte([limite()]);
    await t.gerar(PEDIDO_4).catch(() => undefined);

    expect(chamadas.length).toBeGreaterThan(1);
    for (const c of chamadas) {
      expect(c.provider).toMatchObject({
        zdr: true,
        data_collection: 'deny',
        allow_fallbacks: false,
      });
      expect(c.provider.require_parameters).toBeUndefined();
      expect(c.saida).toBe('texto');
    }
  });

  it('erro que não é 429/5xx não roda a lista: 401 não repete, e falha de rede repete com os mesmos permitidos', async () => {
    const um = transporte([limite(401), ok]);
    await um.t.gerar(PEDIDO_4).catch(() => undefined);
    expect(um.chamadas).toHaveLength(1);

    const rede = transporte([falha(new Error('fetch failed')), ok]);
    await rede.t.gerar(PEDIDO_4);
    expect(rede.chamadas.map(onlyDe)).toEqual([PERMITIDOS, PERMITIDOS]);
  });

  it('com um provedor só não há para onde rodar: repete como antes, sempre com ele', async () => {
    const { t, chamadas } = transporte([limite()]);
    await t.gerar({ ...PEDIDO, provedoresPermitidos: ['alfa'] }).catch(() => undefined);

    expect(chamadas.map(onlyDe)).toEqual([['alfa'], ['alfa'], ['alfa']]);
  });
});
