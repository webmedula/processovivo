import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import type { Peca } from '../../domain/entities/Peca.js';
import { numeroDoMovimento } from '../../domain/entities/linhaDoTempo.js';
import {
  motivoDeRecusaDaAncora,
  numeroDoProjudi,
  resumirNumeracao,
} from '../../domain/entities/numeracaoDoProjudi.js';
import type {
  NumeroDoProjudi,
  ResumoDaNumeracao,
} from '../../domain/entities/numeracaoDoProjudi.js';
import { calcularPosicoesDosAtos } from '../../domain/entities/posicaoDoAto.js';
import {
  DESCRICAO_DO_MOTIVO,
  ESTADOS_ATIVOS,
  ESTADOS_COM_ARQUIVO,
} from '../../domain/entities/JobLeitor.js';
import type { JobLeitor, MotivoNaoObtida } from '../../domain/entities/JobLeitor.js';
import type {
  AncoraGuardada,
  EstadoDaPecaNaPasta,
  ListagemDaPasta,
  MovimentacaoDaPeca,
  PecaEmCache,
  PecaListada,
} from '../../domain/entities/PastaDigital.js';
import {
  CredencialTribunalInvalidaError,
  DomainError,
  CalibracaoDeNumeracaoInvalidaError,
  ListagemDaPastaAusenteError,
  MniBloqueadoError,
  PastaSemPecasParaJuntarError,
  PecaDaPastaNaoEncontradaError,
  PecaSigilosaNaoGuardadaError,
  SegredoDeJusticaNaoGuardadoError,
  SemHabilitacaoNosAutosError,
} from '../../domain/errors/index.js';
import type { ArmazemDoLeitor } from '../../domain/ports/ArmazemDoLeitor.js';
import type { Clock } from '../../domain/ports/Clock.js';
import { clockDoSistema } from '../../domain/ports/Clock.js';
import type { FilaDeJobs } from '../../domain/ports/FilaDeJobs.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioDaPasta } from '../../domain/ports/RepositorioDaPasta.js';
import type { GuardaDePecas } from './GuardaDePecas.js';
import { achatarPecas } from './ServicoLeitor.js';
import type { ServicoLeitor } from './ServicoLeitor.js';

export interface OpcoesServicoPasta {
  readonly leitor: ServicoLeitor;
  readonly guarda: GuardaDePecas;
  readonly repositorio: RepositorioDaPasta;
  /** Só leitura: os jobs de montagem moram na fila do leitor. */
  readonly fila: FilaDeJobs;
  readonly armazem: ArmazemDoLeitor;
  readonly logger: Logger;
  /**
   * Janela de debounce do clique. Cliques dentro dela se fundem: só o último
   * pedido pendente segue para o tribunal (especificação, seção 7).
   */
  readonly debounceMs: number;
  readonly clock?: Clock;
  readonly esperar?: (ms: number) => Promise<void>;
}

/** O que a lista mostra de UMA peça. Sem localizador, sem caminho, sem bytes de peça. */
export interface VisaoDaPeca {
  readonly pecaId: string;
  readonly ordem: number;
  readonly rotulo: string;
  readonly data: Date | undefined;
  readonly movimento: number | undefined;
  /** O ato que juntou a peça, quando o vínculo foi confirmado nos dois lados. */
  readonly movimentacao: MovimentacaoDaPeca | undefined;
  /**
   * O número do ato como o Projudi o mostraria, com o grau de certeza (v0.35.0):
   * `exato` só quando provado pelas âncoras do advogado. Ausente sem posição.
   */
  readonly numeroNoProjudi: NumeroDoProjudi | undefined;
  readonly mimetype: string | undefined;
  readonly estado: EstadoDaPecaNaPasta;
  readonly motivo: MotivoNaoObtida | undefined;
  readonly descricaoDoMotivo: string | undefined;
  /** `nao_obtida` por bloqueio: quando o tribunal volta a atender. */
  readonly retomarEm: Date | undefined;
  /** Desde quando está `na_fila`/`baixando`. */
  readonly desde: Date | undefined;
  /** O pedido foi trocado por outro mais novo antes de ir ao tribunal. */
  readonly substituida: boolean;
  readonly obtidaEm: Date | undefined;
  readonly expiraEm: Date | undefined;
  readonly bytes: number | undefined;
  readonly paginasDaPeca: number | undefined;
  /** `html`/`imagem`: a peça que se lê é conversão do que o tribunal entregou. */
  readonly conversao: PecaEmCache['conversao'] | undefined;
  readonly observacao: string | undefined;
  /** No PDF "pasta completa" pronto: onde a peça está, contado do arquivo. */
  readonly intervalo: { readonly inicial: number; readonly final: number } | undefined;
}

/** A calibração do processo: o que o advogado informou e o que isso resolveu. */
export interface VisaoDaCalibracao {
  readonly ancoras: readonly AncoraGuardada[];
  readonly atos: ResumoDaNumeracao;
  /** Âncoras que a última listagem invalidou (o ato mudou de data). */
  readonly invalidadas: number;
}

export interface VisaoDaPasta {
  /** `undefined` sem listagem ou sem atos recebidos. */
  readonly calibracao: VisaoDaCalibracao | undefined;
  /** Atos que o MNI entregou na listagem gravada; base do aviso de numeração. */
  readonly totalAtosRecebidos: number | undefined;
  /** `undefined`: a tela ainda não carregou as peças do processo. */
  readonly listagem:
    | {
        readonly tribunal: string;
        readonly listadaEm: Date;
        readonly processoSigiloso: boolean;
      }
    | undefined;
  readonly pecas: readonly VisaoDaPeca[];
  /** Pausa do tribunal (disjuntor de 403), quando há. */
  readonly pausadoAte: Date | undefined;
  /** O PDF "pasta completa" mais recente, em qualquer estado. */
  readonly montagem: JobLeitor | undefined;
  /** O "Baixar PDF" mais recente (em andamento ou pronto). */
  readonly selecionadas: JobLeitor | undefined;
  /** O que "Montar pasta completa" buscaria agora — a tela mostra antes do clique. */
  readonly estimativaDaMontagem: EstimativaDeBusca | undefined;
}

