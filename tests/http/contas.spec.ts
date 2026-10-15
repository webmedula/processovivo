import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Config } from '../../src/infrastructure/config/env.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import type { OpcoesAplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';

const CHAVE = 'chave-de-teste-1234567890';
const SENHA = 'uma-senha-boa-o-bastante';

function config(): Config {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: CHAVE,
    CACHE_ENABLED: 'false',
    // Sem HTTPS no teste; com `Secure` o cookie não voltaria.
    COOKIE_SECURE: 'false',
  } as NodeJS.ProcessEnv);
}

function montar(opcoes: OpcoesAplicacaoDeTeste = {}): {
  servidor: FastifyInstance;
  app: Aplicacao;
} {
  const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], opcoes);
  return { servidor: construirServidor(app, config()), app };
}

/** O cookie que o navegador guardaria, extraído do `set-cookie` da resposta. */
function cookieDe(resposta: { headers: Record<string, unknown> }): string {
  const bruto = resposta.headers['set-cookie'];
  const linha = Array.isArray(bruto) ? bruto[0] : bruto;
  return String(linha ?? '').split(';')[0] ?? '';
}

describe('Contas — cadastro', () => {
  let servidor: FastifyInstance;

  beforeEach(() => {
    servidor = montar().servidor;
  });
  afterEach(async () => {
    await servidor.close();
  });

  async function cadastrar(email: string, senha = SENHA) {
    return servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: { nome: 'Maria Silva', email, senha },
    });
  }

  it('cria a conta e já entra, sem pedir login em seguida', async () => {
    const r = await cadastrar('maria@escritorio.com.br');

    expect(r.statusCode).toBe(201);
    expect(r.json().usuario.email).toBe('maria@escritorio.com.br');
    // Cadastro que exige login logo depois é atrito puro: a pessoa acabou de
    // provar que sabe a senha.
    expect(cookieDe(r)).toContain('processovivo_sessao=');
  });

  it('não devolve senha nem hash em lugar nenhum da resposta', async () => {
    const r = await cadastrar('maria@escritorio.com.br');

    expect(r.body).not.toContain(SENHA);
    expect(r.body).not.toContain('senha');
  });

  it('não expõe o workspace na resposta', async () => {
    // O identificador do ambiente não sai: publicá-lo convida a tentar usá-lo
    // como parâmetro em outra rota.
    const r = await cadastrar('maria@escritorio.com.br');
    expect(Object.keys(r.json().usuario)).not.toContain('workspace');
  });

  it('manda o cookie como HttpOnly e SameSite', async () => {
    const r = await cadastrar('maria@escritorio.com.br');
    const bruto = String(r.headers['set-cookie']);

    // HttpOnly é o que faz um XSS não virar roubo de sessão. É também a razão
    // de o token não voltar no corpo — o console poderia guardá-lo e desfazer
    // a proteção inteira.
    expect(bruto).toContain('HttpOnly');
    expect(bruto).toContain('SameSite=Lax');
  });

  it('trata o e-mail sem diferenciar maiúscula nem espaço nas bordas', async () => {
    await cadastrar('Maria@Escritorio.com.BR');
    const repetido = await cadastrar('  maria@escritorio.com.br ');

    // Sem normalizar, viram duas contas — e a segunda pessoa acha que perdeu
    // tudo o que tinha cadastrado.
    expect(repetido.statusCode).toBe(409);
  });

  it('recusa e-mail já cadastrado com 409, não com 400', async () => {
    await cadastrar('maria@escritorio.com.br');
    const r = await cadastrar('maria@escritorio.com.br');

    expect(r.statusCode).toBe(409);
    expect(r.json().erro).toBe('EMAIL_JA_CADASTRADO');
  });

  it('recusa senha curta', async () => {
    const r = await cadastrar('maria@escritorio.com.br', 'curta');
    expect(r.statusCode).toBe(400);
  });

  it('recusa e-mail sem forma de e-mail', async () => {
    const r = await cadastrar('maria-arroba-nada');
    expect(r.statusCode).toBe(400);
  });
});

