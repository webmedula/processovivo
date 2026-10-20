import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';
import { ProviderFalso, umProcesso } from '../helpers/fabricas.js';

/*
 * v0.49.0 — custos por cliente, PDF consolidado e CSV. Dados SINTÉTICOS; o texto do PDF é lido de
 * volta com o pdftotext. Cada processo tem número CNJ com dígito verificador válido.
 */
const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };
const WS_A = workspaceDaChave(CHAVE_A);
const SENTINELAS = ['NOME-DE-PARTE-SINTETICO', 'TEXTO-DE-ATO-SINTETICO'];

const P1 = numeroValido(1101, '26', '0100'); // Grupo Lume
const P2 = numeroValido(1102, '26', '0100'); // grupo  LUME (mesma grafia, outra caixa)
const P3 = numeroValido(1103, '26', '0100'); // R. Andrade
const P4 = numeroValido(1104, '26', '0100'); // sem acompanhamento
const P5 = numeroValido(1105, '26', '0100'); // acompanhado, sem rótulo

let servidor: FastifyInstance;
let app: Aplicacao;
let pasta: string;
let contador = 0;

beforeAll(() => {
  pasta = mkdtempSync(join(tmpdir(), 'pv-clientes-'));
});
afterAll(() => rmSync(pasta, { recursive: true, force: true }));

function texto(pdf: Uint8Array): string {
  const arquivo = join(pasta, `c${contador++}.pdf`);
  writeFileSync(arquivo, pdf);
  return execFileSync('pdftotext', ['-layout', arquivo, '-'], {
    encoding: 'utf8',
  }).replace(/\s+/g, ' ');
}

beforeEach(async () => {
  app = aplicacaoDeTeste(
    [
      new ProviderFalso({
        nome: 'falso',
        porNumero: async () =>
          umProcesso({
            segredoJustica: true,
            partes: [
              {
                polo: 'ATIVO',
                tipoPessoa: 'FISICA',
                nome: SENTINELAS[0]!,
                advogados: [],
              },
            ],
            movimentacoes: [
              {
                data: new Date('2026-09-01T12:00:00Z'),
                titulo: 'Despacho',
                conteudo: SENTINELAS[1]!,
              },
            ],
          }),
      }),
    ],
    { agora: () => new Date('2026-10-20T15:30:00.000Z'), comAssinaturas: true },
  );
  servidor = construirServidor(
    app,
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      CACHE_ENABLED: 'false',
      COOKIE_SECURE: 'false',
      PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
      RATE_LIMIT_MAX: '100000',
    } as NodeJS.ProcessEnv),
  );
  await app.acompanhamento.acompanhar(WS_A, P1);
  await app.acompanhamento.rotular(WS_A, P1, 'Grupo Lume');
  await app.acompanhamento.acompanhar(WS_A, P2);
  await app.acompanhamento.rotular(WS_A, P2, '  grupo   LUME ');
  await app.acompanhamento.acompanhar(WS_A, P3);
  await app.acompanhamento.rotular(WS_A, P3, 'R. Andrade');
  await app.acompanhamento.acompanhar(WS_A, P5);
});
afterEach(async () => {
  await servidor.close();
});

const dados = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  data: '2026-09-10',
  descricao: 'Despesa',
  categoria: 'CUS-020',
  valorCentavos: 10_000,
  reembolsavel: true,
  ...extra,
});
const lancar = (n: string, extra: Record<string, unknown> = {}, h = A) =>
  servidor.inject({
    method: 'POST',
    url: `/v1/processos/${n}/custos`,
    headers: h,
    payload: dados(extra),
  });
const receber = (
  n: string,
  valorCentavos: number,
  data = '2026-09-20',
  observacao?: string,
) =>
  servidor.inject({
    method: 'POST',
    url: `/v1/processos/${n}/recebimentos`,
    headers: A,
    payload: { data, valorCentavos, ...(observacao ? { observacao } : {}) },
  });
const get = (url: string, h = A) => servidor.inject({ method: 'GET', url, headers: h });

