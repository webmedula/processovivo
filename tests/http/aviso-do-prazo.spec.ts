import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import type { RespostaDoModelo } from '../../src/domain/entities/vocabularioDaAnalise.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { AnalisadorFalso, NOME_DA_PARTE, respostaValida } from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A, ProviderFalso, umProcesso } from '../helpers/fabricas.js';

/* Aviso de prazo a partir da análise (v0.39.0). Textos e nomes SINTÉTICOS, analisador dublê,
   nenhuma rede. A disponibilização é segunda 05/10/2026: publica terça 06/10, dia 1 = quarta
   07/10 e, pulando o feriado de segunda 12/10, o 15º dia útil é 28/10/2026. */

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };
const WS_A = workspaceDaChave(CHAVE_A);
const WS_B = workspaceDaChave(CHAVE_B);
const DIGITOS_A = NUMERO_TJSP_A.replace(/\D/g, '');

const TEXTO_COM_PRAZO = `Intime-se a parte autora, ${NOME_DA_PARTE}, para que se manifeste sobre o laudo pericial juntado aos autos, no prazo de 15 (quinze) dias úteis, sob pena de preclusão.`;
const TEXTO_SEM_TIPO = `Intime-se a parte autora, ${NOME_DA_PARTE}, para que se manifeste sobre o laudo pericial juntado aos autos, no prazo de 10 dias, sob pena de preclusão.`;

const DO_DIARIO: Movimentacao = {
  data: new Date('2026-10-05T12:00:00.000Z'),
  titulo: 'Despacho',
  idExterno: 'djen:901',
  conteudo: TEXTO_COM_PRAZO,
};
const DO_DIARIO_SEM_TIPO: Movimentacao = {
  data: new Date('2026-10-05T12:00:00.000Z'),
  titulo: 'Intimação',
  idExterno: 'djen:902',
  conteudo: TEXTO_SEM_TIPO,
};
const FORA_DO_DIARIO: Movimentacao = {
  data: new Date('2026-10-05T12:00:00.000Z'),
  titulo: 'Despacho do tribunal',
  conteudo: TEXTO_COM_PRAZO,
};

let app: Aplicacao;
let servidor: FastifyInstance;
let analisador: AnalisadorFalso;
const agora = new Date('2026-10-05T15:00:00.000Z');

function config() {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    CACHE_ENABLED: 'false',
    PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
    RATE_LIMIT_MAX: '1000',
  } as NodeJS.ProcessEnv);
}

const prazoDoModelo = (
  prazo: RespostaDoModelo['prazo'],
  trecho = 'se manifeste sobre o laudo pericial',
): RespostaDoModelo => respostaValida({ trecho_chave: trecho, prazo });

async function analisar(
  ato: Movimentacao,
  headers = A,
): Promise<Record<string, unknown>> {
  const r = await servidor.inject({
    method: 'POST',
    url: `/v1/acompanhamentos/${DIGITOS_A}/analise`,
    headers,
    payload: { chaveDoAto: chaveDaMovimentacao(ato) },
  });
  expect(r.statusCode).toBe(200);
  return r.json() as Record<string, unknown>;
}

const previa = (id: string, payload: object = {}, headers = A) =>
  servidor.inject({
    method: 'POST',
    url: `/v1/analises/${id}/aviso/previa`,
    headers,
    payload: payload as Record<string, unknown>,
  });
const confirmar = (id: string, payload: object = {}, headers = A) =>
  servidor.inject({
    method: 'POST',
    url: `/v1/analises/${id}/aviso`,
    headers,
    payload: payload as Record<string, unknown>,
  });
const eventos = async (headers = A): Promise<Array<Record<string, unknown>>> =>
  (
    await servidor.inject({
      method: 'GET',
      url: '/v1/calendario/eventos?de=2026-10-01&ate=2027-03-31',
      headers,
    })
  ).json().eventos;

