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
  categoria: 'custas',
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

describe('Custos — lançar, listar, editar e excluir', () => {
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
            categoria: 'outros',
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
      totalGastoCentavos: 3_800,
      totalReembolsavelCentavos: 1_300,
      totalRessarcidoCentavos: 0,
      saldoACobrarCentavos: 1_300,
    });
    expect(j.totais.porCategoria[0]).toMatchObject({
      categoria: 'outros',
      nome: 'Outros',
      totalCentavos: 2_500,
    });
    expect(j.limites).toMatchObject({
      lancamentosPorProcesso: 500,
      categoriasProprias: 30,
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

  it('exclui de vez: some da lista e uma segunda exclusão é 404', async () => {
    const id = (await lancar()).json().id as string;
    const r = await servidor.inject({
      method: 'DELETE',
      url: `/v1/custos/${id}`,
      headers: A,
    });
    expect(r.statusCode).toBe(204);
    expect((await listar()).json().lancamentos).toEqual([]);
    const outra = await servidor.inject({
      method: 'DELETE',
      url: `/v1/custos/${id}`,
      headers: A,
    });
    expect(outra.statusCode).toBe(404);
  });

  it('o desfazer da tela recria o lançamento como era, inclusive o ressarcimento', async () => {
    const id = (await lancar(novo({ ressarcidoEm: '2026-10-18' }))).json().id as string;
    await servidor.inject({ method: 'DELETE', url: `/v1/custos/${id}`, headers: A });
    const recriado = await lancar(novo({ ressarcidoEm: '2026-10-18' }));
    expect(recriado.statusCode).toBe(201);
    expect(recriado.json().ressarcidoEm).toBe('2026-10-18');
    expect((await listar()).json().totais.totalRessarcidoCentavos).toBe(12_345);
  });
});

