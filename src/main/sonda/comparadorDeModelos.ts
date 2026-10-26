import { prepararEntrada } from '../../application/politicas/entradaDoModelo.js';
import type {
  PedidoAoModelo,
  RespostaDoTransporte,
  TransporteDeModelo,
} from '../../infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { escreverCsv } from './casosDaSonda.js';
import { avaliarResposta, type ViolacaoDeProibicao } from './avaliacaoAutomatica.js';
import { paraCasoDaSonda, type CasoDeAvaliacao } from './casosDeAvaliacao.js';
import {
  executarSonda,
  media,
  percentil,
  type PrecoPorToken,
  type RegistroDaChamada,
} from './sondaIaAto.js';

/**
 * Comparador de modelos para a análise do ato (v0.52.0). MANUAL, fora do CI, SÓ casos
 * sintéticos. Reaproveita `executarSonda` (ZDR por chamada, `provider.only`, par modelo +
 * provedor conferido na resposta) e acrescenta: teto de gasto, avaliação automática contra o
 * caso e relatórios sem texto de caso real (não há texto real aqui).
 *
 * Nada em produção muda: o modelo, o prompt e as regras de verificação são os de produção.
 */

export const VERSAO_DO_COMPARADOR = '1.0.0';
export const TETO_PADRAO_USD = 1;

/** Quando nem a resposta nem o preço dizem o custo, cada chamada conta isto contra o teto. */
export const CUSTO_CONSERVADOR_POR_CHAMADA_USD = 0.01;

const TOKENS_DE_SAIDA_ESTIMADOS = 450;
const CARACTERES_POR_TOKEN = 3.5;

export class TetoDeGastoAtingidoError extends Error {
  constructor() {
    super('teto de gasto da rodada atingido');
    this.name = 'TetoDeGastoAtingidoError';
  }
}

/** Soma o gasto de cada chamada e recusa a PRÓXIMA quando o teto já foi alcançado. */
export class TransporteComTeto implements TransporteDeModelo {
  readonly nome: string;
  private gastoUsd = 0;
  private atingido = false;

  constructor(
    private readonly interno: TransporteDeModelo,
    private readonly tetoUsd: number,
    private readonly precos: ReadonlyMap<string, PrecoPorToken> = new Map(),
  ) {
    this.nome = interno.nome;
  }

  get gasto(): number {
    return this.gastoUsd;
  }

  get tetoAtingido(): boolean {
    return this.atingido;
  }

  async gerar(pedido: PedidoAoModelo): Promise<RespostaDoTransporte> {
    if (this.gastoUsd >= this.tetoUsd) {
      this.atingido = true;
      throw new TetoDeGastoAtingidoError();
    }
    try {
      const r = await this.interno.gerar(pedido);
      this.gastoUsd += custoDaResposta(r, this.precos.get(pedido.modelo));
      if (this.gastoUsd >= this.tetoUsd) this.atingido = true;
      return r;
    } catch (erro) {
      // Chamada que falhou pode ter sido cobrada; conta o conservador para o teto nunca subestimar.
      this.gastoUsd += CUSTO_CONSERVADOR_POR_CHAMADA_USD;
      throw erro;
    }
  }
}

function custoDaResposta(
  r: RespostaDoTransporte,
  preco: PrecoPorToken | undefined,
): number {
  if (r.custoUsd !== undefined) return r.custoUsd;
  if (preco && r.tokensEntrada !== undefined && r.tokensSaida !== undefined) {
    return r.tokensEntrada * preco.entrada + r.tokensSaida * preco.saida;
  }
  return CUSTO_CONSERVADOR_POR_CHAMADA_USD;
}

// --- estimativa (modo padrão: nada é enviado) ----------------------------------------

export interface EstimativaDoModelo {
  readonly modelo: string;
  readonly chamadas: number;
  /** `undefined`: sem preço publicado para o modelo; o teto em tempo de execução é a proteção. */
  readonly custoEstimadoUsd?: number;
}

