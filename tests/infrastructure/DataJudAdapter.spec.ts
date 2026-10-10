import { describe, expect, it } from 'vitest';
import { DataJudAdapter } from '../../src/infrastructure/adapters/datajud/DataJudAdapter.js';
import {
  OperacaoNaoSuportadaError,
  ProcessoNaoEncontradoError,
  ProviderIndisponivelError,
  RespostaInvalidaError,
} from '../../src/domain/errors/index.js';
import {
  HttpClient,
  HttpTimeoutError,
} from '../../src/infrastructure/http/HttpClient.js';
import type { RespostaHttp } from '../../src/infrastructure/http/HttpClient.js';
import type { RateLimiter } from '../../src/infrastructure/ratelimit/TokenBucketRateLimiter.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';

/** Dublê do HttpClient: nenhum teste desta suíte toca a rede. */
class HttpClientFalso extends HttpClient {
  readonly requisicoes: Array<{
    url: string;
    corpo: unknown;
    headers: Record<string, string>;
  }> = [];

  constructor(
    private readonly responder: (url: string) => Promise<RespostaHttp> | RespostaHttp,
  ) {
    super();
  }

  override async postJson(
    url: string,
    corpo: unknown,
    headers: Record<string, string> = {},
  ): Promise<RespostaHttp> {
    this.requisicoes.push({ url, corpo, headers });
    return this.responder(url);
  }
}

const limitadorPermissivo: RateLimiter = {
  adquirir: async () => {},
  tentarAdquirir: () => true,
};

function ok(payload: unknown): RespostaHttp {
  return { status: 200, ok: true, corpo: JSON.stringify(payload) };
}

const RESPOSTA_COM_UM_PROCESSO = {
  hits: {
    total: { value: 1, relation: 'eq' },
    hits: [
      {
        _id: 'abc',
        _source: {
          numeroProcesso: '12345674720238260100',
          tribunal: 'TJSP',
          grau: 'G1',
          dataAjuizamento: '2023-03-14T09:12:00.000Z',
          nivelSigilo: 0,
          classe: { codigo: 7, nome: 'Procedimento Comum Cível' },
          assuntos: [
            { codigo: 10433, nome: 'Rescisão do Contrato e Devolução do Dinheiro' },
            { codigo: 10432, nome: 'Indenização por Dano Moral' },
          ],
          orgaoJulgador: { codigo: 100, nome: '12ª Vara Cível' },
          movimentos: [
            {
              codigo: 26,
              nome: 'Distribuição',
              dataHora: '2023-03-14T09:12:00.000Z',
              complementosTabelados: [{ codigo: 2, nome: 'por sorteio' }],
            },
            { codigo: 51, nome: 'Conclusão', dataHora: '2024-11-08T14:03:00.000Z' },
          ],
        },
      },
    ],
  },
};

function adapter(responder: (url: string) => Promise<RespostaHttp> | RespostaHttp): {
  instancia: DataJudAdapter;
  http: HttpClientFalso;
} {
  const http = new HttpClientFalso(responder);
  const instancia = new DataJudAdapter({
    apiKey: 'chave-de-teste',
    httpClient: http,
    rateLimiter: limitadorPermissivo,
  });
  return { instancia, http };
}

