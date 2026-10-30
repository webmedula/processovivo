import { createHash } from 'node:crypto';
import type {
  AvaliacaoDaAnalise,
  MotivoDaAvaliacao,
} from '../../domain/entities/AnaliseDoAto.js';
import type {
  AnaliseDePeca,
  DeterminacaoDaPeca,
  ResultadoDaAnaliseDePeca,
} from '../../domain/entities/AnaliseDePeca.js';
import {
  LIMITE_DE_PECAS_DA_ANALISE_DO_PROCESSO,
  MINIMO_DE_PECAS_LIDAS_PARA_A_SINTESE,
  PESO_DA_SINTESE_NO_TETO,
  type ItemDaSintese,
  type ResultadoDaSintese,
  type SinteseDoProcesso,
} from '../../domain/entities/AnaliseDoProcesso.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type { Processo } from '../../domain/entities/Processo.js';
import {
  AcompanhamentoNaoEncontradoError,
  AnaliseDePecaRecusadaError,
  AnaliseDoProcessoRecusadaError,
  AnaliseNaoEncontradaError,
  CredencialTribunalAusenteError,
  CredencialTribunalInvalidaError,
  DomainError,
  ListagemDaPastaAusenteError,
  MniBloqueadoError,
  PecaSigilosaNaoGuardadaError,
  SegredoDeJusticaNaoGuardadoError,
  type MotivoDeAnaliseDoProcessoRecusada,
} from '../../domain/errors/index.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import type { RepositorioSintesesDoProcesso } from '../../domain/ports/RepositorioSintesesDoProcesso.js';
import type { SintetizadorDoProcesso } from '../../domain/ports/SintetizadorDoProcesso.js';
import {
  montarEntradaDaSintese,
  VERSAO_PROMPT_DA_SINTESE,
  type PecaParaSintese,
} from '../politicas/entradaDaSintese.js';
import type { LimiteDeAnalises, TetoDiario } from '../politicas/limiteDeAnalises.js';
import type { PessoasParaRedigir } from '../politicas/redigirParaIA.js';
import { normalizarRef, verificarSintese } from '../politicas/verificarSintese.js';
import {
  chaveDoProcesso,
  type AnaliseDePecaParaATela,
  type ServicoAnaliseDePeca,
} from './ServicoAnaliseDePeca.js';
import type { ServicoAssinaturas } from './ServicoAssinaturas.js';

/**
 * Análise do PROCESSO pelas peças (v0.66.0; especificação `ia-analise-do-processo` v1.0.0; decisões do dono
 * de 29/10/2026). O advogado escolhe de 2 a 20 peças na Pasta digital e, num clique:
 *
 * 1. **Etapa 1**: cada peça passa pela análise de peça DE SEMPRE (`ServicoAnaliseDePeca.analisar`), uma por
 *    vez — mesma guarda de 24 h, mesma extração, redação, ZDR, verificação por página, peso 5 no teto
 *    diário e reaproveitamento por 30 dias. A peça fora da guarda é pedida ao tribunal pelo caminho da Pasta
 *    (`solicitar`: debounce, fila, pausa de 3 s, disjuntor) e só porque o advogado a marcou. Credencial
 *    recusada ou bloqueio não são insistidos: as peças seguintes que precisariam do tribunal ficam de fora.
 * 2. **Etapa 2**: a SÍNTESE recebe só os resultados VERIFICADOS da etapa 1, com marcadores — nunca texto de
 *    peça — e aponta identificadores de item; o sistema copia trecho e página da etapa 1 (a síntese não tem
 *    como inventar citação). Pesa 5 no teto diário; a mesma seleção volta do banco sem modelo e sem peso.
 *
 * Determinações, documentos, valores, partes e "o que ficou de fora" são montados pelo SISTEMA, sem modelo.
 * Liberação na versão 1: só as contas de `PROCESSOVIVO_IA_PROCESSO_WORKSPACES` (até a Política v1.6) e que
 * também tenham a análise de peça liberada; plano IA sem exceção; interruptor, teto e modelo são os da
 * função `peca` do painel. O job vive em MEMÓRIA (como o envio ao Drive): um por conta, consultado por
 * polling; reiniciar o servidor o perde, e pedir de novo reaproveita o que já foi lido.
 */

/** O que a análise do processo precisa da Pasta digital. Nada daqui consulta o tribunal por conta própria. */
export interface FonteDaAnaliseDoProcesso {
  listar(
    workspace: string,
    numero: string,
  ): Promise<
    | {
        readonly tribunal: string;
        readonly processoSigiloso: boolean;
        readonly pecas: readonly {
          readonly pecaId: string;
          readonly rotulo: string;
          readonly data: Date | undefined;
          readonly sigilosa: boolean;
          readonly emGuarda: boolean;
        }[];
      }
    | undefined
  >;
  solicitar(workspace: string, numero: string, pecaId: string): Promise<void>;
  estado(
    workspace: string,
    numero: string,
    pecaId: string,
  ): Promise<'nao_baixada' | 'na_fila' | 'baixando' | 'disponivel' | 'nao_obtida' | 'sigilo'>;
}

