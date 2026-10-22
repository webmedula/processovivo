import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../infrastructure/config/env.js';
import { VERSAO } from '../../infrastructure/config/versao.js';
import type { Aplicacao } from '../factories/makeProcessoSearchService.js';
import { LocalizadorDeWorkspace } from '../../application/services/LocalizadorDeWorkspace.js';
import { validarChavesDeApi, workspaceDaChave } from './chaves.js';
import { validarConfiguracaoAdmin } from './adminAuth.js';
import { mapearErro } from './erros.js';
import autenticacao from './plugins/autenticacao.js';
import { ROTA_HEALTH, ROTA_READY, rotasDeSaude } from './rotas/saude.js';
import {
  PREFIXO_FONTES,
  PREFIXO_PDFJS,
  ROTA_CONSOLE,
  ROTA_FONTES,
  ROTA_PDFJS,
  rotasDeInterface,
} from './rotas/interface.js';
import { rotasDeProcesso } from './rotas/processos.js';
import { rotasDeAcompanhamento } from './rotas/acompanhamentos.js';
import { rotasDeVigilancia } from './rotas/vigilancias.js';
import { rotasDePecas } from './rotas/pecas.js';
import { rotasDoLeitor } from './rotas/leitor.js';
import { rotasDaPasta } from './rotas/pasta.js';
import { ROTA_DRIVE_RETORNO, rotasDoDrive } from './rotas/drive.js';
import { rotasDoPainel } from './rotas/painel.js';
import { rotasDaAnaliseIA } from './rotas/analiseIA.js';
import { rotasDoResumoIA } from './rotas/resumoIA.js';
import { rotasDaAnaliseDePecaIA } from './rotas/analiseDePecaIA.js';
import { ROTA_FEED_PUBLICO, rotasDoCalendario } from './rotas/calendario.js';
import { rotasDeCustos } from './rotas/custos.js';
import { ROTA_PLANOS_PUBLICOS, rotasDePlanosPublicos } from './rotas/planosPublicos.js';
import { rotasDeAssinaturas } from './rotas/assinaturas.js';
import { ROTA_WEBHOOK_DE_PAGAMENTO, rotasDePagamentos } from './rotas/pagamentos.js';
import { ROTAS_ADMIN, rotasDeAdmin } from './rotas/admin.js';
import {
  ROTA_CONTAS,
  ROTA_RECUPERAR,
  ROTA_REDEFINIR,
  ROTA_SESSOES,
  rotasDeContas,
} from './rotas/contas.js';

/**
 * Monta o servidor HTTP sem subir porta nenhuma.
 *
 * Separar a MONTAGEM da ESCUTA é o que permite testar a API inteira com
 * `servidor.inject()` — sem porta, sem race de bind, sem espera. `iniciar()`,
 * abaixo, é a única função que chama `listen`.
 */
