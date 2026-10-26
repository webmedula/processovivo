import { atosQuePedemProvidencia } from '../../domain/entities/estadoDaPasta.js';
import type {
  AvaliacaoDaAnalise,
  MotivoDaAvaliacao,
} from '../../domain/entities/AnaliseDoAto.js';
import type {
  ContagensDoResumo,
  ResultadoDoResumo,
  ResumoDoProcesso,
} from '../../domain/entities/ResumoDoProcesso.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import {
  versaoEfetiva,
  type InstrucaoDoExperimento,
} from '../../domain/entities/InstrucoesDeIa.js';
import {
  SEM_INSTRUCOES,
  type InstrucoesDaFuncao,
} from '../../domain/ports/InstrucoesDeIa.js';
import type { Processo } from '../../domain/entities/Processo.js';
import type { PontoDeAtencao } from '../../domain/entities/vocabularioDaAnalise.js';
import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import type {
  ItemDoResumo,
  PontoDoResumo,
} from '../../domain/entities/vocabularioDoResumo.js';
import {
  AcompanhamentoNaoEncontradoError,
  AnaliseNaoEncontradaError,
  DomainError,
  EntradaNaoAnalisavelError,
  ProviderIndisponivelError,
} from '../../domain/errors/index.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioDaPasta } from '../../domain/ports/RepositorioDaPasta.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import type { RepositorioResumos } from '../../domain/ports/RepositorioResumos.js';
import type {
  ResumidorDeProcesso,
  RespostaDoResumidor,
} from '../../domain/ports/ResumidorDeProcesso.js';
import {
  prepararEntradaDoResumo,
  VERSAO_PROMPT_DO_RESUMO,
  type AtoEnviado,
  type EntradaDoResumo,
} from '../politicas/entradaDoResumo.js';
import {
  CONTROLE_SEM_PAINEL,
  type ControleDaIa,
} from '../../domain/entities/ControleDaIa.js';
import {
  SEM_REGISTRO_DE_OCORRENCIAS,
  type RegistroDeOcorrenciasDeIa,
} from '../../domain/ports/PainelDeIa.js';
import {
  contagensDoResumo,
  motivoDaFalhaDaChamada,
  registrarContagens,
} from '../politicas/ocorrenciasDeIa.js';
import type { LimiteDeAnalises } from '../politicas/limiteDeAnalises.js';
import type { PessoasParaRedigir } from '../politicas/redigirParaIA.js';
import { diaLocal } from '../politicas/mesmoAtoParaOResumo.js';
import {
  selecionarAtosParaResumo,
  type MotivoDeNaoLido,
  type SelecaoDoResumo,
} from '../politicas/selecionarAtosParaResumo.js';
import {
  verificarResumo,
  type DescartesDoResumo,
  type ResultadoDaVerificacaoDoResumo,
} from '../politicas/verificarResumo.js';

/**
 * Resumo de UM processo por IA, a pedido de um clique (v0.40.0, Etapa 2 da "IA como
 * secretária"). Mesmo esqueleto da análise de ato, e as mesmas regras:
 *
 * - o texto vem do retrato da PRÓPRIA conta, nunca do cliente; nada de peça, PDF ou consulta
 *   ao tribunal;
 * - plano IA sem exceção (a mesma regra da análise), segredo de justiça e processo sem nenhum
 *   ato com texto utilizável encerram ANTES de qualquer chamada ao adaptador;
 * - UM redator para o pedido inteiro: o mesmo nome ou número vira o mesmo marcador em todos os
 *   atos, e a restauração serve ao pedido inteiro;
 * - o que volta só chega à tela depois de `verificarResumo`, item a item;
 * - falha do modelo NÃO vira exceção para a tela: devolve `{ estado: 'erro' }`;
 * - **o resumo da IA e o bloco "Pede providência" do sistema são coisas separadas**: a resposta
 *   só diz quantos atos o sistema marca como pedem providência e a IA não citou;
 * - não há "reabrir o último resumo": os marcadores estruturais dependem da ordem de aparição
 *   daquele pedido, e restaurar depois, com o retrato mudado, poderia trocar o valor errado.
 *
 * Apoio à leitura: nada aqui altera "pede providência", "não lida", ordem, contagem, calendário
 * ou qualquer outro dado do retrato, e nada é criado além da linha de auditoria do próprio resumo.
 */

