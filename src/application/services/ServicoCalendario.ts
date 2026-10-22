import {
  EventoDeCalendario,
  dataLocalEm,
  diasEntre,
  ehDataLocalValida,
  selecionarParaFeed,
  somarDias,
  JANELA_DO_FEED,
} from '../../domain/entities/EventoDeCalendario.js';
import type {
  EstadoDoEvento,
  MudancasNoEvento,
  TipoDeEvento,
} from '../../domain/entities/EventoDeCalendario.js';
import { detectarEventosNoAndamento } from '../../domain/entities/deteccaoDeEventos.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type { Processo } from '../../domain/entities/Processo.js';
import {
  AssinaturaInativaError,
  EventoDeCalendarioInvalidoError,
  EventoDeCalendarioNaoEncontradoError,
  FeedDoCalendarioAusenteError,
  FeedDoCalendarioNaoEncontradoError,
  PlanoDesconhecidoError,
  RecursoNaoIncluidoNoPlanoError,
} from '../../domain/errors/index.js';
import type { TokensDeSessao } from '../../domain/ports/Criptografia.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import { SEM_LEMBRETES } from '../../domain/ports/RepositorioDeEventos.js';
import type {
  FeedDoCalendario,
  LembretesDoFeed,
  MudancasNoFeed,
  RepositorioDeEventos,
} from '../../domain/ports/RepositorioDeEventos.js';
import type { ServicoAssinaturas } from './ServicoAssinaturas.js';

/** Intervalo máximo de uma consulta da tela. */
export const INTERVALO_MAXIMO_DIAS = 400;

/** Quanto do histórico a detecção relê: na ingestão e no retroativo. */
export const DIAS_RELIDOS = 180;

export interface OpcoesServicoCalendario {
  readonly eventos: RepositorioDeEventos;
  /**
   * O repositório CRU das pastas (sem o decorador de ingestão): o calendário
   * só LÊ dele — o processo de um evento manual e os andamentos guardados do
   * retroativo.
   */
  readonly acompanhamentos: RepositorioAcompanhamentos;
  /** Mesmo gerador da sessão: 32 bytes aleatórios, SHA-256 no banco. */
  readonly tokens: TokensDeSessao;
  readonly logger: Logger;
  /** Sem ele (servidor sem banco de contas), o feed não confere plano. */
  readonly assinaturas?: ServicoAssinaturas;
  readonly gerarId: () => string;
  readonly agora?: () => Date;
}

export interface NovoEventoManual {
  readonly numeroProcesso: string;
  readonly tipo: TipoDeEvento;
  readonly titulo: string;
  readonly dataLocal: string;
  readonly horaLocal?: string;
  readonly duracaoMin?: number;
  readonly observacao?: string;
  /** Prazo calculado pelo sistema a partir de ato do Diário (v0.39.0). */
  readonly calculado?: boolean;
}

export interface ResultadoIngestao {
  readonly sugeridos: number;
  readonly marcadosParaRevisao: number;
}

/**
 * O calendário do workspace: agenda, detecção nos andamentos e feed ICS.
 *
 * **Nenhuma chamada a tribunal sai daqui.** A detecção lê o que a
 * sincronização JÁ gravou; não há porta de fonte externa entre as
 * dependências deste serviço, e há teste que falha se aparecer.
 */
export class ServicoCalendario {
  private readonly eventos: RepositorioDeEventos;
  private readonly acompanhamentos: RepositorioAcompanhamentos;
  private readonly tokens: TokensDeSessao;
  private readonly log: Logger;
  private readonly assinaturas: ServicoAssinaturas | undefined;
  private readonly gerarId: () => string;
  private readonly agora: () => Date;

  constructor(opcoes: OpcoesServicoCalendario) {
    this.eventos = opcoes.eventos;
    this.acompanhamentos = opcoes.acompanhamentos;
    this.tokens = opcoes.tokens;
    this.log = opcoes.logger.child({ servico: 'calendario' });
    this.assinaturas = opcoes.assinaturas;
    this.gerarId = opcoes.gerarId;
    this.agora = opcoes.agora ?? ((): Date => new Date());
  }

  // -------------------------------------------------------------------------
  // Agenda
  // -------------------------------------------------------------------------

