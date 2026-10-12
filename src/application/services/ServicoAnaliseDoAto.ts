import { chaveDaMovimentacao } from '../../domain/entities/Acompanhamento.js';
import { atoDoDiario } from '../../domain/entities/atoDoDiario.js';
import type {
  AnaliseDoAto,
  AvaliacaoDaAnalise,
  ResultadoDaAnalise,
} from '../../domain/entities/AnaliseDoAto.js';
import { mascararWorkspace } from '../../domain/entities/workspaceLiberado.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type { Processo } from '../../domain/entities/Processo.js';
import type {
  AcaoPossivel,
  ParecePedir,
  PontoDeAtencao,
} from '../../domain/entities/vocabularioDaAnalise.js';
import {
  AcompanhamentoNaoEncontradoError,
  AnaliseNaoEncontradaError,
  DomainError,
  ProviderIndisponivelError,
  EntradaNaoAnalisavelError,
} from '../../domain/errors/index.js';
import type { AnalisadorDeAto } from '../../domain/ports/AnalisadorDeAto.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import type { RepositorioAnalises } from '../../domain/ports/RepositorioAnalises.js';
import {
  prepararEntrada,
  VERSAO_PROMPT,
  temTextoSuficiente,
  type AtoParaAnalisar,
} from '../politicas/entradaDoModelo.js';
import type { LimiteDeAnalises } from '../politicas/limiteDeAnalises.js';
import type { PessoasParaRedigir } from '../politicas/redigirParaIA.js';
import { verificarAnalise } from '../politicas/verificarAnalise.js';
import type { ServicoAssinaturas } from './ServicoAssinaturas.js';

/**
 * Análise de UM ato por IA, a pedido de um clique (Errata v1.1.0 da spec).
 *
 * Regras que moldam o código:
 * - o ato é resolvido AQUI, no retrato que a conta já acompanha, pela chave dele; a tela
 *   nunca manda texto, e texto vindo de fora nunca é aceito;
 * - plano IA sem exceção (`temRecursoSemExcecao`), segredo de justiça, ato sem texto
 *   suficiente e teor indisponível encerram ANTES de qualquer chamada ao adaptador;
 * - o que vai ao modelo é o texto REDIGIDO (sem nomes, documentos, contatos) e o que
 *   volta só chega à tela depois de `verificarAnalise`;
 * - falha do modelo NÃO vira exceção para a tela: devolve `{ estado: 'erro' }`.
 *
 * Apoio à leitura: nada aqui altera "pede providência", "não lida", ordem, contagem,
 * calendário ou qualquer outro dado do retrato.
 */

export interface AnaliseParaATela {
  readonly estado: 'verificada' | 'nao_verificada';
  readonly id: string;
  readonly parecePedir?: ParecePedir;
  readonly resumo?: string;
  readonly trechoChave?: string;
  readonly acoesPossiveis: readonly AcaoPossivel[];
  readonly pontosDeAtencao: readonly PontoDeAtencao[];
  /**
   * Prazo em dias escrito no ato (v0.39.0). `calculavel` = o ato é do Diário e tem termo
   * inicial; senão a tela manda criar o aviso manualmente. Nunca traz data.
   */
  readonly prazo?: {
    readonly dias: number;
    readonly tipo: 'uteis' | 'corridos' | null;
    readonly calculavel: boolean;
  };
  readonly modelo: string;
  readonly versaoPrompt: string;
  readonly provedor: string;
  readonly criadaEm: Date;
  readonly avaliacao: AvaliacaoDaAnalise | null;
}

export type RespostaDoServico = AnaliseParaATela | { readonly estado: 'erro' };

export interface OpcoesServicoAnaliseDoAto {
  readonly repositorio: RepositorioAcompanhamentos;
  readonly analises: RepositorioAnalises;
  readonly assinaturas: Pick<ServicoAssinaturas, 'temRecursoSemExcecao'>;
  readonly analisador: AnalisadorDeAto;
  readonly limite: LimiteDeAnalises;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly novoId: () => string;
  /**
   * EXCEÇÃO DE TESTE FECHADO (v0.38.1) — REMOVER ANTES DE ABRIR AO PÚBLICO.
   * Workspaces que passam na checagem do plano SEM assinatura, só aqui. Vazio/ausente
   * = só quem tem o plano IA vigente.
   */
  readonly workspacesLiberados?: ReadonlySet<string>;
}

export interface PedidoDeAnaliseDoAto {
  readonly workspace: string;
  readonly numero: string;
  readonly chaveDoAto: string;
  readonly sinal?: AbortSignal;
}