beforeEach(async () => {
  analisador = new AnalisadorFalso();
  app = aplicacaoDeTeste(
    [
      new ProviderFalso({
        nome: 'falso',
        porNumero: async () =>
          umProcesso({
            partes: [
              { nome: NOME_DA_PARTE, polo: 'ATIVO', tipoPessoa: 'FISICA', advogados: [] },
            ],
            movimentacoes: [DO_DIARIO, DO_DIARIO_SEM_TIPO, FORA_DO_DIARIO],
          }),
      }),
    ],
    { agora: () => agora, analiseIa: { analisador } },
  );
  servidor = construirServidor(app, config());
  await app.acompanhamento.acompanhar(WS_A, NUMERO_TJSP_A);
  await app.assinaturas.liberar({ workspace: WS_A, plano: 'ia', meses: 1 });
  analisador.resposta = async () => ({
    resposta: prazoDoModelo({ dias: 15, tipo: 'uteis' }),
    modelo: 'modelo/teste',
    provedor: 'provedor-teste',
  });
});

afterEach(async () => {
  await servidor.close();
});

describe('análise com prazo', () => {
  it('a tela recebe dias, tipo e se o ato é calculável — e nenhuma data', async () => {
    const a = await analisar(DO_DIARIO);
    expect(a['prazo']).toEqual({ dias: 15, tipo: 'uteis', calculavel: true });
    expect(JSON.stringify(a)).not.toContain('dataFinal');
    expect(JSON.stringify(a)).not.toContain('2026-10-28');
  });

  it('ato fora do Diário: a tela fica sabendo que não calcula', async () => {
    const a = await analisar(FORA_DO_DIARIO);
    expect(a['prazo']).toEqual({ dias: 15, tipo: 'uteis', calculavel: false });
  });

  it('prazo cujo número não está no ato é descartado e a análise segue', async () => {
    analisador.resposta = async () => ({
      resposta: prazoDoModelo({ dias: 40, tipo: 'uteis' }),
      modelo: 'modelo/teste',
      provedor: 'provedor-teste',
    });
    const a = await analisar(DO_DIARIO);
    expect(a['estado']).toBe('verificada');
    expect(a['prazo']).toBeUndefined();
    expect((a['acoesPossiveis'] as unknown[]).length).toBe(1);
  });
});

describe('prévia: não grava nada, não chama o modelo', () => {
  it('devolve a data calculada com premissas e aviso, e a agenda continua vazia', async () => {
    const a = await analisar(DO_DIARIO);
    const antes = analisador.chamadas;
    const r = await previa(String(a['id']));
    expect(r.statusCode).toBe(200);
    const corpo = r.json();
    expect(corpo).toMatchObject({
      dias: 15,
      tipo: 'uteis',
      tipoDoAto: true,
      dataDaPublicacao: '2026-10-06',
      inicioDaContagem: '2026-10-07',
      dataFinal: '2026-10-28',
      titulo: 'Prazo de 15 dias úteis (a conferir)',
    });
    expect(corpo.premissas.length).toBeGreaterThanOrEqual(5);
    expect(corpo.aviso).toContain('Feriado local e suspensões não considerados');
    // Zero escritas e zero chamadas ao modelo.
    expect(await eventos()).toHaveLength(0);
    await previa(String(a['id']));
    expect(await eventos()).toHaveLength(0);
    expect(analisador.chamadas).toBe(antes);
  });

  it('ato que não diz o tipo: sem tipo padrão, pede a escolha; com a escolha, calcula', async () => {
    analisador.resposta = async () => ({
      resposta: prazoDoModelo({ dias: 10, tipo: null }),
      modelo: 'modelo/teste',
      provedor: 'provedor-teste',
    });
    const a = await analisar(DO_DIARIO_SEM_TIPO);
    expect(a['prazo']).toEqual({ dias: 10, tipo: null, calculavel: true });
    const sem = await previa(String(a['id']));
    expect(sem.statusCode).toBe(422);
    expect(sem.json()).toMatchObject({ detalhes: { motivo: 'tipo_necessario' } });
    const uteis = await previa(String(a['id']), { tipo: 'uteis' });
    const corridos = await previa(String(a['id']), { tipo: 'corridos' });
    expect(uteis.json()).toMatchObject({
      tipo: 'uteis',
      tipoDoAto: false,
      dataFinal: '2026-10-21',
    });
    expect(corridos.json()).toMatchObject({ tipo: 'corridos', dataFinal: '2026-10-16' });
    expect(await eventos()).toHaveLength(0);
  });

  it('o tipo do ato vale: o cliente não o troca', async () => {
    const a = await analisar(DO_DIARIO);
    const r = await previa(String(a['id']), { tipo: 'corridos' });
    expect(r.json()).toMatchObject({ tipo: 'uteis' });
  });

  it('ato fora do Diário não calcula', async () => {
    const a = await analisar(FORA_DO_DIARIO);
    const r = await previa(String(a['id']));
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({
      erro: 'PRAZO_NAO_CALCULAVEL',
      detalhes: { motivo: 'ato_fora_do_diario' },
    });
    const c = await confirmar(String(a['id']));
    expect(c.statusCode).toBe(422);
    expect(await eventos()).toHaveLength(0);
  });

  it('análise sem prazo: 422 e nada criado', async () => {
    analisador.resposta = async () => ({
      resposta: respostaValida({ trecho_chave: 'se manifeste sobre o laudo pericial' }),
      modelo: 'modelo/teste',
      provedor: 'provedor-teste',
    });
    const a = await analisar(DO_DIARIO);
    expect(a['prazo']).toBeUndefined();
    const r = await previa(String(a['id']));
    expect(r.json()).toMatchObject({ detalhes: { motivo: 'sem_prazo_na_analise' } });
  });
});

