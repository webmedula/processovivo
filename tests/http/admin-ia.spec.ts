import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import { ProviderIndisponivelError } from '../../src/domain/errors/index.js';
import type {
  PedidoDeAnalise,
  RespostaDoAnalisador,
} from '../../src/domain/ports/AnalisadorDeAto.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { AnalisadorFalso, NOME_DA_PARTE, respostaValida } from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A, ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import {
  AGORA_DO_RESUMO,
  ATOS_DO_RESUMO,
  INTIMACAO,
  ResumidorFalso,
  TEXTO_DA_INTIMACAO,
} from '../helpers/resumoIa.js';

/*
 * O painel de IA do /admin (v0.58.0) ponta a ponta: quem acessa, o interruptor das funções (zero
 * chamadas ao modelo, zero consumo do teto, frase fixa), os tetos, o registro de mudanças, as contagens
 * de falha e a garantia de que nada de ato, parte, processo, e-mail ou chave aparece nas respostas.
 * Dublês de analisador e resumidor; nenhuma rede, nenhum relógio real.
 */

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const A = { 'x-api-key': CHAVE_A };
const WS_A = workspaceDaChave(CHAVE_A);
const DIGITOS_A = NUMERO_TJSP_A.replace(/\D/g, '');
const ADMIN_USUARIO = 'joao';
const ADMIN_SENHA = 'uma-senha-administrativa-bem-forte';
const SENHA_CONTA = 'uma-senha-boa-o-bastante';
const EMAIL_DA_CONTA = 'maria.sintetica@escritorio.test';
const FRASE_DESLIGADA = 'Este recurso está indisponível no momento.';
const CHAVE_DO_ATO = chaveDaMovimentacao(INTIMACAO);

const basic = (u: string, s: string): string =>
  'Basic ' + Buffer.from(`${u}:${s}`).toString('base64');
const ADMIN = { authorization: basic(ADMIN_USUARIO, ADMIN_SENHA) };

let app: Aplicacao;
let servidor: FastifyInstance;
let analisador: AnalisadorFalso;
let resumidor: ResumidorFalso;

/** Analisador que também sinaliza repetições automáticas, como o transporte real faz. */
class AnalisadorQueRepete extends AnalisadorFalso {
  repeticoes = 0;
  override async analisar(pedido: PedidoDeAnalise): Promise<RespostaDoAnalisador> {
    for (let i = 0; i < this.repeticoes; i++) pedido.aoRepetir?.();
    return super.analisar(pedido);
  }
}

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

async function montar(
  opcoes: { porDia?: number; comAdmin?: boolean } = {},
): Promise<void> {
  analisador = new AnalisadorQueRepete();
  resumidor = new ResumidorFalso();
  app = aplicacaoDeTeste(
    [
      new ProviderFalso({
        nome: 'falso',
        porNumero: async () =>
          umProcesso({
            partes: [
              { nome: NOME_DA_PARTE, polo: 'ATIVO', tipoPessoa: 'FISICA', advogados: [] },
            ],
            movimentacoes: ATOS_DO_RESUMO,
          }),
      }),
    ],
    {
      agora: () => AGORA_DO_RESUMO,
      analiseIa: {
        analisador,
        ...(opcoes.porDia !== undefined ? { porDia: opcoes.porDia } : {}),
      },
      resumoIa: { resumidor },
      ...(opcoes.comAdmin === false
        ? {}
        : { admin: { usuario: ADMIN_USUARIO, senha: ADMIN_SENHA } }),
    },
  );
  servidor = construirServidor(app, config());
  await app.acompanhamento.acompanhar(WS_A, NUMERO_TJSP_A);
  await app.acompanhamento.sincronizar({ workspace: WS_A });
  await app.assinaturas.liberar({ workspace: WS_A, plano: 'ia', meses: 1 });
}

const painel = async (periodo = 'hoje') =>
  (
    await servidor.inject({
      method: 'GET',
      url: `/admin/api/ia?periodo=${periodo}`,
      headers: ADMIN,
    })
  ).json();
