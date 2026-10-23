/**
 * Controle da IA pelo painel do /admin (v0.58.0, Fase A). Política PURA: o vocabulário, os valores
 * padrão e a regra de precedência. Quem lê e grava é o `ServicoControleDaIa`.
 *
 * A regra que não se discute: **a variável de ambiente é a trava mestra**. Uma função só funciona
 * se o ambiente permite E o painel está ligado; o painel pode desligar ou reduzir um teto, nunca
 * ligar o que o ambiente desligou nem subir um teto acima do da variável. Falha do painel (banco,
 * linha corrompida) NUNCA derruba a IA: vale o padrão do código, que é "o painel não restringe nada".
 */
export const FUNCOES_DE_IA = ['ato', 'resumo', 'peca'] as const;
export type FuncaoDeIa = (typeof FUNCOES_DE_IA)[number];

export const ROTULO_DA_FUNCAO: Readonly<Record<FuncaoDeIa, string>> = Object.freeze({
  ato: 'Análise de ato',
  resumo: 'Resumo do processo',
  peca: 'Análise de peça',
});

export function ehFuncaoDeIa(v: unknown): v is FuncaoDeIa {
  return typeof v === 'string' && (FUNCOES_DE_IA as readonly string[]).includes(v);
}

/** Alerta de custo diário padrão (decisão do dono): US$ 3,00 por dia. */
export const ALERTA_DE_CUSTO_PADRAO_USD = 3;
export const ALERTA_MINIMO_USD = 0.01;
export const ALERTA_MAXIMO_USD = 10_000;
/** Teto em "análises" (a peça pesa 5, como no teto técnico de sempre). */
export const TETO_MAXIMO_DO_PAINEL = 100_000;

export interface ConfigDaFuncao {
  readonly ligada: boolean;
  /** Teto de análises por conta e por dia (peso incluso) só desta função; `null` = sem teto do painel. */
  readonly tetoPorConta: number | null;
}

export interface ConfigDoPainel {
  readonly funcoes: Readonly<Record<FuncaoDeIa, ConfigDaFuncao>>;
  /** Teto de análises por dia no servidor inteiro, todas as contas e funções; `null` = sem teto. */
  readonly tetoGlobal: number | null;
  readonly alertaCustoDiaUsd: number;
}

/** O que vale quando o painel nunca foi mexido ou quando ele falha: nada é restringido. */
export const CONFIG_PADRAO_DO_PAINEL: ConfigDoPainel = Object.freeze({
  funcoes: Object.freeze({
    ato: Object.freeze({ ligada: true, tetoPorConta: null }),
    resumo: Object.freeze({ ligada: true, tetoPorConta: null }),
    peca: Object.freeze({ ligada: true, tetoPorConta: null }),
  }),
  tetoGlobal: null,
  alertaCustoDiaUsd: ALERTA_DE_CUSTO_PADRAO_USD,
});

/** O que o AMBIENTE permite (montado no composition root, a partir das variáveis). */
export interface AmbienteDaIa {
  readonly permite: Readonly<Record<FuncaoDeIa, boolean>>;
  /** `PROCESSOVIVO_IA_MAX_POR_DIA`: teto por conta e por dia (compartilhado entre as funções). */
  readonly tetoPorContaDoAmbiente: number;
}

export interface LimitesDoPainel {
  readonly porFuncao: Readonly<Record<FuncaoDeIa, number | undefined>>;
  readonly global: number | undefined;
}

/** O que o `TetoDiario` e os serviços consultam. Síncrono: está no caminho de toda análise. */
export interface ControleDaIa {
  ligada(funcao: FuncaoDeIa): boolean;
  limites(): LimitesDoPainel;
}

/** Sem painel (testes antigos, CLI): tudo como o ambiente já decidiu. */
export const CONTROLE_SEM_PAINEL: ControleDaIa = Object.freeze({
  ligada: () => true,
  limites: () => ({
    porFuncao: { ato: undefined, resumo: undefined, peca: undefined },
    global: undefined,
  }),
});

export interface EstadoDaFuncao {
  readonly funcao: FuncaoDeIa;
  readonly rotulo: string;
  readonly ambientePermite: boolean;
  readonly painelLigado: boolean;
  /** Ambiente permite E painel ligado. */
  readonly efetivamenteLigada: boolean;
  readonly tetoDoPainel: number | null;
  /** Menor entre a variável de ambiente e o painel. */
  readonly tetoEfetivoPorConta: number;
}

export function estadoDaFuncao(
  funcao: FuncaoDeIa,
  ambiente: AmbienteDaIa,
  config: ConfigDoPainel,
): EstadoDaFuncao {
  const c = config.funcoes[funcao];
  const ambientePermite = ambiente.permite[funcao];
  return {
    funcao,
    rotulo: ROTULO_DA_FUNCAO[funcao],
    ambientePermite,
    painelLigado: c.ligada,
    efetivamenteLigada: ambientePermite && c.ligada,
    tetoDoPainel: c.tetoPorConta,
    tetoEfetivoPorConta:
      c.tetoPorConta === null
        ? ambiente.tetoPorContaDoAmbiente
        : Math.min(ambiente.tetoPorContaDoAmbiente, c.tetoPorConta),
  };
}

export function tetoValido(v: unknown): v is number {
  return (
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= TETO_MAXIMO_DO_PAINEL
  );
}

export function alertaValido(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= ALERTA_MINIMO_USD &&
    v <= ALERTA_MAXIMO_USD
  );
}

/** Dia `AAAA-MM-DD` em São Paulo (-03:00 fixo), o mesmo do teto técnico e do calendário. */
export function diaDeSaoPaulo(instante: Date): string {
  return new Date(instante.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}
