import type { FuncaoDeIa } from './ControleDaIa.js';

/**
 * Modelo por função de IA (v0.60.0, Fase B do painel de IA). Política PURA: o vocabulário, as regras
 * de publicação e a resolução do modelo efetivo. Quem lê, grava e executa é o `ServicoModelosDeIa`
 * e o `ServicoTesteDeModelo`.
 *
 * O que não se discute: a lista de modelos permitidos mora no CÓDIGO (nunca no banco nem na tela) e o
 * painel só escolhe dentro dela. ZDR, redação, verificação e segredo de justiça não existem aqui:
 * valem em TODA chamada, pelo adaptador, qualquer que seja o modelo escolhido.
 */

export type StatusDoModelo = 'ativo' | 'descontinuado';

/**
 * `confirmada`: ZDR e preço conferidos (com data e fonte) — só estes podem ser testados e publicados.
 * `pendente`: o item existe (é o modelo que já roda em produção), mas ainda falta registrar a
 * confirmação; ele segue valendo como o modelo ATUAL e nunca aparece como candidato.
 */
export type ConfirmacaoDoModelo = 'confirmada' | 'pendente';

export interface ItemDoCatalogo {
  /** Id real do modelo no provedor (sem `~` nem `:`). */
  readonly id: string;
  readonly provedor: string;
  readonly apelido: string;
  readonly confirmacao: ConfirmacaoDoModelo;
  /** Dia (AAAA-MM-DD) em que o ZDR foi conferido; `null` só em item pendente. */
  readonly zdrConfirmadoEm: string | null;
  /** Onde o ZDR foi conferido (texto curto, sem segredo). */
  readonly zdrFonte: string | null;
  /** US$ por milhão de tokens; `null` só em item pendente. */
  readonly precoEntradaPorMTokens: number | null;
  readonly precoSaidaPorMTokens: number | null;
  readonly janelaContexto: number | null;
  readonly funcoesPermitidas: readonly FuncaoDeIa[];
  readonly status: StatusDoModelo;
}

export interface CatalogoDeModelos {
  buscar(id: string): ItemDoCatalogo | undefined;
  todos(): readonly ItemDoCatalogo[];
}

export function criarCatalogo(itens: readonly ItemDoCatalogo[]): CatalogoDeModelos {
  const porId = new Map(itens.map((i) => [i.id, i]));
  return Object.freeze({
    buscar: (id: string) => porId.get(id),
    todos: () => itens,
  });
}

/** O item pode ser escolhido para esta função (testar, publicar)? Pendente e descontinuado, nunca. */
export function podeSerCandidato(
  item: ItemDoCatalogo | undefined,
  funcao: FuncaoDeIa,
): item is ItemDoCatalogo {
  return (
    item !== undefined &&
    item.status === 'ativo' &&
    item.confirmacao === 'confirmada' &&
    item.funcoesPermitidas.includes(funcao)
  );
}

// --- regras de publicação (constantes do código; a tela só as MOSTRA) -------------------------------

export const REGRAS_DE_PUBLICACAO = Object.freeze({
  /** Taxa absoluta mínima de citação verificada. */
  citacaoVerificadaMinima: 0.95,
  /** Falhas de formato do candidato acima da referência por mais de 2 pontos percentuais bloqueiam. */
  falhasDeFormatoMaxPp: 2,
  /** Queda de pontos obrigatórios tolerável (com aprovação) de até 3 pontos percentuais. */
  quedaDePontosMaxPp: 3,
  /** Latência p95 tolerável (com aprovação) até +30% sobre a referência. */
  aumentoDaLatenciaP95Max: 0.3,
  /** Teto de gasto por rodada de teste. */
  tetoDaRodadaUsd: 1,
  /** O teste vale para publicar por 24 horas. */
  validadeDoTesteHoras: 24,
  /** Volume usado para o impacto estimado por dia: últimos 30 dias. */
  diasDeVolume: 30,
});

/** Tolerância numérica das comparações de limite exato (2,0 / 3,0 pontos; +30%; 95%). */
const EPS = 1e-9;