export function estimarCusto(
  casos: readonly CasoDeAvaliacao[],
  modelos: readonly string[],
  precos: ReadonlyMap<string, PrecoPorToken>,
): EstimativaDoModelo[] {
  const entradas = casos.flatMap((c) => {
    const caso = paraCasoDaSonda(c);
    const e = prepararEntrada(
      {
        data: caso.data,
        titulo: caso.titulo,
        conteudo: caso.texto,
        ...(caso.tipoComunicacao ? { tipoComunicacao: caso.tipoComunicacao } : {}),
      },
      { classe: c.classe },
      { pessoas: caso.pessoas },
    );
    return e.suficiente
      ? [(e.sistema.length + e.usuario.length) / CARACTERES_POR_TOKEN]
      : [];
  });
  const tokensDeEntrada = entradas.reduce((a, b) => a + b, 0);
  return modelos.map((modelo) => {
    const preco = precos.get(modelo);
    return {
      modelo,
      chamadas: entradas.length,
      ...(preco
        ? {
            custoEstimadoUsd:
              tokensDeEntrada * preco.entrada +
              entradas.length * TOKENS_DE_SAIDA_ESTIMADOS * preco.saida,
          }
        : {}),
    };
  });
}

// --- execução e métricas ---------------------------------------------------------------

export interface OpcoesDoComparador {
  readonly casos: readonly CasoDeAvaliacao[];
  /** O modelo de produção vem primeiro: é a referência de todas as comparações. */
  readonly modeloDeReferencia: string;
  readonly modelos: readonly string[];
  readonly transporte: TransporteDeModelo;
  readonly provedoresPermitidos: (modelo: string) => readonly string[];
  readonly parConfirmadoZdr: (
    modeloResolvido: string | undefined,
    provedor: string | undefined,
  ) => boolean;
  readonly precos: ReadonlyMap<string, PrecoPorToken>;
  readonly agora: () => number;
  readonly pausaMs?: number;
  readonly dormir?: (ms: number) => Promise<void>;
  readonly progresso?: (linha: string) => void;
  /** O transporte JÁ embrulhado em `TransporteComTeto`, para saber se o teto foi atingido. */
  readonly teto?: TransporteComTeto;
  /** O bloco de instruções do operador (Fase C) a medir. Ausente = o prompt de sempre. */
  readonly instrucao?: string;
}

export interface DetalheDoCaso {
  readonly casoId: string;
  readonly categoria: string;
  readonly modelo: string;
  readonly estado: RegistroDaChamada['estado'];
  readonly resumo: string;
  readonly parecePedir: string;
  readonly pontosCobertos: readonly string[];
  readonly pontosFaltando: readonly string[];
  readonly violacoes: readonly ViolacaoDeProibicao[];
  readonly custoUsd?: number;
}

export interface LinhaDoModelo {
  readonly modelo: string;
  readonly referencia: boolean;
  readonly chamadas: number;
  /** Casos que o produto não manda ao modelo (texto curto demais) e que de fato não foram. */
  readonly semChamadaComoEsperado: number;
  readonly respondidas: number;
  readonly citacaoVerificada?: number;
  readonly citacoesEmitidas: number;
  readonly pontosCobertos: number;
  readonly pontosTotais: number;
  readonly taxaPontos?: number;
  readonly violacoes: Readonly<Record<string, number>>;
  readonly totalViolacoes: number;
  readonly falhasDeFormato: number;
  readonly naoVerificadas: number;
  readonly interrompido: boolean;
  readonly latenciaP50Ms?: number;
  readonly latenciaP95Ms?: number;
  readonly custoMedioUsd?: number;
  readonly custoP95Usd?: number;
  readonly custoMaximoUsd?: number;
  readonly custoTotalUsd?: number;
  readonly fonteDoCusto: 'openrouter' | 'estimativa' | 'nao-medido';
}

export interface ResultadoDaComparacao {
  readonly linhas: readonly LinhaDoModelo[];
  readonly detalhes: readonly DetalheDoCaso[];
  readonly registros: readonly RegistroDaChamada[];
  readonly gastoUsd: number;
  readonly tetoAtingido: boolean;
  readonly modelosParados: readonly { modelo: string; motivo: string }[];
}

export function custoDoRegistro(
  r: RegistroDaChamada,
  precos: ReadonlyMap<string, PrecoPorToken>,
): { valor: number; fonte: 'openrouter' | 'estimativa' } | undefined {
  if (r.custoUsd !== undefined) return { valor: r.custoUsd, fonte: 'openrouter' };
  const p = precos.get(r.modelo);
  if (p && r.tokensEntrada !== undefined && r.tokensSaida !== undefined) {
    return {
      valor: r.tokensEntrada * p.entrada + r.tokensSaida * p.saida,
      fonte: 'estimativa',
    };
  }
  return undefined;
}