describe('Contas — entrar e sair', () => {
  let servidor: FastifyInstance;

  beforeEach(async () => {
    servidor = montar().servidor;
    await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: { nome: 'Maria Silva', email: 'maria@escritorio.com.br', senha: SENHA },
    });
  });
  afterEach(async () => {
    await servidor.close();
  });

  function entrar(email: string, senha: string) {
    return servidor.inject({
      method: 'POST',
      url: '/v1/sessoes',
      payload: { email, senha },
    });
  }

  it('entra com e-mail e senha corretos', async () => {
    const r = await entrar('maria@escritorio.com.br', SENHA);
    expect(r.statusCode).toBe(200);
    expect(cookieDe(r)).toContain('processovivo_sessao=');
  });

  it('responde igual para e-mail inexistente e para senha errada', async () => {
    const senhaErrada = await entrar('maria@escritorio.com.br', 'senha-errada-aqui');
    const emailInexistente = await entrar('ninguem@escritorio.com.br', SENHA);

    // Respostas diferentes transformariam a tela de login num verificador de
    // quem é cliente: bastaria testar endereços e ler a diferença.
    expect(senhaErrada.statusCode).toBe(401);
    expect(emailInexistente.statusCode).toBe(401);
    expect(senhaErrada.json()).toEqual(emailInexistente.json());
  });

  it('responde igual também para e-mail malformado', async () => {
    const malformado = await entrar('nao-e-email', SENHA);
    const inexistente = await entrar('ninguem@escritorio.com.br', SENHA);

    expect(malformado.json()).toEqual(inexistente.json());
  });

  it('a sessão dá acesso às rotas de dados, sem chave de API', async () => {
    const login = await entrar('maria@escritorio.com.br', SENHA);
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos',
      headers: { cookie: cookieDe(login) },
    });

    expect(r.statusCode).toBe(200);
  });

  it('sair encerra a sessão NO SERVIDOR, não só no navegador', async () => {
    const login = await entrar('maria@escritorio.com.br', SENHA);
    const cookie = cookieDe(login);

    await servidor.inject({ method: 'DELETE', url: '/v1/sessoes', headers: { cookie } });

    // O mesmo cookie, reapresentado: se o logout só apagasse do navegador, um
    // cookie copiado antes continuaria abrindo a conta.
    const depois = await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos',
      headers: { cookie },
    });
    expect(depois.statusCode).toBe(401);
  });

  it('sessão vencida não vale', async () => {
    const outro = montar({ duracaoSessaoMs: -1000 });
    await outro.servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: { nome: 'Vencida', email: 'v@x.com.br', senha: SENHA },
    });
    const login = await outro.servidor.inject({
      method: 'POST',
      url: '/v1/sessoes',
      payload: { email: 'v@x.com.br', senha: SENHA },
    });

    const r = await outro.servidor.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { cookie: cookieDe(login) },
    });
    expect(r.statusCode).toBe(401);
    await outro.servidor.close();
  });

  it('cookie inventado não entra', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { cookie: 'processovivo_sessao=token-que-eu-inventei-agora' },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('Contas — ambientes isolados', () => {
  let servidor: FastifyInstance;

  beforeEach(() => {
    servidor = montar().servidor;
  });
  afterEach(async () => {
    await servidor.close();
  });

  async function contaCom(email: string): Promise<string> {
    const r = await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: { nome: 'Advogado', email, senha: SENHA },
    });
    return cookieDe(r);
  }

  it('um advogado não vê o processo acompanhado pelo outro', async () => {
    // É a garantia que sustenta vender o mesmo servidor para escritórios
    // diferentes: cada conta nasce com o próprio workspace.
    const ana = await contaCom('ana@a.com.br');
    const bruno = await contaCom('bruno@b.com.br');

    await servidor.inject({
      method: 'POST',
      url: '/v1/acompanhamentos',
      headers: { cookie: ana },
      payload: { numero: '1234567-47.2023.8.26.0100' },
    });

    const deAna = await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos',
      headers: { cookie: ana },
    });
    const deBruno = await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos',
      headers: { cookie: bruno },
    });

    expect(deAna.json().total).toBe(1);
    expect(deBruno.json().total).toBe(0);
  });

  it('a conta não enxerga o que foi acompanhado pela chave de API', async () => {
    await servidor.inject({
      method: 'POST',
      url: '/v1/acompanhamentos',
      headers: { 'x-api-key': CHAVE },
      payload: { numero: '1234567-47.2023.8.26.0100' },
    });

    const cookie = await contaCom('ana@a.com.br');
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos',
      headers: { cookie },
    });
    expect(r.json().total).toBe(0);
  });

  it('com cookie e chave juntos, vence a pessoa', async () => {
    const cookie = await contaCom('ana@a.com.br');
    await servidor.inject({
      method: 'POST',
      url: '/v1/acompanhamentos',
      headers: { 'x-api-key': CHAVE },
      payload: { numero: '1234567-47.2023.8.26.0100' },
    });

    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos',
      headers: { cookie, 'x-api-key': CHAVE },
    });

    // A ordem inversa seria pior de depurar: quem tivesse usado a chave uma
    // vez veria a carteira dela por baixo da própria conta, conforme a aba.
    expect(r.json().total).toBe(0);
  });
});

