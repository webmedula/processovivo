/**
 * Por que um processo está "sem verificação" (v0.69.0), numa lista FECHADA.
 *
 * A tela inicial dizia "1 sem verificação — o silêncio destas não significa que nada
 * aconteceu" sem dizer QUAL processo. O advogado recebia o aviso e não tinha como agir. A
 * tela agora lista os processos, e cada um leva um destes motivos.
 *
 * Decide pelo CÓDIGO do erro de domínio que `ServicoAcompanhamento` grava no começo da
 * mensagem (`CODIGO: mensagem`), nunca por palavra solta da mensagem: o código é nosso e
 * estável; a mensagem pode trazer texto da fonte (e endereço interno), e por isso nunca vai
 * para a tela. Sem evidência para um motivo específico, é `outro` — palpite errado manda o
 * advogado conferir a coisa errada (mesma lição do diagnóstico de SMTP, CLAUDE.md §8).
 */
export type MotivoSemVerificacao =
  /** Acabou de ser acompanhado e ainda não houve consulta que desse certo nem que falhasse. */
  | 'aguardando_primeira'
  /** As fontes responderam e nenhuma tem o processo (número digitado errado, recém-distribuído). */
  | 'nao_encontrado'
  /** As fontes não responderam: rede, tempo esgotado, 5xx, resposta fora do contrato, bloqueio. */
  | 'fontes_indisponiveis'
  /** A última tentativa falhou por outro motivo. */
  | 'outro';

const FONTES_INDISPONIVEIS = new Set([
  'TODAS_AS_FONTES_FALHARAM',
  'PROVIDER_INDISPONIVEL',
  'RESPOSTA_INVALIDA',
  'MNI_BLOQUEADO',
]);

export function motivoSemVerificacao(
  erro: string | undefined,
  sincronizadoEm: Date | undefined,
): MotivoSemVerificacao {
  if (erro === undefined)
    return sincronizadoEm === undefined ? 'aguardando_primeira' : 'outro';
  const codigo = /^([A-Z][A-Z0-9_]*):/.exec(erro)?.[1];
  if (codigo === 'PROCESSO_NAO_ENCONTRADO') return 'nao_encontrado';
  if (codigo !== undefined && FONTES_INDISPONIVEIS.has(codigo))
    return 'fontes_indisponiveis';
  return 'outro';
}