export interface ItemDoResumoParaATela {
  readonly texto: string;
  readonly trecho: string;
  /** O ato de origem: data e tipo vêm do RETRATO, nunca do modelo. */
  readonly ato: {
    readonly chaveDoAto: string;
    readonly data: Date;
    readonly rotulo: string;
    readonly tipoDaComunicacao: string | null;
  };
}

/** Um ato como a tela o mostra na faixa do sistema: data e rótulo vêm do RETRATO. */
export interface AtoParaATela {
  readonly data: Date;
  readonly rotulo: string;
  readonly tipoDaComunicacao: string | null;
}

/**
 * O que o SISTEMA sabe e o modelo não (v0.54.0): qual é o ato mais recente, se o texto dele foi
 * lido e quais providências marcadas pelo sistema ficaram sem leitura. Escrito aqui, nunca pelo
 * modelo — é a faixa que impede o resumo de apresentar um ato antigo como a situação atual.
 */
export interface AtualidadeDoResumo {
  readonly maisRecente: (AtoParaATela & { readonly lido: boolean }) | null;
  /** As mais recentes primeiro; no máximo `LISTADAS_NA_FAIXA`. */
  readonly providenciasNaoLidas: readonly (AtoParaATela & {
    readonly motivo: MotivoDeNaoLido;
  })[];
  readonly providenciasNaoLidasTotal: number;
  /** A Pasta digital (já gravada, sem consulta nova) lista ato mais novo que o retrato. */
  readonly tribunalMaisNovo: {
    readonly data: Date;
    readonly rotulo: string;
    readonly listadaEm: Date;
  } | null;
}

const LISTADAS_NA_FAIXA = 8;

export const SEM_ATUALIDADE: AtualidadeDoResumo = Object.freeze({
  maisRecente: null,
  providenciasNaoLidas: [],
  providenciasNaoLidasTotal: 0,
  tribunalMaisNovo: null,
});

export interface PontoParaATela {
  readonly codigo: PontoDeAtencao;
  readonly ato: AtoParaATela | null;
}

export interface ResumoParaATela {
  readonly estado: 'verificado' | 'nao_verificado';
  readonly id: string;
  readonly situacao: readonly ItemDoResumoParaATela[];
  readonly pendencias: readonly ItemDoResumoParaATela[];
  readonly pontosDeAtencao: readonly PontoDeAtencao[];
  /** Os mesmos pontos, com o ato que os motivou (data e rótulo do retrato), quando há. */
  readonly pontosDoAto: readonly PontoParaATela[];
  readonly atualidade: AtualidadeDoResumo;
  readonly contagens: ContagensDoResumo;
  readonly modelo: string;
  readonly versaoPrompt: string;
  readonly provedor: string;
  readonly criadaEm: Date;
  readonly avaliacao: AvaliacaoDaAnalise | null;
}

export type RespostaDoResumo = ResumoParaATela | { readonly estado: 'erro' };

export type BracoDoExperimentoDoResumo =
  | {
      readonly rotulo: InstrucaoDoExperimento['rotulo'];
      readonly versao: number;
      readonly estado: 'erro';
    }
  | {
      readonly rotulo: InstrucaoDoExperimento['rotulo'];
      readonly versao: number;
      readonly estado: 'ok';
      readonly resumo: ResumoParaATela;
      /** Por que não foi verificado; `null` se foi. */
      readonly motivoDeNaoVerificacao: string | null;
      readonly descartes: DescartesDoResumo;
      readonly latenciaMs: number;
      readonly custoUsd: number | null;
      readonly tokensEntrada: number | null;
      readonly tokensSaida: number | null;
    };

function medidasDe(
  bruta: RespostaDoResumidor,
  latenciaMs: number,
): ResumoDoProcesso['medidas'] {
  return {
    latenciaMs,
    ...(bruta.tokensEntrada !== undefined ? { tokensEntrada: bruta.tokensEntrada } : {}),
    ...(bruta.tokensSaida !== undefined ? { tokensSaida: bruta.tokensSaida } : {}),
    ...(bruta.custoUsd !== undefined ? { custoUsd: bruta.custoUsd } : {}),
  };
}

