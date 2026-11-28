import type { Movimentacao } from './Movimentacao.js';
import type { Peca } from './Peca.js';
import { ehDecisao, ehRuido, triar } from './triagem.js';

/**
 * A régua temporal do processo: um evento por ato, cada um já carregando os
 * documentos que aquele ato juntou.
 *
 * Substitui o desenho anterior — linha do tempo numa seção, lista de 278 peças
 * noutra, no rodapé — que obrigava o advogado a ler "14/09 · Petição da parte",
 * memorizar a data e rolar a página caçando o arquivo. A crítica veio de um
 * advogado em exercício e é sobre rotina, não estética: na correria do
 * escritório, memorizar data para achar PDF não acontece.
 *
 * O que torna isto possível e não foi visto antes: a resposta do MNI que traz
 * as peças TAMBÉM traz os movimentos, e cada `<documento>` aponta para o
 * `identificadorMovimento` do `<movimento>` que o juntou. Não é correlação
 * entre fontes — é uma chave que o tribunal afirmou, dentro de um único XML.
 * (A tentativa de casar `Peca` com a linha do DataJud/DJEN continua impossível
 * e continua proibida: vocabulários e numerações diferentes, sem campo comum.)
 */
export interface EventoDaLinha extends Movimentacao {
  /** Os documentos juntados NESTE ato. Vazio quando o ato não juntou nada. */
  readonly pecas?: readonly Peca[];
  /** Registro de cartório reconhecido — o que o filtro "andamentos principais" tira. */
  readonly ehRuido?: boolean;
  /** Pronunciamento do juízo. Serve para destacar na tela, nunca para filtrar. */
  readonly ehDecisao?: boolean;
  /** Por que a triagem marcou assim. Vai para a tela: heurística sem explicação não se audita. */
  readonly motivoDaTriagem?: string;
}

export interface LinhaDoTempo {
  readonly eventos: readonly EventoDaLinha[];
  /**
   * Peças que não puderam ser penduradas em evento nenhum.
   *
   * É o rodapé que sobreviveu, e ele encolhe até sumir conforme a junção
   * funciona. Mantê-lo é obrigatório: uma peça que o sistema não soube
   * posicionar não pode simplesmente desaparecer da tela.
   */
  readonly pecasSoltas: readonly Peca[];
  readonly resumo: ResumoDaLinha;
}

export interface ResumoDaLinha {
  readonly eventos: number;
  readonly comPeca: number;
  readonly ruido: number;
  readonly exigemAcao: number;
  readonly decisoes: number;
  readonly pecasAcopladas: number;
  readonly pecasSoltas: number;
  /**
   * De onde veio a espinha: `tribunal` quando o MNI respondeu com movimentos
   * (e as peças puderam ser acopladas), `fontes-publicas` quando não.
   *
   * A tela usa isto para não prometer o que não tem: sem a espinha do tribunal
   * a lista de peças continua sendo uma lista, e dizer o contrário seria pior
   * do que o rodapé antigo.
   */
  readonly espinha: 'tribunal' | 'fontes-publicas';
}

interface EntradaDaLinha {
  /** DataJud + DJEN já fundidos — a linha que a tela mostra antes de carregar peças. */
  readonly movimentacoes: readonly Movimentacao[];
  /** Os `<movimento>` do MNI, quando o advogado tem acesso e as peças foram carregadas. */
  readonly movimentosDoTribunal?: readonly Movimentacao[];
  readonly pecas?: readonly Peca[];
}

/**
 * Monta a régua a partir do que houver.
 *
 * Degrada em silêncio e de propósito: sem movimentos do tribunal, ou com a
 * chave não batendo em peça nenhuma, o resultado é exatamente a tela de antes —
 * linha do tempo das fontes públicas e todas as peças no rodapé. Isso importa
 * porque a correspondência `documento.movimento` ↔ `identificadorMovimento` é
 * afirmada pela especificação do MNI 2.2.2 e confirmada em um tribunal; o
 * próximo Projudi pode numerar de outro jeito, e nesse dia o sistema tem de
 * ficar pior, nunca quebrado.
 */
