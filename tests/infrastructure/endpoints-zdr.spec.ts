import { describe, expect, it } from 'vitest';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
} from '../../src/domain/errors/index.js';
import {
  buscarEndpointsZdr,
  lerListaZdr,
  lerModelosPublicos,
  modeloTemZdr,
  modelosComZdr,
  precosEstimados,
  provedorConfirmadoZdr,
} from '../../src/infrastructure/adapters/modelo/endpointsZdr.js';
import {
  HttpClient,
  type RespostaHttp,
} from '../../src/infrastructure/http/HttpClient.js';

/* Lista SINTÉTICA no formato descrito na referência da API (campos reais não capturados). */
const CORPO = {
  data: [
    {
      name: 'Provedor Alfa | fab/modelo-grande',
      model_id: 'fab/modelo-grande',
      model_name: 'Modelo Grande',
      provider_name: 'Provedor Alfa',
      tag: 'alfa',
      pricing: { prompt: '0.000003', completion: '0.000015' },
      context_length: 1000,
    },
    {
      name: 'Amazon Bedrock | fab/modelo-grande',
      model_id: 'fab/modelo-grande',
      provider_name: 'Amazon Bedrock',
      tag: 'amazon-bedrock/us',
      pricing: { prompt: '0.000004', completion: '0.00002' },
    },
    { model_id: 'fab/modelo-pequeno', provider_name: 'Provedor Beta', tag: 'beta' },
    { model_id: 'outra/coisa', provider_name: 'Provedor Gama', tag: 'gama' },
    { model_id: 'sem/provedor' },
  ],
};

describe('lista de endpoints ZDR', () => {
  const lista = lerListaZdr(CORPO);

  it('lê modelo, provedor, tag e preço; ignora item sem modelo ou sem provedor', () => {
    expect(lista.itensRecebidos).toBe(5);
    expect(lista.endpoints).toHaveLength(4);
    expect(lista.endpoints[0]).toMatchObject({
      modelo: 'fab/modelo-grande',
      provedor: 'Provedor Alfa',
      precoEntrada: 0.000003,
    });
  });

  it('lista os modelos com ao menos um endpoint ZDR, sem repetir, com filtro por texto', () => {
    expect(modelosComZdr(lista.endpoints)).toEqual([
      'fab/modelo-grande',
      'fab/modelo-pequeno',
      'outra/coisa',
    ]);
    expect(modelosComZdr(lista.endpoints, 'MODELO')).toEqual([
      'fab/modelo-grande',
      'fab/modelo-pequeno',
    ]);
    expect(modelosComZdr(lista.endpoints, 'zzz')).toEqual([]);
  });

  it('modeloTemZdr: só o id exato', () => {
    expect(modeloTemZdr(lista.endpoints, 'fab/modelo-grande')).toBe(true);
    expect(modeloTemZdr(lista.endpoints, 'fab/modelo')).toBe(false);
    expect(modeloTemZdr(lista.endpoints, 'sem/provedor')).toBe(false);
  });

  it.each([
    ['nome igual', 'Provedor Alfa', true],
    ['sem caixa nem pontuação', 'provedor-alfa', true],
    ['pelo nome com espaço', 'Amazon Bedrock', true],
    ['pelo trecho da tag antes da barra', 'amazon-bedrock', true],
    ['provedor de OUTRO modelo', 'Provedor Beta', false],
    ['provedor desconhecido', 'Provedor Zeta', false],
    ['vazio', '', false],
    ['ausente', undefined, false],
  ])('provedor servido (%s)', (_n, provedor, esperado) => {
    expect(provedorConfirmadoZdr(lista.endpoints, 'fab/modelo-grande', provedor)).toBe(
      esperado,
    );
  });

  it('o preço estimado é o MAIOR entre os endpoints do modelo', () => {
    expect(precosEstimados(lista.endpoints).get('fab/modelo-grande')).toEqual({
      entrada: 0.000004,
      saida: 0.00002,
    });
    expect(precosEstimados(lista.endpoints).has('fab/modelo-pequeno')).toBe(false);
  });

  it('formato inesperado é erro de resposta inválida; campos desconhecidos viram diagnóstico só de NOMES', () => {
    expect(() => lerListaZdr({ items: [] })).toThrow(RespostaInvalidaError);
    const l = lerListaZdr({ data: [{ identificador: 'x', fornecedor: 'y' }] });
    expect(l.endpoints).toHaveLength(0);
    expect(l.camposDoPrimeiroItem).toEqual(['fornecedor', 'identificador']);
  });

  it('lista pública de modelos: id e preço de entrada', () => {
    expect(
      lerModelosPublicos({
        data: [{ id: 'a/b', pricing: { prompt: '0.000001' } }, { id: 'c/d' }],
      }),
    ).toEqual([{ id: 'a/b', precoEntrada: 0.000001 }, { id: 'c/d' }]);
  });
});

class HttpDublado extends HttpClient {
  readonly pedidos: Array<{ url: string; headers: Record<string, string> }> = [];
  constructor(private readonly resposta: () => RespostaHttp) {
    super();
  }
  override async get(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<RespostaHttp> {
    this.pedidos.push({ url, headers });
    return this.resposta();
  }
}

describe('buscarEndpointsZdr', () => {
  const CHAVE = 'sk-or-chave-de-teste-123456';

  it('envia a chave como Bearer à rota de endpoints ZDR e valida a resposta', async () => {
    const http = new HttpDublado(() => ({
      status: 200,
      ok: true,
      corpo: JSON.stringify(CORPO),
    }));
    const r = await buscarEndpointsZdr(http, CHAVE);
    expect(r.endpoints).toHaveLength(4);
    expect(http.pedidos).toEqual([
      {
        url: 'https://openrouter.ai/api/v1/endpoints/zdr',
        headers: { authorization: `Bearer ${CHAVE}` },
      },
    ]);
  });

  it.each([401, 403])(
    'HTTP %i: diz que a chave foi recusada, sem repeti-la',
    async (status) => {
      const http = new HttpDublado(() => ({
        status,
        ok: false,
        corpo: `erro com ${CHAVE}`,
      }));
      const erro = await buscarEndpointsZdr(http, CHAVE).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ProviderIndisponivelError);
      expect((erro as Error).message).toMatch(/recusada/);
      expect((erro as Error).message).not.toContain(CHAVE);
    },
  );

  it('falha de rede vira mensagem fixa, sem a causa (que poderia trazer a chave)', async () => {
    class Quebrado extends HttpClient {
      override async get(): Promise<RespostaHttp> {
        throw new Error(`falhou com ${CHAVE}`);
      }
    }
    const erro = await buscarEndpointsZdr(new Quebrado(), CHAVE).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProviderIndisponivelError);
    expect((erro as Error).message).not.toContain(CHAVE);
  });

  it('corpo que não é JSON é resposta inválida', async () => {
    const http = new HttpDublado(() => ({ status: 200, ok: true, corpo: '<html>' }));
    await expect(buscarEndpointsZdr(http, CHAVE)).rejects.toBeInstanceOf(
      RespostaInvalidaError,
    );
  });
});