  /**
   * Eventos do intervalo, com o total SEM o filtro de estado ao lado — a tela
   * que esconde linha diz quantas escondeu.
   */
  async listar(
    workspace: string,
    filtro: {
      readonly de: string;
      readonly ate: string;
      readonly estados?: readonly EstadoDoEvento[];
    },
  ): Promise<{ eventos: EventoDeCalendario[]; totalNoIntervalo: number }> {
    if (!ehDataLocalValida(filtro.de) || !ehDataLocalValida(filtro.ate)) {
      throw new EventoDeCalendarioInvalidoError(
        'Informe "de" e "ate" como datas AAAA-MM-DD.',
      );
    }
    const dias = diasEntre(filtro.de, filtro.ate);
    if (dias < 0) {
      throw new EventoDeCalendarioInvalidoError('"ate" não pode ser anterior a "de".');
    }
    if (dias > INTERVALO_MAXIMO_DIAS) {
      throw new EventoDeCalendarioInvalidoError(
        `O intervalo pode ter no máximo ${INTERVALO_MAXIMO_DIAS} dias.`,
      );
    }
    const [eventos, totalNoIntervalo] = await Promise.all([
      this.eventos.listar(workspace, {
        de: filtro.de,
        ate: filtro.ate,
        ...(filtro.estados ? { estados: filtro.estados } : {}),
      }),
      this.eventos.contar(workspace, filtro.de, filtro.ate),
    ]);
    return { eventos, totalNoIntervalo };
  }

  /**
   * Evento criado pelo advogado. O processo precisa estar na carteira: é de
   * lá que saem o tribunal e o sigilo — e o sigilo decide o que o feed mostra.
   */
  async criarManual(
    workspace: string,
    dados: NovoEventoManual,
  ): Promise<EventoDeCalendario> {
    const numero = NumeroCNJ.criar(dados.numeroProcesso);
    const pasta = await this.acompanhamentos.buscar(workspace, numero.digitos);
    if (!pasta) {
      throw new EventoDeCalendarioInvalidoError(
        'O processo precisa estar na sua carteira para receber um evento.',
      );
    }
    const evento = EventoDeCalendario.manual({
      id: this.gerarId(),
      workspace,
      numeroProcesso: numero.digitos,
      tribunal: pasta.processo?.tribunal ?? numero.siglaTribunal ?? '',
      segredoJustica: pasta.processo?.segredoJustica ?? false,
      tipo: dados.tipo,
      titulo: dados.titulo,
      dataLocal: dados.dataLocal,
      ...(dados.horaLocal !== undefined ? { horaLocal: dados.horaLocal } : {}),
      ...(dados.duracaoMin !== undefined ? { duracaoMin: dados.duracaoMin } : {}),
      ...(dados.observacao !== undefined ? { observacao: dados.observacao } : {}),
      ...(dados.calculado === true ? { calculado: true } : {}),
      agora: this.agora(),
    });
    await this.eventos.salvar(evento);
    return evento;
  }

  /**
   * Edita e/ou confirma. Confirmar é mudar o estado para `confirmado`; os dois
   * no mesmo pedido são um passo só para quem corrige a hora de uma sugestão
   * antes de aceitá-la.
   */
  async alterar(
    workspace: string,
    id: string,
    mudancas: MudancasNoEvento,
    opcoes: { readonly confirmar?: boolean } = {},
  ): Promise<EventoDeCalendario> {
    const atual = await this.exigirEvento(workspace, id);
    const agora = this.agora();
    let novo = temMudanca(mudancas) ? atual.editar(mudancas, agora) : atual;
    if (opcoes.confirmar) novo = novo.confirmar(agora);
    if (novo !== atual) await this.eventos.salvar(novo);
    return novo;
  }

  async descartar(workspace: string, id: string): Promise<EventoDeCalendario> {
    const atual = await this.exigirEvento(workspace, id);
    const novo = atual.descartar(this.agora());
    if (novo !== atual) await this.eventos.salvar(novo);
    return novo;
  }

  private async exigirEvento(workspace: string, id: string): Promise<EventoDeCalendario> {
    const evento = await this.eventos.buscar(workspace, id);
    if (!evento) throw new EventoDeCalendarioNaoEncontradoError(id);
    return evento;
  }