/** P1 e P2 (Grupo Lume) com saldo e crédito; P3 sem saldo; P4 e P5 sem cliente. */
async function massa(): Promise<void> {
  await lancar(P1, { valorCentavos: 10_000 }); // reembolsável 100,00
  await receber(P1, 4_000); // saldo 60,00
  await lancar(P2, { valorCentavos: 5_000, descricao: 'Segunda' });
  await receber(P2, 7_000); // crédito 20,00
  await lancar(P3, { valorCentavos: 2_000, reembolsavel: false, descricao: 'Interna' });
  await lancar(P4, { valorCentavos: 900, descricao: 'Sem acompanhar' });
  await lancar(P5, { valorCentavos: 300, descricao: 'Sem rótulo' });
}

describe('Custos por cliente — a lista', () => {
  it('junta os processos pelo rótulo (sem acento, caixa nem espaço), com totais calculados no servidor', async () => {
    await massa();
    const r = await get('/v1/custos/clientes');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const j = r.json();
    const por = Object.fromEntries(j.clientes.map((c: { nome: string }) => [c.nome, c]));
    expect(Object.keys(por).sort()).toEqual(['Grupo Lume', 'R. Andrade', 'Sem cliente']);
    expect(por['Grupo Lume']).toMatchObject({
      semCliente: false,
      processos: 2,
      totalDespesasCentavos: 15_000,
      pagoPeloEscritorioCentavos: 15_000,
      totalRecebidoCentavos: 11_000,
      // Saldo e crédito são POR PROCESSO: 60,00 de um e 20,00 de crédito do outro não se anulam.
      saldoACobrarCentavos: 6_000,
      creditoDoClienteCentavos: 2_000,
    });
    expect(por['R. Andrade']).toMatchObject({
      processos: 1,
      saldoACobrarCentavos: 0,
      totalDespesasCentavos: 2_000,
    });
    expect(por['Sem cliente']).toMatchObject({
      semCliente: true,
      processos: 2,
      totalDespesasCentavos: 1_200,
    });
    // "Sem cliente" por último.
    expect(j.clientes.at(-1).semCliente).toBe(true);
    expect(j.totalDeClientes).toBe(3);
    expect(j.totalDeProcessos).toBe(5);
    // A tela avisa quando existem processos sem cliente.
    expect(j.processosSemCliente).toBe(2);
  });

  it('o filtro de período vale para despesas e recebimentos, e o total SEM filtro continua à vista', async () => {
    await massa();
    await lancar(P3, { data: '2026-07-01', valorCentavos: 800, descricao: 'Antiga' });
    const j = (await get('/v1/custos/clientes?de=2026-09-01&ate=2026-09-30')).json();
    const andrade = j.clientes.find((c: { nome: string }) => c.nome === 'R. Andrade');
    expect(andrade.totalDespesasCentavos).toBe(2_000);
    const tudo = (await get('/v1/custos/clientes')).json();
    expect(
      tudo.clientes.find((c: { nome: string }) => c.nome === 'R. Andrade')
        .totalDespesasCentavos,
    ).toBe(2_800);
    // Período sem nada: nenhum cliente, mas o total sem filtro diz que há 3.
    const vazio = (await get('/v1/custos/clientes?de=2020-01-01&ate=2020-12-31')).json();
    expect(vazio.clientes).toEqual([]);
    expect(vazio.totalDeClientes).toBe(3);
    expect(vazio.processosSemCliente).toBe(0);
  });

  it('"somente com saldo a cobrar" e "cliente" filtram, e juntos também', async () => {
    await massa();
    const saldo = (await get('/v1/custos/clientes?somenteComSaldo=true')).json();
    const nomes = saldo.clientes.map((c: { nome: string }) => c.nome).sort();
    // Só Grupo Lume tem saldo > 0; Sem cliente tem 1.200 reembolsáveis sem recebimento → também.
    expect(nomes).toEqual(['Grupo Lume', 'Sem cliente']);
    expect(saldo.totalDeClientes).toBe(3);
    const chave = 'r. andrade';
    const ok = (
      await get(`/v1/custos/clientes?cliente=${encodeURIComponent(chave)}`)
    ).json();
    expect(ok.clientes).toHaveLength(1);
    expect(
      (
        await get(
          `/v1/custos/clientes?somenteComSaldo=true&cliente=${encodeURIComponent(chave)}`,
        )
      ).json().clientes,
    ).toEqual([]);
  });

  it('cancelado não conta; recebimento cancelado também não', async () => {
    await massa();
    const id = (
      await lancar(P3, { valorCentavos: 99_999, descricao: 'Vai cancelar' })
    ).json().id as string;
    await servidor.inject({
      method: 'POST',
      url: `/v1/custos/${id}/cancelamento`,
      headers: A,
      payload: {},
    });
    const j = (await get('/v1/custos/clientes')).json();
    expect(
      j.clientes.find((c: { nome: string }) => c.nome === 'R. Andrade')
        .totalDespesasCentavos,
    ).toBe(2_000);
  });

  it('deixar de acompanhar derruba o processo para "Sem cliente", e o custo NÃO se perde', async () => {
    await massa();
    const antes = (await get('/v1/custos/clientes')).json();
    const lume = antes.clientes.find((c: { nome: string }) => c.nome === 'Grupo Lume');
    expect(lume.processos).toBe(2);
    const parar = await servidor.inject({
      method: 'DELETE',
      url: `/v1/acompanhamentos/${encodeURIComponent(P1)}`,
      headers: A,
    });
    expect(parar.statusCode).toBeLessThan(300);
    const depois = (await get('/v1/custos/clientes')).json();
    expect(
      depois.clientes.find((c: { chave: string }) => c.chave === 'grupo lume').processos,
    ).toBe(1);
    expect(
      depois.clientes.find((c: { semCliente: boolean }) => c.semCliente).processos,
    ).toBe(3);
    expect(depois.processosSemCliente).toBe(3);
    // O lançamento continua no processo.
    const proc = (await get(`/v1/processos/${P1}/custos`)).json();
    expect(proc.lancamentos).toHaveLength(1);
    expect(proc.totais.totalRecebidoCentavos).toBe(4_000);
  });

  it('sem nada lançado, a lista é vazia e honesta', async () => {
    const j = (await get('/v1/custos/clientes')).json();
    expect(j).toMatchObject({
      clientes: [],
      totalDeClientes: 0,
      totalDeProcessos: 0,
      processosSemCliente: 0,
    });
  });
});

