import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Config } from '../../src/infrastructure/config/env.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste, NotificadorEspiao } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import type { Notificador } from '../../src/domain/ports/Notificador.js';
import type { Logger } from '../../src/domain/ports/Logger.js';

const CHAVE = 'chave-de-teste-1234567890';
const SENHA = 'uma-senha-boa-o-bastante';
const SENHA_NOVA = 'outra-senha-igualmente-boa';
const URL_BASE = 'https://processovivo.exemplo.com.br';

function config(): Config {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: CHAVE,
    CACHE_ENABLED: 'false',
    COOKIE_SECURE: 'false',
  } as NodeJS.ProcessEnv);
}

/**
 * Sobe um servidor COM recuperação ligada (SMTP presente, endereço público
 * definido) e devolve junto o espião que recebe o que teria ido por e-mail.
 */
function montarComEmail(duracaoMs?: number): {
  servidor: FastifyInstance;
  correio: NotificadorEspiao;
  encerrar: () => Promise<void>;
} {
  const correio = new NotificadorEspiao();
  const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    recuperacao: {
      notificador: correio,
      urlBase: URL_BASE,
      ...(duracaoMs !== undefined ? { duracaoMs } : {}),
    },
  });
  const servidor = construirServidor(app, config());
  return {
    servidor,
    correio,
    encerrar: async () => {
      await servidor.close();
      app.encerrar();
    },
  };
}

/** Sobe um servidor SEM SMTP — o estado normal de uma instalação recém-feita. */
function montarSemEmail(): { servidor: FastifyInstance; encerrar: () => Promise<void> } {
  const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })]);
  const servidor = construirServidor(app, config());
  return {
    servidor,
    encerrar: async () => {
      await servidor.close();
      app.encerrar();
    },
  };
}

function cookieDe(resposta: { headers: Record<string, unknown> }): string {
  const bruto = resposta.headers['set-cookie'];
  const linha = Array.isArray(bruto) ? bruto[0] : bruto;
  return String(linha ?? '').split(';')[0] ?? '';
}

/** O token do link, como o navegador da pessoa o receberia. */
function tokenDoEmail(correio: NotificadorEspiao, indice = -1): string {
  const mensagem = correio.enviadas.at(indice);
  if (!mensagem) throw new Error('nenhum e-mail foi enviado');
  const achado = /[?&]recuperar=([^\s&]+)/.exec(mensagem.texto);
  if (!achado?.[1]) throw new Error('o e-mail não traz link de recuperação');
  return decodeURIComponent(achado[1]);
}

async function cadastrar(servidor: FastifyInstance, email: string) {
  return servidor.inject({
    method: 'POST',
    url: '/v1/contas',
    payload: { nome: 'Maria Silva', email, senha: SENHA },
  });
}

async function pedir(servidor: FastifyInstance, email: string) {
  return servidor.inject({
    method: 'POST',
    url: '/v1/senha/recuperar',
    payload: { email },
  });
}

async function redefinir(servidor: FastifyInstance, token: string, senhaNova: string) {
  return servidor.inject({
    method: 'POST',
    url: '/v1/senha/redefinir',
    payload: { token, senhaNova },
  });
}

describe('Recuperação de senha — disponibilidade', () => {
  let encerrar: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await encerrar?.();
    encerrar = undefined;
  });

  it('avisa que NÃO está disponível quando o servidor não manda e-mail', async () => {
    const m = montarSemEmail();
    encerrar = m.encerrar;

    const r = await m.servidor.inject({ method: 'GET', url: '/v1/senha/recuperar' });

    expect(r.statusCode).toBe(200);
    // A interface usa isto para NÃO desenhar o "esqueci minha senha". Oferecer
    // e não enviar deixaria a pessoa esperando uma mensagem que nunca sai.
    expect(r.json().disponivel).toBe(false);
  });

  it('avisa que está disponível quando há SMTP e endereço público', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;

    const r = await m.servidor.inject({ method: 'GET', url: '/v1/senha/recuperar' });

    expect(r.json().disponivel).toBe(true);
  });

  it('não exige autenticação: é a rota de quem não consegue entrar', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;

    const consulta = await m.servidor.inject({
      method: 'GET',
      url: '/v1/senha/recuperar',
    });
    const pedido = await pedir(m.servidor, 'ninguem@escritorio.com.br');

    expect(consulta.statusCode).toBe(200);
    expect(pedido.statusCode).toBe(202);
  });

  it('aceita o pedido e não envia nada quando o servidor não manda e-mail', async () => {
    const m = montarSemEmail();
    encerrar = m.encerrar;
    await cadastrar(m.servidor, 'maria@escritorio.com.br');

    const r = await pedir(m.servidor, 'maria@escritorio.com.br');

    // 202 mesmo assim: a resposta desta rota não pode variar com o estado do
    // servidor mais do que com o estado da conta.
    expect(r.statusCode).toBe(202);
  });
});

