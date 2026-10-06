/**
 * Regras PURAS da tabela de Atualizações (v0.37.0): filtros com contador,
 * ordenação, paginação, fatia das atualizações anteriores e texto das partes.
 *
 * Mesma estratégia de `trechoDeTexto.ts`: o console é JavaScript dentro de uma
 * string (`atualizacoes.ts`), então o navegador recebe `funcao.toString()` e o
 * teste exercita exatamente a mesma função. Por isso cada função é
 * AUTOCONTIDA — nada de helper, constante de módulo ou chamada a outra função
 * deste arquivo no corpo.
 *
 * Estas funções só ORDENAM e CONTAM. Nenhuma esconde atualização: o único filtro
 * que tira linha da tela é o que a pessoa escolheu, e a tela diz quantas tirou.
 */

/** O mínimo que as regras leem de uma linha (um grupo de `agruparNovidades`). */
export interface GrupoDaTabela {
  readonly numero: string;
  readonly maisRecente: { readonly data: string; readonly detectadaEm: string };
  readonly anteriores: readonly unknown[];
  readonly naoVistas: number;
  readonly processo: {
    readonly tribunal: string | null;
    readonly pedeProvidencia: boolean;
  } | null;
}

export type SituacaoFiltro = 'todas' | 'naoLidas' | 'providencia';
export type ChaveDeOrdem = 'processo' | 'tribunal' | 'dataAto' | 'detectado';
export interface OrdemDaTabela {
  readonly chave: ChaveDeOrdem;
  readonly direcao: 'asc' | 'desc';
}

export interface ContagemDeSituacoes {
  readonly todas: number;
  readonly naoLidas: number;
  readonly pedemProvidencia: number;
}

/**
 * Quantos PROCESSOS cada filtro traz, sobre a base que a pessoa já escolheu
 * (período + tribunal). "Não lida" = o processo tem atualização ainda não vista;
 * "pede providência" = `estadoDaPasta` do servidor, a mesma regra e a mesma
 * janela dos cartões que esta tabela substituiu.
 */
export function contarSituacoes(grupos: readonly GrupoDaTabela[]): ContagemDeSituacoes {
  let naoLidas = 0;
  let pedemProvidencia = 0;
  for (const g of grupos) {
    if (g.naoVistas > 0) naoLidas += 1;
    if (g.processo && g.processo.pedeProvidencia) pedemProvidencia += 1;
  }
  return { todas: grupos.length, naoLidas, pedemProvidencia };
}

export function filtrarPorSituacao<T extends GrupoDaTabela>(
  grupos: readonly T[],
  situacao: SituacaoFiltro,
): T[] {
  if (situacao === 'naoLidas') return grupos.filter((g) => g.naoVistas > 0);
  if (situacao === 'providencia') {
    return grupos.filter((g) => !!g.processo && g.processo.pedeProvidencia);
  }
  return grupos.slice();
}

/**
 * Primeiro clique ordena; o segundo inverte; o terceiro volta à ordem de
 * chegada. Datas começam pela mais recente, texto pela ordem alfabética.
 */
export function proximaOrdem(
  atual: OrdemDaTabela | null,
  chave: ChaveDeOrdem,
): OrdemDaTabela | null {
  const ehData = chave === 'dataAto' || chave === 'detectado';
  const primeira = ehData ? 'desc' : 'asc';
  if (!atual || atual.chave !== chave) return { chave, direcao: primeira };
  if (atual.direcao === primeira) {
    return { chave, direcao: primeira === 'asc' ? 'desc' : 'asc' };
  }
  return null;
}

/**
 * Ordenação ESTÁVEL: empate mantém a ordem de chegada (a ordem atual da página).
 * `ordem === null` devolve a ordem de chegada, sem inventar uma nova.
 */
