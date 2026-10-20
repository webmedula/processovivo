import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { NUMERO_TJSP_A, NUMERO_TJSP_B, ProviderFalso } from '../helpers/fabricas.js';

/* Valores, descrições e nomes sintéticos; relógio fixo e controlado pelo teste. */

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };
const WS_A = workspaceDaChave(CHAVE_A);
const SENHA = 'uma-senha-boa-o-bastante';

let servidor: FastifyInstance;
let app: Aplicacao;

beforeEach(() => {
  app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    agora: () => new Date('2026-10-20T15:00:00.000Z'),
  });
  servidor = construirServidor(
    app,
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      CACHE_ENABLED: 'false',
      COOKIE_SECURE: 'false',
      PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
      RATE_LIMIT_MAX: '10000',
    } as NodeJS.ProcessEnv),
  );
});
afterEach(async () => {
  await servidor.close();
});

const novo = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  data: '2026-10-15',
  descricao: 'Guia de custas iniciais',
  categoria: 'CUS-020',
  valorCentavos: 12_345,
  reembolsavel: true,
  ...extra,
});

function lancar(
  corpo: Record<string, unknown> = novo(),
  h: Record<string, string> = A,
  numero = NUMERO_TJSP_A,
): Promise<LightMyRequestResponse> {
  return servidor.inject({
    method: 'POST',
    url: `/v1/processos/${numero}/custos`,
    headers: h,
    payload: corpo,
  });
}

function listar(
  h: Record<string, string> = A,
  numero = NUMERO_TJSP_A,
): Promise<LightMyRequestResponse> {
  return servidor.inject({
    method: 'GET',
    url: `/v1/processos/${numero}/custos`,
    headers: h,
  });
}

async function conta(email: string): Promise<{ cookie: string; workspace: string }> {
  const r = await servidor.inject({
    method: 'POST',
    url: '/v1/contas',
    payload: { nome: 'Advogada Sintética', email, senha: SENHA },
  });
  const bruto = r.headers['set-cookie'];
  const linha = Array.isArray(bruto) ? bruto[0] : bruto;
  const cookie = String(linha ?? '').split(';')[0] ?? '';
  const achado = await app.usuarios.porEmail(email);
  return { cookie, workspace: achado!.usuario.workspace };
}

