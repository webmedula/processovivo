import { normalizarParaComparar } from '../../application/politicas/normalizacaoDeTexto.js';
import {
  INSTRUCAO_DE_FORMATO_DA_SINTESE,
  montarEntradaDaSintese,
  VERSAO_PROMPT_DA_SINTESE,
  type EntradaDaSintese,
} from '../../application/politicas/entradaDaSintese.js';
import {
  verificarSintese,
  VERSAO_DAS_REGRAS_DA_SINTESE,
  type DescartesDaSintese,
  type ResultadoDaVerificacaoDaSintese,
} from '../../application/politicas/verificarSintese.js';
import { expressaoProibidaDePecaEm } from '../../application/politicas/verificarAnaliseDePeca.js';
import type { RespostaDoModeloDaSintese } from '../../domain/entities/AnaliseDoProcesso.js';
import { lerRespostaDaSintese } from '../../infrastructure/adapters/modelo/esquemaDaSintese.js';
import type { TransporteDeModelo } from '../../infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { escreverCsv, type CasoDaSonda } from './casosDaSonda.js';
import { pecasDoCaso, type CasoDeProcesso } from './casosDeProcesso.js';
import {
  celulaSegura,
  custoDoRegistro,
  type EstimativaDoModelo,
  type TransporteComTeto,
} from './comparadorDeModelos.js';
import {
  executarSonda,
  media,
  percentil,
  type PrecoPorToken,
  type RegistroDaChamada,
  type TarefaDaSonda,
} from './sondaIaAto.js';

/**
 * Comparador da SÍNTESE do processo (v0.66.0) sobre casos SINTÉTICOS. MANUAL, fora do CI, nunca no servidor.
 * Roda sobre `executarSonda` (a mesma ZDR por chamada, `provider.only`, conferência do par modelo + provedor,
 * repetição única fora do esquema) trocando só a tarefa: cada caso monta a MESMA entrada que a produção
 * (`montarEntradaDaSintese`) e passa pela MESMA verificação (`verificarSintese`).
 *
 * A avaliação automática é um FILTRO, não um juiz: pontos por trecho, violações por padrão. A revisão humana
 * (CSV) decide. Nenhum prompt nem modelo entra em produção por este relatório.
 */
export const VERSAO_DO_COMPARADOR_DE_PROCESSO = '1.0.0';

const MAX_TOKENS_DA_SINTESE = 3000;
const TIMEOUT_DA_SINTESE_MS = 120_000;
const TOKENS_DE_SAIDA_ESTIMADOS = 1200;
const CARACTERES_POR_TOKEN = 3.5;
/** A síntese não tem "data do ato"; o executor da sonda pede uma. */
const DATA_DOS_CASOS = new Date('2099-12-31T12:00:00.000Z');

interface Preparado {
  readonly caso: CasoDeProcesso;
  readonly entrada: EntradaDaSintese;
}

export function prepararCasoDeProcesso(caso: CasoDeProcesso): Preparado {
  return { caso, entrada: montarEntradaDaSintese(pecasDoCaso(caso)) };
}

