import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/domain/ports/Logger.js';
import type { RepositorioDePermissoesDoAdmin } from '../../src/domain/ports/RepositorioDePermissoesDoAdmin.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { RepositorioDePermissoesDoAdminSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDePermissoesDoAdminSqlite.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { ROTAS_DO_ADMIN } from '../../src/main/http/rotas/admin.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { identificarOperador } from '../../src/main/http/operadorDoAdmin.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';

/*
 * Administradores restritos do /admin (v0.62.0): credenciais próprias, abas liberadas pelo dono, negação no SERVIDOR.
 * Usuários e senhas são FICTÍCIOS; nenhuma rede, nenhum relógio real.
 */

const DONO = 'joao';
const SENHA_DO_DONO = 'uma-senha-administrativa-bem-forte';
const ANA = 'ana';
const SENHA_DA_ANA = 'senha-ficticia-da-ana-0123456789';
const BETO = 'beto';
const SENHA_DO_BETO = 'senha-ficticia-do-beto-9876543210';
const RESTRITOS = [
  { usuario: ANA, senha: SENHA_DA_ANA },
  { usuario: BETO, senha: SENHA_DO_BETO },
];
const SENHAS = [SENHA_DO_DONO, SENHA_DA_ANA, SENHA_DO_BETO];

const basic = (u: string, s: string): string =>
  'Basic ' + Buffer.from(`${u}:${s}`).toString('base64');
const COMO_DONO = { authorization: basic(DONO, SENHA_DO_DONO) };
const COMO_ANA = { authorization: basic(ANA, SENHA_DA_ANA) };
const COMO_BETO = { authorization: basic(BETO, SENHA_DO_BETO) };

interface Registro {
  nivel: string;
  mensagem: string;
  contexto: Record<string, unknown> | undefined;
}

function espiao(registros: Registro[]): Logger {
  const l: Logger = {
    debug: (mensagem, contexto) => registros.push({ nivel: 'debug', mensagem, contexto }),
    info: (mensagem, contexto) => registros.push({ nivel: 'info', mensagem, contexto }),
    warn: (mensagem, contexto) => registros.push({ nivel: 'warn', mensagem, contexto }),
    error: (mensagem, contexto) => registros.push({ nivel: 'error', mensagem, contexto }),
    child: () => l,
  };
  return l;
}

function config() {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    CACHE_ENABLED: 'false',
    PROCESSOVIVO_API_KEYS: 'chave-de-teste-1234567890',
    RATE_LIMIT_MAX: '100000',
    COOKIE_SECURE: 'false',
  } as NodeJS.ProcessEnv);
}

let servidor: FastifyInstance | undefined;
let app: Aplicacao;
let registros: Registro[];
let repo: RepositorioDePermissoesDoAdmin;

function montar(
  opcoes: {
    restritos?: typeof RESTRITOS;
    permissoes?: RepositorioDePermissoesDoAdmin;
  } = {},
): FastifyInstance {
  registros = [];
  repo =
    opcoes.permissoes ?? new RepositorioDePermissoesDoAdminSqlite(abrirBanco(':memory:'));
  const base = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    admin: {
      usuario: DONO,
      senha: SENHA_DO_DONO,
      restritos: opcoes.restritos ?? RESTRITOS,
    },
    permissoesDoAdmin: repo,
  });
  app = { ...base, logger: espiao(registros) } as Aplicacao;
  servidor = construirServidor(app, config());
  return servidor;
}

afterEach(async () => {
  await servidor?.close();
  servidor = undefined;
});

async function liberar(
  s: FastifyInstance,
  usuario: string,
  abas: string[],
): Promise<number> {
  const r = await s.inject({
    method: 'PUT',
    url: `/admin/api/administradores/${usuario}/abas`,
    headers: COMO_DONO,
    payload: { abas, confirmado: true },
  });
  return r.statusCode;
}

