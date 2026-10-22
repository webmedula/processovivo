import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import { chaveDaMovimentacao } from '../../domain/entities/Acompanhamento.js';
import { removerCabecalhoInstitucional } from './cabecalhoInstitucional.js';
import { corpoDoAto, temTextoSuficiente } from './entradaDoModelo.js';
import { mesclarMesmoAto } from './mesmoAtoParaOResumo.js';

/**
 * Quais atos entram no resumo de um processo — política PURA (v0.40.0; reescrita na v0.54.0).
 *
 * O resumo só lê o que o sistema já tem: o retrato da conta. Mas um processo grande tem
 * centenas de atos, e o orçamento do pedido é pequeno (custo e latência). A escolha é
 * determinística e dita o que a tela precisa saber: quantos atos ficaram de fora e POR QUÊ.
 *
 *  0. (v0.54.0) o ato só-título e o ato-com-texto que são o mesmo ato contam como um
 *     (`mesclarMesmoAto`), para a seleção — nunca para o retrato;
 *  1. o ato MAIS RECENTE com texto utilizável entra SEMPRE, qualquer que seja o limite;
 *  2. todas as providências em aberto que o sistema marca e têm texto, até `pendentesMax`;
 *  3. os atos mais recentes com texto, até `recentesMax`;
 *  4. uma linha do tempo de TÍTULOS (providências sem texto primeiro, o ato mais recente
 *     sempre) — títulos NÃO gastam o limite de textos.
 *
 * "Texto utilizável" é o mesmo critério da análise de ato (`temTextoSuficiente`) e nunca um
 * ato cujo teor a fonte avisou ser indisponível. O corpo do ato perde o bloco institucional
 * repetido do começo (`removerCabecalhoInstitucional`) antes de contar caracteres e de
 * seguir ao modelo. A seleção também devolve o que a tela precisa dizer: qual é o ato mais
 * recente e se ele foi lido, e quais providências do sistema o resumo NÃO leu.
 */
export const ORCAMENTO_DO_RESUMO = Object.freeze({
  pendentesMax: 8,
  caracteresPorPendente: 2500,
  recentesMax: 10,
  caracteresPorRecente: 1500,
  /** Teto da soma dos textos enviados; cortam-se os mais antigos dos recentes primeiro. */
  totalDeCaracteres: 28_000,
  titulosMax: 40,
  caracteresPorTitulo: 160,
});

/** As regras de seleção de cada versão do prompt; a anterior fica para o comparador. */
export interface RegrasDaSelecao {
  readonly pendentesMax: number;
  /** O ato mais recente com texto entra sempre. */
  readonly garantirMaisRecente: boolean;
  /** Junta o ato só-título e o ato-com-texto que são o mesmo (`mesclarMesmoAto`). */
  readonly mesclarMesmoAto: boolean;
  /** Tira o bloco institucional repetido do começo do texto. */
  readonly limparCabecalho: boolean;
}
export const REGRAS_DA_SELECAO_1_0_0: RegrasDaSelecao = Object.freeze({
  pendentesMax: 5,
  garantirMaisRecente: false,
  mesclarMesmoAto: false,
  limparCabecalho: false,
});
export const REGRAS_DA_SELECAO_1_1_0: RegrasDaSelecao = Object.freeze({
  pendentesMax: ORCAMENTO_DO_RESUMO.pendentesMax,
  garantirMaisRecente: true,
  mesclarMesmoAto: true,
  limparCabecalho: true,
});

export type MotivoDaEscolha = 'providencia' | 'recente' | 'titulo';

export interface AtoDoResumo {
  /** Identificador curto que NÓS damos ao modelo (A1 = o mais recente). */
  readonly id: string;
  readonly ato: Movimentacao;
  readonly chave: string;
  readonly motivo: MotivoDaEscolha;
  /** 0 = só título e data. */
  readonly limiteDeCaracteres: number;
}

/** Por que um ato não foi lido pelo resumo. */
export type MotivoDeNaoLido =
  'teor_indisponivel' | 'sem_texto' | 'abaixo_do_minimo' | 'fora_do_limite';

export interface MotivosDosNaoLidos {
  readonly teorIndisponivel: number;
  readonly semTexto: number;
  readonly abaixoDoMinimo: number;
  readonly foraDoLimite: number;
}

export interface ProvidenciaNaoLida {
  readonly chave: string;
  readonly ato: Movimentacao;
  readonly motivo: MotivoDeNaoLido;
}