describe('Recuperação de senha — não conta quem é assinante', () => {
  let encerrar: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await encerrar?.();
    encerrar = undefined;
  });

  it('responde igual para e-mail cadastrado e não cadastrado', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;
    await cadastrar(m.servidor, 'maria@escritorio.com.br');

    const existente = await pedir(m.servidor, 'maria@escritorio.com.br');
    const inexistente = await pedir(m.servidor, 'ninguem@escritorio.com.br');

    expect(existente.statusCode).toBe(inexistente.statusCode);
    expect(existente.statusCode).toBe(202);
    // A MENSAGEM também: uma diferença de texto transformaria esta rota no
    // verificador de assinantes mais cômodo que existe — nem senha precisa.
    expect(existente.json()).toEqual(inexistente.json());
    // E só a conta real recebeu mensagem.
    expect(m.correio.enviadas).toHaveLength(1);
    expect(m.correio.enviadas[0]?.para).toBe('maria@escritorio.com.br');
  });

  it('responde igual para e-mail malformado', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;

    const r = await pedir(m.servidor, 'isto-nao-e-email');

    expect(r.statusCode).toBe(202);
    expect(m.correio.enviadas).toHaveLength(0);
  });

  it('responde sem esperar o SMTP, mesmo que ele nunca responda', async () => {
    /*
     * A falha que os outros testes deste arquivo não pegam, porque o espião
     * responde na hora.
     *
     * Medido contra um SMTP inalcançável: com `await` no envio, o pedido de um
     * e-mail CADASTRADO ficava pendurado até o timeout do nodemailer, enquanto
     * o de um endereço desconhecido voltava na hora. Status idêntico, mensagem
     * idêntica — e o relógio contando quem é assinante. Mesma enumeração que a
     * rota inteira existe para impedir, por outro canal.
     */
    const travado: Notificador = {
      nome: 'travado',
      habilitado: true,
      enviar: () => new Promise<boolean>(() => {}),
    };
    const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
      recuperacao: { notificador: travado, urlBase: URL_BASE },
    });
    const servidor = construirServidor(app, config());
    encerrar = async () => {
      await servidor.close();
      app.encerrar();
    };
    await cadastrar(servidor, 'maria@escritorio.com.br');

    const antes = Date.now();
    const conhecido = await pedir(servidor, 'maria@escritorio.com.br');
    const comEnvio = Date.now() - antes;

    const antes2 = Date.now();
    const desconhecido = await pedir(servidor, 'ninguem@escritorio.com.br');
    const semEnvio = Date.now() - antes2;

    expect(conhecido.statusCode).toBe(202);
    expect(desconhecido.statusCode).toBe(202);
    // Um envio pendurado para sempre não pode segurar a resposta. O teto é
    // generoso de propósito: o que se verifica aqui é que o caminho não espera
    // o SMTP, não a velocidade da máquina que roda a suíte.
    expect(comEnvio).toBeLessThan(1000);
    expect(Math.abs(comEnvio - semEnvio)).toBeLessThan(1000);
  });

  it('nunca devolve o token na resposta', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;
    await cadastrar(m.servidor, 'maria@escritorio.com.br');

    const r = await pedir(m.servidor, 'maria@escritorio.com.br');
    const token = tokenDoEmail(m.correio);

    // O token é a chave da conta por uma hora. Ele sai por um canal só: o
    // e-mail do dono. Devolvê-lo aqui entregaria a conta a quem digitou o
    // endereço alheio no formulário.
    expect(r.body).not.toContain(token);
  });

  it('para de enviar depois de cinco pedidos numa hora, sem mudar a resposta', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;
    await cadastrar(m.servidor, 'maria@escritorio.com.br');

    const respostas = [];
    for (let i = 0; i < 7; i += 1) {
      respostas.push(await pedir(m.servidor, 'maria@escritorio.com.br'));
    }

    // O limite protege a CAIXA DE ENTRADA do advogado, não a conta dele: sem
    // ele, qualquer um digita o endereço num laço e enche a caixa de mensagens
    // nossas — importunação com o nosso domínio no remetente.
    expect(m.correio.enviadas).toHaveLength(5);
    // E a resposta não muda: se mudasse, contaria de fora que aquele e-mail
    // tem conta e já pediu cinco vezes.
    for (const r of respostas) {
      expect(r.statusCode).toBe(202);
      expect(r.json()).toEqual(respostas[0]?.json());
    }
  });
});

