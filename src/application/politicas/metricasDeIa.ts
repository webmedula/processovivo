import { MOTIVOS_DA_AVALIACAO } from '../../domain/entities/AnaliseDoAto.js';
import type { MotivoDaAvaliacao } from '../../domain/entities/AnaliseDoAto.js';
import { media, percentil } from './estatistica.js';

/**
 * As métricas de uso da IA (v0.58.0): UMA função de cálculo, usada pelo painel do /admin e pelo
 * relatório `scripts/ia-avaliacoes.mjs`. Percentil, média, contagem de avaliações e motivos não se
 * reimplementam em nenhum dos dois: o número do painel TEM de ser o do relatório.
 *
 * Só números e rótulos: a entrada não tem campo para texto de ato ou de peça.
 */
export interface LinhaParaMetricas {
  readonly avaliacao: string | null;
  readonly motivoAvaliacao: string | null;
  readonly naoVerificada: boolean;
  readonly latenciaMs: number;
  readonly custoUsd: number | null;
  readonly tokensEntrada?: number | null;
  readonly tokensSaida?: number | null;
}

export interface MetricasDeCusto {
  readonly total: number;
  readonly medio: number | undefined;
  readonly p50: number | undefined;
  readonly p95: number | undefined;
  readonly maximo: number | undefined;
  /** Quantas linhas tinham o custo informado (a média é só sobre elas). */
  readonly comCusto: number;
}

export interface MetricasDoConjunto {
  readonly analises: number;
  readonly util: number;
  readonly errado: number;
  readonly perigoso: number;
  readonly semAvaliacao: number;
  readonly naoVerificadas: number;
  readonly latenciaP50Ms: number | undefined;
  readonly latenciaP95Ms: number | undefined;
  readonly custo: MetricasDeCusto;
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  /** Motivos das avaliações errado/perigoso (lista fechada). */
  readonly motivos: Readonly<Record<MotivoDaAvaliacao, number>>;
  /** Avaliou "errado/perigoso" e não escolheu motivo (ou o motivo não é da lista). */
  readonly semMotivo: number;
}

export function metricasDeCusto(custos: readonly number[]): MetricasDeCusto {
  return {
    total: custos.reduce((a, b) => a + b, 0),
    medio: media(custos),
    p50: percentil(custos, 0.5),
    p95: percentil(custos, 0.95),
    maximo: custos.length === 0 ? undefined : Math.max(...custos),
    comCusto: custos.length,
  };
}

export function metricasDoConjunto(
  linhas: readonly LinhaParaMetricas[],
): MetricasDoConjunto {
  const conta = (v: string): number => linhas.filter((l) => l.avaliacao === v).length;
  const dosMotivos = linhas.filter(
    (l) => l.avaliacao === 'errado' || l.avaliacao === 'perigoso',
  );
  const motivos = Object.fromEntries(
    MOTIVOS_DA_AVALIACAO.map((m) => [
      m,
      dosMotivos.filter((l) => l.motivoAvaliacao === m).length,
    ]),
  ) as Record<MotivoDaAvaliacao, number>;
  const latencias = linhas.map((l) => l.latenciaMs);
  return {
    analises: linhas.length,
    util: conta('util'),
    errado: conta('errado'),
    perigoso: conta('perigoso'),
    semAvaliacao: linhas.filter((l) => l.avaliacao === null).length,
    naoVerificadas: linhas.filter((l) => l.naoVerificada).length,
    latenciaP50Ms: percentil(latencias, 0.5),
    latenciaP95Ms: percentil(latencias, 0.95),
    custo: metricasDeCusto(
      linhas.flatMap((l) => (l.custoUsd === null ? [] : [Number(l.custoUsd)])),
    ),
    tokensEntrada: linhas.reduce((a, l) => a + (l.tokensEntrada ?? 0), 0),
    tokensSaida: linhas.reduce((a, l) => a + (l.tokensSaida ?? 0), 0),
    motivos,
    semMotivo: dosMotivos.filter(
      (l) =>
        l.motivoAvaliacao === null ||
        !(MOTIVOS_DA_AVALIACAO as readonly string[]).includes(l.motivoAvaliacao),
    ).length,
  };
}
