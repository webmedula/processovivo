import type {
  AnaliseDoAto,
  AvaliacaoDaAnalise,
  MotivoDaAvaliacao,
} from '../entities/AnaliseDoAto.js';

/** Persistência das análises. Toda leitura confere o workspace: de outra conta é "não existe". */
export interface RepositorioAnalises {
  salvar(analise: AnaliseDoAto): Promise<void>;
  buscar(workspace: string, id: string): Promise<AnaliseDoAto | undefined>;
  /** Grava (ou corrige) a avaliação. `false` = a análise não é deste workspace. */
  avaliar(
    workspace: string,
    id: string,
    avaliacao: AvaliacaoDaAnalise,
    /** Só vale com `errado` ou `perigoso`; com `util` o motivo anterior é apagado. */
    motivo?: MotivoDaAvaliacao,
  ): Promise<boolean>;
}