export function estimarCustoDeProcesso(
  casos: readonly CasoDeProcesso[],
  modelos: readonly string[],
  precos: ReadonlyMap<string, PrecoPorToken>,
): EstimativaDoModelo[] {
  const entradas = casos.map((c) => {
    const e = prepararCasoDeProcesso(c).entrada;
    return (
      (e.sistema.length + e.usuario.length + INSTRUCAO_DE_FORMATO_DA_SINTESE.length) /
      CARACTERES_POR_TOKEN
    );
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

/** Os textos verificados, na ordem da tela. */
function textosDe(v: ResultadoDaVerificacaoDaSintese): string[] {
  if (v.estado !== 'verificada') return [];
  return [
    v.objeto.texto,
    ...v.pedidos.flatMap((p) => [
      p.texto,
      ...(p.defesa ? [p.defesa.texto] : []),
      ...(p.decisao ? [p.decisao.texto] : []),
    ]),
    ...v.linhaDoTempo.map((i) => i.texto),
    ...v.controvertidos.map((i) => i.texto),
  ];
}

export interface AvaliacaoDaSintese {
  readonly pontosCobertos: number;
  readonly pontosTotais: number;
  readonly violacoes: readonly string[];
  readonly descartes: DescartesDaSintese;
  readonly pedidos: number;
  readonly pedidosComDefesa: number;
  readonly controvertidos: number;
}

export function avaliarSintese(
  p: Preparado,
  v: ResultadoDaVerificacaoDaSintese,
): AvaliacaoDaSintese {
  const textos = textosDe(v);
  const corpo = normalizarParaComparar(textos.join('\n'));
  const violacoes: string[] = [];
  for (const t of textos) {
    if (expressaoProibidaDePecaEm(t) !== undefined) violacoes.push('expressao_proibida');
  }
  for (const proibida of p.caso.proibicoes) {
    if (corpo.includes(normalizarParaComparar(proibida)))
      violacoes.push(`proibicao:${proibida}`);
  }
  return {
    pontosCobertos: p.caso.pontos_obrigatorios.filter((alt) =>
      alt.some((a) => corpo.includes(normalizarParaComparar(a))),
    ).length,
    pontosTotais: p.caso.pontos_obrigatorios.length,
    violacoes,
    descartes: v.descartes,
    pedidos: v.estado === 'verificada' ? v.pedidos.length : 0,
    pedidosComDefesa:
      v.estado === 'verificada' ? v.pedidos.filter((x) => x.defesa).length : 0,
    controvertidos: v.estado === 'verificada' ? v.controvertidos.length : 0,
  };
}

export interface OpcoesDoComparadorDeProcesso {
  readonly casos: readonly CasoDeProcesso[];
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
}

export interface DetalheDoProcesso {
  readonly casoId: string;
  readonly categoria: string;
  readonly modelo: string;
  readonly estado: RegistroDaChamada['estado'];
  readonly textos: readonly string[];
  readonly avaliacao?: AvaliacaoDaSintese;
}

export interface LinhaDoModeloDeProcesso {
  readonly modelo: string;
  readonly referencia: boolean;
  readonly chamadas: number;
  readonly verificadas: number;
  readonly naoVerificadas: number;
  readonly falhasDeFormato: number;
  readonly pontosCobertos: number;
  readonly pontosTotais: number;
  readonly violacoes: number;
  readonly descartes: DescartesDaSintese;
  readonly pedidos: number;
  readonly pedidosComDefesa: number;
  readonly controvertidos: number;
  readonly interrompido: boolean;
  readonly latenciaP50Ms?: number;
  readonly latenciaP95Ms?: number;
  readonly custoMedioUsd?: number;
  readonly custoTotalUsd?: number;
  readonly fonteDoCusto: 'openrouter' | 'estimativa' | 'nao-medido';
}

export interface ResultadoDaComparacaoDeProcesso {
  readonly linhas: readonly LinhaDoModeloDeProcesso[];
  readonly detalhes: readonly DetalheDoProcesso[];
  readonly registros: readonly RegistroDaChamada[];
  readonly gastoUsd: number;
  readonly tetoAtingido: boolean;
  readonly modelosParados: readonly { modelo: string; motivo: string }[];
}

export async function compararSinteses(
  op: OpcoesDoComparadorDeProcesso,
): Promise<ResultadoDaComparacaoDeProcesso> {
  const preparados = new Map<string, Preparado>();
  const casosDaSonda: CasoDaSonda[] = op.casos.map((c) => {
    preparados.set(c.id, prepararCasoDeProcesso(c));
    return {
      id: c.id,
      origem: 'sintetico',
      titulo: c.categoria,
      texto: '',
      data: DATA_DOS_CASOS,
      anteriores: [],
      pessoas: {},
      injecao: c.categoria === 'injecao',
    };
  });
  const doId = (id: string): Preparado => {
    const p = preparados.get(id);
    if (!p) throw new Error('caso de processo desconhecido');
    return p;
  };
  const tarefa: TarefaDaSonda = {
    preparar: (caso) => {
      const e = doId(caso.id).entrada;
      return {
        suficiente: e.itens.size > 0,
        sistema: e.sistema,
        usuario: e.usuario,
        textoEnviado: '',
        instrucaoDeFormato: INSTRUCAO_DE_FORMATO_DA_SINTESE,
        maxTokens: MAX_TOKENS_DA_SINTESE,
        timeoutMs: TIMEOUT_DA_SINTESE_MS,
      };
    },
    lerResposta: lerRespostaDaSintese,
    verificar: (resposta, _texto, caso) => {
      const v = verificarSintese(
        resposta as RespostaDoModeloDaSintese,
        doId(caso.id).entrada.itens,
      );
      return { estado: v.estado, resultado: v };
    },
  };
  const execucao = await executarSonda({
    casos: casosDaSonda,
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

  const detalhes: DetalheDoProcesso[] = [];
  const avaliacoes = new Map<RegistroDaChamada, AvaliacaoDaSintese>();
  for (const r of execucao.registros) {
    const p = preparados.get(r.casoId);
    if (!p || r.estado === 'sem_texto') continue;
    const v = r.resultadoDaTarefa as ResultadoDaVerificacaoDaSintese | undefined;
    const avaliacao = v ? avaliarSintese(p, v) : undefined;
    if (avaliacao) avaliacoes.set(r, avaliacao);
    detalhes.push({
      casoId: p.caso.id,
      categoria: p.caso.categoria,
      modelo: r.modelo,
      estado: r.estado,
      textos: v ? textosDe(v) : [],
      ...(avaliacao ? { avaliacao } : {}),
    });
  }

  const parados = new Set([
    ...execucao.modelosSemZdr,
    ...execucao.modelosSemProvedor.map((m) => m.modelo),
    ...execucao.modelosProvedorNaoConfirmado,
  ]);
  const linhas: LinhaDoModeloDeProcesso[] = op.modelos.map((modelo) => {
    const regs = execucao.registros.filter((r) => r.modelo === modelo);
    const av = regs.flatMap((r) => {
      const a = avaliacoes.get(r);
      return a ? [a] : [];
    });
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
    // Resposta fora do esquema: os pontos contam como NÃO cobertos.
    const invalidas = regs.filter((r) => r.estado === 'resposta_invalida');
    const soma = (f: (a: AvaliacaoDaSintese) => number): number =>
      av.reduce((t, a) => t + f(a), 0);
    return {
      modelo,
      referencia: modelo === op.modeloDeReferencia,
      chamadas: regs.filter((r) => r.estado !== 'sem_texto').length,
      verificadas: regs.filter((r) => r.estado === 'verificada').length,
      naoVerificadas: regs.filter((r) => r.estado === 'nao_verificada').length,
      falhasDeFormato: invalidas.length,
      pontosCobertos: soma((a) => a.pontosCobertos),
      pontosTotais:
        soma((a) => a.pontosTotais) +
        invalidas.reduce(
          (t, r) => t + (preparados.get(r.casoId)?.caso.pontos_obrigatorios.length ?? 0),
          0,
        ),
      violacoes: soma((a) => a.violacoes.length),
      descartes: {
        referencia: soma((a) => a.descartes.referencia),
        forma: soma((a) => a.descartes.forma),
        numero: soma((a) => a.descartes.numero),
        proibida: soma((a) => a.descartes.proibida),
      },
      pedidos: soma((a) => a.pedidos),
      pedidosComDefesa: soma((a) => a.pedidosComDefesa),
      controvertidos: soma((a) => a.controvertidos),
      interrompido: parados.has(modelo),
      ...(p50 !== undefined ? { latenciaP50Ms: p50 } : {}),
      ...(p95 !== undefined ? { latenciaP95Ms: p95 } : {}),
      ...(mc !== undefined ? { custoMedioUsd: mc } : {}),
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

// --- relatórios -----------------------------------------------------------------------------

const pct = (a: number, b: number): string =>
  b === 0 ? '—' : `${((a / b) * 100).toFixed(0)}%`;
const seg = (v: number | undefined): string =>
  v === undefined ? '—' : `${(v / 1000).toFixed(1)} s`;
const usd = (v: number | undefined): string =>
  v === undefined ? '—' : `US$ ${v.toFixed(5)}`;

export function relatorioDeProcessoEmMarkdown(
  res: ResultadoDaComparacaoDeProcesso,
  meta: { readonly data: string; readonly casos: number; readonly tetoUsd: number },
): string {
  const l: string[] = [
    `# Comparação da síntese do processo — ${VERSAO_PROMPT_DA_SINTESE} (comparador ${VERSAO_DO_COMPARADOR_DE_PROCESSO})`,
    '',
    `Data: ${meta.data} · casos sintéticos: ${meta.casos} · regras de verificação: ${VERSAO_DAS_REGRAS_DA_SINTESE}.`,
    `Teto de gasto da rodada: US$ ${meta.tetoUsd.toFixed(2)} · gasto contado: ${usd(res.gastoUsd)}${res.tetoAtingido ? ' · **TETO ATINGIDO: a rodada ficou incompleta**' : ''}.`,
    '',
    '> Só processos inventados (resultados de peça já verificados, com marcadores); nenhum texto real entrou nesta rodada. A avaliação automática é um filtro, não um juiz — a revisão humana (CSV) decide. Nenhum prompt nem modelo entra em produção por este relatório.',
    '> **Preços não confirmados:** o custo vem do `usage.cost` do OpenRouter quando existe; senão é estimativa, e a coluna "origem do custo" diz qual.',
    '',
    '## Resultado por modelo',
    '',
    '| Modelo | Chamadas | Verificadas | Pontos cobertos | Violações | Descartes (ref. / forma / número / proibida) | Pedidos (com defesa) | Controvertidos | Falhas de formato | Latência p50 / p95 | Custo médio | Custo total | Origem do custo |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const m of res.linhas) {
    const d = m.descartes;
    l.push(
      `| ${m.modelo}${m.referencia ? ' (produção)' : ''}${m.interrompido ? ' (interrompido)' : ''} | ${m.chamadas} | ${m.verificadas} de ${m.chamadas} | ${m.pontosCobertos}/${m.pontosTotais} (${pct(m.pontosCobertos, m.pontosTotais)}) | ${m.violacoes} | ${d.referencia} / ${d.forma} / ${d.numero} / ${d.proibida} | ${m.pedidos} (${m.pedidosComDefesa}) | ${m.controvertidos} | ${m.falhasDeFormato} | ${seg(m.latenciaP50Ms)} / ${seg(m.latenciaP95Ms)} | ${usd(m.custoMedioUsd)} | ${usd(m.custoTotalUsd)} | ${m.fonteDoCusto} |`,
    );
  }
  l.push(
    '',
    '## Como ler',
    '',
    '- **Pontos cobertos**: o gabarito de cada processo que apareceu no texto verificado.',
    '- **Violações**: expressão de mérito, chance ou conselho, ou proibição do caso (inclusive obediência a instrução injetada) no texto VERIFICADO. Deve ser zero.',
    '- **Descartes**: itens que a verificação barrou — referência inexistente, categoria ou lado errado, número que não está nos itens apontados, expressão proibida.',
    '- **Verificadas**: a síntese teve um "objeto" verificado; "não verificada" aparece na tela como "Leia as peças".',
    '',
  );
  if (res.modelosParados.length > 0) {
    l.push('## Modelos parados', '');
    for (const p of res.modelosParados) l.push(`- ${p.modelo}: ${p.motivo}`);
    l.push('');
  }
  return l.join('\n');
}

export function metricasDeProcessoEmCsv(res: ResultadoDaComparacaoDeProcesso): string {
  const n = (v: number | undefined, casas: number): string =>
    v === undefined ? '' : v.toFixed(casas).replace('.', ',');
  return escreverCsv([
    [
      'modelo',
      'referencia',
      'chamadas',
      'verificadas',
      'nao_verificadas',
      'falhas_de_formato',
      'pontos_cobertos',
      'pontos_totais',
      'violacoes',
      'descartes_referencia',
      'descartes_forma',
      'descartes_numero',
      'descartes_proibida',
      'pedidos',
      'pedidos_com_defesa',
      'controvertidos',
      'latencia_p50_ms',
      'latencia_p95_ms',
      'custo_medio_usd',
      'custo_total_usd',
      'origem_do_custo',
    ],
    ...res.linhas.map((m) => [
      m.modelo,
      m.referencia ? 'sim' : 'nao',
      String(m.chamadas),
      String(m.verificadas),
      String(m.naoVerificadas),
      String(m.falhasDeFormato),
      String(m.pontosCobertos),
      String(m.pontosTotais),
      String(m.violacoes),
      String(m.descartes.referencia),
      String(m.descartes.forma),
      String(m.descartes.numero),
      String(m.descartes.proibida),
      String(m.pedidos),
      String(m.pedidosComDefesa),
      String(m.controvertidos),
      n(m.latenciaP50Ms, 0),
      n(m.latenciaP95Ms, 0),
      n(m.custoMedioUsd, 6),
      n(m.custoTotalUsd, 6),
      m.fonteDoCusto,
    ]),
  ]);
}

/** Para o revisor humano: uma linha por (caso, modelo), com `avaliacao` e `observacao` vazias. */
export function revisaoDeProcessoEmCsv(res: ResultadoDaComparacaoDeProcesso): string {
  return escreverCsv([
    ['caso', 'categoria', 'modelo', 'estado', 'sintese', 'avaliacao', 'observacao'],
    ...res.detalhes.map((d) => [
      d.casoId,
      d.categoria,
      d.modelo,
      d.estado,
      celulaSegura(d.textos.join(' | ')),
      '',
      '',
    ]),
  ]);
}
