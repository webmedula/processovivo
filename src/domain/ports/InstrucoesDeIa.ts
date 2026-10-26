import type { FuncaoDeIa } from '../entities/ControleDaIa.js';
import type { InstrucaoEfetiva, InstrucaoGravada } from '../entities/InstrucoesDeIa.js';
import type { AlteracaoDeConfigDeIa } from './PainelDeIa.js';
import type {
  EstimativaDoTeste,
  PrecoPorTokenDoModelo,
  ResultadoDaExecucaoDoTeste,
} from './ModelosDeIa.js';

/**
 * Portas das instruções de interpretação (painel de IA, Fase C, v0.61.0). Só o texto das instruções do
 * operador, números e ids curtos: NENHUM texto de ato, de peça ou de resposta do modelo passa por aqui.
 */

/** O que está em produção numa função, lido de uma vez (a versão e o texto nunca vêm de leituras diferentes). */
export interface InstrucaoEmProducao extends InstrucaoEfetiva {
  /** A edição publicada antes desta (0 = nenhuma: reverter volta ao `+e0`). */
  readonly anterior: number;
}

export interface RepositorioDeInstrucoesDeIa {
  /** Pode lançar (o serviço trata: falha vira o prompt de sempre, `+e0`). */
  emProducao(funcao: FuncaoDeIa): InstrucaoEmProducao;
  buscar(funcao: FuncaoDeIa, versao: number): InstrucaoGravada | undefined;
  rascunho(funcao: FuncaoDeIa): InstrucaoGravada | undefined;
  /** Mais recentes primeiro. */
  historico(funcao: FuncaoDeIa, limite: number): InstrucaoGravada[];
  /**
   * Grava o rascunho: se já há um na função, ele é ATUALIZADO (mesma edição); senão nasce a próxima
   * edição (maior já usada + 1). No máximo um rascunho por função.
   */
  salvarRascunho(
    funcao: FuncaoDeIa,
    texto: string,
    observacao: string,
    autor: string,
    agora: Date,
  ): InstrucaoGravada;
  /**
   * Publica a edição (que tem de ser o rascunho), substitui a que estava publicada e grava o registro da
   * mudança, tudo na MESMA transação.
   */
  publicar(
    funcao: FuncaoDeIa,
    versao: number,
    autor: string,
    agora: Date,
    alteracao: AlteracaoDeConfigDeIa,
  ): void;
  /**
   * Volta à edição anterior (ou ao vazio) e grava o registro, na MESMA transação. Devolve `{ de, para }`;
   * `undefined` se não havia o que reverter.
   */
  reverter(
    funcao: FuncaoDeIa,
    autor: string,
    agora: Date,
    alteracao: (de: number, para: number) => AlteracaoDeConfigDeIa,
  ): { readonly de: number; readonly para: number } | undefined;
}

/** O que a análise de ato, o resumo e a de peça consultam a cada chamada. Síncrono: está no caminho de toda análise. */
export interface InstrucoesDaFuncao {
  /** Nunca lança: falha vira `{ versao: 0, texto: '' }`. */
  efetiva(funcao: FuncaoDeIa): InstrucaoEfetiva;
}

/** Sem painel (testes antigos, CLI): o prompt de sempre. */
export const SEM_INSTRUCOES: InstrucoesDaFuncao = Object.freeze({
  efetiva: () => ({ versao: 0, texto: '' }),
});

// --- "Onde a IA erra" ---------------------------------------------------------------------------------------

export interface ErroRecenteDeIa {
  readonly em: Date;
  /** A versão como foi gravada (`ato-1.2.0+e1`; sem sufixo = `+e0`). */
  readonly versaoPrompt: string;
  readonly avaliacao: 'errado' | 'perigoso';
  readonly motivo: string | null;
  readonly modelo: string;
  /** O resultado não passou na verificação. */
  readonly naoVerificada: boolean;
  /** Só os 8 primeiros caracteres da conta. */
  readonly conta: string;
}

export interface LeitorDeErrosDeIa {
  /** As avaliações "errado"/"perigoso" mais recentes da função, de `desde` em diante. Nunca o conteúdo da análise. */
  errosRecentes(funcao: FuncaoDeIa, desde: Date, limite: number): ErroRecenteDeIa[];
}

// --- o conjunto de verificação opcional ---------------------------------------------------------------------

/** Implementado em `main/sonda`, sobre os comparadores da Fase B (a mesma classe do teste de modelo). */
export interface ExecutorDaVerificacaoDeInstrucoes {
  /** Sem rede: conta as chamadas do conjunto sintético (duas rodadas, no mesmo modelo) e estima o custo. */
  estimarInstrucoes(
    funcao: FuncaoDeIa,
    modelo: string,
    precos: ReadonlyMap<string, PrecoPorTokenDoModelo>,
  ): EstimativaDoTeste;
  /** Roda o conjunto com a instrução publicada (referência) e com o rascunho (candidato), no mesmo modelo. */
  executarInstrucoes(pedido: {
    readonly funcao: FuncaoDeIa;
    readonly modelo: string;
    readonly publicada: string;
    readonly rascunho: string;
    readonly tetoUsd: number;
    readonly precos: ReadonlyMap<string, PrecoPorTokenDoModelo>;
    readonly sinal: AbortSignal;
    /** Chamado a cada chamada ao modelo (só contagem, para o progresso). */
    readonly aoChamar: () => void;
  }): Promise<ResultadoDaExecucaoDoTeste>;
}
