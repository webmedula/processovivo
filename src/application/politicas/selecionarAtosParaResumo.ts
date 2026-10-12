import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import { chaveDaMovimentacao } from '../../domain/entities/Acompanhamento.js';
import { corpoDoAto, temTextoSuficiente } from './entradaDoModelo.js';

/**
 * Quais atos entram no resumo de um processo (v0.40.0) — política PURA.
 *
 * O resumo só lê o que o sistema já tem: o retrato da conta. Mas um processo grande tem
 * centenas de atos, e o orçamento do pedido é pequeno (custo e latência). A escolha é
 * determinística e dita o que a tela precisa saber: quantos atos ficaram de fora.
 *
 *  1. as providências em aberto que o sistema marca (as que têm texto utilizável),
 *     até `pendentesMax`, com mais caracteres cada;
 *  2. os atos mais recentes com texto utilizável, até `recentesMax`;
 *  3. uma linha do tempo de TÍTULOS e datas (sem texto) — as providências em aberto sem
 *     texto utilizável primeiro, depois os atos mais recentes —, até `titulosMax`.
 *
 * "Texto utilizável" é o mesmo critério da análise de ato (`temTextoSuficiente`) e nunca um
 * ato cujo teor a fonte avisou ser indisponível. Os números abaixo são uma ESTIMATIVA de
 * orçamento (cerca de 28 mil caracteres ≈ 7 a 8 mil tokens de texto): a lista ZDR do modelo
 * não pôde ser consultada para fixar preço e janela de contexto reais (ver o CHANGELOG).
 */
export const ORCAMENTO_DO_RESUMO = Object.freeze({
  pendentesMax: 5,
  caracteresPorPendente: 2500,
  recentesMax: 10,
  caracteresPorRecente: 1500,
  /** Teto da soma dos textos enviados; cortam-se os mais antigos dos recentes primeiro. */
  totalDeCaracteres: 28_000,
  titulosMax: 40,
  caracteresPorTitulo: 160,
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

export interface SelecaoDoResumo {
  /** Do mais recente ao mais antigo; o identificador segue essa ordem. */
  readonly atos: readonly AtoDoResumo[];
  readonly totalDeAtos: number;
  readonly comTexto: number;
  readonly soTitulo: number;
  /** Atos do processo que não foram enviados nem como título. */
  readonly foraDoResumo: number;
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

function tamanhoDoTexto(ato: Movimentacao): number {
  return corpoDoAto({
    data: ato.data,
    titulo: ato.titulo,
    ...(ato.conteudo !== undefined ? { conteudo: ato.conteudo } : {}),
    ...(ato.complementos ? { complementos: ato.complementos } : {}),
  }).length;
}

/**
 * @param movimentacoes o retrato inteiro da conta
 * @param chavesPendentes `chaveDaMovimentacao` dos atos que o sistema marca como pedem
 *   providência em aberto (`atosQuePedemProvidencia`)
 */
export function selecionarAtosParaResumo(
  movimentacoes: readonly Movimentacao[],
  chavesPendentes: ReadonlySet<string>,
): SelecaoDoResumo {
  const o = ORCAMENTO_DO_RESUMO;
  // Mais recente primeiro; empate de data fica na ordem do retrato (ordenação estável).
  const ordenados = movimentacoes
    .map((ato, i) => ({ ato, i, chave: chaveDaMovimentacao(ato) }))
    .sort((a, b) => b.ato.data.getTime() - a.ato.data.getTime() || a.i - b.i);

  const escolhidos = new Map<string, { motivo: MotivoDaEscolha; limite: number }>();

  // 1. Providências em aberto com texto utilizável.
  let pendentes = 0;
  for (const x of ordenados) {
    if (pendentes >= o.pendentesMax) break;
    if (!chavesPendentes.has(x.chave) || !atoTemTextoUtilizavel(x.ato)) continue;
    if (escolhidos.has(x.chave)) continue;
    escolhidos.set(x.chave, { motivo: 'providencia', limite: o.caracteresPorPendente });
    pendentes++;
  }

  // 2. Os mais recentes com texto utilizável.
  let recentes = 0;
  for (const x of ordenados) {
    if (recentes >= o.recentesMax) break;
    if (escolhidos.has(x.chave) || !atoTemTextoUtilizavel(x.ato)) continue;
    escolhidos.set(x.chave, { motivo: 'recente', limite: o.caracteresPorRecente });
    recentes++;
  }

  // Orçamento: corta os recentes mais ANTIGOS até a soma caber. Providência não se corta.
  const soma = (): number =>
    ordenados.reduce((total, x) => {
      const e = escolhidos.get(x.chave);
      return e ? total + Math.min(e.limite, tamanhoDoTexto(x.ato)) : total;
    }, 0);
  for (let i = ordenados.length - 1; i >= 0 && soma() > o.totalDeCaracteres; i--) {
    const x = ordenados[i];
    if (x && escolhidos.get(x.chave)?.motivo === 'recente') escolhidos.delete(x.chave);
  }

  // 3. Linha do tempo de títulos: providências sem texto primeiro, depois os mais recentes.
  const titulos: string[] = [];
  const poeTitulo = (chave: string): void => {
    if (titulos.length >= o.titulosMax) return;
    if (escolhidos.has(chave) || titulos.includes(chave)) return;
    titulos.push(chave);
  };
  for (const x of ordenados) if (chavesPendentes.has(x.chave)) poeTitulo(x.chave);
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
  return {
    atos,
    totalDeAtos: movimentacoes.length,
    comTexto,
    soTitulo: atos.length - comTexto,
    foraDoResumo: movimentacoes.length - atos.length,
  };
}
