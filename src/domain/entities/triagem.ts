import type { Movimentacao } from './Movimentacao.js';
import { tipoDaComunicacao } from './tipoDaComunicacao.js';

/**
 * Separa o que o advogado precisa responder do que é registro de cartório.
 *
 * É a diferença entre uma lista e um assistente. O processo de teste tem 361
 * andamentos: 231 são confirmação, expedição e juntada, e dos 62 atos publicados
 * no diário, 43 são "arquivos digitais indisponíveis". Sobra pouca coisa que de
 * fato pede providência — e é essa pouca coisa que decide prazo.
 *
 * AVISO QUE VALE PARA O ARQUIVO INTEIRO: isto é uma triagem, não um parecer.
 * Nunca use `exigeAcao === false` para ESCONDER andamento; use para ordenar e
 * destacar. Sumir com um ato porque a heurística não reconheceu o verbo é
 * exatamente como se perde prazo, e nenhuma expressão regular merece esse
 * poder. A interface mostra tudo; a triagem só diz o que olhar primeiro.
 *
 * Desde a v0.24.0 existe UM filtro que esconde, e ele foi desenhado contra o
 * parágrafo acima, não apesar dele: `ehRuido` decide pelo POSITIVO (casou com a
 * lista de cartório), o desconhecido permanece visível, ato que exige ação ou
 * entrega documento nunca é escondido, o filtro nasce desligado, é o advogado
 * quem o liga, e a tela diz quantas linhas sumiram. `!exigeAcao` continua
 * proibido como critério de ocultação — ele esconderia justamente aquilo que a
 * heurística não soube classificar.
 */

/**
 * Verbos no imperativo que o juízo usa para mandar alguém fazer alguma coisa.
 *
 * Vêm em duas formas no mesmo despacho ("INTIME-SE" e "Intimem-se as partes"),
 * às vezes com pronome no plural, às vezes com hífen comendo. O casamento é
 * frouxo de propósito: falso positivo custa um destaque a mais; falso negativo
 * custa um prazo.
 */
const DETERMINACOES = [
  /\bintime[- ]?(se|m[- ]?se)?\b/i,
  /\bcite[- ]?(se|m[- ]?se)?\b/i,
  /\bnotifique[- ]?(se|m[- ]?se)?\b/i,
  /\bmanifeste[- ]?(se|m[- ]?se)?\b/i,
  /\bapresente[- ]?(se|m)?\b/i,
  /\bcomprove[- ]?(se|m)?\b/i,
  /\bespecifique[- ]?(m)?\b/i,
  /\bemende[- ]?(se|m)?\b/i,
  /\brecolha[- ]?(se|m)?\b/i,
  /\bimpugne[- ]?(se|m)?\b/i,
  /\bcumpra[- ]?se\b/i,
  /\bpague\b/i,
];

/** "prazo de 15 dias", "no prazo de cinco (05) dias", "prazo: 10 dias úteis". */
const PRAZO_EXPLICITO =
  /\bprazo\b[^.;]{0,60}?\b(\d{1,3}|um|dois|tr[êe]s|quatro|cinco|dez|quinze|trinta)\b\s*(\(\s*\d{1,3}\s*\))?\s*dias?\b/i;

/**
 * Tipos de documento do DJEN e rótulos da TPU que praticamente sempre pedem
 * leitura, mesmo quando o texto não traz verbo nenhum.
 */
const TIPOS_RELEVANTES = [
  /\bsenten[çc]a\b/i,
  /\bdecis[ãa]o\b/i,
  /\bac[óo]rd[ãa]o\b/i,
  /\bdespacho\b/i,
  /\bnotifica[çc][ãa]o\b/i,
  /\bintima[çc][ãa]o\b/i,
  /\bcita[çc][ãa]o\b/i,
];

/**
 * Atos que são movimento de cartório: o processo andou, mas ninguém precisa
 * fazer nada. Verificados PRIMEIRO — "Juntada de petição" contém "petição" e
 * cairia em heurística ingênua.
 */
const TIPOS_DE_CARTORIO = [
  /\bjuntada\b/i,
  /\bexpedi[çc][ãa]o\b/i,
  /\bconclus[ãa]o\b/i,
  /\bconclusos?\b/i,
  /\bremessa\b/i,
  /\brecebimento\b/i,
  /\bdistribui[çc][ãa]o\b/i,
  /\bconfirma[çc][ãa]o\b/i,
  /\barquivamento\b/i,
  /\bdesarquivamento\b/i,
];

/**
 * O ato é registro de cartório RECONHECIDO como tal?
 *
 * Existe separado de `exigeAcao === false` porque os dois não são a mesma
 * coisa, e confundi-los é o jeito de perder prazo com a tela ajudando. Hoje
 * `exigeAcao` é falso em DOIS casos muito diferentes:
 *
 *   - "Juntada de petição"  → reconhecido como cartório
 *   - "Redistribuído por prevenção ao juízo da 3ª Vara" → a heurística não
 *     reconheceu o verbo e devolveu falso por não saber
 *
 * Um filtro por `!exigeAcao` esconderia os dois. O segundo é justamente onde a
 * heurística falha, então o filtro esconderia preferencialmente aquilo sobre o
 * que o sistema menos sabe. Este predicado responde pelo POSITIVO: só é ruído o
 * que casou com a lista de cartório. O desconhecido continua na tela.
 *
 * Duas recusas absolutas, e as duas vêm do que o advogado disse procurar:
 *  1. ato que exige ação nunca é ruído, mesmo que o título diga "juntada";
 *  2. ato que ENTREGA DOCUMENTO nunca é ruído — "Juntada de Petição de
 *     Contestação" é literalmente a petição da outra parte chegando aos autos,
 *     e some numa varredura ingênua por "juntada".
 */