const NOMES_DAS_OUTRAS_ABAS = [
  'Assinaturas',
  'Planos',
  'Chaves de API',
  'Administradores',
  '/admin/api/assinaturas',
  '/admin/api/planos',
  '/admin/api/chaves',
  '/admin/api/pagamento',
  '/admin/api/regras',
  '/admin/api/administradores',
  'Mercado Pago',
  'TESTE',
];

/** Troca `:param` por um valor qualquer para a rota virar uma URL chamável. */
const urlDe = (rota: string): string =>
  rota.replace(/:[A-Za-z]+/g, 'x').replace('/*', '/qualquer-coisa');

describe('dono — só com as variáveis de sempre (regressão)', () => {
  it('entra e vê todas as abas, mais "Administradores"', async () => {
    const s = montar({ restritos: [] });
    const r = await s.inject({ method: 'GET', url: '/admin', headers: COMO_DONO });
    expect(r.statusCode).toBe(200);
    for (const nome of [
      'Assinaturas',
      'Planos',
      'Chaves de API',
      'IA',
      'Administradores',
    ]) {
      expect(r.body).toContain(`>${nome}</button>`);
    }
    expect(r.body).toContain('Entrou como <strong>joao</strong> · dono');
  });

  it('usa as rotas de todas as abas', async () => {
    const s = montar({ restritos: [] });
    for (const url of [
      '/admin/api/assinaturas',
      '/admin/api/planos',
      '/admin/api/chaves',
      '/admin/api/ia',
      '/admin/api/administradores',
    ]) {
      const r = await s.inject({ method: 'GET', url, headers: COMO_DONO });
      expect(r.statusCode, url).toBe(200);
    }
  });

  it('rota que não existe sob /admin segue sendo 404 para o dono', async () => {
    const s = montar();
    const r = await s.inject({
      method: 'GET',
      url: '/admin/api/nada',
      headers: COMO_DONO,
    });
    expect(r.statusCode).toBe(404);
  });

  it('sem credencial, 401 com o desafio do navegador', async () => {
    const s = montar();
    const r = await s.inject({ method: 'GET', url: '/admin' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toMatch(/^Basic/);
  });
});

describe('tabela aba → rotas', () => {
  it('cada rota aparece uma única vez, com um destino', () => {
    const rotas = ROTAS_DO_ADMIN.map((r) => r.rota);
    expect(new Set(rotas).size).toBe(rotas.length);
    for (const r of ROTAS_DO_ADMIN) {
      expect([
        'assinaturas',
        'planos',
        'chaves',
        'ia',
        'administradores',
        'qualquer',
        'inexistente',
      ]).toContain(r.destino);
    }
  });

  it('toda rota da tabela existe no servidor (a tabela não tem rota fantasma)', async () => {
    const s = montar();
    await s.ready();
    for (const { rota } of ROTAS_DO_ADMIN) {
      const existe = ['GET', 'POST', 'PUT'].some((metodo) =>
        s.hasRoute({ method: metodo as 'GET', url: rota }),
      );
      expect(existe, rota).toBe(true);
    }
  });

  it('o restrito com SÓ a aba IA recebe 403 em toda rota das outras abas, em qualquer método', async () => {
    const s = montar();
    expect(await liberar(s, ANA, ['ia'])).toBe(200);
    for (const { rota, destino } of ROTAS_DO_ADMIN) {
      if (destino === 'ia' || destino === 'qualquer') continue;
      for (const metodo of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
        const r = await s.inject({
          method: metodo,
          url: urlDe(rota),
          headers: COMO_ANA,
          ...(metodo === 'POST' || metodo === 'PUT' ? { payload: {} } : {}),
        });
        expect(r.statusCode, `${metodo} ${rota}`).toBe(403);
      }
    }
  });

  it('as rotas da IA não negam o restrito com a aba IA (e o dono continua passando em todas)', async () => {
    const s = montar();
    await liberar(s, ANA, ['ia']);
    // A tabela é por rota; o método certo de cada uma é o que o servidor registrou. Com o método errado cai no
    // pega-tudo (403 para o restrito), então basta UM método passar.
    const passa = async (
      rota: string,
      headers: Record<string, string>,
    ): Promise<boolean> => {
      for (const metodo of ['GET', 'POST', 'PUT'] as const) {
        const r = await s.inject({
          method: metodo,
          url: urlDe(rota),
          headers,
          ...(metodo === 'GET' ? {} : { payload: {} }),
        });
        if (r.statusCode !== 403) return true;
      }
      return false;
    };
    for (const { rota, destino } of ROTAS_DO_ADMIN) {
      if (destino !== 'ia') continue;
      expect(await passa(rota, COMO_ANA), rota).toBe(true);
    }
    for (const { rota, destino } of ROTAS_DO_ADMIN) {
      if (destino === 'inexistente') continue;
      expect(await passa(rota, COMO_DONO), rota).toBe(true);
    }
  });

  it('rota de aba inexistente responde exatamente como aba não liberada', async () => {
    const s = montar();
    await liberar(s, ANA, ['ia']);
    const fechada = await s.inject({
      method: 'GET',
      url: '/admin/api/chaves',
      headers: COMO_ANA,
    });
    const inexistente = await s.inject({
      method: 'GET',
      url: '/admin/api/relatorios',
      headers: COMO_ANA,
    });
    expect(inexistente.statusCode).toBe(403);
    expect(inexistente.body).toBe(fechada.body);
  });
});

describe('restrito com só a aba IA — nenhum sinal das outras abas', () => {
  it('a página leva só o menu, o código e os estilos da IA', async () => {
    const s = montar();
    await liberar(s, ANA, ['ia']);
    const r = await s.inject({ method: 'GET', url: '/admin', headers: COMO_ANA });
    expect(r.statusCode).toBe(200);
    for (const nome of NOMES_DAS_OUTRAS_ABAS) {
      expect(r.body, nome).not.toContain(nome);
    }
    // Uma aba só: o menu vira o título dela.
    expect(r.body).toContain('<p class="nav-unica" data-aba="ia">IA</p>');
    expect(r.body).not.toContain('<button type="button" id="nav-');
    expect(r.body).toContain('id="aviso-ia"');
    expect(r.body).toContain('Entrou como <strong>ana</strong> · administrador restrito');
  });

  it('as respostas das rotas da IA não trazem dado de outras abas', async () => {
    const s = montar();
    await liberar(s, ANA, ['ia']);
    for (const url of [
      '/admin/api/ia',
      '/admin/api/ia/alerta',
      '/admin/api/ia/modelos',
      '/admin/api/ia/instrucoes',
    ]) {
      const r = await s.inject({ method: 'GET', url, headers: COMO_ANA });
      expect(r.statusCode, url).toBe(200);
      for (const nome of [
        'assinantes',
        'precoMensal',
        'workspace',
        'pagamento',
        'chaves',
        'planos',
      ]) {
        expect(r.body, `${url}: ${nome}`).not.toContain(nome);
      }
    }
  });

  it('com duas abas o menu lista só as duas', async () => {
    const s = montar();
    await liberar(s, ANA, ['ia', 'chaves']);
    const r = await s.inject({ method: 'GET', url: '/admin', headers: COMO_ANA });
    expect(r.body).toContain('>Chaves de API</button>');
    expect(r.body).toContain('>IA</button>');
    expect(r.body).not.toContain('>Planos</button>');
    expect(r.body).not.toContain('/admin/api/planos');
    expect(r.body).not.toContain('Mercado Pago');
  });

  it('Planos sem Assinaturas não leva a faixa de cobrança nem a rota de pagamento', async () => {
    const s = montar();
    await liberar(s, ANA, ['planos']);
    const r = await s.inject({ method: 'GET', url: '/admin', headers: COMO_ANA });
    expect(r.body).toContain('/admin/api/planos');
    expect(r.body).not.toContain('/admin/api/pagamento');
    expect(r.body).not.toContain('Mercado Pago');
    expect(r.body).not.toContain('/admin/api/assinaturas');
  });

  it('Assinaturas sozinha basta-se: o catálogo vem de uma rota da própria aba, sem contagens', async () => {
    const s = montar();
    await liberar(s, ANA, ['assinaturas']);
    const pagina = await s.inject({ method: 'GET', url: '/admin', headers: COMO_ANA });
    expect(pagina.body).toContain('/admin/api/assinaturas/planos');
    expect(pagina.body).not.toContain("'/admin/api/planos'");
    const catalogo = await s.inject({
      method: 'GET',
      url: '/admin/api/assinaturas/planos',
      headers: COMO_ANA,
    });
    expect(catalogo.statusCode).toBe(200);
    expect(catalogo.body).not.toContain('assinantes');
    expect(catalogo.json().planos.length).toBeGreaterThan(0);
    const aba = await s.inject({
      method: 'GET',
      url: '/admin/api/planos',
      headers: COMO_ANA,
    });
    expect(aba.statusCode).toBe(403);
  });

  it('sem nenhuma aba: tela curta, sem menu nem scripts, e todas as rotas negadas', async () => {
    const s = montar();
    const r = await s.inject({ method: 'GET', url: '/admin', headers: COMO_ANA });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(
      'Nenhuma área liberada para o seu acesso. Fale com o administrador.',
    );
    expect(r.body).not.toContain('<nav');
    expect(r.body).not.toContain('id="conteudo"');
    for (const nome of NOMES_DAS_OUTRAS_ABAS) expect(r.body, nome).not.toContain(nome);
    const api = await s.inject({
      method: 'GET',
      url: '/admin/api/ia',
      headers: COMO_ANA,
    });
    expect(api.statusCode).toBe(403);
  });
});

describe('liberar e tirar abas pela tela', () => {
  it('vale na requisição seguinte, nos dois sentidos', async () => {
    const s = montar();
    const aba = (): Promise<number> =>
      s
        .inject({ method: 'GET', url: '/admin/api/chaves', headers: COMO_ANA })
        .then((r) => r.statusCode);
    expect(await aba()).toBe(403);
    expect(await liberar(s, ANA, ['chaves'])).toBe(200);
    expect(await aba()).toBe(200);
    expect(await liberar(s, ANA, [])).toBe(200);
    expect(await aba()).toBe(403);
  });

  it('uma liberação não vaza para o outro restrito', async () => {
    const s = montar();
    await liberar(s, ANA, ['chaves']);
    const r = await s.inject({
      method: 'GET',
      url: '/admin/api/chaves',
      headers: COMO_BETO,
    });
    expect(r.statusCode).toBe(403);
  });

  it('o histórico guarda quem liberou e tirou qual aba de quem', async () => {
    const s = montar();
    await liberar(s, ANA, ['ia', 'chaves']);
    await liberar(s, ANA, ['ia']);
    const r = await s.inject({
      method: 'GET',
      url: '/admin/api/administradores',
      headers: COMO_DONO,
    });
    const historico = r.json().historico as Array<{
      por: string;
      usuario: string;
      aba: string;
      acao: string;
    }>;
    expect(historico.map((h) => `${h.acao}:${h.aba}`).sort()).toEqual(
      ['liberou:chaves', 'liberou:ia', 'tirou:chaves'].sort(),
    );
    for (const h of historico) {
      expect(h.por).toBe('dono');
      expect(h.usuario).toBe(ANA);
    }
    expect(
      r.json().restritos.find((x: { usuario: string }) => x.usuario === ANA).abas,
    ).toEqual(['ia']);
  });

  it('a gravação pede confirmação, só aceita abas da lista do código e usuário declarado', async () => {
    const s = montar();
    const pedir = (usuario: string, corpo: unknown) =>
      s.inject({
        method: 'PUT',
        url: `/admin/api/administradores/${usuario}/abas`,
        headers: COMO_DONO,
        payload: corpo as object,
      });
    expect((await pedir(ANA, { abas: ['ia'] })).statusCode).toBe(409);
    expect(
      (await pedir(ANA, { abas: ['administradores'], confirmado: true })).statusCode,
    ).toBe(400);
    expect(
      (await pedir(ANA, { abas: ['aba-inventada'], confirmado: true })).statusCode,
    ).toBe(400);
    const desconhecido = await pedir('fulano', { abas: ['ia'], confirmado: true });
    expect(desconhecido.statusCode).toBe(404);
    expect(desconhecido.body).not.toContain('fulano');
    const visao = await s.inject({
      method: 'GET',
      url: '/admin/api/administradores',
      headers: COMO_DONO,
    });
    expect(visao.json().historico).toEqual([]);
  });

  it('a lista de abas do código não muda com o banco: linha de aba desconhecida não abre nada', async () => {
    const s = montar();
    repo.substituir(ANA, ['aba-do-futuro'], 'x', new Date());
    const r = await s.inject({ method: 'GET', url: '/admin/api/ia', headers: COMO_ANA });
    expect(r.statusCode).toBe(403);
  });
});

describe('só o dono mexe nas permissões', () => {
  it('o restrito não lê nem altera as permissões, nem as próprias nem as de outro', async () => {
    const s = montar();
    await liberar(s, ANA, ['ia']);
    const ler = await s.inject({
      method: 'GET',
      url: '/admin/api/administradores',
      headers: COMO_ANA,
    });
    expect(ler.statusCode).toBe(403);
    for (const alvo of [ANA, BETO]) {
      const r = await s.inject({
        method: 'PUT',
        url: `/admin/api/administradores/${alvo}/abas`,
        headers: COMO_ANA,
        payload: { abas: ['ia', 'chaves', 'planos', 'assinaturas'], confirmado: true },
      });
      expect(r.statusCode, alvo).toBe(403);
    }
    const chaves = await s.inject({
      method: 'GET',
      url: '/admin/api/chaves',
      headers: COMO_ANA,
    });
    expect(chaves.statusCode).toBe(403);
  });

  it('a página do restrito nunca leva a tela Administradores', async () => {
    const s = montar();
    await liberar(s, ANA, ['ia', 'planos', 'chaves', 'assinaturas']);
    const r = await s.inject({ method: 'GET', url: '/admin', headers: COMO_ANA });
    expect(r.body).not.toContain('Administradores');
    expect(r.body).not.toContain('__pvAdministradores');
  });
});

describe('falha fechada', () => {
  function repositorioQueFalha(): RepositorioDePermissoesDoAdmin {
    const erro = (): never => {
      throw new Error('banco de permissões indisponível');
    };
    return {
      abasDe: erro,
      todas: erro,
      substituir: erro,
      historico: erro,
      registrarAcesso: erro,
      ultimosAcessos: erro,
    };
  }

  it('banco de permissões fora: o restrito não acessa nada (aviso curto); o dono acessa tudo', async () => {
    const s = montar({ permissoes: repositorioQueFalha() });
    const pagina = await s.inject({ method: 'GET', url: '/admin', headers: COMO_ANA });
    expect(pagina.statusCode).toBe(200);
    expect(pagina.body).toContain('Não foi possível verificar o seu acesso agora.');
    expect(pagina.body).not.toContain('<nav');
    for (const url of ['/admin/api/ia', '/admin/api/chaves', '/admin/api/assinaturas']) {
      const r = await s.inject({ method: 'GET', url, headers: COMO_ANA });
      expect(r.statusCode, url).toBe(403);
    }
    for (const url of [
      '/admin/api/ia',
      '/admin/api/chaves',
      '/admin/api/assinaturas',
      '/admin/api/planos',
    ]) {
      const r = await s.inject({ method: 'GET', url, headers: COMO_DONO });
      expect(r.statusCode, url).toBe(200);
    }
    const pdono = await s.inject({ method: 'GET', url: '/admin', headers: COMO_DONO });
    expect(pdono.body).toContain('>Chaves de API</button>');
  });

  it('usuário que sumiu da variável de ambiente não entra, mesmo com permissões no banco', async () => {
    const com = montar();
    await liberar(com, ANA, ['ia']);
    const permissoes = repo;
    await com.close();

    // Mesmo banco de permissões, mas a variável agora só declara o beto.
    const s = montar({ restritos: [RESTRITOS[1]!], permissoes });
    const r = await s.inject({ method: 'GET', url: '/admin/api/ia', headers: COMO_ANA });
    expect(r.statusCode).toBe(401);
    const visao = await s.inject({
      method: 'GET',
      url: '/admin/api/administradores',
      headers: COMO_DONO,
    });
    expect(visao.json().semCredencial).toEqual([{ usuario: ANA, abas: ['ia'] }]);
    expect(visao.json().restritos.map((x: { usuario: string }) => x.usuario)).toEqual([
      BETO,
    ]);
  });
});

describe('quem fez o quê', () => {
  it('ação do restrito na aba IA entra no histórico com o nome dele; o registro antigo aparece como do dono', async () => {
    const s = montar();
    await liberar(s, ANA, ['ia']);
    const r1 = await s.inject({
      method: 'PUT',
      url: '/admin/api/ia/alerta',
      headers: COMO_DONO,
      payload: { valorUsd: 4 },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await s.inject({
      method: 'PUT',
      url: '/admin/api/ia/alerta',
      headers: COMO_ANA,
      payload: { valorUsd: 5 },
    });
    expect(r2.statusCode).toBe(200);
    const painel = await s.inject({
      method: 'GET',
      url: '/admin/api/ia',
      headers: COMO_ANA,
    });
    const alteracoes = painel.json().alteracoes as Array<{ autor: string; por: string }>;
    expect(alteracoes[0]!.por).toBe('ana');
    expect(alteracoes[1]!.por).toBe('dono');
    // O banco guarda o hash curto do dono (igual ao de antes) e `u:<usuario>` do restrito.
    expect(alteracoes[1]!.autor).toBe(identificarOperador(DONO));
    expect(alteracoes[0]!.autor).toBe('u:ana');
  });
});

describe('credenciais e logs', () => {
  it('usuário inexistente e senha errada recebem a MESMA negação', async () => {
    const s = montar();
    const errada = await s.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basic(ANA, 'senha-errada-qualquer') },
    });
    const inexistente = await s.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basic('ninguem', 'senha-errada-qualquer') },
    });
    expect(errada.statusCode).toBe(401);
    expect(inexistente.statusCode).toBe(401);
    expect(inexistente.body).toBe(errada.body);
    expect(inexistente.headers['www-authenticate']).toBe(
      errada.headers['www-authenticate'],
    );
  });

  it('senha de um usuário com o nome de outro não entra', async () => {
    const s = montar();
    const r = await s.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basic(ANA, SENHA_DO_BETO) },
    });
    expect(r.statusCode).toBe(401);
  });

  it('depois de muitas senhas erradas o IP é barrado, até com a senha certa', async () => {
    const s = montar();
    for (let i = 0; i < 10; i++) {
      const r = await s.inject({
        method: 'GET',
        url: '/admin',
        headers: { authorization: basic(DONO, `errada-${i}`) },
      });
      expect(r.statusCode).toBe(401);
    }
    const barrada = await s.inject({ method: 'GET', url: '/admin', headers: COMO_DONO });
    expect(barrada.statusCode).toBe(429);
  });

  it('o pedido sem cabeçalho (o primeiro do navegador) não gasta tentativa', async () => {
    const s = montar();
    for (let i = 0; i < 15; i++) {
      const r = await s.inject({ method: 'GET', url: '/admin' });
      expect(r.statusCode).toBe(401);
    }
    const r = await s.inject({ method: 'GET', url: '/admin', headers: COMO_DONO });
    expect(r.statusCode).toBe(200);
  });

  it('log: acerto leva usuário e instante; erro, só instante e IP; negação por aba, usuário, aba e instante', async () => {
    const s = montar();
    await s.inject({ method: 'GET', url: '/admin', headers: COMO_ANA });
    await s.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basic('digitei-o-usuario', 'e-a-senha-que-errei') },
    });
    await s.inject({ method: 'GET', url: '/admin/api/chaves', headers: COMO_ANA });

    const acerto = registros.find((r) => r.mensagem === 'acesso administrativo');
    expect(acerto?.contexto?.['usuario']).toBe(ANA);
    expect(typeof acerto?.contexto?.['em']).toBe('string');

    const erro = registros.find((r) => r.mensagem === 'acesso administrativo recusado');
    expect(Object.keys(erro?.contexto ?? {}).sort()).toEqual(['em', 'ip']);

    const negado = registros.find(
      (r) => r.mensagem === 'acesso administrativo negado por aba',
    );
    expect(negado?.contexto?.['usuario']).toBe(ANA);
    expect(negado?.contexto?.['aba']).toBe('chaves');
    expect(typeof negado?.contexto?.['em']).toBe('string');
  });

  it('nenhuma resposta nem log contém uma senha', async () => {
    const s = montar();
    await liberar(s, ANA, ['ia', 'chaves']);
    const corpos: string[] = [];
    for (const [headers, urls] of [
      [
        COMO_DONO,
        ['/admin', '/admin/api/administradores', '/admin/api/chaves', '/admin/api/ia'],
      ],
      [
        COMO_ANA,
        ['/admin', '/admin/api/ia', '/admin/api/administradores', '/admin/api/planos'],
      ],
    ] as const) {
      for (const url of urls) {
        const r = await s.inject({ method: 'GET', url, headers });
        corpos.push(r.body, JSON.stringify(r.headers));
      }
    }
    await s.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basic(ANA, 'errada-que-nao-pode-vazar') },
    });
    const tudo = corpos.join('\n') + JSON.stringify(registros);
    for (const senha of [...SENHAS, 'errada-que-nao-pode-vazar']) {
      expect(tudo).not.toContain(senha);
    }
  });
});