  // -------------------------------------------------------------------------
  // Feed
  // -------------------------------------------------------------------------

  /**
   * Cria o feed, ou regenera: o anterior morre na mesma transação. O token em
   * claro sai daqui UMA vez e não é guardado em lugar nenhum.
   */
  async criarFeed(
    workspace: string,
    incluiSugeridos: boolean,
    lembretes: LembretesDoFeed = SEM_LEMBRETES,
  ): Promise<{ readonly token: string; readonly feed: FeedDoCalendario }> {
    const token = this.tokens.gerar();
    const feed: FeedDoCalendario = {
      id: this.gerarId(),
      workspace,
      tokenHash: this.tokens.hash(token),
      incluiSugeridos,
      lembretes,
      revisaoLembretes: 0,
      criadoEm: this.agora(),
    };
    await this.eventos.substituirFeed(feed);
    this.log.info('feed do calendário criado', { workspace, incluiSugeridos });
    return { token, feed };
  }

  async feed(workspace: string): Promise<FeedDoCalendario | undefined> {
    return this.eventos.feedAtivo(workspace);
  }

  /**
   * Muda as opções do feed que já existe (sugeridos e lembretes), SEM trocar o
   * token: regenerar obrigaria o advogado a assinar de novo em cada aparelho
   * só para mudar uma opção.
   *
   * @throws {FeedDoCalendarioAusenteError} quando não há feed vigente.
   */
  async alterarFeed(
    workspace: string,
    mudancas: MudancasNoFeed,
  ): Promise<FeedDoCalendario> {
    const feed = await this.eventos.alterarFeed(workspace, mudancas, this.agora());
    if (!feed) throw new FeedDoCalendarioAusenteError();
    this.log.info('feed do calendário alterado', {
      workspace,
      incluiSugeridos: feed.incluiSugeridos,
      lembretes: feed.lembretes,
    });
    return feed;
  }

  async revogarFeed(workspace: string): Promise<boolean> {
    const revogado = await this.eventos.revogarFeed(workspace, this.agora());
    if (revogado) this.log.info('feed do calendário revogado', { workspace });
    return revogado;
  }

  /**
   * Os eventos que o feed publica para este token.
   *
   * Token desconhecido, revogado, assinatura bloqueada, plano sem o recurso:
   * todos viram o MESMO `FeedDoCalendarioNaoEncontradoError`. A URL do feed
   * fica anos dentro do aplicativo de calendário de alguém, e qualquer
   * diferença entre as respostas ensinaria a quem a achou se ela já valeu.
   */
  async eventosDoFeed(token: string): Promise<{
    readonly eventos: EventoDeCalendario[];
    readonly agora: Date;
    readonly feed: FeedDoCalendario;
  }> {
    const hash = this.tokens.hash(token);
    const feed = await this.eventos.feedPorHash(hash);
    // A busca já foi pelo hash; a comparação em tempo constante é a segunda
    // trava, para que nenhuma mudança futura na consulta (um LIKE, um prefixo)
    // passe a aceitar token parecido sem ninguém notar.
    if (!feed || !iguaisEmTempoConstante(feed.tokenHash, hash) || feed.revogadoEm) {
      throw new FeedDoCalendarioNaoEncontradoError();
    }
    try {
      await this.assinaturas?.exigir(feed.workspace, 'calendario');
    } catch (erro) {
      if (
        erro instanceof AssinaturaInativaError ||
        erro instanceof RecursoNaoIncluidoNoPlanoError ||
        erro instanceof PlanoDesconhecidoError
      ) {
        throw new FeedDoCalendarioNaoEncontradoError();
      }
      throw erro;
    }

    const agora = this.agora();
    const hoje = dataLocalEm(agora);
    const todos = await this.eventos.listar(feed.workspace, {
      de: somarDias(hoje, -JANELA_DO_FEED.diasAtras),
      ate: somarDias(hoje, JANELA_DO_FEED.diasAFrente),
    });
    return {
      eventos: selecionarParaFeed(todos, {
        agora,
        incluiSugeridos: feed.incluiSugeridos,
      }),
      agora,
      feed,
    };
  }

  // -------------------------------------------------------------------------
  // Detecção
  // -------------------------------------------------------------------------