describe('DataJudAdapter', () => {
  it('exige chave pública na construção', () => {
    expect(() => new DataJudAdapter({ apiKey: '  ' })).toThrow(/chave pública/);
  });

  it('monta a URL com o alias do tribunal deduzido do número CNJ', async () => {
    const { instancia, http } = adapter(() => ok(RESPOSTA_COM_UM_PROCESSO));
    await instancia.buscarPorNumero(NUMERO_TJSP_A);

    expect(http.requisicoes[0]?.url).toBe(
      'https://api-publica.datajud.cnj.jus.br/api_publica_tjsp/_search',
    );
  });

  it('envia o header Authorization no formato "APIKey <chave>"', async () => {
    const { instancia, http } = adapter(() => ok(RESPOSTA_COM_UM_PROCESSO));
    await instancia.buscarPorNumero(NUMERO_TJSP_A);

    expect(http.requisicoes[0]?.headers['Authorization']).toBe('APIKey chave-de-teste');
  });

  it('consulta pelo número SEM máscara, que é como o índice guarda', async () => {
    const { instancia, http } = adapter(() => ok(RESPOSTA_COM_UM_PROCESSO));
    await instancia.buscarPorNumero(NUMERO_TJSP_A);

    expect(http.requisicoes[0]?.corpo).toMatchObject({
      query: { match: { numeroProcesso: '12345674720238260100' } },
    });
  });

  it('mapeia o payload do CNJ para o modelo unificado', async () => {
    const { instancia } = adapter(() => ok(RESPOSTA_COM_UM_PROCESSO));
    const processo = await instancia.buscarPorNumero(NUMERO_TJSP_A);

    expect(processo.numero.formatado).toBe(NUMERO_TJSP_A);
    expect(processo.tribunal).toBe('TJSP');
    expect(processo.vara).toBe('12ª Vara Cível');
    expect(processo.classe).toBe('Procedimento Comum Cível');
    expect(processo.assunto).toBe('Rescisão do Contrato e Devolução do Dinheiro');
    expect(processo.assuntos).toHaveLength(2);
    expect(processo.dataDistribuicao?.toISOString()).toBe('2023-03-14T09:12:00.000Z');
    expect(processo.segredoJustica).toBe(false);
    expect(processo.procedencia.provider).toBe('datajud');
  });

  it('ordena as movimentações da mais recente para a mais antiga', async () => {
    const { instancia } = adapter(() => ok(RESPOSTA_COM_UM_PROCESSO));
    const processo = await instancia.buscarPorNumero(NUMERO_TJSP_A);

    expect(processo.movimentacoes.map((m) => m.titulo)).toEqual([
      'Conclusão',
      'Distribuição',
    ]);
    expect(processo.ultimaMovimentacao?.titulo).toBe('Conclusão');
  });

  it('devolve partes vazias — a base do CNJ não indexa partes nem advogados', async () => {
    const { instancia } = adapter(() => ok(RESPOSTA_COM_UM_PROCESSO));
    const processo = await instancia.buscarPorNumero(NUMERO_TJSP_A);

    expect(processo.partes).toEqual([]);
    expect(processo.temDetalhamento).toBe(false);
    expect(instancia.capacidades.retornaPartes).toBe(false);
  });

  it('não traz o inteiro teor dos despachos, apenas o rótulo da TPU', async () => {
    const { instancia } = adapter(() => ok(RESPOSTA_COM_UM_PROCESSO));
    const processo = await instancia.buscarPorNumero(NUMERO_TJSP_A);

    expect(processo.movimentacoes.every((m) => m.conteudo === undefined)).toBe(true);
    expect(processo.movimentacoes.at(-1)?.codigoTpu).toBe(26);
    expect(processo.movimentacoes.at(-1)?.complementos).toEqual(['por sorteio']);
  });

  it('marca segredo de justiça quando nivelSigilo > 0', async () => {
    const { instancia } = adapter(() =>
      ok({
        hits: {
          hits: [
            {
              _source: {
                numeroProcesso: '12345674720238260100',
                tribunal: 'TJSP',
                nivelSigilo: 3,
              },
            },
          ],
        },
      }),
    );

    const processo = await instancia.buscarPorNumero(NUMERO_TJSP_A);
    expect(processo.segredoJustica).toBe(true);
  });

  it('lança ProcessoNaoEncontradoError quando a busca retorna zero hits', async () => {
    const { instancia } = adapter(() => ok({ hits: { total: { value: 0 }, hits: [] } }));

    await expect(instancia.buscarPorNumero(NUMERO_TJSP_A)).rejects.toBeInstanceOf(
      ProcessoNaoEncontradoError,
    );
  });

  it('trata 401/403 como indisponibilidade, com a causa explícita', async () => {
    const { instancia } = adapter(() => ({ status: 401, ok: false, corpo: '' }));

    await expect(instancia.buscarPorNumero(NUMERO_TJSP_A)).rejects.toThrow(
      /chave pública rejeitada/,
    );
  });

  it('trata 429 como indisponibilidade por limite de requisições', async () => {
    const { instancia } = adapter(() => ({ status: 429, ok: false, corpo: '' }));

    await expect(instancia.buscarPorNumero(NUMERO_TJSP_A)).rejects.toThrow(
      /limite de requisições/,
    );
  });

  it('converte timeout de rede em ProviderIndisponivelError', async () => {
    const { instancia } = adapter(() => {
      throw new HttpTimeoutError('http://exemplo', 8000);
    });

    const erro = await instancia.buscarPorNumero(NUMERO_TJSP_A).catch((e) => e);
    expect(erro).toBeInstanceOf(ProviderIndisponivelError);
    expect(erro.message).toContain('timeout');
  });

  it('rejeita payload fora do contrato em vez de deixar undefined circular', async () => {
    const { instancia } = adapter(() => ok({ resultado: 'formato novo e inesperado' }));

    await expect(instancia.buscarPorNumero(NUMERO_TJSP_A)).rejects.toBeInstanceOf(
      RespostaInvalidaError,
    );
  });

  it('rejeita corpo que não é JSON', async () => {
    const { instancia } = adapter(() => ({
      status: 200,
      ok: true,
      corpo: '<html>manutenção</html>',
    }));

    await expect(instancia.buscarPorNumero(NUMERO_TJSP_A)).rejects.toBeInstanceOf(
      RespostaInvalidaError,
    );
  });

  it('ignora campos novos do CNJ em vez de quebrar a consulta', async () => {
    const { instancia } = adapter(() =>
      ok({
        hits: {
          hits: [
            {
              _source: {
                numeroProcesso: '12345674720238260100',
                tribunal: 'TJSP',
                campoQueOCnjInventouOntem: { alguma: 'coisa' },
              },
            },
          ],
        },
        metadadoNovo: true,
      }),
    );

    await expect(instancia.buscarPorNumero(NUMERO_TJSP_A)).resolves.toBeDefined();
  });

  it('recusa tribunal fora da lista suportada antes de ir à rede', async () => {
    const { instancia, http } = adapter(() => ok(RESPOSTA_COM_UM_PROCESSO));
    /*
     * Segmento 9 não existe na Resolução 65 do CNJ, e por isso serve de exemplo
     * estável de "tribunal que não dá para consultar".
     *
     * Este teste usava a Justiça do Trabalho (segmento 5) como exemplo, até ela
     * passar a ser suportada. Trocar por um segmento inexistente deixa o teste
     * medindo o que ele sempre quis medir — recusar ANTES de ir à rede, em vez
     * de montar um endereço chutado e receber 404 — sem precisar de conserto no
     * dia em que a cobertura crescer de novo.
     */
    const numeroDeSegmentoInexistente = comDigitoValido(
      '0001234',
      '2023',
      '9',
      '99',
      '0001',
    );

    await expect(
      instancia.buscarPorNumero(numeroDeSegmentoInexistente),
    ).rejects.toBeInstanceOf(OperacaoNaoSuportadaError);
    expect(http.requisicoes).toHaveLength(0);
  });

  it('monta o endereço do tribunal trabalhista a partir do número', async () => {
    const { instancia, http } = adapter(() => ok(RESPOSTA_COM_UM_PROCESSO));
    // TRT18 (Goiás), o mesmo tribunal do número real que motivou a cobertura.
    const trabalhista = comDigitoValido('0011242', '2021', '5', '18', '0016');

    await instancia.buscarPorNumero(trabalhista).catch(() => undefined);

    expect(http.requisicoes).toHaveLength(1);
    expect(http.requisicoes[0]?.url).toContain('api_publica_trt18');
  });

  it('declara e cumpre a limitação de não buscar por OAB', async () => {
    const { instancia, http } = adapter(() => ok(RESPOSTA_COM_UM_PROCESSO));

    expect(instancia.capacidades.buscarPorOab).toBe(false);
    await expect(instancia.buscarPorOab('234567', 'SP')).rejects.toBeInstanceOf(
      OperacaoNaoSuportadaError,
    );
    expect(http.requisicoes).toHaveLength(0);
  });

  it('healthCheck devolve false em vez de lançar quando a API cai', async () => {
    const { instancia } = adapter(() => {
      throw new Error('ECONNREFUSED');
    });

    await expect(instancia.healthCheck()).resolves.toBe(false);
  });

  it('respeita o rate limiter antes de cada consulta', async () => {
    let adquiridos = 0;
    const http = new HttpClientFalso(() => ok(RESPOSTA_COM_UM_PROCESSO));
    const instancia = new DataJudAdapter({
      apiKey: 'k',
      httpClient: http,
      rateLimiter: {
        adquirir: async () => {
          adquiridos++;
        },
        tentarAdquirir: () => true,
      },
    });

    await instancia.buscarPorNumero(NUMERO_TJSP_A);
    await instancia.buscarPorNumero(NUMERO_TJSP_A);

    expect(adquiridos).toBe(2);
  });
});

function comDigitoValido(
  sequencial: string,
  ano: string,
  segmento: string,
  tribunal: string,
  origem: string,
): string {
  const base = BigInt(`${sequencial}${ano}${segmento}${tribunal}${origem}00`);
  const dv = String(98n - (base % 97n)).padStart(2, '0');
  return `${sequencial}${dv}${ano}${segmento}${tribunal}${origem}`;
}