describe('arranque', () => {
  const montarComRestritos = (restritos: string) =>
    construirServidor(
      aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
        admin: { usuario: DONO, senha: SENHA_DO_DONO },
      }),
      carregarConfig({
        PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
        LOG_LEVEL: 'silent',
        PROCESSOVIVO_API_KEYS: 'chave-de-teste-1234567890',
        PROCESSOVIVO_ADMIN_USUARIO: DONO,
        PROCESSOVIVO_ADMIN_SENHA: SENHA_DO_DONO,
        PROCESSOVIVO_ADMIN_RESTRITOS: restritos,
      } as NodeJS.ProcessEnv),
    );

  it('recusa configuração inválida sem imprimir a senha', () => {
    const senhaCurta = 'curta-demais-123';
    for (const ruim of [
      `ana:${senhaCurta}`,
      `Ana:${SENHA_DA_ANA}`,
      `ana:${SENHA_DA_ANA},ana:${SENHA_DO_BETO}`,
      `joao:${SENHA_DA_ANA}`,
    ]) {
      let mensagem = '';
      try {
        montarComRestritos(ruim);
      } catch (e) {
        mensagem = e instanceof Error ? e.message : String(e);
      }
      expect(mensagem, ruim).not.toBe('');
      for (const segredo of [senhaCurta, SENHA_DA_ANA, SENHA_DO_BETO]) {
        expect(mensagem).not.toContain(segredo);
      }
    }
  });

  it('aceita a configuração válida', () => {
    const s = montarComRestritos(`ana:${SENHA_DA_ANA},beto:${SENHA_DO_BETO}`);
    void s.close();
  });
});
