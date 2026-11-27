import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Peca } from '../../src/domain/entities/Peca.js';
import type { ConteudoPeca } from '../../src/domain/entities/Peca.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import type {
  AtosDoProcesso,
  ProvedorDePecas,
} from '../../src/domain/ports/ProvedorDePecas.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';

/*
 * v0.71.0: as colunas "Partes" da carteira (Meus processos) e das Atualizações usam as partes
 * dos AUTOS quando a conta já carregou as peças do processo, e as do Diário até lá. O caso
 * real: cumprimento de sentença em que o Diário só trazia o exequente intimado e o executado
 * sumia da lista. Nomes SINTÉTICOS (repositório público).
 */
const CHAVE_A = 'chave-de-teste-partes-aaaaaaaa';
const CHAVE_B = 'chave-de-teste-partes-bbbbbbbb';
const PROCESSO = numeroValido(7301, '09', '0011');
const DIGITOS = NumeroCNJ.criar(PROCESSO).digitos;

class Tribunal implements ProvedorDePecas {
  readonly nome = 'mni-falso';
  readonly tribunais = ['TJGO'];
  sigilo = 0;
  partes: AtosDoProcesso['partes'] = [
    {
      nome: 'BANCO SINTETICO S.A',
      polo: 'ATIVO',
      tipoPessoa: 'JURIDICA',
      // Um adaptador descuidado: documento não pode chegar ao banco nem à resposta.
      documento: '00000000000191',
      advogados: [{ nome: 'ADVOGADA SINTETICA', oab: '99999', ufOab: 'GO' }],
    },
    {
      nome: 'ADVOGADA SINTETICA',
      polo: 'ATIVO',
      tipoPessoa: 'FISICA',
      advogados: [],
    },
    { nome: 'EXECUTADO SINTETICO', polo: 'PASSIVO', tipoPessoa: 'FISICA', advogados: [] },
  ];

  async listarAtos(): Promise<AtosDoProcesso> {
    return {
      movimentos: [
        {
          data: new Date('2026-09-01T10:00:00'),
          titulo: 'Juntada de petição',
          idExterno: 'mni:1',
          fonte: 'mni',
        },
      ],
      pecas: [
        new Peca({
          id: 'doc-1',
          tipo: '57',
          descricao: 'Petição',
          mimetype: 'application/pdf',
          movimento: 1,
        }),
      ],
      ...(this.partes ? { partes: this.partes } : {}),
      ...(this.sigilo > 0 ? { nivelSigiloDoProcesso: this.sigilo } : {}),
    };
  }
  async listarPecas(): Promise<Peca[]> {
    return [...(await this.listarAtos()).pecas];
  }
  async obterConteudo(): Promise<ConteudoPeca> {
    return {
      id: 'doc-1',
      mimetype: 'application/pdf',
      nomeArquivo: 'p.pdf',
      bytes: new Uint8Array([0x25]),
    };
  }
}

/** O retrato do Diário: só quem foi intimado. */
function doDiario(numero: string): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal: 'TJGO',
    classe: 'Cumprimento de Sentença',
    partes: [
      {
        nome: 'ADVOGADA SINTETICA',
        polo: 'ATIVO',
        tipoPessoa: 'DESCONHECIDO',
        advogados: [],
      },
    ],
    movimentacoes: [
      {
        data: new Date('2026-09-02T00:00:00'),
        titulo: 'Intimação',
        idExterno: 'djen:1',
        fonte: 'djen',
      },
    ],
    procedencia: { provider: 'djen', consultadoEm: new Date(), deCache: false },
  });
}

let servidor: FastifyInstance | undefined;
afterEach(async () => {
  await servidor?.close();
  servidor = undefined;
});

async function montar(tribunal: Tribunal): Promise<FastifyInstance> {
  const app = aplicacaoDeTeste(
    [new ProviderFalso({ nome: 'falso', porNumero: async (n) => doDiario(n) })],
    { provedorDePecas: tribunal },
  );
  const s = construirServidor(
    app,
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      CACHE_ENABLED: 'false',
      PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
      RATE_LIMIT_MAX: '100000',
    } as NodeJS.ProcessEnv),
  );
  for (const chave of [CHAVE_A, CHAVE_B]) {
    const r = await s.inject({
      method: 'POST',
      url: '/v1/acompanhamentos',
      headers: { 'x-api-key': chave },
      payload: { numero: PROCESSO },
    });
    expect(r.statusCode).toBe(201);
  }
  const cred = await s.inject({
    method: 'PUT',
    url: '/v1/credenciais',
    headers: { 'x-api-key': CHAVE_A },
    payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
  });
  expect(cred.statusCode).toBe(201);
  return s;
}

async function carregarPecas(s: FastifyInstance): Promise<void> {
  const r = await s.inject({
    method: 'GET',
    url: `/v1/processos/${DIGITOS}/pecas`,
    headers: { 'x-api-key': CHAVE_A },
  });
  expect(r.statusCode).toBe(200);
}

