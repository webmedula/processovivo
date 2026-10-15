import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Peca } from '../../src/domain/entities/Peca.js';
import type { ConteudoPeca } from '../../src/domain/entities/Peca.js';
import type { ProvedorDePecas } from '../../src/domain/ports/ProvedorDePecas.js';
import type { CodigoPlano } from '../../src/domain/entities/Plano.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Config } from '../../src/infrastructure/config/env.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';

const CHAVE = 'chave-de-teste-1234567890';
const PROCESSO = '5818922-04.2026.8.09.0011';

class ProvedorFalsoDePecas implements ProvedorDePecas {
  readonly nome = 'mni-falso';
  readonly tribunais = ['TJGO'];

  async listarPecas(): Promise<Peca[]> {
    return [
      new Peca({
        id: 'doc-1',
        tipo: '57',
        tipoLocal: 'Petição Inicial',
        mimetype: 'application/pdf',
        conteudoDisponivel: true,
      }),
    ];
  }

  async obterConteudo(): Promise<ConteudoPeca> {
    return {
      id: 'doc-1',
      mimetype: 'application/pdf',
      nomeArquivo: 'peca.pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    };
  }
}

function config(): Config {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: CHAVE,
    CACHE_ENABLED: 'false',
  } as NodeJS.ProcessEnv);
}

const cabecalhos = { 'x-api-key': CHAVE };

/**
 * A chave de API resolve para um workspace fixo. Damos assinatura A ELE para
 * exercitar a guarda — em produção quem tem assinatura é a conta, mas o que
 * está sob teste aqui é a guarda da rota, não de onde vem o workspace.
 */
const WORKSPACE = workspaceDaChave(CHAVE);

async function comPlano(app: Aplicacao, plano: CodigoPlano, meses = 1): Promise<void> {
  await app.assinaturas.liberar({ workspace: WORKSPACE, plano, meses });
}

