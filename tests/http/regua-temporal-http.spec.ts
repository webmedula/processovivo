import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Peca } from '../../src/domain/entities/Peca.js';
import type { ConteudoPeca } from '../../src/domain/entities/Peca.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import type {
  AtosDoProcesso,
  ProvedorDePecas,
} from '../../src/domain/ports/ProvedorDePecas.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Config } from '../../src/infrastructure/config/env.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';

const CHAVE = 'chave-de-teste-1234567890';
const PROCESSO = '5818922-04.2026.8.09.0011';
const cabecalhos = { 'x-api-key': CHAVE };

function config(): Config {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: CHAVE,
    CACHE_ENABLED: 'false',
  } as NodeJS.ProcessEnv);
}

function movimento(
  dia: string,
  titulo: string,
  id: number,
  codigoTpu?: number,
): Movimentacao {
  return {
    data: new Date(dia),
    titulo,
    idExterno: `mni:${id}`,
    fonte: 'mni',
    ...(codigoTpu !== undefined ? { codigoTpu } : {}),
  };
}

/**
 * Uma fonte de peças que responde COM linha do tempo — o caso do MNI para quem
 * tem procuração nos autos.
 */
class TribunalFalso implements ProvedorDePecas {
  readonly nome = 'mni-falso';
  readonly tribunais = ['TJGO'];

  async listarAtos(): Promise<AtosDoProcesso> {
    return {
      movimentos: [
        movimento('2026-09-14T09:30:00', 'Juntada de Petição de Contestação', 100, 581),
        movimento('2026-03-03T14:15:00', 'Decisão', 90, 219),
        movimento('2026-02-01T08:00:00', 'Expedição de certidão', 80, 60),
        movimento('2026-01-10T08:00:00', 'Conclusão para decisão', 70, 12265),
      ],
      pecas: [
        new Peca({
          id: 'doc-1',
          tipo: '57',
          descricao: 'Contestação',
          mimetype: 'application/pdf',
          movimento: 100,
        }),
        new Peca({
          id: 'doc-2',
          tipo: '0',
          descricao: 'Outros',
          mimetype: 'application/pdf',
          movimento: 100,
        }),
      ],
    };
  }

  async listarPecas(): Promise<Peca[]> {
    return [...(await this.listarAtos()).pecas];
  }

  async obterConteudo(): Promise<ConteudoPeca> {
    return {
      id: 'doc-1',
      mimetype: 'application/pdf',
      nomeArquivo: 'peca.pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    };
  }
}

/** Uma fonte SEM linha do tempo — o contrato antigo da porta, ainda válido. */
class SoPecas implements ProvedorDePecas {
  readonly nome = 'so-pecas';
  readonly tribunais = ['TJGO'];

  async listarPecas(): Promise<Peca[]> {
    return [
      new Peca({
        id: 'doc-9',
        tipo: '57',
        descricao: 'Petição',
        mimetype: 'application/pdf',
      }),
    ];
  }

  async obterConteudo(): Promise<ConteudoPeca> {
    return {
      id: 'doc-9',
      mimetype: 'application/pdf',
      nomeArquivo: 'peca.pdf',
      bytes: new Uint8Array([0x25]),
    };
  }
}

async function comCredencial(servidor: FastifyInstance): Promise<void> {
  const r = await servidor.inject({
    method: 'PUT',
    url: '/v1/credenciais',
    headers: cabecalhos,
    payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
  });
  expect(r.statusCode).toBe(201);
}

function montar(provedor: ProvedorDePecas): {
  app: Aplicacao;
  servidor: FastifyInstance;
} {
  const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    provedorDePecas: provedor,
  });
  return { app, servidor: construirServidor(app, config()) };
}

/** O MNI de quem tem procuração: além das peças, o cabeçalho com as partes dos autos (v0.73.0). */
class TribunalComPartes extends TribunalFalso {
  override async listarAtos(): Promise<AtosDoProcesso> {
    const base = await super.listarAtos();
    return {
      ...base,
      partes: [
        {
          nome: 'BANCO INVENTADO S.A',
          polo: 'ATIVO',
          tipoPessoa: 'JURIDICA',
          // Simula um adaptador descuidado: o que não é do contrato da rota não pode sair.
          documento: '00000000000191',
          advogados: [{ nome: 'ADVOGADA FICTICIA', oab: '99999', ufOab: 'GO' }],
        },
        { nome: 'FULANO DE TESTE', polo: 'PASSIVO', tipoPessoa: 'FISICA', advogados: [] },
      ],
    };
  }
}

