import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { NotificadorEspiao, aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { NUMERO_TJSP_A, ProviderFalso, umProcesso } from '../helpers/fabricas.js';

/*
 * v0.51.0, pela API: lembretes do feed (PATCH/GET/POST /v1/calendario/feed, ICS público) e a opção do
 * resumo por e-mail (GET/PUT /v1/calendario/resumo). Textos, nomes e números sintéticos.
 */

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };
const WS_A = workspaceDaChave(CHAVE_A);
const URL_BASE = 'https://processovivo.exemplo.invalid';

const DESIGNACAO: Movimentacao = {
  data: new Date('2026-09-20T13:00:00.000Z'),
  titulo: 'Intimação',
  conteudo:
    'Designo audiência de conciliação entre FULANA SINTÉTICA e a ré para 12/11/2026, às 14:30.',
};

let agora: Date;
let servidor: FastifyInstance;
let app: Aplicacao;

function montar(resumo: { habilitado: boolean } | undefined): void {
  app = aplicacaoDeTeste(
    [
      new ProviderFalso({
        nome: 'falso',
        porNumero: async () => umProcesso({ movimentacoes: [DESIGNACAO] }),
      }),
    ],
    {
      agora: () => agora,
      ...(resumo
        ? {
            resumoDoCalendario: {
              habilitado: resumo.habilitado,
              notificador: new NotificadorEspiao(),
            },
          }
        : {}),
    },
  );
  servidor = construirServidor(
    app,
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      CACHE_ENABLED: 'false',
      PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
      PROCESSOVIVO_URL_BASE: URL_BASE,
      RATE_LIMIT_MAX: '1000',
    } as NodeJS.ProcessEnv),
  );
}

beforeEach(async () => {
  agora = new Date('2026-10-02T15:00:00.000Z');
  montar(undefined);
  await app.acompanhamento.acompanhar(WS_A, NUMERO_TJSP_A);
});
afterEach(async () => {
  await servidor.close();
});

async function confirmarEvento(): Promise<void> {
  const lista = await servidor.inject({
    method: 'GET',
    url: '/v1/calendario/eventos?de=2026-10-01&ate=2026-12-31',
    headers: A,
  });
  const id = String(lista.json().eventos[0].id);
  const r = await servidor.inject({
    method: 'PATCH',
    url: `/v1/calendario/eventos/${id}`,
    headers: A,
    payload: { estado: 'confirmado' },
  });
  expect(r.statusCode).toBe(200);
}

async function criarFeed(payload: Record<string, unknown> = {}): Promise<string> {
  const r = await servidor.inject({
    method: 'POST',
    url: '/v1/calendario/feed',
    headers: A,
    payload,
  });
  expect(r.statusCode).toBe(201);
  return String(r.json().url).slice(URL_BASE.length);
}

const ics = async (caminho: string): Promise<string> =>
  (await servidor.inject({ method: 'GET', url: caminho })).body;
const alarmes = (texto: string): number => (texto.match(/BEGIN:VALARM/g) ?? []).length;
const campo = (texto: string, nome: string): string =>
  new RegExp(`${nome}:(.*)\\r\\n`).exec(texto)?.[1] ?? '';