export function montarLinhaDoTempo(entrada: EntradaDaLinha): LinhaDoTempo {
  const pecas = entrada.pecas ?? [];
  const doTribunal = entrada.movimentosDoTribunal ?? [];

  const pecasPorMovimento = agruparPecasPorMovimento(pecas);
  const acopladas = new Set<string>();

  const eventosDoTribunal = doTribunal.map((m) => {
    const identificador = numeroDoMovimento(m);
    const daqui =
      identificador !== undefined ? (pecasPorMovimento.get(identificador) ?? []) : [];
    for (const p of daqui) acopladas.add(p.id);
    return montarEvento(m, daqui);
  });

  const usaTribunal = acopladas.size > 0;
  if (!usaTribunal) {
    // Ou não há resposta do tribunal, ou a chave não vale neste tribunal. Nos
    // dois casos a resposta honesta é a tela anterior, e não uma régua montada
    // sobre uma junção que não aconteceu.
    const eventos = ordenar(entrada.movimentacoes.map((m) => montarEvento(m, [])));
    return {
      eventos,
      pecasSoltas: pecas,
      resumo: resumir(eventos, pecas.length, 0, 'fontes-publicas'),
    };
  }

  const eventos = ordenar([
    ...eventosDoTribunal,
    ...naoCobertas(entrada.movimentacoes, doTribunal).map((m) => montarEvento(m, [])),
    ...orfasDatadas(pecas, acopladas).map(eventoDePecaSolta),
  ]);

  const soltas = pecas.filter((p) => !acopladas.has(p.id) && p.dataHora === undefined);
  return {
    eventos,
    pecasSoltas: soltas,
    resumo: resumir(eventos, soltas.length, acopladas.size, 'tribunal'),
  };
}

/** O `movimento` que a peça aponta, e o `identificadorMovimento` do evento. */
export function numeroDoMovimento(m: Movimentacao): number | undefined {
  const id = m.idExterno;
  if (!id) return undefined;
  const separador = id.indexOf(':');
  const numero = Number.parseInt(separador >= 0 ? id.slice(separador + 1) : id, 10);
  return Number.isNaN(numero) ? undefined : numero;
}

function agruparPecasPorMovimento(pecas: readonly Peca[]): Map<number, Peca[]> {
  const mapa = new Map<number, Peca[]>();
  for (const p of pecas) {
    if (p.movimento === undefined) continue;
    const atual = mapa.get(p.movimento);
    if (atual) atual.push(p);
    else mapa.set(p.movimento, [p]);
  }
  return mapa;
}

function montarEvento(m: Movimentacao, pecas: readonly Peca[]): EventoDaLinha {
  const { exigeAcao, motivo } = triar(m);
  const entregaDocumento = pecas.length > 0;
  return {
    ...m,
    ...(entregaDocumento ? { pecas } : {}),
    ...(exigeAcao ? { exigeAcao: true } : {}),
    ...(ehDecisao(m) ? { ehDecisao: true } : {}),
    ...(motivo ? { motivoDaTriagem: motivo } : {}),
    ...(ehRuido(m, { entregaDocumento }) ? { ehRuido: true } : {}),
  };
}

/**
 * A peça que não pendurou em movimento nenhum mas tem data própria vira evento.
 *
 * Melhor do que mandá-la ao rodapé: ela aparece no lugar cronológico certo, que
 * é onde o advogado vai procurar. O que ela não faz é fingir saber de que ato
 * faz parte — o título é o rótulo da própria peça.
 */
function orfasDatadas(pecas: readonly Peca[], acopladas: ReadonlySet<string>): Peca[] {
  return pecas.filter((p) => !acopladas.has(p.id) && p.dataHora !== undefined);
}