export interface OpcoesServicoResumoDoProcesso {
  readonly repositorio: RepositorioAcompanhamentos;
  readonly resumos: RepositorioResumos;
  readonly resumidor: ResumidorDeProcesso;
  /** A MESMA regra do plano IA da análise de ato. */
  readonly exigirPlanoIa: (workspace: string) => Promise<void>;
  readonly limite: LimiteDeAnalises;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly novoId: () => string;
  /** O painel de IA do /admin (v0.58.0). Ausente = só vale o ambiente. */
  readonly controle?: ControleDaIa;
  /** Contagem de falhas e repetições, por motivo (v0.58.0). Ausente = não conta. */
  readonly ocorrencias?: RegistroDeOcorrenciasDeIa;
  /** A janela única de "pede providência" (`PENDENCIA_JANELA_DIAS`). */
  readonly janelaDePendenciaDias: number;
  /**
   * A listagem da Pasta digital que a tela já gravou (v0.54.0). SÓ LEITURA do que existe: o resumo
   * nunca consulta o tribunal; serve para avisar que o tribunal lista ato mais novo que o retrato.
   */
  readonly pasta?: Pick<RepositorioDaPasta, 'obterListagem'>;
  /** As instruções de interpretação publicadas no painel (Fase C, v0.61.0). Ausente = o prompt de sempre (+e0). */
  readonly instrucoes?: InstrucoesDaFuncao;
}

export interface PedidoDeResumoDoProcesso {
  readonly workspace: string;
  readonly numero: string;
  readonly sinal?: AbortSignal;
}

export class ServicoResumoDoProcesso {
  private readonly log: Logger;
  private readonly ocorrencias: RegistroDeOcorrenciasDeIa;

  constructor(private readonly o: OpcoesServicoResumoDoProcesso) {
    this.ocorrencias = o.ocorrencias ?? SEM_REGISTRO_DE_OCORRENCIAS;
    this.log = o.logger.child({ servico: 'resumo-do-processo' });
  }

  /** A função está ligada no painel (e o ambiente a permite, já que o serviço existe)? */
  disponivel(): boolean {
    return (this.o.controle ?? CONTROLE_SEM_PAINEL).ligada('resumo');
  }

  async resumir(pedido: PedidoDeResumoDoProcesso): Promise<RespostaDoResumo> {
    const { workspace } = pedido;
    // 0. Desligada no painel: nada além da frase fixa, antes de plano, retrato, vaga e modelo.
    if (!this.disponivel()) {
      throw new EntradaNaoAnalisavelError(
        'desligada',
        'Este recurso está indisponível no momento.',
      );
    }
    const numero = NumeroCNJ.criar(pedido.numero).digitos;

    // 1. Plano: sem ele, nada além da frase fixa. Antes de ler o retrato.
    await this.o.exigirPlanoIa(workspace);

    // 2 a 4. O retrato é DA CONTA; sigilo, providências do sistema e a seleção de atos (sem texto = para aqui).
    const { processo, selecao } = await this.lerProcessoDaConta(workspace, numero);

    // 5. Limite de uso (sem tabela). A vaga é liberada em qualquer desfecho.
    const vaga = this.o.limite.reservar(workspace);
    if ('negada' in vaga) {
      throw new EntradaNaoAnalisavelError(
        'limite_de_uso',
        'Há muitos resumos em andamento ou o limite por hora foi atingido. Tente novamente em instantes.',
      );
    }
    try {
      return await this.chamarEGuardar(pedido, numero, processo, selecao);
    } finally {
      vaga.liberar();
    }
  }

