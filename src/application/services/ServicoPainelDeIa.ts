import {
  diaDeSaoPaulo,
  type EstadoDaFuncao,
} from '../../domain/entities/ControleDaIa.js';
import type { Clock } from '../../domain/ports/Clock.js';
import {
  MOTIVOS_DE_OCORRENCIA_DA_IA,
  type AlteracaoDeConfigDeIa,
  type LeitorDeUsoDeIa,
  type MotivoDeOcorrenciaDaIa,
} from '../../domain/ports/PainelDeIa.js';
import {
  metricasDoConjunto,
  type MetricasDoConjunto,
} from '../politicas/metricasDeIa.js';
import type { ServicoControleDaIa } from './ServicoControleDaIa.js';

export const PERIODOS_DO_PAINEL = ['hoje', '7d', '30d'] as const;
export type PeriodoDoPainel = (typeof PERIODOS_DO_PAINEL)[number];

const DIAS_DO_PERIODO: Readonly<Record<PeriodoDoPainel, number>> = {
  hoje: 0,
  '7d': 6,
  '30d': 29,
};

/** A chamada ao modelo não deu resposta utilizável (rede, tempo, formato): o advogado vê "não foi possível". */
const CHAMADA_SEM_RESPOSTA: readonly MotivoDeOcorrenciaDaIa[] = [
  'chamada_falhou',
  'formato_fora_do_esquema',
  'tempo_esgotado',
];

export interface PainelDaFuncao extends EstadoDaFuncao {
  readonly metricas: MetricasDoConjunto;
  /** Análises que o advogado viu como "não foi possível": não verificadas + chamadas que falharam. */
  readonly naoFoiPossivel: number;
  /** `naoFoiPossivel` sobre (análises + chamadas que falharam); `undefined` sem nenhuma tentativa. */
  readonly taxaNaoFoiPossivel: number | undefined;
  readonly taxaNaoVerificado: number | undefined;
  readonly chamadasQueFalharam: number;
  readonly repeticoesAutomaticas: number;
  /** Fase B (v0.60.0): as mesmas métricas quebradas pelo modelo que serviu cada análise (mais usado primeiro). */
  readonly porModelo: ReadonlyArray<{ readonly modelo: string; readonly metricas: MetricasDoConjunto }>;
  readonly falhasDeVerificacao: ReadonlyArray<{
    readonly motivo: MotivoDeOcorrenciaDaIa;
    readonly contagem: number;
  }>;
}

export interface PainelDeIa {
  readonly periodo: PeriodoDoPainel;
  /** Primeiro dia (São Paulo) do período. */
  readonly desde: string;
  readonly funcoes: readonly PainelDaFuncao[];
  /** Ranking por quantidade de análises: id CURTO da conta, nunca e-mail nem nome. */
  readonly contas: ReadonlyArray<{ readonly conta: string; readonly analises: number }>;
  readonly tetoGlobal: number | null;
  readonly custoDoDia: {
    readonly usd: number;
    readonly alertaUsd: number;
    readonly acima: boolean;
  };
  readonly alteracoes: readonly AlteracaoDeConfigDeIa[];
}

export interface OpcoesDoPainelDeIa {
  readonly controle: ServicoControleDaIa;
  readonly leitor: LeitorDeUsoDeIa;
  readonly clock: Clock;
}

const taxa = (parte: number, total: number): number | undefined =>
  total === 0 ? undefined : parte / total;

/** Instante em que o dia de São Paulo começa (00:00 em -03:00 = 03:00 UTC). */
export function inicioDoDiaDeSaoPaulo(dia: string): Date {
  return new Date(`${dia}T03:00:00.000Z`);
}

function diaMenos(dia: string, dias: number): string {
  const d = new Date(`${dia}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/**
 * A leitura do painel de IA (v0.58.0): junta o estado efetivo (ambiente × painel), as métricas das três
 * tabelas pela MESMA função do relatório e as contagens de falha. Só números: nenhum texto de ato ou de
 * peça, nome de parte, número de processo, e-mail ou chave passa por aqui.
 */
export class ServicoPainelDeIa {
  constructor(private readonly o: OpcoesDoPainelDeIa) {}

  custoDoDia(): { usd: number; alertaUsd: number; acima: boolean } {
    const dia = diaDeSaoPaulo(this.o.clock.agora());
    const usd = this.o.leitor.custoDesde(inicioDoDiaDeSaoPaulo(dia));
    const alertaUsd = this.o.controle.alertaDeCustoUsd();
    return { usd, alertaUsd, acima: usd > alertaUsd };
  }

  painel(periodo: PeriodoDoPainel): PainelDeIa {
    const hoje = diaDeSaoPaulo(this.o.clock.agora());
    const primeiroDia = diaMenos(hoje, DIAS_DO_PERIODO[periodo]);
    const desde = inicioDoDiaDeSaoPaulo(primeiroDia);
    const ocorrencias = this.o.leitor.ocorrencias(primeiroDia);
    const porConta = new Map<string, number>();
    const funcoes = this.o.controle.estados().map((estado) => {
      const linhas = this.o.leitor.linhas(estado.funcao, desde);
      for (const l of linhas) {
        porConta.set(l.workspace, (porConta.get(l.workspace) ?? 0) + 1);
      }
      const metricas = metricasDoConjunto(linhas);
      const porModelo = new Map<string, typeof linhas>();
      for (const l of linhas) porModelo.set(l.modelo, [...(porModelo.get(l.modelo) ?? []), l]);
      const doFuncao = ocorrencias.filter((x) => x.funcao === estado.funcao);
      const total = (m: MotivoDeOcorrenciaDaIa): number =>
        doFuncao.find((x) => x.motivo === m)?.contagem ?? 0;
      const chamadasQueFalharam = CHAMADA_SEM_RESPOSTA.reduce((a, m) => a + total(m), 0);
      const naoFoiPossivel = metricas.naoVerificadas + chamadasQueFalharam;
      return {
        ...estado,
        metricas,
        naoFoiPossivel,
        taxaNaoFoiPossivel: taxa(naoFoiPossivel, metricas.analises + chamadasQueFalharam),
        taxaNaoVerificado: taxa(metricas.naoVerificadas, metricas.analises),
        chamadasQueFalharam,
        repeticoesAutomaticas: total('repeticao_automatica'),
        porModelo: [...porModelo.entries()]
          .map(([modelo, ls]) => ({ modelo, metricas: metricasDoConjunto(ls) }))
          .sort((a, b) => b.metricas.analises - a.metricas.analises || a.modelo.localeCompare(b.modelo)),
        falhasDeVerificacao: MOTIVOS_DE_OCORRENCIA_DA_IA.filter(
          (m) =>
            m !== 'repeticao_automatica' && m !== 'modelo_do_painel_invalido' && total(m) > 0,
        ).map((m) => ({ motivo: m, contagem: total(m) })),
      } satisfies PainelDaFuncao;
    });
    const contas = [...porConta.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([ws, analises]) => ({ conta: ws.slice(0, 8), analises }));
    return {
      periodo,
      desde: primeiroDia,
      funcoes,
      contas,
      tetoGlobal: this.o.controle.config().tetoGlobal,
      custoDoDia: this.custoDoDia(),
      alteracoes: this.o.controle.alteracoes(50),
    };
  }
}