export function construirServidor(app: Aplicacao, config: Config): FastifyInstance {
  // Antes de qualquer coisa: configuração de autenticação inválida derruba a
  // montagem, não vira um serviço aberto por acidente.
  validarChavesDeApi(config.http.chavesDeApi, config.http.autenticacaoDesativada);
  validarConfiguracaoAdmin(config.admin.usuario, config.admin.senha);

  const servidor = Fastify({
    // O log sai pelo nosso `Logger` (uma linha JSON por evento) para que
    // aplicação e HTTP tenham o mesmo formato nos logs do Easypanel.
    logger: false,
    bodyLimit: config.http.bodyLimitBytes,
    // Atrás do Traefik do Easypanel, sem isso todo request parece vir do IP do
    // proxy — e o rate limit por IP vira rate limit global.
    //
    // UM salto, e não `true`. Com `true` o Fastify aceita a cadeia INTEIRA de
    // X-Forwarded-For — e essa cadeia é escrita pelo cliente. Bastaria mandar
    // um IP diferente a cada requisição para cair sempre num balde novo de
    // rate limit e anular o limite; na rota de login, que é pública e gasta
    // scrypt, isso é força bruta sem teto e consumo de memória do contêiner ao
    // mesmo tempo.
    //
    // A função devolve `true` só para o salto 0: confia exclusivamente no IP
    // que o nosso próprio proxy (o Traefik do Easypanel) acrescentou, e ignora
    // tudo o que vier antes dele.
    trustProxy: config.http.confiarNoProxy ? (_endereco, salto) => salto === 0 : false,
  });

  const log = app.logger.child({ camada: 'http' });

  if (config.http.corsOrigins.length > 0) {
    void servidor.register(cors, { origin: [...config.http.corsOrigins] });
  }

  void servidor.register(rateLimit, {
    max: config.http.rateLimitMax,
    timeWindow: config.http.rateLimitJanelaMs,
    // Limite por CHAVE quando autenticado, por IP quando não. Sem isso, um
    // cliente atrás de NAT compartilharia a cota com estranhos.
    keyGenerator: (requisicao) => requisicao.identidadeDaChave ?? requisicao.ip,
    // Health checks não gastam cota: eles rodam a cada poucos segundos.
    allowList: (requisicao) =>
      requisicao.url === ROTA_HEALTH ||
      requisicao.url === ROTA_READY ||
      requisicao.url === ROTA_CONSOLE ||
      requisicao.url.startsWith(PREFIXO_FONTES) ||
      // O PDF.js pede dezenas de arquivos ao abrir (fontes padrão, decodificador):
      // são estáticos e sem dado, e não podem gastar a cota das consultas.
      requisicao.url.startsWith(PREFIXO_PDFJS),
  });

  void servidor.register(autenticacao, {
    chaves: config.http.chavesDeApi,
    desativada: config.http.autenticacaoDesativada,
    contas: app.contas,
    chavesDb: app.repositorioChavesApi,
    // O console entra aqui porque é HTML sem dado nenhum. Se ele exigisse
    // chave, o navegador cairia no mesmo 401 que a página existe para resolver.
    //
    // Criar conta e entrar TÊM que ser públicas: são justamente as rotas de
    // quem ainda não tem como se autenticar.
    //
    // As rotas administrativas entram pelo mesmo motivo do console — são
    // "públicas" só do ponto de vista DESTE plugin, porque respondem a outra
    // autenticação (Basic Auth, em `autenticacaoAdmin`), nunca a chave de API
    // nem sessão de assinante. Ver o porquê em `rotas/admin.ts`.
    rotasPublicas: [
      ROTA_HEALTH,
      ROTA_READY,
      ROTA_CONSOLE,
      ROTA_FONTES,
      // O PDF.js entra por import() e new Worker(): o navegador não manda
      // x-api-key nessas requisições. São arquivos da biblioteca, sem dado.
      ROTA_PDFJS,
      ROTA_CONTAS,
      ROTA_SESSOES,
      // Recuperar e redefinir senha são de quem NÃO consegue entrar. Exigir
      // autenticação nelas seria pedir a chave para quem perdeu a chave.
      ROTA_RECUPERAR,
      ROTA_REDEFINIR,
      // O feed ICS se autentica pelo PRÓPRIO token, na URL: o Google Agenda e o
      // Outlook não mandam cookie nem chave de API. Sem token válido, 404.
      ROTA_FEED_PUBLICO,
      // Volta do Google: navegação sem cookie nem chave; autentica-se pelo `state` assinado.
      ROTA_DRIVE_RETORNO,
      // O aviso do gateway de pagamento: sem cookie e sem chave. Quem o autentica é a assinatura do
      // próprio aviso (`x-signature`); inválida = 401. Desligado o recurso, a rota nem existe (404).
      ROTA_WEBHOOK_DE_PAGAMENTO,
      // A vitrine do site de vendas: só planos à venda e preço de vitrine, sem conta nem chave.
      ROTA_PLANOS_PUBLICOS,
      ...ROTAS_ADMIN,
    ],
  });

  void servidor.register(
    rotasDeContas(app.contas, app.pecas, {
      // Cookie `Secure` exige HTTPS. Em produção o Traefik do Easypanel termina
      // TLS, então vale; em desenvolvimento por http://localhost o navegador
      // DESCARTARIA o cookie e o login pareceria não funcionar.
      cookieSeguro: config.http.cookieSeguro,
    }),
  );
  void servidor.register(rotasDeSaude(app));
  void servidor.register(rotasDeInterface());
  void servidor.register(rotasDeProcesso(app));
  void servidor.register(rotasDeAcompanhamento(app.acompanhamento, config.telas));
  void servidor.register(rotasDePecas(app.pecas, app.assinaturas));
  void servidor.register(
    rotasDaAnaliseIA(app.analiseIa, app.avisoDoPrazo, {
      planos: app.planos,
      usuarios: app.usuarios,
      pagamentoDisponivel: app.pagamentos !== undefined,
    }),
  );
  void servidor.register(rotasDoResumoIA(app.resumoDoProcesso));
  void servidor.register(rotasDaAnaliseDePecaIA(app.analiseDePeca, app.pasta));
  void servidor.register(rotasDoLeitor(app.leitor, app.assinaturas));
  void servidor.register(rotasDaPasta(app.pasta, app.assinaturas));
  void servidor.register(rotasDoDrive(app.drive));
  void servidor.register(
    rotasDoPainel(app.acompanhamento, app.pecas, config.telas.pendenciaJanelaDias),
  );
  void servidor.register(
    rotasDoCalendario(app.calendario, app.assinaturas, {
      urlBase: config.http.urlBase,
      resumo: app.resumoDoCalendario,
    }),
  );
  void servidor.register(
    rotasDeCustos(app.custos, app.assinaturas, app.custosPorCliente),
  );
  void servidor.register(
    rotasDeAssinaturas(app.assinaturas, app.planos, {
      pagamentos: app.pagamentos,
      urlDosTermos: config.pagamento.urlDosTermos,
    }),
  );
  void servidor.register(
    rotasDePlanosPublicos(app.planos, {
      pagamentoDisponivel: app.pagamentos !== undefined,
      siteUrl: config.http.siteUrl,
    }),
  );
  void servidor.register(rotasDePagamentos(app.pagamentos, log));
  void servidor.register(rotasDeVigilancia(app.vigilancia, app.preferenciasNotificacao));
  void servidor.register(
    rotasDeAdmin({
      ...(app.adminCredenciais ? { credenciais: app.adminCredenciais } : {}),
      assinaturas: app.assinaturas,
      planos: app.planos,
      repositorioAssinaturas: app.repositorioAssinaturas,
      pagamentos: app.pagamentos,
      emProducao: config.pagamento.emProducao,
      usuarios: app.usuarios,
      chavesApi: app.chavesApi,
      localizador: new LocalizadorDeWorkspace({
        usuarios: app.usuarios,
        chavesApi: app.chavesApi,
        workspacesDeChavesDoEnv: config.http.chavesDeApi.map(workspaceDaChave),
      }),
    }),
  );

  servidor.setNotFoundHandler((requisicao, resposta) => {
    void resposta.code(404).send({
      erro: 'ROTA_NAO_ENCONTRADA',
      mensagem: `Nenhuma rota para ${requisicao.method} ${requisicao.url}.`,
    });
  });

  servidor.setErrorHandler((erro: unknown, requisicao, resposta) => {
    // O rate limit do plugin chega como erro comum; preservamos o 429.
    if (temStatusCode(erro) && erro.statusCode === 429) {
      void resposta.code(429).send({
        erro: 'LIMITE_EXCEDIDO',
        mensagem: 'Muitas requisições. Tente novamente em instantes.',
      });
      return;
    }

    // Corpo maior que o teto da rota (o do comprovante é de 5 MB; o do resto da API é pequeno): o
    // Fastify recusa ANTES de chamar a rota. 413 em JSON, com `motivo`, para a tela dizer a frase.
    if (
      typeof erro === 'object' &&
      erro !== null &&
      (erro as { code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
    ) {
      void resposta.code(413).send({
        erro: 'CORPO_GRANDE_DEMAIS',
        mensagem: 'O arquivo ou o pedido é maior que o permitido.',
        detalhes: { motivo: 'arquivo_grande' },
      });
      return;
    }

    const { status, corpo } = mapearErro(erro);

    // 5xx é o único que merece log de erro — 4xx é o cliente errando, e tratar
    // isso como incidente enche o log de ruído até ninguém mais olhar.
    const contexto = {
      metodo: requisicao.method,
      rota: rotaParaLog(requisicao.url, requisicao.routeOptions.url),
      status,
      erro: corpo.erro,
      chave: requisicao.identidadeDaChave,
    };
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    if (status >= 500) {
      log.error(mensagem, {
        ...contexto,
        stack: erro instanceof Error ? erro.stack : undefined,
      });
    } else {
      log.debug(mensagem, contexto);
    }

    void resposta.code(status).send(corpo);
  });

  servidor.addHook('onResponse', async (requisicao, resposta) => {
    if (requisicao.url === ROTA_HEALTH) return;
    log.info('requisição atendida', {
      metodo: requisicao.method,
      rota: rotaParaLog(requisicao.url, requisicao.routeOptions.url),
      status: resposta.statusCode,
      duracaoMs: Math.round(resposta.elapsedTime),
      chave: requisicao.identidadeDaChave,
    });
  });

  return servidor;
}

/**
 * O caminho da requisição SEM a query string.
 *
 * Achado numa revisão de segurança, e sério: o link de recuperação de senha
 * chega como `GET /?recuperar=<token>`, e o log registrava a URL inteira. Um
 * token válido, de uso único, com uma hora de vida, escrito em nível `info` no
 * log do contêiner — que vai para o Easypanel e, com frequência, para um
 * coletor de terceiro. Quem lê o log toma a conta.
 *
 * Cortar a query INTEIRA, e não os parâmetros conhecidos: uma lista de nomes
 * proibidos envelhece mal — a próxima rota com segredo na URL entra sem que
 * ninguém lembre de acrescentá-la, e a falha volta calada. O caminho basta para
 * saber qual rota foi chamada, que é para o que o log serve.
 *
 * (O lado do navegador já se protegia: o console apaga `?recuperar=` da barra
 * de endereço com `replaceState` antes de qualquer outra coisa. Mas isso é
 * depois de o servidor ter respondido — e escrito o log.)
 */
function rotaParaLog(url: string, padrao?: string): string {
  // Rota cujo CAMINHO é o segredo: o log leva o padrão, não o caminho. O feed
  // do calendário é `/calendario/feed/<token>.ics`, e o token é a única coisa
  // que separa a agenda do advogado de quem lê o log.
  if (padrao !== undefined && ROTAS_COM_SEGREDO_NO_CAMINHO.has(padrao)) return padrao;
  const corte = url.indexOf('?');
  return corte === -1 ? url : url.slice(0, corte);
}

const ROTAS_COM_SEGREDO_NO_CAMINHO: ReadonlySet<string> = new Set([ROTA_FEED_PUBLICO]);

function temStatusCode(erro: unknown): erro is { statusCode: number } {
  return (
    typeof erro === 'object' &&
    erro !== null &&
    typeof (erro as { statusCode?: unknown }).statusCode === 'number'
  );
}

/**
 * Sobe o servidor e trata SIGTERM.
 *
 * O SIGTERM importa mais do que parece: em todo redeploy o Easypanel manda
 * SIGTERM e espera. Sem tratar, o Node morre na hora e derruba as requisições
 * em voo — e o usuário vê erro a cada deploy. Com `close()`, as respostas em
 * andamento terminam antes de o processo sair.
 */
export async function iniciar(app: Aplicacao, config: Config): Promise<FastifyInstance> {
  const servidor = construirServidor(app, config);

  await servidor.listen({ host: config.http.host, port: config.http.porta });

  // Só depois de o servidor estar de pé: se a varredura começasse antes, o
  // health check poderia falhar enquanto o processo está ocupado consultando.
  app.agendador.iniciar();
  // A varredura de OAB tem relógio próprio: roda de hora em hora porque só toca
  // o DJEN, enquanto a de processos espera 12h por causa dos 20 segundos do
  // DataJud. Amarrar as duas no mesmo intervalo faria a fonte lenta ditar o
  // ritmo da rápida — e é na rápida que estão as publicações que abrem prazo.
  app.agendadorVigilancia?.iniciar();
  app.agendadorBackup?.iniciar();
  app.agendadorLeitor?.iniciar();
  app.agendadorLimpezaLeitor?.iniciar();
  app.agendadorLimpezaAnalisesDePeca?.iniciar();
  app.agendadorCalendario?.iniciar();
  app.agendadorResumoDoCalendario?.iniciar();

  app.logger.info('Processo Vivo no ar', {
    versao: VERSAO,
    host: config.http.host,
    porta: config.http.porta,
    fontes: config.cadeiaDeProviders,
    autenticacao: config.http.autenticacaoDesativada ? 'DESATIVADA' : 'chave de API',
    admin: app.adminCredenciais ? 'ligada' : 'desligada',
  });

  let encerrando = false;
  const encerrar = (sinal: string): void => {
    if (encerrando) return;
    encerrando = true;
    app.logger.info('encerrando com elegância', { sinal });
    servidor
      .close()
      .then(() => {
        app.encerrar();
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };

  process.on('SIGTERM', () => encerrar('SIGTERM'));
  process.on('SIGINT', () => encerrar('SIGINT'));

  return servidor;
}
