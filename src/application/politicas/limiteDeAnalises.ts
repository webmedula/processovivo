import type { Clock } from '../../domain/ports/Clock.js';

/**
 * Freio de uso da análise por IA, SEM tabela: tudo em memória do processo, e reiniciar
 * zera os contadores (aceito: o teto de gasto de verdade é o limite da chave no
 * OpenRouter). Três travas, todas conferidas ANTES de qualquer saída de dados:
 *
 * - no máximo `porHora` análises iniciadas por workspace na última hora;
 * - no máximo UMA em andamento por workspace (clique repetido não empilha);
 * - um teto global baixo de análises em andamento no processo inteiro;
 * - (v0.50.0, opcional) um TETO TÉCNICO por workspace e por dia de São Paulo: freio de
 *   segurança contra uso anômalo, não limite do plano (a venda não tem cota). Vira o dia, zera.
 *
 * Clique repetido depois de terminar simplesmente analisa de novo: sem cache, sem cota mensal.
 */
export interface OpcoesDoLimite {
  readonly porHora: number;
  readonly simultaneasNoTotal: number;
  /** Teto por workspace no dia de São Paulo. Ausente = sem teto diário (o resumo não o usa). */
  readonly porDia?: number;
  readonly clock: Clock;
}

const UMA_HORA_MS = 3_600_000;
/** São Paulo em -03:00 fixo (sem horário de verão desde 2019), como o calendário. */
const FUSO_DE_SAO_PAULO_MS = -3 * UMA_HORA_MS;

export type NegativaDoLimite = 'hora' | 'em_andamento' | 'global' | 'dia';

/** `AAAA-MM-DD` do instante no fuso de São Paulo. */
function diaEmSaoPaulo(instanteMs: number): string {
  return new Date(instanteMs + FUSO_DE_SAO_PAULO_MS).toISOString().slice(0, 10);
}

export class LimiteDeAnalises {
  private readonly inicios = new Map<string, number[]>();
  private readonly emAndamento = new Set<string>();
  /** Só a conta do dia corrente de cada workspace: o dia anterior é descartado ao virar. */
  private readonly doDia = new Map<
    string,
    { readonly dia: string; quantidade: number }
  >();

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
    const dia = diaEmSaoPaulo(agora);
    const contagem = this.doDia.get(workspace);
    const doDia = contagem?.dia === dia ? contagem.quantidade : 0;
    if (this.opcoes.porDia !== undefined && doDia >= this.opcoes.porDia) {
      return { negada: 'dia' };
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
    this.doDia.set(workspace, { dia, quantidade: doDia + 1 });
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
