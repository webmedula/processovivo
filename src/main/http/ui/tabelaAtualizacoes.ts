/**
 * Regras PURAS da tabela de Atualizações (v0.37.0): filtros com contador,
 * ordenação, paginação e texto das partes.
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
  readonly maisRecente: {
    /** `null` só em processo sem nenhuma movimentação conhecida. */
    readonly data: string | null;
    /** `null` em processo sem novidade registrada: o acompanhamento não detectou nada. */
    readonly detectadaEm: string | null;
  };
  /** Quantas atualizações o processo tem no período (a tela só mostra a mais recente). */
  readonly quantidade: number;
  readonly naoVistas: number;
  readonly processo: {
    readonly tribunal: string | null;
    readonly pedeProvidencia: boolean;
    /** (v0.37.5) O ato que gera a providência e o que a marca/o tempo tiraram. Ausente em servidor antigo. */
    readonly providencia?: ProvidenciaDaLinha | null;
  } | null;
}

/** O ato que gera (ou gerou) a providência, como `GET /v1/novidades` o manda. */
export interface AtoDaLinha {
  readonly rotulo: string;
  readonly data: string;
  readonly chave: string;
  readonly tipo: 'intimacao' | 'citacao' | 'outro';
  /** (v0.37.6) A comunicação do Diário é dirigida a quem acompanha? Ausente em servidor antigo = `desconhecido`. */
  readonly paraOUsuario?: 'sim' | 'nao' | 'desconhecido';
}

/**
 * `pede`: pede providência agora. `cumprida`: pediria, mas o advogado marcou.
 * `venceu`: intimação/citação que passou da janela sem marca.
 */
export interface ProvidenciaDaLinha {
  /** `outro` (v0.37.6): só há intimação/citação dirigida a OUTRO destinatário. */
  readonly situacao: 'pede' | 'cumprida' | 'venceu' | 'outro';
  readonly motivo: AtoDaLinha;
  readonly cumpridoEm: string | null;
  /** Intimação/citação do Diário dirigida a outro destinatário, sem marca, na janela de 30 dias. */
  readonly outroDestinatario?: AtoDaLinha | null;
}

/** Linha de processo acompanhado sem novidade registrada, como o servidor a manda (`semNovidade`). */
export interface ProcessoSemNovidade {
  readonly numero: string;
  readonly processo: GrupoDaTabela['processo'];
  readonly segredoJustica: boolean;
  readonly ultimaMovimentacao: {
    readonly data: string;
    readonly titulo: string;
    readonly conteudo: string | null;
  } | null;
}

/**
 * `cumpridos` não é um chip: é o "Ver" da frase "N marcados como cumpridos" (v0.37.5),
 * a lista dos processos que o advogado marcou, com o "Desfazer". `outros` (v0.37.6) é o
 * "Ver" de "N com intimação a outro destinatário".
 */
export type SituacaoFiltro = 'todas' | 'naoLidas' | 'providencia' | 'cumpridos' | 'outros';

/**
 * O filtro de Situação com que a aba abre (v0.37.4, decisão do dono, opção A):
 * "Pedem providência". Convive com "triagem ordena, nunca esconde" porque o filtro
 * é escolhido pelo POSITIVO (`estadoDaPasta === 'PROVIDENCIA'`), a tela diz sempre
 * quantos processos ficaram de fora e a lista completa está a um clique. Vive só na
 * página (variável do módulo): recarregar volta a este valor.
 */
export const SITUACAO_PADRAO: SituacaoFiltro = 'providencia';
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

export interface TextoDeProvidencia {
  /** `vazio`: nenhum pede; `parcial`: m < N; `todos`: m = N. */
  readonly modo: 'vazio' | 'parcial' | 'todos';
  /** Frase pronta, em texto puro (quem desenha escapa). Vazia no modo `vazio`. */
  readonly frase: string;
  /** "Ver todos" só existe quando o filtro esconde alguém. */
  readonly verTodos: boolean;
}

/**
 * A frase de situação do filtro "Pedem providência": m = processos que pedem,
 * n = processos da base (período + tribunal). `complemento` é o que a tela já diz
 * da base (" em TJGO"…), em texto puro. Sem a palavra "prazo": é leitura do
 * andamento, não contagem.
 */
export function textoDeProvidencia(
  m: number,
  n: number,
  complemento: string,
): TextoDeProvidencia {
  const acomp = n === 1 ? 'processo acompanhado' : 'processos acompanhados';
  if (m === 0) return { modo: 'vazio', frase: '', verTodos: n > 0 };
  if (m === n) {
    return {
      modo: 'todos',
      frase:
        'Mostrando ' +
        m +
        ' de ' +
        n +
        ' ' +
        acomp +
        complemento +
        (n === 1 ? ': pede providência.' : ': todos pedem providência.'),
      verTodos: false,
    };
  }
  return {
    modo: 'parcial',
    frase:
      'Mostrando ' +
      m +
      ' de ' +
      n +
      ' ' +
      acomp +
      complemento +
      ': só os que pedem providência',
    verTodos: true,
  };
}

