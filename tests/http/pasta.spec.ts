import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MniBloqueadoError } from '../../src/domain/errors/index.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import {
  HTML_SINTETICO,
  PROCESSO_TJGO,
  PROCESSO_TJGO_DIGITOS,
  ProvedorDeLoteFalso,
  marcasDasPaginas,
  pastaTemporaria,
  pdfSintetico,
} from '../helpers/leitor.js';

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };
const PASTA = `/v1/processos/${PROCESSO_TJGO}/pasta`;

let dir: ReturnType<typeof pastaTemporaria>;
let servidor: FastifyInstance;
let app: Aplicacao;
let provedor: ProvedorDeLoteFalso;

beforeEach(async () => {
  dir = pastaTemporaria();
  provedor = new ProvedorDeLoteFalso([
    {
      id: 'a',
      rotulo: 'Petição inicial',
      bytes: await pdfSintetico(2, 'A'),
      movimento: 1,
    },
    { id: 'b', rotulo: 'Procuração', bytes: await pdfSintetico(1, 'B'), movimento: 1 },
    {
      id: 'h',
      rotulo: 'Certidão',
      mimetype: 'text/html',
      bytes: new TextEncoder().encode(HTML_SINTETICO),
    },
    { id: 'c', rotulo: 'Contestação' },
    {
      id: 's',
      rotulo: 'Laudo sigiloso',
      bytes: await pdfSintetico(1, 'S'),
      nivelSigilo: 1,
    },
  ]);
  app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    provedorDePecas: provedor,
    leitor: { pasta: dir.caminho },
    comAssinaturas: true,
  });
  servidor = construirServidor(
    app,
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      CACHE_ENABLED: 'false',
      PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
    } as NodeJS.ProcessEnv),
  );
  for (const [chave, h] of [
    [CHAVE_A, A],
    [CHAVE_B, B],
  ] as const) {
    await app.assinaturas.liberar({
      workspace: workspaceDaChave(chave),
      plano: 'pecas',
      meses: 1,
    });
    await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: h,
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
  }
});
afterEach(async () => {
  await servidor.close();
  dir.apagar();
});

/** O que a tela faz ao abrir o processo: carrega as peças (e a Pasta fica sabendo). */
async function carregarPecas(h = A): Promise<void> {
  const r = await servidor.inject({
    url: `/v1/processos/${PROCESSO_TJGO}/pecas`,
    headers: h,
  });
  expect(r.statusCode).toBe(200);
}

interface PecaJson {
  pecaId: string;
  rotulo: string;
  estado: string;
  intervalo: { inicial: number; final: number } | null;
  [chave: string]: unknown;
}
interface CorpoPasta {
  pecas: PecaJson[];
  [chave: string]: unknown;
}

async function pasta(h = A): Promise<CorpoPasta> {
  const r = await servidor.inject({ url: PASTA, headers: h });
  expect(r.statusCode).toBe(200);
  return r.json() as CorpoPasta;
}

async function pedir(id: string, h = A): Promise<ReturnType<FastifyInstance['inject']>> {
  const r = servidor.inject({ method: 'POST', url: `${PASTA}/pecas/${id}`, headers: h });
  return r;
}

const estados = (corpo: CorpoPasta): Record<string, string> =>
  Object.fromEntries(corpo.pecas.map((p) => [p.pecaId, p.estado]));

