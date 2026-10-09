import { ProcessoSearchService } from '../../application/services/ProcessoSearchService.js';
import { ServicoAcompanhamento } from '../../application/services/ServicoAcompanhamento.js';
import { ServicoNotificacao } from '../../application/services/ServicoNotificacao.js';
import { ServicoPecas } from '../../application/services/ServicoPecas.js';
import { GuardaDePecas } from '../../application/services/GuardaDePecas.js';
import { ServicoLeitor } from '../../application/services/ServicoLeitor.js';
import { ServicoPasta } from '../../application/services/ServicoPasta.js';
import { ServicoCalendario } from '../../application/services/ServicoCalendario.js';
import { comIndicadorDeDestinatario } from '../../application/services/indicadorDeDestinatario.js';
import { comDeteccaoDoCalendario } from '../../application/services/ingestaoDoCalendario.js';
import { OabsDoWorkspaceSqlite } from '../../infrastructure/persistencia/sqlite/OabsDoWorkspaceSqlite.js';
import { RepositorioDeEventosSqlite } from '../../infrastructure/persistencia/sqlite/RepositorioDeEventosSqlite.js';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CredencialTribunal } from '../../domain/ports/ProvedorDePecas.js';
import { ArmazemEmDisco } from '../../infrastructure/arquivos/ArmazemEmDisco.js';
import { QpdfMontador } from '../../infrastructure/pdf/QpdfMontador.js';
import { FilaDeJobsSqlite } from '../../infrastructure/persistencia/sqlite/FilaDeJobsSqlite.js';
import { ServicoVigilanciaOab } from '../../application/services/ServicoVigilanciaOab.js';
import type { BuscaPorOabComPeriodo } from '../../application/services/ServicoVigilanciaOab.js';
import { Agendador } from '../../infrastructure/agenda/Agendador.js';
import type { Notificador } from '../../domain/ports/Notificador.js';
import type { RepositorioNotificacao } from '../../domain/ports/RepositorioNotificacao.js';
import {
  EmailSmtpNotificador,
  LogNotificador,
} from '../../infrastructure/notificacao/EmailSmtpNotificador.js';
import { abrirBanco } from '../../infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioNotificacaoSqlite } from '../../infrastructure/persistencia/sqlite/RepositorioNotificacaoSqlite.js';
import { RepositorioVigilanciasSqlite } from '../../infrastructure/persistencia/sqlite/RepositorioVigilanciasSqlite.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { ProcessoProvider } from '../../domain/ports/ProcessoProvider.js';
import { BuscarProcessoPorNumero } from '../../domain/usecases/BuscarProcessoPorNumero.js';
import { BuscarProcessosPorOab } from '../../domain/usecases/BuscarProcessosPorOab.js';
import { BaixarPecaDoProcesso } from '../../domain/usecases/BaixarPecaDoProcesso.js';
import { ListarPecasDoProcesso } from '../../domain/usecases/ListarPecasDoProcesso.js';
import { MniAdapter } from '../../infrastructure/adapters/mni/MniAdapter.js';
import { RepositorioDaPastaSqlite } from '../../infrastructure/persistencia/sqlite/RepositorioDaPastaSqlite.js';
import { RepositorioPecasBaixadasSqlite } from '../../infrastructure/persistencia/sqlite/RepositorioPecasBaixadasSqlite.js';
import { RepositorioCredenciaisSqlite } from '../../infrastructure/persistencia/sqlite/RepositorioCredenciaisSqlite.js';
import { Cofre } from '../../infrastructure/seguranca/cofre.js';
import {
  DataJudAdapter,
  NOME_DATAJUD,
} from '../../infrastructure/adapters/datajud/DataJudAdapter.js';
import {
  DjenAdapter,
  NOME_DJEN,
} from '../../infrastructure/adapters/djen/DjenAdapter.js';
import {
  MockCrawlerAdapter,
  NOME_MOCK_CRAWLER,
} from '../../infrastructure/adapters/crawler/MockCrawlerAdapter.js';
import { CachedProcessoProvider } from '../../infrastructure/cache/CachedProcessoProvider.js';
import { InMemoryCache } from '../../infrastructure/cache/InMemoryCache.js';
import type { Config } from '../../infrastructure/config/env.js';
import { avisosDeRenomeacao } from '../../infrastructure/config/env.js';
import { pareceValorDeExemplo } from '../../infrastructure/config/placeholder.js';
import { ConsoleLogger } from '../../infrastructure/logging/ConsoleLogger.js';
import { gerarBackup } from '../../infrastructure/persistencia/backup.js';
import { ServicoContas } from '../../application/services/ServicoContas.js';
import { ServicoAssinaturas } from '../../application/services/ServicoAssinaturas.js';
import { ServicoChavesApi } from '../../application/services/ServicoChavesApi.js';
import { ServicoPlanos } from '../../application/services/ServicoPlanos.js';
import type { RepositorioUsuarios } from '../../domain/ports/RepositorioUsuarios.js';
import type { RepositorioAssinaturas } from '../../domain/ports/RepositorioAssinaturas.js';
import type { RepositorioChavesApi } from '../../domain/ports/RepositorioChavesApi.js';
import { RepositorioAssinaturasSqlite } from '../../infrastructure/persistencia/sqlite/RepositorioAssinaturasSqlite.js';
import { RepositorioUsuariosSqlite } from '../../infrastructure/persistencia/sqlite/RepositorioUsuariosSqlite.js';
import { RepositorioChavesApiSqlite } from '../../infrastructure/persistencia/sqlite/RepositorioChavesApiSqlite.js';
import {
  RepositorioPlanosSqlite,
  RepositorioRegrasDeAssinaturaSqlite,
} from '../../infrastructure/persistencia/sqlite/RepositorioPlanosSqlite.js';
import { hashScrypt } from '../../infrastructure/seguranca/senha.js';
import { chavesDeApi } from '../../infrastructure/seguranca/chavesDeApi.js';
import {
  DURACAO_SESSAO_MS,
  tokensDeSessao,
} from '../../infrastructure/seguranca/sessao.js';
import { adminHabilitado } from '../http/adminAuth.js';