export function ordenarGrupos<T extends GrupoDaTabela>(
  grupos: readonly T[],
  ordem: OrdemDaTabela | null,
): T[] {
  const copia = grupos.map((g, i) => ({ g, i }));
  if (!ordem) return copia.map((x) => x.g);
  const sinal = ordem.direcao === 'asc' ? 1 : -1;
  const valor = (g: T): number | string => {
    if (ordem.chave === 'processo') return g.numero.replace(/\D/g, '');
    if (ordem.chave === 'tribunal') return (g.processo?.tribunal ?? '').toLowerCase();
    const iso =
      ordem.chave === 'dataAto' ? g.maisRecente.data : g.maisRecente.detectadaEm;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  copia.sort((a, b) => {
    const va = valor(a.g);
    const vb = valor(b.g);
    // Tribunal vazio vai para o fim nas duas direções: ordenar não esconde, mas
    // também não põe a linha sem dado na frente de quem tem.
    if (ordem.chave === 'tribunal' && (va === '') !== (vb === '')) {
      return va === '' ? 1 : -1;
    }
    const c =
      typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'pt-BR');
    return c * sinal || a.i - b.i;
  });
  return copia.map((x) => x.g);
}

export interface PaginaCalculada {
  readonly pagina: number;
  readonly paginas: number;
  /** Índice (0-based) do primeiro item; `fim` é exclusivo. */
  readonly inicio: number;
  readonly fim: number;
  /** "X–Y de Z": `de` e `ate` já em base 1; ambos 0 quando não há itens. */
  readonly de: number;
  readonly ate: number;
  readonly total: number;
}

/** Página pedida fora do intervalo é ajustada, nunca vira tela vazia. */
export function paginar(
  total: number,
  paginaPedida: number,
  porPagina: number,
): PaginaCalculada {
  const tam = Math.max(1, Math.floor(porPagina) || 1);
  const n = Math.max(0, Math.floor(total) || 0);
  const paginas = Math.max(1, Math.ceil(n / tam));
  const pagina = Math.min(Math.max(1, Math.floor(paginaPedida) || 1), paginas);
  const inicio = (pagina - 1) * tam;
  const fim = Math.min(inicio + tam, n);
  return {
    pagina,
    paginas,
    inicio,
    fim,
    de: n === 0 ? 0 : inicio + 1,
    ate: fim,
    total: n,
  };
}

export interface FatiaDeAnteriores {
  /** Quantas já estão na tela. */
  readonly mostrando: number;
  readonly total: number;
  readonly faltam: number;
  /** Quantas o botão "Mostrar mais" traz agora (no máximo o lote). */
  readonly proximoLote: number;
}

/**
 * As anteriores de um processo entram em lotes (20 + 20 …): um processo com 300
 * não vira 300 blocos de uma vez. `pedido` é quantas a pessoa já quis ver.
 */
export function fatiaDeAnteriores(
  total: number,
  pedido: number,
  lote: number = 20,
): FatiaDeAnteriores {
  const n = Math.max(0, Math.floor(total) || 0);
  const tam = Math.max(1, Math.floor(lote) || 20);
  const mostrando = Math.min(n, Math.max(tam, Math.floor(pedido) || 0));
  const faltam = n - mostrando;
  return { mostrando, total: n, faltam, proximoLote: Math.min(tam, faltam) };
}

interface PoloDasPartes {
  readonly nomes: readonly string[];
  readonly total: number;
}

/**
 * "Autor × Réu" como a fonte entregou, com "+N" quando o servidor cortou a lista.
 * Vazio quando a fonte não trouxe parte nenhuma — a tela põe "—"; nada é deduzido.
 */
export function textoDePartes(
  partes: { readonly ativo: PoloDasPartes; readonly passivo: PoloDasPartes } | null,
): string {
  if (!partes) return '';
  const lado = (polo: PoloDasPartes): string => {
    if (!polo || polo.total === 0) return '';
    const resto = polo.total - polo.nomes.length;
    return polo.nomes.join('; ') + (resto > 0 ? ' +' + resto : '');
  };
  const a = lado(partes.ativo);
  const p = lado(partes.passivo);
  if (!a && !p) return '';
  // Um polo só: o traço diz que o OUTRO não veio — sem ele, "Fulano" não diria de que lado está.
  return (a || '—') + ' × ' + (p || '—');
}
