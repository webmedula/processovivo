import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirServidor } from '../../src/main/http/servidor.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { montarAplicacao } from '../../src/main/factories/makeProcessoSearchService.js';

const CHAVE = 'chave-de-teste-1234567890';

function montar(): FastifyInstance {
  const config = carregarConfig({
    PROCESSOVIVO_DB_PATH: ':memory:',
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    MOCK_CRAWLER_LATENCY_MS: '0',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: CHAVE,
  } as NodeJS.ProcessEnv);
  return construirServidor(montarAplicacao(config), config);
}

describe('console web', () => {
  let servidor: FastifyInstance;

  beforeEach(() => {
    servidor = montar();
  });
  afterEach(async () => {
    await servidor.close();
  });

  it('a raiz serve HTML sem exigir chave', async () => {
    // É o ponto inteiro da página: digitar a URL no navegador tem que abrir o
    // sistema, não devolver {"erro":"NAO_AUTENTICADO"}.
    const r = await servidor.inject({ method: 'GET', url: '/' });

    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('<title>Processo Vivo</title>');
  });

  it('mostra a versão em execução', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/' });
    expect(r.body).toMatch(/v\d+\.\d+\.\d+/);
  });

  it('oferece consulta por número e por OAB', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/' });
    expect(r.body).toContain('/v1/processos/');
    expect(r.body).toContain('/v1/advogados/');
  });

  it('não embute chave de API nenhuma no HTML', async () => {
    // A página pede a chave ao usuário; ela nunca é servida pelo servidor.
    const r = await servidor.inject({ method: 'GET', url: '/' });
    expect(r.body).not.toContain(CHAVE);
  });

  it('não é cacheada nem indexada', async () => {
    const r = await servidor.inject({ method: 'GET', url: '/' });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-robots-tag']).toBe('noindex');
  });

  it('não carrega nada de fora — funciona sem internet', async () => {
    // Nenhum script, fonte ou CSS externo: a página é uma string do servidor.
    const r = await servidor.inject({ method: 'GET', url: '/' });
    expect(r.body).not.toMatch(/<script[^>]+src=/i);
    expect(r.body).not.toMatch(/<link[^>]+href="https?:/i);
  });

  it('as rotas de dados continuam protegidas', async () => {
    // Servir a página aberta não pode ter aberto a API junto.
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/processos/1234567-47.2023.8.26.0100',
    });
    expect(r.statusCode).toBe(401);
  });

  it('mantém a classificação de andamentos internos e marcos', async () => {
    // Se estas tabelas sumirem, a linha do tempo volta a ser um muro de 361
    // itens. Os códigos vieram de uma resposta REAL do TJGO.
    const r = await servidor.inject({ method: 'GET', url: '/' });

    expect(r.body).toMatch(/var INTERNOS=\{[^}]*12266/);
    expect(r.body).toMatch(/var MARCOS=\{[^}]*848/);
  });

  it('nunca descarta andamento: o recolhido é contado e reversível', async () => {
    // Sumir com movimentação em silêncio é como se perde prazo. O botão de
    // alternar e a contagem precisam existir na página.
    const r = await servidor.inject({ method: 'GET', url: '/' });

    expect(r.body).toContain('interno(s)');
    expect(r.body).toContain('Nada foi descartado');
    expect(r.body).toContain('alternar');
  });

  it('o console não consome cota do rate limit', async () => {
    for (let i = 0; i < 8; i++) {
      const r = await servidor.inject({ method: 'GET', url: '/' });
      expect(r.statusCode).toBe(200);
    }
  });
});

/**
 * A interface é o único lugar onde o advogado consegue cadastrar o acesso dele
 * no tribunal. Sem ela, a v0.12.0 existe só para quem chama a API com curl — foi
 * exatamente o que aconteceu no primeiro deploy, e é o que estes testes impedem
 * de acontecer de novo em silêncio.
 */