  /**
   * Os passos 2 a 4 do resumo, comuns ao clique do assinante e ao experimento do operador: o retrato é da
   * PRÓPRIA conta, e segredo de justiça e processo sem texto utilizável encerram aqui, ANTES de qualquer
   * chamada ao modelo.
   */
  private async lerProcessoDaConta(
    workspace: string,
    numero: string,
  ): Promise<{ readonly processo: Processo; readonly selecao: SelecaoDoResumo }> {
    const acompanhamento = await this.o.repositorio.buscar(workspace, numero);
    if (!acompanhamento) throw new AcompanhamentoNaoEncontradoError();
    const processo = acompanhamento.processo;
    if (!processo || processo.movimentacoes.length === 0) {
      throw new EntradaNaoAnalisavelError(
        'texto_insuficiente',
        'Este processo ainda não tem atos com texto para resumir. Leia o processo.',
      );
    }

    // 3. Segredo de justiça: o texto não sai do sistema, qualquer que seja ele.
    if (processo.segredoJustica) {
      throw new EntradaNaoAnalisavelError(
        'segredo_de_justica',
        'Processo em segredo de justiça: o resumo por IA não é feito. Leia os atos.',
      );
    }

    // 4. As providências em aberto que o SISTEMA marca (a regra e a janela do selo da carteira).
    const agora = this.o.clock.agora();
    const pendentes = atosQuePedemProvidencia(
      processo.movimentacoes,
      agora,
      this.o.janelaDePendenciaDias,
      undefined,
      acompanhamento.cumprido
        ? {
            chave: acompanhamento.cumprido.chave,
            ate: acompanhamento.cumprido.ate,
            em: acompanhamento.cumprido.em,
          }
        : undefined,
    );
    const chavesDoSistema = new Set(pendentes.map((p) => p.chave));
    const selecao = selecionarAtosParaResumo(processo.movimentacoes, chavesDoSistema);
    if (selecao.comTexto === 0) {
      throw new EntradaNaoAnalisavelError(
        'texto_insuficiente',
        'Este processo não tem atos com texto suficiente para resumir. Leia os atos.',
      );
    }
    return { processo, selecao };
  }

  /**
   * Prepara a entrada, chama o modelo e verifica a resposta item a item. É o MESMO caminho do clique do
   * assinante e do experimento do operador (`contar` liga as ocorrências do painel). Falha do modelo vira
   * `undefined`, nunca exceção.
   */
  private async chamar(
    selecao: SelecaoDoResumo,
    processo: Processo,
    instrucao: string,
    sinal: AbortSignal | undefined,
    contar: boolean,
  ): Promise<
    | {
        readonly entrada: EntradaDoResumo;
        readonly bruta: RespostaDoResumidor;
        readonly verificada: ResultadoDaVerificacaoDoResumo;
        readonly resultado: ResultadoDoResumo;
        readonly latenciaMs: number;
      }
    | undefined
  > {
    const entrada = prepararEntradaDoResumo(
      selecao,
      {
        ...(processo.classe ? { classe: processo.classe } : {}),
        tribunal: processo.tribunal,
      },
      pessoasDoProcesso(processo),
      { instrucao },
    );

    const inicio = this.o.clock.monotonico();
    let bruta: RespostaDoResumidor;
    try {
      bruta = await this.o.resumidor.resumir({
        sistema: entrada.sistema,
        usuario: entrada.usuario,
        ...(sinal ? { sinal } : {}),
        ...(contar
          ? {
              aoRepetir: () =>
                this.ocorrencias.registrar('resumo', 'repeticao_automatica'),
            }
          : {}),
      });
    } catch (erro) {
      if (contar) this.ocorrencias.registrar('resumo', motivoDaFalhaDaChamada(erro));
      // Só a CLASSE do erro e o roteamento SANEADO vão ao log: a mensagem de um roteador pode
      // ecoar o pedido (que leva texto de ato), então ela nunca é copiada.
      const r = erro instanceof ProviderIndisponivelError ? erro.roteamento : undefined;
      this.log.warn('resumo do processo não concluído', {
        causa: erro instanceof DomainError ? erro.codigo : 'erro_inesperado',
        tipo: erro instanceof Error ? erro.name : typeof erro,
        ...(r?.status !== undefined ? { statusHttp: r.status } : {}),
        ...(r?.passo !== undefined ? { passoDoRoteamento: r.passo } : {}),
      });
      return undefined;
    }
    const latenciaMs = Math.max(0, Math.round(this.o.clock.monotonico() - inicio));

    // O que o SISTEMA sabe e o modelo não: a verificação usa para barrar "situação atual" sem ter
    // lido o ato mais recente e "sem pendências" havendo providência que a IA não leu.
    const verificada = verificarResumo(bruta.resposta, entrada.atos, {
      regras: '1.2.0',
      maisRecenteNaoLido: selecao.maisRecente !== undefined && !selecao.maisRecente.lido,
      providenciaNaoLida: selecao.providenciasNaoLidas.length > 0,
      ...(selecao.maisRecente
        ? {
            maisRecente: {
              chave: selecao.maisRecente.chave,
              lido: selecao.maisRecente.lido,
            },
          }
        : {}),
    });
    if (contar) {
      registrarContagens(
        this.ocorrencias,
        'resumo',
        contagensDoResumo(
          verificada.descartes,
          verificada.estado === 'nao_verificado' ? verificada.motivo : undefined,
        ),
      );
    }
    const resultado: ResultadoDoResumo =
      verificada.estado === 'verificado'
        ? {
            estado: 'verificado',
            situacao: verificada.situacao,
            pendencias: verificada.pendencias,
            pontosDeAtencao: verificada.pontosDeAtencao,
            pontosDoAto: verificada.pontosDoAto,
          }
        : { estado: 'nao_verificado', motivo: verificada.motivo };
    return { entrada, bruta, verificada, resultado, latenciaMs };
  }

