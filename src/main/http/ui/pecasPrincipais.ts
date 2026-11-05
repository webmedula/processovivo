/**
 * O atalho "Peças principais" da análise do processo (v0.66.0), em função PURA e AUTOCONTIDA: vai ao
 * navegador por `toString()` (como `descricaoDoAto`), então o teste exercita a MESMA função da tela.
 *
 * Marca pelo RÓTULO do tribunal: petição inicial, contestação, réplica (e impugnação à contestação),
 * decisões, sentença, acórdão e recursos. **O laudo NÃO entra** (decisão do dono, 29/10/2026): é onde mais
 * aparece dado de saúde, e só entra se o advogado o marcar à mão. Peça sob sigilo e linha sem peça nunca
 * entram, nem o despacho que o tribunal chama de "inicial". O atalho só MARCA: nada é enviado sem o advogado confirmar. No máximo `limite` peças, as mais
 * recentes quando passam disso (o fim do processo costuma ter a decisão que importa).
 */
export function pecasPrincipais(
  pecas: ReadonlyArray<{
    readonly pecaId: string;
    readonly rotulo: string;
    readonly estado?: string;
    readonly semPeca?: boolean;
  }>,
  limite: number,
): string[] {
  const normal = (t: string): string =>
    String(t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  const sim =
    /peticao\b[^a-z]*inicial|contestacao|replica|impugnacao a contestacao|decisao|sentenca|acordao|recurso|apelacao|agravo|embargos/;
  const ids = pecas
    .filter((p) => !p.semPeca && p.estado !== 'sigilo')
    .filter((p) => {
      const r = normal(p.rotulo);
      return sim.test(r) && !/laudo/.test(r);
    })
    .map((p) => p.pecaId);
  return ids.length > limite ? ids.slice(ids.length - limite) : ids;
}