export const MOTIVOS_DE_APROVACAO = [
  'custo_aceitavel',
  'qualidade_aceitavel',
  'latencia_aceitavel',
  'modelo_atual_com_problema',
  'outro',
] as const;
export type MotivoDeAprovacao = (typeof MOTIVOS_DE_APROVACAO)[number];

export const ROTULO_DO_MOTIVO_DE_APROVACAO: Readonly<Record<MotivoDeAprovacao, string>> =
  Object.freeze({
    custo_aceitavel: 'Aceito o custo maior',
    qualidade_aceitavel: 'Aceito a pequena queda de qualidade',
    latencia_aceitavel: 'Aceito a resposta mais lenta',
    modelo_atual_com_problema: 'O modelo atual está com problema',
    outro: 'Outro motivo',
  });

/** A palavra que o operador digita para aprovar uma ressalva. */
export const PALAVRA_DE_CONFIRMACAO = 'PUBLICAR';
export const TAMANHO_MAXIMO_DA_OBSERVACAO = 80;

/**
 * A observação curta é texto livre; não há como provar que não tem dado pessoal, então a regra é
 * restritiva: letras, números, espaço e pontuação simples; sem "@", sem barras, sem URL e com no
 * máximo 4 dígitos no total.
 */
export function observacaoValida(texto: string): boolean {
  if (texto.length > TAMANHO_MAXIMO_DA_OBSERVACAO) return false;
  if (!/^[\p{L}\p{N} .,;:()!?-]*$/u.test(texto)) return false;
  // Mais de 4 dígitos no total (mesmo separados): CNJ, CPF, telefone e OAB nunca cabem.
  if (texto.replace(/\D/g, '').length > 4) return false;
  return true;
}

// --- métricas e veredito ----------------------------------------------------------------------------

/** As métricas de UM modelo numa rodada, na mesma forma para as três funções. SÓ números. */
export interface MetricasDoModelo {
  readonly modelo: string;
  /** Chamadas que o produto faria (casos sem texto suficiente não contam). */
  readonly chamadas: number;
  readonly respondidas: number;
  /** 0..1; `null` = nenhuma citação para medir. */
  readonly citacaoVerificada: number | null;
  readonly pontosCobertos: number;
  readonly pontosTotais: number;
  readonly violacoes: number;
  readonly falhasDeFormato: number;
  readonly naoVerificadas: number;
  /** Chamadas que terminaram em erro do provedor, sem ZDR ou sem provedor confirmado. */
  readonly chamadasComErro: number;
  /** Rodada parada no meio (ZDR, provedor, teto de gasto). */
  readonly interrompido: boolean;
  readonly latenciaP50Ms: number | null;
  readonly latenciaP95Ms: number | null;
  readonly custoMedioUsd: number | null;
  readonly custoP95Usd: number | null;
  readonly custoMaximoUsd: number | null;
  readonly custoTotalUsd: number | null;
  readonly fonteDoCusto: 'openrouter' | 'estimativa' | 'nao-medido';
}

export type Veredito = 'aprovado' | 'aprovado_com_ressalva' | 'bloqueado';

export const MOTIVOS_DE_BLOQUEIO = [
  'sem_zdr',
  'teste_incompleto',
  'erro_do_provedor',
  'violacao_acima_da_referencia',
  'citacao_abaixo_do_minimo',
  'citacao_sem_dado',
  'falhas_de_formato_acima',
  'pontos_sem_dado',
  'pontos_queda_acima_do_limite',
  'latencia_sem_dado',
  'latencia_acima_do_limite',
] as const;
export type MotivoDeBloqueio = (typeof MOTIVOS_DE_BLOQUEIO)[number];

export const MOTIVOS_DE_RESSALVA = [
  'citacao_menor',
  'falhas_de_formato_maiores',
  'pontos_em_queda',
  'latencia_maior',
  'custo_maior',
  'custo_nao_medido',
] as const;
export type MotivoDeRessalva = (typeof MOTIVOS_DE_RESSALVA)[number];