  /** As contagens que a tela e o registro mostram, a partir da seleção e do que a verificação manteve. */
  private contagensDe(
    selecao: SelecaoDoResumo,
    verificada: ResultadoDaVerificacaoDoResumo,
  ): ContagensDoResumo {
    const chavesPendentes = selecao.chavesPendentes;
    const citadas = new Set<string>(
      verificada.estado === 'verificado'
        ? [...verificada.situacao, ...verificada.pendencias].map((i) => i.chaveDoAto)
        : [],
    );
    const verificados =
      verificada.estado === 'verificado'
        ? verificada.situacao.length + verificada.pendencias.length
        : 0;
    return {
      atosNoProcesso: selecao.totalDeAtos,
      atosComTexto: selecao.comTexto,
      atosSoTitulo: selecao.soTitulo,
      foraDoResumo: selecao.foraDoResumo,
      itensDescartados: Math.max(0, verificada.itensRecebidos - verificados),
      providenciasDoSistema: chavesPendentes.size,
      providenciasNaoCitadas: [...chavesPendentes].filter((c) => !citadas.has(c)).length,
      atosMesclados: selecao.mesclados,
      providenciasNaoLidas: selecao.providenciasNaoLidas.length,
      maisRecenteLido: selecao.maisRecente?.lido ?? false,
    };
  }

  private async chamarEGuardar(
    pedido: PedidoDeResumoDoProcesso,
    numero: string,
    processo: Processo,
    selecao: SelecaoDoResumo,
  ): Promise<RespostaDoResumo> {
    // A versão e o texto vêm juntos, de UMA leitura: o que se grava é a versão do texto que foi ao modelo.
    const instrucao = (this.o.instrucoes ?? SEM_INSTRUCOES).efetiva('resumo');
    const feita = await this.chamar(
      selecao,
      processo,
      instrucao.texto,
      pedido.sinal,
      true,
    );
    if (!feita) return { estado: 'erro' };
    const { entrada, bruta, verificada, resultado, latenciaMs } = feita;
    const contagens = this.contagensDe(selecao, verificada);

    // Só CONTAGENS, por motivo: nada de texto de ato, título, número de processo, conta ou parte.
    this.log.info('resumo do processo montado', {
      versaoPrompt: versaoEfetiva(entrada.versaoPrompt, instrucao.versao),
      atosNoProcesso: selecao.totalDeAtos,
      comTexto: selecao.comTexto,
      soTitulo: selecao.soTitulo,
      foraDoResumo: selecao.foraDoResumo,
      mesclados: selecao.mesclados,
      naoLidosTeorIndisponivel: selecao.motivosDosNaoLidos.teorIndisponivel,
      naoLidosSemTexto: selecao.motivosDosNaoLidos.semTexto,
      naoLidosAbaixoDoMinimo: selecao.motivosDosNaoLidos.abaixoDoMinimo,
      naoLidosForaDoLimite: selecao.motivosDosNaoLidos.foraDoLimite,
      providenciasNaoLidas: selecao.providenciasNaoLidas.length,
      maisRecenteLido: selecao.maisRecente?.lido ?? false,
      descartesReferencia: verificada.descartes.referencia,
      descartesCitacao: verificada.descartes.citacao,
      descartesNumero: verificada.descartes.numeroInventado,
      descartesCopia: verificada.descartes.copiaDoTrecho,
      descartesForma: verificada.descartes.forma,
      descartesAtualidade: verificada.descartes.atualidade,
      descartesPendenciaNegada: verificada.descartes.pendenciaNegada,
      descartesExpressaoProibida: verificada.descartes.expressaoProibida,
    });

    const resumo: ResumoDoProcesso = {
      id: this.o.novoId(),
      workspace: pedido.workspace,
      numero,
      resultado,
      atosEnviados: selecao.atos.map((a) => ({
        chaveDoAto: a.chave,
        data: a.ato.data,
        comTexto: a.limiteDeCaracteres > 0,
      })),
      contagens,
      procedencia: {
        modelo: bruta.modelo,
        versaoPrompt: versaoEfetiva(VERSAO_PROMPT_DO_RESUMO, instrucao.versao),
        provedor: bruta.provedor,
        criadaEm: this.o.clock.agora(),
      },
      medidas: medidasDe(bruta, latenciaMs),
    };
    await this.o.resumos.salvar(resumo);

    const atualidade = await this.atualidadeDe(pedido.workspace, numero, selecao);
    return resumoParaATela(resumo, entrada.atos, (t) => entrada.restaurar(t), atualidade);
  }

