import { MOTIVOS_DA_AVALIACAO } from '../../domain/entities/AnaliseDoAto.js';
import type { MotivoDaAvaliacao } from '../../domain/entities/AnaliseDoAto.js';
import { abrirSomenteLeitura } from '../../infrastructure/persistencia/diagnosticoDeProvidencia.js';
import { media, percentil } from './sondaIaAto.js';

/**
 * Avaliações da análise por IA (`scripts/ia-avaliacoes.mjs`, v1.0.0) — SOMENTE LEITURA.
 *
 * Por modelo e por versão do prompt: quantas análises, quantas avaliações (útil / errado /
 * perigoso), taxa de "não verificado", latência p50/p95, custo médio, p50, p95 e máximo (v1.1.0) e a
 * contagem por MOTIVO das avaliações errado/perigoso (v1.1.0). Lê só colunas
 * numéricas e rótulos de `analises_ia`: nunca o resultado, nunca número de processo,
 * nunca workspace. O banco é aberto com `readOnly` + `query_only` e nunca por `abrirBanco`
 * (que cria esquema e migra).
 */
export const VERSAO_DE_AVALIACOES_DE_IA = '1.2.0';

export const USO_DE_AVALIACOES_DE_IA = `Uso: node scripts/ia-avaliacoes.mjs
Mostra, por modelo e versão do prompt, as análises de ato, os resumos de processo e as análises de peça, e as avaliações das contas (útil / errado / perigoso). As três tabelas ficam em seções separadas.`;

export interface LinhaDeAvaliacoes {
  readonly modelo: string;
  readonly versaoPrompt: string;
  readonly analises: number;
  readonly util: number;
  readonly errado: number;
  readonly perigoso: number;
  readonly semAvaliacao: number;
  readonly naoVerificadas: number;
  readonly latenciaP50Ms: number | undefined;
  readonly latenciaP95Ms: number | undefined;
  readonly custoMedioUsd: number | undefined;
  /** Quantas análises tinham o custo informado (a média é só sobre elas). */
  readonly comCusto: number;
  readonly custoP50Usd: number | undefined;
  readonly custoP95Usd: number | undefined;
  readonly custoMaximoUsd: number | undefined;
  /** Motivos das avaliações errado/perigoso (lista fechada); `semMotivo` = avaliou e não escolheu. */
  readonly motivos: Readonly<Record<MotivoDaAvaliacao, number>>;
  readonly semMotivo: number;
}

interface Linha {
  modelo: string;
  versao_prompt: string;
  avaliacao: string | null;
  nao_verificada: number;
  latencia_ms: number;
  custo_usd: number | null;
  /** Ausente em banco de antes da v0.52.0 (a coluna ainda não existe). */
  motivo_avaliacao?: string | null;
}

export function agruparAvaliacoes(linhas: readonly Linha[]): LinhaDeAvaliacoes[] {
  const grupos = new Map<string, Linha[]>();
  for (const l of linhas) {
    const chave = `${l.modelo}\u0000${l.versao_prompt}`;
    grupos.set(chave, [...(grupos.get(chave) ?? []), l]);
  }
  return [...grupos.values()]
    .map((g) => {
      const primeira = g[0] as Linha;
      const custos = g.flatMap((l) =>
        l.custo_usd === null ? [] : [Number(l.custo_usd)],
      );
      const latencias = g.map((l) => Number(l.latencia_ms));
      const conta = (v: string): number => g.filter((l) => l.avaliacao === v).length;
      const dosMotivos = g.filter(
        (l) => l.avaliacao === 'errado' || l.avaliacao === 'perigoso',
      );
      const motivos = Object.fromEntries(
        MOTIVOS_DA_AVALIACAO.map((m) => [
          m,
          dosMotivos.filter((l) => l.motivo_avaliacao === m).length,
        ]),
      ) as Record<MotivoDaAvaliacao, number>;
      return {
        modelo: primeira.modelo,
        versaoPrompt: primeira.versao_prompt,
        analises: g.length,
        util: conta('util'),
        errado: conta('errado'),
        perigoso: conta('perigoso'),
        semAvaliacao: g.filter((l) => l.avaliacao === null).length,
        naoVerificadas: g.filter((l) => Number(l.nao_verificada) === 1).length,
        latenciaP50Ms: percentil(latencias, 0.5),
        latenciaP95Ms: percentil(latencias, 0.95),
        custoMedioUsd: media(custos),
        comCusto: custos.length,
        custoP50Usd: percentil(custos, 0.5),
        custoP95Usd: percentil(custos, 0.95),
        custoMaximoUsd: custos.length === 0 ? undefined : Math.max(...custos),
        motivos,
        semMotivo: dosMotivos.filter(
          (l) =>
            l.motivo_avaliacao === null ||
            l.motivo_avaliacao === undefined ||
            !(MOTIVOS_DA_AVALIACAO as readonly string[]).includes(l.motivo_avaliacao),
        ).length,
      };
    })
    .sort(
      (a, b) =>
        a.modelo.localeCompare(b.modelo) || a.versaoPrompt.localeCompare(b.versaoPrompt),
    );
}

