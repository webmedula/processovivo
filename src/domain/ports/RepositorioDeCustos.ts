import type { CategoriaDeCusto, Custo } from '../entities/Custo.js';

/**
 * Persistência do centro de custos (v0.47.0).
 *
 * TODA operação leva o `workspace` e o confere na consulta: lançamento ou categoria de outra conta
 * é "não existe" (`undefined` / `false`), nunca "proibido". Não há método que leia pelo id sozinho.
 */
export interface RepositorioDeCustos {
  /** Do mais recente para o mais antigo (data do gasto; o `criadoEm` desempata). */
  listar(workspace: string, numeroProcesso: string): Promise<Custo[]>;
  contar(workspace: string, numeroProcesso: string): Promise<number>;
  buscar(workspace: string, id: string): Promise<Custo | undefined>;
  inserir(custo: Custo): Promise<void>;
  /** `false` quando o lançamento não existe neste workspace. */
  atualizar(custo: Custo): Promise<boolean>;
  excluir(workspace: string, id: string): Promise<boolean>;

  categorias(workspace: string): Promise<CategoriaDeCusto[]>;
  buscarCategoria(workspace: string, id: string): Promise<CategoriaDeCusto | undefined>;
  inserirCategoria(categoria: CategoriaDeCusto): Promise<void>;
  atualizarCategoria(categoria: CategoriaDeCusto): Promise<boolean>;

  /**
   * Apaga TUDO que é deste workspace — lançamentos e categorias. É o caminho da exclusão de conta
   * (que ainda não existe no produto), igual ao dos demais dados por workspace. Devolve quantas
   * linhas saíram.
   */
  apagarDoWorkspace(workspace: string): Promise<number>;
}