  /**
   * EXPERIMENTO do operador (Fase C, v0.61.0): o MESMO caminho de produção (seleção, redação, modelo com
   * ZDR, verificação item a item, segredo de justiça) sobre UM processo da conta do operador, uma vez para
   * cada instrução. **Não grava nada**, não consome o teto dos assinantes e não conta ocorrência.
   */
  async experimentar(pedido: {
    readonly workspace: string;
    readonly numero: string;
    readonly instrucoes: readonly InstrucaoDoExperimento[];
    readonly sinal?: AbortSignal;
  }): Promise<readonly BracoDoExperimentoDoResumo[]> {
    const numero = NumeroCNJ.criar(pedido.numero).digitos;
    const { processo, selecao } = await this.lerProcessoDaConta(pedido.workspace, numero);
    const atualidade = await this.atualidadeDe(pedido.workspace, numero, selecao);
    return Promise.all(
      pedido.instrucoes.map(async (i): Promise<BracoDoExperimentoDoResumo> => {
        const feita = await this.chamar(selecao, processo, i.texto, pedido.sinal, false);
        if (!feita) return { rotulo: i.rotulo, versao: i.versao, estado: 'erro' };
        const { entrada, bruta, verificada, resultado, latenciaMs } = feita;
        const resumo: ResumoDoProcesso = {
          id: 'experimento',
          workspace: pedido.workspace,
          numero,
          resultado,
          atosEnviados: selecao.atos.map((a) => ({
            chaveDoAto: a.chave,
            data: a.ato.data,
            comTexto: a.limiteDeCaracteres > 0,
          })),
          contagens: this.contagensDe(selecao, verificada),
          procedencia: {
            modelo: bruta.modelo,
            versaoPrompt: versaoEfetiva(VERSAO_PROMPT_DO_RESUMO, i.versao),
            provedor: bruta.provedor,
            criadaEm: this.o.clock.agora(),
          },
          medidas: medidasDe(bruta, latenciaMs),
        };
        return {
          rotulo: i.rotulo,
          versao: i.versao,
          estado: 'ok',
          resumo: resumoParaATela(
            resumo,
            entrada.atos,
            (t) => entrada.restaurar(t),
            atualidade,
          ),
          motivoDeNaoVerificacao:
            resultado.estado === 'nao_verificado' ? resultado.motivo : null,
          descartes: verificada.descartes,
          latenciaMs,
          custoUsd: bruta.custoUsd ?? null,
          tokensEntrada: bruta.tokensEntrada ?? null,
          tokensSaida: bruta.tokensSaida ?? null,
        };
      }),
    );
  }