export async function compararModelos(
  op: OpcoesDoComparador,
): Promise<ResultadoDaComparacao> {
  const porId = new Map(op.casos.map((c) => [c.id, c]));
  const execucao = await executarSonda({
    casos: op.casos.map(paraCasoDaSonda),
    modelos: op.modelos,
    variantes: ['sem-titulos'],
    transporte: op.transporte,
    ...(op.instrucao ? { instrucao: op.instrucao } : {}),
    provedoresPermitidos: op.provedoresPermitidos,
    parConfirmadoZdr: op.parConfirmadoZdr,
    agora: op.agora,
    ...(op.pausaMs ? { pausaMs: op.pausaMs } : {}),
    ...(op.dormir ? { dormir: op.dormir } : {}),
    ...(op.progresso ? { progresso: op.progresso } : {}),
  });

  const detalhes: DetalheDoCaso[] = [];
  for (const r of execucao.registros) {
    const caso = porId.get(r.casoId);
    if (!caso) continue;
    const avaliacao =
      r.respostaCrua !== undefined ? avaliarResposta(caso, r.respostaCrua) : undefined;
    const v = r.verificacao;
    const custo = custoDoRegistro(r, op.precos);
    detalhes.push({
      casoId: r.casoId,
      categoria: caso.categoria,
      modelo: r.modelo,
      estado: r.estado,
      resumo:
        v?.estado === 'verificada'
          ? (v.resumo ?? '')
          : v
            ? `NÃO VERIFICADO (${v.motivo})`
            : '',
      parecePedir: v?.estado === 'verificada' ? v.parecePedir : '',
      pontosCobertos: avaliacao?.pontosCobertos ?? [],
      pontosFaltando: avaliacao?.pontosFaltando ?? [],
      violacoes: avaliacao?.violacoes ?? [],
      ...(custo ? { custoUsd: custo.valor } : {}),
    });
  }

  const parados = new Set([
    ...execucao.modelosSemZdr,
    ...execucao.modelosSemProvedor.map((m) => m.modelo),
    ...execucao.modelosProvedorNaoConfirmado,
  ]);
  const linhas = op.modelos.map((modelo): LinhaDoModelo => {
    const regs = execucao.registros.filter((r) => r.modelo === modelo);
    const respondidas = regs.filter((r) => r.verificacao !== undefined);
    const dets = detalhes.filter((d) => d.modelo === modelo && d.estado !== 'sem_texto');
    const citacoes = respondidas.flatMap((r) =>
      r.verificacao ? [r.verificacao.citacoes] : [],
    );
    const emitidas = citacoes.reduce((a, c) => a + c.emitidas, 0);
    const validas = citacoes.reduce((a, c) => a + c.validas, 0);
    let cobertos = 0;
    let totais = 0;
    const violacoes: Record<string, number> = {};
    for (const d of dets) {
      cobertos += d.pontosCobertos.length;
      totais += d.pontosCobertos.length + d.pontosFaltando.length;
      for (const x of d.violacoes) violacoes[x] = (violacoes[x] ?? 0) + 1;
    }
    // Resposta que nem chegou a ser avaliada (formato inválido) conta os pontos como não cobertos.
    for (const r of regs.filter((x) => x.estado === 'resposta_invalida')) {
      const caso = porId.get(r.casoId);
      totais += caso?.pontos_obrigatorios.length ?? 0;
    }
    const custos = regs.flatMap((r) => {
      const c = r.verificacao ? custoDoRegistro(r, op.precos) : undefined;
      return c ? [c] : [];
    });
    const valores = custos.map((c) => c.valor);
    const latencias = respondidas.flatMap((r) =>
      r.latenciaMs !== undefined ? [r.latenciaMs] : [],
    );
    const total = valores.reduce((a, b) => a + b, 0);
    const fonte = custos.some((c) => c.fonte === 'openrouter')
      ? 'openrouter'
      : custos.length > 0
        ? 'estimativa'
        : 'nao-medido';
    const mediaDoCusto = media(valores);
    const p50 = percentil(latencias, 0.5);
    const p95 = percentil(latencias, 0.95);
    const cp95 = percentil(valores, 0.95);
    return {
      modelo,
      referencia: modelo === op.modeloDeReferencia,
      chamadas: regs.filter((r) => r.estado !== 'sem_texto').length,
      semChamadaComoEsperado: regs.filter((r) => r.estado === 'sem_texto').length,
      respondidas: respondidas.length,
      ...(emitidas > 0 ? { citacaoVerificada: validas / emitidas } : {}),
      citacoesEmitidas: emitidas,
      pontosCobertos: cobertos,
      pontosTotais: totais,
      ...(totais > 0 ? { taxaPontos: cobertos / totais } : {}),
      violacoes,
      totalViolacoes: Object.values(violacoes).reduce((a, b) => a + b, 0),
      falhasDeFormato: regs.filter((r) => r.estado === 'resposta_invalida').length,
      naoVerificadas: regs.filter((r) => r.estado === 'nao_verificada').length,
      interrompido: parados.has(modelo),
      ...(p50 !== undefined ? { latenciaP50Ms: p50 } : {}),
      ...(p95 !== undefined ? { latenciaP95Ms: p95 } : {}),
      ...(mediaDoCusto !== undefined ? { custoMedioUsd: mediaDoCusto } : {}),
      ...(cp95 !== undefined ? { custoP95Usd: cp95 } : {}),
      ...(valores.length > 0 ? { custoMaximoUsd: Math.max(...valores) } : {}),
      ...(valores.length > 0 ? { custoTotalUsd: total } : {}),
      fonteDoCusto: fonte,
    };
  });

  return {
    linhas,
    detalhes,
    registros: execucao.registros,
    gastoUsd: op.teto?.gasto ?? linhas.reduce((a, l) => a + (l.custoTotalUsd ?? 0), 0),
    tetoAtingido: op.teto?.tetoAtingido ?? false,
    modelosParados: [
      ...execucao.modelosSemZdr.map((modelo) => ({ modelo, motivo: 'sem ZDR' })),
      ...execucao.modelosSemProvedor.map((m) => ({
        modelo: m.modelo,
        motivo: 'sem provedor',
      })),
      ...execucao.modelosProvedorNaoConfirmado.map((modelo) => ({
        modelo,
        motivo: 'provedor não confirmado na lista ZDR',
      })),
      ...execucao.modelosComFalha,
    ],
  };
}