export interface OpcoesServicoAnaliseDoProcesso {
  readonly pecas: Pick<
    ServicoAnaliseDePeca,
    'analisar' | 'comMarcadores' | 'jaAnalisadas' | 'modoDa' | 'disponivel'
  >;
  readonly repositorio: RepositorioAcompanhamentos;
  readonly assinaturas: Pick<ServicoAssinaturas, 'temRecursoSemExcecao'>;
  readonly fonte: FonteDaAnaliseDoProcesso;
  readonly sintetizador: SintetizadorDoProcesso;
  readonly sinteses: RepositorioSintesesDoProcesso;
  /** Freio PRÓPRIO por análise do processo (por hora; uma em andamento por conta). Peso 0: o teto é o `teto`. */
  readonly limite: LimiteDeAnalises;
  /** O MESMO teto diário das outras funções de IA: a síntese pesa 5, na conta da função `peca`. */
  readonly teto: Pick<TetoDiario, 'cabe' | 'registrar'>;
  /** `PROCESSOVIVO_IA_PROCESSO_WORKSPACES`: as únicas contas liberadas na versão 1. */
  readonly workspaces: readonly string[];
  readonly tribunais: readonly string[];
  /** O modelo da análise de peça (a síntese usa o mesmo na versão 1), para o reaproveitamento. */
  readonly modelo: () => string;
  readonly resultadoDias: number;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly novoId: () => string;
  readonly esperar?: (ms: number) => Promise<void>;
}

export type EstadoDaPecaNaAnalise =
  | 'aguardando'
  | 'baixando'
  | 'lendo'
  | 'lida'
  | 'reaproveitada'
  | 'fora';

/** Por que uma peça ficou de fora. A tela tem uma frase FIXA para cada um. */
export type MotivoDaPecaFora =
  | AnaliseDePecaRecusadaError['motivo']
  | 'nao_verificada'
  | 'erro'
  | 'nao_obtida'
  | 'credencial'
  | 'bloqueio_do_tribunal'
  | 'tempo_esgotado'
  | 'cancelada';

export interface FonteDoItem {
  readonly pecaId: string;
  readonly rotulo: string;
  readonly data: string | null;
  readonly pagina: number | null;
  readonly trecho: string | null;
}

export interface ItemParaATela {
  readonly texto: string;
  readonly fontes: readonly FonteDoItem[];
}

export interface ResultadoDaAnaliseDoProcessoParaATela {
  /** `null` quando não houve síntese (menos de 2 peças lidas, teto do dia, erro do modelo). */
  readonly sintese: {
    readonly id: string;
    readonly estado: 'verificada' | 'nao_verificada';
    readonly reaproveitada: boolean;
    readonly objeto: ItemParaATela | null;
    readonly pedidos: readonly (ItemParaATela & {
      readonly defesa: ItemParaATela | null;
      readonly decisao: ItemParaATela | null;
    })[];
    readonly linhaDoTempo: readonly ItemParaATela[];
    readonly controvertidos: readonly ItemParaATela[];
    readonly criadaEm: string;
    readonly avaliacao: AvaliacaoDaAnalise | null;
  } | null;
  readonly semSintese: 'poucas_pecas' | 'limite_diario' | 'erro' | null;
  readonly classe: string | null;
  readonly partes: { readonly autores: readonly string[]; readonly reus: readonly string[] };
  readonly determinacoes: readonly {
    readonly quem: string;
    readonly texto: string;
    readonly prazo: string | null;
    readonly fonte: FonteDoItem;
  }[];
  readonly documentos: readonly { readonly nome: string; readonly fonte: FonteDoItem }[];
  readonly valores: readonly {
    readonly valor: string;
    readonly contexto: string;
    readonly fonte: FonteDoItem;
  }[];
}

export interface VisaoDaAnaliseDoProcesso {
  readonly id: string;
  readonly fase: 'pecas' | 'sintese' | 'concluida' | 'falhou' | 'cancelada';
  readonly motivo: MotivoDeAnaliseDoProcessoRecusada | null;
  readonly total: number;
  readonly concluidas: number;
  readonly pecas: readonly {
    readonly pecaId: string;
    readonly rotulo: string;
    readonly data: string | null;
    readonly estado: EstadoDaPecaNaAnalise;
    readonly motivo: MotivoDaPecaFora | null;
  }[];
  readonly resultado: ResultadoDaAnaliseDoProcessoParaATela | null;
}