describe('Contas — perfil e trilha de liberação', () => {
  let servidor: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    servidor = montar().servidor;
    const r = await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: { nome: 'Maria Silva', email: 'maria@escritorio.com.br', senha: SENHA },
    });
    cookie = cookieDe(r);
  });
  afterEach(async () => {
    await servidor.close();
  });

  it('a conta nova tem a conta pronta e o resto pendente', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { cookie },
    });

    expect(r.json().trilha).toEqual({ conta: true, oab: false, tribunal: false });
  });

  it('informar a OAB destrava o passo da vigilância', async () => {
    const r = await servidor.inject({
      method: 'PATCH',
      url: '/v1/eu',
      headers: { cookie },
      payload: { oab: '47383', ufOab: 'go' },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().trilha.oab).toBe(true);
    // Normalizado por `Oab.criar`: guardar "go" faria a vigilância procurar
    // por um texto que o DJEN nunca devolve.
    expect(r.json().usuario.ufOab).toBe('GO');
  });

  it('atualizar só a OAB não apaga o nome', async () => {
    await servidor.inject({
      method: 'PATCH',
      url: '/v1/eu',
      headers: { cookie },
      payload: { oab: '47383', ufOab: 'GO' },
    });
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { cookie },
    });

    expect(r.json().usuario.nome).toBe('Maria Silva');
  });

  it('recusa OAB inválida em vez de guardar lixo', async () => {
    const r = await servidor.inject({
      method: 'PATCH',
      url: '/v1/eu',
      headers: { cookie },
      payload: { oab: '47383', ufOab: 'ZZ' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('exige sessão para ver o próprio perfil', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/v1/eu' });
    expect(r.statusCode).toBe(401);
  });

  it('a chave de API não tem perfil — ela não é uma pessoa', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { 'x-api-key': CHAVE },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('Contas — troca de senha', () => {
  let servidor: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    servidor = montar().servidor;
    const r = await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: { nome: 'Maria', email: 'maria@escritorio.com.br', senha: SENHA },
    });
    cookie = cookieDe(r);
  });
  afterEach(async () => {
    await servidor.close();
  });

  it('exige a senha atual', async () => {
    const r = await servidor.inject({
      method: 'POST',
      url: '/v1/eu/senha',
      headers: { cookie },
      payload: { senhaAtual: 'nao-e-a-minha-senha', senhaNova: 'outra-senha-longa' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('derruba as sessões abertas em outros aparelhos', async () => {
    const outroAparelho = cookieDe(
      await servidor.inject({
        method: 'POST',
        url: '/v1/sessoes',
        payload: { email: 'maria@escritorio.com.br', senha: SENHA },
      }),
    );

    const troca = await servidor.inject({
      method: 'POST',
      url: '/v1/eu/senha',
      headers: { cookie },
      payload: { senhaAtual: SENHA, senhaNova: 'a-senha-nova-bem-longa' },
    });

    // Quem troca a senha costuma estar tirando alguém de dentro. Manter a
    // sessão antiga válida deixaria o invasor lá.
    const antiga = await servidor.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { cookie: outroAparelho },
    });
    expect(antiga.statusCode).toBe(401);

    // E quem trocou continua conectado, com o cookie novo.
    const nova = await servidor.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { cookie: cookieDe(troca) },
    });
    expect(nova.statusCode).toBe(200);
  });
});

/**
 * A tela inicial mostra movimentação NOVA, e um processo recém-adicionado não
 * gera nenhuma — a primeira sincronização é o retrato inicial, de propósito.
 *
 * Isso enganou o dono do produto num teste real: ele cadastrou três processos,
 * abriu a tela inicial, viu um item e concluiu que só um tinha sido salvo. O
 * banco tinha os três. O defeito não era perda de dado; era a tela não dizer
 * quantos processos existem.
 */
describe('Tela inicial — quantos processos a pessoa acompanha', () => {
  let servidor: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    servidor = montar().servidor;
    cookie = cookieDe(
      await servidor.inject({
        method: 'POST',
        url: '/v1/contas',
        payload: { nome: 'Maria', email: 'maria@escritorio.com.br', senha: SENHA },
      }),
    );
  });
  afterEach(async () => {
    await servidor.close();
  });

  it('conta zero numa conta nova', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/novidades',
      headers: { cookie },
    });
    expect(r.json().acompanhados).toBe(0);
  });

  it('conta os processos acompanhados mesmo sem nenhuma novidade', async () => {
    for (const numero of [
      '0311517-22.2015.8.09.0051',
      '5818922-04.2026.8.09.0011',
      '1234567-47.2023.8.26.0100',
    ]) {
      await servidor.inject({
        method: 'POST',
        url: '/v1/acompanhamentos',
        headers: { cookie },
        payload: { numero },
      });
    }

    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/novidades',
      headers: { cookie },
    });

    // Zero novidades E três processos ao mesmo tempo: é exatamente o estado
    // que a tela precisa saber distinguir de "você não tem nada".
    expect(r.json().novidades).toHaveLength(0);
    expect(r.json().acompanhados).toBe(3);
  });

  it('não conta os processos de outro assinante', async () => {
    const outro = cookieDe(
      await servidor.inject({
        method: 'POST',
        url: '/v1/contas',
        payload: { nome: 'Bruno', email: 'bruno@b.com.br', senha: SENHA },
      }),
    );
    await servidor.inject({
      method: 'POST',
      url: '/v1/acompanhamentos',
      headers: { cookie: outro },
      payload: { numero: '0311517-22.2015.8.09.0051' },
    });

    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/novidades',
      headers: { cookie },
    });
    expect(r.json().acompanhados).toBe(0);
  });
});