describe('confirmação', () => {
  it('recalcula no servidor e cria o evento: tipo prazo, dia inteiro, marcador de calculado', async () => {
    const a = await analisar(DO_DIARIO);
    const antes = analisador.chamadas;
    const r = await confirmar(String(a['id']));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      tipo: 'prazo',
      titulo: 'Prazo de 15 dias úteis (a conferir)',
      dataLocal: '2026-10-28',
      calculado: true,
    });
    const lista = await eventos();
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      tipo: 'prazo',
      origem: 'manual',
      estado: 'confirmado',
      dataLocal: '2026-10-28',
      horaLocal: null,
      calculado: true,
      numeroProcesso: DIGITOS_A,
    });
    expect(String(lista[0]?.['observacao'])).toContain(
      'Disponibilização no Diário em 05/10/2026.',
    );
    expect(String(lista[0]?.['observacao'])).toContain('Data a conferir no processo.');
    expect(analisador.chamadas).toBe(antes); // zero chamadas ao modelo
  });

  it('o evento não leva nome de parte nem texto da IA', async () => {
    const a = await analisar(DO_DIARIO);
    await confirmar(String(a['id']));
    const e = JSON.stringify(await eventos());
    expect(e).not.toContain(NOME_DA_PARTE);
    expect(e).not.toContain('FULANA');
    expect(e).not.toContain('Parte autora: apresentar');
    expect(e).not.toContain('laudo');
  });

  it('data editada: vale a do advogado, e o marcador de calculado sai', async () => {
    const a = await analisar(DO_DIARIO);
    const r = await confirmar(String(a['id']), { dataLocal: '2026-10-30' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ dataLocal: '2026-10-30', calculado: false });
    const [e] = await eventos();
    expect(String(e?.['observacao'])).toContain('Data editada por você para 30/10/2026.');
    expect(String(e?.['observacao'])).toContain('Data calculada: 28/10/2026.');
  });

  it.each(['2026-02-30', '30/10/2026', 'amanhã', '2026-13-01', '2026-1-1'])(
    'rejeita data inválida (%s) e não cria nada',
    async (dataLocal) => {
      const a = await analisar(DO_DIARIO);
      const r = await confirmar(String(a['id']), { dataLocal });
      expect(r.statusCode).toBe(400);
      expect(await eventos()).toHaveLength(0);
    },
  );

  it('sem o tipo escolhido, não cria (ato sem tipo)', async () => {
    analisador.resposta = async () => ({
      resposta: prazoDoModelo({ dias: 10, tipo: null }),
      modelo: 'modelo/teste',
      provedor: 'provedor-teste',
    });
    const a = await analisar(DO_DIARIO_SEM_TIPO);
    expect((await confirmar(String(a['id']))).statusCode).toBe(422);
    expect(await eventos()).toHaveLength(0);
    const ok = await confirmar(String(a['id']), { tipo: 'corridos' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ titulo: 'Prazo de 10 dias corridos (a conferir)' });
  });
});

