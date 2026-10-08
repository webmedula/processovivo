import type { Movimentacao } from './Movimentacao.js';
import type { Processo } from './Processo.js';

/**
 * Um processo que alguém pediu para acompanhar.
 *
 * É o que transforma o Processo Vivo de "consulta avulsa" em produto de assinatura:
 * o advogado não quer perguntar pelo processo todo dia, quer ser avisado quando
 * algo acontece nele.
 */
export interface Acompanhamento {
  /** Espaço isolado do assinante. Ver `workspaceDaChave`. */
  readonly workspace: string;
  /** Número CNJ sem máscara — 20 dígitos. Chave junto com o workspace. */
  readonly numero: string;
  /** Nome que o usuário deu ("Ação do cliente Silva"), opcional. */
  readonly apelido?: string;
  /**
   * O cliente de quem é esta pasta, como o ADVOGADO o chama.
   *
   * Separado de `apelido` porque só um dos dois agrupa: apelido nomeia o caso,
   * cliente nomeia a pessoa, e dois processos do mesmo cliente ganham apelidos
   * diferentes que nunca cairiam no mesmo grupo.
   *
   * Nenhuma fonte preenche isto, e não é limitação a resolver: o tribunal
   * entrega as partes sem dizer qual delas o consultante representa. Deduzir
   * pela OAB seria inventar vínculo de cliente a partir de palpite — e o
   * palpite errado põe o nome do adversário na coluna "Cliente".
   */
  readonly cliente?: string;
  readonly criadoEm: Date;
  /** Última sincronização BEM-SUCEDIDA. Ausente = nunca sincronizou. */
  readonly sincronizadoEm?: Date;
  /** Motivo da última falha de sincronização, se a última tentativa falhou. */
  readonly erro?: string;
  /** Último retrato conhecido do processo. Ausente antes da primeira busca. */
  readonly processo?: Processo;
  /** "Cumpri o que este ato pedia" (v0.37.5). Ausente = nada marcado. */
  readonly cumprido?: CumpridoDoAcompanhamento;
}

/**
 * A marca de "cumprido" de uma pasta: o advogado leu o ato, tomou a providência
 * e disse ao sistema. Uma por processo (marcar de novo substitui) e por
 * workspace, como o resto do acompanhamento.
 *
 * Guarda a CHAVE do ato (a mesma `chaveDaMovimentacao` da detecção de
 * novidades) e a DATA dele: a marca cobre os atos até aquela data, e um ato
 * posterior que exija ação volta a pedir providência sozinho. Não toca a
 * detecção de novidades nem a "não lida" — são coisas diferentes: ler não é cumprir.
 */
export interface CumpridoDoAcompanhamento {
  readonly chave: string;
  /** Data do ato marcado; os atos até ela (inclusive) ficam cobertos. */
  readonly ate: Date;
  readonly em: Date;
  /** Quem marcou: `u:<id>` (pessoa, por sessão) ou o identificador da chave de API. Nunca e-mail nem segredo. */
  readonly por: string;
}

/**
 * Uma movimentação que apareceu depois que começamos a acompanhar.
 *
 * Guardada como registro próprio, e não deduzida na hora de exibir, por dois
 * motivos: o feed precisa ser ordenável e filtrável sem reprocessar todos os
 * processos, e "quando NÓS vimos" é diferente de "quando o tribunal registrou"
 * — um movimento de 2023 pode entrar hoje, se o tribunal publicou com atraso.
 */
export interface Novidade {
  readonly id: number;
  readonly workspace: string;
  readonly numero: string;
  /** Data do andamento, como o tribunal informou. */
  readonly data: Date;
  readonly titulo: string;
  readonly codigoTpu?: number;
  readonly conteudo?: string;
  /** Quando o Processo Vivo percebeu. */
  readonly detectadaEm: Date;
  /** Quando o usuário leu. Ausente = ainda não vista. */
  readonly vistaEm?: Date;
}

/**
 * Identidade de uma movimentação para fins de comparação entre sincronizações.
 *
 * `idExterno` entra no fim, e não no lugar dos outros dois, por
 * retrocompatibilidade: fonte que não expõe identificador (o DataJud) produz
 * exatamente a mesma chave de antes, e nenhum acompanhamento já gravado passa a
 * ver o histórico inteiro como novidade no primeiro deploy desta versão.
 */
export function chaveDaMovimentacao(m: Movimentacao): string {
  return `${m.data.toISOString()}|${m.titulo}|${m.idExterno ?? ''}`;
}