interface ParteLista {
  nome: string;
  polo: string;
}

async function partesDaCarteira(
  s: FastifyInstance,
  chave = CHAVE_A,
): Promise<ParteLista[]> {
  const r = await s.inject({
    method: 'GET',
    url: '/v1/acompanhamentos',
    headers: { 'x-api-key': chave },
  });
  const corpo = r.json<{ acompanhamentos: Array<{ partes: ParteLista[] }> }>();
  return corpo.acompanhamentos[0]?.partes ?? [];
}

interface PolosDaTabela {
  ativo: { nomes: string[]; total: number };
  passivo: { nomes: string[]; total: number };
}

async function polosDasAtualizacoes(
  s: FastifyInstance,
  chave = CHAVE_A,
): Promise<PolosDaTabela | undefined> {
  const r = await s.inject({
    method: 'GET',
    url: '/v1/novidades?janela=todas',
    headers: { 'x-api-key': chave },
  });
  const corpo = r.json<{
    grupos: Array<{ processo: { partes: PolosDaTabela } }>;
    semNovidade: Array<{ processo: { partes: PolosDaTabela } }>;
  }>();
  return (corpo.grupos[0] ?? corpo.semNovidade[0])?.processo.partes;
}

describe('Colunas "Partes": dos autos quando a conta já carregou as peças', () => {
  it('antes das peças, as do Diário; depois, a lista dos autos — com o executado', async () => {
    servidor = await montar(new Tribunal());

    expect(await partesDaCarteira(servidor)).toEqual([
      { nome: 'ADVOGADA SINTETICA', polo: 'ATIVO' },
    ]);
    expect((await polosDasAtualizacoes(servidor))?.passivo.total).toBe(0);

    await carregarPecas(servidor);

    expect(await partesDaCarteira(servidor)).toEqual([
      { nome: 'BANCO SINTETICO S.A', polo: 'ATIVO' },
      { nome: 'ADVOGADA SINTETICA', polo: 'ATIVO' },
      { nome: 'EXECUTADO SINTETICO', polo: 'PASSIVO' },
    ]);
    const polos = await polosDasAtualizacoes(servidor);
    expect(polos?.ativo.nomes).toEqual(['BANCO SINTETICO S.A', 'ADVOGADA SINTETICA']);
    expect(polos?.passivo).toEqual({ nomes: ['EXECUTADO SINTETICO'], total: 1 });
  });

  it('a lista é da conta que tem o acesso: outra conta que acompanha o mesmo processo segue com o Diário', async () => {
    servidor = await montar(new Tribunal());
    await carregarPecas(servidor);
    expect(await partesDaCarteira(servidor, CHAVE_B)).toEqual([
      { nome: 'ADVOGADA SINTETICA', polo: 'ATIVO' },
    ]);
    expect((await polosDasAtualizacoes(servidor, CHAVE_B))?.passivo.total).toBe(0);
  });

  it('o "cumprido" devolve a linha com as mesmas partes da lista', async () => {
    servidor = await montar(new Tribunal());
    await carregarPecas(servidor);
    const r = await servidor.inject({
      method: 'DELETE',
      url: `/v1/acompanhamentos/${DIGITOS}/cumprido`,
      headers: { 'x-api-key': CHAVE_A },
    });
    expect(r.statusCode).toBe(200);
    expect(
      r.json<{ processo: { partes: PolosDaTabela } }>().processo.partes.passivo.nomes,
    ).toEqual(['EXECUTADO SINTETICO']);
  });

  it('nada além de nome e polo sai na lista, e o documento nunca é gravado', async () => {
    servidor = await montar(new Tribunal());
    await carregarPecas(servidor);
    for (const url of ['/v1/acompanhamentos', '/v1/novidades?janela=todas']) {
      const r = await servidor.inject({
        method: 'GET',
        url,
        headers: { 'x-api-key': CHAVE_A },
      });
      expect(r.body).not.toContain('00000000000191');
    }
  });

  it('resposta sem cabeçalho não apaga a lista já guardada', async () => {
    const tribunal = new Tribunal();
    servidor = await montar(tribunal);
    await carregarPecas(servidor);
    tribunal.partes = undefined;
    await carregarPecas(servidor);
    expect((await partesDaCarteira(servidor)).map((p) => p.nome)).toContain(
      'EXECUTADO SINTETICO',
    );
  });

  it('processo que o tribunal declara sob sigilo tira a lista guardada e volta ao Diário', async () => {
    const tribunal = new Tribunal();
    servidor = await montar(tribunal);
    await carregarPecas(servidor);
    tribunal.sigilo = 5;
    await carregarPecas(servidor);
    expect(await partesDaCarteira(servidor)).toEqual([
      { nome: 'ADVOGADA SINTETICA', polo: 'ATIVO' },
    ]);
  });
});
