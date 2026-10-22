import { chaveDaMovimentacao } from '../../domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import { normalizarParaComparar } from './normalizacaoDeTexto.js';

/**
 * Quando um ato só com título (em geral do DataJud) e um ato com texto (em geral do DJEN)
 * são o MESMO ato para a seleção do resumo (v0.54.0).
 *
 * As fontes não compartilham identificador: o DataJud diz "Despacho" no dia 05/10 e o DJEN
 * traz o despacho com o texto no mesmo dia, como duas linhas. Sem juntá-las, o resumo achava
 * que o ato mais recente (a linha só com título) não foi lido e que havia uma providência a
 * mais sem texto, quando o texto estava ali, na linha ao lado.
 *
 * A regra é CONSERVADORA e só vale para a SELEÇÃO — o retrato, a tela, as contagens do
 * sistema e o "pede providência" não mudam. Junta apenas quando TUDO isto é verdade:
 *  - mesmo dia (fuso de São Paulo) e mesma CLASSE de ato, reconhecida pelo começo do título
 *    (despacho, decisão, sentença, intimação, citação, ato ordinatório, edital);
 *  - uma delas tem texto utilizável e a outra não tem (e a outra NÃO é "teor indisponível");
 *  - as fontes são DIFERENTES (dois despachos do mesmo diário no mesmo dia são dois atos);
 *  - há exatamente UMA de cada no dia e na classe — qualquer outra contagem é dúvida, e na
 *    dúvida não se junta.
 */
export type ClasseDoAto =
  | 'despacho'
  | 'decisao'
  | 'sentenca'
  | 'intimacao'
  | 'citacao'
  | 'ato_ordinatorio'
  | 'edital';

const CLASSES: ReadonlyArray<readonly [ClasseDoAto, RegExp]> = [
  ['despacho', /^despacho\b/],
  ['decisao', /^decisao\b/],
  ['sentenca', /^sentenca\b/],
  ['intimacao', /^intimacao\b/],
  ['citacao', /^citacao\b/],
  ['ato_ordinatorio', /^ato ordinatorio\b/],
  ['edital', /^edital\b/],
];

export function classeDoAto(titulo: string): ClasseDoAto | undefined {
  const t = normalizarParaComparar(titulo);
  return CLASSES.find(([, r]) => r.test(t))?.[0];
}

/** Dia do calendário em São Paulo (-03:00 fixo), como o resto do sistema. */
export function diaLocal(data: Date): string {
  return new Date(data.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

/** O prefixo da fonte do ato (`djen`, `datajud`, `mni`…), ou `fonte`, ou nada. */
export function origemDoAto(ato: Movimentacao): string {
  const prefixo = ato.idExterno?.split(':')[0]?.toLowerCase();
  return prefixo || ato.fonte?.toLowerCase() || '';
}

/**
 * @returns `chave do ato só com título` → `chave do ato com texto` que o absorve.
 * @param temTexto o MESMO critério do resumo (`atoTemTextoUtilizavel`)
 */
export function mesclarMesmoAto(
  atos: readonly Movimentacao[],
  temTexto: (ato: Movimentacao) => boolean,
): Map<string, string> {
  const baldes = new Map<
    string,
    { comTexto: Movimentacao[]; semTexto: Movimentacao[] }
  >();
  for (const ato of atos) {
    const classe = classeDoAto(ato.titulo);
    if (!classe) continue;
    const balde = `${diaLocal(ato.data)}|${classe}`;
    const g = baldes.get(balde) ?? { comTexto: [], semTexto: [] };
    baldes.set(balde, g);
    // O "teor indisponível" também entra em `semTexto`: conta para a dúvida (ver abaixo).
    if (temTexto(ato)) g.comTexto.push(ato);
    else g.semTexto.push(ato);
  }
  const absorvidos = new Map<string, string>();
  for (const g of baldes.values()) {
    const [com] = g.comTexto;
    const [sem] = g.semTexto;
    if (g.comTexto.length !== 1 || g.semTexto.length !== 1 || !com || !sem) continue;
    if (sem.teorIndisponivel === true) continue;
    const origemCom = origemDoAto(com);
    const origemSem = origemDoAto(sem);
    if (origemCom === '' || origemSem === '' || origemCom === origemSem) continue;
    absorvidos.set(chaveDaMovimentacao(sem), chaveDaMovimentacao(com));
  }
  return absorvidos;
}