describe('API — Pasta digital: a lista', () => {
  it('antes de carregar as peças do processo, diz que não há listagem (200, não erro)', async () => {
    const c = await pasta();
    expect(c['listagem']).toBeNull();
    expect(c.pecas).toEqual([]);
    expect(c['procedencia']).toMatchObject({ fonte: 'mni', aoVivo: false });
  });

  it('depois de carregar, lista na ordem dos autos com os totais SEM filtro e a procedência', async () => {
    await carregarPecas();
    const antes = provedor.chamadas.length;
    const c = await pasta();

    expect(estados(c)).toEqual({
      a: 'nao_baixada',
      b: 'nao_baixada',
      h: 'nao_baixada',
      c: 'nao_baixada',
      s: 'sigilo',
    });
    expect(c.pecas.map((p) => p.rotulo)).toEqual([
      'Petição inicial',
      'Procuração',
      'Certidão',
      'Contestação',
      'Laudo sigiloso',
    ]);
    expect(c['totais']).toEqual({
      pecas: 5,
      atosSemPeca: 0,
      disponiveis: 0,
      sigilosas: 1,
      naFila: 0,
      naoObtidas: 0,
      naoBaixadas: 4,
    });
    expect(c['procedencia']).toMatchObject({
      fonte: 'mni',
      tribunal: 'TJGO',
      aoVivo: false,
    });
    expect(c['listagem']).toMatchObject({ tribunal: 'TJGO', processoSigiloso: false });
    expect(c['estimativaDaMontagem']).toMatchObject({ abuscar: 4, sigilosas: 1 });
    // Ler a lista não consulta o tribunal.
    expect(provedor.chamadas.length).toBe(antes);
  });

  it('a resposta não expõe localizador, caminho em disco, bytes de peça nem credencial', async () => {
    await carregarPecas();
    await pedir('a');
    await app.pasta?.aguardarOciosa();
    const c = await pasta();
    const a = c.pecas.find((p) => p.pecaId === 'a') ?? ({} as PecaJson);
    expect(Object.keys(a).sort()).toEqual([
      'aoVivo',
      'bytes',
      'conversao',
      'data',
      'descricaoDoMotivo',
      'desde',
      'estado',
      'expiraEm',
      'intervalo',
      'mimetype',
      'motivo',
      'movimentacao',
      'movimento',
      'observacao',
      'obtidaEm',
      'ordem',
      'paginasDaPeca',
      'pecaId',
      'retomarEm',
      'rotulo',
      'substituida',
    ]);
    expect(a.aoVivo).toBe(false);
    const texto = JSON.stringify(c);
    expect(texto).not.toContain(dir.caminho);
    expect(texto).not.toMatch(/localizador|[a-f0-9]{32}\.pdf|segredo/);
  });
});