describe('feed', () => {
  it('o marcador aparece no feed, e o feed continua sem nome de parte, título ou trecho', async () => {
    const a = await analisar(DO_DIARIO);
    await confirmar(String(a['id']));
    const feed = await servidor.inject({
      method: 'POST',
      url: '/v1/calendario/feed',
      headers: A,
      payload: { incluiSugeridos: false },
    });
    expect(feed.statusCode).toBe(201);
    const caminho = new URL(String(feed.json().url)).pathname;
    // O ICS dobra linhas longas (RFC 5545): desdobra antes de procurar a frase.
    const ics = (await servidor.inject({ method: 'GET', url: caminho })).body.replace(
      /\r\n /g,
      '',
    );
    expect(ics).toContain('Data calculada pelo Processo Vivo: confira no processo.');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261028');
    expect(ics).toContain('SUMMARY:Prazo — ');
    expect(ics).not.toContain(NOME_DA_PARTE);
    expect(ics).not.toContain('a conferir)'); // o título livre nunca vai ao feed
    expect(ics).not.toContain('laudo');
    expect(ics).not.toContain('Parte autora');
  });

  it('evento comum (sem cálculo) não leva o marcador', async () => {
    await servidor.inject({
      method: 'POST',
      url: '/v1/calendario/eventos',
      headers: A,
      payload: {
        numeroProcesso: DIGITOS_A,
        tipo: 'prazo',
        titulo: 'Prazo manual',
        dataLocal: '2026-11-10',
      },
    });
    const feed = await servidor.inject({
      method: 'POST',
      url: '/v1/calendario/feed',
      headers: A,
      payload: { incluiSugeridos: false },
    });
    const caminho = new URL(String(feed.json().url)).pathname;
    const ics = (await servidor.inject({ method: 'GET', url: caminho })).body;
    expect(ics).toContain('Criado por você.');
    expect(ics).not.toContain('Data calculada pelo Processo Vivo');
  });

  it('editar a data do evento calculado, depois, apaga o marcador', async () => {
    const a = await analisar(DO_DIARIO);
    const criado = (await confirmar(String(a['id']))).json();
    const r = await servidor.inject({
      method: 'PATCH',
      url: `/v1/calendario/eventos/${criado.id}`,
      headers: A,
      payload: { dataLocal: '2026-11-03' },
    });
    expect(r.json()).toMatchObject({ dataLocal: '2026-11-03', calculado: false });
  });
});

describe('plano e isolamento', () => {
  it('sem o plano IA, as duas rotas recusam (403) e nada é criado', async () => {
    const a = await analisar(DO_DIARIO);
    await app.assinaturas.liberar({ workspace: WS_A, plano: 'pecas', meses: 1 });
    expect((await previa(String(a['id']))).statusCode).toBe(403);
    expect((await confirmar(String(a['id']))).statusCode).toBe(403);
    expect(await eventos()).toHaveLength(0);
  });

  it('chave de outra conta: 403 sem plano, e com plano é 404 igual a "não existe"', async () => {
    const a = await analisar(DO_DIARIO);
    expect((await previa(String(a['id']), {}, B)).statusCode).toBe(403);
    await app.assinaturas.liberar({ workspace: WS_B, plano: 'ia', meses: 1 });
    const deOutra = await previa(String(a['id']), {}, B);
    const inexistente = await previa('nao-existe', {}, B);
    expect(deOutra.statusCode).toBe(404);
    expect(inexistente.statusCode).toBe(404);
    expect(deOutra.json()).toEqual(inexistente.json());
    expect((await confirmar(String(a['id']), {}, B)).statusCode).toBe(404);
    expect(await eventos(B)).toHaveLength(0);
  });

  it('exige autenticação', async () => {
    const r = await servidor.inject({
      method: 'POST',
      url: '/v1/analises/x/aviso/previa',
      payload: {},
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('IA desligada', () => {
  it('as rotas do aviso nem existem', async () => {
    await servidor.close();
    app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {});
    servidor = construirServidor(app, config());
    const r = await servidor.inject({
      method: 'POST',
      url: '/v1/analises/x/aviso/previa',
      headers: A,
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });
});
