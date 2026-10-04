/**
 * Calibração do número da movimentação com o Projudi (v0.35.0).
 *
 * O Projudi numera em sequência TODOS os atos, inclusive os bloqueados que o
 * MNI não entrega. Logo `número no Projudi = posição no MNI + bloqueados antes
 * dele`: o deslocamento `d = número − posição` nunca é negativo e nunca diminui
 * ao longo do processo. Só o advogado, olhando a tela do Projudi, sabe um
 * número de verdade — cada âncora é um par (posição, número) informado por ele.
 *
 * O número só sai como EXATO quando as âncoras PROVAM (deslocamento igual dos
 * dois lados, ou o próprio ato ancorado). Entre âncoras de deslocamento
 * diferente a resposta honesta é uma FAIXA, nunca um número arredondado; depois
 * da última, uma ESTIMATIVA. Nada aqui lê texto de peça nem consulta o tribunal.
 */

/** Teto de âncoras por processo: o suficiente para refinar, pouco para abusar. */
export const MAX_ANCORAS_POR_PROCESSO = 50;
/** Teto de sanidade do número digitado: nenhum processo chega perto. */
export const MAX_NUMERO_PROJUDI = 100_000;

export interface AncoraDeNumeracao {
  readonly posicao: number;
  readonly numeroProjudi: number;
}

export type NumeroDoProjudi =
  /** Sem calibração: a posição calculada (comportamento da 0.34.0, com aviso). */
  | { readonly tipo: 'posicao'; readonly n: number }
  | { readonly tipo: 'exato'; readonly n: number }
  | { readonly tipo: 'faixa'; readonly min: number; readonly max: number }
  | { readonly tipo: 'estimado'; readonly n: number };

export interface ResumoDaNumeracao {
  readonly exatos: number;
  readonly faixas: number;
  readonly estimados: number;
  readonly total: number;
}

function ordenadas(ancoras: readonly AncoraDeNumeracao[]): AncoraDeNumeracao[] {
  return [...ancoras].sort((a, b) => a.posicao - b.posicao);
}

const desloc = (a: AncoraDeNumeracao): number => a.numeroProjudi - a.posicao;

export function numeroDoProjudi(
  posicao: number,
  ancoras: readonly AncoraDeNumeracao[],
  totalRecebido: number,
): NumeroDoProjudi {
  // Posição fora dos atos recebidos não tem o que afirmar além de si mesma.
  if (ancoras.length === 0 || posicao < 1 || posicao > totalRecebido) {
    return { tipo: 'posicao', n: posicao };
  }
  const lista = ordenadas(ancoras);
  const propria = lista.find((a) => a.posicao === posicao);
  if (propria) return { tipo: 'exato', n: propria.numeroProjudi };

  let antes: AncoraDeNumeracao | undefined;
  let depois: AncoraDeNumeracao | undefined;
  for (const a of lista) {
    if (a.posicao < posicao) antes = a;
    else if (!depois) depois = a;
  }
  if (antes && depois) {
    const dA = desloc(antes);
    const dB = desloc(depois);
    return dA === dB
      ? { tipo: 'exato', n: posicao + dA }
      : { tipo: 'faixa', min: posicao + dA, max: posicao + dB };
  }
  if (depois) {
    // Antes da primeira âncora: d está entre 0 (nenhum bloqueado) e dF.
    const dF = desloc(depois);
    return dF === 0
      ? { tipo: 'exato', n: posicao }
      : { tipo: 'faixa', min: posicao, max: posicao + dF };
  }
  // Depois da última: atos novos podem ter vindo, e pode haver novo bloqueado.
  // (Âncora no último ato recebido não deixa posição "depois" a calcular.)
  return { tipo: 'estimado', n: posicao + desloc(antes as AncoraDeNumeracao) };
}

export function resumirNumeracao(
  ancoras: readonly AncoraDeNumeracao[],
  totalRecebido: number,
): ResumoDaNumeracao {
  let exatos = 0;
  let faixas = 0;
  let estimados = 0;
  for (let p = 1; p <= totalRecebido; p++) {
    const r = numeroDoProjudi(p, ancoras, totalRecebido);
    if (r.tipo === 'exato') exatos++;
    else if (r.tipo === 'faixa') faixas++;
    else if (r.tipo === 'estimado') estimados++;
  }
  return { exatos, faixas, estimados, total: totalRecebido };
}

/**
 * Confere uma âncora nova contra as existentes (a de mesma posição é
 * substituída). Devolve o motivo da recusa, ou `undefined` se serve.
 */
export function motivoDeRecusaDaAncora(
  nova: AncoraDeNumeracao,
  existentes: readonly AncoraDeNumeracao[],
  totalRecebido: number,
): string | undefined {
  if (
    !Number.isInteger(nova.posicao) ||
    nova.posicao < 1 ||
    nova.posicao > totalRecebido
  ) {
    return `A posição do ato deve estar entre 1 e ${totalRecebido}.`;
  }
  if (
    !Number.isInteger(nova.numeroProjudi) ||
    nova.numeroProjudi < 1 ||
    nova.numeroProjudi > MAX_NUMERO_PROJUDI
  ) {
    return 'Informe o número da movimentação como aparece no Projudi (inteiro positivo).';
  }
  if (nova.numeroProjudi < nova.posicao) {
    return (
      `O número ${nova.numeroProjudi} é menor que ${nova.posicao}, a posição deste ato ` +
      'entre os atos recebidos — o Projudi nunca numera abaixo disso. Confira o número.'
    );
  }
  const outras = existentes.filter((a) => a.posicao !== nova.posicao);
  if (
    !existentes.some((a) => a.posicao === nova.posicao) &&
    existentes.length >= MAX_ANCORAS_POR_PROCESSO
  ) {
    return `Este processo já tem ${MAX_ANCORAS_POR_PROCESSO} números informados. Remova algum antes de acrescentar outro.`;
  }
  const todas = ordenadas([...outras, nova]);
  for (let i = 1; i < todas.length; i++) {
    const a = todas[i - 1] as AncoraDeNumeracao;
    const b = todas[i] as AncoraDeNumeracao;
    if (desloc(b) < desloc(a)) {
      return 'Esse número não é compatível com os outros que você informou.';
    }
  }
  return undefined;
}
