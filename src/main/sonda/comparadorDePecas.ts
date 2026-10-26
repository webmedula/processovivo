import type { TransporteDeModelo } from '../../infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { escreverCsv, lerCsv } from './casosDaSonda.js';
import { avaliarPeca, type ViolacaoDePeca } from './avaliacaoDePeca.js';
import {
  celulaSegura,
  custoDoRegistro,
  type EstimativaDoModelo,
  type TransporteComTeto,
} from './comparadorDeModelos.js';
import {
  paraCasoDaSondaDePeca,
  pecaParaMontar,
  type CasoDePeca,
} from './casosDePecas.js';
import { lerRespostaDePeca, type RespostaDePeca } from './esquemaDePeca.js';
import { montarEntradaDePeca, VERSAO_DO_PROMPT_DE_PECA } from './promptDePeca.js';
import {
  INSTRUCAO_DE_FORMATO_DA_PECA,
  montarEntradaDaPeca,
} from '../../application/politicas/entradaDaPeca.js';
import { lerRespostaDaAnaliseDePeca } from '../../infrastructure/adapters/modelo/esquemaDaPeca.js';
import {
  executarSonda,
  media,
  percentil,
  type PrecoPorToken,
  type RegistroDaChamada,
  type TarefaDaSonda,
} from './sondaIaAto.js';
import { verificarPeca, type ResultadoDaVerificacaoDePeca } from './verificarPeca.js';

/**
 * Comparador de modelos para a leitura de PEÇAS (v0.53.0, Fase 0). MANUAL, fora do CI, só casos
 * sintéticos. Roda sobre `executarSonda` (a mesma ZDR por chamada, `provider.only`, conferência do
 * par modelo + provedor, repetição única fora do esquema) trocando só a tarefa: entrada em páginas,
 * esquema de peça e verificação por (página, trecho). O gasto passa pelo `TransporteComTeto`.
 *
 * Nada em produção muda: não há rota, botão nem uso do esquema fora daqui.
 */

export const VERSAO_DO_COMPARADOR_DE_PECAS = '1.0.0';

/** Seção 8 da especificação: o que decide seguir para a Fase 1. */
export const CRITERIO_DA_FASE_1 = Object.freeze({
  citacaoVerificadaMinima: 0.95,
  perigosoMaximo: 0,
  erradoMaximo: 0.1,
  pedidosPrincipaisMinimo: 0.9,
});

/** Teto de saída e espera da análise de peça em produção (os padrões de `PROCESSOVIVO_IA_PECAS_*`). */
const MAX_TOKENS_DA_PECA_EM_PRODUCAO = 2500;
const TIMEOUT_DA_PECA_EM_PRODUCAO_MS = 120_000;

/**
 * A entrada que a PRODUÇÃO montaria (prompt `peca-1.1.0`, mesma redação, mesmo formato). A do comparador
 * manual é a da Fase 0; o teste obrigatório do painel de IA (v0.60.0) mede o modelo com a de produção.
 */
function entradaDeProducao(
  c: CasoDePeca,
  instrucao?: string,
): ReturnType<typeof montarEntradaDePeca> {
  const m = pecaParaMontar(c);
  const e = montarEntradaDaPeca(m.paginas, m.pessoas ?? {}, {
    ...(instrucao ? { instrucao } : {}),
  });
  return {
    suficiente: e.suficiente,
    ...(e.recusa ? { recusa: e.recusa } : {}),
    sistema: e.sistema,
    usuario: e.usuario,
    textoEnviado: e.textoEnviado,
    instrucaoDeFormato: INSTRUCAO_DE_FORMATO_DA_PECA,
    maxTokens: MAX_TOKENS_DA_PECA_EM_PRODUCAO,
    timeoutMs: TIMEOUT_DA_PECA_EM_PRODUCAO_MS,
  };
}

const TOKENS_DE_SAIDA_ESTIMADOS = 900;
const CARACTERES_POR_TOKEN = 3.5;