const funcaoDoPainel = async (f: string) =>
  (await painel()).funcoes.find((x: { funcao: string }) => x.funcao === f);
const mudar = (
  caminho: string,
  corpo: unknown,
  headers: Record<string, string> = ADMIN,
) =>
  servidor.inject({
    method: 'PUT',
    url: `/admin/api/ia/${caminho}`,
    headers,
    payload: corpo as Record<string, unknown>,
  });
const analisar = () =>
  servidor.inject({
    method: 'POST',
    url: `/v1/acompanhamentos/${DIGITOS_A}/analise`,
    headers: A,
    payload: { chaveDoAto: CHAVE_DO_ATO },
  });
const resumir = () =>
  servidor.inject({
    method: 'POST',
    url: `/v1/acompanhamentos/${DIGITOS_A}/resumo`,
    headers: A,
  });
const disponibilidade = () =>
  servidor.inject({ method: 'GET', url: '/v1/analises/disponibilidade', headers: A });

afterEach(async () => {
  await servidor.close();
});

describe('quem acessa o painel de IA', () => {
  beforeEach(() => montar());

  it('sem credencial: 401 com o desafio do Basic Auth, em toda rota nova', async () => {
    for (const [metodo, url] of [
      ['GET', '/admin/api/ia'],
      ['GET', '/admin/api/ia/alerta'],
      ['PUT', '/admin/api/ia/alerta'],
      ['PUT', '/admin/api/ia/funcoes/ato'],
      ['PUT', '/admin/api/ia/funcoes/ato/teto'],
      ['PUT', '/admin/api/ia/teto-global'],
    ] as const) {
      const r = await servidor.inject({ method: metodo, url, payload: {} });
      expect(r.statusCode, `${metodo} ${url}`).toBe(401);
      expect(r.headers['www-authenticate']).toMatch(/^Basic/);
    }
  });

  it('senha errada: 401', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: '/admin/api/ia',
      headers: { authorization: basic(ADMIN_USUARIO, 'senha-errada-qualquer') },
    });
    expect(r.statusCode).toBe(401);
  });

  it('a chave de API de uma integração NÃO abre o painel', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/admin/api/ia', headers: A });
    expect(r.statusCode).toBe(401);
    const p = await mudar('funcoes/ato', { ligada: false, confirmado: true }, A);
    expect(p.statusCode).toBe(401);
    expect((await funcaoDoPainel('ato')).painelLigado).toBe(true);
  });

  it('uma conta de assinante (sessão por cookie) NÃO abre o painel nem muda nada', async () => {
    const c = await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: { nome: 'Maria Silva', email: EMAIL_DA_CONTA, senha: SENHA_CONTA },
    });
    expect(c.statusCode).toBe(201);
    const cookie = String(c.headers['set-cookie']).split(';')[0] as string;
    const r = await servidor.inject({
      method: 'GET',
      url: '/admin/api/ia',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(401);
    const p = await mudar('funcoes/ato', { ligada: false, confirmado: true }, { cookie });
    expect(p.statusCode).toBe(401);
    const a = await mudar('alerta', { valorUsd: 99 }, { cookie });
    expect(a.statusCode).toBe(401);
    expect((await painel()).custoDoDia.alertaUsd).toBe(3);
  });

  it('o admin entra; a página do /admin ganhou a aba "IA" e o espaço do aviso de custo', async () => {
    const p = await servidor.inject({ method: 'GET', url: '/admin', headers: ADMIN });
    expect(p.statusCode).toBe(200);
    expect(p.body).toContain('id="nav-ia"');
    expect(p.body).toContain('id="aviso-ia"');
    expect(p.body).toContain('window.__pvIaAdmin');
  });
});

describe('painel de IA sem a área administrativa', () => {
  beforeEach(() => montar({ comAdmin: false }));

  it('as rotas novas respondem 501 como o resto do /admin', async () => {
    for (const [m, u] of [
      ['GET', '/admin/api/ia'],
      ['PUT', '/admin/api/ia/funcoes/ato'],
    ] as const) {
      expect((await servidor.inject({ method: m, url: u, payload: {} })).statusCode).toBe(
        501,
      );
    }
  });

  it('a IA continua funcionando sem painel: vale o ambiente', async () => {
    expect((await analisar()).statusCode).toBe(200);
  });
});