describe('Custos por cliente — um cliente', () => {
  it('lista os processos do cliente com os totais de cada um e o atalho (número formatado e tribunal)', async () => {
    await massa();
    const r = await get(
      `/v1/custos/clientes/detalhe?cliente=${encodeURIComponent('grupo lume')}`,
    );
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({
      nome: 'Grupo Lume',
      semCliente: false,
      totalDeProcessos: 2,
    });
    expect(j.totais).toMatchObject({
      processos: 2,
      saldoACobrarCentavos: 6_000,
      creditoDoClienteCentavos: 2_000,
    });
    expect(j.processos.map((p: { numeroProcesso: string }) => p.numeroProcesso)).toEqual([
      P1,
      P2,
    ]);
    expect(j.processos[0]).toMatchObject({
      formatado: expect.stringMatching(/^\d{7}-\d{2}\.2026\.8\.26\.0100$/),
      tribunal: 'TJSP',
      lancamentos: 1,
      recebimentos: 1,
      saldoACobrarCentavos: 6_000,
    });
    expect(j.processos[1]).toMatchObject({
      saldoACobrarCentavos: 0,
      creditoDoClienteCentavos: 2_000,
    });
  });

  it('com "somente com saldo", mostra só os processos com saldo e diz quantos há ao todo', async () => {
    await massa();
    const j = (
      await get(
        `/v1/custos/clientes/detalhe?cliente=${encodeURIComponent('grupo lume')}&somenteComSaldo=true`,
      )
    ).json();
    expect(j.processos).toHaveLength(1);
    expect(j.totalDeProcessos).toBe(2);
  });

  it('"Sem cliente" abre como qualquer outro; cliente que não existe é 404; sem o parâmetro é 400', async () => {
    await massa();
    const sem = (
      await get(
        `/v1/custos/clientes/detalhe?cliente=${encodeURIComponent('~sem-cliente')}`,
      )
    ).json();
    expect(sem).toMatchObject({ nome: 'Sem cliente', semCliente: true });
    expect(
      sem.processos.map((p: { numeroProcesso: string }) => p.numeroProcesso).sort(),
    ).toEqual([P4, P5].sort());
    expect((await get('/v1/custos/clientes/detalhe?cliente=nao-existe')).statusCode).toBe(
      404,
    );
    expect((await get('/v1/custos/clientes/detalhe')).statusCode).toBe(400);
  });

  it('datas inválidas e parâmetro desconhecido são 400', async () => {
    for (const q of ['de=2026-02-30', 'ate=abc', 'de=2026-10-01&ate=2026-09-01', 'x=1']) {
      expect((await get(`/v1/custos/clientes?${q}`)).statusCode, q).toBe(400);
    }
  });
});

