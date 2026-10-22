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
import type { Processo } from '../../domain/entities/Processo.js';
import type { PontoDeAtencao } from '../../domain/entities/vocabularioDaAnalise.js';
import type { ItemDoResumo } from '../../domain/entities/vocabularioDoResumo.js';
import {
  AcompanhamentoNaoEncontradoError,
  AnaliseNaoEncontradaError,
  DomainError,
  EntradaNaoAnalisavelError,
  ProviderIndisponivelError,
} from '../../domain/errors/index.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import type { RepositorioResumos } from '../../domain/ports/RepositorioResumos.js';
import type { ResumidorDeProcesso } from '../../domain/ports/ResumidorDeProcesso.js';
import {
  prepararEntradaDoResumo,
  VERSAO_PROMPT_DO_RESUMO,
  type AtoEnviado,
} from '../politicas/entradaDoResumo.js';
import type { LimiteDeAnalises } from '../politicas/limiteDeAnalises.js';
import type { PessoasParaRedigir } from '../politicas/redigirParaIA.js';
import { selecionarAtosParaResumo } from '../politicas/selecionarAtosParaResumo.js';
import { verificarResumo } from '../politicas/verificarResumo.js';

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

export interface ResumoParaATela {
  readonly estado: 'verificado' | 'nao_verificado';
  readonly id: string;
  readonly situacao: readonly ItemDoResumoParaATela[];
  readonly pendencias: readonly ItemDoResumoParaATela[];
  readonly pontosDeAtencao: readonly PontoDeAtencao[];
  readonly contagens: ContagensDoResumo;
  readonly modelo: string;
  readonly versaoPrompt: string;
  readonly provedor: string;
  readonly criadaEm: Date;
  readonly avaliacao: AvaliacaoDaAnalise | null;
}

export type RespostaDoResumo = ResumoParaATela | { readonly estado: 'erro' };

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
  /** A janela única de "pede providência" (`PENDENCIA_JANELA_DIAS`). */
  readonly janelaDePendenciaDias: number;
}

export interface PedidoDeResumoDoProcesso {
  readonly workspace: string;
  readonly numero: string;
  readonly sinal?: AbortSignal;
}

export class ServicoResumoDoProcesso {
  private readonly log: Logger;

  constructor(private readonly o: OpcoesServicoResumoDoProcesso) {
    this.log = o.logger.child({ servico: 'resumo-do-processo' });
  }

  async resumir(pedido: PedidoDeResumoDoProcesso): Promise<RespostaDoResumo> {
    const { workspace } = pedido;
    const numero = NumeroCNJ.criar(pedido.numero).digitos;

    // 1. Plano: sem ele, nada além da frase fixa. Antes de ler o retrato.
    await this.o.exigirPlanoIa(workspace);

    // 2. O retrato é DA CONTA.
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
    const chavesPendentes = new Set(pendentes.map((p) => p.chave));
    const selecao = selecionarAtosParaResumo(processo.movimentacoes, chavesPendentes);
    if (selecao.comTexto === 0) {
      throw new EntradaNaoAnalisavelError(
        'texto_insuficiente',
        'Este processo não tem atos com texto suficiente para resumir. Leia os atos.',
      );
    }

    // 5. Limite de uso (sem tabela). A vaga é liberada em qualquer desfecho.
    const vaga = this.o.limite.reservar(workspace);
    if ('negada' in vaga) {
      throw new EntradaNaoAnalisavelError(
        'limite_de_uso',
        'Há muitos resumos em andamento ou o limite por hora foi atingido. Tente novamente em instantes.',
      );
    }
    try {
      return await this.chamarEGuardar(
        pedido,
        numero,
        processo,
        selecao,
        chavesPendentes,
        pessoasDoProcesso(processo),
      );
    } finally {
      vaga.liberar();
    }
  }

  private async chamarEGuardar(
    pedido: PedidoDeResumoDoProcesso,
    numero: string,
    processo: Processo,
    selecao: ReturnType<typeof selecionarAtosParaResumo>,
    chavesPendentes: ReadonlySet<string>,
    pessoas: PessoasParaRedigir,
  ): Promise<RespostaDoResumo> {
    const entrada = prepararEntradaDoResumo(
      selecao,
      {
        ...(processo.classe ? { classe: processo.classe } : {}),
        tribunal: processo.tribunal,
      },
      pessoas,
    );

    const inicio = this.o.clock.monotonico();
    let bruta;
    try {
      bruta = await this.o.resumidor.resumir({
        sistema: entrada.sistema,
        usuario: entrada.usuario,
        ...(pedido.sinal ? { sinal: pedido.sinal } : {}),
      });
    } catch (erro) {
      // Só a CLASSE do erro e o roteamento SANEADO vão ao log: a mensagem de um roteador pode
      // ecoar o pedido (que leva texto de ato), então ela nunca é copiada.
      const r = erro instanceof ProviderIndisponivelError ? erro.roteamento : undefined;
      this.log.warn('resumo do processo não concluído', {
        causa: erro instanceof DomainError ? erro.codigo : 'erro_inesperado',
        tipo: erro instanceof Error ? erro.name : typeof erro,
        ...(r?.status !== undefined ? { statusHttp: r.status } : {}),
        ...(r?.passo !== undefined ? { passoDoRoteamento: r.passo } : {}),
      });
      return { estado: 'erro' };
    }
    const latenciaMs = Math.max(0, Math.round(this.o.clock.monotonico() - inicio));

    const verificada = verificarResumo(bruta.resposta, entrada.atos);
    const resultado: ResultadoDoResumo =
      verificada.estado === 'verificado'
        ? {
            estado: 'verificado',
            situacao: verificada.situacao,
            pendencias: verificada.pendencias,
            pontosDeAtencao: verificada.pontosDeAtencao,
          }
        : { estado: 'nao_verificado', motivo: verificada.motivo };

    const citadas = new Set<string>(
      verificada.estado === 'verificado'
        ? [...verificada.situacao, ...verificada.pendencias].map((i) => i.chaveDoAto)
        : [],
    );
    const verificados =
      verificada.estado === 'verificado'
        ? verificada.situacao.length + verificada.pendencias.length
        : 0;
    const contagens: ContagensDoResumo = {
      atosNoProcesso: selecao.totalDeAtos,
      atosComTexto: selecao.comTexto,
      atosSoTitulo: selecao.soTitulo,
      foraDoResumo: selecao.foraDoResumo,
      itensDescartados: Math.max(0, verificada.itensRecebidos - verificados),
      providenciasDoSistema: chavesPendentes.size,
      providenciasNaoCitadas: [...chavesPendentes].filter((c) => !citadas.has(c)).length,
    };

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
        versaoPrompt: VERSAO_PROMPT_DO_RESUMO,
        provedor: bruta.provedor,
        criadaEm: this.o.clock.agora(),
      },
      medidas: {
        latenciaMs,
        ...(bruta.tokensEntrada !== undefined
          ? { tokensEntrada: bruta.tokensEntrada }
          : {}),
        ...(bruta.tokensSaida !== undefined ? { tokensSaida: bruta.tokensSaida } : {}),
        ...(bruta.custoUsd !== undefined ? { custoUsd: bruta.custoUsd } : {}),
      },
    };
    await this.o.resumos.salvar(resumo);

    return resumoParaATela(resumo, entrada.atos, (t) => entrada.restaurar(t));
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
  const base = {
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
    };
  }
  return {
    ...base,
    estado: 'verificado',
    situacao: r.situacao.map(item),
    pendencias: r.pendencias.map(item),
    pontosDeAtencao: r.pontosDeAtencao,
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