describe('Custos — ressarcimento', () => {
  it('marca com a data de hoje (São Paulo) e desmarca; os totais acompanham', async () => {
    const id = (await lancar(novo({ valorCentavos: 10_000 }))).json().id as string;
    await lancar(novo({ valorCentavos: 5_000 }));

    const marcado = await servidor.inject({
      method: 'PUT',
      url: `/v1/custos/${id}/ressarcimento`,
      headers: A,
      payload: {},
    });
    expect(marcado.statusCode).toBe(200);
    expect(marcado.json().ressarcidoEm).toBe('2026-10-20');
    let t = (await listar()).json().totais;
    expect(t).toMatchObject({
      totalReembolsavelCentavos: 15_000,
      totalRessarcidoCentavos: 10_000,
      saldoACobrarCentavos: 5_000,
    });

    const desmarcado = await servidor.inject({
      method: 'DELETE',
      url: `/v1/custos/${id}/ressarcimento`,
      headers: A,
    });
    expect(desmarcado.json().ressarcidoEm).toBeNull();
    t = (await listar()).json().totais;
    expect(t).toMatchObject({ totalRessarcidoCentavos: 0, saldoACobrarCentavos: 15_000 });
  });

  it('aceita uma data informada e recusa data impossível', async () => {
    const id = (await lancar()).json().id as string;
    const url = `/v1/custos/${id}/ressarcimento`;
    const boa = await servidor.inject({
      method: 'PUT',
      url,
      headers: A,
      payload: { em: '2026-10-02' },
    });
    expect(boa.json().ressarcidoEm).toBe('2026-10-02');
    const ruim = await servidor.inject({
      method: 'PUT',
      url,
      headers: A,
      payload: { em: '2026-02-30' },
    });
    expect(ruim.statusCode).toBe(400);
  });

  it('despesa que não se cobra do cliente não pode ser ressarcida', async () => {
    const id = (await lancar(novo({ reembolsavel: false }))).json().id as string;
    const r = await servidor.inject({
      method: 'PUT',
      url: `/v1/custos/${id}/ressarcimento`,
      headers: A,
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().mensagem).toContain('Cobrar do cliente');
  });
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
        categoria: 'outros',
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

describe('Custos — categorias próprias', () => {
  async function criarCategoria(nome: string, h = A): Promise<LightMyRequestResponse> {
    return servidor.inject({
      method: 'POST',
      url: '/v1/custos/categorias',
      headers: h,
      payload: { nome },
    });
  }

  it('lista a base mais as próprias; cria e usa em um lançamento', async () => {
    const antes = (
      await servidor.inject({ method: 'GET', url: '/v1/custos/categorias', headers: A })
    ).json();
    expect(antes.categorias).toHaveLength(7);
    expect(antes.categorias.every((c: { base: boolean }) => c.base)).toBe(true);

    const nova = await criarCategoria('Cartório do 2º ofício');
    expect(nova.statusCode).toBe(201);
    const codigo = nova.json().codigo as string;
    expect(codigo.startsWith('c-')).toBe(true);

    expect((await lancar(novo({ categoria: codigo }))).statusCode).toBe(201);
    const j = (await listar()).json();
    expect(j.categorias).toHaveLength(8);
    expect(j.totais.porCategoria[0]).toMatchObject({
      categoria: codigo,
      nome: 'Cartório do 2º ofício',
    });
  });

  it('não repete a lista base nem outra categoria própria (sem acento e sem caixa)', async () => {
    expect((await criarCategoria('perícia')).statusCode).toBe(400);
    expect((await criarCategoria('Taxa X')).statusCode).toBe(201);
    expect((await criarCategoria('  taxa   x ')).statusCode).toBe(400);
    expect((await criarCategoria('')).statusCode).toBe(400);
    expect((await criarCategoria('y'.repeat(41))).statusCode).toBe(400);
  });

  it('arquiva em vez de excluir: o lançamento antigo mantém o nome; lançamento novo não a usa', async () => {
    const codigo = (await criarCategoria('Taxa de cartório')).json().codigo as string;
    const id = (await lancar(novo({ categoria: codigo }))).json().id as string;

    const arquivada = await servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/categorias/${codigo.slice(2)}`,
      headers: A,
      payload: { arquivada: true },
    });
    expect(arquivada.json().arquivada).toBe(true);

    const j = (await listar()).json();
    expect(
      j.categorias.find((c: { codigo: string }) => c.codigo === codigo),
    ).toMatchObject({
      nome: 'Taxa de cartório',
      arquivada: true,
    });
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

  it('criar de novo o nome de uma arquivada a reativa', async () => {
    const codigo = (await criarCategoria('Taxa Y')).json().codigo as string;
    await servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/categorias/${codigo.slice(2)}`,
      headers: A,
      payload: { arquivada: true },
    });
    const de_novo = await criarCategoria('Taxa Y');
    expect(de_novo.statusCode).toBe(201);
    expect(de_novo.json()).toMatchObject({ codigo, arquivada: false });
  });

  it('limita 30 categorias próprias ativas; arquivar uma abre vaga', async () => {
    for (let i = 0; i < 30; i++)
      expect((await criarCategoria(`Categoria ${i}`)).statusCode).toBe(201);
    const estouro = await criarCategoria('Uma a mais');
    expect(estouro.statusCode).toBe(422);
    expect(estouro.json().detalhes).toEqual({ limite: 'categorias' });
    const primeira = (
      await servidor.inject({ method: 'GET', url: '/v1/custos/categorias', headers: A })
    )
      .json()
      .categorias.find((c: { nome: string }) => c.nome === 'Categoria 0');
    await servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/categorias/${String(primeira.codigo).slice(2)}`,
      headers: A,
      payload: { arquivada: true },
    });
    expect((await criarCategoria('Uma a mais')).statusCode).toBe(201);
  });
});

describe('Custos — isolamento entre contas', () => {
  it('uma conta não vê, edita, ressarce nem apaga lançamento de outra', async () => {
    const id = (await lancar()).json().id as string;

    expect((await listar(B)).json().lancamentos).toEqual([]);
    expect((await listar(B)).json().totais.totalGastoCentavos).toBe(0);

    const edita = await servidor.inject({
      method: 'PATCH',
      url: `/v1/custos/${id}`,
      headers: B,
      payload: { descricao: 'invadido' },
    });
    const ressarce = await servidor.inject({
      method: 'PUT',
      url: `/v1/custos/${id}/ressarcimento`,
      headers: B,
      payload: {},
    });
    const apaga = await servidor.inject({
      method: 'DELETE',
      url: `/v1/custos/${id}`,
      headers: B,
    });
    // Mesma resposta de "não existe": ninguém confirma um id alheio.
    for (const r of [edita, ressarce, apaga]) {
      expect(r.statusCode).toBe(404);
      expect(r.json().erro).toBe('CUSTO_NAO_ENCONTRADO');
    }
    const a = (await listar(A)).json().lancamentos[0];
    expect(a).toMatchObject({ descricao: 'Guia de custas iniciais', ressarcidoEm: null });
  });

  it('categoria própria de uma conta não existe para outra', async () => {
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
    expect(dasB.categorias).toHaveLength(7);
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
    ] as const) {
      const r = await servidor.inject({
        method: metodo,
        url,
        headers: { cookie },
        ...(metodo === 'POST' ? { payload: novo() } : {}),
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

  it('apagar a conta (apagarDoWorkspace) leva lançamentos e categorias, e só os dela', async () => {
    await lancar();
    await servidor.inject({
      method: 'POST',
      url: '/v1/custos/categorias',
      headers: A,
      payload: { nome: 'Minha' },
    });
    await lancar(novo(), B);
    const n = await app.custos.apagarDoWorkspace(WS_A);
    expect(n).toBe(2);
    expect((await listar(A)).json().lancamentos).toEqual([]);
    expect(
      (
        await servidor.inject({ method: 'GET', url: '/v1/custos/categorias', headers: A })
      ).json().categorias,
    ).toHaveLength(7);
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
