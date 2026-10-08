import type {
  Acompanhamento,
  CumpridoDoAcompanhamento,
  Novidade,
} from '../entities/Acompanhamento.js';
import type { Movimentacao } from '../entities/Movimentacao.js';
import type { Processo } from '../entities/Processo.js';

/** Filtros da lista de processos acompanhados. */
export interface FiltroAcompanhamentos {
  /** Busca livre em número, apelido, vara, classe e assunto. */
  readonly texto?: string;
  readonly tribunal?: string;
  readonly classe?: string;
  /**
   * Nome (ou parte do nome) de uma PARTE do processo.
   *
   * Separado de `texto` porque responde outra pergunta. `texto` varre o JSON
   * inteiro e casa com qualquer menção — inclusive dentro de um despacho, o
   * que traz processo em que o cliente é só citado. Este casa apenas com quem
   * consta como parte, e é o filtro de "quais processos são do cliente X".
   */
  readonly parte?: string;
  /** Nome (ou parte) do rótulo de cliente que o advogado deu à pasta. */
  readonly cliente?: string;
  /** Só os que têm novidade não lida. */
  readonly somenteComNovidade?: boolean;
  /** Última movimentação nos últimos N dias. */
  readonly movimentadoNosUltimosDias?: number;
  readonly ordem?: 'MOVIMENTACAO_RECENTE' | 'ADICIONADO_RECENTE' | 'NUMERO';
}

export interface FiltroNovidades {
  readonly numero?: string;
  readonly tribunal?: string;
  readonly somenteNaoVistas?: boolean;
  readonly desde?: Date;
  readonly limite?: number;
}

/** Um acompanhamento com os números que a lista precisa mostrar. */
export interface AcompanhamentoResumido extends Acompanhamento {
  readonly novidadesNaoVistas: number;
  readonly ultimaMovimentacao?: Movimentacao;
}

/**
 * Porta de persistência do acompanhamento.
 *
 * Hoje implementada em SQLite num arquivo. Trocar por Postgres, quando houver
 * mais de uma instância, é escrever outra classe que cumpra esta interface —
 * nada acima daqui muda.
 */
export interface RepositorioAcompanhamentos {
  acompanhar(
    workspace: string,
    numero: string,
    apelido?: string,
  ): Promise<Acompanhamento>;

  deixarDeAcompanhar(workspace: string, numero: string): Promise<boolean>;

  /**
   * Grava (ou apaga, com string vazia) o rótulo de cliente da pasta.
   *
   * Método próprio em vez de um parâmetro a mais em `acompanhar` porque as duas
   * operações têm significados diferentes: `acompanhar` é idempotente e usa
   * COALESCE para não apagar o que já existe ao reacompanhar. Rotular precisa
   * do contrário — tem de conseguir LIMPAR um rótulo digitado errado, e com
   * COALESCE isso seria impossível.
   *
   * @returns `false` quando não há acompanhamento com esse número.
   */
  rotular(workspace: string, numero: string, cliente: string): Promise<boolean>;

  /**
   * Grava a marca de "cumprido" (substitui a anterior).
   *
   * @returns `false` quando não há acompanhamento com esse número NESTE workspace.
   */
  marcarCumprido(
    workspace: string,
    numero: string,
    cumprido: CumpridoDoAcompanhamento,
  ): Promise<boolean>;

  /** Remove a marca. `false` quando não há acompanhamento com esse número neste workspace. */
  desfazerCumprido(workspace: string, numero: string): Promise<boolean>;

  /** Os rótulos de cliente em uso, para alimentar o seletor. */
  clientes(workspace: string): Promise<string[]>;

  buscar(workspace: string, numero: string): Promise<Acompanhamento | undefined>;

  listar(
    workspace: string,
    filtro?: FiltroAcompanhamentos,
  ): Promise<AcompanhamentoResumido[]>;

  /** Todos os acompanhamentos de TODOS os workspaces, para a varredura. */
  /**
   * Fila da varredura.
   *
   * @param workspace quando informado, limita a UM assinante. É o que separa a
   *   varredura agendada (global, de todo mundo) do "verificar agora" disparado
   *   por uma pessoa — sem isso, qualquer conta dispara consulta ao tribunal
   *   sobre os processos de TODOS os outros assinantes.
   */
  listarParaSincronizar(limite: number, workspace?: string): Promise<Acompanhamento[]>;

  /** Grava o retrato novo e registra as movimentações inéditas. */
  registrarSincronizacao(
    workspace: string,
    numero: string,
    processo: Processo,
    novidades: readonly Movimentacao[],
  ): Promise<void>;

  registrarFalha(workspace: string, numero: string, erro: string): Promise<void>;

  listarNovidades(workspace: string, filtro?: FiltroNovidades): Promise<Novidade[]>;

  contarNaoVistas(workspace: string): Promise<number>;

  /**
   * Quantos processos o assinante acompanha.
   *
   * Existe como COUNT próprio, e não como `listar().length`, porque a tela
   * inicial pede esse número a cada abertura — e `listar` desserializa o JSON
   * do processo de cada linha, que é dezenas de KB por processo.
   */
  contarAcompanhamentos(workspace: string): Promise<number>;

  /** Marca como lidas. Sem `numero`, marca todas do workspace. */
  marcarComoVistas(workspace: string, numero?: string): Promise<number>;

  /** Valores distintos para alimentar os seletores de filtro. */
  facetas(workspace: string): Promise<{ tribunais: string[]; classes: string[] }>;
}