describe('Recuperação de senha — o link', () => {
  let encerrar: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await encerrar?.();
    encerrar = undefined;
  });

  it('manda um link absoluto para o endereço público configurado', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;
    await cadastrar(m.servidor, 'maria@escritorio.com.br');

    await pedir(m.servidor, 'maria@escritorio.com.br');

    // Absoluto porque link relativo em e-mail não leva a lugar nenhum. E vindo
    // da configuração, não do cabeçalho `Host`: senão bastaria mandar outro
    // `Host` para o nosso servidor enviar, com a nossa cara, um link para o
    // endereço do atacante.
    expect(m.correio.enviadas[0]?.texto).toContain(URL_BASE + '/?recuperar=');
  });

  it('troca a senha e já entra, com sessão nova no cookie', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;
    await cadastrar(m.servidor, 'maria@escritorio.com.br');
    await pedir(m.servidor, 'maria@escritorio.com.br');

    const r = await redefinir(m.servidor, tokenDoEmail(m.correio), SENHA_NOVA);

    expect(r.statusCode).toBe(200);
    expect(r.json().usuario.email).toBe('maria@escritorio.com.br');
    expect(cookieDe(r)).toContain('processovivo_sessao=');
  });

  it('a senha nova passa a valer e a antiga para de valer', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;
    await cadastrar(m.servidor, 'maria@escritorio.com.br');
    await pedir(m.servidor, 'maria@escritorio.com.br');
    await redefinir(m.servidor, tokenDoEmail(m.correio), SENHA_NOVA);

    const comAntiga = await m.servidor.inject({
      method: 'POST',
      url: '/v1/sessoes',
      payload: { email: 'maria@escritorio.com.br', senha: SENHA },
    });
    const comNova = await m.servidor.inject({
      method: 'POST',
      url: '/v1/sessoes',
      payload: { email: 'maria@escritorio.com.br', senha: SENHA_NOVA },
    });

    expect(comAntiga.statusCode).toBe(401);
    expect(comNova.statusCode).toBe(200);
  });

  it('serve UMA vez: o mesmo link recusa na segunda', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;
    await cadastrar(m.servidor, 'maria@escritorio.com.br');
    await pedir(m.servidor, 'maria@escritorio.com.br');
    const token = tokenDoEmail(m.correio);

    const primeira = await redefinir(m.servidor, token, SENHA_NOVA);
    const segunda = await redefinir(m.servidor, token, 'terceira-senha-boa-assim');

    expect(primeira.statusCode).toBe(200);
    // Quem achar a mensagem no histórico do e-mail meses depois não entra.
    expect(segunda.statusCode).toBe(401);
  });

  it('recusa link vencido', async () => {
    // Duração negativa: o link já nasce fora do prazo.
    const m = montarComEmail(-1000);
    encerrar = m.encerrar;
    await cadastrar(m.servidor, 'maria@escritorio.com.br');
    await pedir(m.servidor, 'maria@escritorio.com.br');

    const r = await redefinir(m.servidor, tokenDoEmail(m.correio), SENHA_NOVA);

    expect(r.statusCode).toBe(401);
  });

  it('recusa token inventado com a MESMA resposta de um link já usado', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;
    await cadastrar(m.servidor, 'maria@escritorio.com.br');
    await pedir(m.servidor, 'maria@escritorio.com.br');
    const token = tokenDoEmail(m.correio);
    await redefinir(m.servidor, token, SENHA_NOVA);

    const usado = await redefinir(m.servidor, token, 'terceira-senha-boa-assim');
    const inventado = await redefinir(
      m.servidor,
      'token-que-nunca-existiu-0123456789',
      'terceira-senha-boa-assim',
    );

    // Distinguir "já usado" de "nunca existiu" contaria a quem achou o e-mail
    // que aquele link foi real — e portanto que a conta existe.
    expect(usado.statusCode).toBe(inventado.statusCode);
    expect(usado.json()).toEqual(inventado.json());
  });

  it('senha curta NÃO queima o link', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;
    await cadastrar(m.servidor, 'maria@escritorio.com.br');
    await pedir(m.servidor, 'maria@escritorio.com.br');
    const token = tokenDoEmail(m.correio);

    const curta = await redefinir(m.servidor, token, 'curta');
    const boa = await redefinir(m.servidor, token, SENHA_NOVA);

    expect(curta.statusCode).toBe(400);
    // Se o token fosse consumido antes de validar a senha, um erro de digitação
    // obrigaria a pedir outro e-mail — e o limite de cinco por hora tornaria
    // isso um caminho para ficar de fora da própria conta.
    expect(boa.statusCode).toBe(200);
  });
});