export interface EstimativaDaAnaliseDoProcesso {
  readonly total: number;
  readonly sigilosas: number;
  readonly aBuscarNoTribunal: number;
  readonly jaAnalisadas: number;
  /** O máximo que a análise pode pesar no teto do dia (5 por peça nova + 5 da síntese). */
  readonly pesoMaximo: number;
}

interface PecaDoJob {
  readonly pecaId: string;
  readonly rotulo: string;
  readonly data: Date | undefined;
  estado: EstadoDaPecaNaAnalise;
  motivo?: MotivoDaPecaFora;
  analise?: AnaliseDePecaParaATela;
}

interface Job {
  readonly id: string;
  readonly workspace: string;
  readonly numero: string;
  readonly processo: Processo;
  fase: VisaoDaAnaliseDoProcesso['fase'];
  motivo?: MotivoDeAnaliseDoProcessoRecusada;
  readonly pecas: PecaDoJob[];
  resultado?: ResultadoDaAnaliseDoProcessoParaATela;
  readonly cancelamento: AbortController;
  terminadoEm?: Date;
}

const UM_DIA_MS = 86_400_000;
/** Quanto tempo o resultado de um job terminado fica consultável na memória. */
const RETENCAO_DO_JOB_MS = 3_600_000;
const ESPERA_ENTRE_CONSULTAS_MS = 1_000;
const MAXIMO_DE_ESPERAS_PELA_PECA = 120;
const MAXIMO_DE_PEDIDOS_POR_PECA = 3;

const FRASES: Readonly<Record<MotivoDeAnaliseDoProcessoRecusada, string>> = {
  indisponivel: 'A análise do processo por IA não está disponível para esta conta.',
  sem_plano:
    'A análise do processo por IA faz parte do plano IA. Faça upgrade do plano para usar.',
  desligada: 'Este recurso está indisponível no momento.',
  processo_sigiloso:
    'Processo em segredo de justiça: a análise por IA não é feita. Leia as peças.',
  tribunal_nao_suportado:
    'Por enquanto a análise do processo vale apenas para o Tribunal de Justiça de Goiás (TJGO).',
  selecao_invalida: 'Marque de 2 a 20 peças da lista para analisar o processo.',
  limite_de_uso:
    'Já há uma análise do processo em andamento, ou o limite por hora foi atingido. Tente novamente em instantes.',
  nao_encontrada: 'Esta análise não foi encontrada. Comece de novo pela Pasta digital.',
};

const recusa = (m: MotivoDeAnaliseDoProcessoRecusada): AnaliseDoProcessoRecusadaError =>
  new AnaliseDoProcessoRecusadaError(m, FRASES[m]);

/** Motivos da peça que derrubam a análise inteira (valem para todas as peças). */
const MOTIVOS_QUE_PARAM: ReadonlySet<string> = new Set([
  'indisponivel',
  'sem_plano',
  'desligada',
  'processo_sigiloso',
  'tribunal_nao_suportado',
]);

class PecaFora extends Error {
  constructor(readonly motivo: MotivoDaPecaFora) {
    super(motivo);
  }
}

export class ServicoAnaliseDoProcesso {
  private readonly log: Logger;
  private readonly esperar: (ms: number) => Promise<void>;
  /** Um job por conta (o mais recente). */
  private readonly jobs = new Map<string, Job>();
  private readonly emCurso = new Set<Promise<void>>();