const pct = (parte: number, total: number): string =>
  total === 0 ? '—' : `${((parte / total) * 100).toFixed(0)}%`;
const ms = (v: number | undefined): string =>
  v === undefined ? '—' : `${(v / 1000).toFixed(1)} s`;
const ROTULO_DO_MOTIVO: Readonly<Record<MotivoDaAvaliacao, string>> = {
  erro_de_fato: 'erro de fato',
  citacao_inventada: 'citação inventada',
  concluiu_prazo: 'concluiu prazo',
  deixou_de_fora: 'deixou de fora algo importante',
  outro: 'outro',
};
const usd = (v: number | undefined): string =>
  v === undefined ? 'não informado' : `US$ ${v.toFixed(5)}`;

export function linhasDeAvaliacoes(grupos: readonly LinhaDeAvaliacoes[]): string[] {
  if (grupos.length === 0) return ['Nenhuma análise registrada ainda.'];
  const saida: string[] = [];
  for (const g of grupos) {
    const avaliadas = g.util + g.errado + g.perigoso;
    saida.push(
      `Modelo ${g.modelo} · prompt ${g.versaoPrompt}`,
      `  Análises: ${g.analises} · avaliadas: ${avaliadas} · sem avaliação: ${g.semAvaliacao}`,
      `  Útil: ${g.util} (${pct(g.util, avaliadas)}) · Errado: ${g.errado} (${pct(g.errado, avaliadas)}) · Perigoso: ${g.perigoso} (${pct(g.perigoso, avaliadas)})`,
      `  Não verificadas: ${g.naoVerificadas} (${pct(g.naoVerificadas, g.analises)})`,
      `  Latência: p50 ${ms(g.latenciaP50Ms)} · p95 ${ms(g.latenciaP95Ms)}`,
      `  Custo médio por análise: ${usd(g.custoMedioUsd)}${g.comCusto < g.analises ? ` (informado em ${g.comCusto} de ${g.analises})` : ''}`,
      `  Custo p50 ${usd(g.custoP50Usd)} · p95 ${usd(g.custoP95Usd)} · máximo ${usd(g.custoMaximoUsd)}`,
    );
    if (g.errado + g.perigoso > 0) {
      saida.push(
        `  Motivos (Errado/Perigoso): ${MOTIVOS_DA_AVALIACAO.map((m) => `${ROTULO_DO_MOTIVO[m]} ${g.motivos[m]}`).join(' · ')} · sem motivo ${g.semMotivo}`,
      );
    }
    saida.push('');
  }
  return saida;
}

export interface DependenciasDeAvaliacoes {
  readonly caminhoBanco: string;
  readonly saida: (linha: string) => void;
  readonly aviso: (linha: string) => void;
}

