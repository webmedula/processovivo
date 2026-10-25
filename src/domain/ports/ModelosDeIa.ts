import type { FuncaoDeIa } from '../entities/ControleDaIa.js';
import type {
  MetricasDoModelo,
  MotivoDeBloqueio,
  MotivoDeRessalva,
  Veredito,
} from '../entities/ModelosDeIa.js';
import type { AlteracaoDeConfigDeIa } from './PainelDeIa.js';

/**
 * Portas da Fase B do painel de IA (v0.60.0): o modelo por função e o teste obrigatório antes de
 * publicar. Só ids de modelo, números e rótulos de lista fechada: NENHUM texto de fixture, de ato, de
 * peça ou de resposta do modelo passa por aqui.
 */

export interface ModeloGravado {
  /** `null` = vale o ambiente/padrão do código. */
  readonly modelo: string | null;
  /** O modelo que estava em produção antes da última troca (para reverter). */
  readonly anterior: string | null;
  readonly desde: Date | null;
}

export type ModelosGravados = Readonly<Record<FuncaoDeIa, ModeloGravado>>;

export interface RepositorioDeModelosDeIa {
  /** Pode lançar (o serviço trata: falha vira o ambiente). */
  ler(): ModelosGravados;
  /** Grava o modelo da função E o registro da mudança, na MESMA transação. */
  publicar(
    funcao: FuncaoDeIa,
    modelo: string | null,
    anterior: string | null,
    agora: Date,
    alteracao: AlteracaoDeConfigDeIa,
  ): void;
  /** Só o registro (início de um teste). */
  registrar(alteracao: AlteracaoDeConfigDeIa): void;
}

export type EstadoDoTeste =
  'na_fila' | 'executando' | 'concluido' | 'falhou' | 'cancelado';

export type MotivoDeFalhaDoTeste =
  'teto_de_gasto' | 'reiniciado' | 'zdr_indisponivel' | 'erro_interno';

export interface TesteDeModelo {
  readonly id: string;
  readonly funcao: FuncaoDeIa;
  readonly candidato: string;
  readonly referencia: string;
  readonly estado: EstadoDoTeste;
  readonly autor: string;
  readonly criadoEm: Date;
  readonly iniciadoEm?: Date;
  readonly terminadoEm?: Date;
  readonly chamadasPrevistas: number;
  readonly chamadasFeitas: number;
  readonly estimativaUsd: number | null;
  readonly gastoUsd: number | null;
  readonly metricasDoCandidato?: MetricasDoModelo;
  readonly metricasDaReferencia?: MetricasDoModelo;
  readonly veredito?: Veredito;
  readonly bloqueios: readonly MotivoDeBloqueio[];
  readonly ressalvas: readonly MotivoDeRessalva[];
  readonly falha?: MotivoDeFalhaDoTeste;
}

export type AtualizacaoDoTeste = Partial<
  Omit<TesteDeModelo, 'id' | 'funcao' | 'candidato' | 'referencia' | 'autor' | 'criadoEm'>
>;

export interface RepositorioDeTestesDeModelo {
  criar(teste: TesteDeModelo): void;
  atualizar(id: string, mudanca: AtualizacaoDoTeste): void;
  buscar(id: string): TesteDeModelo | undefined;
  /** O mais recente da função (qualquer estado). */
  ultimoDaFuncao(funcao: FuncaoDeIa): TesteDeModelo | undefined;
  /** Algum teste `na_fila` ou `executando`? */
  emAndamento(): TesteDeModelo | undefined;
  /** No arranque: o que estava rodando não retoma sozinho; vira `falhou` (`reiniciado`). */
  marcarInterrompidos(agora: Date): number;
}

// --- execução do teste (implementada em main/sonda, sobre o comparador) ---------------------------------

export interface PrecoPorTokenDoModelo {
  readonly entrada: number;
  readonly saida: number;
}

export interface EstimativaDoTeste {
  /** Chamadas no total (candidato + referência). */
  readonly chamadas: number;
  /** `null` quando falta preço para algum dos dois. */
  readonly custoEstimadoUsd: number | null;
}

export type ResultadoDaExecucaoDoTeste =
  | {
      readonly tipo: 'ok';
      readonly candidato: MetricasDoModelo;
      readonly referencia: MetricasDoModelo;
      readonly gastoUsd: number;
      readonly tetoAtingido: boolean;
    }
  | { readonly tipo: 'sem_zdr' }
  | { readonly tipo: 'zdr_indisponivel' };

export interface ExecutorDoTesteDeModelo {
  /** Sem rede: conta as chamadas do conjunto sintético e estima o custo pelos preços da lista. */
  estimar(
    funcao: FuncaoDeIa,
    modelos: readonly string[],
    precos: ReadonlyMap<string, PrecoPorTokenDoModelo>,
  ): EstimativaDoTeste;
  executar(pedido: {
    readonly funcao: FuncaoDeIa;
    readonly candidato: string;
    readonly referencia: string;
    readonly tetoUsd: number;
    readonly precos: ReadonlyMap<string, PrecoPorTokenDoModelo>;
    readonly sinal: AbortSignal;
    /** Chamado a cada chamada ao modelo (só contagem, para o progresso). */
    readonly aoChamar: () => void;
  }): Promise<ResultadoDaExecucaoDoTeste>;
}
