/**
 * Quem pode usar a análise de PEÇA por IA (v0.55.0) — política PURA, em duas chaves:
 *
 *  - `habilitada` (`PROCESSOVIVO_IA_PECAS_HABILITADA`): todas as contas com o recurso `analiseIa`;
 *  - `workspaces` (`PROCESSOVIVO_IA_PECAS_WORKSPACES`): só estas contas (16 ou 32 hex) — e elas também
 *    precisam do recurso.
 *
 * Sem nenhuma das duas, nada: o botão não aparece e a rota responde "indisponível". O modo diz COMO a conta foi
 * liberada: `avaliacao` (conta da lista, com a chave geral desligada) ou `geral` (chave geral ligada). Até a v0.55.0 o
 * modo decidia a tela (três botões de avaliação × link "Reportar problema"); desde a v0.56.0 a tela é a mesma para
 * todos, com o polegar, e o modo fica só na API (informação de como a conta entrou).
 * A liberação NÃO substitui o plano: o plano é conferido à parte, por `temRecursoSemExcecao`.
 */
export type ModoDaAnaliseDePeca = 'geral' | 'avaliacao';

export interface LiberacaoDaAnaliseDePeca {
  readonly habilitada: boolean;
  readonly workspaces: readonly string[];
}

export function modoDaAnaliseDePeca(
  workspace: string,
  liberacao: LiberacaoDaAnaliseDePeca,
): ModoDaAnaliseDePeca | undefined {
  if (liberacao.habilitada) return 'geral';
  const id = workspace.trim().toLowerCase();
  return liberacao.workspaces.includes(id) ? 'avaliacao' : undefined;
}