export interface Aplicacao {
  readonly buscarProcessoPorNumero: BuscarProcessoPorNumero;
  readonly buscarProcessosPorOab: BuscarProcessosPorOab;
  readonly orquestrador: ProcessoSearchService;
  readonly provider: ProcessoProvider;
  readonly acompanhamento: ServicoAcompanhamento;
  readonly vigilancia: ServicoVigilanciaOab | undefined;
  readonly notificacao: ServicoNotificacao;
  /**
   * `undefined` quando não há chave de cofre configurada. As rotas respondem
   * 501 com a instrução, em vez de existirem e falharem na primeira consulta.
   */
  readonly pecas: ServicoPecas | undefined;
  /**
   * Leitor de peças (v0.30.0): PDF combinado com índice. `undefined` sem
   * acesso a peças ou sem o `qpdf` instalado — as rotas respondem 501.
   */
  readonly leitor: ServicoLeitor | undefined;
  /**
   * Pasta digital (v0.33.0): lista de peças, abrir uma por vez, montar a pasta
   * completa. Sobe junto com o leitor (mesmo `qpdf`, mesma guarda em disco).
   */
  readonly pasta: ServicoPasta | undefined;
  /** Executor da fila do leitor (a cada minuto) e limpeza por prazo (a cada hora). */
  readonly agendadorLeitor: Agendador | undefined;
  readonly agendadorLimpezaLeitor: Agendador | undefined;
  /**
   * Calendário (v0.32.0): agenda, detecção nos andamentos e feed ICS. Sempre
   * montado — só depende do banco.
   */
  readonly calendario: ServicoCalendario;
  /** Preenchimento retroativo do calendário (de hora em hora, só banco). */
  readonly agendadorCalendario: Agendador | undefined;
  /** Contas de assinante. Cada uma nasce com o próprio `workspace`. */
  readonly contas: ServicoContas;
  /**
   * Planos e vigência.
   *
   * Sempre montado: mesmo sem nada vendido, é ele que cria o teste da conta
   * nova e responde ao console qual plano está valendo. Workspace sem
   * assinatura — o caso das chaves de API — passa livre por ele.
   */
  readonly assinaturas: ServicoAssinaturas;
  /**
   * Catálogo de planos e regras de teste/carência (v0.28.0). O assinante só
   * LÊ por aqui (a lista de planos à venda); quem escreve é `rotasDeAdmin`.
   */
  readonly planos: ServicoPlanos;
  /**
   * Repositórios crus, para o CLI e para a área administrativa.
   *
   * Expostos porque a liberação manual acontece por e-mail — o operador
   * conhece o e-mail do advogado, não o `workspace` — e porque listar todas as
   * assinaturas é diagnóstico, não caso de uso do produto. **Nenhuma rota do
   * ASSINANTE deve tocar nestes** — o que elas usam é o serviço acima; só o
   * CLI e `rotasDeAdmin` (o próprio operador, atrás de Basic Auth separado)
   * têm razão para ler `porEmail`/`porWorkspace`/`todas` diretamente.
   */
  readonly usuarios: RepositorioUsuarios;
  readonly repositorioAssinaturas: RepositorioAssinaturas;
  /** Chaves de API emitidas pela área administrativa — ver `ServicoChavesApi`. */
  readonly repositorioChavesApi: RepositorioChavesApi;
  /** Emissão/listagem/revogação de chaves, para `rotasDeAdmin`. */
  readonly chavesApi: ServicoChavesApi;
  /**
   * `undefined` quando `PROCESSOVIVO_ADMIN_USUARIO`/`_SENHA` não estão
   * configuradas — a área administrativa existe (as rotas respondem 501 com
   * instrução) mas não abre para ninguém.
   */
  readonly adminCredenciais:
    { readonly usuario: string; readonly senha: string } | undefined;
  readonly preferenciasNotificacao: RepositorioNotificacao;
  /**
   * O canal de saída cru, exposto para DIAGNÓSTICO.
   *
   * O `ServicoNotificacao` acima é o que decide QUANDO avisar; este é por onde
   * a mensagem sai. Quem precisa dele é o comando `email` do CLI, que existe
   * para responder "o SMTP está configurado certo?" sem disparar uma
   * recuperação de senha de verdade — que é a única outra forma de descobrir,
   * e envolve gastar um link e mexer numa conta.
   */
  readonly notificador: Notificador;
  readonly agendador: Agendador;
  readonly agendadorVigilancia: Agendador | undefined;
  /** `undefined` com backup desligado ou banco em memória (testes). */
  readonly agendadorBackup: Agendador | undefined;
  readonly logger: Logger;
  /** Fecha o banco. Chamado no desligamento gracioso. */
  readonly encerrar: () => void;
}