  /** A faixa do sistema (v0.54.0): ato mais recente, providências sem leitura e o aviso da Pasta digital. */
  private async atualidadeDe(
    workspace: string,
    numero: string,
    selecao: SelecaoDoResumo,
  ): Promise<AtualidadeDoResumo> {
    const doAto = (a: Movimentacao): AtoParaATela => ({
      data: a.data,
      rotulo: a.titulo,
      tipoDaComunicacao: a.tipoComunicacao?.trim() || null,
    });
    let tribunalMaisNovo: AtualidadeDoResumo['tribunalMaisNovo'] = null;
    const maisRecente = selecao.maisRecente;
    if (this.o.pasta && maisRecente) {
      try {
        const listagem = await this.o.pasta.obterListagem(workspace, numero);
        const novo = [...(listagem?.atos ?? [])].sort(
          (a, b) => b.data.getTime() - a.data.getTime(),
        )[0];
        // Comparação por DIA: a Pasta e as fontes públicas não dão a mesma hora ao mesmo ato.
        if (
          listagem &&
          !listagem.processoSigiloso &&
          novo &&
          diaLocal(novo.data) > diaLocal(maisRecente.ato.data)
        ) {
          tribunalMaisNovo = {
            data: novo.data,
            rotulo: novo.descricao,
            listadaEm: listagem.listadaEm,
          };
        }
      } catch {
        // O aviso é um extra: a falha em ler a Pasta nunca derruba o resumo (e não vai ao log com dado).
      }
    }
    return {
      maisRecente: maisRecente
        ? { ...doAto(maisRecente.ato), lido: maisRecente.lido }
        : null,
      providenciasNaoLidas: selecao.providenciasNaoLidas
        .slice(0, LISTADAS_NA_FAIXA)
        .map((p) => ({ ...doAto(p.ato), motivo: p.motivo })),
      providenciasNaoLidasTotal: selecao.providenciasNaoLidas.length,
      tribunalMaisNovo,
    };
  }

  /** Só o dono da conta avalia; pode corrigir a avaliação anterior. 404 igual para "não existe" e "é de outra". */
  async avaliar(
    workspace: string,
    id: string,
    avaliacao: AvaliacaoDaAnalise,
    motivo?: MotivoDaAvaliacao,
  ): Promise<void> {
    const ok = await this.o.resumos.avaliar(workspace, id, avaliacao, motivo);
    if (!ok) throw new AnaliseNaoEncontradaError();
  }
}

/**
 * Do que está gravado (com marcadores) ao que a tela recebe (marcadores trocados pelos valores
 * da conta). A data e o rótulo do ato saem do que NÓS enviamos, nunca do que o modelo disse.
 */
export function resumoParaATela(
  resumo: ResumoDoProcesso,
  atos: ReadonlyMap<string, AtoEnviado>,
  restaurar: (texto: string) => string,
  atualidade: AtualidadeDoResumo = SEM_ATUALIDADE,
): ResumoParaATela {
  const porChave = new Map<string, AtoEnviado>();
  for (const a of atos.values()) porChave.set(a.chave, a);
  const item = (i: ItemDoResumo): ItemDoResumoParaATela => {
    const ato = porChave.get(i.chaveDoAto);
    return {
      texto: restaurar(i.texto),
      trecho: restaurar(i.trecho),
      ato: {
        chaveDoAto: i.chaveDoAto,
        data: ato?.data ?? new Date(0),
        rotulo: ato?.titulo ?? '',
        tipoDaComunicacao: ato?.tipoComunicacao ?? null,
      },
    };
  };
  const r = resumo.resultado;
  const pontoParaATela = (p: PontoDoResumo): PontoParaATela => {
    const ato = p.chaveDoAto ? porChave.get(p.chaveDoAto) : undefined;
    return {
      codigo: p.codigo,
      ato: ato
        ? { data: ato.data, rotulo: ato.titulo, tipoDaComunicacao: ato.tipoComunicacao }
        : null,
    };
  };
  const base = {
    atualidade,
    id: resumo.id,
    contagens: resumo.contagens,
    modelo: resumo.procedencia.modelo,
    versaoPrompt: resumo.procedencia.versaoPrompt,
    provedor: resumo.procedencia.provedor,
    criadaEm: resumo.procedencia.criadaEm,
    avaliacao: resumo.avaliacao ?? null,
  };
  if (r.estado === 'nao_verificado') {
    return {
      ...base,
      estado: 'nao_verificado',
      situacao: [],
      pendencias: [],
      pontosDeAtencao: [],
      pontosDoAto: [],
    };
  }
  return {
    ...base,
    estado: 'verificado',
    situacao: r.situacao.map(item),
    pendencias: r.pendencias.map(item),
    pontosDeAtencao: r.pontosDeAtencao,
    pontosDoAto: (r.pontosDoAto ?? r.pontosDeAtencao.map((codigo) => ({ codigo }))).map(
      pontoParaATela,
    ),
  };
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