export interface ArquivoDaPasta {
  readonly tamanho: number;
  readonly nomeArquivo: string;
  readonly baixadoEm: Date;
  readonly expiraEm: Date;
  ler(inicio: number, fim: number): AsyncIterable<Uint8Array>;
}

export interface EstimativaDeBusca {
  /** Quantas peças serão buscadas no tribunal. */
  readonly abuscar: number;
  readonly emGuarda: number;
  readonly sigilosas: number;
  readonly total: number;
  readonly minimoSegundos: number;
  readonly maximoSegundos: number;
  readonly confirmarAcimaDe: number;
  readonly exigeConfirmacao: boolean;
}

export type EstadoDoPedido = 'disponivel' | 'na_fila';

type Falha = {
  readonly motivo: MotivoNaoObtida;
  readonly mensagem: string;
  readonly retomarEm?: Date;
  readonly em: Date;
};

interface Pendencia {
  readonly pecaId: string;
  readonly desde: Date;
  /** Sobe a cada pedido de peça DIFERENTE; é o que reinicia o debounce. */
  readonly versao: number;
}

const chave = (workspace: string, numero: string): string => `${workspace}\0${numero}`;

/**
 * A Pasta digital (v0.33.0): a lista de todas as peças do processo, e cada uma
 * abrindo ao clique.
 *
 * **Um único limitador.** Este serviço NÃO conhece o provedor de peças, nem
 * balde, nem disjuntor: toda ida ao tribunal passa por `ServicoLeitor.consultarLote`
 * — a fila de chamadas com a pausa de 3 s, sobre o MESMO adapter do MNI da peça
 * avulsa, da régua e dos jobs. Há teste que falha se este arquivo importar o
 * adapter ou um rate limiter.
 *
 * **O clique não é uma chamada.** Cada processo (por workspace) tem UM lugar de
 * pedido pendente. Um clique novo numa peça diferente TROCA o pendente — o
 * intermediário morre antes de sair do servidor — e o despacho só acontece
 * depois de uma janela de debounce sem pedido novo. Quem já está no ar não é
 * cancelado (a resposta do tribunal já foi paga); o resultado entra na guarda
 * e vale para o próximo clique.
 *
 * **Sem pré-busca.** Nada é buscado sem o advogado ter pedido aquela peça, ou a
 * pasta completa, ou o "Baixar PDF".
 *
 * **Sem retry.** Falha vira o estado da peça, com o motivo; quem decide tentar
 * de novo é a pessoa, com outro clique. Bloqueio do tribunal (403) não é
 * insistido: o motivo carrega a hora em que ele volta.
 */
export class ServicoPasta {
  private readonly leitor: ServicoLeitor;
  private readonly guarda: GuardaDePecas;
  private readonly repositorio: RepositorioDaPasta;
  private readonly fila: FilaDeJobs;
  private readonly armazem: ArmazemDoLeitor;
  private readonly logger: Logger;
  private readonly debounceMs: number;
  private readonly clock: Clock;
  private readonly esperar: (ms: number) => Promise<void>;

  /** O pedido que espera a janela do debounce, por (workspace, processo). */
  private readonly pendentes = new Map<string, Pendencia>();
  /** O pedido que está no ar agora. */
  private readonly emVoo = new Map<
    string,
    { pecaId: string; desde: Date; fase: 'fila' | 'tribunal' }
  >();
  /** Último desfecho ruim por peça. Em memória: evapora no redeploy, e tudo bem. */
  private readonly falhas = new Map<string, Map<string, Falha>>();
  private readonly substituidas = new Map<string, Set<string>>();
  private readonly operarios = new Map<string, Promise<void>>();
  private versao = 0;