describe('Recuperação de senha — derruba o que estava aberto', () => {
  let encerrar: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await encerrar?.();
    encerrar = undefined;
  });

  it('encerra as sessões antigas ao redefinir', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;
    const cadastro = await cadastrar(m.servidor, 'maria@escritorio.com.br');
    const sessaoAntiga = cookieDe(cadastro);
    await pedir(m.servidor, 'maria@escritorio.com.br');
    await redefinir(m.servidor, tokenDoEmail(m.correio), SENHA_NOVA);

    const r = await m.servidor.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { cookie: sessaoAntiga },
    });

    // Quem recupera a senha pode estar justamente tirando alguém de dentro da
    // conta. Uma sessão sobrevivente anularia o resgate inteiro em silêncio.
    expect(r.statusCode).toBe(401);
  });

  it('trocar a senha pelo painel mata o link de recuperação pendente', async () => {
    const m = montarComEmail();
    encerrar = m.encerrar;
    const cadastro = await cadastrar(m.servidor, 'maria@escritorio.com.br');
    await pedir(m.servidor, 'maria@escritorio.com.br');
    const token = tokenDoEmail(m.correio);

    await m.servidor.inject({
      method: 'POST',
      url: '/v1/eu/senha',
      headers: { cookie: cookieDe(cadastro) },
      payload: { senhaAtual: SENHA, senhaNova: SENHA_NOVA },
    });
    const r = await redefinir(m.servidor, token, 'terceira-senha-boa-assim');

    // É justamente quem desconfia de invasão que troca a senha. Um link antigo
    // ainda válido seria a porta dos fundos que ela acabou de tentar fechar.
    expect(r.statusCode).toBe(401);
  });
});

describe('Recuperação de senha — o token não escapa para o log', () => {
  let encerrar: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await encerrar?.();
    encerrar = undefined;
  });

  /** Guarda tudo o que passaria pelo log, com o contexto de cada linha. */
  class LoggerEspiao implements Logger {
    readonly linhas: string[] = [];
    private registrar(mensagem: string, contexto?: Record<string, unknown>): void {
      this.linhas.push(mensagem + ' ' + JSON.stringify(contexto ?? {}));
    }
    debug = (m: string, c?: Record<string, unknown>): void => this.registrar(m, c);
    info = (m: string, c?: Record<string, unknown>): void => this.registrar(m, c);
    warn = (m: string, c?: Record<string, unknown>): void => this.registrar(m, c);
    error = (m: string, c?: Record<string, unknown>): void => this.registrar(m, c);
    child = (): Logger => this;
  }

  it('não escreve a query string da requisição no log de acesso', async () => {
    /*
     * Achado de revisão, e dos graves. O link do e-mail é
     * `GET /?recuperar=<token>`, e o hook `onResponse` registrava a URL inteira
     * em nível `info`. Um token válido, de uso único, com uma hora de vida,
     * escrito no log do contêiner — que vai para o painel e, muitas vezes, para
     * um coletor de terceiro. Quem lê o log toma a conta.
     */
    const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
      recuperacao: { notificador: new NotificadorEspiao(), urlBase: URL_BASE },
    });
    const espiao = new LoggerEspiao();
    const servidor = construirServidor({ ...app, logger: espiao }, config());
    encerrar = async () => {
      await servidor.close();
      app.encerrar();
    };

    const token = 'tOkEn-QuE-nAo-PoDe-VaZaR-0123456789';
    await servidor.inject({ method: 'GET', url: `/?recuperar=${token}` });

    expect(espiao.linhas.length).toBeGreaterThan(0);
    for (const linha of espiao.linhas) {
      expect(linha).not.toContain(token);
      expect(linha).not.toContain('recuperar=');
    }
    // E o caminho continua no log: cortar a query não pode cegar quem opera.
    expect(espiao.linhas.some((l) => l.includes('"rota":"/"'))).toBe(true);
  });
});
