import type { Comprovante } from '../entities/Comprovante.js';
import type { CategoriaDeCusto, Custo } from '../entities/Custo.js';
import type {
  EntidadeDoHistorico,
  EventoDoHistorico,
} from '../entities/HistoricoDeCustos.js';
import type { Recebimento } from '../entities/Recebimento.js';

export interface FiltroDePeriodo {
  readonly de?: string;
  readonly ate?: string;
}

/**
 * Persistência do centro de custos (v0.47.0, ampliada na v0.48.0).
 *
 * TODA operação leva o `workspace` e o confere na consulta: lançamento, recebimento ou categoria de
 * outra conta é "não existe" (`undefined` / `false`), nunca "proibido". Não há método que leia pelo
 * id sozinho. **Não há método que apague lançamento ou recebimento**: cancelar é gravar
 * `canceladoEm`. Só `apagarDoWorkspace` (exclusão de conta) remove linhas.
 *
 * Cada escrita leva o EVENTO do histórico e grava os dois na mesma transação: não existe mudança
 * sem trilha nem trilha de mudança que não aconteceu.
 */
export interface RepositorioDeCustos {
  /** Do mais recente para o mais antigo (data do gasto; o `criadoEm` desempata). */
  listar(
    workspace: string,
    numeroProcesso: string,
    incluirCancelados: boolean,
  ): Promise<Custo[]>;
  /** Só os ativos: é o que conta para o teto de lançamentos. */
  contar(workspace: string, numeroProcesso: string): Promise<number>;
  buscar(workspace: string, id: string): Promise<Custo | undefined>;
  inserir(custo: Custo, evento: EventoDoHistorico): Promise<void>;
  /** `false` quando o lançamento não existe neste workspace. */
  atualizar(custo: Custo, evento: EventoDoHistorico): Promise<boolean>;

  listarRecebimentos(
    workspace: string,
    numeroProcesso: string,
    incluirCancelados: boolean,
  ): Promise<Recebimento[]>;
  contarRecebimentos(workspace: string, numeroProcesso: string): Promise<number>;
  buscarRecebimento(workspace: string, id: string): Promise<Recebimento | undefined>;
  inserirRecebimento(recebimento: Recebimento, evento: EventoDoHistorico): Promise<void>;
  atualizarRecebimento(
    recebimento: Recebimento,
    evento: EventoDoHistorico,
  ): Promise<boolean>;

  /**
   * Tudo o que é deste workspace, de TODOS os processos, para a visão por cliente e os relatórios.
   * `de`/`ate` (AAAA-MM-DD, inclusive) filtram pela data do gasto/recebimento.
   */
  listarDoWorkspace(
    workspace: string,
    filtro: FiltroDePeriodo,
    incluirCancelados: boolean,
  ): Promise<Custo[]>;
  listarRecebimentosDoWorkspace(
    workspace: string,
    filtro: FiltroDePeriodo,
    incluirCancelados: boolean,
  ): Promise<Recebimento[]>;

  /** Comprovantes de um processo (ou, sem número, de todo o workspace). */
  listarComprovantes(workspace: string, numeroProcesso?: string): Promise<Comprovante[]>;
  contarComprovantes(workspace: string, custoId: string): Promise<number>;
  buscarComprovante(workspace: string, id: string): Promise<Comprovante | undefined>;
  /**
   * Grava o vínculo e o evento "anexou" na mesma transação. `false` quando o lançamento já está no
   * teto de comprovantes (conferido DENTRO da transação: duas requisições juntas não passam do teto).
   */
  inserirComprovante(
    comprovante: Comprovante,
    maximo: number,
    evento: EventoDoHistorico,
  ): Promise<boolean>;
  /** Apaga SÓ o vínculo e grava o evento "removeu". `false` quando não existe neste workspace. */
  removerComprovante(
    workspace: string,
    id: string,
    evento: EventoDoHistorico,
  ): Promise<boolean>;

  categorias(workspace: string): Promise<CategoriaDeCusto[]>;
  buscarCategoria(workspace: string, id: string): Promise<CategoriaDeCusto | undefined>;
  inserirCategoria(categoria: CategoriaDeCusto): Promise<void>;
  /** Grava `arquivada` e `grupo`. */
  atualizarCategoria(categoria: CategoriaDeCusto): Promise<boolean>;
  /** Quantos lançamentos (cancelados inclusive) usam este código. */
  usosDaCategoria(workspace: string, codigo: string): Promise<number>;

  /** Em ordem cronológica (do mais antigo ao mais novo). */
  historico(
    workspace: string,
    entidade: EntidadeDoHistorico,
    entidadeId: string,
  ): Promise<EventoDoHistorico[]>;

  /**
   * Apaga TUDO que é deste workspace — lançamentos, recebimentos, categorias e histórico. É o
   * caminho da exclusão de conta (que ainda não existe no produto). Devolve quantas linhas saíram.
   */
  apagarDoWorkspace(workspace: string): Promise<number>;
}