  constructor(opcoes: OpcoesServicoPasta) {
    this.leitor = opcoes.leitor;
    this.guarda = opcoes.guarda;
    this.repositorio = opcoes.repositorio;
    this.fila = opcoes.fila;
    this.armazem = opcoes.armazem;
    this.logger = opcoes.logger.child({ servico: 'pasta' });
    this.debounceMs = opcoes.debounceMs;
    this.clock = opcoes.clock ?? clockDoSistema;
    this.esperar =
      opcoes.esperar ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // ---------------------------------------------------------------------------
  // A listagem

  /**
   * Grava o retrato da listagem do tribunal. Chamado por quem acabou de listar
   * as peças (a tela do processo) — a Pasta lê DAQUI e não consulta o tribunal
   * de novo. NUNCA lança: um defeito aqui não pode derrubar a tela do processo.
   */
  async registrarListagem(
    workspace: string,
    numeroProcesso: string,
    atos: {
      readonly pecas: readonly Peca[];
      readonly movimentos?: readonly Movimentacao[];
      readonly nivelSigiloDoProcesso?: number;
    },
  ): Promise<void> {
    try {
      const cnj = NumeroCNJ.criar(numeroProcesso);
      const posicoes = calcularPosicoesDosAtos(atos.movimentos ?? []);
      const atosPorNumero = indexarAtos(atos.movimentos ?? [], posicoes.porIdentificador);
      const pecas: PecaListada[] = achatarPecas(atos.pecas).map((p, ordem) => ({
        pecaId: p.id,
        ordem,
        rotulo: p.rotulo,
        // Sigilo da PEÇA decide por `nivelSigilo`, como no leitor.
        sigilosa: (p.nivelSigilo ?? 0) > 0,
        ...(p.dataHora !== undefined ? { data: p.dataHora } : {}),
        ...(p.movimento !== undefined ? { movimento: p.movimento } : {}),
        ...(p.movimento !== undefined && atosPorNumero.get(p.movimento)
          ? { movimentacao: atosPorNumero.get(p.movimento) as MovimentacaoDaPeca }
          : {}),
        ...(p.mimetype !== undefined ? { mimetype: p.mimetype } : {}),
      }));
      const invalidadas = await this.invalidarAncorasQueMudaram(
        workspace,
        cnj.digitos,
        posicoes.datas,
      );
      await this.repositorio.guardarListagem(workspace, {
        numeroProcesso: cnj.digitos,
        tribunal: cnj.siglaTribunal ?? '',
        listadaEm: this.clock.agora(),
        processoSigiloso: (atos.nivelSigiloDoProcesso ?? 0) > 0,
        pecas,
        // Sem movimentos na resposta não há "N" a afirmar: ausente, não zero.
        ...(posicoes.total > 0
          ? { totalAtosRecebidos: posicoes.total, datasDosAtos: posicoes.datas }
          : {}),
        ...(invalidadas > 0 ? { ancorasInvalidadas: invalidadas } : {}),
      });
    } catch (erro) {
      this.logger.warn('pasta: não foi possível gravar a listagem', {
        erro: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  /**
   * Descarta as âncoras cujo ato, na listagem nova, tem outra `dataHora` (ou
   * deixou de existir): a posição passou a apontar para outro ato, e número
   * calculado sobre âncora errada seria pior que não calibrar. Devolve quantas
   * a tela deve avisar — as de agora somadas às que a pessoa ainda não viu.
   */
  private async invalidarAncorasQueMudaram(
    workspace: string,
    numero: string,
    datas: readonly Date[],
  ): Promise<number> {
    const ancoras = await this.repositorio.ancorasDoProcesso(workspace, numero);
    let agoraInvalidadas = 0;
    for (const a of ancoras) {
      const atual = datas[a.posicao - 1];
      if (atual && atual.getTime() === a.dataHoraDoAto.getTime()) continue;
      await this.repositorio.removerAncora(workspace, numero, a.posicao);
      agoraInvalidadas++;
    }
    if (agoraInvalidadas > 0) {
      this.logger.info('pasta: calibração invalidada por listagem nova', {
        invalidadas: agoraInvalidadas,
      });
    }
    const anterior = await this.repositorio.obterListagem(workspace, numero);
    return agoraInvalidadas + (anterior?.ancorasInvalidadas ?? 0);
  }

  // ---------------------------------------------------------------------------
  // Calibração do número com o Projudi (v0.35.0). Nada aqui toca o tribunal.

  /**
   * Informa o número que o Projudi mostra para o ato na `posicao`. Substitui a
   * âncora daquela posição. Recusa o que contradiz as outras já informadas.
   *
   * @throws {ListagemDaPastaAusenteError | CalibracaoDeNumeracaoInvalidaError}
   */
  async calibrar(
    workspace: string,
    numeroProcesso: string,
    posicao: number,
    numeroProjudi: number,
  ): Promise<VisaoDaCalibracao> {
    const numero = NumeroCNJ.criar(numeroProcesso).digitos;
    const listagem = await this.repositorio.obterListagem(workspace, numero);
    const total = listagem?.totalAtosRecebidos;
    // Sem as datas não há como provar depois que a âncora ainda vale: recarregar
    // as peças do processo as grava (listagem anterior à 0.35.0).
    if (!listagem || total === undefined || !listagem.datasDosAtos) {
      throw new ListagemDaPastaAusenteError(numero);
    }
    const existentes = await this.repositorio.ancorasDoProcesso(workspace, numero);
    const motivo = motivoDeRecusaDaAncora({ posicao, numeroProjudi }, existentes, total);
    if (motivo) throw new CalibracaoDeNumeracaoInvalidaError(motivo);
    const dataHoraDoAto = listagem.datasDosAtos[posicao - 1];
    if (!dataHoraDoAto) throw new ListagemDaPastaAusenteError(numero);
    await this.repositorio.guardarAncora(workspace, numero, {
      posicao,
      numeroProjudi,
      dataHoraDoAto,
      criadaEm: this.clock.agora(),
    });
    await this.repositorio.zerarAncorasInvalidadas(workspace, numero);
    return this.calibracao(workspace, numero);
  }

  /** Atalho: o último número que a pessoa vê no Projudi vale para o último ato recebido. */
  async calibrarPeloUltimoNumero(
    workspace: string,
    numeroProcesso: string,
    numeroProjudi: number,
  ): Promise<VisaoDaCalibracao> {
    const numero = NumeroCNJ.criar(numeroProcesso).digitos;
    const listagem = await this.repositorio.obterListagem(workspace, numero);
    if (!listagem || listagem.totalAtosRecebidos === undefined) {
      throw new ListagemDaPastaAusenteError(numero);
    }
    return this.calibrar(workspace, numero, listagem.totalAtosRecebidos, numeroProjudi);
  }

  async removerAncora(
    workspace: string,
    numeroProcesso: string,
    posicao: number,
  ): Promise<VisaoDaCalibracao> {
    const numero = NumeroCNJ.criar(numeroProcesso).digitos;
    await this.repositorio.removerAncora(workspace, numero, posicao);
    await this.repositorio.zerarAncorasInvalidadas(workspace, numero);
    return this.calibracao(workspace, numero);
  }

  async limparCalibracao(
    workspace: string,
    numeroProcesso: string,
  ): Promise<VisaoDaCalibracao> {
    const numero = NumeroCNJ.criar(numeroProcesso).digitos;
    await this.repositorio.limparAncoras(workspace, numero);
    await this.repositorio.zerarAncorasInvalidadas(workspace, numero);
    return this.calibracao(workspace, numero);
  }

  async calibracao(
    workspace: string,
    numeroProcesso: string,
  ): Promise<VisaoDaCalibracao> {
    const numero = NumeroCNJ.criar(numeroProcesso).digitos;
    const listagem = await this.repositorio.obterListagem(workspace, numero);
    const ancoras = await this.repositorio.ancorasDoProcesso(workspace, numero);
    return montarCalibracao(ancoras, listagem?.totalAtosRecebidos ?? 0, listagem);
  }

  /**
   * A lista com o estado de cada peça. NÃO consulta o tribunal: junta a
   * listagem gravada, a guarda por peça, o que está na fila/no ar e os jobs.
   */
  async visao(workspace: string, numeroProcesso: string): Promise<VisaoDaPasta> {
    const numero = NumeroCNJ.criar(numeroProcesso).digitos;
    const listagem = await this.repositorio.obterListagem(workspace, numero);
    const pausadoAte = this.leitor.pausadoAte();
    const jobs = await this.fila.doProcesso(workspace, numero);
    const montagem = jobs.find((j) => j.finalidade === 'pasta_completa');
    const selecionadas = jobs.find((j) => j.finalidade === 'selecionadas');
    if (!listagem) {
      return {
        calibracao: undefined,
        totalAtosRecebidos: undefined,
        listagem: undefined,
        pecas: [],
        pausadoAte,
        montagem,
        selecionadas,
        estimativaDaMontagem: undefined,
      };
    }

    const agora = this.clock.agora();
    const ancoras = await this.repositorio.ancorasDoProcesso(workspace, numero);
    const totalAtos = listagem.totalAtosRecebidos ?? 0;
    const guardadas = await this.guarda.doProcesso(workspace, numero);
    const k = chave(workspace, numero);
    const noAr = this.emVoo.get(k);
    const pendente = this.pendentes.get(k);
    const falhas = this.falhas.get(k);
    const substituidas = this.substituidas.get(k);
    const doJob = estadosDosJobs(jobs, (j) => this.jobVigente(j, agora));
    const intervalos = await this.intervalosDaMontagem(workspace, montagem, agora);

    const pecas = [...listagem.pecas]
      .sort((a, b) => a.ordem - b.ordem)
      .map((p): VisaoDaPeca => {
        const e = guardadas.get(p.pecaId);
        const base: Omit<VisaoDaPeca, 'estado'> = {
          pecaId: p.pecaId,
          ordem: p.ordem,
          rotulo: p.rotulo,
          data: p.data,
          movimento: p.movimento,
          movimentacao: p.movimentacao,
          numeroNoProjudi:
            p.movimentacao?.posicao !== undefined && totalAtos > 0
              ? numeroDoProjudi(p.movimentacao.posicao, ancoras, totalAtos)
              : undefined,
          mimetype: p.mimetype,
          motivo: undefined,
          descricaoDoMotivo: undefined,
          retomarEm: undefined,
          desde: undefined,
          substituida: false,
          obtidaEm: undefined,
          expiraEm: undefined,
          bytes: undefined,
          paginasDaPeca: undefined,
          conversao: undefined,
          observacao: undefined,
          intervalo: intervalos.get(p.pecaId),
        };

        if (p.sigilosa || listagem.processoSigiloso) {
          return {
            ...base,
            estado: 'sigilo',
            motivo: 'sigilosa',
            descricaoDoMotivo: DESCRICAO_DO_MOTIVO.sigilosa,
          };
        }
        if (e) {
          return {
            ...base,
            estado: 'disponivel',
            obtidaEm: e.obtidaEm,
            expiraEm: e.expiraEm,
            bytes: e.bytes,
            paginasDaPeca: e.paginas,
            conversao: e.conversao,
            observacao: e.observacao,
          };
        }
        if (noAr?.pecaId === p.pecaId) {
          // "Baixando" só quando a consulta já saiu: antes disso o pedido espera
          // a vez na fila do tribunal (um job em andamento, a pausa de 3 s).
          return {
            ...base,
            estado: noAr.fase === 'tribunal' ? 'baixando' : 'na_fila',
            desde: noAr.desde,
          };
        }
        const job = doJob.ativas.get(p.pecaId);
        if (job) return { ...base, estado: job.estado, desde: job.desde };
        if (pendente?.pecaId === p.pecaId) {
          return { ...base, estado: 'na_fila', desde: pendente.desde };
        }
        const falha = falhas?.get(p.pecaId) ?? doJob.falhas.get(p.pecaId);
        if (falha) {
          return {
            ...base,
            estado: 'nao_obtida',
            motivo: falha.motivo,
            descricaoDoMotivo: DESCRICAO_DO_MOTIVO[falha.motivo],
            retomarEm: falha.retomarEm,
          };
        }
        return {
          ...base,
          estado: 'nao_baixada',
          substituida: substituidas?.has(p.pecaId) === true,
        };
      });

    return {
      calibracao:
        totalAtos > 0 ? montarCalibracao(ancoras, totalAtos, listagem) : undefined,
      totalAtosRecebidos: listagem.totalAtosRecebidos,
      listagem: {
        tribunal: listagem.tribunal,
        listadaEm: listagem.listadaEm,
        processoSigiloso: listagem.processoSigiloso,
      },
      pecas,
      pausadoAte,
      montagem,
      selecionadas,
      estimativaDaMontagem: await this.estimar(
        workspace,
        listagem,
        listagem.pecas.map((p) => p.pecaId),
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // Abrir UMA peça

  /**
   * Pede uma peça. Idempotente: a peça em guarda responde `disponivel` sem
   * chamar o tribunal; a que já está na fila ou no ar continua onde está.
   *
   * @throws {ListagemDaPastaAusenteError | PecaDaPastaNaoEncontradaError}
   * @throws {PecaSigilosaNaoGuardadaError | SegredoDeJusticaNaoGuardadoError}
   * @throws {CredencialTribunalAusenteError | CredencialTribunalInvalidaError}
   */
  async solicitar(
    workspace: string,
    numeroProcesso: string,
    pecaId: string,
  ): Promise<{ readonly estado: EstadoDoPedido; readonly entrada?: PecaEmCache }> {
    const numero = NumeroCNJ.criar(numeroProcesso).digitos;
    const listagem = await this.exigirListagem(workspace, numero);
    if (listagem.processoSigiloso) throw new SegredoDeJusticaNaoGuardadoError(numero);
    const peca = listagem.pecas.find((p) => p.pecaId === pecaId);
    if (!peca) throw new PecaDaPastaNaoEncontradaError(pecaId);
    if (peca.sigilosa) throw new PecaSigilosaNaoGuardadaError(pecaId);

    const guardada = await this.guarda.obter(workspace, numero, pecaId);
    if (guardada) {
      this.esquecerFalha(workspace, numero, pecaId);
      return { estado: 'disponivel', entrada: guardada };
    }

    // Credencial ausente ou já recusada é resposta imediata: não há o que
    // enfileirar, e a tela precisa dizer isso ao clique, não depois.
    await this.leitor.prepararConsulta(workspace, numero);

    const k = chave(workspace, numero);
    if (this.emVoo.get(k)?.pecaId === pecaId) return { estado: 'na_fila' };
    const atual = this.pendentes.get(k);
    if (atual?.pecaId !== pecaId) {
      if (atual) this.marcarSubstituida(k, atual.pecaId);
      this.desmarcarSubstituida(k, pecaId);
      this.falhas.get(k)?.delete(pecaId);
      this.versao += 1;
      this.pendentes.set(k, {
        pecaId,
        desde: this.clock.agora(),
        versao: this.versao,
      });
    }
    this.iniciarOperario(workspace, numero);
    return { estado: 'na_fila' };
  }

  /** Espera os despachos em andamento terminarem. Para teste e para o desligamento. */
  async aguardarOciosa(): Promise<void> {
    while (this.operarios.size > 0) {
      await Promise.all([...this.operarios.values()]);
    }
  }

  /**
   * O PDF de UMA peça guardada, para o PDF.js.
   *
   * @throws {PecaDaPastaNaoEncontradaError} não há — ou é de outro workspace.
   * A resposta é a MESMA nos dois casos.
   */
  async abrirPeca(
    workspace: string,
    numeroProcesso: string,
    pecaId: string,
  ): Promise<ArquivoDaPasta> {
    const numero = NumeroCNJ.criar(numeroProcesso).digitos;
    const entrada = await this.guarda.obter(workspace, numero, pecaId);
    if (!entrada) throw new PecaDaPastaNaoEncontradaError(pecaId);
    const tamanho = await this.armazem.tamanho(workspace, entrada.localizador);
    if (tamanho === undefined) throw new PecaDaPastaNaoEncontradaError(pecaId);
    return {
      tamanho,
      nomeArquivo: `processo-${numero}-peca-${pecaId.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`,
      baixadoEm: entrada.obtidaEm,
      expiraEm: entrada.expiraEm,
      ler: (inicio, fim) => this.armazem.ler(workspace, entrada.localizador, inicio, fim),
    };
  }

  // ---------------------------------------------------------------------------
  // Montar a pasta completa e baixar as marcadas

  /**
   * "Montar pasta completa": um job do leitor (lote adaptativo, pausa de 3 s,
   * disjuntor) para todas as peças — as não sigilosas fora da guarda são as
   * únicas que vão ao tribunal.
   *
   * Já há montagem em andamento → devolve ela (clique duplo não cria job). Já
   * há PDF pronto, no prazo, que cobre a lista inteira → devolve ele.
   */
  async montar(
    workspace: string,
    numeroProcesso: string,
  ): Promise<{
    readonly job: JobLeitor;
    readonly jaExistia: boolean;
    readonly estimativa: EstimativaDeBusca;
  }> {
    const numero = NumeroCNJ.criar(numeroProcesso).digitos;
    const listagem = await this.exigirListagem(workspace, numero);
    if (listagem.processoSigiloso) throw new SegredoDeJusticaNaoGuardadoError(numero);
    const todas = listagem.pecas.map((p) => p.pecaId);
    const estimativa = await this.estimar(workspace, listagem, todas);
    if (estimativa.total - estimativa.sigilosas === 0) {
      throw new PastaSemPecasParaJuntarError(numero);
    }

    const jobs = (await this.fila.doProcesso(workspace, numero)).filter(
      (j) => j.finalidade === 'pasta_completa',
    );
    const ativo = jobs.find((j) => ESTADOS_ATIVOS.includes(j.estado));
    if (ativo) return { job: ativo, jaExistia: true, estimativa };
    const pronto = jobs.find(
      (j) =>
        ESTADOS_COM_ARQUIVO.includes(j.estado) &&
        j.arquivo !== undefined &&
        (j.expiraEm?.getTime() ?? 0) > this.clock.agora().getTime() &&
        todas.every((id) => j.pedidas.includes(id)),
    );
    if (pronto && (await this.armazem.tamanho(workspace, pronto.arquivo!.localizador))) {
      return { job: pronto, jaExistia: true, estimativa };
    }

    const job = await this.leitor.criar(workspace, numero, todas, {
      finalidade: 'pasta_completa',
      listagem,
    });
    return { job, jaExistia: false, estimativa };
  }

  /**
   * Quantas peças da seleção serão buscadas no tribunal — a pergunta que a tela
   * faz ANTES de "Baixar PDF". Não cria nada e não chama o tribunal.
   */
  async previaDaSelecao(
    workspace: string,
    numeroProcesso: string,
    pecaIds: readonly string[],
  ): Promise<EstimativaDeBusca> {
    const numero = NumeroCNJ.criar(numeroProcesso).digitos;
    const listagem = await this.exigirListagem(workspace, numero);
    this.conferirIds(listagem, pecaIds);
    return this.estimar(workspace, listagem, pecaIds);
  }

  /**
   * "Baixar PDF" das marcadas: um job do leitor com as peças marcadas, na ordem
   * dos autos, índice próprio e nome `processo-<n>-pecas-selecionadas.pdf`. A
   * guarda é usada primeiro; só o que falta vai ao tribunal. Peça sob sigilo
   * marcada é ignorada (a tela as desabilita) — o resultado diz quantas.
   */
  async baixarSelecao(
    workspace: string,
    numeroProcesso: string,
    pecaIds: readonly string[],
  ): Promise<{ readonly job: JobLeitor; readonly estimativa: EstimativaDeBusca }> {
    const numero = NumeroCNJ.criar(numeroProcesso).digitos;
    const listagem = await this.exigirListagem(workspace, numero);
    if (listagem.processoSigiloso) throw new SegredoDeJusticaNaoGuardadoError(numero);
    this.conferirIds(listagem, pecaIds);
    const sigilosas = new Set(
      listagem.pecas.filter((p) => p.sigilosa).map((p) => p.pecaId),
    );
    const ids = [...new Set(pecaIds)].filter((id) => !sigilosas.has(id));
    if (ids.length === 0) throw new PastaSemPecasParaJuntarError(numero);
    const estimativa = await this.estimar(workspace, listagem, pecaIds);
    const job = await this.leitor.criar(workspace, numero, ids, {
      finalidade: 'selecionadas',
      listagem,
    });
    return { job, estimativa };
  }

  // ---------------------------------------------------------------------------

  private async exigirListagem(
    workspace: string,
    numero: string,
  ): Promise<ListagemDaPasta> {
    const listagem = await this.repositorio.obterListagem(workspace, numero);
    if (!listagem) throw new ListagemDaPastaAusenteError(numero);
    return listagem;
  }

  private conferirIds(listagem: ListagemDaPasta, ids: readonly string[]): void {
    const conhecidas = new Set(listagem.pecas.map((p) => p.pecaId));
    for (const id of ids) {
      if (!conhecidas.has(id)) throw new PecaDaPastaNaoEncontradaError(id);
    }
  }

  private async estimar(
    workspace: string,
    listagem: ListagemDaPasta,
    ids: readonly string[],
  ): Promise<EstimativaDeBusca> {
    const unicos = [...new Set(ids)];
    const porId = new Map(listagem.pecas.map((p) => [p.pecaId, p]));
    const guardadas = await this.guarda.doProcesso(workspace, listagem.numeroProcesso);
    let sigilosas = 0;
    let emGuarda = 0;
    let abuscar = 0;
    for (const id of unicos) {
      const p = porId.get(id);
      if (!p) continue;
      if (p.sigilosa) sigilosas += 1;
      else if (guardadas.has(id)) emGuarda += 1;
      else abuscar += 1;
    }
    const faixa = this.leitor.estimar(abuscar);
    return {
      abuscar,
      emGuarda,
      sigilosas,
      total: unicos.length,
      minimoSegundos: faixa.minimoSegundos,
      maximoSegundos: faixa.maximoSegundos,
      confirmarAcimaDe: faixa.confirmarAcimaDe,
      exigeConfirmacao: faixa.exigeConfirmacao,
    };
  }

  private iniciarOperario(workspace: string, numero: string): void {
    const k = chave(workspace, numero);
    if (this.operarios.has(k)) return;
    const operario: Promise<void> = this.despachar(workspace, numero)
      .catch((erro: unknown) => {
        this.logger.error('pasta: despacho falhou', {
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      })
      .finally(() => {
        // Só sai quem ainda é o operário do processo: um pedido que chegou
        // entre o fim do laço e este callback já pôs outro no lugar.
        if (this.operarios.get(k) === operario) this.operarios.delete(k);
      });
    this.operarios.set(k, operario);
  }

  /**
   * O laço de um processo: espera o debounce, e só despacha o pedido que
   * sobreviveu a ele. Pedido novo (peça diferente) durante a espera reinicia a
   * janela — o anterior já foi descartado em `solicitar`.
   *
   * Ao esvaziar, o operário SAI do mapa no mesmo trecho síncrono em que decide
   * sair. Sair só no `finally` deixaria uma janela em que um pedido novo
   * encontraria o operário "ainda vivo", não iniciaria outro, e ficaria
   * pendente sem ninguém para despachá-lo.
   */
  private async despachar(workspace: string, numero: string): Promise<void> {
    const k = chave(workspace, numero);
    for (;;) {
      const visto = this.pendentes.get(k);
      if (!visto) {
        this.operarios.delete(k);
        return;
      }
      await this.esperar(this.debounceMs);
      const atual = this.pendentes.get(k);
      if (!atual) {
        this.operarios.delete(k);
        return;
      }
      if (atual.versao !== visto.versao) continue;

      this.pendentes.delete(k);
      this.emVoo.set(k, {
        pecaId: atual.pecaId,
        desde: this.clock.agora(),
        fase: 'fila',
      });
      try {
        await this.buscarUma(workspace, numero, atual.pecaId);
      } finally {
        this.emVoo.delete(k);
      }
    }
  }

  private async buscarUma(
    workspace: string,
    numero: string,
    pecaId: string,
  ): Promise<void> {
    try {
      // Outro caminho (um job, um clique anterior) pode ter guardado a peça
      // enquanto esta esperava na fila: não volta ao tribunal.
      if (await this.guarda.obter(workspace, numero, pecaId)) return;

      await this.leitor.recusarSegredo(numero);
      const { tribunal, credencial } = await this.leitor.prepararConsulta(
        workspace,
        numero,
      );

      const uso = await this.leitor.garantirEspaco(workspace, numero);
      if (uso >= this.leitor.cotaPorWorkspaceBytes) {
        this.registrarFalha(workspace, numero, pecaId, 'cota_do_workspace');
        return;
      }

      const lote = await this.leitor.consultarLote(numero, [pecaId], credencial, () => {
        const voo = this.emVoo.get(chave(workspace, numero));
        if (voo?.pecaId === pecaId) voo.fase = 'tribunal';
      });
      await this.leitor.registrarUso(workspace, tribunal);

      const c = lote.conteudos.find((x) => x.id === pecaId);
      if (!c) {
        this.registrarFalha(
          workspace,
          numero,
          pecaId,
          lote.semTeor.includes(pecaId) ? 'sem_teor' : 'ausente_no_lote',
        );
        return;
      }
      if (c.bytes.length === 0) {
        this.registrarFalha(workspace, numero, pecaId, 'vazia');
        return;
      }
      if (c.bytes.length > this.leitor.cotaPorPdfBytes) {
        this.registrarFalha(workspace, numero, pecaId, 'cota_do_pdf');
        return;
      }

      const guardada = await this.guarda.guardar(workspace, numero, pecaId, {
        mimetype: c.mimetype,
        bytes: c.bytes,
      });
      if (!guardada.ok) {
        this.registrarFalha(workspace, numero, pecaId, guardada.motivo);
        return;
      }

      // A peça pode ter levado a conta acima da cota: sai o mais antigo —
      // nunca esta.
      const depois = await this.leitor.garantirEspaco(workspace, numero, {
        depoisDeGravar: { pecaId },
      });
      if (depois > this.leitor.cotaPorWorkspaceBytes) {
        await this.guarda.remover(guardada.entrada);
        this.registrarFalha(workspace, numero, pecaId, 'cota_do_workspace');
        return;
      }
      this.esquecerFalha(workspace, numero, pecaId);
      this.logger.info('pasta: peça obtida', {
        workspace,
        bytes: guardada.entrada.bytes,
        paginas: guardada.entrada.paginas,
      });
    } catch (erro) {
      await this.tratarErro(workspace, numero, pecaId, erro);
    }
  }

  private async tratarErro(
    workspace: string,
    numero: string,
    pecaId: string,
    erro: unknown,
  ): Promise<void> {
    if (erro instanceof MniBloqueadoError) {
      this.registrarFalha(workspace, numero, pecaId, 'bloqueio_do_tribunal', {
        retomarEm: erro.retomarEm,
      });
      return;
    }
    if (erro instanceof CredencialTribunalInvalidaError) {
      const tribunal = NumeroCNJ.criar(numero).siglaTribunal;
      if (tribunal) await this.leitor.registrarRecusa(workspace, tribunal);
      this.registrarFalha(workspace, numero, pecaId, 'credencial_recusada');
      return;
    }
    if (erro instanceof SemHabilitacaoNosAutosError) {
      this.registrarFalha(workspace, numero, pecaId, 'sem_habilitacao');
      return;
    }
    if (erro instanceof SegredoDeJusticaNaoGuardadoError) {
      this.registrarFalha(workspace, numero, pecaId, 'sigilosa');
      return;
    }
    // Mensagem de erro de domínio é feita para a pessoa ler; a de qualquer
    // outro erro pode carregar caminho interno, e fica no log.
    this.logger.warn('pasta: a peça não pôde ser obtida', {
      workspace,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    this.registrarFalha(workspace, numero, pecaId, 'interrompido', {
      mensagem:
        erro instanceof DomainError
          ? erro.message
          : 'Falha inesperada ao consultar o tribunal.',
    });
  }

  private registrarFalha(
    workspace: string,
    numero: string,
    pecaId: string,
    motivo: MotivoNaoObtida,
    extra: { readonly retomarEm?: Date; readonly mensagem?: string } = {},
  ): void {
    const k = chave(workspace, numero);
    const mapa = this.falhas.get(k) ?? new Map<string, Falha>();
    const agora = this.clock.agora();
    mapa.set(pecaId, {
      motivo,
      mensagem: extra.mensagem ?? DESCRICAO_DO_MOTIVO[motivo],
      ...(extra.retomarEm ? { retomarEm: extra.retomarEm } : {}),
      em: agora,
    });
    this.falhas.set(k, mapa);
  }

  private esquecerFalha(workspace: string, numero: string, pecaId: string): void {
    const k = chave(workspace, numero);
    this.falhas.get(k)?.delete(pecaId);
    this.substituidas.get(k)?.delete(pecaId);
  }

  private marcarSubstituida(k: string, pecaId: string): void {
    const s = this.substituidas.get(k) ?? new Set<string>();
    s.add(pecaId);
    this.substituidas.set(k, s);
  }

  private desmarcarSubstituida(k: string, pecaId: string): void {
    this.substituidas.get(k)?.delete(pecaId);
  }

  /** Job que ainda diz algo sobre as peças: em andamento, ou pronto no prazo. */
  private jobVigente(j: JobLeitor, agora: Date): boolean {
    if (ESTADOS_ATIVOS.includes(j.estado)) return true;
    if (j.estado !== 'pronto' && j.estado !== 'parcial') return false;
    return (j.expiraEm?.getTime() ?? 0) > agora.getTime();
  }

  /** Onde cada peça está no PDF "pasta completa" pronto — contado do arquivo. */
  private async intervalosDaMontagem(
    workspace: string,
    montagem: JobLeitor | undefined,
    agora: Date,
  ): Promise<Map<string, { inicial: number; final: number }>> {
    const saida = new Map<string, { inicial: number; final: number }>();
    if (
      !montagem ||
      !ESTADOS_COM_ARQUIVO.includes(montagem.estado) ||
      !montagem.arquivo ||
      !montagem.indice ||
      (montagem.expiraEm?.getTime() ?? 0) <= agora.getTime()
    ) {
      return saida;
    }
    if (
      (await this.armazem.tamanho(workspace, montagem.arquivo.localizador)) === undefined
    ) {
      return saida;
    }
    for (const e of montagem.indice) {
      saida.set(e.pecaId, { inicial: e.paginaInicial, final: e.paginaFinal });
    }
    return saida;
  }
}

/**
 * O que os jobs do processo dizem de cada peça: quem está esperando (`na_fila`)
 * ou sendo baixada (`baixando`) num job em andamento, e quem o último job
 * pronto não conseguiu obter (com o motivo).
 */
function estadosDosJobs(
  jobs: readonly JobLeitor[],
  vigente: (j: JobLeitor) => boolean,
): {
  readonly ativas: Map<
    string,
    { readonly estado: 'na_fila' | 'baixando'; readonly desde: Date }
  >;
  readonly falhas: Map<string, Falha>;
} {
  const ativas = new Map<
    string,
    { readonly estado: 'na_fila' | 'baixando'; readonly desde: Date }
  >();
  const falhas = new Map<string, Falha>();
  // Do mais recente ao mais antigo: o primeiro que fala de uma peça vale.
  for (const j of jobs) {
    if (!vigente(j)) continue;
    if (ESTADOS_ATIVOS.includes(j.estado)) {
      const baixando = j.estado === 'baixando' || j.estado === 'montando';
      let noLote = 0;
      for (const p of j.pecas) {
        if (p.situacao !== 'pendente' && p.situacao !== 'repetir') continue;
        if (ativas.has(p.pecaId)) continue;
        const estaNoLote = baixando && noLote < j.tamanhoLote && j.estado === 'baixando';
        if (estaNoLote) noLote += 1;
        ativas.set(p.pecaId, {
          estado: estaNoLote ? 'baixando' : 'na_fila',
          desde: j.criadoEm,
        });
      }
      continue;
    }
    for (const p of j.pecas) {
      if (p.situacao !== 'nao_obtida' || p.motivo === 'sigilosa') continue;
      if (falhas.has(p.pecaId)) continue;
      falhas.set(p.pecaId, {
        motivo: p.motivo ?? 'interrompido',
        mensagem: DESCRICAO_DO_MOTIVO[p.motivo ?? 'interrompido'],
        ...(j.retomarEm ? { retomarEm: j.retomarEm } : {}),
        em: j.atualizadoEm,
      });
    }
  }
  return { ativas, falhas };
}

/**
 * Os atos do tribunal por número, para pendurar cada peça no seu.
 *
 * Número repetido na mesma resposta não se resolve: qualquer dos dois atos
 * seria chute, e a descrição errada sobre uma peça é pior que descrição
 * nenhuma — o número fica de fora do índice e a linha segue como sempre foi.
 * Texto do ato guardado como veio (só aparado): é o que o cartório escreveu.
 */
function indexarAtos(
  movimentos: readonly Movimentacao[],
  posicoes: ReadonlyMap<number, number>,
): Map<number, MovimentacaoDaPeca> {
  const mapa = new Map<number, MovimentacaoDaPeca>();
  const repetidos = new Set<number>();
  for (const m of movimentos) {
    const numero = numeroDoMovimento(m);
    if (numero === undefined) continue;
    if (mapa.has(numero)) {
      repetidos.add(numero);
      continue;
    }
    const complemento = (m.complementos ?? [])
      .map((c) => c.trim())
      .filter((c) => c !== '')
      .join('; ');
    const posicao = posicoes.get(numero);
    mapa.set(numero, {
      numero,
      ...(posicao !== undefined ? { posicao } : {}),
      data: m.data,
      descricao: m.titulo.trim(),
      ...(complemento ? { complemento } : {}),
    });
  }
  for (const n of repetidos) mapa.delete(n);
  return mapa;
}

function montarCalibracao(
  ancoras: readonly AncoraGuardada[],
  total: number,
  listagem: ListagemDaPasta | undefined,
): VisaoDaCalibracao {
  return {
    ancoras,
    atos: resumirNumeracao(ancoras, total),
    invalidadas: listagem?.ancorasInvalidadas ?? 0,
  };
}