/** Frases FIXAS (a tela nunca mostra texto do servidor, do modelo ou do provedor). */
export const FRASE_DO_BLOQUEIO: Readonly<Record<MotivoDeBloqueio, string>> =
  Object.freeze({
    sem_zdr:
      'O modelo não tem retenção zero de dados (ZDR) confirmada. Nada foi enviado.',
    teste_incompleto: 'O teste ficou incompleto. Refaça o teste.',
    erro_do_provedor: 'O provedor devolveu erro em alguma chamada do teste.',
    violacao_acima_da_referencia:
      'O modelo novo cometeu mais violações (prazo calculado, valor, data ou nome inventado) do que o atual na mesma rodada.',
    citacao_abaixo_do_minimo: 'A taxa de citação verificada ficou abaixo de 95%.',
    citacao_sem_dado: 'Não foi possível medir a citação verificada.',
    falhas_de_formato_acima:
      'As falhas de formato passaram do modelo atual em mais de 2 pontos percentuais.',
    pontos_sem_dado: 'Não foi possível medir os pontos obrigatórios.',
    pontos_queda_acima_do_limite:
      'Os pontos obrigatórios caíram mais de 3 pontos percentuais em relação ao modelo atual.',
    latencia_sem_dado: 'Não foi possível medir o tempo de resposta.',
    latencia_acima_do_limite:
      'O tempo de resposta p95 ficou mais de 30% acima do modelo atual.',
  });

export const FRASE_DA_RESSALVA: Readonly<Record<MotivoDeRessalva, string>> =
  Object.freeze({
    citacao_menor:
      'A citação verificada ficou menor que a do modelo atual (ainda acima de 95%).',
    falhas_de_formato_maiores:
      'Há mais falhas de formato que no modelo atual (até 2 pontos percentuais).',
    pontos_em_queda:
      'Os pontos obrigatórios atendidos caíram em relação ao modelo atual (até 3 pontos percentuais).',
    latencia_maior:
      'O tempo de resposta p95 ficou maior que o do modelo atual (até 30%).',
    custo_maior: 'O custo médio por chamada ficou maior que o do modelo atual.',
    custo_nao_medido: 'O custo não pôde ser medido, então não dá para comparar.',
  });

export interface ResultadoDoVeredito {
  readonly veredito: Veredito;
  readonly bloqueios: readonly MotivoDeBloqueio[];
  readonly ressalvas: readonly MotivoDeRessalva[];
}

const taxa = (parte: number, total: number): number | null =>
  total > 0 ? parte / total : null;

export const taxaDePontos = (m: MetricasDoModelo): number | null =>
  taxa(m.pontosCobertos, m.pontosTotais);
export const taxaDeFormato = (m: MetricasDoModelo): number | null =>
  taxa(m.falhasDeFormato, m.chamadas);

/**
 * O veredito da troca de modelo, pelas regras do dono. DUAS classes:
 *  - **bloqueio duro** (nenhuma aprovação manual publica): sem ZDR; mais violações que a referência;
 *    citação verificada < 95%; falhas de formato > referência + 2 pp; rodada incompleta ou com erro do
 *    provedor. Também bloqueia, por coerência, o que passa do limite da queda tolerável (> 3 pp de
 *    pontos; > +30% de latência p95) e o que não pôde ser medido;
 *  - **ressalva** (publica só com confirmação digitada e motivo): qualquer piora dentro dos limites —
 *    pontos até −3 pp, latência p95 até +30%, custo médio maior (qualquer valor).
 * Tudo igual ou melhor = aprovado. Os limites exatos (2,0 / 3,0 pp; +30%; 95%) passam.
 */