/**
 * Processos que o filtro de providência NÃO consegue avaliar: acompanhados sem
 * nenhuma movimentação conhecida (nunca sincronizados, ou sem retrato). Sem dado
 * não há leitura — e a tela não inventa providência; diz quantos são.
 */
export function contarSemLeitura(
  grupos: ReadonlyArray<{
    readonly semNovidade?: boolean;
    readonly maisRecente: { readonly data: string | null };
  }>,
): number {
  let n = 0;
  for (const g of grupos)
    if (g.semNovidade === true && g.maisRecente.data === null) n += 1;
  return n;
}

/**
 * Quantos PROCESSOS a marca de "cumprido" tirou de "Pedem providência" e quantos
 * passaram da janela da intimação/citação sem marca (v0.37.5). Os dois números
 * existem para a tela dizer o que o filtro deixou de fora — nada some calado.
 */
export function contarSaidasDaProvidencia(
  grupos: ReadonlyArray<{
    readonly processo: {
      readonly pedeProvidencia?: boolean;
      readonly providencia?: {
        readonly situacao: string;
        readonly outroDestinatario?: unknown;
      } | null;
    } | null;
  }>,
): { readonly cumpridos: number; readonly vencidos: number; readonly outros: number } {
  let cumpridos = 0;
  let vencidos = 0;
  let outros = 0;
  for (const g of grupos) {
    const p = g.processo && g.processo.providencia ? g.processo.providencia : null;
    if (!p) continue;
    if (p.situacao === 'cumprida') cumpridos += 1;
    else if (p.situacao === 'venceu') vencidos += 1;
    // Só conta quem o filtro de fato deixou de fora: processo que pede providência por
    // outro ato está na lista e a linha já diz que há intimação a outro destinatário.
    if (p.outroDestinatario && !g.processo?.pedeProvidencia) outros += 1;
  }
  return { cumpridos, vencidos, outros };
}

/**
 * As frases que acompanham "Pedem providência": "N marcados como cumpridos",
 * "N sem marca há mais de 30 dias" e (v0.37.6) "N com intimação a outro destinatário".
 * Vazias quando o número é zero. Sem a palavra "prazo": a janela é de leitura
 * automática, não de contagem.
 */
export function frasesDeSaidas(
  cumpridos: number,
  vencidos: number,
  janelaDias: number,
  outros: number = 0,
): {
  readonly cumpridos: string;
  readonly vencidos: string;
  readonly outros: string;
} {
  return {
    cumpridos:
      cumpridos <= 0
        ? ''
        : cumpridos === 1
          ? '1 marcado como cumprido'
          : cumpridos + ' marcados como cumpridos',
    vencidos:
      vencidos <= 0 ? '' : vencidos + ' sem marca há mais de ' + janelaDias + ' dias',
    outros: outros <= 0 ? '' : outros + ' com intimação a outro destinatário',
  };
}

/**
 * O ato que a LINHA mostra (v0.37.6). Quando o processo pede providência, é o ato que
 * gera a providência — rótulo, data, selo e, se for o mesmo da atualização, o trecho —
 * e o último andamento, quando é outro, vai numa segunda linha. Sem providência, é a
 * atualização da linha, como antes. Assim a data do ato, o selo e o rótulo falam do
 * MESMO ato (antes a linha mostrava um ato e o selo vinha de outro).
 *
 * `igualAAtualizacao`: o ato exibido é o da atualização/última movimentação da linha
 * (só nesse caso o trecho de texto dela é dele). Compara rótulo e data: a novidade não
 * guarda o identificador da fonte.
 */
export function atoExibido(g: {
  readonly maisRecente: { readonly data: string | null; readonly titulo?: string };
  readonly processo: {
    readonly providencia?: {
      readonly situacao: string;
      readonly motivo: {
        readonly rotulo: string;
        readonly data: string;
        readonly tipo: string;
        readonly paraOUsuario?: string;
      };
    } | null;
  } | null;
}): {
  readonly rotulo: string;
  readonly data: string | null;
  readonly tipo: string;
  readonly paraOUsuario: string;
  readonly daProvidencia: boolean;
  readonly igualAAtualizacao: boolean;
  readonly ultimoAndamento: { readonly rotulo: string; readonly data: string } | null;
} {
  const n = g.maisRecente;
  const p = g.processo && g.processo.providencia ? g.processo.providencia : null;
  if (!p || p.situacao !== 'pede') {
    return {
      rotulo: n.titulo || '',
      data: n.data,
      tipo: 'outro',
      paraOUsuario: 'desconhecido',
      daProvidencia: false,
      igualAAtualizacao: true,
      ultimoAndamento: null,
    };
  }
  const mesmo = n.data === p.motivo.data && n.titulo === p.motivo.rotulo;
  return {
    rotulo: p.motivo.rotulo,
    data: p.motivo.data,
    tipo: p.motivo.tipo,
    paraOUsuario: p.motivo.paraOUsuario || 'desconhecido',
    daProvidencia: true,
    igualAAtualizacao: mesmo,
    ultimoAndamento:
      mesmo || !n.data || !n.titulo ? null : { rotulo: n.titulo, data: n.data },
  };
}