describe('Custos — lançar, listar, editar e cancelar', () => {
  it('lança e lista, do mais recente para o mais antigo, com os totais calculados no servidor', async () => {
    expect(
      (await lancar(novo({ data: '2026-10-01', valorCentavos: 1_000 }))).statusCode,
    ).toBe(201);
    expect(
      (
        await lancar(
          novo({
            data: '2026-10-10',
            valorCentavos: 2_500,
            reembolsavel: false,
            categoria: 'OUT-001',
          }),
        )
      ).statusCode,
    ).toBe(201);
    await lancar(novo({ data: '2026-10-05', valorCentavos: 300 }));

    const r = await listar();
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.lancamentos.map((l: { data: string }) => l.data)).toEqual([
      '2026-10-10',
      '2026-10-05',
      '2026-10-01',
    ]);
    expect(j.totais).toMatchObject({
      quantidade: 3,
      totalDespesasCentavos: 3_800,
      pagoPeloEscritorioCentavos: 3_800,
      pagoPeloClienteCentavos: 0,
      totalReembolsavelCentavos: 1_300,
      totalRecebidoCentavos: 0,
      saldoACobrarCentavos: 1_300,
      creditoDoClienteCentavos: 0,
    });
    expect(j.totais.porCategoria[0]).toMatchObject({
      categoria: 'OUT-001',
      nome: 'Outras despesas › Despesa processual não classificada',
      totalCentavos: 2_500,
    });
    expect(j.lancamentos[0]).toMatchObject({
      grupo: '12',
      deposito: false,
      pagoPor: 'escritorio',
    });
    expect(j.grupos).toHaveLength(10);
    expect(j.limites).toMatchObject({
      lancamentosPorProcesso: 500,
      categoriasProprias: 60,
      recebimentosPorProcesso: 500,
    });
    // O número com ou sem máscara é o mesmo processo.
    const semMascara = await listar(A, NUMERO_TJSP_A.replace(/\D/g, ''));
    expect(semMascara.json().lancamentos).toHaveLength(3);
  });

  it('edita um lançamento e devolve o recalculado', async () => {
    const id = (await lancar()).json().id as string;
    const r = await servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/${id}`,
      headers: A,
      payload: {
        descricao: 'Guia complementar',
        valorCentavos: 9_999,
        reembolsavel: false,
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      descricao: 'Guia complementar',
      valorCentavos: 9_999,
      reembolsavel: false,
    });
    expect((await listar()).json().totais.totalReembolsavelCentavos).toBe(0);
  });

  it('não existe rota para apagar: DELETE do lançamento não é aceito e nada some', async () => {
    const id = (await lancar()).json().id as string;
    const r = await servidor.inject({
      method: 'DELETE',
      url: `/v1/custos/${id}`,
      headers: A,
    });
    expect([404, 405]).toContain(r.statusCode);
    expect((await listar()).json().lancamentos).toHaveLength(1);
  });

  it('cancela: some da lista e dos totais, fica guardado com o motivo, e reativa', async () => {
    const id = (await lancar(novo({ valorCentavos: 10_000 }))).json().id as string;
    await lancar(novo({ valorCentavos: 5_000 }));

    const c = await servidor.inject({
      method: 'POST',
      url: `/v1/custos/${id}/cancelamento`,
      headers: A,
      payload: { motivo: 'Processo errado' },
    });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({
      cancelado: true,
      motivoDoCancelamento: 'Processo errado',
    });

    const escondido = (await listar()).json();
    expect(escondido.lancamentos).toHaveLength(1);
    expect(escondido.canceladosEscondidos).toBe(1);
    expect(escondido.totais).toMatchObject({
      totalDespesasCentavos: 5_000,
      totalReembolsavelCentavos: 5_000,
    });

    const todos = (
      await servidor.inject({
        method: 'GET',
        url: `/v1/processos/${NUMERO_TJSP_A}/custos?cancelados=true`,
        headers: A,
      })
    ).json();
    expect(todos.lancamentos).toHaveLength(2);
    expect(todos.canceladosEscondidos).toBe(0);
    // Mostrar os cancelados NÃO os põe nos totais.
    expect(todos.totais.totalDespesasCentavos).toBe(5_000);

    // Cancelar de novo é idempotente; editar cancelado é recusado até reativar.
    expect(
      (
        await servidor.inject({
          method: 'POST',
          url: `/v1/custos/${id}/cancelamento`,
          headers: A,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const edita = await servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/${id}`,
      headers: A,
      payload: { descricao: 'x' },
    });
    expect(edita.statusCode).toBe(400);

    const r = await servidor.inject({
      method: 'DELETE',
      url: `/v1/custos/${id}/cancelamento`,
      headers: A,
    });
    expect(r.json()).toMatchObject({ cancelado: false, motivoDoCancelamento: null });
    expect((await listar()).json().totais.totalDespesasCentavos).toBe(15_000);
  });

  it('motivo com mais de 200 caracteres é 400 e nada é cancelado', async () => {
    const id = (await lancar()).json().id as string;
    const r = await servidor.inject({
      method: 'POST',
      url: `/v1/custos/${id}/cancelamento`,
      headers: A,
      payload: { motivo: 'm'.repeat(201) },
    });
    expect(r.statusCode).toBe(400);
    expect((await listar()).json().lancamentos).toHaveLength(1);
  });

  it('despesa paga pelo cliente não gera reembolsável nem saldo, mesmo pedindo "cobrar"', async () => {
    const r = await lancar(
      novo({ pagoPor: 'cliente', reembolsavel: true, valorCentavos: 8_000 }),
    );
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ pagoPor: 'cliente', reembolsavel: false });
    const t = (await listar()).json().totais;
    expect(t).toMatchObject({
      totalDespesasCentavos: 8_000,
      pagoPeloClienteCentavos: 8_000,
      pagoPeloEscritorioCentavos: 0,
      totalReembolsavelCentavos: 0,
      saldoACobrarCentavos: 0,
    });
    expect((await lancar(novo({ pagoPor: 'banco' }))).statusCode).toBe(400);
  });

  it('depósito (Grupo 08) fica fora do total de despesas, em bloco à parte; cobrado, entra no saldo', async () => {
    await lancar(novo({ valorCentavos: 1_000 }));
    await lancar(
      novo({ categoria: 'DEP-001', valorCentavos: 50_000, reembolsavel: true }),
    );
    await lancar(
      novo({ categoria: 'DEP-003', valorCentavos: 7_000, reembolsavel: false }),
    );
    const j = (await listar()).json();
    expect(j.totais).toMatchObject({
      totalDespesasCentavos: 1_000,
      totalReembolsavelCentavos: 51_000,
      reembolsavelDeDepositosCentavos: 50_000,
      saldoACobrarCentavos: 51_000,
    });
    expect(j.totais.depositos).toMatchObject({ quantidade: 2, totalCentavos: 57_000 });
    expect(j.lancamentos.filter((l: { deposito: boolean }) => l.deposito)).toHaveLength(
      2,
    );
  });

  it('códigos da 0.47.0 ainda são aceitos e viram o código novo (compatibilidade)', async () => {
    const r = await lancar(novo({ categoria: 'publicacoes' }));
    expect(r.statusCode).toBe(201);
    expect(r.json().categoria).toBe('DIL-010');
  });

  it('o histórico registra criar, editar (valor anterior e novo), cancelar e reativar, em ordem', async () => {
    const id = (await lancar(novo({ valorCentavos: 10_000 }))).json().id as string;
    await servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/${id}`,
      headers: A,
      payload: { valorCentavos: 12_500, categoria: 'PER-001' },
    });
    await servidor.inject({
      method: 'POST',
      url: `/v1/custos/${id}/cancelamento`,
      headers: A,
      payload: { motivo: 'engano' },
    });
    await servidor.inject({
      method: 'DELETE',
      url: `/v1/custos/${id}/cancelamento`,
      headers: A,
    });
    const h = (
      await servidor.inject({
        method: 'GET',
        url: `/v1/custos/${id}/historico`,
        headers: A,
      })
    ).json();
    expect(h.eventos.map((e: { operacao: string }) => e.operacao)).toEqual([
      'criou',
      'editou',
      'cancelou',
      'reativou',
    ]);
    expect(h.eventos[1].campos).toEqual([
      { campo: 'valor', rotulo: 'Valor', de: 'R$ 100,00', para: 'R$ 125,00' },
      {
        campo: 'categoria',
        rotulo: 'Subcategoria',
        de: 'Custas e taxas judiciais › Outras custas judiciais',
        para: 'Perícias e avaliações › Honorários de perito judicial',
      },
    ]);
    expect(h.eventos[2].motivo).toBe('engano');
    // Edição sem mudança não gera evento.
    await servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/${id}`,
      headers: A,
      payload: { valorCentavos: 12_500 },
    });
    const depois = (
      await servidor.inject({
        method: 'GET',
        url: `/v1/custos/${id}/historico`,
        headers: A,
      })
    ).json();
    expect(depois.eventos).toHaveLength(4);
  });

  it('o histórico é só de acréscimo: o repositório nem tem como alterar ou apagar um evento', () => {
    const fonte = readFileSync(
      resolve(
        __dirname,
        '../../src/infrastructure/persistencia/sqlite/RepositorioDeCustosSqlite.ts',
      ),
      'utf8',
    );
    expect(fonte).not.toMatch(/UPDATE\s+historico_custos/i);
    expect(fonte).not.toMatch(/DELETE\s+FROM\s+historico_custos/i);
    // E nenhum lançamento ou recebimento é apagado: só a exclusão da conta apaga, por loop de tabelas.
    expect(fonte).not.toMatch(
      /DELETE\s+FROM\s+(custos_processo|recebimentos_processo)\s+WHERE\s+workspace\s*=\s*\?\s+AND/i,
    );
  });
});

