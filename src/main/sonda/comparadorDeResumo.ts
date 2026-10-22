import { atosQuePedemProvidencia } from '../../domain/entities/estadoDaPasta.js';
import { normalizarParaComparar } from '../../application/politicas/normalizacaoDeTexto.js';
import {
  prepararEntradaDoResumo,
  type EntradaDoResumo,
  type VersaoDoPromptDoResumo,
} from '../../application/politicas/entradaDoResumo.js';
import {
  REGRAS_DA_SELECAO_1_0_0,
  REGRAS_DA_SELECAO_1_1_0,
  selecionarAtosParaResumo,
  type SelecaoDoResumo,
} from '../../application/politicas/selecionarAtosParaResumo.js';
import {
  textoApresentaComoAtual,
  textoNegaPendencia,
  verificarResumo,
  VERSAO_DAS_REGRAS_DO_RESUMO,
  type ResultadoDaVerificacaoDoResumo,
} from '../../application/politicas/verificarResumo.js';
import { expressaoProibidaEm } from '../../application/politicas/verificarAnalise.js';
import type { RespostaDoModeloResumo } from '../../domain/entities/vocabularioDoResumo.js';
import {
  INSTRUCAO_DE_FORMATO_DO_RESUMO,
  lerRespostaDoResumo,
} from '../../infrastructure/adapters/modelo/esquemaDoResumo.js';
import type { TransporteDeModelo } from '../../infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { escreverCsv } from './casosDaSonda.js';
import { movimentacoesDoCaso, type CasoDeResumo } from './casosDeResumo.js';
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
import type { CasoDaSonda } from './casosDaSonda.js';

/**
 * Comparador do RESUMO de processo por IA (v0.54.0): `resumo-1.0.0` × `resumo-1.1.0` sobre casos
 * SINTÉTICOS. MANUAL, fora do CI, nunca no servidor. Roda sobre `executarSonda` (a mesma ZDR por
 * chamada, `provider.only`, conferência do par modelo + provedor, repetição única fora do esquema)
 * trocando só a tarefa: cada versão monta a MESMA entrada que a produção montaria (seleção, limpeza
 * de cabeçalho, prompt) e passa pela MESMA verificação (`verificarResumo`).
 *
 * A avaliação automática é um FILTRO, não um juiz: pontos por trecho, violações por padrão. A
 * revisão humana (CSV) decide. Nenhum prompt entra em produção por este relatório.
 */
export const VERSAO_DO_COMPARADOR_DE_RESUMO = '1.0.0';

export const VERSOES_DO_RESUMO: readonly VersaoDoPromptDoResumo[] = [
  'resumo-1.0.0',
  'resumo-1.1.0',
];

/** "Hoje" dos casos sintéticos: fixo, para a providência do sistema não depender do relógio. */
export const AGORA_DOS_CASOS_DE_RESUMO = new Date('2099-03-20T15:00:00.000Z');
const JANELA_DE_PENDENCIA_DIAS = 10;
const MAX_TOKENS_DO_RESUMO = 1500;
const TIMEOUT_DO_RESUMO_MS = 120_000;
const TOKENS_DE_SAIDA_ESTIMADOS = 700;
const CARACTERES_POR_TOKEN = 3.5;

interface Preparado {
  readonly caso: CasoDeResumo;
  readonly versao: VersaoDoPromptDoResumo;
  readonly selecao: SelecaoDoResumo;
  readonly entrada: EntradaDoResumo;
}

/** O que a produção montaria para este caso nesta versão (mesma seleção, mesma entrada). */
export function prepararCasoDeResumo(
  caso: CasoDeResumo,
  versao: VersaoDoPromptDoResumo,
): Preparado {
  const movs = movimentacoesDoCaso(caso);
  const pendentes = new Set(
    atosQuePedemProvidencia(
      movs,
      AGORA_DOS_CASOS_DE_RESUMO,
      JANELA_DE_PENDENCIA_DIAS,
      undefined,
      undefined,
    ).map((p) => p.chave),
  );
  const selecao = selecionarAtosParaResumo(
    movs,
    pendentes,
    versao === 'resumo-1.1.0' ? REGRAS_DA_SELECAO_1_1_0 : REGRAS_DA_SELECAO_1_0_0,
  );
  const entrada = prepararEntradaDoResumo(
    selecao,
    { tribunal: 'TJGO', ...(caso.classe ? { classe: caso.classe } : {}) },
    {},
    { versao },
  );
  return { caso, versao, selecao, entrada };
}