function eventoDePecaSolta(p: Peca): EventoDaLinha {
  return {
    // `orfasDatadas` já garantiu a data; o fallback existe só para o tipo.
    data: p.dataHora ?? new Date(0),
    titulo: p.rotulo,
    pecas: [p],
    fonte: 'tribunal',
  };
}

/**
 * As linhas das fontes públicas que o tribunal NÃO cobriu.
 *
 * A regra é conservadora por dentro, e a razão está escrita em
 * `fusaoProcessos.ts`: duas linhas descrevendo o mesmo ato é incômodo visual;
 * uma linha ausente é prazo perdido. Por isso a comparação é por BALDE — mesmo
 * dia, mesmo código da TPU (ou, sem código, mesmo título) — e só se descarta
 * enquanto o tribunal tiver PELO MENOS TANTAS linhas naquele balde quanto a
 * fonte pública. Se o DataJud tem três juntadas num dia e o tribunal mandou
 * duas, a terceira fica. A contagem de atos nunca diminui.
 */
export function naoCobertas(
  publicas: readonly Movimentacao[],
  doTribunal: readonly Movimentacao[],
): Movimentacao[] {
  const saldo = new Map<string, number>();
  for (const m of doTribunal) {
    const b = balde(m);
    saldo.set(b, (saldo.get(b) ?? 0) + 1);
  }

  const sobra: Movimentacao[] = [];
  for (const m of publicas) {
    const b = balde(m);
    const disponivel = saldo.get(b) ?? 0;
    if (disponivel > 0) {
      saldo.set(b, disponivel - 1);
      continue;
    }
    sobra.push(m);
  }
  return sobra;
}

function balde(m: Movimentacao): string {
  const dia = `${m.data.getFullYear()}-${m.data.getMonth()}-${m.data.getDate()}`;
  return m.codigoTpu !== undefined
    ? `${dia}|tpu:${m.codigoTpu}`
    : `${dia}|t:${normalizar(m.titulo)}`;
}

/** Sem acento, sem caixa, sem espaço dobrado — o mesmo ato escrito por duas fontes. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function ordenar(eventos: readonly EventoDaLinha[]): EventoDaLinha[] {
  return [...eventos].sort((a, b) => b.data.getTime() - a.data.getTime());
}

function resumir(
  eventos: readonly EventoDaLinha[],
  pecasSoltas: number,
  pecasAcopladas: number,
  espinha: ResumoDaLinha['espinha'],
): ResumoDaLinha {
  return {
    eventos: eventos.length,
    comPeca: eventos.filter((e) => (e.pecas?.length ?? 0) > 0).length,
    ruido: eventos.filter((e) => e.ehRuido).length,
    exigemAcao: eventos.filter((e) => e.exigeAcao).length,
    decisoes: eventos.filter((e) => e.ehDecisao).length,
    pecasAcopladas,
    pecasSoltas,
    espinha,
  };
}

/**
 * Troca `Movimento 12345` pelo nome que a TPU dá àquele código.
 *
 * O MNI manda o código e nem sempre a descrição; o DataJud manda o nome. Mesmo
 * número da mesma tabela do CNJ, então emprestar o nome não é dedução — é ler a
 * tabela numa fonte que a tem. Só preenche onde o tribunal não escreveu nada.
 */
export function batizarPeloCodigo(
  doTribunal: readonly Movimentacao[],
  publicas: readonly Movimentacao[],
): Movimentacao[] {
  const nomes = new Map<number, string>();
  for (const m of publicas) {
    if (m.codigoTpu === undefined) continue;
    if (!nomes.has(m.codigoTpu)) nomes.set(m.codigoTpu, m.titulo);
  }

  return doTribunal.map((m) => {
    if (!/^Movimento \d+$/.test(m.titulo)) return m;
    if (m.codigoTpu === undefined) return m;
    const nome = nomes.get(m.codigoTpu);
    return nome ? { ...m, titulo: nome } : m;
  });
}