describe('estado inicial', () => {
  beforeEach(() => montar());

  it('mostra as três funções com ambiente × painel; a peça está bloqueada pelo ambiente neste teste', async () => {
    const p = await painel();
    expect(p.periodo).toBe('hoje');
    expect(p.funcoes.map((f: { funcao: string }) => f.funcao)).toEqual([
      'ato',
      'resumo',
      'peca',
    ]);
    const [ato, resumo, peca] = p.funcoes;
    expect(ato).toMatchObject({
      ambientePermite: true,
      painelLigado: true,
      efetivamenteLigada: true,
      analises: 0,
    });
    expect(resumo).toMatchObject({ efetivamenteLigada: true });
    expect(peca).toMatchObject({
      ambientePermite: false,
      painelLigado: true,
      efetivamenteLigada: false,
    });
    expect(p.custoDoDia).toEqual({ usd: 0, alertaUsd: 3, acima: false });
    expect(p.alteracoes).toEqual([]);
    expect(p.tetoGlobal).toBeNull();
  });

  it('período fora da lista: 400', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: '/admin/api/ia?periodo=ano',
      headers: ADMIN,
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('o interruptor: função desligada no painel', () => {
  beforeEach(() => montar({ porDia: 1 }));

  it('desligar exige confirmação NO PEDIDO: sem ela, 409 e nada muda', async () => {
    const r = await mudar('funcoes/ato', { ligada: false });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      erro: 'CONFIGURACAO_DE_IA_RECUSADA',
      detalhes: { motivo: 'confirmacao_necessaria' },
    });
    expect((await funcaoDoPainel('ato')).painelLigado).toBe(true);
    expect((await painel()).alteracoes).toEqual([]);
  });

  it('análise de ato desligada: 503 com a frase fixa, ZERO chamadas ao modelo e ZERO consumo do teto', async () => {
    expect(
      (await mudar('funcoes/ato', { ligada: false, confirmado: true })).statusCode,
    ).toBe(200);
    for (let i = 0; i < 3; i++) {
      const r = await analisar();
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({
        erro: 'ENTRADA_NAO_ANALISAVEL',
        mensagem: FRASE_DESLIGADA,
        detalhes: { motivo: 'desligada' },
      });
    }
    expect(analisador.chamadas).toBe(0);
    // O teto do dia é 1: se as três tentativas tivessem consumido, a análise abaixo seria barrada.
    expect((await mudar('funcoes/ato', { ligada: true })).statusCode).toBe(200);
    const volta = await analisar();
    expect(volta.statusCode).toBe(200);
    expect(volta.json().estado).toBe('verificada');
    expect(analisador.chamadas).toBe(1);
    expect((await analisar()).json().detalhes.motivo).toBe('limite_diario');
  });

  it('o botão some para todas as contas: a disponibilidade diz que a função está desligada', async () => {
    await mudar('funcoes/ato', { ligada: false, confirmado: true });
    // O resumo segue ligado: a pergunta continua "habilitada", só diz qual função está de pé.
    expect((await disponibilidade()).json()).toMatchObject({
      habilitada: true,
      funcoes: { ato: false, resumo: true },
    });
    await mudar('funcoes/resumo', { ligada: false, confirmado: true });
    expect((await disponibilidade()).json()).toEqual({ habilitada: false });
  });

  it('resumo desligado: 503 com a frase fixa e zero chamadas; a análise de ato segue funcionando', async () => {
    await mudar('funcoes/resumo', { ligada: false, confirmado: true });
    const r = await resumir();
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({
      erro: 'ENTRADA_NAO_ANALISAVEL',
      mensagem: FRASE_DESLIGADA,
      detalhes: { motivo: 'desligada' },
    });
    expect(resumidor.chamadas).toBe(0);
    expect((await analisar()).statusCode).toBe(200);
    expect((await disponibilidade()).json()).toMatchObject({
      habilitada: true,
      funcoes: { ato: true, resumo: false },
    });
  });

  it('ligar de novo restaura o resumo', async () => {
    await mudar('funcoes/resumo', { ligada: false, confirmado: true });
    await mudar('funcoes/resumo', { ligada: true });
    expect((await resumir()).statusCode).toBe(200);
    expect(resumidor.chamadas).toBe(1);
  });

  it('desligada, a função vem ANTES do plano: a conta sem plano também vê a frase da função desligada', async () => {
    await mudar('funcoes/ato', { ligada: false, confirmado: true });
    const sem = await servidor.inject({
      method: 'POST',
      url: `/v1/acompanhamentos/${DIGITOS_A}/analise`,
      headers: { 'x-api-key': CHAVE_A },
      payload: { chaveDoAto: 'qualquer' },
    });
    expect(sem.json().detalhes.motivo).toBe('desligada');
  });

  it('as frases dos outros casos NÃO mudaram (sem plano continua a de sempre)', async () => {
    await app.assinaturas.cancelar(WS_A);
    const r = await analisar();
    expect(r.statusCode).toBe(403);
    expect(r.json().mensagem).toBe(
      'A análise por IA faz parte do plano IA. Faça upgrade do plano para usar.',
    );
  });

  it('o painel nunca liga o que o ambiente desligou (a peça): 409 e nada gravado', async () => {
    const r = await mudar('funcoes/peca', { ligada: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().detalhes.motivo).toBe('ambiente_bloqueia');
    expect((await painel()).alteracoes).toEqual([]);
  });

  it('função que não existe: 400', async () => {
    const r = await mudar('funcoes/drive', { ligada: false, confirmado: true });
    expect(r.statusCode).toBe(400);
    expect(r.json().detalhes.motivo).toBe('funcao_desconhecida');
  });

  it('corpo com campo a mais ou tipo errado: 400', async () => {
    expect((await mudar('funcoes/ato', { ligada: 'sim' })).statusCode).toBe(400);
    expect(
      (await mudar('funcoes/ato', { ligada: false, confirmado: true, x: 1 })).statusCode,
    ).toBe(400);
  });
});

describe('tetos do painel', () => {
  beforeEach(() => montar());

  it('o teto da função reduz: a 2ª análise do dia é barrada com a frase de sempre; remover o teto libera', async () => {
    expect((await mudar('funcoes/ato/teto', { teto: 1 })).statusCode).toBe(200);
    expect((await funcaoDoPainel('ato')).tetoDoPainel).toBe(1);
    expect((await analisar()).statusCode).toBe(200);
    const barrada = await analisar();
    expect(barrada.statusCode).toBe(429);
    expect(barrada.json()).toMatchObject({
      mensagem: 'Muitas análises hoje. Tente de novo amanhã ou fale com a gente.',
      detalhes: { motivo: 'limite_diario' },
    });
    expect(analisador.chamadas).toBe(1);
    await mudar('funcoes/ato/teto', { teto: null });
    expect((await analisar()).statusCode).toBe(200);
  });

  it('o teto global do dia vale para todas as funções somadas', async () => {
    expect((await mudar('teto-global', { teto: 1 })).statusCode).toBe(200);
    expect((await analisar()).statusCode).toBe(200);
    expect((await resumir()).statusCode).toBe(429);
    expect(resumidor.chamadas).toBe(0);
    expect((await painel()).tetoGlobal).toBe(1);
  });

  it.each([
    ['funcoes/ato/teto', { teto: 0 }],
    ['funcoes/ato/teto', { teto: 1.5 }],
    ['funcoes/ato/teto', { teto: 100_001 }],
    ['teto-global', { teto: -3 }],
    ['alerta', { valorUsd: 0 }],
    ['alerta', { valorUsd: 10_001 }],
  ])('valor fora da faixa (%s %j): 400 e nada gravado', async (caminho, corpo) => {
    const r = await mudar(caminho, corpo);
    expect(r.statusCode).toBe(400);
    expect((await painel()).alteracoes).toEqual([]);
  });

  it('teto sem número ou com texto: 400', async () => {
    expect((await mudar('teto-global', { teto: '50' })).statusCode).toBe(400);
    expect((await mudar('teto-global', {})).statusCode).toBe(400);
  });
});

describe('registro de mudanças', () => {
  beforeEach(() => montar());

  it('cada mudança vira uma linha com autor curto (nunca o nome), função, tipo e valores simples', async () => {
    await mudar('funcoes/ato', { ligada: false, confirmado: true });
    await mudar('funcoes/ato/teto', { teto: 25 });
    await mudar('teto-global', { teto: 500 });
    await mudar('alerta', { valorUsd: 4.5 });
    const h = (await painel()).alteracoes as Array<Record<string, string>>;
    expect(h.map((a) => [a['funcao'], a['tipo'], a['anterior'], a['novo']])).toEqual([
      ['global', 'alerta_custo', '3.00', '4.50'],
      ['global', 'teto_dia_global', 'sem teto', '500'],
      ['ato', 'teto_dia_conta', 'sem teto', '25'],
      ['ato', 'ligada', 'ligada', 'desligada'],
    ]);
    for (const a of h) {
      expect(a['autor']).toMatch(/^[0-9a-f]{8}$/);
      expect(JSON.stringify(a)).not.toContain(ADMIN_USUARIO);
      expect(a['em']).toBe('2026-10-06T15:00:00.000Z');
    }
    // Reversível: o valor anterior está no registro e a própria tela o restaura.
    await mudar('alerta', { valorUsd: 3 });
    expect((await painel()).custoDoDia.alertaUsd).toBe(3);
  });
});

describe('contagens de falha e repetição (só números, por motivo)', () => {
  beforeEach(() => montar());

  it('citação que não existe no ato: não verificada + "citação inválida" contada', async () => {
    analisador.resposta = async () => ({
      resposta: respostaValida({ trecho_chave: 'um trecho que o ato nunca escreveu' }),
      modelo: 'modelo/teste',
      provedor: 'prov',
      custoUsd: 0.0002,
    });
    expect((await analisar()).json().estado).toBe('nao_verificada');
    const f = await funcaoDoPainel('ato');
    expect(f.naoVerificadas).toBe(1);
    expect(f.taxaNaoVerificado).toBe(1);
    expect(f.falhasDeVerificacao).toEqual([{ motivo: 'citacao_invalida', contagem: 1 }]);
  });

  it('repetições automáticas do transporte são contadas por função', async () => {
    (analisador as AnalisadorQueRepete).repeticoes = 2;
    await analisar();
    expect((await funcaoDoPainel('ato')).repeticoesAutomaticas).toBe(2);
    expect((await funcaoDoPainel('resumo')).repeticoesAutomaticas).toBe(0);
  });

  it('chamada que falha ("não foi possível") e tempo esgotado entram na taxa', async () => {
    analisador.resposta = async () => {
      throw new ProviderIndisponivelError('openrouter', 'tempo esgotado');
    };
    expect((await analisar()).json()).toEqual({ estado: 'erro' });
    analisador.resposta = async () => {
      throw new ProviderIndisponivelError(
        'openrouter',
        'o OpenRouter respondeu HTTP 500',
      );
    };
    await analisar();
    const f = await funcaoDoPainel('ato');
    expect(f.naoFoiPossivel).toBe(2);
    expect(f.taxaNaoFoiPossivel).toBe(1);
    expect(f.chamadasQueFalharam).toBe(2);
    expect(f.falhasDeVerificacao).toEqual(
      expect.arrayContaining([
        { motivo: 'tempo_esgotado', contagem: 1 },
        { motivo: 'chamada_falhou', contagem: 1 },
      ]),
    );
  });

  it('custo, avaliação e motivo do polegar chegam às métricas', async () => {
    const r = await analisar();
    const id = r.json().id as string;
    const av = await servidor.inject({
      method: 'POST',
      url: `/v1/analises/${id}/avaliacao`,
      headers: A,
      payload: { avaliacao: 'errado', motivo: 'erro_de_fato' },
    });
    expect(av.statusCode).toBe(200);
    const f = await funcaoDoPainel('ato');
    expect(f).toMatchObject({ analises: 1, util: 0, errado: 1 });
    expect(f.motivosDaAvaliacao.erro_de_fato).toBe(1);
    expect(f.custo).toMatchObject({
      total: 0.0002,
      medio: 0.0002,
      p50: 0.0002,
      p95: 0.0002,
      maximo: 0.0002,
    });
  });
});

describe('alerta de custo no painel', () => {
  beforeEach(() => montar());

  it('abaixo do limite: sem aviso; acima: o aviso aparece (de qualquer aba, por /alerta)', async () => {
    const antes = await servidor.inject({
      method: 'GET',
      url: '/admin/api/ia/alerta',
      headers: ADMIN,
    });
    expect(antes.json()).toEqual({ usd: 0, alertaUsd: 3, acima: false });
    analisador.resposta = async () => ({
      resposta: respostaValida(),
      modelo: 'modelo/teste',
      provedor: 'prov',
      custoUsd: 3.5,
    });
    await analisar();
    const depois = await servidor.inject({
      method: 'GET',
      url: '/admin/api/ia/alerta',
      headers: ADMIN,
    });
    expect(depois.json()).toEqual({ usd: 3.5, alertaUsd: 3, acima: true });
    // Subir o limite apaga o aviso.
    const r = await mudar('alerta', { valorUsd: 10 });
    expect(r.json()).toEqual({ usd: 3.5, alertaUsd: 10, acima: false });
  });
});

describe('nada de dado sensível nas respostas do painel', () => {
  beforeEach(() => montar());

  it('depois de analisar, resumir, avaliar e mudar o painel, o JSON não leva texto de ato, parte, processo, e-mail, chave, senha nem workspace inteiro', async () => {
    const c = await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: { nome: 'Maria Silva', email: EMAIL_DA_CONTA, senha: SENHA_CONTA },
    });
    expect(c.statusCode).toBe(201);
    const a = await analisar();
    expect(a.statusCode).toBe(200);
    expect((await resumir()).statusCode).toBe(200);
    await servidor.inject({
      method: 'POST',
      url: `/v1/analises/${a.json().id}/avaliacao`,
      headers: A,
      payload: { avaliacao: 'util' },
    });
    await mudar('funcoes/resumo', { ligada: false, confirmado: true });
    await mudar('funcoes/resumo', { ligada: true });
    const tudo = [
      await servidor.inject({
        method: 'GET',
        url: '/admin/api/ia?periodo=30d',
        headers: ADMIN,
      }),
      await servidor.inject({
        method: 'GET',
        url: '/admin/api/ia/alerta',
        headers: ADMIN,
      }),
      await mudar('funcoes/ato/teto', { teto: 9 }),
      await mudar('teto-global', { teto: 9 }),
    ]
      .map((r) => r.body)
      .join('\n');
    const proibidos = [
      NOME_DA_PARTE,
      'Mariana',
      'laudo pericial',
      TEXTO_DA_INTIMACAO.slice(0, 30),
      NUMERO_TJSP_A,
      DIGITOS_A,
      EMAIL_DA_CONTA,
      '@',
      CHAVE_A,
      ADMIN_SENHA,
      ADMIN_USUARIO,
      SENHA_CONTA,
      WS_A,
      '98765-4321',
    ];
    for (const p of proibidos) expect(tudo, `vazou: ${p}`).not.toContain(p);
    // O que aparece da conta é só o início do identificador.
    expect(
      JSON.parse(
        (await servidor.inject({ method: 'GET', url: '/admin/api/ia', headers: ADMIN }))
          .body,
      ).contas[0].conta,
    ).toBe(WS_A.slice(0, 8));
  });
});