export function julgarTeste(
  candidato: MetricasDoModelo,
  referencia: MetricasDoModelo,
): ResultadoDoVeredito {
  const bloqueios: MotivoDeBloqueio[] = [];
  const ressalvas: MotivoDeRessalva[] = [];

  if (candidato.interrompido || referencia.interrompido || candidato.chamadas === 0) {
    bloqueios.push('teste_incompleto');
  }
  if (candidato.chamadasComErro > 0 || referencia.chamadasComErro > 0) {
    bloqueios.push('erro_do_provedor');
  }
  if (candidato.violacoes > referencia.violacoes) {
    bloqueios.push('violacao_acima_da_referencia');
  }

  if (candidato.citacaoVerificada === null) {
    bloqueios.push('citacao_sem_dado');
  } else if (
    candidato.citacaoVerificada <
    REGRAS_DE_PUBLICACAO.citacaoVerificadaMinima - EPS
  ) {
    bloqueios.push('citacao_abaixo_do_minimo');
  } else if (
    referencia.citacaoVerificada !== null &&
    candidato.citacaoVerificada < referencia.citacaoVerificada - EPS
  ) {
    ressalvas.push('citacao_menor');
  }

  const fc = taxaDeFormato(candidato);
  const fr = taxaDeFormato(referencia);
  if (fc !== null && fr !== null) {
    const ppFormato = (fc - fr) * 100;
    if (ppFormato > REGRAS_DE_PUBLICACAO.falhasDeFormatoMaxPp + EPS) {
      bloqueios.push('falhas_de_formato_acima');
    } else if (ppFormato > EPS) {
      ressalvas.push('falhas_de_formato_maiores');
    }
  }

  const pc = taxaDePontos(candidato);
  const pr = taxaDePontos(referencia);
  if (pc === null || pr === null) {
    bloqueios.push('pontos_sem_dado');
  } else {
    const ppPontos = (pc - pr) * 100;
    if (ppPontos < -REGRAS_DE_PUBLICACAO.quedaDePontosMaxPp - EPS) {
      bloqueios.push('pontos_queda_acima_do_limite');
    } else if (ppPontos < -EPS) {
      ressalvas.push('pontos_em_queda');
    }
  }

  const lc = candidato.latenciaP95Ms;
  const lr = referencia.latenciaP95Ms;
  if (lc === null || lr === null || lr <= 0) {
    bloqueios.push('latencia_sem_dado');
  } else {
    const aumento = lc / lr - 1;
    if (aumento > REGRAS_DE_PUBLICACAO.aumentoDaLatenciaP95Max + EPS) {
      bloqueios.push('latencia_acima_do_limite');
    } else if (aumento > EPS) {
      ressalvas.push('latencia_maior');
    }
  }

  const cc = candidato.custoMedioUsd;
  const cr = referencia.custoMedioUsd;
  if (cc === null || cr === null) {
    ressalvas.push('custo_nao_medido');
  } else if (cc > cr * (1 + EPS) + 1e-15) {
    ressalvas.push('custo_maior');
  }

  const veredito: Veredito =
    bloqueios.length > 0
      ? 'bloqueado'
      : ressalvas.length > 0
        ? 'aprovado_com_ressalva'
        : 'aprovado';
  return { veredito, bloqueios, ressalvas };
}

/**
 * Impacto estimado por dia no custo, no volume dos últimos 30 dias: (custo médio do candidato −
 * custo médio do atual) × análises por dia. `null` quando falta custo ou volume.
 */
export function impactoPorDiaUsd(
  candidato: MetricasDoModelo,
  referencia: MetricasDoModelo,
  analisesNosUltimosDias: number,
  dias: number = REGRAS_DE_PUBLICACAO.diasDeVolume,
): number | null {
  if (candidato.custoMedioUsd === null || referencia.custoMedioUsd === null) return null;
  return (
    ((candidato.custoMedioUsd - referencia.custoMedioUsd) * analisesNosUltimosDias) / dias
  );
}

// --- resolução do modelo efetivo ---------------------------------------------------------------------

export type OrigemDoModelo = 'painel' | 'ambiente';

export interface ModeloEfetivo {
  readonly modelo: string;
  readonly origem: OrigemDoModelo;
  /** O painel guarda um modelo, mas ele saiu da lista, está descontinuado ou não serve a esta função. */
  readonly painelInvalido: boolean;
}

/**
 * painel (se válido, na lista e ativo) → ambiente (que já traz o padrão do código). Um modelo do
 * painel que deixou de valer cai no ambiente SEM erro, e o resultado avisa (`painelInvalido`).
 */