describe('API — lembretes do feed', () => {
  it('padrão: nenhum lembrete, no GET e no ICS', async () => {
    await confirmarEvento();
    const caminho = await criarFeed();
    const estado = await servidor.inject({
      method: 'GET',
      url: '/v1/calendario/feed',
      headers: A,
    });
    expect(estado.json()).toMatchObject({
      existe: true,
      lembretes: { umDiaAntes: false, umaHoraAntes: false },
    });
    expect(alarmes(await ics(caminho))).toBe(0);
  });

  it('PATCH liga os lembretes; o ICS passa a ter VALARM só no evento confirmado', async () => {
    await confirmarEvento();
    const caminho = await criarFeed({ incluiSugeridos: true });
    const r = await servidor.inject({
      method: 'PATCH',
      url: '/v1/calendario/feed',
      headers: A,
      payload: { lembretes: { umDiaAntes: true, umaHoraAntes: true } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      existe: true,
      incluiSugeridos: true,
      lembretes: { umDiaAntes: true, umaHoraAntes: true },
    });
    const corpo = await ics(caminho);
    expect(alarmes(corpo)).toBe(2);
    expect(corpo).toContain('TRIGGER:-P1D');
    expect(corpo).toContain('TRIGGER:-PT1H');
  });

  it('mudar a preferência atualiza o feed na próxima leitura, com o mesmo UID e SEQUENCE/DTSTAMP crescentes', async () => {
    await confirmarEvento();
    const caminho = await criarFeed();
    const antes = await ics(caminho);
    agora = new Date('2026-10-03T10:00:00.000Z');
    await servidor.inject({
      method: 'PATCH',
      url: '/v1/calendario/feed',
      headers: A,
      payload: { lembretes: { umDiaAntes: true, umaHoraAntes: false } },
    });
    const depois = await ics(caminho);
    expect(campo(depois, 'UID')).toBe(campo(antes, 'UID'));
    expect((depois.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
    expect(Number(campo(depois, 'SEQUENCE'))).toBe(Number(campo(antes, 'SEQUENCE')) + 1);
    expect(campo(depois, 'DTSTAMP')).toBe('20261003T100000Z');
    expect(alarmes(depois)).toBe(1);
    // Mudar de novo sobe de novo; salvar a MESMA escolha não sobe.
    await servidor.inject({
      method: 'PATCH',
      url: '/v1/calendario/feed',
      headers: A,
      payload: { lembretes: { umDiaAntes: true, umaHoraAntes: false } },
    });
    expect(campo(await ics(caminho), 'SEQUENCE')).toBe(campo(depois, 'SEQUENCE'));
    await servidor.inject({
      method: 'PATCH',
      url: '/v1/calendario/feed',
      headers: A,
      payload: { lembretes: { umDiaAntes: false, umaHoraAntes: false } },
    });
    const sem = await ics(caminho);
    expect(alarmes(sem)).toBe(0);
    expect(Number(campo(sem, 'SEQUENCE'))).toBe(Number(campo(antes, 'SEQUENCE')) + 2);
  });

  it('mudar só "incluir sugeridos" não mexe nos lembretes nem na revisão', async () => {
    await confirmarEvento();
    const caminho = await criarFeed({
      lembretes: { umDiaAntes: true, umaHoraAntes: false },
    });
    const antes = await ics(caminho);
    await servidor.inject({
      method: 'PATCH',
      url: '/v1/calendario/feed',
      headers: A,
      payload: { incluiSugeridos: true },
    });
    const depois = await ics(caminho);
    expect(campo(depois, 'SEQUENCE')).toBe(campo(antes, 'SEQUENCE'));
    expect(alarmes(depois)).toBe(1);
  });

  it('regenerar a URL com os lembretes do painel os mantém; o feed novo começa na revisão 0', async () => {
    await confirmarEvento();
    const velho = await criarFeed({
      lembretes: { umDiaAntes: true, umaHoraAntes: true },
    });
    const novo = await criarFeed({ lembretes: { umDiaAntes: true, umaHoraAntes: true } });
    expect(novo).not.toBe(velho);
    expect(alarmes(await ics(novo))).toBe(2);
    expect((await servidor.inject({ method: 'GET', url: velho })).statusCode).toBe(404);
  });

  it('Zod nas bordas: corpo vazio, campo extra e tipo errado são 400', async () => {
    await criarFeed();
    for (const payload of [
      {},
      { lembretes: { umDiaAntes: 'sim', umaHoraAntes: true } },
      { lembretes: { umDiaAntes: true } },
      { lembretes: { umDiaAntes: true, umaHoraAntes: true, tresDiasAntes: true } },
      { alarme: true },
    ]) {
      const r = await servidor.inject({
        method: 'PATCH',
        url: '/v1/calendario/feed',
        headers: A,
        payload,
      });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('sem feed vigente, o PATCH de lembretes diz que falta o feed (404)', async () => {
    const r = await servidor.inject({
      method: 'PATCH',
      url: '/v1/calendario/feed',
      headers: A,
      payload: { lembretes: { umDiaAntes: true, umaHoraAntes: false } },
    });
    expect(r.statusCode).toBe(404);
  });

  it('isolamento: a preferência de A não aparece no feed de B', async () => {
    await criarFeed({ lembretes: { umDiaAntes: true, umaHoraAntes: true } });
    const b = await servidor.inject({
      method: 'POST',
      url: '/v1/calendario/feed',
      headers: B,
      payload: {},
    });
    const caminhoB = String(b.json().url).slice(URL_BASE.length);
    const estadoB = await servidor.inject({
      method: 'GET',
      url: '/v1/calendario/feed',
      headers: B,
    });
    expect(estadoB.json().lembretes).toEqual({ umDiaAntes: false, umaHoraAntes: false });
    expect(alarmes(await ics(caminhoB))).toBe(0);
  });

  it('a privacidade do feed não muda: sem parte e sem trecho, com lembretes ligados', async () => {
    await confirmarEvento();
    const caminho = await criarFeed({
      lembretes: { umDiaAntes: true, umaHoraAntes: true },
    });
    expect(await ics(caminho)).not.toMatch(/FULANA|SINTÉTICA|Designo audiência/);
  });
});

describe('API — opção do resumo por e-mail', () => {
  it('sem o serviço (sem SMTP de verdade) ou com a chave global desligada: indisponível, e a tela não mostra a opção', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/calendario/resumo',
      headers: A,
    });
    expect(r.json()).toEqual({ disponivel: false, ativo: false });
    await servidor.close();
    montar({ habilitado: false });
    const desligada = await servidor.inject({
      method: 'GET',
      url: '/v1/calendario/resumo',
      headers: A,
    });
    expect(desligada.json()).toEqual({ disponivel: false, ativo: false });
    const put = await servidor.inject({
      method: 'PUT',
      url: '/v1/calendario/resumo',
      headers: A,
      payload: { ativo: false },
    });
    expect(put.json()).toEqual({ disponivel: false, ativo: false });
  });

  it('com a chave ligada: padrão LIGADO, PUT liga/desliga e cada conta tem a sua', async () => {
    await servidor.close();
    montar({ habilitado: true });
    const get = (h: Record<string, string>) =>
      servidor.inject({ method: 'GET', url: '/v1/calendario/resumo', headers: h });
    expect((await get(A)).json()).toEqual({ disponivel: true, ativo: true });
    const r = await servidor.inject({
      method: 'PUT',
      url: '/v1/calendario/resumo',
      headers: A,
      payload: { ativo: false },
    });
    expect(r.json()).toEqual({ disponivel: true, ativo: false });
    expect((await get(A)).json().ativo).toBe(false);
    expect((await get(B)).json().ativo).toBe(true);
  });

  it('exige autenticação e corpo válido', async () => {
    await servidor.close();
    montar({ habilitado: true });
    expect(
      (await servidor.inject({ method: 'GET', url: '/v1/calendario/resumo' })).statusCode,
    ).toBe(401);
    for (const payload of [{}, { ativo: 'sim' }, { ativo: true, x: 1 }]) {
      const r = await servidor.inject({
        method: 'PUT',
        url: '/v1/calendario/resumo',
        headers: A,
        payload,
      });
      expect(r.statusCode).toBe(400);
    }
  });
});
