import type {
  AvaliacaoDaAnalise,
  MotivoDaAvaliacao,
} from '../entities/AnaliseDoAto.js';
import type { AnaliseDePeca } from '../entities/AnaliseDePeca.js';

/**
 * Persistência das análises de peça (v0.55.0). Toda operação recebe o `workspace` e filtra por ele:
 * não existe "obter por id" sem dono. Guarda resultado com citações curtas e marcadores, NUNCA o
 * texto da peça, e some sozinho no `expiraEm` (rotina do `Agendador`).
 */
export interface RepositorioAnalisesDePeca {
  salvar(analise: AnaliseDePeca): Promise<void>;
  buscar(workspace: string, id: string): Promise<AnaliseDePeca | undefined>;
  /**
   * A análise VIGENTE (não vencida) da mesma conta, processo, peça, bytes e versão do prompt.
   * Serve ao reaproveitamento: a mesma peça, os mesmos bytes e o mesmo prompt dão o mesmo
   * resultado, então não se cobra do teto duas vezes.
   */
  buscarReaproveitavel(
    workspace: string,
    chave: {
      readonly processoChave: string;
      readonly pecaId: string;
      readonly hashDosBytes: string;
      readonly versaoPrompt: string;
      readonly modeloPedido: string;
    },
    agora: Date,
  ): Promise<AnaliseDePeca | undefined>;
  /** @returns se a análise existe PARA ESTA conta. */
  avaliar(
    workspace: string,
    id: string,
    avaliacao: AvaliacaoDaAnalise,
    motivo?: MotivoDaAvaliacao,
  ): Promise<boolean>;
  /** Apaga as vencidas (`expira_em` ≤ agora). @returns quantas. */
  apagarVencidas(agora: Date): Promise<number>;
  /** Exclusão de conta. @returns quantas linhas saíram. */
  apagarDoWorkspace(workspace: string): Promise<number>;
}