export function resolverModelo(
  funcao: FuncaoDeIa,
  doPainel: string | null,
  doAmbiente: string,
  catalogo: CatalogoDeModelos,
): ModeloEfetivo {
  if (doPainel === null)
    return { modelo: doAmbiente, origem: 'ambiente', painelInvalido: false };
  const item = catalogo.buscar(doPainel);
  const valido =
    item !== undefined &&
    item.status === 'ativo' &&
    item.confirmacao === 'confirmada' &&
    item.funcoesPermitidas.includes(funcao);
  return valido
    ? { modelo: doPainel, origem: 'painel', painelInvalido: false }
    : { modelo: doAmbiente, origem: 'ambiente', painelInvalido: true };
}

// --- comparação para a tela ---------------------------------------------------------------------------

export type FormatoDaMetrica = 'pct' | 'ms' | 'usd' | 'n';

export interface LinhaDaComparacao {
  readonly chave: string;
  readonly rotulo: string;
  readonly formato: FormatoDaMetrica;
  readonly referencia: number | null;
  readonly candidato: number | null;
  /** candidato − referência (fração, ms, US$ ou contagem); `null` sem um dos dois. */
  readonly diferenca: number | null;
  /** `true` = o candidato é melhor; `false` = pior; `null` = igual ou sem dado. */
  readonly melhor: boolean | null;
}

/**
 * As linhas da tabela candidato × atual: os mesmos números que o veredito usa, com a diferença em cada
 * um. Quem desenha só formata; a conta mora aqui (e é testada).
 */
export function linhasDaComparacao(
  c: MetricasDoModelo,
  r: MetricasDoModelo,
): LinhaDaComparacao[] {
  const linha = (
    chave: string,
    rotulo: string,
    formato: FormatoDaMetrica,
    ref: number | null,
    cand: number | null,
    menorEMelhor: boolean,
  ): LinhaDaComparacao => {
    const dif = ref === null || cand === null ? null : cand - ref;
    const igual = dif === null || Math.abs(dif) <= EPS;
    return {
      chave,
      rotulo,
      formato,
      referencia: ref,
      candidato: cand,
      diferenca: dif,
      melhor: igual || dif === null ? null : menorEMelhor ? dif < 0 : dif > 0,
    };
  };
  return [
    linha(
      'citacao',
      'Citação verificada',
      'pct',
      r.citacaoVerificada,
      c.citacaoVerificada,
      false,
    ),
    linha(
      'pontos',
      'Pontos obrigatórios atendidos',
      'pct',
      taxaDePontos(r),
      taxaDePontos(c),
      false,
    ),
    linha('violacoes', 'Violações', 'n', r.violacoes, c.violacoes, true),
    linha(
      'formato',
      'Falhas de formato',
      'pct',
      taxaDeFormato(r),
      taxaDeFormato(c),
      true,
    ),
    linha(
      'naoVerificadas',
      'Não verificadas',
      'n',
      r.naoVerificadas,
      c.naoVerificadas,
      true,
    ),
    linha(
      'latenciaP50',
      'Tempo de resposta p50',
      'ms',
      r.latenciaP50Ms,
      c.latenciaP50Ms,
      true,
    ),
    linha(
      'latenciaP95',
      'Tempo de resposta p95',
      'ms',
      r.latenciaP95Ms,
      c.latenciaP95Ms,
      true,
    ),
    linha(
      'custoMedio',
      'Custo médio por chamada',
      'usd',
      r.custoMedioUsd,
      c.custoMedioUsd,
      true,
    ),
    linha('custoP95', 'Custo p95', 'usd', r.custoP95Usd, c.custoP95Usd, true),
    linha('custoMaximo', 'Custo máximo', 'usd', r.custoMaximoUsd, c.custoMaximoUsd, true),
    linha('custoTotal', 'Custo da rodada', 'usd', r.custoTotalUsd, c.custoTotalUsd, true),
    linha('chamadas', 'Chamadas', 'n', r.chamadas, c.chamadas, false),
  ];
}
