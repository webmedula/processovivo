import type { Clock } from '../../domain/ports/Clock.js';

/**
 * Freio de uso da análise por IA, SEM tabela: tudo em memória do processo, e reiniciar
 * zera os contadores (aceito: o teto de gasto de verdade é o limite da chave no
 * OpenRouter). Três travas, todas conferidas ANTES de qualquer saída de dados:
 *
 * - no máximo `porHora` análises iniciadas por workspace na última hora;
 * - no máximo UMA em andamento por workspace (clique repetido não empilha);
 * - um teto global baixo de análises em andamento no processo inteiro.
 *
 * Clique repetido depois de terminar simplesmente analisa de novo: sem cache, sem cota mensal.
 */
export interface OpcoesDoLimite {
  readonly porHora: number;
  readonly simultaneasNoTotal: number;
  readonly clock: Clock;
}

const UMA_HORA_MS = 3_600_000;

export type NegativaDoLimite = 'hora' | 'em_andamento' | 'global';

export class LimiteDeAnalises {
  private readonly inicios = new Map<string, number[]>();
  private readonly emAndamento = new Set<string>();

  constructor(private readonly opcoes: OpcoesDoLimite) {}

  /**
   * Reserva uma vaga. Devolve a função que a libera (idempotente), ou o motivo da recusa.
   * A recusa não consome nada.
   */
  reservar(
    workspace: string,
  ): { readonly liberar: () => void } | { readonly negada: NegativaDoLimite } {
    const agora = this.opcoes.clock.agora().getTime();
    if (this.emAndamento.has(workspace)) return { negada: 'em_andamento' };
    if (this.emAndamento.size >= this.opcoes.simultaneasNoTotal) {
      return { negada: 'global' };
    }
    const recentes = (this.inicios.get(workspace) ?? []).filter(
      (t) => agora - t < UMA_HORA_MS,
    );
    if (recentes.length >= this.opcoes.porHora) {
      this.inicios.set(workspace, recentes);
      return { negada: 'hora' };
    }
    recentes.push(agora);
    this.inicios.set(workspace, recentes);
    this.emAndamento.add(workspace);
    let liberada = false;
    return {
      liberar: () => {
        if (liberada) return;
        liberada = true;
        this.emAndamento.delete(workspace);
      },
    };
  }
}
