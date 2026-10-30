import {
  LIMITES_DA_SINTESE,
  type CategoriaDeItem,
  type ItemDaSintese,
  type LadoDaPeca,
  type PedidoDaSintese,
  type RespostaDoModeloDaSintese,
} from '../../domain/entities/AnaliseDoProcesso.js';
import type { ItemDaEntrada } from './entradaDaSintese.js';
import { normalizarParaComparar } from './normalizacaoDeTexto.js';
import { numerosForaDoTexto } from './verificarAnalise.js';
import { expressaoProibidaDePecaEm } from './verificarAnaliseDePeca.js';

/**
 * Verificação DETERMINÍSTICA da síntese do processo (v0.66.0). Não confia no modelo em nada; o que falha
 * sai ITEM a ITEM (a síntese cruza muitas coisas, e uma frase ruim não deve apagar o resto):
 *
 * 1. Toda referência tem de existir na entrada (identificador que o sistema deu a um item VERIFICADO da
 *    etapa 1). Referência desconhecida é ignorada; item sem nenhuma referência válida sai (`referencia`).
 * 2. A categoria da referência tem de servir ao campo: pedido só de `.pedido`; defesa só de `.alegacao` ou
 *    `.preliminar` de peça da parte ré (ou de lado não identificado); decisão só de peça do juízo. Ponto
 *    controvertido precisa de itens de pelo menos DUAS peças de lados diferentes. Senão, sai (`forma`).
 * 3. Número, valor ou data escritos pelo modelo têm de estar nos itens que ele apontou (`numero`).
 * 4. Expressão proibida (mérito, chance, conselho, prazo fatal) faz o item sair (`proibida`). Além da
 *    lista da peça, a síntese barra o JUÍZO de procedência na voz do próprio modelo ("o pedido é
 *    procedente", "deve ser julgado improcedente"): cruzar as posições é onde mais tenta dizer quem ganha.
 *    Descrever o pedido ("pede que seja julgado procedente") continua valendo, como na peça.
 * 5. Sem `objeto` verificado, o resultado é "não verificado": a tela manda ler as peças.
 *
 * O modelo não escreve citação: a tela mostra o trecho e a página copiados do resultado da etapa 1 pelas
 * referências. Mude `VERSAO_DAS_REGRAS_DA_SINTESE` junto com qualquer alteração aqui.
 */
export const VERSAO_DAS_REGRAS_DA_SINTESE = '1.0.0';

export interface DescartesDaSintese {
  readonly referencia: number;
  readonly forma: number;
  readonly numero: number;
  readonly proibida: number;
}

export type ResultadoDaVerificacaoDaSintese =
  | {
      readonly estado: 'verificada';
      readonly objeto: ItemDaSintese;
      readonly pedidos: readonly PedidoDaSintese[];
      readonly linhaDoTempo: readonly ItemDaSintese[];
      readonly controvertidos: readonly ItemDaSintese[];
      readonly descartes: DescartesDaSintese;
    }
  | {
      readonly estado: 'nao_verificada';
      readonly motivo: 'sem_objeto_verificado';
      readonly descartes: DescartesDaSintese;
    };

/** `p2.Pedido1`, `[P2.pedido1]` → `P2.pedido1`. */
export function normalizarRef(bruta: string): string {
  const m = /^\[?\s*p(\d{1,2})\s*\.\s*([a-z]+?)(\d{1,2})\s*\]?$/i.exec(bruta.trim());
  if (!m) return '';
  return `P${Number(m[1])}.${(m[2] ?? '').toLowerCase()}${Number(m[3])}`;
}

const JUIZO_DE_PROCEDENCIA =
  /\b(e|sao|seria|seriam|sera|serao|parece|parecem|deve ser|devem ser|deveria ser|deveriam ser|esta|estao)\s+(julgad[oa]s?\s+)?(totalmente\s+|parcialmente\s+)?(im)?procedentes?\b/;