describe('API — a régua temporal', () => {
  let servidor: FastifyInstance;

  afterEach(async () => {
    await servidor.close();
  });

  it('cada evento entrega os documentos daquele ato', async () => {
    /*
     * O contrato que a tela consome. Antes a resposta era uma lista de peças
     * sem relação com a linha do tempo, e o advogado tinha de casar as duas
     * coisas na cabeça — lendo a data no andamento e caçando o arquivo no
     * rodapé, no meio de 278.
     */
    servidor = montar(new TribunalFalso()).servidor;
    await comCredencial(servidor);

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });

    expect(r.statusCode).toBe(200);
    const linha = r.json().linhaDoTempo;
    expect(linha.resumo.espinha).toBe('tribunal');
    expect(linha.resumo.pecasAcopladas).toBe(2);

    const juntada = linha.eventos.find((e: { titulo: string }) =>
      e.titulo.startsWith('Juntada'),
    );
    expect(juntada.pecas.map((p: { id: string }) => p.id)).toEqual(['doc-1', 'doc-2']);
    expect(linha.pecasSoltas).toEqual([]);
  });

  it('a decisão sai marcada, e a juntada que entrega documento não vira ruído', async () => {
    // Os dois ajustes visuais que o advogado pediu, no mesmo lugar: o
    // pronunciamento do juízo salta, e o filtro de ruído não pode levar embora
    // a petição da outra parte só porque o título começa com "Juntada".
    servidor = montar(new TribunalFalso()).servidor;
    await comCredencial(servidor);

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });
    const eventos = r.json().linhaDoTempo.eventos as Array<{
      titulo: string;
      ehDecisao: boolean;
      ehRuido: boolean;
    }>;

    expect(eventos.find((e) => e.titulo === 'Decisão')?.ehDecisao).toBe(true);
    expect(eventos.find((e) => e.titulo.startsWith('Juntada'))?.ehRuido).toBe(false);
    // Expedição e conclusão são cartório reconhecido: esses, sim, o filtro tira.
    // (A régua também traz os andamentos das fontes públicas, que entram na
    // mesma triagem — por isso a asserção é de pertinência, não de igualdade.)
    const ruido = eventos.filter((e) => e.ehRuido).map((e) => e.titulo);
    expect(ruido).toContain('Conclusão para decisão');
    expect(ruido).toContain('Expedição de certidão');
    expect(ruido).not.toContain('Decisão');
    expect(ruido.some((t) => t.startsWith('Juntada de Petição'))).toBe(false);
  });

  it('devolve as partes dos autos que vieram na mesma resposta, sem CPF/CNPJ', async () => {
    servidor = montar(new TribunalComPartes()).servidor;
    await comCredencial(servidor);

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().partes).toEqual([
      {
        nome: 'BANCO INVENTADO S.A',
        polo: 'ATIVO',
        tipoPessoa: 'JURIDICA',
        advogados: [{ nome: 'ADVOGADA FICTICIA', oab: '99999', ufOab: 'GO' }],
      },
      { nome: 'FULANO DE TESTE', polo: 'PASSIVO', tipoPessoa: 'FISICA', advogados: [] },
    ]);
    expect(r.body).not.toContain('00000000000191');
  });

  it('sem cabeçalho do tribunal, a lista de partes vem vazia (a tela fica com as que já tinha)', async () => {
    servidor = montar(new TribunalFalso()).servidor;
    await comCredencial(servidor);
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });
    expect(r.json().partes).toEqual([]);
  });

  it('fonte sem linha do tempo continua funcionando, e a régua avisa', async () => {
    /*
     * O contrato antigo da porta não quebrou: `listarAtos` é opcional. Sem ela,
     * a resposta degrada para o desenho anterior — peças na lista, espinha das
     * fontes públicas — em vez de devolver erro ou uma régua vazia, que
     * apagaria os andamentos da tela.
     */
    servidor = montar(new SoPecas()).servidor;
    await comCredencial(servidor);

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().linhaDoTempo.resumo.espinha).toBe('fontes-publicas');
    expect(r.json().linhaDoTempo.pecasSoltas).toHaveLength(1);
  });

  it('a lista de peças continua no contrato, para quem integra', async () => {
    // A rota é usada por integração (n8n). Trocar o formato por baixo dela sem
    // necessidade quebraria o que já roda na casa de quem assinou.
    servidor = montar(new TribunalFalso()).servidor;
    await comCredencial(servidor);

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });

    expect(r.json().total).toBe(2);
    expect(
      r
        .json()
        .pecas.map((p: { id: string }) => p.id)
        .sort(),
    ).toEqual(['doc-1', 'doc-2']);
  });
});