describe('API — planos e assinatura', () => {
  let app: Aplicacao;
  let servidor: FastifyInstance;

  beforeEach(() => {
    app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
      provedorDePecas: new ProvedorFalsoDePecas(),
    });
    servidor = construirServidor(app, config());
  });
  afterEach(async () => {
    await servidor.close();
  });

  async function cadastrarCredencial(): Promise<number> {
    const r = await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: cabecalhos,
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
    return r.statusCode;
  }

  it('sem assinatura nenhuma, as peças continuam funcionando', async () => {
    /*
     * A regra que impede a entrega da cobrança de derrubar as integrações do
     * próprio operador: workspace de chave de API nunca terá assinatura. Se
     * ausência fosse bloqueio, o n8n cairia no dia do deploy sem ninguém ter
     * comprado nada.
     */
    expect(await cadastrarCredencial()).toBe(201);
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });
    expect(r.statusCode).toBe(200);
  });

  it('plano Acompanhamento recebe 403 nas peças, com a mensagem que resolve', async () => {
    await comPlano(app, 'acompanhamento');

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });

    expect(r.statusCode).toBe(403);
    expect(r.json().erro).toBe('RECURSO_NAO_INCLUIDO_NO_PLANO');
    // A mensagem nomeia o plano que resolve. Erro que diz "indisponível" sem
    // dizer o que fazer é porta sem maçaneta.
    expect(r.json().mensagem).toContain('Peças');
  });

  it('plano Acompanhamento nem consegue cadastrar a credencial do tribunal', async () => {
    // Guardar a senha do Projudi de quem não pode usá-la seria custódia de
    // segredo sem contrapartida — e a senha ficaria lá, cifrada, sem serventia.
    await comPlano(app, 'acompanhamento');
    expect(await cadastrarCredencial()).toBe(403);
  });

  it('plano Peças passa', async () => {
    await comPlano(app, 'pecas');
    expect(await cadastrarCredencial()).toBe(201);

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().total).toBe(1);
  });

  it('assinatura vencida devolve 402, e NÃO 403', async () => {
    // Códigos diferentes porque as ações são diferentes: 402 é "pague o que
    // contratou", 403 é "contrate outro plano". Colapsar os dois manda metade
    // das pessoas ao lugar errado.
    await comPlano(app, 'pecas');
    expect(await cadastrarCredencial()).toBe(201);

    // Vence e passa da carência.
    const atual = await app.assinaturas.doWorkspace(WORKSPACE);
    expect(atual).toBeDefined();
    await app.assinaturas.cancelar(WORKSPACE, 'teste');

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });
    expect(r.statusCode).toBe(402);
    expect(r.json().erro).toBe('ASSINATURA_INATIVA');
  });

  it('quem perdeu o plano ainda consegue APAGAR a credencial que deixou aqui', async () => {
    /*
     * A única rota do arquivo sem guarda de plano, e de propósito. Exigir plano
     * para remover credencial significaria "pague para poder tirar seus dados"
     * — indefensável, e empurraria a pessoa a pedir exclusão da conta inteira
     * só para conseguir apagar uma senha.
     */
    await comPlano(app, 'pecas');
    expect(await cadastrarCredencial()).toBe(201);
    await app.assinaturas.liberar({
      workspace: WORKSPACE,
      plano: 'acompanhamento',
      meses: 1,
    });

    const r = await servidor.inject({
      method: 'DELETE',
      url: '/v1/credenciais/TJGO',
      headers: cabecalhos,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().removida).toBe(true);
  });

  it('a rota de assinatura diz o plano e nunca oferece o que não existe', async () => {
    await comPlano(app, 'pecas', 3);

    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/assinatura',
      headers: cabecalhos,
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().assinatura.plano).toBe('pecas');
    expect(r.json().assinatura.status).toBe('ativa');
    // O plano de IA está modelado e NÃO à venda enquanto a análise não existir.
    expect(r.json().planos.map((p: { codigo: string }) => p.codigo)).toEqual([
      'acompanhamento',
      'pecas',
    ]);
  });

  it('sem assinatura a rota responde 200 com null, não 404', async () => {
    // 404 faria a interface pintar erro onde não há: é o caso normal de uma
    // chave de API.
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/assinatura',
      headers: cabecalhos,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().assinatura).toBeNull();
  });
});

describe('cadastro cria o teste de 14 dias', () => {
  let app: Aplicacao;
  let servidor: FastifyInstance;

  beforeEach(() => {
    app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
      provedorDePecas: new ProvedorFalsoDePecas(),
      comAssinaturas: true,
    });
    servidor = construirServidor(app, config());
  });
  afterEach(async () => {
    await servidor.close();
  });

  it('a conta nasce com assinatura, e com as peças liberadas', async () => {
    /*
     * A janela que este teste fecha: se o teste fosse criado numa chamada
     * separada da rota, existiria um instante em que a conta existe sem
     * assinatura nenhuma. Quem caísse nela veria um sistema que aceitou o
     * cadastro e recusa tudo em seguida, sem explicar por quê.
     */
    const cadastro = await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: {
        email: 'ana@escritorio.com.br',
        nome: 'Ana',
        senha: 'senha-bem-comprida',
      },
    });
    expect(cadastro.statusCode).toBe(201);

    const cookie = cadastro.headers['set-cookie'];
    expect(cookie).toBeDefined();
    const sessao = {
      cookie: String(Array.isArray(cookie) ? cookie[0] : cookie).split(';')[0],
    };

    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/assinatura',
      headers: sessao,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().assinatura.status).toBe('teste');
    // O teste entrega o plano que mostra o DIFERENCIAL. Um teste que só dá
    // acompanhamento mostra ao advogado exatamente o que o concorrente também
    // faz, e ele decide não assinar por uma razão que não é verdadeira.
    expect(r.json().assinatura.plano).toBe('pecas');
    expect(r.json().assinatura.diasParaVencer).toBe(14);

    // E as peças funcionam de fato desde o primeiro minuto, não só no papel.
    const credencial = await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: sessao,
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
    expect(credencial.statusCode).toBe(201);
  });
});