describe('Custos — recebimentos do cliente', () => {
  function receber(
    corpo: Record<string, unknown>,
    h: Record<string, string> = A,
  ): Promise<LightMyRequestResponse> {
    return servidor.inject({
      method: 'POST',
      url: `/v1/processos/${NUMERO_TJSP_A}/recebimentos`,
      headers: h,
      payload: corpo,
    });
  }

  it('abate o saldo, é parcial e múltiplo; o excedente vira crédito, nunca saldo negativo', async () => {
    await lancar(novo({ valorCentavos: 10_000 }));
    await lancar(novo({ valorCentavos: 5_000 }));
    expect((await receber({ data: '2026-10-18', valorCentavos: 4_000 })).statusCode).toBe(
      201,
    );
    let t = (await listar()).json().totais;
    expect(t).toMatchObject({
      totalRecebidoCentavos: 4_000,
      saldoACobrarCentavos: 11_000,
      creditoDoClienteCentavos: 0,
    });

    await receber({ data: '2026-10-19', valorCentavos: 11_000, observacao: 'Pix' });
    t = (await listar()).json().totais;
    expect(t).toMatchObject({ saldoACobrarCentavos: 0, creditoDoClienteCentavos: 0 });

    await receber({ data: '2026-10-20', valorCentavos: 1 });
    t = (await listar()).json().totais;
    expect(t).toMatchObject({
      totalRecebidoCentavos: 15_001,
      saldoACobrarCentavos: 0,
      creditoDoClienteCentavos: 1,
    });
    const j = (await listar()).json();
    expect(j.recebimentos).toHaveLength(3);
    expect(j.recebimentos[0]).toMatchObject({ data: '2026-10-20', cancelado: false });
  });

  it.each([
    ['valor zero', { valorCentavos: 0 }],
    ['valor negativo', { valorCentavos: -1 }],
    ['fração de centavo', { valorCentavos: 10.5 }],
    ['acima do teto', { valorCentavos: 100_000_001 }],
    ['data inexistente', { data: '2026-02-30' }],
    ['observação longa', { observacao: 'o'.repeat(201) }],
    ['campo desconhecido', { semNexo: 1 }],
  ])('recusa recebimento com %s e não grava nada', async (_n, extra) => {
    const r = await receber({ data: '2026-10-18', valorCentavos: 100, ...extra });
    expect(r.statusCode).toBe(400);
    expect((await listar()).json().recebimentos).toEqual([]);
  });

  it('edita, cancela (sai dos totais), reativa e deixa tudo no histórico', async () => {
    const id = (await receber({ data: '2026-10-18', valorCentavos: 1_000 })).json()
      .id as string;
    await lancar(novo({ valorCentavos: 5_000 }));
    const ed = await servidor.inject({
      method: 'PATCH',
      url: `/v1/recebimentos/${id}`,
      headers: A,
      payload: { valorCentavos: 2_000, observacao: 'complemento' },
    });
    expect(ed.json()).toMatchObject({ valorCentavos: 2_000, observacao: 'complemento' });
    expect((await listar()).json().totais.saldoACobrarCentavos).toBe(3_000);

    await servidor.inject({
      method: 'POST',
      url: `/v1/recebimentos/${id}/cancelamento`,
      headers: A,
      payload: {},
    });
    let j = (await listar()).json();
    expect(j.recebimentos).toEqual([]);
    expect(j.canceladosEscondidos).toBe(1);
    expect(j.totais.saldoACobrarCentavos).toBe(5_000);

    await servidor.inject({
      method: 'DELETE',
      url: `/v1/recebimentos/${id}/cancelamento`,
      headers: A,
    });
    j = (await listar()).json();
    expect(j.recebimentos).toHaveLength(1);
    expect(j.totais.saldoACobrarCentavos).toBe(3_000);

    const h = (
      await servidor.inject({
        method: 'GET',
        url: `/v1/recebimentos/${id}/historico`,
        headers: A,
      })
    ).json();
    expect(h.eventos.map((e: { operacao: string }) => e.operacao)).toEqual([
      'criou',
      'editou',
      'cancelou',
      'reativou',
    ]);
    expect(h.eventos[1].campos[0]).toMatchObject({
      campo: 'valor',
      de: 'R$ 10,00',
      para: 'R$ 20,00',
    });
  });

  it('a rota do ressarcimento por lançamento da 0.47.0 não existe mais', async () => {
    const id = (await lancar()).json().id as string;
    const r = await servidor.inject({
      method: 'PUT',
      url: `/v1/custos/${id}/ressarcimento`,
      headers: A,
      payload: {},
    });
    expect([404, 405]).toContain(r.statusCode);
    expect((await lancar(novo({ ressarcidoEm: '2026-10-18' }))).statusCode).toBe(400);
  });

  it('o teto é de 500 recebimentos por processo, e reativar também respeita', async () => {
    for (let i = 0; i < 500; i++) {
      await app.custos.registrarRecebimento(WS_A, NUMERO_TJSP_A, {
        data: '2026-10-01',
        valorCentavos: 100,
      });
    }
    const r = await receber({ data: '2026-10-18', valorCentavos: 100 });
    expect(r.statusCode).toBe(422);
    expect(r.json().detalhes).toEqual({ limite: 'recebimentos' });
  }, 60_000);
});