const idDoCasoNaSonda = (c: CasoDeResumo, v: VersaoDoPromptDoResumo): string =>
  `${c.id}@${v}`;

export function estimarCustoDeResumo(
  casos: readonly CasoDeResumo[],
  versoes: readonly VersaoDoPromptDoResumo[],
  modelos: readonly string[],
  precos: ReadonlyMap<string, PrecoPorToken>,
): EstimativaDoModelo[] {
  const entradas = casos.flatMap((c) =>
    versoes.flatMap((v) => {
      const p = prepararCasoDeResumo(c, v);
      return p.selecao.comTexto > 0
        ? [
            (p.entrada.sistema.length +
              p.entrada.usuario.length +
              INSTRUCAO_DE_FORMATO_DO_RESUMO.length) /
              CARACTERES_POR_TOKEN,
          ]
        : [];
    }),
  );
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

export interface AvaliacaoDoResumo {
  readonly pontosCobertos: number;
  readonly pontosTotais: number;
  readonly violacoes: readonly string[];
  /** Só quando o ato mais recente foi lido: o primeiro item de situação é sobre ele? */
  readonly abreNoMaisRecente?: boolean;
  /** Só quando o ato mais recente NÃO foi lido: itens de situação que o apresentam como atual. */
  readonly atualIndevida: number;
  /** Só com providência do sistema sem leitura: itens que negam pendência. */
  readonly negouPendencia: number;
  readonly descartes: number;
}

/** Os itens verificados (situação e pendências), ou nenhum se o resultado não foi verificado. */
function itensDe(v: ResultadoDaVerificacaoDoResumo): {
  situacao: readonly { texto: string; chaveDoAto: string }[];
  pendencias: readonly { texto: string; chaveDoAto: string }[];
} {
  return v.estado === 'verificado'
    ? { situacao: v.situacao, pendencias: v.pendencias }
    : { situacao: [], pendencias: [] };
}

const somaDescartes = (v: ResultadoDaVerificacaoDoResumo): number =>
  Object.values(v.descartes).reduce((a, b) => a + b, 0);

export function avaliarResumo(
  p: Preparado,
  v: ResultadoDaVerificacaoDoResumo,
): AvaliacaoDoResumo {
  const { situacao, pendencias } = itensDe(v);
  const textos = [...situacao, ...pendencias].map((i) => i.texto);
  const corpo = normalizarParaComparar(textos.join('\n'));
  const cobertos = p.caso.pontos_obrigatorios.filter((alternativas) =>
    alternativas.some((a) => corpo.includes(normalizarParaComparar(a))),
  ).length;
  const violacoes: string[] = [];
  for (const t of textos) {
    const e = expressaoProibidaEm(t);
    if (e !== undefined) violacoes.push(`expressao_proibida`);
  }
  for (const proibida of p.caso.proibicoes) {
    if (corpo.includes(normalizarParaComparar(proibida)))
      violacoes.push(`proibicao:${proibida}`);
  }
  const maisRecente = p.entrada.maisRecente;
  const chaveDoMaisRecente = maisRecente
    ? p.entrada.atos.get(maisRecente.id)?.chave
    : undefined;
  const abre =
    maisRecente?.lido && v.estado === 'verificado'
      ? situacao[0]?.chaveDoAto === chaveDoMaisRecente
      : undefined;
  return {
    pontosCobertos: cobertos,
    pontosTotais: p.caso.pontos_obrigatorios.length,
    violacoes,
    ...(abre !== undefined ? { abreNoMaisRecente: abre } : {}),
    atualIndevida:
      maisRecente && !maisRecente.lido
        ? situacao.filter((i) => textoApresentaComoAtual(i.texto)).length
        : 0,
    negouPendencia:
      p.entrada.providenciasNaoLidas.length > 0
        ? [...situacao, ...pendencias].filter((i) => textoNegaPendencia(i.texto)).length
        : 0,
    descartes: somaDescartes(v),
  };
}

export interface OpcoesDoComparadorDeResumo {
  readonly casos: readonly CasoDeResumo[];
  readonly versoes: readonly VersaoDoPromptDoResumo[];
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

export interface DetalheDoResumo {
  readonly casoId: string;
  readonly categoria: string;
  readonly modelo: string;
  readonly versao: VersaoDoPromptDoResumo;
  readonly estado: RegistroDaChamada['estado'];
  readonly maisRecenteLido: string;
  readonly situacao: readonly string[];
  readonly pendencias: readonly string[];
  readonly avaliacao?: AvaliacaoDoResumo;
}

export interface LinhaDaVersao {
  readonly modelo: string;
  readonly versao: VersaoDoPromptDoResumo;
  readonly referencia: boolean;
  readonly chamadas: number;
  readonly verificadas: number;
  readonly naoVerificadas: number;
  readonly falhasDeFormato: number;
  readonly pontosCobertos: number;
  readonly pontosTotais: number;
  readonly abreNoMaisRecente: number;
  readonly casosComMaisRecenteLido: number;
  readonly atualIndevida: number;
  readonly negouPendencia: number;
  readonly violacoes: number;
  readonly descartes: number;
  readonly interrompido: boolean;
  readonly latenciaP50Ms?: number;
  readonly latenciaP95Ms?: number;
  readonly custoMedioUsd?: number;
  readonly custoTotalUsd?: number;
  readonly fonteDoCusto: 'openrouter' | 'estimativa' | 'nao-medido';
}

export interface ResultadoDaComparacaoDeResumo {
  readonly linhas: readonly LinhaDaVersao[];
  readonly detalhes: readonly DetalheDoResumo[];
  readonly registros: readonly RegistroDaChamada[];
  readonly gastoUsd: number;
  readonly tetoAtingido: boolean;
  readonly modelosParados: readonly { modelo: string; motivo: string }[];
}

export async function compararResumos(
  op: OpcoesDoComparadorDeResumo,
): Promise<ResultadoDaComparacaoDeResumo> {
  const preparados = new Map<string, Preparado>();
  const casosDaSonda: CasoDaSonda[] = [];
  for (const c of op.casos) {
    for (const v of op.versoes) {
      const id = idDoCasoNaSonda(c, v);
      preparados.set(id, prepararCasoDeResumo(c, v));
      casosDaSonda.push({
        id,
        origem: 'sintetico',
        titulo: c.categoria,
        texto: '',
        data: AGORA_DOS_CASOS_DE_RESUMO,
        anteriores: [],
        pessoas: {},
        injecao: false,
      });
    }
  }
  const doId = (id: string): Preparado => {
    const p = preparados.get(id);
    if (!p) throw new Error('caso de resumo desconhecido');
    return p;
  };

  const tarefa: TarefaDaSonda = {
    preparar: (caso) => {
      const p = doId(caso.id);
      return {
        suficiente: p.selecao.comTexto > 0,
        sistema: p.entrada.sistema,
        usuario: p.entrada.usuario,
        textoEnviado: '',
        instrucaoDeFormato: INSTRUCAO_DE_FORMATO_DO_RESUMO,
        maxTokens: MAX_TOKENS_DO_RESUMO,
        timeoutMs: TIMEOUT_DO_RESUMO_MS,
      };
    },
    lerResposta: lerRespostaDoResumo,
    verificar: (resposta, _texto, caso) => {
      const p = doId(caso.id);
      // A 1.0.0 não conhecia a faixa do sistema: verifica COMO a 1.0.0 verificava.
      const contexto =
        p.versao === 'resumo-1.1.0'
          ? {
              maisRecenteNaoLido: p.entrada.maisRecente?.lido === false,
              providenciaNaoLida: p.entrada.providenciasNaoLidas.length > 0,
            }
          : {};
      const v = verificarResumo(
        resposta as RespostaDoModeloResumo,
        p.entrada.atos,
        contexto,
      );
      return {
        estado: v.estado === 'verificado' ? 'verificada' : 'nao_verificada',
        resultado: v,
      };
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

  const detalhes: DetalheDoResumo[] = [];
  const avaliacoes = new Map<RegistroDaChamada, AvaliacaoDoResumo>();
  for (const r of execucao.registros) {
    const p = preparados.get(r.casoId);
    if (!p) continue;
    const v = r.resultadoDaTarefa as ResultadoDaVerificacaoDoResumo | undefined;
    const avaliacao = v ? avaliarResumo(p, v) : undefined;
    if (avaliacao) avaliacoes.set(r, avaliacao);
    if (r.estado === 'sem_texto') continue;
    const itens = v ? itensDe(v) : { situacao: [], pendencias: [] };
    detalhes.push({
      casoId: p.caso.id,
      categoria: p.caso.categoria,
      modelo: r.modelo,
      versao: p.versao,
      estado: r.estado,
      maisRecenteLido: p.entrada.maisRecente?.lido ? 'sim' : 'nao',
      situacao: itens.situacao.map((i) => i.texto),
      pendencias: itens.pendencias.map((i) => i.texto),
      ...(avaliacao ? { avaliacao } : {}),
    });
  }

  const parados = new Set([
    ...execucao.modelosSemZdr,
    ...execucao.modelosSemProvedor.map((m) => m.modelo),
    ...execucao.modelosProvedorNaoConfirmado,
  ]);
  const linhas: LinhaDaVersao[] = [];
  for (const modelo of op.modelos) {
    for (const versao of op.versoes) {
      const regs = execucao.registros.filter(
        (r) => r.modelo === modelo && preparados.get(r.casoId)?.versao === versao,
      );
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
      const totaisDasInvalidas = invalidas.reduce(
        (a, r) => a + (preparados.get(r.casoId)?.caso.pontos_obrigatorios.length ?? 0),
        0,
      );
      linhas.push({
        modelo,
        versao,
        referencia: modelo === op.modeloDeReferencia,
        chamadas: regs.filter((r) => r.estado !== 'sem_texto').length,
        verificadas: regs.filter((r) => r.estado === 'verificada').length,
        naoVerificadas: regs.filter((r) => r.estado === 'nao_verificada').length,
        falhasDeFormato: invalidas.length,
        pontosCobertos: av.reduce((a, x) => a + x.pontosCobertos, 0),
        pontosTotais: av.reduce((a, x) => a + x.pontosTotais, 0) + totaisDasInvalidas,
        abreNoMaisRecente: av.filter((x) => x.abreNoMaisRecente === true).length,
        casosComMaisRecenteLido: av.filter((x) => x.abreNoMaisRecente !== undefined)
          .length,
        atualIndevida: av.reduce((a, x) => a + x.atualIndevida, 0),
        negouPendencia: av.reduce((a, x) => a + x.negouPendencia, 0),
        violacoes: av.reduce((a, x) => a + x.violacoes.length, 0),
        descartes: av.reduce((a, x) => a + x.descartes, 0),
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
      });
    }
  }

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

export interface MetaDoRelatorioDeResumo {
  readonly data: string;
  readonly casos: number;
  readonly tetoUsd: number;
}

export function relatorioDeResumoEmMarkdown(
  res: ResultadoDaComparacaoDeResumo,
  meta: MetaDoRelatorioDeResumo,
): string {
  const l: string[] = [];
  l.push(
    `# Comparação do resumo de processo — resumo-1.0.0 × resumo-1.1.0 (comparador ${VERSAO_DO_COMPARADOR_DE_RESUMO})`,
    '',
    `Data: ${meta.data} · casos sintéticos: ${meta.casos} · regras de verificação ${VERSAO_DAS_REGRAS_DO_RESUMO}.`,
    `Teto de gasto da rodada: US$ ${meta.tetoUsd.toFixed(2)} · gasto contado: ${usd(res.gastoUsd)}${res.tetoAtingido ? ' · **TETO ATINGIDO: a rodada ficou incompleta**' : ''}.`,
    '',
    '> Só processos inventados; nenhum texto de processo real entrou nesta rodada. A avaliação automática é um filtro, não um juiz: pontos e violações se medem por padrão e podem errar — a revisão humana (CSV) decide. Nenhum prompt entra em produção por este relatório.',
    '> **Preços não confirmados:** o custo vem do `usage.cost` do OpenRouter quando existe; senão é estimativa (tokens × preço de lista), e a coluna "origem do custo" diz qual.',
    '',
    '## Resultado por modelo e versão',
    '',
    '| Modelo | Versão | Chamadas | Verificadas | Pontos cobertos | Abre no ato mais recente | "Atual" com o mais recente sem leitura | Negou pendência | Violações | Itens descartados | Falhas de formato | Latência p50 / p95 | Custo médio | Custo total | Origem do custo |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const m of res.linhas) {
    l.push(
      `| ${m.modelo}${m.referencia ? ' (produção)' : ''}${m.interrompido ? ' (interrompido)' : ''} | ${m.versao} | ${m.chamadas} | ${m.verificadas} de ${m.chamadas} | ${m.pontosCobertos}/${m.pontosTotais} (${pct(m.pontosCobertos, m.pontosTotais)}) | ${m.abreNoMaisRecente}/${m.casosComMaisRecenteLido} | ${m.atualIndevida} | ${m.negouPendencia} | ${m.violacoes} | ${m.descartes} | ${m.falhasDeFormato} | ${seg(m.latenciaP50Ms)} / ${seg(m.latenciaP95Ms)} | ${usd(m.custoMedioUsd)} | ${usd(m.custoTotalUsd)} | ${m.fonteDoCusto} |`,
    );
  }
  l.push(
    '',
    '## Como ler',
    '',
    '- **Pontos cobertos**: o gabarito de cada processo (trechos que o resumo deveria conter) que apareceu no texto verificado.',
    '- **Abre no ato mais recente**: nos casos em que o ato mais recente foi lido, o primeiro item de situação cita esse ato.',
    '- **"Atual" com o mais recente sem leitura**: itens de situação que apresentam como atual um ato antigo, quando o ato mais recente NÃO foi lido. É o defeito que a 1.1.0 existe para eliminar: deve ser zero.',
    '- **Negou pendência**: itens que dizem "não há pendências" havendo providência do sistema sem leitura. Também deve ser zero.',
    '- **Itens descartados**: itens que o modelo devolveu e a verificação barrou (inclui as duas regras acima, só na 1.1.0).',
    '- **Verificadas**: o resultado passou pela verificação item a item; "não verificado" aparece na tela como "Leia os atos".',
    '',
  );
  if (res.modelosParados.length > 0) {
    l.push('## Modelos parados', '');
    for (const p of res.modelosParados) l.push(`- ${p.modelo}: ${p.motivo}`);
    l.push('');
  }
  return l.join('\n');
}

export function metricasDeResumoEmCsv(res: ResultadoDaComparacaoDeResumo): string {
  const n = (v: number | undefined, casas: number): string =>
    v === undefined ? '' : v.toFixed(casas).replace('.', ',');
  return escreverCsv([
    [
      'modelo',
      'versao',
      'referencia',
      'chamadas',
      'verificadas',
      'nao_verificadas',
      'falhas_de_formato',
      'pontos_cobertos',
      'pontos_totais',
      'abre_no_mais_recente',
      'casos_com_mais_recente_lido',
      'atual_indevida',
      'negou_pendencia',
      'violacoes',
      'descartes',
      'latencia_p50_ms',
      'latencia_p95_ms',
      'custo_medio_usd',
      'custo_total_usd',
      'origem_do_custo',
    ],
    ...res.linhas.map((m) => [
      m.modelo,
      m.versao,
      m.referencia ? 'sim' : 'nao',
      String(m.chamadas),
      String(m.verificadas),
      String(m.naoVerificadas),
      String(m.falhasDeFormato),
      String(m.pontosCobertos),
      String(m.pontosTotais),
      String(m.abreNoMaisRecente),
      String(m.casosComMaisRecenteLido),
      String(m.atualIndevida),
      String(m.negouPendencia),
      String(m.violacoes),
      String(m.descartes),
      n(m.latenciaP50Ms, 0),
      n(m.latenciaP95Ms, 0),
      n(m.custoMedioUsd, 6),
      n(m.custoTotalUsd, 6),
      m.fonteDoCusto,
    ]),
  ]);
}

/** Para o revisor humano: uma linha por (caso, modelo, versão), com `avaliacao` e `observacao` vazias. */
export function revisaoDeResumoEmCsv(res: ResultadoDaComparacaoDeResumo): string {
  return escreverCsv([
    [
      'caso',
      'categoria',
      'modelo',
      'versao',
      'estado',
      'ato_mais_recente_lido',
      'situacao',
      'pendencias',
      'avaliacao',
      'observacao',
    ],
    ...res.detalhes.map((d) => [
      d.casoId,
      d.categoria,
      d.modelo,
      d.versao,
      d.estado,
      d.maisRecenteLido,
      celulaSegura(d.situacao.join(' | ')),
      celulaSegura(d.pendencias.join(' | ')),
      '',
      '',
    ]),
  ]);
}