describe('console — peças e acessos de tribunal', () => {
  let servidor: FastifyInstance;

  beforeEach(() => {
    servidor = montar();
  });
  afterEach(async () => {
    await servidor.close();
  });

  async function console_(): Promise<string> {
    return (await servidor.inject({ method: 'GET', url: '/' })).body;
  }

  it('oferece a aba de acessos na navegação', async () => {
    const html = await console_();
    expect(html).toContain('nav-credenciais');
    expect(html).toContain('Meus acessos');
  });

  it('tem formulário com tribunal, CPF e senha', async () => {
    const html = await console_();
    expect(html).toContain('c-trib');
    expect(html).toContain('c-id');
    expect(html).toContain('c-senha');
  });

  it('avisa que a senha fica cifrada e não volta para a tela', async () => {
    // A senha some do campo depois de salva, e isso PARECE defeito para quem
    // não foi avisado — o texto na tela é parte do funcionamento.
    expect(await console_()).toContain('cifrada no servidor');
  });

  it('carrega as peças na tela do processo', async () => {
    const html = await console_();
    expect(html).toContain('carregarPecas');
    expect(html).toContain('/pecas');
  });

  it('explica o 428 em vez de mostrar erro cru', async () => {
    // Sem credencial cadastrada, a resposta correta é um convite a cadastrar —
    // não "erro 428" na cara de quem só queria ler a petição.
    const html = await console_();
    expect(html).toContain('Cadastrar o acesso do advogado');
    expect(html).toContain('publicados no diário');
  });
});

/**
 * A busca por OAB já recebia as partes e as descartava. Uma carteira de 130
 * processos sem mostrar quem é a parte obriga o advogado a abrir um por um
 * para achar os do cliente X — que é justamente o trabalho que ele esperava
 * que o sistema fizesse.
 *
 * Aqui se verifica o CONSOLE, que é uma string servida pelo servidor: o que dá
 * para afirmar é que o código está na página e que as funções puras dele fazem
 * o que dizem. Comportamento de clique exigiria navegador, e não temos um na
 * suíte.
 */
describe('console — resultado da busca por OAB', () => {
  let servidor: FastifyInstance;

  beforeEach(() => {
    servidor = montar();
  });
  afterEach(async () => {
    await servidor.close();
  });

  async function pagina(): Promise<string> {
    return (await servidor.inject({ method: 'GET', url: '/' })).body;
  }

  it('desenha o resultado por função própria, e não dentro do fetch', async () => {
    // Separar o desenho da busca é o que permite refiltrar sem reconsultar o
    // DJEN: uma ida à rede por tecla digitada seria inaceitável.
    expect(await pagina()).toContain('function desenharBuscaOab');
  });

  it('tem o campo de filtro por parte', async () => {
    const html = await pagina();
    expect(html).toContain('Filtrar por parte, classe ou número');
  });

  it('guarda o resultado no estado do console, não em variável global', async () => {
    // Filtro em variável global sobrevive a trocar de aba e só morre com
    // recarregamento — foi assim que um filtro esquecido fez a carteira
    // parecer ter um processo em vez de três.
    const html = await pagina();
    expect(html).toContain('estado.buscaOab');
    expect(html).not.toContain('window.__oab');
  });

  it('anuncia quando o filtro está escondendo processos', async () => {
    expect(await pagina()).toContain('Mostrando <b>');
  });

  it('traduz o polo para palavra de advogado', async () => {
    const html = await pagina();
    expect(html).toContain('function rotuloPolo');
    expect(html).toContain("ATIVO:'autor'");
  });

  it('normaliza a CAIXA ALTA que o DJEN manda, com acento minúsculo', async () => {
    const html = await pagina();
    // A função que o navegador recebe é a do domínio (nomeDaClasse), injetada por toString().
    const fonte = /var nomeDaClasse=(function nomeDaClasse[\s\S]*?\n\});/.exec(html);
    expect(fonte).not.toBeNull();

    const titulo = new Function(`return ${fonte?.[1]};`)() as (t: string) => string;

    // O DJEN manda caixa alta com os acentuados em minúscula: chega
    // literalmente "AçãO TRABALHISTA". Exigir 100% de maiúsculas deixaria
    // passar exatamente o caso que motivou a função.
    expect(titulo('AçãO TRABALHISTA - RITO ORDINáRIO')).toBe(
      'Ação Trabalhista - Rito Ordinário',
    );
    expect(titulo('CUMPRIMENTO DE SENTENçA')).toBe('Cumprimento de Sentença');
    expect(titulo('EMBARGOS à EXECUçãO FISCAL')).toBe('Embargos à Execução Fiscal');
    // Texto já escrito normalmente passa intacto — normalizar de novo estragaria.
    expect(titulo('Execução Fiscal')).toBe('Execução Fiscal');
    expect(titulo('')).toBe('');
  });
});