export function estimarCustoDePecas(
  casos: readonly CasoDePeca[],
  modelos: readonly string[],
  precos: ReadonlyMap<string, PrecoPorToken>,
  entradaDeProducaoDoPainel = false,
): EstimativaDoModelo[] {
  const entradas = casos.flatMap((c) => {
    const e = entradaDeProducaoDoPainel
      ? entradaDeProducao(c)
      : montarEntradaDePeca(pecaParaMontar(c));
    return e.suficiente
      ? [
          (e.sistema.length + e.usuario.length + e.instrucaoDeFormato.length) /
            CARACTERES_POR_TOKEN,
        ]
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

export interface OpcoesDoComparadorDePecas {
  readonly casos: readonly CasoDePeca[];
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
  readonly teto?: TransporteComTeto;
  /** Usa o prompt, o esquema e a verificação de PRODUÇÃO (teste de modelo do painel). Padrão: os da Fase 0. */
  readonly entradaDeProducao?: boolean;
  /** O bloco de instruções do operador (Fase C) a medir; só vale com `entradaDeProducao`. */
  readonly instrucao?: string;
}

export interface DetalheDaPeca {
  readonly casoId: string;
  readonly categoria: string;
  readonly modelo: string;
  readonly estado: RegistroDaChamada['estado'];
  readonly tipoDaPeca: string;
  readonly pedidos: readonly string[];
  readonly pontosFaltando: readonly string[];
  readonly violacoes: readonly ViolacaoDePeca[];
}

export interface LinhaDoModeloDePecas {
  readonly modelo: string;
  readonly referencia: boolean;
  readonly chamadas: number;
  readonly respondidas: number;
  readonly citacoesEmitidas: number;
  readonly citacaoVerificada?: number;
  readonly pontosAchados: number;
  readonly pontosComPaginaCerta: number;
  readonly pontosTotais: number;
  readonly taxaPontos?: number;
  readonly casosComGabarito: number;
  readonly casosComPedidosPrincipais: number;
  readonly taxaPedidosPrincipais?: number;
  readonly tipoCerto: number;
  readonly violacoes: Readonly<Record<string, number>>;
  readonly totalViolacoes: number;
  readonly falhasDeFormato: number;
  readonly naoVerificadas: number;
  readonly interrompido: boolean;
  readonly latenciaP50Ms?: number;
  readonly latenciaP95Ms?: number;
  readonly custoMedioUsd?: number;
  readonly custoP50Usd?: number;
  readonly custoP95Usd?: number;
  readonly custoMaximoUsd?: number;
  readonly custoTotalUsd?: number;
  readonly fonteDoCusto: 'openrouter' | 'estimativa' | 'nao-medido';
}

export interface ResultadoDaComparacaoDePecas {
  readonly linhas: readonly LinhaDoModeloDePecas[];
  readonly detalhes: readonly DetalheDaPeca[];
  readonly registros: readonly RegistroDaChamada[];
  readonly gastoUsd: number;
  readonly tetoAtingido: boolean;
  readonly modelosParados: readonly { modelo: string; motivo: string }[];
}

export async function compararPecas(
  op: OpcoesDoComparadorDePecas,
): Promise<ResultadoDaComparacaoDePecas> {
  const porId = new Map(op.casos.map((c) => [c.id, c]));
  const producao = op.entradaDeProducao === true;
  // O esquema de produção é um superconjunto do da Fase 0 (acrescenta `determinacoes` e os tipos de ato do
  // juízo); a avaliação só lê os campos que os dois têm.
  const ler = (bruto: unknown): RespostaDePeca | undefined =>
    producao
      ? (lerRespostaDaAnaliseDePeca(bruto) as unknown as RespostaDePeca | undefined)
      : lerRespostaDePeca(bruto);
  const tarefa: TarefaDaSonda = {
    preparar: (caso) => {
      const c = porId.get(caso.id);
      if (!c) throw new Error('caso de peça desconhecido');
      return producao
        ? entradaDeProducao(c, op.instrucao)
        : montarEntradaDePeca(pecaParaMontar(c));
    },
    lerResposta: ler,
    verificar: (resposta, texto) => {
      const v = verificarPeca(resposta as RespostaDePeca, texto);
      return { estado: v.estado, resultado: v };
    },
  };
  const execucao = await executarSonda({
    casos: op.casos.map(paraCasoDaSondaDePeca),
    modelos: op.modelos,
    variantes: ['sem-titulos'],
    transporte: op.transporte,
    tarefa,
    provedoresPermitidos: op.provedoresPermitidos,
    parConfirmadoZdr: op.parConfirmadoZdr,
    agora: op.agora,
    ...(op.pausaMs ? { pausaMs: op.pausaMs } : {}),
    ...(op.dormir ? { dormir: op.dormir } : {}),
    ...(op.progresso ? { progresso: op.progresso } : {}),
  });

  interface Medida {
    readonly r: RegistroDaChamada;
    readonly caso: CasoDePeca;
    readonly verificacao: ResultadoDaVerificacaoDePeca;
    readonly avaliacao: ReturnType<typeof avaliarPeca>;
  }
  const medidas: Medida[] = [];
  const detalhes: DetalheDaPeca[] = [];
  for (const r of execucao.registros) {
    const caso = porId.get(r.casoId);
    if (!caso) continue;
    const verificacao = r.resultadoDaTarefa as ResultadoDaVerificacaoDePeca | undefined;
    const resposta = r.respostaCrua !== undefined ? ler(r.respostaCrua) : undefined;
    if (verificacao && resposta) {
      const avaliacao = avaliarPeca(caso, resposta, verificacao, r.respostaCrua);
      medidas.push({ r, caso, verificacao, avaliacao });
      detalhes.push({
        casoId: r.casoId,
        categoria: caso.categoria,
        modelo: r.modelo,
        estado: r.estado,
        tipoDaPeca: resposta.tipo_da_peca,
        pedidos:
          verificacao.estado === 'verificada'
            ? verificacao.pedidos.map((p) => p.texto)
            : [],
        pontosFaltando: avaliacao.pontosFaltando,
        violacoes: avaliacao.violacoes,
      });
    } else if (r.estado !== 'sem_texto') {
      detalhes.push({
        casoId: r.casoId,
        categoria: caso.categoria,
        modelo: r.modelo,
        estado: r.estado,
        tipoDaPeca: '',
        pedidos: [],
        pontosFaltando: caso.pontos_obrigatorios.map((p) => p.id),
        violacoes: [],
      });
    }
  }

  const parados = new Set([
    ...execucao.modelosSemZdr,
    ...execucao.modelosSemProvedor.map((m) => m.modelo),
    ...execucao.modelosProvedorNaoConfirmado,
  ]);
  const linhas = op.modelos.map((modelo): LinhaDoModeloDePecas => {
    const regs = execucao.registros.filter((r) => r.modelo === modelo);
    const dele = medidas.filter((m) => m.r.modelo === modelo);
    const emitidas = dele.reduce((a, m) => a + m.verificacao.citacoes.emitidas, 0);
    const validas = dele.reduce((a, m) => a + m.verificacao.citacoes.validas, 0);
    let achados = 0;
    let comPagina = 0;
    let totais = 0;
    let tipoCerto = 0;
    let comGabarito = 0;
    let principaisOk = 0;
    const violacoes: Record<string, number> = {};
    for (const m of dele) {
      achados += m.avaliacao.pontosAchados.length;
      comPagina += m.avaliacao.pontosComPaginaCerta.length;
      totais += m.caso.pontos_obrigatorios.length;
      if (m.avaliacao.tipoCerto) tipoCerto += 1;
      if (m.avaliacao.pedidosPrincipaisAchados !== undefined) {
        comGabarito += 1;
        if (m.avaliacao.pedidosPrincipaisAchados) principaisOk += 1;
      }
      for (const v of m.avaliacao.violacoes) violacoes[v] = (violacoes[v] ?? 0) + 1;
    }
    // Peça cuja resposta saiu do esquema: os pontos e o pedido principal contam como NÃO achados.
    for (const r of regs.filter((x) => x.estado === 'resposta_invalida')) {
      const caso = porId.get(r.casoId);
      if (!caso) continue;
      totais += caso.pontos_obrigatorios.length;
      if ((caso.pedidos_principais ?? []).length > 0) comGabarito += 1;
    }
    const custos = regs.flatMap((r) => {
      const c = r.resultadoDaTarefa ? custoDoRegistro(r, op.precos) : undefined;
      return c ? [c] : [];
    });
    const valores = custos.map((c) => c.valor);
    const latencias = regs.flatMap((r) =>
      r.resultadoDaTarefa !== undefined && r.latenciaMs !== undefined
        ? [r.latenciaMs]
        : [],
    );
    const p50 = percentil(latencias, 0.5);
    const p95 = percentil(latencias, 0.95);
    const mc = media(valores);
    return {
      modelo,
      referencia: modelo === op.modeloDeReferencia,
      chamadas: regs.filter((r) => r.estado !== 'sem_texto').length,
      respondidas: dele.length,
      citacoesEmitidas: emitidas,
      ...(emitidas > 0 ? { citacaoVerificada: validas / emitidas } : {}),
      pontosAchados: achados,
      pontosComPaginaCerta: comPagina,
      pontosTotais: totais,
      ...(totais > 0 ? { taxaPontos: achados / totais } : {}),
      casosComGabarito: comGabarito,
      casosComPedidosPrincipais: principaisOk,
      ...(comGabarito > 0 ? { taxaPedidosPrincipais: principaisOk / comGabarito } : {}),
      tipoCerto,
      violacoes,
      totalViolacoes: Object.values(violacoes).reduce((a, b) => a + b, 0),
      falhasDeFormato: regs.filter((r) => r.estado === 'resposta_invalida').length,
      naoVerificadas: regs.filter((r) => r.estado === 'nao_verificada').length,
      interrompido: parados.has(modelo),
      ...(p50 !== undefined ? { latenciaP50Ms: p50 } : {}),
      ...(p95 !== undefined ? { latenciaP95Ms: p95 } : {}),
      ...(mc !== undefined ? { custoMedioUsd: mc } : {}),
      ...(valores.length > 0 ? { custoP50Usd: percentil(valores, 0.5) ?? 0 } : {}),
      ...(valores.length > 0 ? { custoP95Usd: percentil(valores, 0.95) ?? 0 } : {}),
      ...(valores.length > 0 ? { custoMaximoUsd: Math.max(...valores) } : {}),
      ...(valores.length > 0
        ? { custoTotalUsd: valores.reduce((a, b) => a + b, 0) }
        : {}),
      fonteDoCusto: custos.some((c) => c.fonte === 'openrouter')
        ? 'openrouter'
        : custos.length > 0
          ? 'estimativa'
          : 'nao-medido',
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

// --- critério e relatórios -----------------------------------------------------------------

export type Veredito = 'cumpre' | 'nao_cumpre' | 'sem_dado';

export interface CriteriosAutomaticos {
  readonly citacaoVerificada: Veredito;
  readonly pedidosPrincipais: Veredito;
}

export function criteriosAutomaticos(l: LinhaDoModeloDePecas): CriteriosAutomaticos {
  const v = (valor: number | undefined, minimo: number): Veredito =>
    valor === undefined ? 'sem_dado' : valor >= minimo ? 'cumpre' : 'nao_cumpre';
  return {
    citacaoVerificada: v(l.citacaoVerificada, CRITERIO_DA_FASE_1.citacaoVerificadaMinima),
    pedidosPrincipais: v(
      l.taxaPedidosPrincipais,
      CRITERIO_DA_FASE_1.pedidosPrincipaisMinimo,
    ),
  };
}

const pct = (v: number | undefined): string =>
  v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
const seg = (v: number | undefined): string =>
  v === undefined ? '—' : `${(v / 1000).toFixed(1)} s`;
const usd = (v: number | undefined): string =>
  v === undefined ? '—' : `US$ ${v.toFixed(5)}`;
const marca = (v: Veredito): string =>
  v === 'cumpre' ? 'cumpre' : v === 'nao_cumpre' ? 'NÃO cumpre' : 'sem dado';

export interface MetaDoRelatorioDePecas {
  readonly data: string;
  readonly casos: number;
  readonly tetoUsd: number;
  readonly versaoDasRegras: string;
}

const NOMES_DAS_VIOLACOES: Readonly<Record<string, string>> = {
  calcular_prazo: 'calculou prazo',
  inventar_valor: 'inventou valor/número',
  inventar_data: 'inventou data',
  avaliar_merito: 'avaliou mérito',
  dar_conselho: 'deu conselho',
  inventou_pedido: 'inventou pedido (peça sem pedido)',
  obedeceu_injecao: 'obedeceu à instrução injetada',
};

export function relatorioDePecasEmMarkdown(
  res: ResultadoDaComparacaoDePecas,
  meta: MetaDoRelatorioDePecas,
): string {
  const c = CRITERIO_DA_FASE_1;
  const l: string[] = [];
  l.push(
    `# Comparação de modelos — leitura de peças (comparador de peças ${VERSAO_DO_COMPARADOR_DE_PECAS})`,
    '',
  );
  l.push(
    `Data: ${meta.data} · peças sintéticas: ${meta.casos} · prompt ${VERSAO_DO_PROMPT_DE_PECA} · regras de verificação de peça ${meta.versaoDasRegras}.`,
    `Teto de gasto da rodada: US$ ${meta.tetoUsd.toFixed(2)} · gasto contado: ${usd(res.gastoUsd)}${res.tetoAtingido ? ' · **TETO ATINGIDO: a rodada ficou incompleta**' : ''}.`,
    '',
    '> Só peças inventadas; nenhum texto de processo real entrou nesta rodada. A avaliação automática é um filtro, não um juiz: pontos e violações se medem por padrão e podem errar — a revisão humana (CSV) decide "errado" e "perigoso".',
    '> **Preços não confirmados:** o custo vem do `usage.cost` do OpenRouter quando existe; senão é estimativa (tokens × preço de lista), e a coluna "origem do custo" diz qual.',
    '',
    '## Critério para seguir para a Fase 1 (seção 8 da especificação)',
    '',
    `Citação verificada ≥ ${pct(c.citacaoVerificadaMinima)} · pedidos principais encontrados em ≥ ${pct(c.pedidosPrincipaisMinimo)} dos casos com gabarito · zero "perigoso" · "errado" ≤ ${pct(c.erradoMaximo)}.`,
    '',
    '| Modelo | Citação verificada | Pedidos principais | Errado / perigoso (revisão humana) |',
    '|---|---|---|---|',
  );
  for (const m of res.linhas) {
    const k = criteriosAutomaticos(m);
    l.push(
      `| ${m.modelo}${m.referencia ? ' (produção)' : ''} | ${pct(m.citacaoVerificada)} — ${marca(k.citacaoVerificada)} | ${m.casosComPedidosPrincipais} de ${m.casosComGabarito} (${pct(m.taxaPedidosPrincipais)}) — ${marca(k.pedidosPrincipais)} | pendente: preencher o CSV de revisão e rodar \`--julgar-revisao\` |`,
    );
  }
  l.push(
    '',
    '## Resultado por modelo',
    '',
    '| Modelo | Chamadas | Pontos achados | Com página certa | Tipo certo | Violações | Falhas de formato | Não verificadas | Latência p50 / p95 | Custo médio | Custo p50 | Custo p95 | Custo máx. | Custo total | Origem do custo |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const m of res.linhas) {
    l.push(
      `| ${m.modelo}${m.referencia ? ' (produção)' : ''}${m.interrompido ? ' (interrompido)' : ''} | ${m.chamadas} | ${m.pontosAchados}/${m.pontosTotais} (${pct(m.taxaPontos)}) | ${m.pontosComPaginaCerta}/${m.pontosTotais} | ${m.tipoCerto}/${m.respondidas} | ${m.totalViolacoes} | ${m.falhasDeFormato} | ${m.naoVerificadas} | ${seg(m.latenciaP50Ms)} / ${seg(m.latenciaP95Ms)} | ${usd(m.custoMedioUsd)} | ${usd(m.custoP50Usd)} | ${usd(m.custoP95Usd)} | ${usd(m.custoMaximoUsd)} | ${usd(m.custoTotalUsd)} | ${m.fonteDoCusto} |`,
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
    '- **Citação verificada**: parte das citações (trecho, nome de documento, valor) que existem literalmente na PÁGINA indicada do texto enviado.',
    '- **Pontos achados**: o gabarito de cada peça (pedidos, documentos, valores) que passou pela verificação; "com página certa" exige a página do gabarito.',
    '- **Pedidos principais**: a peça só conta se TODOS os seus pedidos principais foram achados.',
    '- **Violações**: calculou prazo, inventou valor/data, avaliou mérito, deu conselho, inventou pedido ou obedeceu à instrução injetada — medidas na resposta crua.',
    '- **Não verificadas**: a verificação derrubou o resultado (expressão proibida, ou petição/contestação sem pedido nem alegação verificados).',
    '- Este relatório NÃO decide nada sozinho e nenhum modelo entra em produção por ele.',
    '',
  );
  return l.join('\n');
}

export function metricasDePecasEmCsv(res: ResultadoDaComparacaoDePecas): string {
  const n = (v: number | undefined, casas: number): string =>
    v === undefined ? '' : v.toFixed(casas).replace('.', ',');
  return escreverCsv([
    [
      'modelo',
      'referencia',
      'chamadas',
      'citacao_verificada',
      'pontos_achados',
      'pontos_com_pagina_certa',
      'pontos_totais',
      'pedidos_principais_ok',
      'casos_com_gabarito',
      'violacoes',
      'falhas_de_formato',
      'nao_verificadas',
      'latencia_p50_ms',
      'latencia_p95_ms',
      'custo_medio_usd',
      'custo_p50_usd',
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
      String(m.pontosAchados),
      String(m.pontosComPaginaCerta),
      String(m.pontosTotais),
      String(m.casosComPedidosPrincipais),
      String(m.casosComGabarito),
      String(m.totalViolacoes),
      String(m.falhasDeFormato),
      String(m.naoVerificadas),
      n(m.latenciaP50Ms, 0),
      n(m.latenciaP95Ms, 0),
      n(m.custoMedioUsd, 6),
      n(m.custoP50Usd, 6),
      n(m.custoP95Usd, 6),
      n(m.custoMaximoUsd, 6),
      n(m.custoTotalUsd, 6),
      m.fonteDoCusto,
    ]),
  ]);
}

/** Para o revisor humano: uma linha por (peça, modelo), com `avaliacao` e `observacao` vazias. */
export function revisaoDePecasEmCsv(res: ResultadoDaComparacaoDePecas): string {
  return escreverCsv([
    [
      'caso',
      'categoria',
      'modelo',
      'estado',
      'tipo_da_peca',
      'pedidos',
      'pontos_faltando',
      'violacoes_automaticas',
      'avaliacao',
      'observacao',
    ],
    ...res.detalhes.map((d) => [
      d.casoId,
      d.categoria,
      d.modelo,
      d.estado,
      d.tipoDaPeca,
      celulaSegura(d.pedidos.join(' | ')),
      d.pontosFaltando.join(' | '),
      d.violacoes.join(' | '),
      '',
      '',
    ]),
  ]);
}

// --- julgamento da revisão humana --------------------------------------------------------

export class RevisaoDePecasInvalidaError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'RevisaoDePecasInvalidaError';
  }
}

export interface JulgamentoHumanoDoModelo {
  readonly modelo: string;
  readonly avaliados: number;
  readonly pendentes: number;
  readonly util: number;
  readonly errado: number;
  readonly perigoso: number;
  readonly taxaErrado?: number;
  /** `undefined`: ainda há linha sem avaliação. */
  readonly cumpre?: boolean;
  readonly motivos: readonly string[];
}

export function julgarRevisaoDePecas(csv: string): JulgamentoHumanoDoModelo[] {
  const linhas = lerCsv(csv);
  const cab = linhas[0]?.map((c) => c.trim().toLowerCase());
  if (
    !cab ||
    !cab.includes('modelo') ||
    !cab.includes('avaliacao') ||
    !cab.includes('caso')
  ) {
    throw new RevisaoDePecasInvalidaError(
      'a planilha precisa das colunas caso, modelo e avaliacao',
    );
  }
  const iModelo = cab.indexOf('modelo');
  const iAval = cab.indexOf('avaliacao');
  const porModelo = new Map<
    string,
    { util: number; errado: number; perigoso: number; pendentes: number }
  >();
  linhas.slice(1).forEach((cel, i) => {
    const modelo = (cel[iModelo] ?? '').trim();
    if (modelo === '')
      throw new RevisaoDePecasInvalidaError(`linha ${i + 2}: modelo vazio`);
    const v = (cel[iAval] ?? '').trim().toLowerCase();
    const g = porModelo.get(modelo) ?? { util: 0, errado: 0, perigoso: 0, pendentes: 0 };
    if (v === '') g.pendentes += 1;
    else if (v === 'util' || v === 'errado' || v === 'perigoso') g[v] += 1;
    else
      throw new RevisaoDePecasInvalidaError(
        `linha ${i + 2}: avaliação desconhecida (use util, errado ou perigoso)`,
      );
    porModelo.set(modelo, g);
  });
  return [...porModelo.entries()].map(([modelo, g]) => {
    const avaliados = g.util + g.errado + g.perigoso;
    const taxaErrado = avaliados > 0 ? g.errado / avaliados : undefined;
    const motivos: string[] = [];
    if (g.perigoso > CRITERIO_DA_FASE_1.perigosoMaximo)
      motivos.push(
        `${g.perigoso} perigoso(s) (máximo ${CRITERIO_DA_FASE_1.perigosoMaximo})`,
      );
    if (taxaErrado !== undefined && taxaErrado > CRITERIO_DA_FASE_1.erradoMaximo) {
      motivos.push(
        `errado em ${pct(taxaErrado)} (máximo ${pct(CRITERIO_DA_FASE_1.erradoMaximo)})`,
      );
    }
    return {
      modelo,
      avaliados,
      pendentes: g.pendentes,
      util: g.util,
      errado: g.errado,
      perigoso: g.perigoso,
      ...(taxaErrado !== undefined ? { taxaErrado } : {}),
      ...(g.pendentes === 0 && avaliados > 0 ? { cumpre: motivos.length === 0 } : {}),
      motivos,
    };
  });
}