describe('API — Pasta digital: abrir uma peça', () => {
  it('202 ao pedir; a peça aparece como disponível e o arquivo sai com Range, sempre "não ao vivo"', async () => {
    await carregarPecas();
    const r = await pedir('a');
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ pecaId: 'a', estado: 'na_fila', aoVivo: false });

    await app.pasta?.aguardarOciosa();
    expect(provedor.lotes()).toEqual([['a']]);
    expect(estados(await pasta())['a']).toBe('disponivel');

    const arq = `${PASTA}/pecas/a/arquivo`;
    const inteiro = await servidor.inject({ url: arq, headers: A });
    expect(inteiro.statusCode).toBe(200);
    expect(inteiro.headers['content-type']).toBe('application/pdf');
    expect(inteiro.headers['accept-ranges']).toBe('bytes');
    expect(inteiro.headers['cache-control']).toBe('private, no-store');
    expect(inteiro.headers['x-processovivo-ao-vivo']).toBe('false');
    expect(inteiro.headers['x-processovivo-baixado-em']).toEqual(expect.any(String));
    expect(inteiro.headers['x-processovivo-expira-em']).toEqual(expect.any(String));
    expect(inteiro.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await marcasDasPaginas(inteiro.rawPayload)).toEqual(['A-p1', 'A-p2']);

    const trecho = await servidor.inject({
      url: arq,
      headers: { ...A, range: 'bytes=10-29' },
    });
    expect(trecho.statusCode).toBe(206);
    expect(trecho.rawPayload.equals(inteiro.rawPayload.subarray(10, 30))).toBe(true);
  });

  it('peça já guardada responde 200 e não chama o tribunal', async () => {
    await carregarPecas();
    await pedir('a');
    await app.pasta?.aguardarOciosa();
    const chamadas = provedor.chamadas.length;

    const r = await pedir('a');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ estado: 'disponivel' });
    expect(provedor.chamadas.length).toBe(chamadas);
  });

  it('403 do tribunal: a lista mostra a peça pausada com a hora, e a rota diz até quando', async () => {
    await carregarPecas();
    const volta = new Date('2026-10-01T13:15:00.000Z');
    provedor.falharNoLote = { n: 1, erro: new MniBloqueadoError('mni', volta) };
    provedor.pausa = volta;
    await pedir('a');
    await app.pasta?.aguardarOciosa();

    const c = await pasta();
    const a = c.pecas.find((p) => p.pecaId === 'a');
    expect(a).toMatchObject({
      estado: 'nao_obtida',
      motivo: 'bloqueio_do_tribunal',
      retomarEm: volta.toISOString(),
    });
    expect(c['pausadoAte']).toBe(volta.toISOString());
  });

  it('peça sob sigilo: 403 e nada em disco', async () => {
    await carregarPecas();
    const r = await pedir('s');
    expect(r.statusCode).toBe(403);
    expect(r.json().erro).toBe('PECA_SIGILOSA_NAO_GUARDADA');
    const arq = await servidor.inject({ url: `${PASTA}/pecas/s/arquivo`, headers: A });
    expect(arq.statusCode).toBe(404);
  });

  it('pedir sem ter carregado as peças é 409 com instrução; id desconhecido é 404', async () => {
    const cedo = await pedir('a');
    expect(cedo.statusCode).toBe(409);
    expect(cedo.json().erro).toBe('LISTAGEM_DA_PASTA_AUSENTE');
    await carregarPecas();
    const r = await pedir('inventado');
    expect(r.statusCode).toBe(404);
    expect(r.json().erro).toBe('PECA_DA_PASTA_NAO_ENCONTRADA');
  });

  it('o arquivo de uma peça que não está guardada é 404', async () => {
    await carregarPecas();
    const r = await servidor.inject({ url: `${PASTA}/pecas/a/arquivo`, headers: A });
    expect(r.statusCode).toBe(404);
  });

  it('plano sem o recurso "peças": consultar o tribunal é recusado, ler a lista não', async () => {
    await carregarPecas();
    await app.assinaturas.cancelar(workspaceDaChave(CHAVE_A));
    await app.assinaturas.liberar({
      workspace: workspaceDaChave(CHAVE_A),
      plano: 'acompanhamento',
      meses: 1,
    });
    const r = await pedir('a');
    expect(r.statusCode).toBe(403);
    expect(r.json().erro).toBe('RECURSO_NAO_INCLUIDO_NO_PLANO');
    for (const [url, corpo] of [
      [`${PASTA}/montar`, undefined],
      [`${PASTA}/baixar`, { pecas: ['a'] }],
    ] as const) {
      const x = await servidor.inject({
        method: 'POST',
        url,
        headers: A,
        ...(corpo ? { payload: corpo } : {}),
      });
      expect(x.statusCode, url).toBe(403);
    }
    expect((await servidor.inject({ url: PASTA, headers: A })).statusCode).toBe(200);
    expect(provedor.lotes()).toEqual([]);
  });

  it('sem chave nem sessão, nada disto responde', async () => {
    const r = await servidor.inject({ url: PASTA });
    expect(r.statusCode).toBe(401);
    const p = await servidor.inject({ method: 'POST', url: `${PASTA}/pecas/a` });
    expect(p.statusCode).toBe(401);
  });
});