/** O modelo afirma, na própria voz, que algo é (ou será) procedente ou improcedente. */
export function afirmaProcedencia(texto: string): boolean {
  return JUIZO_DE_PROCEDENCIA.test(normalizarParaComparar(texto));
}

export function verificarSintese(
  resposta: RespostaDoModeloDaSintese,
  itens: ReadonlyMap<string, ItemDaEntrada>,
): ResultadoDaVerificacaoDaSintese {
  const d = { referencia: 0, forma: 0, numero: 0, proibida: 0 };

  const conferir = (
    item: ItemDaSintese,
    aceita: (i: ItemDaEntrada) => boolean,
    regraExtra?: (refs: readonly ItemDaEntrada[]) => boolean,
  ): ItemDaSintese | null => {
    const vistos = new Set<string>();
    const refs: ItemDaEntrada[] = [];
    for (const bruta of item.refs) {
      const ref = normalizarRef(bruta);
      const i = itens.get(ref);
      if (!i || vistos.has(ref)) continue;
      vistos.add(ref);
      refs.push(i);
    }
    if (refs.length === 0) {
      d.referencia++;
      return null;
    }
    if (!refs.every(aceita) || (regraExtra && !regraExtra(refs))) {
      d.forma++;
      return null;
    }
    if (
      expressaoProibidaDePecaEm(item.texto) !== undefined ||
      afirmaProcedencia(item.texto)
    ) {
      d.proibida++;
      return null;
    }
    const base = normalizarParaComparar(refs.map((r) => r.base).join('\n'));
    if (numerosForaDoTexto(item.texto, base).length > 0) {
      d.numero++;
      return null;
    }
    return {
      texto: item.texto.trim(),
      refs: refs.slice(0, LIMITES_DA_SINTESE.refsPorItem).map((r) => r.ref),
    };
  };

  const qualquer = (): boolean => true;
  const daCategoria =
    (...cs: readonly CategoriaDeItem[]) =>
    (i: ItemDaEntrada): boolean =>
      cs.includes(i.categoria);
  const doLado =
    (...ls: readonly LadoDaPeca[]) =>
    (i: ItemDaEntrada): boolean =>
      ls.includes(i.lado);
  const e =
    (a: (i: ItemDaEntrada) => boolean, b: (i: ItemDaEntrada) => boolean) =>
    (i: ItemDaEntrada): boolean =>
      a(i) && b(i);
  const ladosDiferentes = (refs: readonly ItemDaEntrada[]): boolean => {
    const pecas = new Set(refs.map((r) => r.peca));
    const lados = new Set(refs.filter((r) => r.lado !== 'juizo').map((r) => r.lado));
    return pecas.size >= 2 && (lados.size >= 2 || lados.has('outro'));
  };

  const objeto = conferir(resposta.objeto, qualquer);
  const pedidos: PedidoDaSintese[] = [];
  for (const p of resposta.pedidos) {
    const base = conferir(p, daCategoria('pedido'));
    if (!base) continue;
    const defesa = p.defesa
      ? conferir(
          p.defesa,
          e(daCategoria('alegacao', 'preliminar'), doLado('reu', 'outro')),
        )
      : null;
    const decisao = p.decisao ? conferir(p.decisao, doLado('juizo')) : null;
    pedidos.push({ ...base, defesa, decisao });
  }
  const linhaDoTempo = resposta.linha_do_tempo
    .map((i) => conferir(i, qualquer))
    .filter((i): i is ItemDaSintese => i !== null);
  const controvertidos = resposta.pontos_controvertidos
    .map((i) => conferir(i, doLado('autor', 'reu', 'outro'), ladosDiferentes))
    .filter((i): i is ItemDaSintese => i !== null);

  if (!objeto)
    return { estado: 'nao_verificada', motivo: 'sem_objeto_verificado', descartes: d };
  return {
    estado: 'verificada',
    objeto,
    pedidos,
    linhaDoTempo,
    controvertidos,
    descartes: d,
  };
}