/** Quem consta como autor de um retrato: "datajud+djen" → {datajud, djen}. */
function fontesDo(provider: string): Set<string> {
  return new Set(
    provider
      .split('+')
      .map((f) => f.trim())
      .filter((f) => f.length > 0),
  );
}

const UM_DIA_MS = 86_400_000;
const BRASILIA_MS = 3 * 3_600_000;

/** Meia-noite de Brasília do dia de `instante` (o fuso fixo do projeto, -03:00). */
function inicioDoDiaEmBrasilia(instante: Date): number {
  const local = instante.getTime() - BRASILIA_MS;
  return Math.floor(local / UM_DIA_MS) * UM_DIA_MS + BRASILIA_MS;
}

/**
 * Até onde o retrato anterior "conhecia" a linha do tempo: a data do ato mais
 * recente dele. Retrato sem nenhum ato cai para o início do dia da consulta, para
 * que uma fonte nova num retrato vazio não despeje o passado inteiro.
 */
function limiteDoQueSeConhecia(anterior: Processo): number {
  let maisRecente = Number.NEGATIVE_INFINITY;
  for (const m of anterior.movimentacoes) {
    if (m.data.getTime() > maisRecente) maisRecente = m.data.getTime();
  }
  return Number.isFinite(maisRecente)
    ? maisRecente
    : inicioDoDiaEmBrasilia(anterior.procedencia.consultadoEm);
}

/**
 * Compara o retrato guardado com o que a fonte devolveu agora.
 *
 * Deliberadamente conservador: só considera NOVO o que não existia antes. Se o
 * tribunal reescreve ou remove um andamento, isso não vira novidade — some do
 * retrato e pronto. Inventar "movimentação removida" a partir de uma ausência
 * geraria alarme falso toda vez que a fonte oscilasse.
 *
 * **Fonte que passa a existir no retrato não despeja o passado como novidade**
 * (v0.37.5). A vigilância por OAB grava o processo só com o que o DJEN
 * publicou; na primeira varredura regular o retrato passa a ser DataJud+DJEN e
 * a linha do tempo inteira do DataJud "não existia antes". Num log real isso
 * foram 892 novidades em 4 processos, com atos de 2024 "detectados há 2 dias".
 * O mesmo acontece quando uma fonte cai (o retrato é regravado só com a outra)
 * e depois volta. A regra: o que vem de uma fonte que o retrato anterior ainda
 * não tinha e é ANTERIOR ao ato mais recente que ele já conhecia é histórico —
 * reforça a linha de base, não avisa ninguém. Ato POSTERIOR ao que se conhecia
 * continua sendo novidade (na dúvida, avisa: falso negativo é prazo perdido) — é
 * o caso de uma publicação do DJEN que chega a um processo que só tinha o
 * DataJud. A
 * completude do retrato sai da própria procedência (`datajud+djen`), já gravada
 * — não há campo novo para manter em sincronia com ela.
 *
 * @param anterior retrato guardado; ausente na primeira sincronização
 * @returns movimentações que apareceram agora, da mais antiga para a mais nova
 */
export function detectarNovidades(
  anterior: Processo | undefined,
  atual: Processo,
): Movimentacao[] {
  // Primeira sincronização não gera novidade: o processo inteiro é "novo", e
  // despejar 361 avisos na cara de quem acabou de adicionar não ajuda ninguém.
  if (!anterior) return [];

  const conhecidas = new Set(anterior.movimentacoes.map(chaveDaMovimentacao));

  const fontesAnteriores = fontesDo(anterior.procedencia.provider);
  const fontesNovas = new Set(
    [...fontesDo(atual.procedencia.provider)].filter((f) => !fontesAnteriores.has(f)),
  );
  const corte = fontesNovas.size > 0 ? limiteDoQueSeConhecia(anterior) : undefined;

  const ehHistoricoDeFonteNova = (m: Movimentacao): boolean => {
    if (corte === undefined || m.data.getTime() > corte) return false;
    // Sem carimbo de fonte, a movimentação pode ser de qualquer uma das que
    // compõem o retrato: só é histórico se TODAS forem fontes novas.
    const fontes = m.fonte ? new Set([m.fonte]) : fontesDo(atual.procedencia.provider);
    return [...fontes].every((f) => fontesNovas.has(f));
  };

  return atual.movimentacoes
    .filter((m) => !conhecidas.has(chaveDaMovimentacao(m)))
    .filter((m) => !ehHistoricoDeFonteNova(m))
    .slice()
    .sort((a, b) => a.data.getTime() - b.data.getTime());
}
