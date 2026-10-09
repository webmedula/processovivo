/**
 * Para quem o DJEN endereçou uma comunicação, visto do workspace (v0.37.6).
 *
 * O DJEN publica a comunicação com os destinatários (as partes) e os advogados
 * delas, com inscrição na OAB. A consulta por NÚMERO devolve todas as
 * comunicações do processo, inclusive as dirigidas à outra parte e ao advogado
 * dela — e o sistema tratava toda "Intimação" como pedido de providência para
 * quem acompanha. Em `Movimentacao`:
 *
 *  - `destinatariosOab` é TRANSITÓRIO: as inscrições dos advogados da
 *    comunicação, em memória, só entre o mapper e a gravação do acompanhamento.
 *    Nunca vai para o banco nem para a resposta da API — inscrição de terceiro
 *    não é dado que o produto guarda;
 *  - `paraOUsuario` é o que sobra e persiste: só `sim`, `nao` ou `desconhecido`.
 *
 * Não é prova de nada: o advogado de um sócio do escritório (outra inscrição,
 * não cadastrada) aparece como `nao`. Por isso `nao` não esconde ninguém — a tela
 * diz quantos processos saíram do filtro por causa dele e oferece "Ver".
 */
export type ParaOUsuario = 'sim' | 'nao' | 'desconhecido';

/** "47383/GO": número sem zeros à esquerda e sem letra, UF em maiúsculas. Vazio se não der para comparar. */
export function chaveDeOab(
  numero: string | null | undefined,
  uf: string | null | undefined,
): string {
  const n = (numero ?? '')
    .toUpperCase()
    .replace(/[.\s-]/g, '')
    .match(/^(\d{1,7})[A-Z]?$/)?.[1];
  const u = (uf ?? '').trim().toUpperCase();
  if (!n || !/^[A-Z]{2}$/.test(u)) return '';
  return `${n.replace(/^0+(?=\d)/, '')}/${u}`;
}

/**
 * `desconhecido` quando não dá para afirmar: o workspace não cadastrou OAB
 * nenhuma, ou a comunicação não trouxe nenhum advogado com inscrição legível
 * (parte sem advogado, campo vazio). `sim` se qualquer inscrição da comunicação
 * é do workspace; `nao` se há inscrições legíveis e nenhuma é dele.
 */
export function calcularParaOUsuario(
  destinatariosOab: readonly string[] | undefined,
  oabsDoWorkspace: ReadonlySet<string>,
): ParaOUsuario {
  if (oabsDoWorkspace.size === 0) return 'desconhecido';
  if (!destinatariosOab || destinatariosOab.length === 0) return 'desconhecido';
  return destinatariosOab.some((o) => oabsDoWorkspace.has(o)) ? 'sim' : 'nao';
}