// --- relatórios --------------------------------------------------------------------------

const pct = (v: number | undefined): string =>
  v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
const seg = (v: number | undefined): string =>
  v === undefined ? '—' : `${(v / 1000).toFixed(1)} s`;
const usd = (v: number | undefined): string =>
  v === undefined ? '—' : `US$ ${v.toFixed(5)}`;

export interface MetaDoRelatorio {
  readonly data: string;
  readonly casos: number;
  readonly tetoUsd: number;
  readonly versaoPrompt: string;
  readonly versaoDasRegras: string;
}

const NOMES_DAS_VIOLACOES: Readonly<Record<string, string>> = {
  calcular_prazo: 'calculou prazo',
  prazo_inventado: 'prazo estruturado inventado',
  inventar_valor: 'inventou valor/número',
  inventar_data: 'inventou data',
  inventar_nome: 'inventou nome (indício)',
  dar_conselho: 'deu conselho',
};

export function relatorioEmMarkdown(
  res: ResultadoDaComparacao,
  meta: MetaDoRelatorio,
): string {
  const l: string[] = [];
  l.push(
    `# Comparação de modelos — análise do ato (comparador ${VERSAO_DO_COMPARADOR})`,
    '',
  );
  l.push(
    `Data: ${meta.data} · casos sintéticos: ${meta.casos} · prompt ${meta.versaoPrompt} · regras de verificação ${meta.versaoDasRegras}.`,
    `Teto de gasto da rodada: US$ ${meta.tetoUsd.toFixed(2)} · gasto contado: ${usd(res.gastoUsd)}${res.tetoAtingido ? ' · **TETO ATINGIDO: a rodada ficou incompleta**' : ''}.`,
    '',
    '> Só casos inventados; nenhum texto de processo real entrou nesta rodada. A avaliação automática é um filtro, não um juiz: ' +
      'pontos obrigatórios e violações se medem por padrão e podem errar — a revisão humana (CSV) é quem decide.',
    '> **Preços não confirmados:** o custo vem do `usage.cost` devolvido pelo OpenRouter quando existe; senão é estimativa (tokens × preço de lista), e a coluna "origem do custo" diz qual. Confirme com o provedor antes de decidir.',
    '',
    '## Resultado por modelo',
    '',
    '| Modelo | Chamadas | Citação verificada | Pontos obrigatórios | Violações | Falhas de formato | Não verificadas | Latência p50 / p95 | Custo médio | Custo p95 | Custo máx. | Custo total | Origem do custo |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const m of res.linhas) {
    l.push(
      `| ${m.modelo}${m.referencia ? ' (produção)' : ''}${m.interrompido ? ' (interrompido)' : ''} | ${m.chamadas} | ${pct(m.citacaoVerificada)} | ${m.pontosCobertos}/${m.pontosTotais} (${pct(m.taxaPontos)}) | ${m.totalViolacoes} | ${m.falhasDeFormato} | ${m.naoVerificadas} | ${seg(m.latenciaP50Ms)} / ${seg(m.latenciaP95Ms)} | ${usd(m.custoMedioUsd)} | ${usd(m.custoP95Usd)} | ${usd(m.custoMaximoUsd)} | ${usd(m.custoTotalUsd)} | ${m.fonteDoCusto} |`,
    );
  }
  l.push('', '## Violações por tipo', '');
  for (const m of res.linhas) {
    const itens = Object.entries(m.violacoes).map(
      ([k, n]) => `${NOMES_DAS_VIOLACOES[k] ?? k}: ${n}`,
    );
    l.push(`- ${m.modelo}: ${itens.length > 0 ? itens.join(' · ') : 'nenhuma'}`);
  }
  if (res.modelosParados.length > 0) {
    l.push('', '## Modelos parados', '');
    for (const p of res.modelosParados) l.push(`- ${p.modelo}: ${p.motivo}`);
  }
  l.push(
    '',
    '## Como ler',
    '',
    '- **Citação verificada**: parte das citações do modelo que existem literalmente no texto enviado (mínimo de produção: 95%).',
    '- **Pontos obrigatórios**: o que cada caso exige que a resposta diga (ex.: o prazo escrito no ato).',
    '- **Violações**: a resposta calculou prazo, inventou valor, data ou nome, ou deu conselho.',
    '- **Falhas de formato**: a resposta não obedeceu ao esquema, mesmo depois de uma repetição.',
    '- Nenhum modelo entra em produção por este relatório: a troca é decisão do dono, depois da revisão humana.',
    '',
  );
  return l.join('\n');
}