/**
 * O ato é um pronunciamento do juízo — sentença, decisão, acórdão, despacho?
 *
 * Serve só para DESTACAR. Num processo de 381 andamentos, a decisão de 03/03
 * fica visualmente indistinguível de "Outros ×2", e foi isso que um advogado
 * apontou ao usar a tela. É o inverso do ruído: aquele tira da frente, este
 * puxa para a frente, e nenhum dos dois esconde nada.
 *
 * Não inclui intimação, citação e notificação — são atos de comunicação, e
 * marcá-los como pronunciamento encheria a tela de destaque até o destaque não
 * significar mais nada.
 */
const PRONUNCIAMENTOS = [
  /\bsenten[çc]a\b/i,
  /\bdecis[ãa]o\b/i,
  /\bac[óo]rd[ãa]o\b/i,
  /\bdespacho\b/i,
  /\bhomologa[çc][ãa]o\b/i,
  /\bjulgamento\b/i,
];

export function ehDecisao(movimentacao: Movimentacao): boolean {
  // "Juntada de cópia da decisão" é cartório levando a decisão aos autos, não a
  // decisão sendo proferida. Sem esta linha o destaque vaza para a juntada.
  if (TIPOS_DE_CARTORIO.some((r) => r.test(movimentacao.titulo))) return false;
  return PRONUNCIAMENTOS.some((r) => r.test(movimentacao.titulo));
}

export function ehRuido(
  movimentacao: Movimentacao,
  opcoes: { readonly entregaDocumento?: boolean } = {},
): boolean {
  if (opcoes.entregaDocumento) return false;
  if (triar(movimentacao).exigeAcao) return false;
  return TIPOS_DE_CARTORIO.some((r) => r.test(movimentacao.titulo));
}

export interface Triagem {
  /** Abre prazo ou pede providência — é o que o advogado precisa olhar. */
  readonly exigeAcao: boolean;
  /** Por que foi marcado assim. Aparece na tela: heurística sem explicação não se audita. */
  readonly motivo?: string;
}

/**
 * @param movimentacao o andamento já mapeado para o domínio
 */
export function triar(movimentacao: Movimentacao): Triagem {
  const titulo = movimentacao.titulo;
  const texto = movimentacao.conteudo ?? '';

  // Um teor que a fonte não entregou não pode ser triado pelo texto: o "não" da
  // heurística seria sobre uma string vazia, não sobre o ato. Vai pelo tipo.
  const temTexto = !movimentacao.teorIndisponivel && texto.length > 0;

  // Intimação ou citação PUBLICADA no Diário (v0.37.5): o tipo vem da fonte, não
  // do texto — "Ato ordinatório" e afins escapavam das listas abaixo. Vale
  // também com o teor indisponível: o ato foi endereçado ao advogado de qualquer jeito.
  if (tipoDaComunicacao(movimentacao.tipoComunicacao) !== 'outro') {
    return { exigeAcao: true, motivo: 'intimação ou citação publicada no Diário' };
  }

  const prazo = temTexto && PRAZO_EXPLICITO.test(texto);
  if (prazo) {
    return { exigeAcao: true, motivo: 'o ato menciona prazo em dias' };
  }

  const determinacao = temTexto && DETERMINACOES.some((r) => r.test(texto));
  if (determinacao) {
    return { exigeAcao: true, motivo: 'o ato contém determinação ao advogado' };
  }

  if (TIPOS_DE_CARTORIO.some((r) => r.test(titulo))) {
    return { exigeAcao: false, motivo: 'movimento de cartório' };
  }

  if (TIPOS_RELEVANTES.some((r) => r.test(titulo))) {
    return { exigeAcao: true, motivo: `é ${titulo.toLowerCase()}` };
  }

  return { exigeAcao: false };
}

/** Aplica a triagem numa lista, preservando tudo o mais. */
export function triarTodas(movimentacoes: readonly Movimentacao[]): Movimentacao[] {
  return movimentacoes.map((m) => {
    const { exigeAcao } = triar(m);
    return exigeAcao ? { ...m, exigeAcao: true } : m;
  });
}

/**
 * Os andamentos que pedem providência, do mais recente para o mais antigo.
 * É o que alimenta o topo da tela e o corpo do e-mail.
 */
export function pendencias(movimentacoes: readonly Movimentacao[]): Movimentacao[] {
  return movimentacoes
    .filter((m) => triar(m).exigeAcao)
    .slice()
    .sort((a, b) => b.data.getTime() - a.data.getTime());
}
