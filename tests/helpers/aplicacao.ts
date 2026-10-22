import { ProcessoSearchService } from '../../src/application/services/ProcessoSearchService.js';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import { ServicoNotificacao } from '../../src/application/services/ServicoNotificacao.js';
import { ServicoPecas } from '../../src/application/services/ServicoPecas.js';
import { GuardaDePecas } from '../../src/application/services/GuardaDePecas.js';
import { ServicoLeitor } from '../../src/application/services/ServicoLeitor.js';
import { ServicoPasta } from '../../src/application/services/ServicoPasta.js';
import { ServicoDrive } from '../../src/application/services/ServicoDrive.js';
import { ServicoPagamentos } from '../../src/application/services/ServicoPagamentos.js';
import { RepositorioPagamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioPagamentosSqlite.js';
import type { GatewayDePagamento } from '../../src/domain/ports/GatewayDePagamento.js';
import { fonteDePecasDaPasta } from '../../src/application/services/fonteDePecasDaPasta.js';
import { EstadosDeConexao } from '../../src/application/politicas/estadosDeConexao.js';
import { RepositorioDoDriveSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDoDriveSqlite.js';
import type { DestinoExternoDePecas } from '../../src/domain/ports/DestinoExternoDePecas.js';
import { RepositorioDaPastaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDaPastaSqlite.js';
import { ServicoCalendario } from '../../src/application/services/ServicoCalendario.js';
import { ServicoResumoDoCalendario } from '../../src/application/services/ServicoResumoDoCalendario.js';
import { RepositorioDoResumoDoCalendarioSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDoResumoDoCalendarioSqlite.js';
import { ServicoCustosPorCliente } from '../../src/application/services/ServicoCustosPorCliente.js';
import { ServicoCustos } from '../../src/application/services/ServicoCustos.js';
import { PrestacaoDeContasPdf } from '../../src/infrastructure/pdf/PrestacaoDeContasPdf.js';
import { RepositorioDeCustosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeCustosSqlite.js';
import { comDeteccaoDoCalendario } from '../../src/application/services/ingestaoDoCalendario.js';
import { RepositorioDeEventosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeEventosSqlite.js';
import type { ConfiguracaoLeitor } from '../../src/application/services/ServicoLeitor.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Clock } from '../../src/domain/ports/Clock.js';
import { ArmazemEmDisco } from '../../src/infrastructure/arquivos/ArmazemEmDisco.js';
import { QpdfMontador } from '../../src/infrastructure/pdf/QpdfMontador.js';
import { FilaDeJobsSqlite } from '../../src/infrastructure/persistencia/sqlite/FilaDeJobsSqlite.js';
import { ServicoVigilanciaOab } from '../../src/application/services/ServicoVigilanciaOab.js';
import type { BuscaPorOabComPeriodo } from '../../src/application/services/ServicoVigilanciaOab.js';
import { BuscarProcessoPorNumero } from '../../src/domain/usecases/BuscarProcessoPorNumero.js';
import { BuscarProcessosPorOab } from '../../src/domain/usecases/BuscarProcessosPorOab.js';
import type { ProcessoProvider } from '../../src/domain/ports/ProcessoProvider.js';
import type { ProvedorDePecas } from '../../src/domain/ports/ProvedorDePecas.js';
import { BaixarPecaDoProcesso } from '../../src/domain/usecases/BaixarPecaDoProcesso.js';
import { ListarPecasDoProcesso } from '../../src/domain/usecases/ListarPecasDoProcesso.js';
import { RepositorioPecasBaixadasSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioPecasBaixadasSqlite.js';
import { RepositorioCredenciaisSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioCredenciaisSqlite.js';
import { Cofre } from '../../src/infrastructure/seguranca/cofre.js';
import type { Notificador } from '../../src/domain/ports/Notificador.js';
import { Agendador } from '../../src/infrastructure/agenda/Agendador.js';
import type { Logger } from '../../src/domain/ports/Logger.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioNotificacaoSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioNotificacaoSqlite.js';
import { RepositorioVigilanciasSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioVigilanciasSqlite.js';
import { ServicoAvisoDoPrazo } from '../../src/application/services/ServicoAvisoDoPrazo.js';
import { ServicoAnaliseDoAto } from '../../src/application/services/ServicoAnaliseDoAto.js';
import { LimiteDeAnalises } from '../../src/application/politicas/limiteDeAnalises.js';
import type { AnalisadorDeAto } from '../../src/domain/ports/AnalisadorDeAto.js';
import { RepositorioAnalisesSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAnalisesSqlite.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { ServicoContas } from '../../src/application/services/ServicoContas.js';
import { ServicoAssinaturas } from '../../src/application/services/ServicoAssinaturas.js';
import { ServicoChavesApi } from '../../src/application/services/ServicoChavesApi.js';
import { ServicoPlanos } from '../../src/application/services/ServicoPlanos.js';
import {
  RepositorioPlanosSqlite,
  RepositorioRegrasDeAssinaturaSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositorioPlanosSqlite.js';
import { RepositorioAssinaturasSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAssinaturasSqlite.js';
import { RepositorioUsuariosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioUsuariosSqlite.js';
import { RepositorioChavesApiSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioChavesApiSqlite.js';
import { tokensDeSessao } from '../../src/infrastructure/seguranca/sessao.js';
import { chavesDeApi } from '../../src/infrastructure/seguranca/chavesDeApi.js';
import type { HashDeSenha } from '../../src/domain/ports/Criptografia.js';
import {
  EntradaNaoAnalisavelError,
  SenhaFracaError,
} from '../../src/domain/errors/index.js';
import { ServicoResumoDoProcesso } from '../../src/application/services/ServicoResumoDoProcesso.js';
import type { ResumidorDeProcesso } from '../../src/domain/ports/ResumidorDeProcesso.js';
import { RepositorioResumosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioResumosSqlite.js';

/**
 * Hash de senha BARATO, só para teste.
 *
 * O scrypt de produção gasta ~100ms por verificação de propósito. Numa suíte
 * que cria dezenas de contas isso vira meio minuto de espera, e teste lento é
 * teste que alguém para de rodar. A porta `HashDeSenha` existe justamente para
 * esta troca — o que se verifica aqui é o COMPORTAMENTO das contas, e o scrypt
 * de verdade tem a suíte dele.
 */
export const hashDeTeste: HashDeSenha = {
  validar: (senha) => {
    if (senha.length < 10) throw new SenhaFracaError(10);
  },
  guardar: (senha) => {
    if (senha.length < 10) throw new SenhaFracaError(10);
    return `teste:${senha}`;
  },
  conferir: (senha, guardada) => guardada === `teste:${senha}`,
  hashDeComparacao: 'teste:__ninguem__',
};

/** Os valores de produção, sem pausa real: o teste injeta `esperar`. */
export const CONFIG_LEITOR_DE_TESTE: ConfiguracaoLeitor = {
  inicial: 5,
  maximo: 20,
  limiteRespostaBytes: 12 * 1_048_576,
  limiarCrescimentoBytes: 3 * 1_048_576,
  pausaEntreChamadasMs: 3000,
  ttlMs: 24 * 3_600_000,
  cotaPorPdfBytes: 300 * 1_048_576,
  cotaPorWorkspaceBytes: 1024 * 1_048_576,
  avisoDiscoBytes: 10 * 1024 * 1_048_576,
  segundosPorChamada: 1.8,
  confirmarAcimaDe: 150,
};

/** Notificador que guarda o que "enviou", para o teste conferir o conteúdo. */
export class NotificadorEspiao implements Notificador {
  readonly nome = 'espiao';
  readonly habilitado = true;
  readonly enviadas: Array<{ para: string; assunto: string; texto: string }> = [];

  async enviar(m: { para: string; assunto: string; texto: string }): Promise<boolean> {
    this.enviadas.push(m);
    return true;
  }
}

export interface OpcoesAplicacaoDeTeste {
  /**
   * Monta o resumo por e-mail dos eventos a confirmar (v0.51.0) com este notificador (em geral um espião).
   * Sem isto, `resumoDoCalendario` fica indefinido, como em produção sem SMTP de verdade.
   */
  readonly resumoDoCalendario?: {
    readonly habilitado: boolean;
    readonly notificador: Notificador;
    readonly urlBase?: string;
  };
  /**
   * Liga a cobrança recorrente (v0.44.0) com o gateway dado (em geral o `GatewayFalso`). Sem isto,
   * `pagamentos` fica indefinido: as rotas de checkout não existem e o webhook responde 404.
   */
  readonly pagamentos?: {
    readonly gateway: GatewayDePagamento;
    readonly urlBase?: string;
    readonly emailDoOperador?: string;
    readonly gerarReferencia?: () => string;
    /** Para o teste ler o que o serviço de pagamento registra no log (v0.49.5). Padrão: silencioso. */
    readonly logger?: Logger;
  };
  /** Fonte da vigilância por OAB. Sem ela, `vigilancia` fica indefinida. */
  readonly buscaOab?: BuscaPorOabComPeriodo;
  readonly notificador?: Notificador;
  readonly agora?: () => Date;
  /** Troca o hash de senha — use para testar o scrypt de verdade. */
  readonly senhas?: HashDeSenha;
  /** Duração da sessão; passe um valor negativo para simular sessão vencida. */
  readonly duracaoSessaoMs?: number;
  /** Fonte de peças. Sem ela, `pecas` fica indefinida e as rotas dão 501. */
  readonly provedorDePecas?: ProvedorDePecas;
  /**
   * Liga a cobrança nos testes.
   *
   * Desligada por padrão de propósito: a esmagadora maioria dos testes
   * verifica comportamento que não tem nada a ver com plano, e ligar cobrança
   * em todos eles faria cada um precisar liberar uma assinatura antes de
   * exercitar o que realmente está sob teste. Sem isto, o workspace não tem
   * assinatura — e workspace sem assinatura passa livre, que é a regra de
   * produção para as chaves de API.
   */
  readonly comAssinaturas?: boolean;
  /**
   * Liga a recuperação de senha.
   *
   * Ausente de propósito por padrão: a instalação sem SMTP é o estado normal,
   * e é ele que os testes de "a recuperação não existe aqui" precisam ver.
   */
  readonly recuperacao?: {
    readonly notificador: Notificador;
    readonly urlBase: string;
    /** Passe um valor negativo para simular link já vencido. */
    readonly duracaoMs?: number;
  };
  /** Liga o leitor de peças (exige `provedorDePecas`). Pasta: use uma temporária. */
  readonly leitor?: {
    readonly pasta: string;
    readonly config?: Partial<ConfiguracaoLeitor>;
    readonly clock?: Clock;
    readonly gerarId?: () => string;
    /** Como no composition root: enfileirar acorda o executor (teste de navegador). */
    readonly executarSozinho?: boolean;
  };
  /**
   * Pasta digital. `debounceMs > 0` usa o relógio de verdade (teste de
   * navegador); o padrão, 0, é instantâneo.
   */
  readonly pasta?: { readonly debounceMs?: number };
  /**
   * Liga a análise por IA com um analisador DUBLÊ (nenhum teste toca a rede). Ausente = IA
   * desligada, o padrão de produção.
   */
  readonly analiseIa?: {
    readonly analisador: AnalisadorDeAto;
    readonly porHora?: number;
    /** Teto técnico do dia (v0.50.0). Ausente = sem teto diário. */
    readonly porDia?: number;
    readonly simultaneasNoTotal?: number;
    readonly clock?: Clock;
  };
  /**
   * Liga o resumo de processo por IA (v0.40.0) com um resumidor DUBLÊ (nenhum teste toca a
   * rede). Ausente = desligado. A regra do plano é a da análise de ato.
   */
  readonly resumoIa?: {
    readonly resumidor: ResumidorDeProcesso;
    readonly porHora?: number;
    readonly clock?: Clock;
  };
  /**
   * Liga o envio ao Google Drive (v0.42.0) com um destino DUBLÊ (nenhum teste toca a rede).
   * Exige `leitor` (a Pasta digital). Ausente = desligado, o padrão de produção. O plano é o
   * de sempre: sem `comAssinaturas`, o workspace não tem assinatura — e o Drive NÃO passa livre
   * sem assinatura (como a análise por IA), então os testes liberam um plano com `salvarNoDrive`.
   */
  readonly drive?: {
    readonly destino: DestinoExternoDePecas;
    readonly uriDeRetorno?: string;
    readonly maxSimultaneos?: number;
    readonly pausaEntrePecasMs?: number;
    readonly clock?: Clock;
    readonly esperar?: (ms: number) => Promise<void>;
    /** Teste de navegador: o envio anda sozinho com espera real curta. */
    readonly gerarId?: () => string;
  };
  /** Liga a área administrativa. Ausente por padrão — mesma regra de `comAssinaturas`. */
  readonly admin?: { readonly usuario: string; readonly senha: string };
}

/**
 * Monta uma `Aplicacao` completa para teste, com banco EM MEMÓRIA.
 *
 * Existe para que adicionar uma dependência nova ao composition root não
 * quebre meia dúzia de arquivos de teste que montavam o objeto na mão — foi
 * exatamente o que aconteceu quando o acompanhamento entrou.
 */
export function aplicacaoDeTeste(
  providers: readonly ProcessoProvider[],
  opcoes: OpcoesAplicacaoDeTeste = {},
): Aplicacao {
  const orquestrador = new ProcessoSearchService({ providers });
  const db = abrirBanco(':memory:');
  const repositorioCru = new RepositorioAcompanhamentosSqlite(db);

  const usuarios = new RepositorioUsuariosSqlite(db);
  const repositorioAssinaturas = new RepositorioAssinaturasSqlite(db);
  const repositorioChavesApi = new RepositorioChavesApiSqlite(db);
  const repositorioPlanos = new RepositorioPlanosSqlite(db);
  const repositorioRegras = new RepositorioRegrasDeAssinaturaSqlite(db);
  const assinaturas = new ServicoAssinaturas({
    repositorio: repositorioAssinaturas,
    planos: repositorioPlanos,
    regras: repositorioRegras,
    usuarios,
    logger: loggerSilencioso,
    ...(opcoes.notificador ? { notificador: opcoes.notificador } : {}),
    ...(opcoes.agora ? { agora: opcoes.agora } : {}),
  });

  // Como no composition root: o calendário lê o repositório cru, e todo o
  // resto grava pelo decorado — o ponto único da detecção.
  const calendario = new ServicoCalendario({
    eventos: new RepositorioDeEventosSqlite(db),
    acompanhamentos: repositorioCru,
    tokens: tokensDeSessao,
    logger: loggerSilencioso,
    assinaturas,
    gerarId: () => randomUUID(),
    ...(opcoes.agora ? { agora: opcoes.agora } : {}),
  });
  const resumoDoCalendario = opcoes.resumoDoCalendario
    ? new ServicoResumoDoCalendario({
        repositorio: new RepositorioDoResumoDoCalendarioSqlite(db),
        usuarios,
        notificador: opcoes.resumoDoCalendario.notificador,
        logger: loggerSilencioso,
        urlBase: opcoes.resumoDoCalendario.urlBase ?? 'https://app.exemplo.test',
        habilitado: opcoes.resumoDoCalendario.habilitado,
        assinaturas,
        ...(opcoes.agora ? { agora: opcoes.agora } : {}),
      })
    : undefined;
  const repositorio = comDeteccaoDoCalendario(
    repositorioCru,
    calendario,
    loggerSilencioso,
  );

  const acompanhamento = new ServicoAcompanhamento({
    repositorio,
    provider: orquestrador,
    logger: loggerSilencioso,
    pausaEntreConsultasMs: 0,
  });

  const preferenciasNotificacao = new RepositorioNotificacaoSqlite(db);
  const notificacao = new ServicoNotificacao({
    preferencias: preferenciasNotificacao,
    acompanhamentos: repositorio,
    notificador: opcoes.notificador ?? new NotificadorEspiao(),
    logger: loggerSilencioso,
    ...(opcoes.agora ? { agora: opcoes.agora } : {}),
  });

  const vigilancia = opcoes.buscaOab
    ? new ServicoVigilanciaOab({
        vigilancias: new RepositorioVigilanciasSqlite(db),
        acompanhamentos: repositorio,
        busca: opcoes.buscaOab,
        logger: loggerSilencioso,
        pausaMs: 0,
        ...(opcoes.agora ? { agora: opcoes.agora } : {}),
      })
    : undefined;

  // Chave de cofre gerada por teste: nenhum segredo fixo entra no repositório,
  // e cada teste tem a sua, o que também prova que o cofre não depende de
  // estado global.
  const credenciais = new RepositorioCredenciaisSqlite(
    db,
    Cofre.comChaveBase64(Cofre.gerarChaveBase64()),
  );
  // A Pasta digital nasce junto do leitor, como no composition root; o serviço
  // de peças a avisa de cada listagem pela referência preenchida mais abaixo.
  let pasta: ServicoPasta | undefined;
  const pecas = opcoes.provedorDePecas
    ? (() => {
        const provedor = opcoes.provedorDePecas as ProvedorDePecas;
        return new ServicoPecas({
          listar: new ListarPecasDoProcesso(provedor, credenciais),
          baixar: new BaixarPecaDoProcesso(provedor, credenciais),
          credenciais,
          logger: loggerSilencioso,
          // A régua temporal precisa das fontes públicas para as publicações
          // que o tribunal não numera.
          processos: new BuscarProcessoPorNumero(orquestrador),
          baixadas: new RepositorioPecasBaixadasSqlite(db),
          aoListar: async (workspace, numero, atos) => {
            await pasta?.registrarListagem(workspace, numero, atos);
          },
        });
      })()
    : undefined;

  // O leitor usa o MESMO provedor e o MESMO repositório de credenciais das
  // peças — como no composition root. Os jobs não andam sozinhos: o teste
  // chama `processarFila()` quando quer, sem timer.
  let leitor: ServicoLeitor | undefined;
  let guardaDoDrive: GuardaDePecas | undefined;
  let armazemDoDrive: ArmazemEmDisco | undefined;
  if (opcoes.provedorDePecas && opcoes.leitor) {
    const armazem = new ArmazemEmDisco(opcoes.leitor.pasta);
    const montador = new QpdfMontador();
    const fila = new FilaDeJobsSqlite(db);
    const repositorioDaPasta = new RepositorioDaPastaSqlite(db);
    const config = { ...CONFIG_LEITOR_DE_TESTE, ...(opcoes.leitor.config ?? {}) };
    const clock = opcoes.leitor.clock;
    const guarda = new GuardaDePecas({
      repositorio: repositorioDaPasta,
      armazem,
      montador,
      logger: loggerSilencioso,
      ttlMs: config.ttlMs,
      ...(clock ? { clock } : {}),
    });
    // O leitor usa o MESMO provedor e o MESMO repositório de credenciais das
    // peças — como no composition root. Os jobs não andam sozinhos: o teste
    // chama `processarFila()` quando quer, sem timer.
    leitor = new ServicoLeitor({
      provedor: opcoes.provedorDePecas,
      credenciais,
      fila,
      armazem,
      montador,
      guarda,
      logger: loggerSilencioso,
      identificarCredencial: (ws, c) => `id-${ws.length}-${c.tribunal}`.slice(0, 16),
      gerarId: opcoes.leitor.gerarId ?? (() => randomBytes(16).toString('hex')),
      esperar: async () => {},
      config,
      ...(clock ? { clock } : {}),
      ...(opcoes.leitor.executarSozinho
        ? {
            aoEnfileirar: () => {
              void leitor?.processarFila();
            },
          }
        : {}),
    });
    guardaDoDrive = guarda;
    armazemDoDrive = armazem;
    pasta = new ServicoPasta({
      leitor,
      guarda,
      repositorio: repositorioDaPasta,
      fila,
      armazem,
      logger: loggerSilencioso,
      debounceMs: opcoes.pasta?.debounceMs ?? 0,
      ...((opcoes.pasta?.debounceMs ?? 0) > 0
        ? {}
        : { esperar: async (): Promise<void> => {} }),
      ...(clock ? { clock } : {}),
    });
  }

  // Intervalo 0: nenhum agendador dispara sozinho durante os testes.
  const parado = (): Agendador =>
    new Agendador({
      intervaloHoras: 0,
      logger: loggerSilencioso,
      tarefa: async () => {},
    });

  const analiseIa = opcoes.analiseIa
    ? new ServicoAnaliseDoAto({
        repositorio: repositorioCru,
        analises: new RepositorioAnalisesSqlite(db),
        assinaturas,
        analisador: opcoes.analiseIa.analisador,
        limite: new LimiteDeAnalises({
          porHora: opcoes.analiseIa.porHora ?? 100,
          simultaneasNoTotal: opcoes.analiseIa.simultaneasNoTotal ?? 10,
          ...(opcoes.analiseIa.porDia !== undefined
            ? { porDia: opcoes.analiseIa.porDia }
            : {}),
          clock: opcoes.analiseIa.clock ?? {
            agora: () => (opcoes.agora ? opcoes.agora() : new Date()),
            monotonico: () => 0,
          },
        }),
        clock: opcoes.analiseIa.clock ?? {
          agora: () => (opcoes.agora ? opcoes.agora() : new Date()),
          monotonico: () => 0,
        },
        logger: loggerSilencioso,
        novoId: () => randomUUID(),
      })
    : undefined;
  const clockDoResumo: Clock = opcoes.resumoIa?.clock ?? {
    agora: () => (opcoes.agora ? opcoes.agora() : new Date()),
    monotonico: () => 0,
  };
  const resumoDoProcesso = opcoes.resumoIa
    ? new ServicoResumoDoProcesso({
        repositorio: repositorioCru,
        resumos: new RepositorioResumosSqlite(db),
        resumidor: opcoes.resumoIa.resumidor,
        exigirPlanoIa: async (ws) => {
          if (!(await assinaturas.temRecursoSemExcecao(ws, 'analiseIa'))) {
            throw new EntradaNaoAnalisavelError(
              'sem_plano',
              'A análise por IA faz parte do plano IA. Faça upgrade do plano para usar.',
            );
          }
        },
        limite: new LimiteDeAnalises({
          porHora: opcoes.resumoIa.porHora ?? 100,
          simultaneasNoTotal: 10,
          clock: clockDoResumo,
        }),
        clock: clockDoResumo,
        logger: loggerSilencioso,
        novoId: () => randomUUID(),
        janelaDePendenciaDias: 10,
      })
    : undefined;
  const analisesRepo = new RepositorioAnalisesSqlite(db);
  const avisoDoPrazo = analiseIa
    ? new ServicoAvisoDoPrazo({
        analises: analisesRepo,
        repositorio: repositorioCru,
        calendario,
        exigirPlanoIa: (ws) => analiseIa.exigirPlano(ws),
        exigirCalendario: (ws) => assinaturas.exigir(ws, 'calendario'),
      })
    : undefined;

  // O Drive usa o MESMO cofre das credenciais (uma chave por teste) e o relógio do teste.
  const clockDoDrive: Clock = opcoes.drive?.clock ?? {
    agora: () => (opcoes.agora ? opcoes.agora() : new Date()),
    monotonico: () => 0,
  };
  const drive =
    opcoes.drive && pasta && guardaDoDrive && armazemDoDrive
      ? new ServicoDrive({
          destino: opcoes.drive.destino,
          repositorio: new RepositorioDoDriveSqlite(
            db,
            Cofre.comChaveBase64(Cofre.gerarChaveBase64()),
          ),
          fonte: fonteDePecasDaPasta({
            pasta,
            guarda: guardaDoDrive,
            armazem: armazemDoDrive,
          }),
          estados: new EstadosDeConexao({
            segredo: randomBytes(32),
            clock: clockDoDrive,
          }),
          conferirPlano: async (ws) =>
            (await assinaturas.temRecursoSemExcecao(ws, 'salvarNoDrive')) &&
            (await assinaturas.temRecursoSemExcecao(ws, 'pecas')),
          logger: loggerSilencioso,
          uriDeRetorno:
            opcoes.drive.uriDeRetorno ?? 'https://app.exemplo.test/v1/drive/retorno',
          maxSimultaneos: opcoes.drive.maxSimultaneos ?? 2,
          pausaEntrePecasMs: opcoes.drive.pausaEntrePecasMs ?? 0,
          clock: clockDoDrive,
          esperar: opcoes.drive.esperar ?? (async (): Promise<void> => {}),
          gerarId: opcoes.drive.gerarId ?? (() => randomBytes(8).toString('hex')),
        })
      : undefined;

  const pagamentos = opcoes.pagamentos
    ? new ServicoPagamentos({
        gateway: opcoes.pagamentos.gateway,
        repositorio: new RepositorioPagamentosSqlite(db),
        planos: repositorioPlanos,
        assinaturas,
        usuarios,
        logger: opcoes.pagamentos.logger ?? loggerSilencioso,
        notificador: opcoes.notificador ?? new NotificadorEspiao(),
        urlBase: opcoes.pagamentos.urlBase ?? 'https://app.exemplo.test',
        versaoDosTermos: '1.1',
        ...(opcoes.pagamentos.emailDoOperador
          ? { emailDoOperador: opcoes.pagamentos.emailDoOperador }
          : {}),
        ...(opcoes.agora ? { agora: opcoes.agora } : {}),
        ...(opcoes.pagamentos.gerarReferencia
          ? { gerarReferencia: opcoes.pagamentos.gerarReferencia }
          : {}),
      })
    : undefined;

  const repositorioDeCustos = new RepositorioDeCustosSqlite(db);
  const custos = new ServicoCustos({
    repositorio: repositorioDeCustos,
    acompanhamentos: repositorioCru,
    gerador: new PrestacaoDeContasPdf(),
    logger: loggerSilencioso,
    gerarId: () => randomUUID(),
    comprovantes: drive,
    versao: '9.9.9-teste',
    ...(opcoes.agora ? { agora: opcoes.agora } : {}),
  });
  const custosPorCliente = new ServicoCustosPorCliente({
    repositorio: repositorioDeCustos,
    acompanhamentos: repositorioCru,
    custos,
    gerador: new PrestacaoDeContasPdf(),
    logger: loggerSilencioso,
    versao: '9.9.9-teste',
    ...(opcoes.agora ? { agora: opcoes.agora } : {}),
  });

  return {
    buscarProcessoPorNumero: new BuscarProcessoPorNumero(orquestrador),
    buscarProcessosPorOab: new BuscarProcessosPorOab(orquestrador),
    orquestrador,
    provider: orquestrador,
    acompanhamento,
    vigilancia,
    notificacao,
    pecas,
    analiseIa,
    resumoDoProcesso,
    avisoDoPrazo,
    leitor,
    pasta,
    drive,
    pagamentos,
    agendadorLeitor: undefined,
    agendadorLimpezaLeitor: undefined,
    assinaturas,
    calendario,
    agendadorCalendario: undefined,
    resumoDoCalendario,
    agendadorResumoDoCalendario: undefined,
    custos,
    custosPorCliente,
    usuarios,
    repositorioAssinaturas,
    planos: new ServicoPlanos({
      planos: repositorioPlanos,
      regras: repositorioRegras,
      assinaturas: repositorioAssinaturas,
      logger: loggerSilencioso,
      ...(opcoes.agora ? { agora: opcoes.agora } : {}),
    }),
    repositorioChavesApi,
    chavesApi: new ServicoChavesApi({
      repositorio: repositorioChavesApi,
      chaves: chavesDeApi,
      ...(opcoes.agora ? { agora: opcoes.agora } : {}),
    }),
    adminCredenciais: opcoes.admin,
    contas: new ServicoContas({
      repositorio: usuarios,
      ...(opcoes.comAssinaturas
        ? { assinaturas: repositorioAssinaturas, regras: repositorioRegras }
        : {}),
      senhas: opcoes.senhas ?? hashDeTeste,
      tokens: tokensDeSessao,
      duracaoSessaoMs: opcoes.duracaoSessaoMs ?? 60 * 60 * 1000,
      ...(opcoes.recuperacao
        ? {
            notificador: opcoes.recuperacao.notificador,
            urlBase: opcoes.recuperacao.urlBase,
            ...(opcoes.recuperacao.duracaoMs !== undefined
              ? { duracaoRecuperacaoMs: opcoes.recuperacao.duracaoMs }
              : {}),
          }
        : {}),
    }),
    preferenciasNotificacao,
    notificador: opcoes.notificador ?? new NotificadorEspiao(),
    agendador: parado(),
    agendadorVigilancia: undefined,
    agendadorBackup: undefined,
    logger: loggerSilencioso,
    encerrar: () => db.close(),
  };
}