describe('Custos — valores e entrada', () => {
  it.each([
    ['zero', { valorCentavos: 0 }],
    ['negativo', { valorCentavos: -100 }],
    ['fração de centavo', { valorCentavos: 10.5 }],
    ['gigante', { valorCentavos: 1e15 }],
    ['acima do teto de R$ 1.000.000,00', { valorCentavos: 100_000_001 }],
    ['texto no lugar do número', { valorCentavos: '12,34' }],
    ['nulo', { valorCentavos: null }],
    ['descrição vazia', { descricao: '   ' }],
    ['descrição com mais de 200 caracteres', { descricao: 'x'.repeat(201) }],
    ['data inexistente', { data: '2026-02-30' }],
    ['data em outro formato', { data: '15/10/2026' }],
    ['categoria que não existe', { categoria: 'inventada' }],
    ['ressarcimento por lançamento (extinto na 0.48.0)', { ressarcidoEm: '2026-10-10' }],
    ['categoria própria de outra conta', { categoria: 'c-nao-existe' }],
    ['campo desconhecido (corpo estrito)', { semNexo: 1 }],
  ])('recusa %s com 400 e sem gravar nada', async (_nome, extra) => {
    const r = await lancar(novo(extra));
    expect(r.statusCode).toBe(400);
    expect((await listar()).json().lancamentos).toEqual([]);
  });

  it('aceita o teto exato e R$ 0,01', async () => {
    expect((await lancar(novo({ valorCentavos: 100_000_000 }))).statusCode).toBe(201);
    expect((await lancar(novo({ valorCentavos: 1 }))).statusCode).toBe(201);
  });

  it('número de processo inválido é 400, sem tocar no banco', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/processos/123/custos',
      headers: A,
    });
    expect(r.statusCode).toBe(400);
  });

  it('a mensagem de erro não devolve o valor nem a descrição enviados', async () => {
    const r = await lancar(
      novo({ descricao: 'x'.repeat(201), valorCentavos: 77_700_077 }),
    );
    expect(r.body).not.toContain('xxxxxxxx');
    expect(r.body).not.toContain('77700077');
  });

  it('limita 500 lançamentos por processo, com mensagem clara; outro processo não é afetado', async () => {
    for (let i = 0; i < 500; i++) {
      await app.custos.criar(WS_A, NUMERO_TJSP_A, {
        data: '2026-10-01',
        descricao: `Lançamento ${i}`,
        categoria: 'OUT-001',
        valorCentavos: 100,
        reembolsavel: false,
      });
    }
    const r = await lancar();
    expect(r.statusCode).toBe(422);
    expect(r.json().detalhes).toEqual({ limite: 'lancamentos' });
    expect(r.json().mensagem).toContain('500');
    expect((await lancar(novo(), A, NUMERO_TJSP_B)).statusCode).toBe(201);
  }, 60_000);
});