describe('API — Pasta digital: montar a pasta completa', () => {
  it('202 cria o job; 200 se já existe; o PDF e o índice saem pelas rotas do leitor, com intervalos na lista', async () => {
    await carregarPecas();
    const r = await servidor.inject({
      method: 'POST',
      url: `${PASTA}/montar`,
      headers: A,
    });
    expect(r.statusCode).toBe(202);
    expect(r.json().jaExistia).toBe(false);
    expect(r.json().job).toMatchObject({
      finalidade: 'pasta_completa',
      estado: 'na_fila',
    });
    expect(r.json().estimativa).toMatchObject({ abuscar: 4, sigilosas: 1 });
    const jobId = String(r.json().job.jobId);

    const outra = await servidor.inject({
      method: 'POST',
      url: `${PASTA}/montar`,
      headers: A,
    });
    expect(outra.statusCode).toBe(200);
    expect(outra.json().job.jobId).toBe(jobId);

    await app.leitor?.processarFila();
    const c = await pasta();
    expect(c['montagem']).toMatchObject({
      estado: 'parcial',
      finalidade: 'pasta_completa',
    });
    expect(
      c.pecas.map((p) => [p.pecaId, p.intervalo?.inicial, p.intervalo?.final]),
    ).toEqual([
      ['a', 1, 2],
      ['b', 3, 3],
      ['h', 4, 4],
      ['c', 5, 5],
      ['s', 6, 6],
    ]);
    expect(estados(c)).toMatchObject({
      a: 'disponivel',
      b: 'disponivel',
      h: 'disponivel',
    });

    const pdf = await servidor.inject({
      url: `/v1/processos/${PROCESSO_TJGO}/leitor/${jobId}/pdf`,
      headers: A,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-disposition']).toContain(
      `processo-${PROCESSO_TJGO_DIGITOS}-pecas.pdf`,
    );
  });

  it('B não vê a montagem de A, nem baixa a peça dela, nem lê a lista dela', async () => {
    await carregarPecas(A);
    await pedir('a', A);
    await app.pasta?.aguardarOciosa();
    await servidor.inject({ method: 'POST', url: `${PASTA}/montar`, headers: A });
    await app.leitor?.processarFila();

    const cb = await pasta(B);
    expect(cb['listagem']).toBeNull();
    expect(cb['montagem']).toBeNull();
    expect(cb.pecas).toEqual([]);
    const arq = await servidor.inject({ url: `${PASTA}/pecas/a/arquivo`, headers: B });
    expect(arq.statusCode).toBe(404);
    expect(arq.body).not.toContain('%PDF');
    const ped = await pedir('a', B);
    expect(ped.statusCode).toBe(409); // B nem carregou a lista
    // O dono continua lendo.
    expect(
      (await servidor.inject({ url: `${PASTA}/pecas/a/arquivo`, headers: A })).statusCode,
    ).toBe(200);
  });
});

describe('API — Pasta digital: baixar as marcadas', () => {
  it('a prévia conta o que irá ao tribunal; baixar usa a guarda; o arquivo tem o nome e o índice próprios', async () => {
    await carregarPecas();
    await pedir('b');
    await app.pasta?.aguardarOciosa();

    const previa = await servidor.inject({
      method: 'POST',
      url: `${PASTA}/baixar/previa`,
      headers: A,
      payload: { pecas: ['h', 'a', 'b'] },
    });
    expect(previa.statusCode).toBe(200);
    expect(previa.json()).toMatchObject({
      total: 3,
      abuscar: 2,
      emGuarda: 1,
      sigilosas: 0,
    });

    const r = await servidor.inject({
      method: 'POST',
      url: `${PASTA}/baixar`,
      headers: A,
      payload: { pecas: ['h', 'a', 'b'] },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json().job.finalidade).toBe('selecionadas');
    const jobId = String(r.json().job.jobId);
    provedor.chamadas.length = 0;
    await app.leitor?.processarFila();
    expect(provedor.lotes()).toEqual([['a', 'h']]); // "b" veio da guarda

    const pdf = await servidor.inject({
      url: `/v1/processos/${PROCESSO_TJGO}/leitor/${jobId}/pdf`,
      headers: A,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-disposition']).toBe(
      `attachment; filename="processo-${PROCESSO_TJGO_DIGITOS}-pecas-selecionadas.pdf"`,
    );
    const indice = await servidor.inject({
      url: `/v1/processos/${PROCESSO_TJGO}/leitor/${jobId}/indice`,
      headers: A,
    });
    expect(
      (indice.json().indice as Array<Record<string, unknown>>).map((e) => [
        e['pecaId'],
        e['paginaInicial'],
        e['paginaFinal'],
      ]),
    ).toEqual([
      ['a', 1, 2],
      ['b', 3, 3],
      ['h', 4, 4],
    ]);
    expect(indice.json().procedencia).toMatchObject({ aoVivo: false });
  });

  it('seleção vazia ou malformada é 400; só sigilosa é 409; id desconhecido é 404', async () => {
    await carregarPecas();
    const vazio = await servidor.inject({
      method: 'POST',
      url: `${PASTA}/baixar`,
      headers: A,
      payload: { pecas: [] },
    });
    expect(vazio.statusCode).toBe(400);
    const sigilosa = await servidor.inject({
      method: 'POST',
      url: `${PASTA}/baixar`,
      headers: A,
      payload: { pecas: ['s'] },
    });
    expect(sigilosa.statusCode).toBe(409);
    expect(sigilosa.json().erro).toBe('PASTA_SEM_PECAS_PARA_JUNTAR');
    const fantasma = await servidor.inject({
      method: 'POST',
      url: `${PASTA}/baixar`,
      headers: A,
      payload: { pecas: ['fantasma'] },
    });
    expect(fantasma.statusCode).toBe(404);
  });
});

describe('API — Pasta digital sem leitor montado', () => {
  it('diz o que falta (501) em vez de fingir', async () => {
    const sem = construirServidor(
      aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })]),
      carregarConfig({
        PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
        LOG_LEVEL: 'silent',
        PROCESSOVIVO_API_KEYS: CHAVE_A,
      } as NodeJS.ProcessEnv),
    );
    const r = await sem.inject({ url: PASTA, headers: A });
    expect(r.statusCode).toBe(501);
    await sem.close();
  });
});