  /**
   * Relê os andamentos dos últimos 180 dias de um processo já gravado.
   *
   * Idempotente por construção: a sugestão repetida bate no índice único da
   * chave de detecção, e a marca de revisão só acende para andamento de
   * mudança mais novo que o último considerado. Por isso a ingestão pode
   * reler a janela inteira a cada sincronização, em vez de só as novidades —
   * o que cobre também a primeira sincronização, que não gera novidade.
   */
  async processarProcesso(
    workspace: string,
    processo: Processo,
  ): Promise<ResultadoIngestao> {
    const agora = this.agora();
    const hoje = dataLocalEm(agora);
    const desde = agora.getTime() - DIAS_RELIDOS * 86_400_000;
    const numero = processo.numero.digitos;
    const nomesProtegidos = processo.partes.flatMap((p) => [
      p.nome,
      ...p.advogados.map((a) => a.nome),
    ]);

    const andamentos = processo.movimentacoes
      .filter((m) => m.data.getTime() >= desde)
      .slice()
      .sort((a, b) => a.data.getTime() - b.data.getTime());

    let sugeridos = 0;
    let marcados = 0;
    for (const andamento of andamentos) {
      const r = detectarEventosNoAndamento(andamento, { hoje, nomesProtegidos });
      for (const sugestao of r.sugestoes) {
        const evento = EventoDeCalendario.sugerido({
          id: this.gerarId(),
          workspace,
          numeroProcesso: numero,
          tribunal: processo.tribunal,
          segredoJustica: processo.segredoJustica,
          sugestao,
          agora,
        });
        if (await this.eventos.inserirSeNovo(evento)) sugeridos++;
      }
      if (r.mudanca && r.mudanca.tipos.length > 0) {
        const tipos = new Set(r.mudanca.tipos);
        for (const e of await this.eventos.detectadosDoProcesso(workspace, numero)) {
          // Só o que foi lido de andamento ANTERIOR ao que sugere a mudança.
          const anterior =
            e.procedencia !== undefined &&
            e.procedencia.dataDoAndamento.getTime() < andamento.data.getTime();
          if (!anterior || !tipos.has(e.tipo)) continue;
          const marcado = e.marcarParaRevisao(andamento.data, agora);
          if (marcado !== e) {
            await this.eventos.salvar(marcado);
            marcados++;
          }
        }
      }
    }

    await this.eventos.atualizarSegredo(workspace, numero, processo.segredoJustica);
    return { sugeridos, marcadosParaRevisao: marcados };
  }

  /**
   * O preenchimento retroativo: relê o que já está gravado nas pastas de quem
   * ainda não passou por ele. Sem rede — só o banco.
   *
   * Uma falha num processo não impede os outros; uma falha no workspace
   * inteiro deixa-o sem a marca, e a próxima volta tenta de novo.
   */
  async preencherRetroativo(
    limiteDeWorkspaces = 20,
  ): Promise<{ workspaces: number; sugeridos: number }> {
    let sugeridos = 0;
    const pendentes = await this.eventos.workspacesSemRetroativo(limiteDeWorkspaces);
    for (const workspace of pendentes) {
      try {
        for (const pasta of await this.acompanhamentos.listar(workspace)) {
          if (!pasta.processo) continue;
          try {
            sugeridos += (await this.processarProcesso(workspace, pasta.processo))
              .sugeridos;
          } catch (erro) {
            this.log.warn('retroativo do calendário falhou num processo', {
              workspace,
              numero: pasta.numero,
              erro: erro instanceof Error ? erro.message : String(erro),
            });
          }
        }
        await this.eventos.marcarRetroativo(workspace, this.agora());
      } catch (erro) {
        this.log.warn('retroativo do calendário falhou', {
          workspace,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      }
    }
    if (pendentes.length > 0) {
      this.log.info('retroativo do calendário', {
        workspaces: pendentes.length,
        sugeridos,
      });
    }
    return { workspaces: pendentes.length, sugeridos };
  }
}

function temMudanca(m: MudancasNoEvento): boolean {
  return Object.values(m).some((v) => v !== undefined);
}

/**
 * Comparação que gasta o mesmo tempo acerte ou erre. Sem `node:crypto` de
 * propósito: `application/` não importa biblioteca de I/O, e para dois hex de
 * tamanho fixo o laço basta.
 */
export function iguaisEmTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}