export class ServicoAnaliseDoAto {
  private readonly log: Logger;

  constructor(private readonly o: OpcoesServicoAnaliseDoAto) {
    this.log = o.logger.child({ servico: 'analise-do-ato' });
  }

  /**
   * O plano IA, sem exceção para workspace sem assinatura. O workspace liberado por variável
   * passa SEM assinatura (nada é gravado em `assinaturas`); quem não está na lista continua
   * dependendo do plano. Público porque o aviso de prazo (v0.39.0) exige a MESMA regra.
   */
  async exigirPlano(workspace: string): Promise<void> {
    if (this.o.workspacesLiberados?.has(workspace) === true) {
      this.log.info('análise liberada por exceção de teste fechado', {
        workspace: mascararWorkspace(workspace),
      });
      return;
    }
    if (!(await this.o.assinaturas.temRecursoSemExcecao(workspace, 'analiseIa'))) {
      throw new EntradaNaoAnalisavelError(
        'sem_plano',
        'A análise por IA faz parte do plano IA. Faça upgrade do plano para usar.',
      );
    }
  }

  async analisar(pedido: PedidoDeAnaliseDoAto): Promise<RespostaDoServico> {
    const { workspace } = pedido;
    const numero = NumeroCNJ.criar(pedido.numero).digitos;

    // 1. Plano: sem ele, nada além da frase fixa. Antes de ler o retrato.
    await this.exigirPlano(workspace);

    // 2. O ato vem do retrato DA CONTA, nunca do cliente.
    const acompanhamento = await this.o.repositorio.buscar(workspace, numero);
    if (!acompanhamento) throw new AcompanhamentoNaoEncontradoError();
    const processo = acompanhamento.processo;
    const ato = processo?.movimentacoes.find(
      (m) => chaveDaMovimentacao(m) === pedido.chaveDoAto,
    );
    if (!processo || !ato) {
      throw new EntradaNaoAnalisavelError(
        'ato_nao_encontrado',
        'Esse ato não está mais no último retrato do processo. Atualize a tela e confira de novo.',
      );
    }

    // 3. Segredo de justiça: o texto não sai do sistema, qualquer que seja ele.
    if (processo.segredoJustica) {
      throw new EntradaNaoAnalisavelError(
        'segredo_de_justica',
        'Processo em segredo de justiça: a análise por IA não é feita. Leia o ato.',
      );
    }

    // 4. Teor que o tribunal avisou não ser público ≠ texto curto demais.
    if (ato.teorIndisponivel === true) {
      throw new EntradaNaoAnalisavelError(
        'texto_indisponivel',
        'O tribunal não liberou o texto deste ato. Abra o processo no tribunal.',
      );
    }
    const paraAnalisar: AtoParaAnalisar = {
      data: ato.data,
      titulo: ato.titulo,
      ...(ato.conteudo !== undefined ? { conteudo: ato.conteudo } : {}),
      ...(ato.complementos ? { complementos: ato.complementos } : {}),
      ...(ato.tipoComunicacao ? { tipoComunicacao: ato.tipoComunicacao } : {}),
    };
    if (!temTextoSuficiente(paraAnalisar)) {
      throw new EntradaNaoAnalisavelError(
        'texto_insuficiente',
        'Este ato não traz texto suficiente para analisar. Leia o ato.',
      );
    }

    // 5. Limite de uso (sem tabela). A vaga é liberada em qualquer desfecho.
    const vaga = this.o.limite.reservar(workspace);
    if ('negada' in vaga) {
      throw new EntradaNaoAnalisavelError(
        'limite_de_uso',
        'Há muitas análises em andamento. Tente novamente em instantes.',
      );
    }
    try {
      return await this.chamarEGuardar(
        pedido,
        numero,
        processo,
        paraAnalisar,
        atoDoDiario(ato),
      );
    } finally {
      vaga.liberar();
    }
  }