/**
 * COMPOSITION ROOT — o único lugar do sistema que sabe quais implementações
 * concretas existem e as amarra.
 *
 * Todo `new` de infraestrutura acontece aqui. É o que permite ao domínio
 * depender só de interfaces: nenhuma outra camada importa `DataJudAdapter`, e
 * por isso trocar a fonte, reordenar a cadeia ou desligar o cache é editar
 * ESTE arquivo — não caçar dependências espalhadas.
 *
 * A montagem final fica assim:
 *
 *   CasosDeUso → CachedProcessoProvider → ProcessoSearchService → [ adapters ]
 *                └── decorator de cache   └── fallback/estratégia
 *
 * O cache embrulha o orquestrador, não cada adapter: o que interessa guardar é
 * a RESPOSTA ao usuário, venha ela de qual fonte vier — e assim um acerto de
 * cache não gasta nem a cota do DataJud nem uma ida ao tribunal.
 */
export function montarAplicacao(config: Config): Aplicacao {
  const logger = new ConsoleLogger(config.nivelLog);

  // O aviso sai AQUI, e não dentro de `carregarConfig`, porque lá o logger ainda
  // não existe — o nível de log vem justamente da configuração que está sendo
  // lida. `warn` e não `info`: é dívida de migração, e some da tela no dia em
  // que o painel estiver limpo.
  for (const { antigo, atual } of avisosDeRenomeacao()) {
    logger.warn('variável de ambiente com nome antigo', {
      antigo,
      atual,
      acao: `renomeie ${antigo} para ${atual} na configuração do serviço`,
    });
  }

  const providers = construirProviders(config, logger);
  if (providers.length === 0) {
    throw new Error(
      `Nenhum provider utilizável em PROCESSOVIVO_PROVIDER_CHAIN="${config.cadeiaDeProviders.join(',')}". ` +
        `Valores aceitos: ${NOME_MOCK_CRAWLER}, ${NOME_DATAJUD}, ${NOME_DJEN}.`,
    );
  }

  const orquestrador = new ProcessoSearchService({
    providers,
    logger,
    estrategiaOab: 'AGREGAR',
  });

  const provider: ProcessoProvider = config.cache.habilitado
    ? new CachedProcessoProvider({
        provider: orquestrador,
        cache: new InMemoryCache({
          ttlPadraoSegundos: config.cache.ttlSegundos,
          maxEntradas: config.cache.maxEntradas,
        }),
        ttlNumeroSegundos: config.cache.ttlSegundos,
        ttlOabSegundos: Math.min(300, config.cache.ttlSegundos),
      })
    : orquestrador;

  // O banco entra aqui, no único lugar que conhece implementações concretas.
  const db = abrirBanco(config.banco.caminho);
  const repositorioCru = new RepositorioAcompanhamentosSqlite(db);

  // As assinaturas sobem ANTES do acompanhamento porque o calendário precisa
  // delas (o feed confere o plano), e o acompanhamento precisa do calendário
  // (a detecção roda na ingestão). Nenhum dos três depende do provider.
  //
  // O notificador vai para as assinaturas com a MESMA regra da recuperação de
  // senha: só o que entrega de verdade. Aviso de assinatura que só existe no
  // log é exatamente o bloqueio silencioso que a carência foi criada para
  // evitar.
  const notificador = construirNotificador(config, logger);
  const usuarios = new RepositorioUsuariosSqlite(db);
  const repositorioAssinaturas = new RepositorioAssinaturasSqlite(db);
  const repositorioPlanos = new RepositorioPlanosSqlite(db);
  const repositorioRegras = new RepositorioRegrasDeAssinaturaSqlite(db);
  const assinaturas = new ServicoAssinaturas({
    repositorio: repositorioAssinaturas,
    planos: repositorioPlanos,
    regras: repositorioRegras,
    usuarios,
    logger,
    ...(entregaDeVerdade(config) ? { notificador } : {}),
  });

  // O calendário lê o repositório CRU; todo o resto grava pelo decorado, que
  // é o ponto único onde a detecção encontra a ingestão de andamentos.
  const calendario = new ServicoCalendario({
    eventos: new RepositorioDeEventosSqlite(db),
    acompanhamentos: repositorioCru,
    tokens: tokensDeSessao,
    logger,
    assinaturas,
    gerarId: () => randomUUID(),
  });
  // Por fora do calendário: o indicador de destinatário troca as inscrições
  // transitórias do DJEN por `paraOUsuario` ANTES de o retrato descer, e nem o
  // calendário nem o banco chegam a ver inscrição de terceiro (v0.37.6).
  const repositorio = comIndicadorDeDestinatario(
    comDeteccaoDoCalendario(repositorioCru, calendario, logger),
    new OabsDoWorkspaceSqlite(db),
    logger,
  );

  // A sincronização usa o `provider` COM cache: se dois workspaces acompanham
  // o mesmo processo, a segunda consulta da varredura sai da memória em vez de
  // gastar outra ida de 20 segundos ao CNJ.
  const acompanhamento = new ServicoAcompanhamento({
    repositorio,
    provider,
    logger,
    maximoPorVarredura: config.sincronizacao.maximoPorVarredura,
    pausaEntreConsultasMs: config.sincronizacao.pausaMs,
  });

  // Contas. O scrypt e o gerador de token entram como PORTA — é no composition
  // root que a escolha concreta vive, e é o que deixa trocar scrypt por argon2
  // no dia em que a imagem deixar de ser Alpine sem tocar em `application/`.
  // (O notificador, montado lá em cima junto das assinaturas, é UM: serve a
  // vigilância e a recuperação de senha. Duas chamadas a
  // `construirNotificador` abririam dois pools SMTP para o mesmo servidor.)

  // Chaves de API emitidas pela área administrativa. Montado SEMPRE que há
  // banco — não só quando a credencial do operador está configurada: uma
  // chave já emitida continua válida mesmo que o acesso à área administrativa
  // seja desligado depois. É revogação explícita que derruba uma chave, nunca
  // a ausência de PROCESSOVIVO_ADMIN_USUARIO.
  const repositorioChavesApi = new RepositorioChavesApiSqlite(db);
  const chavesApi = new ServicoChavesApi({
    repositorio: repositorioChavesApi,
    chaves: chavesDeApi,
  });
  const adminCredenciais = adminHabilitado(config.admin.usuario, config.admin.senha)
    ? { usuario: config.admin.usuario, senha: config.admin.senha }
    : undefined;

  const contas = new ServicoContas({
    repositorio: usuarios,
    assinaturas: repositorioAssinaturas,
    regras: repositorioRegras,
    senhas: hashScrypt,
    tokens: tokensDeSessao,
    duracaoSessaoMs: DURACAO_SESSAO_MS,
    // A recuperação recebe o notificador SÓ quando ele entrega de verdade.
    //
    // A diferença é sutil e custou um achado de revisão: sem SMTP, a vigilância
    // cai no `LogNotificador`, que se declara `habilitado` de propósito — o
    // caminho inteiro continua sendo exercitado e o resumo aparece no log. Isso
    // é certo para a vigilância e ERRADO para a recuperação: ali o "envio" que
    // vai para o log é um token que ninguém recebe, e a pessoa fica com a tela
    // dizendo "confira seu e-mail", um link gasto e, depois de cinco tentativas,
    // uma hora de espera sem entender por quê.
    //
    // Log não é entrega. Sem SMTP de verdade, a recuperação não existe neste
    // servidor, e a interface não a oferece.
    ...(entregaDeVerdade(config) ? { notificador } : {}),
    urlBase: config.http.urlBase,
  });

  const preferenciasNotificacao = new RepositorioNotificacaoSqlite(db);
  const notificacao = new ServicoNotificacao({
    preferencias: preferenciasNotificacao,
    acompanhamentos: repositorio,
    notificador,
    logger,
    horasAteAlertar: config.notificacao.horasAteAlertar,
    ...(config.notificacao.urlBase ? { urlBase: config.notificacao.urlBase } : {}),
  });

  const agendador = new Agendador({
    intervaloHoras: config.sincronizacao.intervaloHoras,
    logger,
    // Notificar faz parte da varredura, não é um passo à parte: se separasse,
    // um deploy podia deixar a varredura viva e o aviso morto — o pior estado
    // possível, porque o sistema continua "funcionando" e ninguém é avisado.
    tarefa: async () => {
      const r = await acompanhamento.sincronizar();
      await notificacao.marcarVarreduraOk();
      await notificacao.despachar();
      // Faxina das sessões vencidas, de carona na varredura que já roda.
      //
      // Não é segurança — a expiração é conferida no SQL a cada leitura, então
      // sessão vencida nunca vale. É higiene: sem isto a tabela cresce para
      // sempre, e cada backup diário carrega o lixo inteiro junto. O método
      // existia, testado, e ninguém o chamava; um agendador só para isso seria
      // peça a mais para manter.
      const limpas = await contas.limparSessoesExpiradas();
      if (limpas > 0) logger.debug('sessões vencidas removidas', { limpas });

      // Aviso de assinatura na MESMA volta, e pelo mesmo motivo do comentário
      // acima: um agendador separado pode morrer sozinho, e o estado resultante
      // seria o pior de todos — a vigilância parando por assinatura vencida
      // enquanto o aviso de que ela vai parar não sai. O silêncio continuaria
      // parecendo tranquilidade.
      //
      // Falha aqui não derruba a varredura: o aviso é importante, o
      // acompanhamento é o produto.
      try {
        await assinaturas.avisarVencimentos();
      } catch (erro) {
        logger.error('falha ao avisar vencimentos de assinatura', { erro });
      }

      return r;
    },
  });

  // A vigilância só existe se a cadeia tiver uma fonte que busque por OAB com
  // recorte de período — hoje, o DJEN. Sem ela, o serviço não é montado e a
  // rota responde 501, em vez de existir e nunca encontrar nada.
  const fonteOab = providers.find(temBuscaPorPeriodo);
  const vigilancia = fonteOab
    ? new ServicoVigilanciaOab({
        vigilancias: new RepositorioVigilanciasSqlite(db),
        acompanhamentos: repositorio,
        busca: fonteOab,
        logger,
        maximoPorVarredura: config.vigilancia.maximoPorVarredura,
        pausaMs: config.vigilancia.pausaMs,
      })
    : undefined;

  if (!vigilancia) {
    logger.warn(
      'vigilância por OAB indisponível: nenhuma fonte da cadeia busca por OAB com período',
      { acao: 'inclua "djen" em PROCESSOVIVO_PROVIDER_CHAIN' },
    );
  }

  // A busca por número entra no serviço de peças para que a régua temporal
  // tenha as publicações do DJEN que o tribunal não numera. Cai em cache, então
  // não custa consulta nova quando a tela acabou de carregar o processo.
  const buscarProcessoPorNumero = new BuscarProcessoPorNumero(provider);
  const { pecas, leitor, pasta } = montarServicoPecas(
    config,
    db,
    logger,
    buscarProcessoPorNumero,
  );

  // O executor do leitor acorda a cada minuto para retomar job pausado por
  // bloqueio e pegar o que um redeploy interrompeu; o pedido novo não espera
  // por ele (`aoEnfileirar` dispara na hora). A limpeza por prazo é horária:
  // o TTL é de horas, e a precisão de minutos não compraria nada.
  const agendadorLeitor = leitor
    ? new Agendador({
        intervaloHoras: 1 / 60,
        atrasoInicialMs: 15_000,
        logger,
        tarefa: () => leitor.processarFila(),
      })
    : undefined;
  const agendadorLimpezaLeitor = leitor
    ? new Agendador({
        intervaloHoras: 1,
        atrasoInicialMs: 60_000,
        logger,
        tarefa: () => leitor.limparExpirados(),
      })
    : undefined;

  // Retroativo do calendário: relê os andamentos JÁ gravados de quem ainda
  // não passou por ele. Só banco, sem rede — por isso pode rodar de hora em
  // hora sem custo para tribunal nenhum.
  const agendadorCalendario = new Agendador({
    intervaloHoras: 1,
    atrasoInicialMs: 90_000,
    logger,
    tarefa: () => calendario.preencherRetroativo(),
  });

  const agendadorVigilancia =
    vigilancia && config.vigilancia.intervaloHoras > 0
      ? new Agendador({
          intervaloHoras: config.vigilancia.intervaloHoras,
          logger,
          tarefa: async () => {
            const r = await vigilancia.varrer();
            if (r.novidades > 0 || r.processosNovos > 0) await notificacao.despachar();
            return r;
          },
        })
      : undefined;

  /**
   * Backup automático, no agendador que já existe.
   *
   * Sem cron externo e sem serviço novo: o Processo Vivo roda numa instância, e o
   * mesmo mecanismo que varre os processos serve para isto. Uma dependência a
   * menos para configurar no Easypanel — e backup que depende de configuração
   * manual é backup que não existe no dia em que precisa.
   *
   * Falhar aqui NÃO derruba nada: o agendador registra e tenta de novo no
   * próximo ciclo. Mas o log sai como ERRO, porque backup falhando é a única
   * coisa desta lista que só se descobre tarde demais.
   */
  const agendadorBackup =
    config.backup.intervaloHoras > 0 && config.banco.caminho !== ':memory:'
      ? new Agendador({
          intervaloHoras: config.backup.intervaloHoras,
          logger,
          tarefa: async () =>
            gerarBackup({
              caminhoBanco: config.banco.caminho,
              manter: config.backup.manter,
              logger,
            }),
        })
      : undefined;

  return {
    buscarProcessoPorNumero,
    buscarProcessosPorOab: new BuscarProcessosPorOab(provider),
    orquestrador,
    provider,
    acompanhamento,
    vigilancia,
    notificacao,
    pecas,
    leitor,
    pasta,
    agendadorLeitor,
    agendadorLimpezaLeitor,
    calendario,
    agendadorCalendario,
    contas,
    assinaturas,
    usuarios,
    repositorioAssinaturas,
    planos: new ServicoPlanos({
      planos: repositorioPlanos,
      regras: repositorioRegras,
      assinaturas: repositorioAssinaturas,
      logger,
    }),
    repositorioChavesApi,
    chavesApi,
    adminCredenciais,
    preferenciasNotificacao,
    notificador,
    agendador,
    agendadorVigilancia,
    agendadorBackup,
    logger,
    encerrar: () => {
      agendador.parar();
      agendadorVigilancia?.parar();
      agendadorBackup?.parar();
      agendadorLeitor?.parar();
      agendadorLimpezaLeitor?.parar();
      agendadorCalendario.parar();
      db.close();
    },
  };
}

