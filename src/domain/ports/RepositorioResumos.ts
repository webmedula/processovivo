import type { AvaliacaoDaAnalise, MotivoDaAvaliacao } from '../entities/AnaliseDoAto.js';
import type { ResumoDoProcesso } from '../entities/ResumoDoProcesso.js';

/** Persistência dos resumos. Toda leitura confere o workspace: de outra conta é "não existe". */
export interface RepositorioResumos {
  salvar(resumo: ResumoDoProcesso): Promise<void>;
  buscar(workspace: string, id: string): Promise<ResumoDoProcesso | undefined>;
  /** Grava (ou corrige) a avaliação. `false` = o resumo não é deste workspace. */
  avaliar(
    workspace: string,
    id: string,
    avaliacao: AvaliacaoDaAnalise,
    /** Só vale com `errado` ou `perigoso`; com `util` o motivo anterior é apagado. */
    motivo?: MotivoDaAvaliacao,
  ): Promise<boolean>;
}