/**
 * Os filtros da tela de processos vivem numa variável global da página:
 * sobrevivem a trocar de aba e só somem quando a página recarrega. Um filtro
 * esquecido fez a carteira parecer ter um processo em vez de três, e "sair e
 * entrar de novo" resolveu — que é o pior tipo de conserto, porque não explica
 * nada e deixa a desconfiança de pé.
 *
 * A defesa é o servidor dizer SEMPRE o total real, para a tela nunca poder
 * mostrar um subconjunto calada.
 */
describe('Listagem de processos — o total real vai junto', () => {
  let servidor: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    servidor = montar().servidor;
    cookie = cookieDe(
      await servidor.inject({
        method: 'POST',
        url: '/v1/contas',
        payload: { nome: 'Maria', email: 'maria@escritorio.com.br', senha: SENHA },
      }),
    );
    for (const numero of [
      '0311517-22.2015.8.09.0051',
      '5818922-04.2026.8.09.0011',
      '1234567-47.2023.8.26.0100',
    ]) {
      await servidor.inject({
        method: 'POST',
        url: '/v1/acompanhamentos',
        headers: { cookie },
        payload: { numero },
      });
    }
  });
  afterEach(async () => {
    await servidor.close();
  });

  it('sem filtro, os dois totais coincidem', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos',
      headers: { cookie },
    });
    expect(r.json().total).toBe(3);
    expect(r.json().totalSemFiltro).toBe(3);
  });

  it('com filtro, o total real continua aparecendo', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos?texto=0311517',
      headers: { cookie },
    });

    // É esta diferença que a tela usa para dizer "mostrando 1 de 3" em vez de
    // mostrar um e calar sobre os outros dois.
    expect(r.json().total).toBe(1);
    expect(r.json().totalSemFiltro).toBe(3);
  });

  it('o total real é o do assinante, não o do servidor', async () => {
    const outro = cookieDe(
      await servidor.inject({
        method: 'POST',
        url: '/v1/contas',
        payload: { nome: 'Bruno', email: 'bruno@b.com.br', senha: SENHA },
      }),
    );
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/acompanhamentos',
      headers: { cookie: outro },
    });
    expect(r.json().totalSemFiltro).toBe(0);
  });
});