describe('API — Pasta digital: a movimentação de cada peça (v0.33.2) e a posição do ato (v0.34.0)', () => {
  const ato = (numero: number, titulo: string, extra = {}) => ({
    data: new Date('2026-09-28T13:00:00Z'),
    titulo,
    idExterno: `mni:${numero}`,
    fonte: 'mni',
    ...extra,
  });

  it('devolve, por peça, o ato do tribunal (data e texto como está, sem número) — sem consulta nova', async () => {
    provedor.movimentos = [
      ato(1, 'Juntada de Petição de Impugnação — ev. 382', {
        complementos: ['tipo_de_documento: petição', 'ref: 12'],
      }),
    ];
    await carregarPecas();
    const antes = provedor.chamadas.length;
    const c = await pasta();
    const porId = Object.fromEntries(c.pecas.map((p) => [p.pecaId, p]));
    // Com número e complemento: as duas peças do mesmo ato repetem a descrição.
    for (const id of ['a', 'b']) {
      expect(porId[id]?.['movimentacao']).toEqual({
        posicao: 1,
        // Sem calibração o número é a posição, dita como tal (v0.35.0).
        numero: { tipo: 'posicao', n: 1 },
        data: '2026-09-28T13:00:00.000Z',
        descricao: 'Juntada de Petição de Impugnação — ev. 382',
        complemento: 'tipo_de_documento: petição; ref: 12',
      });
    }
    // O identificador interno nunca sai como número: `numero` é o objeto com o
    // grau de certeza, e a chave interna não aparece em lugar nenhum.
    expect(JSON.stringify(porId['a']?.['movimentacao'])).not.toContain('identificador');
    // Sem vínculo: sem bloco, e a procedência segue em toda resposta.
    for (const id of ['h', 'c', 's']) expect(porId[id]?.['movimentacao']).toBeNull();
    expect(c['procedencia']).toMatchObject({ aoVivo: false });
    expect(provedor.chamadas.length).toBe(antes);
  });

  it('o identificador interno do tribunal nunca sai como número (regressão da v0.33.2)', async () => {
    provedor.movimentos = [
      ato(516017862, 'Juntada de Petição de Impugnação'),
    ];
    provedor.pecas = provedor.pecas.map((p) =>
      p.id === 'a' ? { ...p, movimento: 516017862 } : p,
    );
    await carregarPecas();
    const c = await pasta();
    const a = c.pecas.find((p) => p.pecaId === 'a');
    expect(a?.['movimentacao']).toMatchObject({
      descricao: 'Juntada de Petição de Impugnação',
      posicao: 1,
    });
    expect(JSON.stringify(c.pecas.map((p) => p['movimentacao']))).not.toContain('516017862');
  });

  it('a posição segue a ordem cronológica, mesmo com os atos fora de ordem na resposta', async () => {
    const em = (dia: number): Date => new Date(Date.UTC(2026, 8, dia, 13, 0, 0));
    provedor.pecas = provedor.pecas.map((p) =>
      p.id === 'a' ? { ...p, movimento: 900000003 } : p.id === 'b' ? { ...p, movimento: 900000001 } : p,
    );
    // Cronologia: 900000001 (dia 1), 900000002 (dia 5), 900000003 (dia 9).
    provedor.movimentos = [
      ato(900000003, 'Terceiro', { data: em(9) }),
      ato(900000001, 'Primeiro', { data: em(1) }),
      ato(900000002, 'Segundo', { data: em(5) }),
    ];
    await carregarPecas();
    const c = await pasta();
    expect(c['totalAtosRecebidos']).toBe(3);
    const porId = Object.fromEntries(c.pecas.map((p) => [p.pecaId, p]));
    expect(porId['a']?.['movimentacao']).toMatchObject({ posicao: 3 });
    expect(porId['b']?.['movimentacao']).toMatchObject({ posicao: 1 });
  });

  it('desempate estável: atos na mesma dataHora ordenam pelo identificador, não pela ordem da resposta', async () => {
    provedor.pecas = provedor.pecas.map((p) =>
      p.id === 'a' ? { ...p, movimento: 20 } : p.id === 'b' ? { ...p, movimento: 10 } : p,
    );
    const mesmaHora = new Date('2026-09-28T13:00:00Z');
    provedor.movimentos = [
      ato(20, 'Vinte', { data: mesmaHora }),
      ato(10, 'Dez', { data: mesmaHora }),
    ];
    await carregarPecas();
    let c = await pasta();
    expect(c.pecas.find((p) => p.pecaId === 'b')?.['movimentacao']).toMatchObject({ posicao: 1 });
    expect(c.pecas.find((p) => p.pecaId === 'a')?.['movimentacao']).toMatchObject({ posicao: 2 });
    // A ordem em que o tribunal respondeu não muda o resultado.
    provedor.movimentos = [...provedor.movimentos].reverse();
    await carregarPecas();
    c = await pasta();
    expect(c.pecas.find((p) => p.pecaId === 'b')?.['movimentacao']).toMatchObject({ posicao: 1 });
    expect(c.pecas.find((p) => p.pecaId === 'a')?.['movimentacao']).toMatchObject({ posicao: 2 });
  });

  it('totalAtosRecebidos conta TODOS os atos da resposta, também os sem peça — e fica nulo sem listagem ou sem atos', async () => {
    expect((await pasta())['totalAtosRecebidos']).toBeNull(); // nada carregado
    provedor.movimentos = [ato(1, 'Um'), ato(2, 'Dois', { data: new Date('2026-09-29T13:00:00Z') }), ato(3, 'Três', { data: new Date('2026-09-30T13:00:00Z') })];
    await carregarPecas();
    expect((await pasta())['totalAtosRecebidos']).toBe(3);
    provedor.movimentos = [];
    await carregarPecas();
    const vazio = await pasta();
    expect(vazio['totalAtosRecebidos']).toBeNull();
    expect(vazio.pecas.every((p) => p['movimentacao'] === null)).toBe(true);
  });

  it('lacuna (o sistema recebe um ato a menos que o Projudi): a posição continua sendo a dos atos recebidos', async () => {
    // O Projudi teria 4 atos; o MNI entrega 3 (um bloqueado entre o 1º e o 2º).
    // A API só sabe de 3 — e diz 3, para a tela avisar.
    provedor.pecas = provedor.pecas.map((p) =>
      p.id === 'a' ? { ...p, movimento: 7 } : p,
    );
    provedor.movimentos = [
      ato(5, 'Primeiro', { data: new Date('2026-09-01T13:00:00Z') }),
      ato(6, 'Segundo recebido', { data: new Date('2026-09-10T13:00:00Z') }),
      ato(7, 'Terceiro recebido', { data: new Date('2026-09-20T13:00:00Z') }),
    ];
    await carregarPecas();
    const c = await pasta();
    expect(c['totalAtosRecebidos']).toBe(3);
    expect(c.pecas.find((p) => p.pecaId === 'a')?.['movimentacao']).toMatchObject({ posicao: 3 });
  });

  it('sem complemento o campo vem nulo; peça que aponta ato que o tribunal não listou fica sem bloco', async () => {
    provedor.movimentos = [ato(1, 'Distribuição')];
    await carregarPecas();
    const c = await pasta();
    expect(c.pecas.find((p) => p.pecaId === 'a')?.['movimentacao']).toMatchObject({
      descricao: 'Distribuição',
      complemento: null,
    });
    // Peça cujo `movimento` não existe na resposta: só um lado do vínculo.
    provedor.movimentos = [ato(99, 'Outro ato')];
    await carregarPecas();
    const d = await pasta();
    expect(d.pecas.every((p) => p['movimentacao'] === null)).toBe(true);
  });

  it('número repetido na resposta não vira vínculo: descrição errada é pior que nenhuma', async () => {
    provedor.movimentos = [ato(1, 'Primeiro ato'), ato(1, 'Segundo ato')];
    await carregarPecas();
    const c = await pasta();
    expect(c.pecas.every((p) => p['movimentacao'] === null)).toBe(true);
    // Sem vínculo confiável, sem posição — mas o total recebido continua dito.
    expect(c['totalAtosRecebidos']).toBe(2);
  });

  it('o ato do A nunca aparece para o B — cada workspace lê a SUA listagem', async () => {
    provedor.movimentos = [ato(1, 'Ato visto pela advogada A')];
    await carregarPecas(A);
    // B ainda não carregou: não herda a listagem (nem o texto) do A.
    const vazio = await pasta(B);
    expect(vazio['listagem']).toBeNull();
    expect(JSON.stringify(vazio)).not.toContain('advogada A');

    provedor.movimentos = [ato(1, 'Ato visto pelo advogado B')];
    await carregarPecas(B);
    const doB = await pasta(B);
    const doA = await pasta(A);
    expect(doB.pecas.find((p) => p.pecaId === 'a')?.['movimentacao']).toMatchObject({
      descricao: 'Ato visto pelo advogado B',
    });
    expect(doA.pecas.find((p) => p.pecaId === 'a')?.['movimentacao']).toMatchObject({
      descricao: 'Ato visto pela advogada A',
    });
    expect(JSON.stringify(doA)).not.toContain('advogado B');
  });

  it('posição e total do A nunca vazam para o B', async () => {
    provedor.movimentos = [ato(1, 'Ato do A'), ato(2, 'Outro do A', { data: new Date('2026-09-29T13:00:00Z') })];
    await carregarPecas(A);
    const doB = await pasta(B);
    expect(doB['totalAtosRecebidos']).toBeNull();
    expect(doB.pecas).toEqual([]);
    provedor.movimentos = [ato(1, 'Ato do B')];
    await carregarPecas(B);
    expect((await pasta(B))['totalAtosRecebidos']).toBe(1);
    expect((await pasta(A))['totalAtosRecebidos']).toBe(2);
  });
});
