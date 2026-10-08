import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Peca } from '../../src/domain/entities/Peca.js';
import type { ConteudoPeca } from '../../src/domain/entities/Peca.js';
import type { ProvedorDePecas } from '../../src/domain/ports/ProvedorDePecas.js';
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

class ProvedorFalsoDePecas implements ProvedorDePecas {
  readonly nome = 'mni-falso';
  readonly tribunais = ['TJGO'];
  chamadas = 0;

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
    this.chamadas += 1;
    return {
      id: 'doc-1',
      mimetype: 'application/pdf',
      nomeArquivo: 'contestacao.pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    };
  }
}

describe('painel', () => {
  let app: Aplicacao;
  let servidor: FastifyInstance;
  let provedor: ProvedorFalsoDePecas;

  beforeEach(() => {
    provedor = new ProvedorFalsoDePecas();
    app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
      provedorDePecas: provedor,
    });
    servidor = construirServidor(app, config());
  });
  afterEach(async () => {
    await servidor.close();
  });

  async function painel(): Promise<Record<string, never>> {
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/painel',
      headers: cabecalhos,
    });
    expect(r.statusCode).toBe(200);
    return r.json() as Record<string, never>;
  }

  async function baixar(): Promise<number> {
    const cred = await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: cabecalhos,
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
    expect(cred.statusCode).toBe(201);
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas/doc-1`,
      headers: cabecalhos,
    });
    return r.statusCode;
  }

  it('carteira vazia responde com zeros, não com erro', async () => {
    // A primeira tela que uma conta nova vê. Erro aqui, no minuto seguinte ao
    // cadastro, é o pior primeiro contato possível com o produto.
    const p = await painel();
    expect(p['cards']).toMatchObject({ ativos: 0, pedemProvidencia: 0, baixadasHoje: 0 });
    expect(p['pecasBaixadas']).toEqual([]);
  });

  it('o download fica registrado e aparece no painel', async () => {
    expect(await baixar()).toBe(200);

    const p = await painel();
    expect(p['cards']).toMatchObject({ baixadasHoje: 1 });
    const lista = p['pecasBaixadas'] as unknown as Array<Record<string, unknown>>;
    expect(lista).toHaveLength(1);
    expect(lista[0]?.['rotulo']).toBe('contestacao.pdf');
    expect(lista[0]?.['bytes']).toBe(5);
  });

  it('o registro da peça AVULSA guarda metadado, nunca o arquivo', async () => {
    /*
     * A regra mudou na v0.30.0, por decisão do dono (29/09/2026), e mudou só
     * para o PDF COMBINADO do leitor: esse fica em disco, por workspace, com
     * prazo de guarda, cota e limpeza (ver `tests/http/leitor.spec.ts` e o
     * CLAUDE.md §8). O download avulso continua como era — vai do tribunal
     * direto para a máquina do advogado, e o registro dele é só metadado.
     *
     * Este teste fixa as chaves para que nenhum campo de conteúdo ou de
     * caminho em disco entre aqui por descuido: são autos de processo, muitos
     * em segredo de justiça.
     */
    await baixar();
    const lista = (await painel())['pecasBaixadas'] as unknown as Array<
      Record<string, unknown>
    >;
    expect(Object.keys(lista[0] ?? {}).sort()).toEqual([
      'baixadaEm',
      'bytes',
      'idPeca',
      'mimetype',
      'numero',
      'rotulo',
    ]);
  });

  it('a régua diz o que já foi baixado, para não repetir consulta cara', async () => {
    /*
     * O motivo não é estético. Baixar uma peça custa dezenas de segundos e uma
     * requisição que carrega a senha do advogado, contando para o bloqueio da
     * conta dele no tribunal. Quem não lembra se já puxou a contestação clica
     * de novo e paga tudo outra vez.
     */
    await baixar();
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });
    expect(r.json().jaBaixadas).toEqual(['doc-1']);
  });

  it('baixar duas vezes são dois registros, e um id só na régua', async () => {
    // O histórico é log — "puxei de novo na semana passada" é informação. A
    // marca da régua é sobre existência, e aí a repetição não importa.
    await baixar();
    await baixar();
    expect((await painel())['cards']).toMatchObject({ baixadasHoje: 2 });

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });
    expect(r.json().jaBaixadas).toEqual(['doc-1']);
  });

  it('o painel conta processo ativo e diz quando foi verificado', async () => {
    await servidor.inject({
      method: 'POST',
      url: '/v1/acompanhamentos',
      headers: cabecalhos,
      payload: { numero: PROCESSO },
    });

    const p = await painel();
    expect(p['cards']).toMatchObject({ ativos: 1, totalPastas: 1 });
    // A hora da última verificação é o número que decide se dá para confiar na
    // tela — vem antes dos cards, e por isso é testada junto com eles.
    expect((p['verificacao'] as unknown as Record<string, unknown>)['ultimaEm']).toEqual(
      expect.any(String),
    );
  });

  it('a verificação do painel é DA CONTA: sem processo pendente dela, não há "andamento" nem "demorando" (v0.37.3)', async () => {
    const v = (await painel())['verificacao'] as unknown as Record<string, unknown>;
    expect(v).toMatchObject({ emAndamento: false, pendentes: 0, desde: null, demorando: false });
  });

  it('o painel NÃO promete prazo', async () => {
    /*
     * A referência visual que originou esta tela trazia "Prazos em 48h", e não
     * há prazo cadastrado em lugar nenhum do sistema. O card fala de
     * providência, que é o ato que ABRE um prazo — coisa diferente. Este teste
     * existe para que a palavra não entre no contrato por descuido.
     */
    const p = await painel();
    expect(Object.keys(p['cards'] as unknown as object).sort()).toEqual([
      'ativos',
      'baixadasHoje',
      'pedemProvidencia',
      // A janela de dias do selo — um recorte do que olhar primeiro, não um prazo.
      'pendenciaJanelaDias',
      'totalPastas',
    ]);
  });

  it('o card diz a janela de pendência configurada — a mesma do selo da carteira', async () => {
    const outro = construirServidor(
      aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })]),
      carregarConfig({
        PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
        LOG_LEVEL: 'silent',
        PROCESSOVIVO_API_KEYS: CHAVE,
        CACHE_ENABLED: 'false',
        PENDENCIA_JANELA_DIAS: '7',
      } as NodeJS.ProcessEnv),
    );
    try {
      const r = await outro.inject({
        method: 'GET',
        url: '/v1/painel',
        headers: cabecalhos,
      });
      expect(
        (r.json() as { cards: { pendenciaJanelaDias: number } }).cards
          .pendenciaJanelaDias,
      ).toBe(7);
      expect((await painel()).cards).toMatchObject({ pendenciaJanelaDias: 10 });
    } finally {
      await outro.close();
    }
  });
});