export interface SelecaoDoResumo {
  /** Do mais recente ao mais antigo; o identificador segue essa ordem. */
  readonly atos: readonly AtoDoResumo[];
  readonly totalDeAtos: number;
  readonly comTexto: number;
  readonly soTitulo: number;
  /** Atos do processo que não foram enviados nem como título. */
  readonly foraDoResumo: number;
  /** Atos só-título absorvidos por um ato com texto do mesmo dia e tipo (contam como um). */
  readonly mesclados: number;
  /** O ato mais recente (depois da mescla) e se o texto dele foi lido. */
  readonly maisRecente?: {
    readonly chave: string;
    readonly ato: Movimentacao;
    readonly lido: boolean;
  };
  /** Providências do sistema cujo texto o resumo não leu (ordem: mais recente primeiro). */
  readonly providenciasNaoLidas: readonly ProvidenciaNaoLida[];
  /** Todos os atos não lidos, por motivo (só contagens, para o log). */
  readonly motivosDosNaoLidos: MotivosDosNaoLidos;
  /** As providências do sistema depois da mescla (a do só-título passou ao ato com texto). */
  readonly chavesPendentes: ReadonlySet<string>;
  /** A regra do cabeçalho vale para a montagem da mensagem também. */
  readonly regras: RegrasDaSelecao;
}

export function atoTemTextoUtilizavel(ato: Movimentacao): boolean {
  if (ato.teorIndisponivel === true) return false;
  return temTextoSuficiente({
    data: ato.data,
    titulo: ato.titulo,
    ...(ato.conteudo !== undefined ? { conteudo: ato.conteudo } : {}),
    ...(ato.complementos ? { complementos: ato.complementos } : {}),
  });
}

/**
 * O corpo que segue ao modelo: o do ato, sem o bloco institucional do começo quando a regra
 * da versão manda. A limpeza nunca deixa o texto abaixo do mínimo (devolve o original).
 */
export function corpoDoAtoParaOResumo(
  ato: Movimentacao,
  limparCabecalho: boolean,
): string {
  const corpo = corpoDoAto({
    data: ato.data,
    titulo: ato.titulo,
    ...(ato.conteudo !== undefined ? { conteudo: ato.conteudo } : {}),
    ...(ato.complementos ? { complementos: ato.complementos } : {}),
  });
  return limparCabecalho ? removerCabecalhoInstitucional(corpo) : corpo;
}

/** Por que o ato não tem texto utilizável (só vale se `atoTemTextoUtilizavel` for falso). */
function motivoSemTexto(ato: Movimentacao): Exclude<MotivoDeNaoLido, 'fora_do_limite'> {
  if (ato.teorIndisponivel === true) return 'teor_indisponivel';
  const tamanho = corpoDoAto({
    data: ato.data,
    titulo: ato.titulo,
    ...(ato.conteudo !== undefined ? { conteudo: ato.conteudo } : {}),
    ...(ato.complementos ? { complementos: ato.complementos } : {}),
  })
    .replace(/\s+/g, ' ')
    .trim().length;
  return tamanho === 0 ? 'sem_texto' : 'abaixo_do_minimo';
}

/**
 * @param movimentacoes o retrato inteiro da conta
 * @param chavesPendentes `chaveDaMovimentacao` dos atos que o sistema marca como pedem
 *   providência em aberto (`atosQuePedemProvidencia`)
 */
