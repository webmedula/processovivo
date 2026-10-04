import type { Oab } from './Oab.js';

/**
 * Uma inscrição da OAB sob vigilância contínua.
 *
 * É a virada de chave do produto. Até aqui o Processo Vivo vigiava **o que o usuário
 * digitou**: ele precisava saber o número do processo para acompanhá-lo — ou
 * seja, precisava já saber que o processo existe. A vigilância por OAB inverte
 * isso: o advogado cadastra a inscrição dele uma vez e o sistema passa a vigiar
 * **o nome dele**. Processo novo em que ele foi habilitado ontem entra sozinho
 * na carteira, sem ninguém digitar nada.
 *
 * Só o DJEN sustenta isso: é a única fonte que indexa advogado. E sustenta bem —
 * responde em menos de um segundo e não cobra nada, o que permite varrer de hora
 * em hora, contra as 20 horas que o DataJud levaria.
 */
export interface VigilanciaOab {
  readonly workspace: string;
  readonly oab: Oab;
  /** Nome dado pelo usuário — um escritório vigia várias inscrições. */
  readonly apelido?: string;
  readonly criadaEm: Date;
  /**
   * Quando a varredura rodou pela última vez. Ausente = nunca rodou.
   *
   * A primeira varredura é diferente das seguintes: ver `desdeQuandoVarrer`.
   */
  readonly varridaEm?: Date;
  /** Última falha, para a tela poder dizer que a vigilância está cega. */
  readonly erro?: string;
  /** Quantos processos já entraram na carteira por causa desta inscrição. */
  readonly processosEncontrados: number;
  /** Desligada pelo usuário sem perder o histórico. */
  readonly ativa: boolean;
}

/**
 * Quantos dias para trás a PRIMEIRA varredura olha.
 *
 * Não é o histórico inteiro de propósito. Um advogado com 1.871 publicações
 * acumuladas veria a carteira inteira dele entrar como "novidade" no primeiro
 * minuto — centenas de avisos que não são novidade nenhuma, e o aviso de verdade
 * enterrado no meio. Trinta dias trazem a carteira ativa sem virar enxurrada.
 */
export const DIAS_DA_PRIMEIRA_VARREDURA = 30;

/**
 * Margem de sobreposição entre varreduras.
 *
 * O DJEN não publica tudo à meia-noite: uma comunicação com
 * `data_disponibilizacao` de ontem pode aparecer no índice hoje. Varrer
 * exatamente a partir da última execução perderia essas — e perder publicação
 * é perder prazo. Dois dias de sobreposição custam registros repetidos, que a
 * deduplicação por número já resolve.
 */
export const DIAS_DE_SOBREPOSICAO = 2;

/**
 * A partir de que data esta varredura deve pedir publicações.
 *
 * @param agora momento da varredura, injetado para o teste não depender do relógio
 */
export function desdeQuandoVarrer(vigilancia: VigilanciaOab, agora: Date): Date {
  const dias = vigilancia.varridaEm
    ? DIAS_DE_SOBREPOSICAO
    : DIAS_DA_PRIMEIRA_VARREDURA;

  const base = vigilancia.varridaEm ?? agora;
  const desde = new Date(base);
  desde.setUTCDate(desde.getUTCDate() - dias);

  // Nunca antes da criação da vigilância menos a janela inicial: se a varredura
  // ficou meses parada, retomar de onde parou pediria um ano de publicações de
  // uma vez.
  const teto = new Date(agora);
  teto.setUTCDate(teto.getUTCDate() - DIAS_DA_PRIMEIRA_VARREDURA);
  return desde > teto ? desde : teto;
}

/** Formato `YYYY-MM-DD`, que é o que o DJEN aceita nos filtros de data. */
export function comoDataDjen(data: Date): string {
  return data.toISOString().slice(0, 10);
}