/**
 * Monta o acesso a peças — ou não monta, e diz por quê.
 *
 * A ausência da chave do cofre NÃO derruba o serviço e NÃO cai para guardar
 * senha em claro: monta tudo menos isso. É a mesma escolha feita para o DataJud
 * sem chave, e pela mesma razão — ficar sem uma funcionalidade é melhor do que
 * ficar sem serviço. A diferença é que aqui o custo do atalho seria a senha do
 * advogado no tribunal em texto puro no banco, e esse atalho não existe.
 */
function montarServicoPecas(
  config: Config,
  db: ReturnType<typeof abrirBanco>,
  logger: Logger,
  processos: BuscarProcessoPorNumero,
): {
  pecas: ServicoPecas | undefined;
  leitor: ServicoLeitor | undefined;
  pasta: ServicoPasta | undefined;
} {
  const nada = { pecas: undefined, leitor: undefined, pasta: undefined };
  if (pareceValorDeExemplo(config.mni.chaveDoCofre)) {
    logger.warn(
      'acesso a peças desligado: PROCESSOVIVO_CREDENCIAL_CHAVE ainda contém o texto de exemplo',
      { acao: 'gere uma chave real com `npm run chave -- --cofre`' },
    );
    return nada;
  }
  if (!config.mni.chaveDoCofre) {
    logger.warn('acesso a peças desligado: PROCESSOVIVO_CREDENCIAL_CHAVE não definida', {
      motivo:
        'sem cofre, a senha do advogado no tribunal só poderia ser guardada em claro',
      acao: 'gere uma chave com `npm run chave -- --cofre`',
    });
    return nada;
  }

  let cofre: Cofre;
  try {
    cofre = Cofre.comChaveBase64(config.mni.chaveDoCofre);
  } catch (erro) {
    // Chave presente e inválida é diferente de chave ausente: alguém TENTOU
    // configurar. Derrubar seria defensável, mas o efeito prático é o serviço
    // inteiro fora do ar por causa de um caractere colado errado.
    logger.error('acesso a peças desligado: chave do cofre inválida', {
      motivo: erro instanceof Error ? erro.message : String(erro),
    });
    return nada;
  }

  const credenciais = new RepositorioCredenciaisSqlite(db, cofre, logger);
  // UM adapter, e portanto UM balde e UM disjuntor de 403, para tudo que fala
  // com o MNI: peça avulsa, régua do processo e leitor. Um segundo `new
  // MniAdapter` aqui daria ao leitor um balde próprio — e dois baldes de 30
  // somam acima do teto relatado do tribunal. Há teste que falha se isso
  // acontecer.
  const provedor = new MniAdapter({
    endpoint: config.mni.endpoint,
    tribunais: config.mni.tribunais,
    timeoutMs: config.mni.timeoutMs,
    limitePorMinuto: config.mni.limitePorMinuto,
    pausaApos403Ms: config.mni.pausaApos403Ms,
    logger,
  });

  logger.info('acesso a peças habilitado', {
    endpoint: config.mni.endpoint,
    tribunais: config.mni.tribunais,
  });

  // O serviço de peças avisa a Pasta digital de cada listagem do tribunal: é
  // como a lista de peças dela se forma sem uma segunda consulta.
  const montado = montarLeitor(config, db, logger, processos, provedor, credenciais);
  const pasta = montado?.pasta;
  const pecas = new ServicoPecas({
    listar: new ListarPecasDoProcesso(provedor, credenciais),
    baixar: new BaixarPecaDoProcesso(provedor, credenciais),
    credenciais,
    logger,
    processos,
    baixadas: new RepositorioPecasBaixadasSqlite(db),
    aoListar: async (workspace, numero, atos) => {
      await pasta?.registrarListagem(workspace, numero, atos);
    },
  });

  return { pecas, leitor: montado?.leitor, pasta };
}