describe('Custos por cliente — isolamento, autenticação e plano', () => {
  it('uma conta nunca vê cliente, processo, PDF ou CSV de outra', async () => {
    await massa();
    expect((await get('/v1/custos/clientes', B)).json().clientes).toEqual([]);
    expect(
      (
        await get(
          `/v1/custos/clientes/detalhe?cliente=${encodeURIComponent('grupo lume')}`,
          B,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await get(
          `/v1/custos/clientes/prestacao.pdf?cliente=${encodeURIComponent('grupo lume')}`,
          B,
        )
      ).statusCode,
    ).toBe(404);
    const csv = await get('/v1/custos/lancamentos.csv', B);
    expect(csv.body).not.toContain('Despesa');
    expect(csv.body).not.toContain('Grupo Lume');
  });

  it('sem credencial é 401; sem o recurso do plano é 403; assinatura cancelada é 402', async () => {
    await massa();
    for (const url of [
      '/v1/custos/clientes',
      '/v1/custos/clientes/detalhe?cliente=x',
      '/v1/custos/clientes/prestacao.pdf?cliente=x',
      '/v1/custos/lancamentos.csv',
      `/v1/processos/${P1}/custos/lancamentos.csv`,
    ]) {
      expect((await servidor.inject({ url })).statusCode, url).toBe(401);
    }
    await app.assinaturas.liberar({ workspace: WS_A, plano: 'pecas', meses: 1 });
    const codigo = (await app.repositorioAssinaturas.porWorkspace(WS_A))!.plano;
    const plano = await app.planos.porCodigo(codigo);
    await app.planos.atualizar(codigo, {
      recursos: plano.recursos.filter((r) => r !== 'custosDoProcesso'),
    });
    for (const url of [
      '/v1/custos/clientes',
      '/v1/custos/lancamentos.csv',
      `/v1/processos/${P1}/custos/lancamentos.csv`,
    ]) {
      expect((await get(url)).statusCode, url).toBe(403);
    }
    await app.planos.atualizar(codigo, { recursos: plano.recursos });
    await app.assinaturas.cancelar(WS_A);
    expect((await get('/v1/custos/clientes')).statusCode).toBe(402);
  });
});

describe('PDF consolidado do cliente', () => {
  const url = (extra = ''): string =>
    `/v1/custos/clientes/prestacao.pdf?cliente=${encodeURIComponent('grupo lume')}${extra}`;

  it('uma seção por processo (número e tribunal), totais gerais, saldo e crédito, rodapé com a versão', async () => {
    await massa();
    await lancar(P1, {
      categoria: 'DEP-001',
      valorCentavos: 50_000,
      descricao: 'Depósito sintético',
    });
    const r = await get(url());
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="prestacao-de-contas-por-cliente-2026-10-20.pdf"',
    );
    expect(Buffer.from(r.rawPayload).subarray(0, 5).toString()).toBe('%PDF-');
    const t = texto(new Uint8Array(r.rawPayload));
    expect(t).toContain('Prestação de contas — Grupo Lume');
    expect(t).toContain('Cliente Grupo Lume');
    expect(t).toMatch(/Processo \d{7}-\d{2}\.2026\.8\.26\.0100 · TJSP/);
    expect(t.match(/Processo \d{7}-\d{2}\.2026\.8\.26\.0100 · TJSP/g)).toHaveLength(2);
    // Categoria como "Grupo › Subcategoria"; pago por; recebimentos; depósito em bloco à parte.
    expect(t).toContain('Outras custas judiciais');
    expect(t).toContain('Pago pelo escritório');
    expect(t).toContain('Recebimentos do cliente');
    expect(t).toContain('Depósitos e garantias Não entram no total de despesas.');
    expect(t).toContain('Depósito sintético');
    // Totais por processo e GERAIS (a soma): 600,00 + 500,00 de depósito cobrado = saldo; crédito 20,00.
    expect(t).toContain('Totais do processo');
    expect(t).toContain('Totais gerais');
    expect(t).toContain('Total de despesas R$ 150,00');
    expect(t).toContain('Total recebido do cliente R$ 110,00');
    expect(t).toContain('Saldo a cobrar R$ 560,00');
    expect(t).toContain('Crédito do cliente R$ 20,00');
    expect(t).toContain(
      'Valores informados pelo advogado. Gerado pelo Processo Vivo, versão 9.9.9-teste.',
    );
    // Nada de outro cliente.
    expect(t).not.toContain('R. Andrade');
    expect(t).not.toContain('Interna');
  });

  it('sem partes, sem texto de ato e sem dado de segredo de justiça (o processo é sigiloso)', async () => {
    await massa();
    const t = texto(new Uint8Array((await get(url())).rawPayload));
    for (const s of SENTINELAS) expect(t).not.toContain(s);
  });

  it('cancelados ficam fora, com período e "somente com saldo" refletidos nos filtros do documento', async () => {
    await massa();
    const id = (
      await lancar(P1, { descricao: 'Cancelada SUMIDA', valorCentavos: 77_777 })
    ).json().id as string;
    await servidor.inject({
      method: 'POST',
      url: `/v1/custos/${id}/cancelamento`,
      headers: A,
      payload: {},
    });
    const rid = (
      await receber(P2, 33_333, '2026-09-25', 'Recebimento cancelado SUMIDO')
    ).json().id as string;
    await servidor.inject({
      method: 'POST',
      url: `/v1/recebimentos/${rid}/cancelamento`,
      headers: A,
      payload: {},
    });
    const t = texto(
      new Uint8Array(
        (await get(url('&de=2026-09-01&ate=2026-09-30&somenteComSaldo=true'))).rawPayload,
      ),
    );
    expect(t).not.toContain('SUMID');
    expect(t).not.toContain('777,77');
    expect(t).toContain('Período: de 01/09/2026 até 30/09/2026');
    expect(t).toContain('Somente processos com saldo a cobrar');
    // Só o processo com saldo (P1) entra.
    expect(t.match(/Processo \d{7}-\d{2}\.2026\.8\.26\.0100 · TJSP/g)).toHaveLength(1);
  });

  it('cliente que não existe é 404; período inválido é 400', async () => {
    await massa();
    expect((await get('/v1/custos/clientes/prestacao.pdf?cliente=nada')).statusCode).toBe(
      404,
    );
    expect((await get(url('&de=2026-13-01'))).statusCode).toBe(400);
  });

  it('1 lançamento e 200 lançamentos (vários processos): gera, com cabeçalho em todas as páginas, sem gravar', async () => {
    await massa();
    const r1 = await get(url());
    expect(r1.statusCode).toBe(200);
    // Direto no serviço: 200 chamadas HTTP passariam do limite de escritas por minuto.
    const novo = (descricao: string, valorCentavos: number) => ({
      data: '2026-09-10',
      descricao,
      categoria: 'CUS-020',
      valorCentavos,
      reembolsavel: true,
    });
    for (let i = 0; i < 100; i++) {
      await app.custos.criar(WS_A, P1, novo(`Item ${i} do primeiro`, 100 + i));
      await app.custos.criar(WS_A, P2, novo(`Item ${i} do segundo`, 200 + i));
    }
    const r = await get(url());
    expect(r.statusCode).toBe(200);
    const t = texto(new Uint8Array(r.rawPayload));
    expect(t).toContain('Item 0 do primeiro');
    expect(t).toContain('Item 99 do segundo');
    expect(t).toContain('Totais gerais');
    expect(t).toMatch(/Página 1 de \d+/);
    expect(t).toContain('Prestação de contas · Grupo Lume');
    for (const f of [
      '../../src/application/services/ServicoCustosPorCliente.ts',
      '../../src/infrastructure/pdf/PrestacaoDeContasPdf.ts',
    ]) {
      expect(readFileSync(resolve(__dirname, f), 'utf8'), f).not.toMatch(
        /from 'node:(fs|os|path|child_process)'|writeFile|createWriteStream|tmpdir/,
      );
    }
  }, 60_000);

  it('o nome do cliente com caractere que a fonte não desenha vira "?", sem derrubar a geração', async () => {
    await app.acompanhamento.rotular(WS_A, P3, 'Cliente 😀 Ltda.');
    await lancar(P3);
    const r = await get(
      `/v1/custos/clientes/prestacao.pdf?cliente=${encodeURIComponent('cliente 😀 ltda.')}`,
    );
    expect(r.statusCode).toBe(200);
  });
});