/** Devolve o código de saída. */
export function executarAvaliacoesDeIa(
  argv: readonly string[],
  deps: DependenciasDeAvaliacoes,
): number {
  if (argv.includes('--ajuda')) {
    deps.saida(USO_DE_AVALIACOES_DE_IA);
    return 0;
  }
  if (argv.length > 0) {
    deps.aviso(`argumento desconhecido: ${argv[0] ?? ''}`);
    deps.aviso(USO_DE_AVALIACOES_DE_IA);
    return 2;
  }
  let db;
  try {
    db = abrirSomenteLeitura(deps.caminhoBanco);
  } catch {
    deps.aviso(
      'Não consegui abrir o banco em modo somente leitura (caminho ou permissão).',
    );
    return 1;
  }
  try {
    const existe = tabelaExiste(db, 'analises_ia');
    const existeResumo = tabelaExiste(db, 'resumos_ia');
    const existePeca = tabelaExiste(db, 'analises_pecas_ia');
    deps.saida(
      `Avaliações da análise por IA v${VERSAO_DE_AVALIACOES_DE_IA} — somente leitura; só contagens e medidas, nenhum texto.`,
    );
    if (!existe && !existeResumo && !existePeca) {
      deps.saida('Nenhuma análise registrada ainda.');
      return 0;
    }
    if (existe) {
      const linhas = db
        .prepare(
          `SELECT modelo, versao_prompt, avaliacao, latencia_ms, custo_usd, ${colunaDoMotivo(db, 'analises_ia')},
                  CASE WHEN json_extract(resultado, '$.estado') = 'nao_verificada' THEN 1 ELSE 0 END AS nao_verificada
             FROM analises_ia`,
        )
        .all() as unknown as Linha[];
      deps.saida('');
      for (const l of linhasDeAvaliacoes(agruparAvaliacoes(linhas))) deps.saida(l);
    }
    // Resumos de processo (v0.40.0): outra tabela, outra seção — as métricas nunca se misturam
    // com as da análise de ato.
    if (existeResumo) {
      const linhas = db
        .prepare(
          `SELECT modelo, versao_prompt, avaliacao, latencia_ms, custo_usd, ${colunaDoMotivo(db, 'resumos_ia')},
                  CASE WHEN json_extract(resultado, '$.estado') = 'nao_verificado' THEN 1 ELSE 0 END AS nao_verificada
             FROM resumos_ia`,
        )
        .all() as unknown as Linha[];
      deps.saida('');
      deps.saida('Resumos de processo');
      deps.saida('');
      const grupos = agruparAvaliacoes(linhas);
      if (grupos.length === 0) deps.saida('Nenhum resumo registrado ainda.');
      else for (const l of linhasDeAvaliacoes(grupos)) deps.saida(l);
    }
    // Análises de peça (v0.55.0): terceira tabela, terceira seção. Só rótulos e medidas — o resultado
    // (que tem citações curtas) nunca é lido, só o `estado` dentro dele.
    if (existePeca) {
      const linhas = db
        .prepare(
          `SELECT modelo, versao_prompt, avaliacao, latencia_ms, custo_usd, ${colunaDoMotivo(db, 'analises_pecas_ia')},
                  CASE WHEN json_extract(resultado, '$.estado') = 'nao_verificada' THEN 1 ELSE 0 END AS nao_verificada
             FROM analises_pecas_ia`,
        )
        .all() as unknown as Linha[];
      deps.saida('');
      deps.saida('Análises de peça (o resultado guardado vence em 30 dias: a série é a das vigentes)');
      deps.saida('');
      const grupos = agruparAvaliacoes(linhas);
      if (grupos.length === 0) deps.saida('Nenhuma análise de peça registrada ainda.');
      else for (const l of linhasDeAvaliacoes(grupos)) deps.saida(l);
    }
    return 0;
  } finally {
    db.close();
  }
}

/** Banco de antes da v0.52.0 não tem a coluna: o relatório continua funcionando, sem os motivos. */
function colunaDoMotivo(
  db: ReturnType<typeof abrirSomenteLeitura>,
  tabela: string,
): string {
  const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all() as Array<{
    name: string;
  }>;
  return colunas.some((c) => c.name === 'motivo_avaliacao')
    ? 'motivo_avaliacao'
    : 'NULL AS motivo_avaliacao';
}

function tabelaExiste(db: ReturnType<typeof abrirSomenteLeitura>, nome: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(nome) !== undefined
  );
}
