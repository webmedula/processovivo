import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import {
  ATUAL,
  DESCONTINUADO,
  ExecutorFalso,
  NOVO,
  PENDENTE,
  SO_RESUMO,
  catalogoDeTeste,
  metricas,
} from '../helpers/modelosDeIa.js';

/*
 * Modelo por função e teste obrigatório, ponta a ponta pelo /admin (Fase B): só o operador, id forjado
 * nunca aceito, o fluxo estimar → testar → publicar → reverter, o registro e a garantia de que nenhuma
 * resposta leva texto de ato, parte, número de processo, e-mail, chave ou workspace.
 */

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const WS_A = workspaceDaChave(CHAVE_A);
const ADMIN_USUARIO = 'joao';
const ADMIN_SENHA = 'uma-senha-administrativa-bem-forte';
const EMAIL_DA_CONTA = 'maria.sintetica@escritorio.test';
const basic = (u: string, s: string): string =>
  'Basic ' + Buffer.from(`${u}:${s}`).toString('base64');
const ADMIN = { authorization: basic(ADMIN_USUARIO, ADMIN_SENHA) };
const AGORA = new Date('2026-10-26T12:00:00.000Z');

let app: Aplicacao;
let servidor: FastifyInstance;
let executor: ExecutorFalso;
let tudo: string[];

function config() {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    CACHE_ENABLED: 'false',
    PROCESSOVIVO_API_KEYS: CHAVE_A,
    RATE_LIMIT_MAX: '1000',
    COOKIE_SECURE: 'false',
  } as NodeJS.ProcessEnv);
}

function montar(comExecutor = true): void {
  executor = new ExecutorFalso();
  let n = 0;
  app = aplicacaoDeTeste(
    [new ProviderFalso({ nome: 'falso', porNumero: async () => umProcesso() })],
    {
      agora: () => AGORA,
      admin: { usuario: ADMIN_USUARIO, senha: ADMIN_SENHA },
      modelosDeIa: {
        catalogo: catalogoDeTeste(),
        doAmbiente: { ato: ATUAL, resumo: ATUAL, peca: ATUAL },
        ...(comExecutor ? { executor } : {}),
        novoId: () => `t-${++n}`,
      },
    },
  );
  servidor = construirServidor(app, config());
  tudo = [];
}

const chamar = async (
  metodo: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = ADMIN,
) => {
  const r = await servidor.inject({
    method: metodo,
    url,
    headers,
    ...(payload ? { payload } : {}),
  });
  tudo.push(r.body);
  return r;
};
const modelos = async () => (await chamar('GET', '/admin/api/ia/modelos')).json();
const daFuncao = async (f: string) =>
  (await modelos()).funcoes.find((x: { funcao: string }) => x.funcao === f);
const testar = async (f = 'ato', candidato = NOVO) => {
  const r = await chamar('POST', `/admin/api/ia/modelos/${f}/testes`, {
    candidato,
    confirmado: true,
  });
  await app.testeDeModelo.aguardarFim();
  return r;
};

afterEach(async () => {
  await servidor.close();
});