/**
 * "Detectado" e data do ato estão longe um do outro? (v0.37.6) Mais de 7 dias de
 * diferença: o "há 2 dias" sozinho sugere ato novo, quando a data do ato é de semanas
 * atrás. Só decide qual TEXTO a coluna mostra; não toca a ordenação nem `detectadaEm`.
 */
export function detectadoDistanteDoAto(
  dataDoAto: string | null,
  detectadaEm: string | null,
): boolean {
  if (!dataDoAto || !detectadaEm) return false;
  const a = new Date(dataDoAto).getTime();
  const d = new Date(detectadaEm).getTime();
  if (Number.isNaN(a) || Number.isNaN(d)) return false;
  return Math.abs(d - a) > 7 * 86_400_000;
}

/** "dd/mm" no fuso de Brasília (fixo, -03:00), para o "detectado em 07/10". Vazio se a data não existe. */
export function diaMesBrasilia(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const local = new Date(t - 3 * 3_600_000);
  const dd = String(local.getUTCDate());
  const mm = String(local.getUTCMonth() + 1);
  return (dd.length < 2 ? '0' + dd : dd) + '/' + (mm.length < 2 ? '0' + mm : mm);
}

/** "Intimação" / "Citação" quando o ato que gera a providência veio de comunicação do DJEN desse tipo. */
export function seloDoTipo(tipo: string | null | undefined): string {
  return tipo === 'intimacao' ? 'Intimação' : tipo === 'citacao' ? 'Citação' : '';
}

export function filtrarPorSituacao<T extends GrupoDaTabela>(
  grupos: readonly T[],
  situacao: SituacaoFiltro,
): T[] {
  if (situacao === 'cumpridos') {
    return grupos.filter(
      (g) =>
        !!g.processo && !!g.processo.providencia && g.processo.providencia.situacao === 'cumprida',
    );
  }
  if (situacao === 'outros') {
    return grupos.filter(
      (g) =>
        !!g.processo &&
        !g.processo.pedeProvidencia &&
        !!g.processo.providencia &&
        !!g.processo.providencia.outroDestinatario,
    );
  }
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
    // A coluna "Data do ato" mostra a data do ato que gera a providência quando o
    // processo a pede (v0.37.6); ordenar por outra data contradiria o que está na tela.
    const prov = g.processo && g.processo.providencia ? g.processo.providencia : null;
    const iso =
      ordem.chave === 'dataAto'
        ? prov && prov.situacao === 'pede'
          ? prov.motivo.data
          : g.maisRecente.data
        : g.maisRecente.detectadaEm;
    if (iso === null) return Number.NaN;
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
    // Data ausente (processo sem detecção ou sem movimentação) vai para o fim nas
    // duas direções: ordenar não esconde, mas não põe a linha sem dado na frente.
    if (
      typeof va === 'number' &&
      typeof vb === 'number' &&
      Number.isNaN(va) !== Number.isNaN(vb)
    ) {
      return Number.isNaN(va) ? 1 : -1;
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

/**
 * A base da tabela (v0.37.3): primeiro os processos com atualização detectada, na
 * ordem que o servidor mandou; depois os sem novidade, pela data da última
 * movimentação (mais recente primeiro; sem movimentação por último). Com o período
 * ligado (`incluirSemNovidade` falso) a lista é só a de quem tem atualização no período.
 *
 * A linha sem novidade ganha `semNovidade: true` e `detectadaEm: null` — não foi o
 * acompanhamento que a detectou, e a tela não finge o contrário.
 */
export function montarLinhas<G extends GrupoDaTabela>(
  grupos: readonly G[],
  semNovidade: readonly ProcessoSemNovidade[],
  incluirSemNovidade: boolean,
): Array<G | LinhaSemNovidade> {
  const saida: Array<G | LinhaSemNovidade> = grupos.slice();
  if (!incluirSemNovidade) return saida;
  const tempo = (p: ProcessoSemNovidade): number =>
    p.ultimaMovimentacao ? new Date(p.ultimaMovimentacao.data).getTime() || 0 : -1;
  const extras = semNovidade
    .map((p, i) => ({ p, i }))
    .sort((a, b) => tempo(b.p) - tempo(a.p) || a.i - b.i)
    .map(({ p }): LinhaSemNovidade => {
      const u = p.ultimaMovimentacao;
      return {
        numero: p.numero,
        processo: p.processo,
        quantidade: 0,
        naoVistas: 0,
        semNovidade: true,
        segredoJustica: p.segredoJustica,
        maisRecente: {
          data: u ? u.data : null,
          detectadaEm: null,
          titulo: u ? u.titulo : '',
          conteudo: u ? u.conteudo : null,
          numero: p.numero,
          vista: true,
        },
      };
    });
  return saida.concat(extras);
}

export interface LinhaSemNovidade extends GrupoDaTabela {
  readonly semNovidade: true;
  readonly segredoJustica: boolean;
  readonly maisRecente: GrupoDaTabela['maisRecente'] & {
    readonly titulo: string;
    readonly conteudo: string | null;
    readonly numero: string;
    readonly vista: boolean;
  };
}
