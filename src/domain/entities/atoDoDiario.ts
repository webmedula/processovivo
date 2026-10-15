/**
 * O ato veio do Diário (DJEN)? (v0.39.0)
 *
 * Só ato do Diário tem a data de DISPONIBILIZAÇÃO, que é o termo inicial do prazo; a data dos
 * demais atos é a do cartório ou do sistema do tribunal, e dela não se tira termo inicial. O
 * identificador externo é prefixado pela fonte (`djen:<id>`), e fica no ato mesmo depois da
 * fusão com o DataJud — a `fonte` da linha pode ter sido trocada, o prefixo não.
 */
export function atoDoDiario(ato: { readonly idExterno?: string | undefined }): boolean {
  return ato.idExterno?.startsWith('djen:') === true;
}
