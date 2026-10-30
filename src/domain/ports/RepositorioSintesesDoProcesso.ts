import type {
  AvaliacaoDaAnalise,
  MotivoDaAvaliacao,
} from '../entities/AnaliseDoAto.js';
import type { SinteseDoProcesso } from '../entities/AnaliseDoProcesso.js';

/**
 * Persistência das sínteses do processo (v0.66.0). Toda operação recebe o `workspace` e filtra por ele.
 * Guarda o resultado com marcadores e identificadores de item, NUNCA texto de peça, e some sozinho no
 * `expiraEm` (rotina do `Agendador`, a mesma das análises de peça).
 */
export interface RepositorioSintesesDoProcesso {
  salvar(sintese: SinteseDoProcesso): Promise<void>;
  /** A síntese VIGENTE da mesma conta e da mesma seleção (análises, prompt e modelo). */
  buscarReaproveitavel(
    workspace: string,
    chaveDaSelecao: string,
    agora: Date,
  ): Promise<SinteseDoProcesso | undefined>;
  /** @returns se a síntese existe PARA ESTA conta. */
  avaliar(
    workspace: string,
    id: string,
    avaliacao: AvaliacaoDaAnalise,
    motivo?: MotivoDaAvaliacao,
  ): Promise<boolean>;
  apagarVencidas(agora: Date): Promise<number>;
  apagarDoWorkspace(workspace: string): Promise<number>;
}
