import { describe, expect, it } from 'vitest';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
} from '../../src/domain/errors/index.js';
import type { EndpointZdr } from '../../src/infrastructure/adapters/modelo/endpointsZdr.js';
import { lerRespostaDaAnaliseDePeca } from '../../src/infrastructure/adapters/modelo/esquemaDaPeca.js';
import { ModeloComZdr } from '../../src/infrastructure/adapters/modelo/ModeloComZdr.js';
import { OpenRouterAnalisadorDePeca } from '../../src/infrastructure/adapters/modelo/OpenRouterAnalisadorDePeca.js';
import { TransporteOpenRouter } from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { LoggerColetor } from '../helpers/analiseIa.js';
import { respostaDaPeca } from '../helpers/analiseDePeca.js';
import { ClockFalso } from '../helpers/leitor.js';

const MODELO = 'fab/modelo-falso';
const CHAVE = 'sk-or-chave-de-teste-123456';
const SEGREDO = 'TEXTO-SECRETO-DA-PECA';
const LISTA: EndpointZdr[] = [
  { modelo: MODELO, provedor: 'Alfa', tag: 'alfa/fp8' },
  { modelo: MODELO, provedor: 'Beta', tag: 'beta' },
];

const json = (corpo: unknown): Response =>
  new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const corpoOk = (provider: string, conteudo: unknown = respostaDaPeca()): unknown => ({
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
  respostas: Array<() => Response> = [() => json(corpoOk('Alfa'))],
) {
  const corpos: Array<Record<string, unknown>> = [];
  let n = 0;
  const f = (async (_u: string, init: RequestInit) => {
    corpos.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const resposta = respostas[Math.min(n, respostas.length - 1)] ?? respostas[0]!;
    n += 1;
    return resposta();
  }) as unknown as typeof fetch;
  const modeloZdr = new ModeloComZdr({
    transporte: new TransporteOpenRouter({
      chave: CHAVE,
      fetch: f,
      esperasEntreTentativasMs: [0, 0],
      dormir: async () => {},
    }),
    modelo: MODELO,
    buscarListaZdr: lista,
    clock: new ClockFalso(),
    logger: new LoggerColetor(),
  });
  return {
    analisador: new OpenRouterAnalisadorDePeca({
      modeloZdr,
      maxTokens: 2500,
      timeoutMs: 120000,
    }),
    corpos,
  };
}

const PEDIDO = { sistema: 'sistema', usuario: `peça: ${SEGREDO}` };

describe('esquema fechado da análise de peça', () => {
  it('aceita a resposta perfeita e preenche listas ausentes com vazio', () => {
    expect(lerRespostaDaAnaliseDePeca(respostaDaPeca())).toBeDefined();
    const minima = lerRespostaDaAnaliseDePeca({
      tipo_da_peca: 'outro',
      em_uma_frase: 'Peça.',
    });
    expect(minima?.pedidos).toEqual([]);
    expect(minima?.pontos_de_atencao).toEqual([]);
  });

  it.each([
    ['campo a mais', { ...respostaDaPeca(), parecer: 'x' }],
    ['tipo desconhecido', { ...respostaDaPeca(), tipo_da_peca: 'parecer' }],
    ['sem a frase única', { ...respostaDaPeca(), em_uma_frase: undefined }],
    [
      'frase acima de 200 caracteres',
      { ...respostaDaPeca(), em_uma_frase: 'x'.repeat(201) },
    ],
    [
      'seis pedidos (o limite de produção é 5)',
      {
        ...respostaDaPeca(),
        pedidos: Array.from({ length: 6 }, () => respostaDaPeca().pedidos[0]),
      },
    ],
    [
      'texto de pedido acima de 160',
      {
        ...respostaDaPeca(),
        pedidos: [{ ...respostaDaPeca().pedidos[0], texto: 'x'.repeat(161) }],
      },
    ],
    [
      'código de atenção fora da lista',
      { ...respostaDaPeca(), pontos_de_atencao: ['inventado'] },
    ],
    [
      'página zero',
      {
        ...respostaDaPeca(),
        documentos_citados: [{ nome_como_escrito: 'Doc. 1', pagina: 0 }],
      },
    ],
  ])('recusa: %s', (_nome, bruto) => {
    expect(lerRespostaDaAnaliseDePeca(bruto)).toBeUndefined();
  });
});

describe('OpenRouterAnalisadorDePeca', () => {
  it('sai com as travas ZDR e o formato da peça em texto', async () => {
    const m = montar();
    const r = await m.analisador.analisar(PEDIDO);
    const corpo = m.corpos[0]!;
    expect(corpo['provider']).toMatchObject({
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: false,
      only: ['alfa', 'beta'],
    });
    expect(corpo['max_tokens']).toBe(2500);
    expect(corpo).not.toHaveProperty('response_format');
    expect(JSON.stringify(corpo['messages'])).toContain('em_uma_frase');
    expect(r.provedor).toBe('Alfa');
    expect(r.resposta.pedidos).toHaveLength(1);
  });

  it('lista ZDR inalcançável: falha fechada, nenhuma chamada ao modelo', async () => {
    const m = montar(async () => {
      throw new Error('sem rede');
    });
    await expect(m.analisador.analisar(PEDIDO)).rejects.toBeInstanceOf(
      ProviderIndisponivelError,
    );
    expect(m.corpos).toHaveLength(0);
  });

  it('resposta de provedor fora do conjunto ZDR é descartada', async () => {
    const m = montar(undefined, [() => json(corpoOk('Intruso'))]);
    await expect(m.analisador.analisar(PEDIDO)).rejects.toBeInstanceOf(
      ProviderIndisponivelError,
    );
  });

  it('fora do esquema: UMA repetição (de novo com ZDR) e, se persistir, erro sem texto de peça', async () => {
    const m = montar(undefined, [() => json(corpoOk('Alfa', { tipo_da_peca: 'x' }))]);
    const erro = await m.analisador.analisar(PEDIDO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(RespostaInvalidaError);
    expect(m.corpos).toHaveLength(2);
    for (const c of m.corpos) {
      expect(c['provider']).toMatchObject({
        zdr: true,
        data_collection: 'deny',
        allow_fallbacks: false,
      });
    }
    expect(String((erro as Error).message)).not.toContain(SEGREDO);
    expect(String((erro as Error).message)).not.toContain(CHAVE);
  });

  it('fora do esquema na primeira e certo na segunda: devolve a segunda', async () => {
    const m = montar(undefined, [
      () => json(corpoOk('Alfa', { tipo_da_peca: 'x' })),
      () => json(corpoOk('Alfa')),
    ]);
    const r = await m.analisador.analisar(PEDIDO);
    expect(r.resposta.tipo_da_peca).toBe('peticao_inicial');
    expect(m.corpos).toHaveLength(2);
  });
});

describe('esquema da análise de peça: determinações (0.56.1)', () => {
  it('aceita a determinação com prazo literal e tolera os códigos antigos de fato do sistema', () => {
    const r = lerRespostaDaAnaliseDePeca({
      ...respostaDaPeca(),
      tipo_da_peca: 'despacho',
      determinacoes: [
        {
          quem: 'Estado',
          texto: 'Determina que individualize a conta',
          prazo_escrito: '10 (dez) dias',
          trecho: 'individualize a conta',
          pagina: 1,
        },
      ],
      pontos_de_atencao: ['peca_longa_demais_para_leitura_completa'],
    });
    expect(r?.determinacoes?.[0]?.prazo_escrito).toBe('10 (dez) dias');
  });

  it('recusa campo a mais e mais de cinco determinações', () => {
    const d = {
      quem: 'A',
      texto: 'Manda x',
      prazo_escrito: null,
      trecho: 'trecho',
      pagina: 1,
    };
    expect(
      lerRespostaDaAnaliseDePeca({
        ...respostaDaPeca(),
        determinacoes: [{ ...d, data: 'x' }],
      }),
    ).toBeUndefined();
    expect(
      lerRespostaDaAnaliseDePeca({
        ...respostaDaPeca(),
        determinacoes: Array(6).fill(d),
      }),
    ).toBeUndefined();
  });
});