export function metricasEmCsv(res: ResultadoDaComparacao): string {
  const n = (v: number | undefined, casas: number): string =>
    v === undefined ? '' : v.toFixed(casas).replace('.', ',');
  return escreverCsv([
    [
      'modelo',
      'referencia',
      'chamadas',
      'citacao_verificada',
      'pontos_cobertos',
      'pontos_totais',
      'violacoes',
      'falhas_de_formato',
      'nao_verificadas',
      'latencia_p50_ms',
      'latencia_p95_ms',
      'custo_medio_usd',
      'custo_p95_usd',
      'custo_maximo_usd',
      'custo_total_usd',
      'origem_do_custo',
    ],
    ...res.linhas.map((m) => [
      m.modelo,
      m.referencia ? 'sim' : 'nao',
      String(m.chamadas),
      n(m.citacaoVerificada, 4),
      String(m.pontosCobertos),
      String(m.pontosTotais),
      String(m.totalViolacoes),
      String(m.falhasDeFormato),
      String(m.naoVerificadas),
      n(m.latenciaP50Ms, 0),
      n(m.latenciaP95Ms, 0),
      n(m.custoMedioUsd, 6),
      n(m.custoP95Usd, 6),
      n(m.custoMaximoUsd, 6),
      n(m.custoTotalUsd, 6),
      m.fonteDoCusto,
    ]),
  ]);
}

/** Célula de texto que começa com `=`, `+`, `-`, `@`, tabulação ou CR vira texto, nunca fórmula. */
export function celulaSegura(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** Para o revisor humano: uma linha por (caso, modelo), com a coluna de avaliação vazia. */
export function revisaoHumanaEmCsv(res: ResultadoDaComparacao): string {
  return escreverCsv([
    [
      'caso',
      'categoria',
      'modelo',
      'estado',
      'parece_pedir',
      'resumo',
      'pontos_faltando',
      'violacoes_automaticas',
      'avaliacao',
      'observacao',
    ],
    ...res.detalhes
      .filter((d) => d.estado !== 'sem_texto')
      .map((d) => [
        d.casoId,
        d.categoria,
        d.modelo,
        d.estado,
        d.parecePedir,
        celulaSegura(d.resumo),
        d.pontosFaltando.join(' | '),
        d.violacoes.join(' | '),
        '',
        '',
      ]),
  ]);
}