export function selecionarAtosParaResumo(
  movimentacoes: readonly Movimentacao[],
  chavesPendentes: ReadonlySet<string>,
  regras: RegrasDaSelecao = REGRAS_DA_SELECAO_1_1_0,
): SelecaoDoResumo {
  const o = ORCAMENTO_DO_RESUMO;
  // Mais recente primeiro; empate de data fica na ordem do retrato (ordenação estável).
  const todos = movimentacoes
    .map((ato, i) => ({ ato, i, chave: chaveDaMovimentacao(ato) }))
    .sort((a, b) => b.ato.data.getTime() - a.ato.data.getTime() || a.i - b.i);

  // 0. Mesmo ato em duas fontes: o só-título some da seleção e a providência dele passa ao
  //    ato com texto (que o resumo vai ler).
  const absorvidos = regras.mesclarMesmoAto
    ? mesclarMesmoAto(
        todos.map((x) => x.ato),
        atoTemTextoUtilizavel,
      )
    : new Map<string, string>();
  const pendentes = new Set(chavesPendentes);
  for (const [sem, com] of absorvidos) if (chavesPendentes.has(sem)) pendentes.add(com);
  const ordenados = todos.filter((x) => !absorvidos.has(x.chave));
  const mesclados = todos.length - ordenados.length;

  const escolhidos = new Map<string, { motivo: MotivoDaEscolha; limite: number }>();
  const textoDe = (x: { ato: Movimentacao }): number =>
    corpoDoAtoParaOResumo(x.ato, regras.limparCabecalho).length;

  // 1. O ato mais recente COM texto entra sempre (é a "situação atual" que o resumo conta).
  const maisNovoComTexto = ordenados.find((x) => atoTemTextoUtilizavel(x.ato));
  let recentes = 0;
  if (regras.garantirMaisRecente && maisNovoComTexto) {
    escolhidos.set(maisNovoComTexto.chave, {
      motivo: pendentes.has(maisNovoComTexto.chave) ? 'providencia' : 'recente',
      limite: o.caracteresPorPendente,
    });
    if (!pendentes.has(maisNovoComTexto.chave)) recentes++;
  }

  // 2. Providências em aberto com texto utilizável.
  let nPendentes = [...escolhidos.values()].filter(
    (e) => e.motivo === 'providencia',
  ).length;
  for (const x of ordenados) {
    if (nPendentes >= regras.pendentesMax) break;
    if (!pendentes.has(x.chave) || !atoTemTextoUtilizavel(x.ato)) continue;
    if (escolhidos.has(x.chave)) continue;
    escolhidos.set(x.chave, { motivo: 'providencia', limite: o.caracteresPorPendente });
    nPendentes++;
  }

  // 3. Os mais recentes com texto utilizável.
  for (const x of ordenados) {
    if (recentes >= o.recentesMax) break;
    if (escolhidos.has(x.chave) || !atoTemTextoUtilizavel(x.ato)) continue;
    escolhidos.set(x.chave, { motivo: 'recente', limite: o.caracteresPorRecente });
    recentes++;
  }

  // Orçamento: corta os recentes mais ANTIGOS até a soma caber. Providência e o ato mais
  // recente com texto não se cortam.
  const soma = (): number =>
    ordenados.reduce((total, x) => {
      const e = escolhidos.get(x.chave);
      return e ? total + Math.min(e.limite, textoDe(x)) : total;
    }, 0);
  for (let i = ordenados.length - 1; i >= 0 && soma() > o.totalDeCaracteres; i--) {
    const x = ordenados[i];
    if (!x || escolhidos.get(x.chave)?.motivo !== 'recente') continue;
    if (regras.garantirMaisRecente && x.chave === maisNovoComTexto?.chave) continue;
    escolhidos.delete(x.chave);
  }

  // 4. Linha do tempo de títulos: o ato mais recente, as providências sem texto, os recentes.
  const titulos: string[] = [];
  const poeTitulo = (chave: string): void => {
    if (titulos.length >= o.titulosMax) return;
    if (escolhidos.has(chave) || titulos.includes(chave)) return;
    titulos.push(chave);
  };
  const maisNovo = ordenados[0];
  if (regras.garantirMaisRecente && maisNovo) poeTitulo(maisNovo.chave);
  for (const x of ordenados) if (pendentes.has(x.chave)) poeTitulo(x.chave);
  for (const x of ordenados) poeTitulo(x.chave);

  const noResumo = new Set<string>([...escolhidos.keys(), ...titulos]);
  const atos: AtoDoResumo[] = [];
  let n = 0;
  const jaNaLista = new Set<string>();
  for (const x of ordenados) {
    // Dois atos de mesma chave são o mesmo ato para o resto do sistema: entra um só.
    if (!noResumo.has(x.chave) || jaNaLista.has(x.chave)) continue;
    jaNaLista.add(x.chave);
    n++;
    const e = escolhidos.get(x.chave);
    atos.push({
      id: `A${n}`,
      ato: x.ato,
      chave: x.chave,
      motivo: e ? e.motivo : 'titulo',
      limiteDeCaracteres: e ? e.limite : 0,
    });
  }
  const comTexto = atos.filter((a) => a.limiteDeCaracteres > 0).length;

  // O que a tela precisa dizer: o ato mais recente foi lido? Quais providências não foram?
  const motivos = {
    teorIndisponivel: 0,
    semTexto: 0,
    abaixoDoMinimo: 0,
    foraDoLimite: 0,
  };
  const naoLidas: ProvidenciaNaoLida[] = [];
  const motivoDe = (x: { ato: Movimentacao }): MotivoDeNaoLido =>
    atoTemTextoUtilizavel(x.ato) ? 'fora_do_limite' : motivoSemTexto(x.ato);
  const vistas = new Set<string>();
  for (const x of ordenados) {
    if (vistas.has(x.chave)) continue;
    vistas.add(x.chave);
    if (escolhidos.has(x.chave)) continue;
    const motivo = motivoDe(x);
    if (motivo === 'teor_indisponivel') motivos.teorIndisponivel++;
    else if (motivo === 'sem_texto') motivos.semTexto++;
    else if (motivo === 'abaixo_do_minimo') motivos.abaixoDoMinimo++;
    else motivos.foraDoLimite++;
    if (pendentes.has(x.chave)) naoLidas.push({ chave: x.chave, ato: x.ato, motivo });
  }
  return {
    atos,
    totalDeAtos: movimentacoes.length,
    comTexto,
    soTitulo: atos.length - comTexto,
    foraDoResumo: movimentacoes.length - atos.length - mesclados,
    mesclados,
    ...(maisNovo
      ? {
          maisRecente: {
            chave: maisNovo.chave,
            ato: maisNovo.ato,
            lido: escolhidos.has(maisNovo.chave),
          },
        }
      : {}),
    providenciasNaoLidas: naoLidas,
    motivosDosNaoLidos: motivos,
    chavesPendentes: new Set([...pendentes].filter((c) => !absorvidos.has(c))),
    regras,
  };
}