  private async chamarEGuardar(
    pedido: PedidoDeAnaliseDoAto,
    numero: string,
    processo: Processo,
    ato: AtoParaAnalisar,
    doDiario: boolean,
  ): Promise<RespostaDoServico> {
    const entrada = prepararEntrada(
      ato,
      {
        ...(processo.classe ? { classe: processo.classe } : {}),
        tribunal: processo.tribunal,
      },
      { pessoas: pessoasDoProcesso(processo) },
    );

    const inicio = this.o.clock.monotonico();
    let bruta;
    try {
      bruta = await this.o.analisador.analisar({
        sistema: entrada.sistema,
        usuario: entrada.usuario,
        ...(pedido.sinal ? { sinal: pedido.sinal } : {}),
      });
    } catch (erro) {
      // Só a CLASSE do erro e o roteamento SANEADO vão ao log: a mensagem de um roteador pode
      // ecoar o pedido (que leva texto de ato), então ela nunca é copiada.
      const r = erro instanceof ProviderIndisponivelError ? erro.roteamento : undefined;
      this.log.warn('análise do ato não concluída', {
        causa: erro instanceof DomainError ? erro.codigo : 'erro_inesperado',
        tipo: erro instanceof Error ? erro.name : typeof erro,
        ...(r?.status !== undefined ? { statusHttp: r.status } : {}),
        ...(r?.passo !== undefined ? { passoDoRoteamento: r.passo } : {}),
        ...(r?.funil !== undefined ? { funilDoRoteamento: funilEmTexto(r.funil) } : {}),
      });
      return { estado: 'erro' };
    }
    const latenciaMs = Math.max(0, Math.round(this.o.clock.monotonico() - inicio));

    const verificada = verificarAnalise(bruta.resposta, entrada.textoEnviado);
    const resultado: ResultadoDaAnalise =
      verificada.estado === 'verificada'
        ? {
            estado: 'verificada',
            parecePedir: verificada.parecePedir,
            ...(verificada.resumo !== undefined ? { resumo: verificada.resumo } : {}),
            ...(verificada.trechoChave !== undefined
              ? { trechoChave: verificada.trechoChave }
              : {}),
            acoesPossiveis: verificada.acoesPossiveis,
            pontosDeAtencao: verificada.pontosDeAtencao,
            ...(verificada.prazo !== undefined ? { prazo: verificada.prazo } : {}),
          }
        : { estado: 'nao_verificada', motivo: verificada.motivo };

    const analise: AnaliseDoAto = {
      id: this.o.novoId(),
      workspace: pedido.workspace,
      numero,
      chaveDoAto: pedido.chaveDoAto,
      resultado,
      procedencia: {
        modelo: bruta.modelo,
        versaoPrompt: VERSAO_PROMPT,
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
    await this.o.analises.salvar(analise);

    return paraATela(analise, (t) => entrada.redacao.restaurar(t), doDiario);
  }

  /** Só o dono da conta avalia; pode corrigir a avaliação anterior. 404 igual para "não existe" e "é de outra". */
  async avaliar(
    workspace: string,
    id: string,
    avaliacao: AvaliacaoDaAnalise,
  ): Promise<void> {
    const ok = await this.o.analises.avaliar(workspace, id, avaliacao);
    if (!ok) throw new AnaliseNaoEncontradaError();
  }
}

/** Do que está gravado (com marcadores) ao que a tela recebe (marcadores trocados pelos valores da conta). */
export function paraATela(
  analise: AnaliseDoAto,
  restaurar: (texto: string) => string,
  doDiario = false,
): AnaliseParaATela {
  const base = {
    id: analise.id,
    modelo: analise.procedencia.modelo,
    versaoPrompt: analise.procedencia.versaoPrompt,
    provedor: analise.procedencia.provedor,
    criadaEm: analise.procedencia.criadaEm,
    avaliacao: analise.avaliacao ?? null,
  };
  const r = analise.resultado;
  if (r.estado === 'nao_verificada') {
    return {
      ...base,
      estado: 'nao_verificada',
      acoesPossiveis: [],
      pontosDeAtencao: [],
    };
  }
  return {
    ...base,
    estado: 'verificada',
    parecePedir: r.parecePedir,
    ...(r.resumo !== undefined ? { resumo: restaurar(r.resumo) } : {}),
    ...(r.trechoChave !== undefined ? { trechoChave: restaurar(r.trechoChave) } : {}),
    // Só a ação: análises gravadas antes da 0.38.5 trazem `trecho` na linha, e ele não sai.
    acoesPossiveis: r.acoesPossiveis.map((a) => ({ acao: restaurar(a.acao) })),
    pontosDeAtencao: r.pontosDeAtencao,
    ...(r.prazo
      ? { prazo: { dias: r.prazo.dias, tipo: r.prazo.tipo, calculavel: doDiario } }
      : {}),
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

/** O funil do roteamento em texto, truncado: vai ao log, que não pode crescer com o corpo do erro. */
const LIMITE_DO_FUNIL_NO_LOG = 600;
function funilEmTexto(funil: unknown): string {
  const texto = JSON.stringify(funil) ?? '';
  return texto.length > LIMITE_DO_FUNIL_NO_LOG
    ? `${texto.slice(0, LIMITE_DO_FUNIL_NO_LOG)}…`
    : texto;
}