describe('quem acessa', () => {
  beforeEach(() => montar());

  it('sem credencial: 401 em toda rota nova, e nada é enviado ao modelo', async () => {
    for (const [metodo, url] of [
      ['GET', '/admin/api/ia/modelos'],
      ['POST', '/admin/api/ia/modelos/ato/estimativa'],
      ['POST', '/admin/api/ia/modelos/ato/testes'],
      ['GET', '/admin/api/ia/modelos/testes/t-1'],
      ['POST', '/admin/api/ia/modelos/testes/t-1/cancelar'],
      ['POST', '/admin/api/ia/modelos/ato/publicar'],
      ['POST', '/admin/api/ia/modelos/ato/reverter'],
    ] as const) {
      const r = await servidor.inject({
        method: metodo,
        url,
        payload: { candidato: NOVO, confirmado: true },
      });
      expect(r.statusCode, `${metodo} ${url}`).toBe(401);
      // o desafio do Basic Auth do /admin (e não o 401 do plugin do assinante) prova que a rota é DO /admin
      expect(r.headers['www-authenticate'], `${metodo} ${url}`).toMatch(/^Basic/);
    }
    expect(executor.execucoes).toHaveLength(0);
    expect(executor.estimativas).toHaveLength(0);
  });

  it('a chave de API de uma integração e a sessão de um assinante NÃO abrem nada', async () => {
    const c = await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: {
        nome: 'Maria Silva',
        email: EMAIL_DA_CONTA,
        senha: 'uma-senha-boa-o-bastante',
      },
    });
    const cookie = String(c.headers['set-cookie']).split(';')[0] as string;
    for (const h of [{ 'x-api-key': CHAVE_A }, { cookie }]) {
      expect(
        (
          await servidor.inject({
            method: 'GET',
            url: '/admin/api/ia/modelos',
            headers: h,
          })
        ).statusCode,
      ).toBe(401);
      const r = await servidor.inject({
        method: 'POST',
        url: '/admin/api/ia/modelos/ato/testes',
        headers: h,
        payload: { candidato: NOVO, confirmado: true },
      });
      expect(r.statusCode).toBe(401);
    }
    expect(executor.execucoes).toHaveLength(0);
  });

  it('o /v1 do assinante não tem rota de modelos', async () => {
    const r = await servidor.inject({
      method: 'POST',
      url: '/v1/ia/modelos/ato/testes',
      headers: { 'x-api-key': CHAVE_A },
      payload: { candidato: NOVO },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('o que a tela lê', () => {
  beforeEach(() => montar());

  it('traz, por função, o modelo em uso e de onde vem, só os candidatos válidos, as regras e o aviso fixo', async () => {
    const m = await modelos();
    expect(m.testeDisponivel).toBe(true);
    expect(m.aviso).toBe(
      'Para incluir um modelo novo na lista é preciso uma alteração de código e revisão da Política de Privacidade.',
    );
    expect(m.regras).toMatchObject({
      citacaoVerificadaMinima: 0.95,
      falhasDeFormatoMaxPp: 2,
      quedaDePontosMaxPp: 3,
      aumentoDaLatenciaP95Max: 0.3,
      tetoDaRodadaUsd: 1,
      validadeDoTesteHoras: 24,
      palavraDeConfirmacao: 'PUBLICAR',
    });
    expect(m.funcoes.map((f: { funcao: string }) => f.funcao)).toEqual([
      'ato',
      'resumo',
      'peca',
    ]);
    const ato = m.funcoes[0];
    expect(ato.efetivo).toMatchObject({
      modelo: ATUAL,
      origem: 'ambiente',
      painelInvalido: false,
    });
    // descontinuado, pendente e o próprio modelo em uso nunca são oferecidos
    expect(ato.candidatos.map((c: { id: string }) => c.id).sort()).toEqual(
      [NOVO, SO_RESUMO].filter((x) => x !== SO_RESUMO),
    );
    expect(
      (await daFuncao('resumo')).candidatos.map((c: { id: string }) => c.id).sort(),
    ).toEqual([NOVO, SO_RESUMO].sort());
    expect(ato.candidatos[0]).toMatchObject({
      precoEntradaPorMTokens: 0.2,
      janelaContexto: 128000,
    });
    expect(ato.podeReverter).toBe(false);
    expect(ato.ultimoTeste).toBeNull();
  });

  it('sem executor (IA desligada no ambiente) a tela é informada e o teste é recusado com 503', async () => {
    await servidor.close();
    montar(false);
    expect((await modelos()).testeDisponivel).toBe(false);
    const r = await chamar('POST', '/admin/api/ia/modelos/ato/testes', {
      candidato: NOVO,
      confirmado: true,
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().detalhes.motivo).toBe('teste_indisponivel');
  });
});

describe('id forjado nunca é aceito', () => {
  beforeEach(() => montar());

  it.each([
    ['fora da lista', 'fabrica-z/inventado'],
    ['descontinuado', DESCONTINUADO],
    ['pendente de confirmação', PENDENTE],
    ['de outra função', SO_RESUMO],
    ['apelido', '~fabrica/modelo-latest'],
    ['com script', '<script>alert(1)</script>'],
  ])('%s: 400 sem repetir o valor e sem enviar nada', async (_n, id) => {
    for (const url of ['estimativa', 'testes']) {
      const r = await chamar('POST', `/admin/api/ia/modelos/ato/${url}`, {
        candidato: id,
        ...(url === 'testes' ? { confirmado: true } : {}),
      });
      expect(r.statusCode, url).toBe(400);
      expect(r.json().detalhes.motivo).toBe('modelo_fora_da_lista');
      expect(r.body).not.toContain(id);
    }
    expect(executor.execucoes).toHaveLength(0);
    expect(executor.estimativas).toHaveLength(0);
  });

  it('corpo com campo a mais ou função desconhecida: 400', async () => {
    expect(
      (
        await chamar('POST', '/admin/api/ia/modelos/ato/testes', {
          candidato: NOVO,
          confirmado: true,
          extra: 1,
        })
      ).statusCode,
    ).toBe(400);
    const r = await chamar('POST', '/admin/api/ia/modelos/inventada/testes', {
      candidato: NOVO,
      confirmado: true,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().detalhes.motivo).toBe('funcao_desconhecida');
  });
});

describe('estimar → testar → publicar → reverter', () => {
  beforeEach(() => montar());

  it('o fluxo inteiro, com o registro de cada passo', async () => {
    executor.chamadas = 96;
    executor.custoEstimadoUsd = 0.08;
    const e = await chamar('POST', '/admin/api/ia/modelos/ato/estimativa', {
      candidato: NOVO,
    });
    expect(e.json()).toMatchObject({
      chamadas: 96,
      custoEstimadoUsd: 0.08,
      tetoUsd: 1,
      acimaDoTeto: false,
      referencia: ATUAL,
    });
    expect(executor.execucoes).toHaveLength(0);

    // sem confirmar, não testa
    const sem = await chamar('POST', '/admin/api/ia/modelos/ato/testes', {
      candidato: NOVO,
    });
    expect(sem.statusCode).toBe(409);

    const t = await testar();
    expect(t.statusCode).toBe(202);
    const f = await daFuncao('ato');
    expect(f.ultimoTeste).toMatchObject({
      estado: 'concluido',
      veredito: 'aprovado',
      candidato: NOVO,
      referencia: ATUAL,
    });
    expect(f.ultimoTeste.comparacao.length).toBeGreaterThan(5);
    expect(f.publicacao).toEqual({ pode: true, exigeAprovacao: false });

    const consulta = await chamar(
      'GET',
      `/admin/api/ia/modelos/testes/${f.ultimoTeste.id}`,
    );
    expect(consulta.json().estado).toBe('concluido');

    const pub = await chamar('POST', '/admin/api/ia/modelos/ato/publicar', {
      testeId: f.ultimoTeste.id,
      confirmado: true,
    });
    expect(pub.statusCode).toBe(200);
    const depois = await daFuncao('ato');
    expect(depois.efetivo).toMatchObject({ modelo: NOVO, origem: 'painel' });
    expect(depois.efetivo.desde).toBe(AGORA.toISOString());
    expect(depois.anterior.modelo).toBe(ATUAL);
    expect(depois.podeReverter).toBe(true);
    expect((await daFuncao('resumo')).efetivo.modelo).toBe(ATUAL);

    const rev = await chamar('POST', '/admin/api/ia/modelos/ato/reverter', {
      confirmado: true,
    });
    expect(rev.statusCode).toBe(200);
    expect((await daFuncao('ato')).efetivo).toMatchObject({
      modelo: ATUAL,
      origem: 'ambiente',
    });

    const painel = (await chamar('GET', '/admin/api/ia?periodo=hoje')).json();
    const tipos = painel.alteracoes.map((a: { tipo: string }) => a.tipo);
    expect(tipos).toEqual([
      'modelo_revertido',
      'modelo_publicado',
      'teste_modelo_iniciado',
    ]);
    const publicada = painel.alteracoes.find(
      (a: { tipo: string }) => a.tipo === 'modelo_publicado',
    );
    expect(publicada).toMatchObject({
      funcao: 'ato',
      anterior: ATUAL,
      novo: NOVO,
      testeId: f.ultimoTeste.id,
      aprovacao: null,
    });
  });

  it('teste bloqueado: publicar é recusado com 409, mesmo com a aprovação digitada', async () => {
    executor.resultado = {
      tipo: 'ok',
      candidato: metricas({ modelo: NOVO, violacoes: 1 }),
      referencia: metricas(),
      gastoUsd: 0.05,
      tetoAtingido: false,
    };
    await testar();
    const f = await daFuncao('ato');
    expect(f.ultimoTeste.veredito).toBe('bloqueado');
    expect(f.publicacao).toMatchObject({ pode: false, motivo: 'veredito_bloqueado' });
    const r = await chamar('POST', '/admin/api/ia/modelos/ato/publicar', {
      testeId: f.ultimoTeste.id,
      confirmado: true,
      palavra: 'PUBLICAR',
      motivo: 'outro',
    });
    expect(r.statusCode).toBe(409);
    expect((await daFuncao('ato')).efetivo.modelo).toBe(ATUAL);
  });

  it('teste com ressalva: pede a palavra digitada e o motivo; o registro guarda a aprovação', async () => {
    executor.resultado = {
      tipo: 'ok',
      candidato: metricas({ modelo: NOVO, custoMedioUsd: 0.004 }),
      referencia: metricas(),
      gastoUsd: 0.05,
      tetoAtingido: false,
    };
    await testar();
    const f = await daFuncao('ato');
    expect(f.publicacao).toEqual({ pode: true, exigeAprovacao: true });
    expect(f.ultimoTeste.impactoPorDiaUsd).toBe(0);
    const id = f.ultimoTeste.id;
    expect(
      (
        await chamar('POST', '/admin/api/ia/modelos/ato/publicar', {
          testeId: id,
          confirmado: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await chamar('POST', '/admin/api/ia/modelos/ato/publicar', {
          testeId: id,
          confirmado: true,
          palavra: 'publicar',
          motivo: 'custo_aceitavel',
        })
      ).statusCode,
    ).toBe(400);
    const ok = await chamar('POST', '/admin/api/ia/modelos/ato/publicar', {
      testeId: id,
      confirmado: true,
      palavra: 'PUBLICAR',
      motivo: 'custo_aceitavel',
      observacao: 'Vale pela qualidade',
    });
    expect(ok.statusCode).toBe(200);
    const painel = (await chamar('GET', '/admin/api/ia?periodo=hoje')).json();
    expect(painel.alteracoes[0]).toMatchObject({
      tipo: 'modelo_publicado',
      aprovacao: 'custo_aceitavel: Vale pela qualidade',
    });
  });

  it('um teste de outra função ou de um candidato diferente não publica', async () => {
    await testar('ato');
    const f = await daFuncao('ato');
    const r = await chamar('POST', '/admin/api/ia/modelos/resumo/publicar', {
      testeId: f.ultimoTeste.id,
      confirmado: true,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().detalhes.motivo).toBe('teste_de_outro_modelo');
  });

  it('reverter sem modelo anterior: 409', async () => {
    const r = await chamar('POST', '/admin/api/ia/modelos/ato/reverter', {
      confirmado: true,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().detalhes.motivo).toBe('sem_modelo_anterior');
  });

  it('cancelar um teste em andamento', async () => {
    let soltar!: () => void;
    executor.portao = new Promise<void>((r) => (soltar = r));
    const t = await chamar('POST', '/admin/api/ia/modelos/ato/testes', {
      candidato: NOVO,
      confirmado: true,
    });
    const id = t.json().id as string;
    expect(
      (
        await chamar('POST', '/admin/api/ia/modelos/resumo/testes', {
          candidato: NOVO,
          confirmado: true,
        })
      ).statusCode,
    ).toBe(409);
    expect((await modelos()).emAndamento.id).toBe(id);
    await chamar('POST', `/admin/api/ia/modelos/testes/${id}/cancelar`, {});
    soltar();
    await app.testeDeModelo.aguardarFim();
    expect(
      (await chamar('GET', `/admin/api/ia/modelos/testes/${id}`)).json().estado,
    ).toBe('cancelado');
  });

  it('teste que não existe: 404', async () => {
    expect(
      (await chamar('GET', '/admin/api/ia/modelos/testes/nao-existe')).statusCode,
    ).toBe(404);
  });
});

describe('o que NUNCA aparece nas respostas', () => {
  it('nem e-mail, nem chave, nem workspace inteiro, nem número de processo, nem texto do erro interno', async () => {
    montar();
    await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: {
        nome: 'Maria Silva',
        email: EMAIL_DA_CONTA,
        senha: 'uma-senha-boa-o-bastante',
      },
    });
    executor.falhar = true;
    await testar();
    executor.falhar = false;
    await testar();
    const f = await daFuncao('ato');
    await chamar('POST', '/admin/api/ia/modelos/ato/publicar', {
      testeId: f.ultimoTeste.id,
      confirmado: true,
    });
    await chamar('GET', '/admin/api/ia?periodo=30d');
    const corpo = tudo.join('\n');
    expect(corpo).not.toContain(EMAIL_DA_CONTA);
    expect(corpo).not.toContain(CHAVE_A);
    expect(corpo).not.toContain(WS_A);
    expect(corpo).not.toContain(ADMIN_SENHA);
    expect(corpo).not.toContain('SEGREDO-NAO-VAZAR');
    expect(corpo).not.toMatch(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
    expect(corpo).not.toMatch(/\d{20}/);
  });
});