/**
 * O filtro por PARTE é o que o advogado mais usa numa carteira grande: "quais
 * destes são do meu cliente X". Vive numa coluna desnormalizada, e não num
 * json_extract por linha, porque o segundo desserializaria ~100 KB de processo
 * por linha a cada tecla digitada.
 */
describe('Meus processos — filtro por parte', () => {
  let servidor: FastifyInstance;
  let cookie: string;
  const CLIENTE = 'CONDOMINIO SUNSQUARE';

  beforeEach(async () => {
    // Provider próprio: o processo padrão das fábricas não tem partes, e sem
    // partes não há o que filtrar. Aqui o dublê devolve o cliente de verdade.
    const app = aplicacaoDeTeste([
      new ProviderFalso({
        nome: 'falso',
        porNumero: async () =>
          umProcesso({
            partes: [
              { nome: CLIENTE, polo: 'ATIVO', tipoPessoa: 'JURIDICA', advogados: [] },
              {
                nome: 'Outra Parte Qualquer',
                polo: 'PASSIVO',
                tipoPessoa: 'FISICA',
                advogados: [],
              },
            ],
          }),
      }),
    ]);
    servidor = construirServidor(app, config());
    cookie = cookieDe(
      await servidor.inject({
        method: 'POST',
        url: '/v1/contas',
        payload: { nome: 'Maria', email: 'maria@escritorio.com.br', senha: SENHA },
      }),
    );
    await servidor.inject({
      method: 'POST',
      url: '/v1/acompanhamentos',
      headers: { cookie },
      payload: { numero: '0311517-22.2015.8.09.0051' },
    });
  });
  afterEach(async () => {
    await servidor.close();
  });

  async function lista(query = ''): Promise<{
    total: number;
    totalSemFiltro: number;
    acompanhamentos: Array<{ partes: Array<{ nome: string; polo: string }> }>;
  }> {
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/acompanhamentos${query}`,
      headers: { cookie },
    });
    return r.json();
  }

  it('devolve as partes no resumo da lista', async () => {
    // Sem isto, achar os processos de um cliente exige abrir um por um.
    const r = await lista();
    expect(Array.isArray(r.acompanhamentos[0]?.partes)).toBe(true);
    expect(r.acompanhamentos[0]?.partes.length).toBeGreaterThan(0);
    expect(r.acompanhamentos[0]?.partes[0]).toHaveProperty('nome');
    expect(r.acompanhamentos[0]?.partes[0]).toHaveProperty('polo');
  });

  it('acha a parte ignorando a caixa', async () => {
    // O tribunal grava "CONDOMINIO SUNSQUARE" e o advogado digita "sunsquare".
    // Sem normalizar as duas pontas, o filtro não acha e parece que o cliente
    // não tem processo.
    expect((await lista('?parte=sunsquare')).total).toBe(1);
    expect((await lista('?parte=SunSquare')).total).toBe(1);
  });

  it('acha por trecho do meio do nome', async () => {
    // Ninguém digita a razão social inteira.
    expect((await lista('?parte=SQUARE')).total).toBe(1);
  });

  it('acha também a outra parte, não só a do polo ativo', async () => {
    expect((await lista('?parte=outra parte')).total).toBe(1);
  });

  it('não acha quem não é parte', async () => {
    const r = await lista('?parte=empresa-que-nao-existe-nos-autos');
    expect(r.total).toBe(0);
    // O total real continua aparecendo: a tela nunca mostra recorte calada.
    expect(r.totalSemFiltro).toBe(1);
  });

  it('o filtro por parte respeita o isolamento entre contas', async () => {
    const outro = cookieDe(
      await servidor.inject({
        method: 'POST',
        url: '/v1/contas',
        payload: { nome: 'Bruno', email: 'bruno@b.com.br', senha: SENHA },
      }),
    );

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/acompanhamentos?parte=${encodeURIComponent(CLIENTE)}`,
      headers: { cookie: outro },
    });
    expect(r.json().total).toBe(0);
  });
});