/**
 * O leitor de peças, sobre o MESMO adapter das peças.
 *
 * Sem `qpdf` no PATH o leitor não sobe, e diz por quê. Montar e falhar na
 * primeira combinação deixaria o advogado esperar minutos de download para
 * receber um erro no fim.
 */
function montarLeitor(
  config: Config,
  db: ReturnType<typeof abrirBanco>,
  logger: Logger,
  processos: BuscarProcessoPorNumero,
  provedor: MniAdapter,
  credenciais: RepositorioCredenciaisSqlite,
): { leitor: ServicoLeitor; pasta: ServicoPasta } | undefined {
  if (!QpdfMontador.disponivelSync(config.leitor.qpdf)) {
    logger.warn('leitor de peças desligado: qpdf não encontrado', {
      binario: config.leitor.qpdf,
      acao: 'instale o qpdf (Alpine: apk add qpdf) ou ajuste LEITOR_QPDF',
    });
    return undefined;
  }

  // Ao lado do banco, no volume — e fora do backup, que copia o banco e não a
  // pasta. Banco em memória (teste, diagnóstico) usa uma pasta temporária.
  const pasta =
    config.leitor.pasta ||
    (config.banco.caminho === ':memory:'
      ? join(tmpdir(), `processovivo-leitor-${process.pid}`)
      : join(dirname(config.banco.caminho), 'leitor'));

  // A procedência mostra QUAL credencial baixou o arquivo sem mostrar a
  // credencial. HMAC com a chave do cofre, e não hash simples: CPF tem 10^11
  // valores, e oito hex de um SHA-256 puro se revertem por força bruta.
  const chave = Buffer.from(config.mni.chaveDoCofre, 'base64');
  const identificarCredencial = (workspace: string, c: CredencialTribunal): string =>
    createHmac('sha256', chave)
      .update(`leitor\0${workspace}\0${c.tribunal}\0${c.identificacao}`)
      .digest('hex')
      .slice(0, 8);

  logger.info('leitor de peças habilitado', {
    loteInicial: config.leitor.loteInicial,
    loteMaximo: config.leitor.loteMaximo,
    ttlHoras: config.leitor.ttlMs / 3_600_000,
  });

  // UM armazém, UM montador: o PDF combinado e a peça guardada dividem a pasta
  // do workspace e, portanto, a cota. Dois armazéns somariam acima dela.
  const armazem = new ArmazemEmDisco(pasta);
  const montador = new QpdfMontador({ binario: config.leitor.qpdf });
  const fila = new FilaDeJobsSqlite(db);
  const repositorioDaPasta = new RepositorioDaPastaSqlite(db);
  const guarda = new GuardaDePecas({
    repositorio: repositorioDaPasta,
    armazem,
    montador,
    logger,
    ttlMs: config.leitor.ttlMs,
  });

  const leitor: ServicoLeitor = new ServicoLeitor({
    provedor,
    credenciais,
    fila,
    armazem,
    montador,
    guarda,
    logger,
    processos,
    identificarCredencial,
    gerarId: () => randomBytes(16).toString('hex'),
    aoEnfileirar: () => {
      void leitor.processarFila().catch((erro: unknown) => {
        logger.error('executor do leitor falhou', {
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      });
    },
    config: {
      inicial: config.leitor.loteInicial,
      maximo: config.leitor.loteMaximo,
      limiteRespostaBytes: config.leitor.limiteRespostaBytes,
      limiarCrescimentoBytes: config.leitor.limiarCrescimentoBytes,
      pausaEntreChamadasMs: config.leitor.pausaEntreChamadasMs,
      ttlMs: config.leitor.ttlMs,
      cotaPorPdfBytes: config.leitor.cotaPorPdfBytes,
      cotaPorWorkspaceBytes: config.leitor.cotaPorWorkspaceBytes,
      avisoDiscoBytes: config.leitor.avisoDiscoBytes,
      confirmarAcimaDe: config.leitor.confirmarAcimaDe,
      // Pior latência medida na sonda de lote (20 peças, 1,8 s).
      segundosPorChamada: 1.8,
    },
  });
  const servicoPasta = new ServicoPasta({
    leitor,
    guarda,
    repositorio: repositorioDaPasta,
    fila,
    armazem,
    logger,
    debounceMs: config.pasta.debounceMs,
  });
  return { leitor, pasta: servicoPasta };
}

/**
 * Reconhece a fonte que sabe buscar por OAB dentro de um período.
 *
 * Checagem estrutural em vez de `instanceof DjenAdapter` de propósito: o
 * composition root pode conhecer implementações concretas, mas amarrar a
 * vigilância a UMA classe faria o próximo adapter com a mesma capacidade —
 * um agregador pago, por exemplo — exigir edição aqui em vez de só entrar na
 * cadeia.
 */
function temBuscaPorPeriodo(
  provider: ProcessoProvider,
): provider is ProcessoProvider & BuscaPorOabComPeriodo {
  return (
    provider.capacidades.buscarPorOab &&
    typeof (provider as Partial<BuscaPorOabComPeriodo>).buscarPorOabNoPeriodo ===
      'function'
  );
}

/**
 * O notificador ENTREGA, ou só escreve no log?
 *
 * A mesma condição decide as duas coisas, e por isso mora numa função só: com
 * ela falsa, `construirNotificador` devolve o `LogNotificador` e a recuperação
 * de senha não é montada. Duplicar o teste faria os dois divergirem no dia em
 * que um deles ganhasse uma condição nova.
 */
function entregaDeVerdade(config: Config): boolean {
  return Boolean(config.notificacao.smtpHost && config.notificacao.remetente);
}

/**
 * SMTP quando configurado; log quando não.
 *
 * Cair para o log em vez de desligar a notificação é decisão consciente: o
 * caminho inteiro continua sendo exercitado — detecta, agrupa, monta o resumo —
 * e o operador vê no log o que teria saído. Desligar esconderia um defeito no
 * resumo até o dia em que o SMTP fosse ligado, que é o pior dia para descobrir.
 */
function construirNotificador(config: Config, logger: Logger): Notificador {
  if (!entregaDeVerdade(config)) {
    logger.info('notificação por e-mail em modo log', {
      motivo: 'SMTP_HOST ou SMTP_FROM não definidos',
    });
    return new LogNotificador(logger);
  }
  return new EmailSmtpNotificador({
    host: config.notificacao.smtpHost,
    porta: config.notificacao.smtpPorta,
    seguro: config.notificacao.smtpSeguro,
    remetente: config.notificacao.remetente,
    logger,
    ...(config.notificacao.smtpUsuario
      ? { usuario: config.notificacao.smtpUsuario, senha: config.notificacao.smtpSenha }
      : {}),
  });
}

/**
 * A ordem da cadeia é a ordem declarada em `PROCESSOVIVO_PROVIDER_CHAIN` — mudar a
 * fonte primária em produção é mudar uma variável de ambiente, sem redeploy de
 * código.
 *
 * Um provider mal configurado (ex.: DataJud sem chave) é OMITIDO com aviso, em
 * vez de derrubar o processo: perder o fallback é ruim, mas ficar sem serviço
 * porque a fonte secundária não tem credencial é pior.
 */
function construirProviders(config: Config, logger: Logger): ProcessoProvider[] {
  const providers: ProcessoProvider[] = [];

  for (const nome of config.cadeiaDeProviders) {
    switch (nome) {
      case NOME_MOCK_CRAWLER:
        providers.push(
          new MockCrawlerAdapter({
            latenciaMs: config.mockCrawler.latenciaMs,
            taxaDeFalha: config.mockCrawler.taxaDeFalha,
          }),
        );
        break;

      case NOME_DATAJUD:
        // Placeholder é tratado como AUSENTE, não como chave ruim. Do contrário
        // o adapter entra na cadeia com uma credencial de mentira e o problema
        // só aparece como 401 lá na consulta — longe da causa real, que é uma
        // variável nunca preenchida.
        if (pareceValorDeExemplo(config.dataJud.apiKey)) {
          logger.warn(
            'DataJud fora da cadeia: DATAJUD_API_KEY ainda contém o texto de exemplo',
            {
              valor: config.dataJud.apiKey,
              acao: 'Apague o conteúdo da variável, ou cole a chave real.',
              ajuda: 'https://datajud-wiki.cnj.jus.br/api-publica/acesso/',
            },
          );
          break;
        }
        if (!config.dataJud.apiKey) {
          logger.warn('DataJud fora da cadeia: DATAJUD_API_KEY não definida', {
            ajuda: 'https://datajud-wiki.cnj.jus.br/api-publica/acesso/',
          });
          break;
        }
        providers.push(
          new DataJudAdapter({
            apiKey: config.dataJud.apiKey,
            baseUrl: config.dataJud.baseUrl,
            timeoutMs: config.dataJud.timeoutMs,
            timeoutVerificacaoMs: config.dataJud.timeoutVerificacaoMs,
            limitePorMinuto: config.dataJud.limitePorMinuto,
            logger,
          }),
        );
        break;

      case NOME_DJEN:
        // Sem chave, sem configuração obrigatória: é o diário oficial, aberto
        // por desenho. Nunca sai da cadeia por falta de credencial.
        providers.push(
          new DjenAdapter({
            baseUrl: config.djen.baseUrl,
            timeoutMs: config.djen.timeoutMs,
            limitePorMinuto: config.djen.limitePorMinuto,
            maxComunicacoesPorOab: config.djen.maxComunicacoesPorOab,
            logger,
          }),
        );
        break;

      default:
        logger.warn('provider desconhecido ignorado', { nome });
    }
  }

  return providers;
}