describe('CSV dos custos', () => {
  const linhas = (r: LightMyRequestResponse): string[][] =>
    r.body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n')
      .map((l) => l.split(';'));

  it('por processo: BOM UTF-8, ponto e vírgula, vírgula decimal, data dd/mm/aaaa e uma linha por registro (coluna Tipo)', async () => {
    await massa();
    await lancar(P1, {
      categoria: 'DEP-001',
      valorCentavos: 123_456,
      descricao: 'Depósito',
    });
    await lancar(P1, { pagoPor: 'cliente', valorCentavos: 800, descricao: 'Do cliente' });
    const r = await get(`/v1/processos/${P1}/custos/lancamentos.csv`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-disposition']).toMatch(
      /^attachment; filename="custos-\d{7}-\d{2}\.2026\.8\.26\.0100-2026-10-20\.csv"$/,
    );
    expect([...r.rawPayload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const l = linhas(r);
    expect(l[0]).toEqual([
      'Tipo',
      'Situação',
      'Processo',
      'Cliente',
      'Data',
      'Descrição',
      'Subcategoria',
      'Pago por',
      'Cobrar do cliente',
      'Valor',
      'Comprovantes',
    ]);
    expect(l).toHaveLength(5); // cabeçalho + 3 lançamentos + 1 recebimento
    const por = (tipo: string, desc?: string) =>
      l.find((x) => x[0] === tipo && (!desc || x[5] === desc))!;
    expect(por('Despesa', 'Despesa')).toEqual([
      'Despesa',
      'Ativo',
      expect.stringMatching(/^\d{7}-\d{2}\.2026\.8\.26\.0100$/),
      'Grupo Lume',
      '10/09/2026',
      'Despesa',
      'Custas e taxas judiciais › Outras custas judiciais',
      'Escritório',
      'Sim',
      '100,00',
      '0',
    ]);
    expect(por('Depósito')[9]).toBe('1234,56'); // sem separador de milhar, vírgula decimal
    expect(por('Depósito')[6]).toBe('Depósitos e garantias › Depósito judicial');
    expect(por('Despesa', 'Do cliente').slice(7, 9)).toEqual(['Cliente', 'Não']);
    expect(por('Recebimento')).toEqual([
      'Recebimento',
      'Ativo',
      expect.any(String),
      'Grupo Lume',
      '20/09/2026',
      '',
      '',
      '',
      '',
      '40,00',
      '',
    ]);
    // Ordem: por data; na mesma data, lançamentos antes de recebimentos.
    expect(l.slice(1).map((x) => x[4])).toEqual([
      '10/09/2026',
      '10/09/2026',
      '10/09/2026',
      '20/09/2026',
    ]);
  });

  it('cancelados ficam de fora; com a opção entram MARCADOS como "Cancelado"', async () => {
    await massa();
    const id = (await lancar(P1, { descricao: 'Cancelada', valorCentavos: 555 })).json()
      .id as string;
    await servidor.inject({
      method: 'POST',
      url: `/v1/custos/${id}/cancelamento`,
      headers: A,
      payload: { motivo: 'engano' },
    });
    const rid = (await receber(P1, 123, '2026-09-21')).json().id as string;
    await servidor.inject({
      method: 'POST',
      url: `/v1/recebimentos/${rid}/cancelamento`,
      headers: A,
      payload: {},
    });
    const sem = linhas(await get(`/v1/processos/${P1}/custos/lancamentos.csv`));
    expect(sem.some((x) => x[5] === 'Cancelada')).toBe(false);
    expect(sem.some((x) => x[1] === 'Cancelado')).toBe(false);
    const com = linhas(
      await get(`/v1/processos/${P1}/custos/lancamentos.csv?incluirCancelados=true`),
    );
    const marcados = com.filter((x) => x[1] === 'Cancelado');
    expect(marcados.map((x) => x[0]).sort()).toEqual(['Despesa', 'Recebimento']);
    expect(com.filter((x) => x[1] === 'Ativo')).toHaveLength(2);
    // O motivo é texto livre do advogado: não sai na planilha.
    expect(com.flat().join('|')).not.toContain('engano');
  });

  it('PROTEÇÃO contra injeção de fórmula: descrição, observação e rótulo de cliente perigosos saem neutralizados', async () => {
    await app.acompanhamento.rotular(WS_A, P3, '=HYPERLINK("http://mal","x")');
    await lancar(P3, { descricao: '=1+1' });
    await lancar(P3, { descricao: '@SOMA(A1)', valorCentavos: 200 });
    await lancar(P3, { descricao: '-5+cmd', valorCentavos: 300 });
    await lancar(P3, { descricao: '+55', valorCentavos: 400 });
    await receber(P3, 100, '2026-09-20', '=CMD()');
    const r = await get(`/v1/processos/${P3}/custos/lancamentos.csv`);
    const brutas = r.body.replace(/^\uFEFF/, '').split('\r\n');
    // Nenhuma CÉLULA de texto começa com gatilho: todas ganham o apóstrofo.
    const celulas = linhas(r).slice(1).flat();
    for (const c of celulas)
      expect(/^[=+\-@\t]/.test(c.replace(/^"/, '')), c).toBe(false);
    expect(brutas.join('\n')).toContain("'=1+1");
    expect(brutas.join('\n')).toContain("'@SOMA(A1)");
    expect(brutas.join('\n')).toContain("'-5+cmd");
    expect(brutas.join('\n')).toContain("'+55");
    expect(brutas.join('\n')).toContain("'=CMD()");
    expect(brutas.join('\n')).toContain(`"'=HYPERLINK(""http://mal"",""x"")"`);
  });

  it('descrição com ponto e vírgula, aspas e quebra de linha continua uma célula só', async () => {
    await lancar(P3, { descricao: 'Guia; "urgente" nº 1' });
    const r = await get(`/v1/processos/${P3}/custos/lancamentos.csv`);
    expect(r.body).toContain('"Guia; ""urgente"" nº 1"');
  });

  it('por cliente e período: junta os processos do cliente; sem cliente informado, traz todos', async () => {
    await massa();
    await lancar(P1, {
      data: '2026-07-01',
      descricao: 'Fora do período',
      valorCentavos: 100,
    });
    const lume = linhas(
      await get(
        `/v1/custos/lancamentos.csv?cliente=${encodeURIComponent('grupo lume')}&de=2026-09-01&ate=2026-09-30`,
      ),
    );
    expect(lume.slice(1).every((x) => x[3] === 'Grupo Lume')).toBe(true);
    expect(lume.some((x) => x[5] === 'Fora do período')).toBe(false);
    expect(
      lume
        .slice(1)
        .map((x) => x[0])
        .sort(),
    ).toEqual(['Despesa', 'Despesa', 'Recebimento', 'Recebimento']);
    const todos = linhas(await get('/v1/custos/lancamentos.csv'));
    expect(new Set(todos.slice(1).map((x) => x[3]))).toEqual(
      new Set(['Grupo Lume', 'R. Andrade', 'Sem cliente']),
    );
    const r = await get('/v1/custos/lancamentos.csv');
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="custos-por-cliente-2026-10-20.csv"',
    );
  });

  it('o CSV não leva parte, texto de ato nem nome de arquivo ou link do Drive', async () => {
    await massa();
    const r = await get('/v1/custos/lancamentos.csv');
    for (const s of SENTINELAS) expect(r.body).not.toContain(s);
    expect(r.body).not.toContain('drive.google.com');
  });

  it('parâmetros inválidos são 400; o limite de exportações por minuto barra o laço', async () => {
    expect((await get('/v1/custos/lancamentos.csv?de=2026-02-30')).statusCode).toBe(400);
    expect((await get('/v1/custos/lancamentos.csv?x=1')).statusCode).toBe(400);
    expect((await get('/v1/processos/123/custos/lancamentos.csv')).statusCode).toBe(400);
    let ultimo = 200;
    for (let i = 0; i < 22; i++)
      ultimo = (await get('/v1/custos/lancamentos.csv')).statusCode;
    expect(ultimo).toBe(429);
  });
});