  constructor(private readonly o: OpcoesServicoAnaliseDoProcesso) {
    this.log = o.logger.child({ servico: 'analise-do-processo' });
    this.esperar =
      o.esperar ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** A conta está liberada (lista da versão 1 + análise de peça liberada e ligada)? */
  liberado(workspace: string): boolean {
    const id = workspace.trim().toLowerCase();
    return this.o.workspaces.includes(id) && this.o.pecas.modoDa(workspace) !== undefined;
  }

  async estimar(
    workspace: string,
    numeroBruto: string,
    pecaIds: readonly string[],
  ): Promise<EstimativaDaAnaliseDoProcesso> {
    const { numero, listagem } = await this.conferir(workspace, numeroBruto, pecaIds);
    const escolhidas = listagem.pecas.filter((p) => pecaIds.includes(p.pecaId));
    const sigilosas = escolhidas.filter((p) => p.sigilosa).length;
    const legiveis = escolhidas.filter((p) => !p.sigilosa);
    const ja = await this.o.pecas.jaAnalisadas(
      workspace,
      numero,
      legiveis.map((p) => p.pecaId),
    );
    const novas = legiveis.length - ja.size;
    return {
      total: escolhidas.length,
      sigilosas,
      aBuscarNoTribunal: legiveis.filter((p) => !p.emGuarda).length,
      jaAnalisadas: ja.size,
      pesoMaximo: novas * 5 + PESO_DA_SINTESE_NO_TETO,
    };
  }

  async iniciar(
    workspace: string,
    numeroBruto: string,
    pecaIds: readonly string[],
  ): Promise<VisaoDaAnaliseDoProcesso> {
    const { numero, processo, listagem } = await this.conferir(
      workspace,
      numeroBruto,
      pecaIds,
    );
    const atual = this.jobs.get(workspace);
    if (atual && (atual.fase === 'pecas' || atual.fase === 'sintese')) {
      throw recusa('limite_de_uso');
    }
    // A vaga do freio PRÓPRIO (por hora e "uma por conta"); peso 0: quem pesa é cada peça e a síntese.
    const vaga = this.o.limite.reservar(workspace, 0);
    if ('negada' in vaga) throw recusa('limite_de_uso');

    const job: Job = {
      id: this.o.novoId(),
      workspace,
      numero,
      processo,
      fase: 'pecas',
      // A ordem dos autos (a da listagem), não a ordem do clique.
      pecas: listagem.pecas
        .filter((p) => pecaIds.includes(p.pecaId))
        .map((p) => ({
          pecaId: p.pecaId,
          rotulo: p.rotulo,
          data: p.data,
          estado: p.sigilosa ? 'fora' : 'aguardando',
          ...(p.sigilosa ? { motivo: 'peca_sigilosa' as const } : {}),
        })),
      cancelamento: new AbortController(),
    };
    this.jobs.set(workspace, job);
    const execucao = this.executar(job)
      .catch((erro: unknown) => {
        job.fase = 'falhou';
        this.log.warn('análise do processo interrompida', {
          causa: erro instanceof DomainError ? erro.codigo : 'erro_inesperado',
        });
      })
      .finally(() => {
        vaga.liberar();
        job.terminadoEm = this.o.clock.agora();
        this.emCurso.delete(execucao);
      });
    this.emCurso.add(execucao);
    return this.visao(job);
  }

  /** O estado do job DESTA conta. Mesma resposta para "não existe" e "é de outra". */
  consultar(workspace: string, id: string): VisaoDaAnaliseDoProcesso {
    const job = this.jobs.get(workspace);
    if (!job || job.id !== id || this.expirado(job)) throw recusa('nao_encontrada');
    return this.visao(job);
  }

  cancelar(workspace: string, id: string): VisaoDaAnaliseDoProcesso {
    const job = this.jobs.get(workspace);
    if (!job || job.id !== id || this.expirado(job)) throw recusa('nao_encontrada');
    if (job.fase === 'pecas' || job.fase === 'sintese') {
      job.cancelamento.abort();
      job.fase = 'cancelada';
    }
    return this.visao(job);
  }

  async avaliar(
    workspace: string,
    id: string,
    avaliacao: AvaliacaoDaAnalise,
    motivo?: MotivoDaAvaliacao,
  ): Promise<void> {
    if (!this.liberado(workspace)) throw recusa('indisponivel');
    const ok = await this.o.sinteses.avaliar(workspace, id, avaliacao, motivo);
    if (!ok) throw new AnaliseNaoEncontradaError();
  }

  /** Espera os jobs em andamento terminarem. Para teste e para o desligamento. */
  async aguardarOcioso(): Promise<void> {
    while (this.emCurso.size > 0) await Promise.all([...this.emCurso]);
  }

  // ---------------------------------------------------------------------------

  /** Tudo o que recusa ANTES de qualquer consulta ao tribunal ou ao modelo. */
  private async conferir(
    workspace: string,
    numeroBruto: string,
    pecaIds: readonly string[],
  ): Promise<{
    readonly numero: string;
    readonly processo: Processo;
    readonly listagem: NonNullable<Awaited<ReturnType<FonteDaAnaliseDoProcesso['listar']>>>;
  }> {
    if (!this.o.pecas.disponivel()) throw recusa('desligada');
    if (!this.liberado(workspace)) throw recusa('indisponivel');
    if (!(await this.o.assinaturas.temRecursoSemExcecao(workspace, 'analiseIa'))) {
      throw recusa('sem_plano');
    }
    const numero = NumeroCNJ.criar(numeroBruto).digitos;
    const acompanhamento = await this.o.repositorio.buscar(workspace, numero);
    const processo = acompanhamento?.processo;
    if (!processo) throw new AcompanhamentoNaoEncontradoError();
    if (processo.segredoJustica) throw recusa('processo_sigiloso');
    const listagem = await this.o.fonte.listar(workspace, numero);
    if (!listagem) throw new ListagemDaPastaAusenteError(numero);
    if (listagem.processoSigiloso) throw recusa('processo_sigiloso');
    if (!this.o.tribunais.includes(listagem.tribunal.toUpperCase())) {
      throw recusa('tribunal_nao_suportado');
    }
    const unicas = new Set(pecaIds);
    const conhecidas = new Set(listagem.pecas.map((p) => p.pecaId));
    if (
      unicas.size !== pecaIds.length ||
      unicas.size < MINIMO_DE_PECAS_LIDAS_PARA_A_SINTESE ||
      unicas.size > LIMITE_DE_PECAS_DA_ANALISE_DO_PROCESSO ||
      ![...unicas].every((id) => conhecidas.has(id))
    ) {
      throw recusa('selecao_invalida');
    }
    return { numero, processo, listagem };
  }

  private expirado(job: Job): boolean {
    return (
      job.terminadoEm !== undefined &&
      this.o.clock.agora().getTime() - job.terminadoEm.getTime() > RETENCAO_DO_JOB_MS
    );
  }

  private cancelado(job: Job): boolean {
    return job.cancelamento.signal.aborted;
  }

  private async executar(job: Job): Promise<void> {
    // ---- Etapa 1: uma peça por vez ----
    let semTribunal: MotivoDaPecaFora | undefined;
    for (let i = 0; i < job.pecas.length; i++) {
      const p = job.pecas[i];
      if (!p || p.estado !== 'aguardando') continue;
      if (this.cancelado(job)) break;
      try {
        p.analise = await this.lerPeca(job, p, semTribunal);
        p.estado = p.analise.reaproveitada ? 'reaproveitada' : 'lida';
      } catch (erro) {
        if (erro instanceof PecaFora) {
          p.estado = 'fora';
          p.motivo = erro.motivo;
          if (
            erro.motivo === 'credencial' ||
            erro.motivo === 'bloqueio_do_tribunal'
          ) {
            semTribunal = erro.motivo;
          }
          continue;
        }
        if (erro instanceof AnaliseDePecaRecusadaError) {
          if (MOTIVOS_QUE_PARAM.has(erro.motivo)) {
            job.fase = 'falhou';
            job.motivo = erro.motivo as MotivoDeAnaliseDoProcessoRecusada;
            for (const r of job.pecas.slice(i)) {
              if (r.estado !== 'fora') {
                r.estado = 'fora';
                r.motivo = erro.motivo;
              }
            }
            return;
          }
          p.estado = 'fora';
          p.motivo = erro.motivo;
          // O teto do dia acabou: nenhuma peça seguinte cabe. Paramos a etapa 1 com o que já foi lido.
          if (erro.motivo === 'limite_diario') {
            for (const r of job.pecas.slice(i + 1)) {
              if (r.estado === 'aguardando') {
                r.estado = 'fora';
                r.motivo = 'limite_diario';
              }
            }
            break;
          }
          continue;
        }
        throw erro;
      }
    }
    if (this.cancelado(job)) {
      for (const r of job.pecas) {
        if (r.estado === 'aguardando' || r.estado === 'baixando' || r.estado === 'lendo') {
          r.estado = 'fora';
          r.motivo = 'cancelada';
        }
      }
      job.fase = 'cancelada';
      return;
    }

    // ---- Etapa 2: a síntese dos resultados verificados ----
    job.fase = 'sintese';
    const resultado = await this.sintetizar(job);
    if (this.cancelado(job)) {
      job.fase = 'cancelada';
      return;
    }
    job.resultado = resultado;
    job.fase = 'concluida';
    this.log.info('análise do processo concluída', {
      pecas: job.pecas.length,
      lidas: job.pecas.filter((p) => p.estado === 'lida').length,
      reaproveitadas: job.pecas.filter((p) => p.estado === 'reaproveitada').length,
      fora: job.pecas.filter((p) => p.estado === 'fora').length,
      sintese: resultado.sintese?.estado ?? resultado.semSintese,
    });
  }

  /** Lê UMA peça pela análise de peça de sempre; se ela não está na guarda, pede ao tribunal e espera. */
  private async lerPeca(
    job: Job,
    p: PecaDoJob,
    semTribunal: MotivoDaPecaFora | undefined,
  ): Promise<AnaliseDePecaParaATela> {
    const analisar = async (): Promise<AnaliseDePecaParaATela> => {
      p.estado = 'lendo';
      const r = await this.o.pecas.analisar({
        workspace: job.workspace,
        numero: job.numero,
        pecaId: p.pecaId,
        sinal: job.cancelamento.signal,
        dentroDaAnaliseDoProcesso: true,
      });
      if (r.estado === 'erro') throw new PecaFora(this.cancelado(job) ? 'cancelada' : 'erro');
      if (r.estado === 'nao_verificada') throw new PecaFora('nao_verificada');
      return r;
    };
    try {
      return await analisar();
    } catch (erro) {
      if (!(erro instanceof AnaliseDePecaRecusadaError) || erro.motivo !== 'peca_nao_baixada') {
        throw erro;
      }
    }
    if (semTribunal) throw new PecaFora(semTribunal);
    await this.baixar(job, p);
    return analisar();
  }

  /** Pede a peça pelo caminho da Pasta e espera ela entrar na guarda. Sem insistir contra recusa. */
  private async baixar(job: Job, p: PecaDoJob): Promise<void> {
    p.estado = 'baixando';
    for (let pedido = 1; pedido <= MAXIMO_DE_PEDIDOS_POR_PECA; pedido++) {
      try {
        await this.o.fonte.solicitar(job.workspace, job.numero, p.pecaId);
      } catch (erro) {
        if (
          erro instanceof CredencialTribunalAusenteError ||
          erro instanceof CredencialTribunalInvalidaError
        ) {
          throw new PecaFora('credencial');
        }
        if (erro instanceof MniBloqueadoError) throw new PecaFora('bloqueio_do_tribunal');
        if (
          erro instanceof SegredoDeJusticaNaoGuardadoError ||
          erro instanceof PecaSigilosaNaoGuardadaError
        ) {
          throw new PecaFora('peca_sigilosa');
        }
        throw new PecaFora('nao_obtida');
      }
      for (let espera = 0; espera < MAXIMO_DE_ESPERAS_PELA_PECA; espera++) {
        if (this.cancelado(job)) throw new PecaFora('cancelada');
        const e = await this.o.fonte.estado(job.workspace, job.numero, p.pecaId);
        if (e === 'disponivel') return;
        if (e === 'nao_obtida') throw new PecaFora('nao_obtida');
        if (e === 'sigilo') throw new PecaFora('peca_sigilosa');
        // O pedido foi trocado por outro (o advogado clicou noutra peça na Pasta): pede de novo.
        if (e === 'nao_baixada') break;
        await this.esperar(ESPERA_ENTRE_CONSULTAS_MS);
      }
    }
    throw new PecaFora('tempo_esgotado');
  }

  private async sintetizar(job: Job): Promise<ResultadoDaAnaliseDoProcessoParaATela> {
    const lidas = job.pecas.filter(
      (p): p is PecaDoJob & { analise: AnaliseDePecaParaATela } =>
        (p.estado === 'lida' || p.estado === 'reaproveitada') && p.analise !== undefined,
    );
    // A versão com MARCADORES de cada análise, do banco: é ela que vai ao modelo.
    const comMarcadores: Array<{
      readonly peca: (typeof lidas)[number];
      readonly guardada: AnaliseDePeca & {
        readonly resultado: Extract<ResultadoDaAnaliseDePeca, { estado: 'verificada' }>;
      };
    }> = [];
    for (const peca of lidas) {
      const g = await this.o.pecas.comMarcadores(job.workspace, peca.analise.id);
      if (g && g.resultado.estado === 'verificada') {
        comMarcadores.push({
          peca,
          guardada: g as AnaliseDePeca & {
            readonly resultado: Extract<ResultadoDaAnaliseDePeca, { estado: 'verificada' }>;
          },
        });
      }
    }
    // Ordem cronológica: `P1` é a peça mais antiga.
    comMarcadores.sort(
      (a, b) => (a.peca.data?.getTime() ?? 0) - (b.peca.data?.getTime() ?? 0),
    );
    const doSistema = this.blocosDoSistema(job, comMarcadores.map((c) => c.peca));
    if (comMarcadores.length < MINIMO_DE_PECAS_LIDAS_PARA_A_SINTESE) {
      return { ...doSistema, sintese: null, semSintese: 'poucas_pecas' };
    }

    const pecasParaSintese: PecaParaSintese[] = comMarcadores.map((c) => ({
      tipo: c.guardada.resultado.tipo,
      data: c.peca.data,
      resultado: c.guardada.resultado,
    }));
    const entrada = montarEntradaDaSintese(pecasParaSintese, pessoasDoProcesso(job.processo));
    const modelo = this.o.modelo();
    const ids = comMarcadores.map((c) => c.guardada.id);
    const chaveDaSelecao = createHash('sha256')
      .update(`${ids.join(',')}|${VERSAO_PROMPT_DA_SINTESE}|${modelo}`)
      .digest('hex');
    const agora = this.o.clock.agora();

    let sintese = await this.o.sinteses.buscarReaproveitavel(
      job.workspace,
      chaveDaSelecao,
      agora,
    );
    const reaproveitada = sintese !== undefined;
    if (!sintese) {
      if (!this.o.teto.cabe(job.workspace, PESO_DA_SINTESE_NO_TETO, 'peca')) {
        return { ...doSistema, sintese: null, semSintese: 'limite_diario' };
      }
      this.o.teto.registrar(job.workspace, PESO_DA_SINTESE_NO_TETO, 'peca');
      const inicio = this.o.clock.monotonico();
      let bruta;
      try {
        bruta = await this.o.sintetizador.sintetizar({
          sistema: entrada.sistema,
          usuario: entrada.usuario,
          sinal: job.cancelamento.signal,
        });
      } catch (erro) {
        // Só a CLASSE do erro: a mensagem de um roteador pode ecoar o pedido.
        this.log.warn('síntese do processo não concluída', {
          causa: erro instanceof DomainError ? erro.codigo : 'erro_inesperado',
        });
        return { ...doSistema, sintese: null, semSintese: 'erro' };
      }
      const latenciaMs = Math.max(0, Math.round(this.o.clock.monotonico() - inicio));
      const v = verificarSintese(bruta.resposta, entrada.itens);
      const resultado: ResultadoDaSintese =
        v.estado === 'verificada'
          ? {
              estado: 'verificada',
              objeto: v.objeto,
              pedidos: v.pedidos,
              linhaDoTempo: v.linhaDoTempo,
              controvertidos: v.controvertidos,
            }
          : { estado: 'nao_verificada', motivo: v.motivo };
      const descartes =
        v.descartes.referencia + v.descartes.forma + v.descartes.numero + v.descartes.proibida;
      const criadaEm = this.o.clock.agora();
      sintese = {
        id: this.o.novoId(),
        workspace: job.workspace,
        processoChave: chaveDoProcesso(job.workspace, job.numero),
        chaveDaSelecao,
        analises: ids,
        resultado,
        contagens: {
          pecas: ids.length,
          itensEnviados: entrada.itens.size,
          itensDescartados: descartes,
          peso: PESO_DA_SINTESE_NO_TETO,
        },
        procedencia: {
          modelo: bruta.modelo,
          versaoPrompt: VERSAO_PROMPT_DA_SINTESE,
          provedor: bruta.provedor,
          criadaEm,
        },
        modeloPedido: modelo,
        medidas: {
          latenciaMs,
          ...(bruta.tokensEntrada !== undefined ? { tokensEntrada: bruta.tokensEntrada } : {}),
          ...(bruta.tokensSaida !== undefined ? { tokensSaida: bruta.tokensSaida } : {}),
          ...(bruta.custoUsd !== undefined ? { custoUsd: bruta.custoUsd } : {}),
        },
        criadaEm,
        expiraEm: new Date(criadaEm.getTime() + this.o.resultadoDias * UM_DIA_MS),
      };
      await this.o.sinteses.salvar(sintese);
      // Só contagens: nada de texto, trecho, parte, número de processo ou conta.
      this.log.info('síntese do processo montada', {
        estado: resultado.estado,
        pecas: ids.length,
        itensEnviados: entrada.itens.size,
        descartesReferencia: v.descartes.referencia,
        descartesForma: v.descartes.forma,
        descartesNumero: v.descartes.numero,
        descartesProibida: v.descartes.proibida,
        latenciaMs,
      });
    }

    return {
      ...doSistema,
      semSintese: null,
      sintese: this.sinteseParaATela(
        sintese,
        reaproveitada,
        comMarcadores.map((c) => c.peca),
        entrada.restaurar,
      ),
    };
  }

  private sinteseParaATela(
    s: SinteseDoProcesso,
    reaproveitada: boolean,
    pecas: readonly (PecaDoJob & { analise: AnaliseDePecaParaATela })[],
    restaurar: (t: string) => string,
  ): NonNullable<ResultadoDaAnaliseDoProcessoParaATela['sintese']> {
    const item = (i: ItemDaSintese): ItemParaATela => ({
      texto: restaurar(i.texto),
      fontes: i.refs
        .map((r) => fonteDaRef(r, pecas))
        .filter((f): f is FonteDoItem => f !== undefined),
    });
    const r = s.resultado;
    // A linha do tempo vai em ordem de peça (a numeração já é cronológica).
    const primeiraPeca = (i: ItemDaSintese): number =>
      Math.min(...i.refs.map((ref) => Number(/^P(\d+)/.exec(ref)?.[1] ?? 999)));
    return {
      id: s.id,
      estado: r.estado,
      reaproveitada,
      objeto: r.estado === 'verificada' ? item(r.objeto) : null,
      pedidos:
        r.estado === 'verificada'
          ? r.pedidos.map((p) => ({
              ...item(p),
              defesa: p.defesa ? item(p.defesa) : null,
              decisao: p.decisao ? item(p.decisao) : null,
            }))
          : [],
      linhaDoTempo:
        r.estado === 'verificada'
          ? [...r.linhaDoTempo]
              .sort((a, b) => primeiraPeca(a) - primeiraPeca(b))
              .map(item)
          : [],
      controvertidos: r.estado === 'verificada' ? r.controvertidos.map(item) : [],
      criadaEm: s.criadaEm.toISOString(),
      avaliacao: s.avaliacao ?? null,
    };
  }

  /** Os blocos que o SISTEMA monta, sem modelo: partes, classe, determinações, documentos e valores. */
  private blocosDoSistema(
    job: Job,
    pecas: readonly (PecaDoJob & { analise: AnaliseDePecaParaATela })[],
  ): Omit<ResultadoDaAnaliseDoProcessoParaATela, 'sintese' | 'semSintese'> {
    const determinacoes: Array<ResultadoDaAnaliseDoProcessoParaATela['determinacoes'][number]> =
      [];
    const documentos: Array<ResultadoDaAnaliseDoProcessoParaATela['documentos'][number]> = [];
    const valores: Array<ResultadoDaAnaliseDoProcessoParaATela['valores'][number]> = [];
    for (const p of pecas) {
      const r = p.analise.resultado;
      if (r.estado !== 'verificada') continue;
      const fonte = (pagina: number | null, trecho: string | null): FonteDoItem => ({
        pecaId: p.pecaId,
        rotulo: p.rotulo,
        data: dataIso(p.data),
        pagina,
        trecho,
      });
      for (const d of r.determinacoes ?? ([] as readonly DeterminacaoDaPeca[])) {
        determinacoes.push({
          quem: d.quem,
          texto: d.texto,
          prazo: d.prazo_escrito,
          fonte: fonte(d.pagina, d.trecho),
        });
      }
      for (const d of r.documentos) {
        documentos.push({ nome: d.nome_como_escrito, fonte: fonte(d.pagina, null) });
      }
      for (const v of r.valores) {
        valores.push({
          valor: v.valor_literal,
          contexto: v.contexto_curto,
          fonte: fonte(v.pagina, v.trecho),
        });
      }
    }
    const nomes = (polo: 'ATIVO' | 'PASSIVO'): string[] =>
      job.processo.partes.filter((x) => x.polo === polo).map((x) => x.nome);
    return {
      classe: job.processo.classe ?? null,
      partes: { autores: nomes('ATIVO'), reus: nomes('PASSIVO') },
      determinacoes,
      documentos,
      valores,
    };
  }

  private visao(job: Job): VisaoDaAnaliseDoProcesso {
    return {
      id: job.id,
      fase: job.fase,
      motivo: job.motivo ?? null,
      total: job.pecas.length,
      concluidas: job.pecas.filter(
        (p) => p.estado === 'lida' || p.estado === 'reaproveitada' || p.estado === 'fora',
      ).length,
      pecas: job.pecas.map((p) => ({
        pecaId: p.pecaId,
        rotulo: p.rotulo,
        data: dataIso(p.data),
        estado: p.estado,
        motivo: p.motivo ?? null,
      })),
      resultado: job.resultado ?? null,
    };
  }
}

const TIPO_DA_CATEGORIA: Readonly<Record<string, 'pedidos' | 'alegacoes' | 'preliminares' | 'determinacoes' | 'valores'>> = {
  pedido: 'pedidos',
  alegacao: 'alegacoes',
  preliminar: 'preliminares',
  determinacao: 'determinacoes',
  valor: 'valores',
};

/** `P2.pedido1` → o trecho e a página do item 1 dos pedidos da 2ª peça, COPIADOS da etapa 1 (com os nomes). */
function fonteDaRef(
  bruta: string,
  pecas: readonly (PecaDoJob & { analise: AnaliseDePecaParaATela })[],
): FonteDoItem | undefined {
  const ref = normalizarRef(bruta);
  const m = /^P(\d+)\.([a-z]+)(\d+)$/.exec(ref);
  if (!m) return undefined;
  const p = pecas[Number(m[1]) - 1];
  if (!p) return undefined;
  const r = p.analise.resultado;
  if (r.estado !== 'verificada') return undefined;
  const base = { pecaId: p.pecaId, rotulo: p.rotulo, data: dataIso(p.data) };
  const categoria = m[2] ?? '';
  if (categoria === 'resumo') return { ...base, pagina: null, trecho: null };
  const campo = TIPO_DA_CATEGORIA[categoria];
  if (!campo) return undefined;
  const lista: readonly { readonly trecho: string; readonly pagina: number }[] =
    campo === 'determinacoes' ? (r.determinacoes ?? []) : r[campo];
  const it = lista[Number(m[3]) - 1];
  return it ? { ...base, pagina: it.pagina, trecho: it.trecho } : undefined;
}

function dataIso(d: Date | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function pessoasDoProcesso(processo: Processo): PessoasParaRedigir {
  return {
    partes: processo.partes.map((p) => ({
      nome: p.nome,
      pessoaFisica: p.tipoPessoa === 'FISICA',
      advogados: p.advogados.map((a) => ({ nome: a.nome })),
    })),
  };
}

