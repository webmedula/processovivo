import { abrirSomenteLeitura } from '../../infrastructure/persistencia/diagnosticoDeProvidencia.js';
import { media, percentil } from './sondaIaAto.js';

/**
 * Avaliações da análise por IA (`scripts/ia-avaliacoes.mjs`, v1.0.0) — SOMENTE LEITURA.
 *
 * Por modelo e por versão do prompt: quantas análises, quantas avaliações (útil / errado /
 * perigoso), taxa de "não verificado", latência p50/p95 e custo médio. Lê só colunas
 * numéricas e rótulos de `analises_ia`: nunca o resultado, nunca número de processo,
 * nunca workspace. O banco é aberto com `readOnly` + `query_only` e nunca por `abrirBanco`
 * (que cria esquema e migra).
 */
export const VERSAO_DE_AVALIACOES_DE_IA = '1.0.0';

export const USO_DE_AVALIACOES_DE_IA = `Uso: node scripts/ia-avaliacoes.mjs
Mostra, por modelo e versão do prompt, as análises de ato e os resumos de processo, e as avaliações das contas (útil / errado / perigoso). As duas tabelas ficam em seções separadas.`;

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
}

interface Linha {
  modelo: string;
  versao_prompt: string;
  avaliacao: string | null;
  nao_verificada: number;
  latencia_ms: number;
  custo_usd: number | null;
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
      '',
    );
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
    deps.saida(
      `Avaliações da análise por IA v${VERSAO_DE_AVALIACOES_DE_IA} — somente leitura; só contagens e medidas, nenhum texto.`,
    );
    if (!existe && !existeResumo) {
      deps.saida('Nenhuma análise registrada ainda.');
      return 0;
    }
    if (existe) {
      const linhas = db
        .prepare(
          `SELECT modelo, versao_prompt, avaliacao, latencia_ms, custo_usd,
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
          `SELECT modelo, versao_prompt, avaliacao, latencia_ms, custo_usd,
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
    return 0;
  } finally {
    db.close();
  }
}

function tabelaExiste(db: ReturnType<typeof abrirSomenteLeitura>, nome: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(nome) !== undefined
  );
}