describe('Custos — subcategorias próprias', () => {
  async function criarCategoria(
    nome: string,
    h = A,
    grupo?: string,
  ): Promise<LightMyRequestResponse> {
    return servidor.inject({
      method: 'POST',
      url: '/v1/custos/categorias',
      headers: h,
      payload: grupo ? { nome, grupo } : { nome },
    });
  }
  const patch = (id: string, payload: Record<string, unknown>, h = A) =>
    servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/categorias/${id}`,
      headers: h,
      payload,
    });

  it('lista as 45 pré-cadastradas; cria uma própria (grupo 12 por padrão) e usa em um lançamento', async () => {
    const antes = (
      await servidor.inject({ method: 'GET', url: '/v1/custos/categorias', headers: A })
    ).json();
    expect(antes.categorias).toHaveLength(45);
    expect(antes.categorias.every((c: { base: boolean }) => c.base)).toBe(true);
    expect(antes.grupos).toHaveLength(10);

    const nova = await criarCategoria('Cartório do 2º ofício');
    expect(nova.statusCode).toBe(201);
    expect(nova.json()).toMatchObject({ grupo: '12', deposito: false });
    const codigo = nova.json().codigo as string;
    expect(codigo.startsWith('c-')).toBe(true);

    expect((await lancar(novo({ categoria: codigo }))).statusCode).toBe(201);
    const j = (await listar()).json();
    expect(j.categorias).toHaveLength(46);
    expect(j.totais.porCategoria[0]).toMatchObject({
      categoria: codigo,
      nome: 'Outras despesas › Cartório do 2º ofício',
    });
  });

  it('o nome é único DENTRO do grupo (sem acento nem caixa) e não repete a pré-cadastrada do grupo', async () => {
    expect((await criarCategoria('taxa judiciaria', A, '01')).statusCode).toBe(400);
    expect((await criarCategoria('taxa judiciaria', A, '12')).statusCode).toBe(201);
    expect((await criarCategoria('  TAXA   judiciária ', A, '12')).statusCode).toBe(400);
    // O mesmo nome em outro grupo é outra subcategoria.
    expect((await criarCategoria('Taxa X', A, '03')).statusCode).toBe(201);
    expect((await criarCategoria('Taxa X', A, '11')).statusCode).toBe(201);
    expect((await criarCategoria('')).statusCode).toBe(400);
    expect((await criarCategoria('y'.repeat(61))).statusCode).toBe(400);
    expect((await criarCategoria('Ok', A, '09')).statusCode).toBe(400);
    expect((await criarCategoria('Ok', A, '10')).statusCode).toBe(400);
  });

  it('arquiva em vez de excluir: o lançamento antigo mantém o nome; lançamento novo não a usa', async () => {
    const codigo = (await criarCategoria('Taxa de cartório')).json().codigo as string;
    const id = (await lancar(novo({ categoria: codigo }))).json().id as string;

    const arquivada = await patch(codigo.slice(2), { arquivada: true });
    expect(arquivada.json().arquivada).toBe(true);

    const j = (await listar()).json();
    expect(
      j.categorias.find((c: { codigo: string }) => c.codigo === codigo),
    ).toMatchObject({ nome: 'Taxa de cartório', arquivada: true });
    expect((await lancar(novo({ categoria: codigo }))).statusCode).toBe(400);
    // Editar o lançamento antigo, sem trocar de categoria, continua valendo.
    const ed = await servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/${id}`,
      headers: A,
      payload: { descricao: 'Ajuste', categoria: codigo },
    });
    expect(ed.statusCode).toBe(200);
  });

  it('criar de novo o nome de uma arquivada do mesmo grupo a reativa', async () => {
    const codigo = (await criarCategoria('Taxa Y')).json().codigo as string;
    await patch(codigo.slice(2), { arquivada: true });
    const de_novo = await criarCategoria('Taxa Y');
    expect(de_novo.statusCode).toBe(201);
    expect(de_novo.json()).toMatchObject({ codigo, arquivada: false });
  });

  it('pode mover a própria de grupo; para o Grupo 08 só se ainda não tem lançamento', async () => {
    const livre = (await criarCategoria('Caução X')).json().codigo as string;
    const movida = await patch(livre.slice(2), { grupo: '08' });
    expect(movida.json()).toMatchObject({ grupo: '08', deposito: true });
    // Já com lançamento, mudar de natureza reclassificaria totais já prestados: recusado.
    const usada = (await criarCategoria('Usada Z')).json().codigo as string;
    await lancar(novo({ categoria: usada }));
    const recusa = await patch(usada.slice(2), { grupo: '08' });
    expect(recusa.statusCode).toBe(400);
    // Entre grupos de despesa, pode.
    expect((await patch(usada.slice(2), { grupo: '03' })).json().grupo).toBe('03');
    // Nome repetido no grupo de destino é recusado; corpo vazio e grupo inválido também.
    await criarCategoria('Dup', A, '12');
    const dup = (await criarCategoria('Dup', A, '11')).json().codigo as string;
    expect((await patch(dup.slice(2), { grupo: '12' })).statusCode).toBe(400);
    expect((await patch(dup.slice(2), {})).statusCode).toBe(400);
    expect((await patch(dup.slice(2), { grupo: '99' })).statusCode).toBe(400);
  });

  it('limita 60 subcategorias próprias ativas; arquivar uma abre vaga', async () => {
    for (let i = 0; i < 60; i++)
      expect((await criarCategoria(`Categoria ${i}`)).statusCode).toBe(201);
    const estouro = await criarCategoria('Uma a mais');
    expect(estouro.statusCode).toBe(422);
    expect(estouro.json().detalhes).toEqual({ limite: 'categorias' });
    const primeira = (
      await servidor.inject({ method: 'GET', url: '/v1/custos/categorias', headers: A })
    )
      .json()
      .categorias.find((c: { nome: string }) => c.nome === 'Categoria 0');
    await patch(String(primeira.codigo).slice(2), { arquivada: true });
    expect((await criarCategoria('Uma a mais')).statusCode).toBe(201);
  });
});

