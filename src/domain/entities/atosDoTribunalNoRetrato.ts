import type { Movimentacao } from './Movimentacao.js';
import type { Processo } from './Processo.js';
import { batizarPeloCodigo, naoCobertas } from './linhaDoTempo.js';

/**
 * O nome que os andamentos lidos no sistema do tribunal (MNI/Projudi) carregam em `fonte`.
 *
 * É o mesmo `NOME_MNI` do adapter; repetido aqui porque o domínio não importa a infraestrutura.
 * Há teste que confere os dois.
 */
export const FONTE_DO_TRIBUNAL = 'mni';

/**
 * Junta ao retrato das fontes públicas os andamentos que o próprio tribunal informou (v0.72.0).
 *
 * Por que existe: o DataJud atualiza com atraso e o Diário só traz o que foi publicado, então a
 * varredura via o despacho dias depois de ele estar no Projudi. Com a credencial do advogado o
 * tribunal entrega a linha do tempo inteira, inclusive o que ainda não foi publicado.
 *
 * As regras, todas escritas contra perder andamento:
 *
 * - **O tribunal tem a preferência no ato que as duas fontes contam**, pela MESMA regra da régua
 *   da tela do processo (`naoCobertas`): linha pública só sai enquanto o tribunal tiver PELO MENOS
 *   tantas linhas no mesmo balde (mesmo dia e mesmo código, ou mesmo título). A contagem de atos
 *   nunca diminui. Preferir o tribunal (e não o DataJud) é o que impede o mesmo ato de virar
 *   novidade duas vezes: quando o DataJud alcança o Projudi, a linha dele cai num balde já coberto.
 * - **O Diário nunca é coberto na prática** (não traz código e data a publicação, não o ato): a
 *   publicação continua no retrato com o texto, o tipo da comunicação e o destinatário — é dela que
 *   saem a intimação, o "pede providência" e a data de publicação.
 * - **Sem consulta nova, os andamentos do tribunal do retrato ANTERIOR continuam.** Consulta pulada
 *   (nada mudou no tribunal), falha, credencial recusada ou removida: o que o tribunal já afirmou
 *   não deixa de ser verdade, e tirá-lo faria as linhas do DataJud que ele cobria voltarem com
 *   chave nova — e virarem novidade de novo.
 * - **Segredo de justiça não se complementa por outra fonte** (CLAUDE.md §8): devolve o público.
 */
export function incorporarAtosDoTribunal(
  publico: Processo,
  atosDoTribunal: readonly Movimentacao[] | undefined,
  anterior: Processo | undefined,
): Processo {
  if (publico.segredoJustica) return publico;

  const frescos =
    atosDoTribunal && atosDoTribunal.length > 0
      ? atosDoTribunal.map((m) => (m.fonte ? m : { ...m, fonte: FONTE_DO_TRIBUNAL }))
      : undefined;
  const doTribunal =
    frescos ??
    (anterior && !anterior.segredoJustica
      ? anterior.movimentacoes.filter((m) => m.fonte === FONTE_DO_TRIBUNAL)
      : []);
  if (doTribunal.length === 0) return publico;

  // O retrato público pode já trazer linhas do tribunal (veio de um retrato fundido, como na
  // vigilância por OAB): elas são substituídas pelas de agora, nunca somadas.
  const publicas = publico.movimentacoes.filter((m) => m.fonte !== FONTE_DO_TRIBUNAL);
  const nomeadas = batizarPeloCodigo(doTribunal, publicas);

  const fontes = publico.procedencia.provider.split('+').filter(Boolean);
  if (!fontes.includes(FONTE_DO_TRIBUNAL)) fontes.push(FONTE_DO_TRIBUNAL);

  return publico.comAlteracoes({
    movimentacoes: [...nomeadas, ...naoCobertas(publicas, nomeadas)],
    procedencia: { ...publico.procedencia, provider: fontes.join('+') },
  });
}

/** O andamento foi lido no sistema do tribunal (e pode ainda não ter sido publicado no Diário). */
export function veioDoTribunal(m: { readonly fonte?: string | null }): boolean {
  return m.fonte === FONTE_DO_TRIBUNAL;
}