describe('Custos — isolamento entre contas', () => {
  it('uma conta não vê, edita, cancela nem lê o histórico de lançamento ou recebimento de outra', async () => {
    const id = (await lancar()).json().id as string;

    expect((await listar(B)).json().lancamentos).toEqual([]);
    expect((await listar(B)).json().totais.totalDespesasCentavos).toBe(0);

    const edita = await servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/${id}`,
      headers: B,
      payload: { descricao: 'invadido' },
    });
    const cancela = await servidor.inject({
      method: 'POST',
      url: `/v1/custos/${id}/cancelamento`,
      headers: B,
      payload: {},
    });
    const historico = await servidor.inject({
      method: 'GET',
      url: `/v1/custos/${id}/historico`,
      headers: B,
    });
    const recId = (
      await servidor.inject({
        method: 'POST',
        url: `/v1/processos/${NUMERO_TJSP_A}/recebimentos`,
        headers: A,
        payload: { data: '2026-10-18', valorCentavos: 100 },
      })
    ).json().id as string;
    const recEdita = await servidor.inject({
      method: 'PATCH',
      url: `/v1/recebimentos/${recId}`,
      headers: B,
      payload: { valorCentavos: 1 },
    });
    const recCancela = await servidor.inject({
      method: 'POST',
      url: `/v1/recebimentos/${recId}/cancelamento`,
      headers: B,
      payload: {},
    });
    const recReativa = await servidor.inject({
      method: 'DELETE',
      url: `/v1/recebimentos/${recId}/cancelamento`,
      headers: B,
    });
    const recHistorico = await servidor.inject({
      method: 'GET',
      url: `/v1/recebimentos/${recId}/historico`,
      headers: B,
    });
    // Mesma resposta de "não existe": ninguém confirma um id alheio.
    for (const r of [
      edita,
      cancela,
      historico,
      recEdita,
      recCancela,
      recReativa,
      recHistorico,
    ]) {
      expect(r.statusCode).toBe(404);
      expect(r.json().erro).toBe('CUSTO_NAO_ENCONTRADO');
    }
    const a = (await listar(A)).json().lancamentos[0];
    expect(a).toMatchObject({ descricao: 'Guia de custas iniciais', cancelado: false });
    expect((await listar(A)).json().recebimentos[0]).toMatchObject({
      valorCentavos: 100,
      cancelado: false,
    });
    expect((await listar(B)).json().recebimentos).toEqual([]);
  });

  it('subcategoria própria de uma conta não existe para outra', async () => {
    const codigo = (
      await servidor.inject({
        method: 'POST',
        url: '/v1/custos/categorias',
        headers: A,
        payload: { nome: 'Só da A' },
      })
    ).json().codigo as string;
    expect((await lancar(novo({ categoria: codigo }), B)).statusCode).toBe(400);
    const arquiva = await servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/categorias/${codigo.slice(2)}`,
      headers: B,
      payload: { arquivada: true },
    });
    expect(arquiva.statusCode).toBe(404);
    const dasB = (
      await servidor.inject({ method: 'GET', url: '/v1/custos/categorias', headers: B })
    ).json();
    expect(dasB.categorias).toHaveLength(45);
  });

  it('o PDF de uma conta nunca traz lançamento de outra', async () => {
    await lancar(novo({ descricao: 'Só da conta A' }));
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${NUMERO_TJSP_A}/custos/prestacao.pdf`,
      headers: B,
    });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.includes(Buffer.from('Só da conta A'))).toBe(false);
  });
});

describe('Custos — autenticação, plano e conta de chave', () => {
  it('sem credencial é 401', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${NUMERO_TJSP_A}/custos`,
    });
    expect(r.statusCode).toBe(401);
  });

  it('a conta de chave de API (sem assinatura) usa o recurso, como nos demais', async () => {
    expect(await app.repositorioAssinaturas.porWorkspace(WS_A)).toBeUndefined();
    expect((await lancar()).statusCode).toBe(201);
  });

  it('funciona com sessão (cookie) e a conta nova — no teste de 14 dias — já tem o recurso', async () => {
    const { cookie, workspace } = await conta('ana@escritorio.com.br');
    // O teste de 14 dias: a mesma assinatura que o cadastro cria, no plano do teste.
    const teste = await app.assinaturas.criarTeste(workspace);
    expect(teste.statusEm(new Date('2026-10-20T15:00:00Z'))).toBe('teste');
    const r = await servidor.inject({
      method: 'POST',
      url: `/v1/processos/${NUMERO_TJSP_A}/custos`,
      headers: { cookie },
      payload: novo(),
    });
    expect(r.statusCode).toBe(201);
    const l = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${NUMERO_TJSP_A}/custos`,
      headers: { cookie },
    });
    expect(l.json().lancamentos).toHaveLength(1);
  });

  it('sessão e chave de API que resolvem para workspaces diferentes não se misturam', async () => {
    const { cookie } = await conta('ana@escritorio.com.br');
    await servidor.inject({
      method: 'POST',
      url: `/v1/processos/${NUMERO_TJSP_A}/custos`,
      headers: { cookie },
      payload: novo(),
    });
    expect((await listar(A)).json().lancamentos).toEqual([]);
  });

  it('plano que não inclui o recurso é 403; assinatura cancelada é 402', async () => {
    const { cookie, workspace } = await conta('bia@escritorio.com.br');
    await app.assinaturas.liberar({ workspace, plano: 'pecas', meses: 1 });
    const get = (): Promise<LightMyRequestResponse> =>
      servidor.inject({
        method: 'GET',
        url: `/v1/processos/${NUMERO_TJSP_A}/custos`,
        headers: { cookie },
      });

    expect((await get()).statusCode).toBe(200);

    const codigoDoPlano = (await app.repositorioAssinaturas.porWorkspace(workspace))!
      .plano;
    const plano = await app.planos.porCodigo(codigoDoPlano);
    await app.planos.atualizar(codigoDoPlano, {
      recursos: plano.recursos.filter((r) => r !== 'custosDoProcesso'),
    });
    const sem = await get();
    expect(sem.statusCode).toBe(403);
    // Só o centro de custos é barrado: o resto do plano segue igual.
    expect(
      (
        await servidor.inject({
          method: 'GET',
          url: '/v1/calendario/feed',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    for (const [metodo, url] of [
      ['POST', `/v1/processos/${NUMERO_TJSP_A}/custos`],
      ['GET', `/v1/processos/${NUMERO_TJSP_A}/custos/totais`],
      ['GET', `/v1/processos/${NUMERO_TJSP_A}/custos/prestacao.pdf`],
      ['GET', '/v1/custos/categorias'],
      ['POST', `/v1/processos/${NUMERO_TJSP_A}/recebimentos`],
    ] as const) {
      const r = await servidor.inject({
        method: metodo,
        url,
        headers: { cookie },
        ...(metodo === 'POST'
          ? {
              payload: url.endsWith('/recebimentos')
                ? { data: '2026-10-18', valorCentavos: 100 }
                : novo(),
            }
          : {}),
      });
      expect(r.statusCode, `${metodo} ${url}`).toBe(403);
    }

    await app.planos.atualizar(codigoDoPlano, { recursos: plano.recursos });
    expect((await get()).statusCode).toBe(200);
    await app.assinaturas.cancelar(workspace);
    expect((await get()).statusCode).toBe(402);
  });
});

describe('Custos — o processo e a conta', () => {
  it('deixar de acompanhar o processo mantém os lançamentos', async () => {
    await servidor.inject({
      method: 'POST',
      url: '/v1/acompanhamentos',
      headers: A,
      payload: { numero: NUMERO_TJSP_A },
    });
    await lancar();
    const parar = await servidor.inject({
      method: 'DELETE',
      url: `/v1/acompanhamentos/${encodeURIComponent(NUMERO_TJSP_A)}`,
      headers: A,
    });
    expect(parar.statusCode).toBeLessThan(300);
    expect((await listar()).json().lancamentos).toHaveLength(1);
  });

  it('processo nunca acompanhado também recebe lançamentos', async () => {
    expect((await lancar(novo(), A, NUMERO_TJSP_B)).statusCode).toBe(201);
  });

  it('apagar a conta (apagarDoWorkspace) leva lançamentos, recebimentos, categorias e histórico, e só os dela', async () => {
    await lancar();
    await servidor.inject({
      method: 'POST',
      url: '/v1/custos/categorias',
      headers: A,
      payload: { nome: 'Minha' },
    });
    await lancar(novo(), B);
    await servidor.inject({
      method: 'POST',
      url: `/v1/processos/${NUMERO_TJSP_A}/recebimentos`,
      headers: A,
      payload: { data: '2026-10-18', valorCentavos: 100 },
    });
    const n = await app.custos.apagarDoWorkspace(WS_A);
    // lançamento + recebimento + categoria + 2 eventos de histórico (criou lançamento, criou recebimento).
    expect(n).toBe(5);
    expect((await listar(A)).json().lancamentos).toEqual([]);
    expect(
      (
        await servidor.inject({ method: 'GET', url: '/v1/custos/categorias', headers: A })
      ).json().categorias,
    ).toHaveLength(45);
    expect((await listar(B)).json().lancamentos).toHaveLength(1);
  });

  it('os custos NÃO aparecem em /v1/novidades, no painel nem no calendário', async () => {
    await lancar(
      novo({ descricao: 'DESCRICAO-SECRETA-DE-CUSTO', valorCentavos: 7_654_321 }),
    );
    for (const url of ['/v1/novidades', '/v1/painel', '/v1/acompanhamentos']) {
      const r = await servidor.inject({ method: 'GET', url, headers: A });
      expect(r.body).not.toContain('DESCRICAO-SECRETA-DE-CUSTO');
      expect(r.body).not.toContain('7654321');
    }
  });
});

describe('Custos — a tela não cresce o script do console e o servidor não loga dado', () => {
  it('nenhuma rota de custos loga valor, descrição ou nome', () => {
    const fonte = [
      '../../src/main/http/rotas/custos.ts',
      '../../src/application/services/ServicoCustos.ts',
      '../../src/infrastructure/persistencia/sqlite/RepositorioDeCustosSqlite.ts',
    ]
      .map((f) => readFileSync(resolve(__dirname, f), 'utf8'))
      .join('\n');
    const chamadasDeLog = fonte.match(/logger\.\w+\([^)]*\)/g) ?? [];
    for (const c of chamadasDeLog) {
      expect(c).not.toMatch(/valor|descricao|nome|categoria|cliente/i);
    }
  });
});
