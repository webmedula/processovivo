import {
  EventoDeCalendarioInvalidoError,
  TransicaoDeEventoInvalidaError,
} from '../errors/index.js';

/**
 * Um evento da agenda do advogado: audiência, perícia, prazo com data escrita,
 * reunião.
 *
 * Duas origens que a tela e o feed SEMPRE distinguem:
 *
 *   - `detectado`: a data foi LIDA de um andamento já gravado. Nasce
 *     `sugerido` e só vale depois que o advogado confirma. Carrega a
 *     procedência — de qual andamento veio e um trecho dele.
 *   - `manual`: o advogado criou. Nasce `confirmado`.
 *
 * **O sistema não afirma prazo.** Um evento do tipo `prazo` só existe quando a
 * data final está ESCRITA no andamento ("até 20/10/2026"); "prazo de 15 dias"
 * não vira evento, porque transformar isso numa data seria calcular prazo —
 * dias úteis, suspensões, recesso — e apresentar o cálculo como fato.
 */

export type TipoDeEvento = 'audiencia' | 'pericia' | 'prazo' | 'reuniao' | 'outro';
export const TIPOS_DE_EVENTO: readonly TipoDeEvento[] = Object.freeze([
  'audiencia',
  'pericia',
  'prazo',
  'reuniao',
  'outro',
]);

/** Rótulo do tipo, para a tela e para o `SUMMARY` do feed. */
export const ROTULO_DO_TIPO: Readonly<Record<TipoDeEvento, string>> = Object.freeze({
  audiencia: 'Audiência',
  pericia: 'Perícia',
  prazo: 'Prazo',
  reuniao: 'Reunião',
  outro: 'Compromisso',
});

export type OrigemDoEvento = 'detectado' | 'manual';
export type EstadoDoEvento = 'sugerido' | 'confirmado' | 'descartado';
export const ESTADOS_DO_EVENTO: readonly EstadoDoEvento[] = Object.freeze([
  'sugerido',
  'confirmado',
  'descartado',
]);

/** De onde saiu a data de um evento detectado. */
export interface ProcedenciaDoEvento {
  /**
   * Identidade do andamento — a mesma `chaveDaMovimentacao` que a detecção de
   * novidades usa. Andamento não tem id próprio em todas as fontes (o DataJud
   * não expõe), e esta chave é a que o resto do sistema já trata como estável.
   */
  readonly movimentacaoId: string;
  readonly dataDoAndamento: Date;
  /** Até 200 caracteres do andamento, SEM nome de parte. Nunca vai para o feed. */
  readonly trecho: string;
}

export const LIMITE_TITULO = 140;
export const LIMITE_OBSERVACAO = 1000;
export const LIMITE_TRECHO = 200;
/** Um dia. Duração maior que isso é digitação errada, não audiência. */
export const DURACAO_MAXIMA_MIN = 1440;

export interface EventoDeCalendarioProps {
  readonly id: string;
  readonly workspace: string;
  /** Número CNJ, 20 dígitos, sem máscara. */
  readonly numeroProcesso: string;
  readonly tribunal: string;
  readonly tipo: TipoDeEvento;
  readonly titulo: string;
  /** Só do advogado. Nunca vai para o feed. */
  readonly observacao?: string;
  /** `AAAA-MM-DD`, no fuso de São Paulo. Data de calendário, não instante. */
  readonly dataLocal: string;
  /** `HH:MM`. Ausente = dia inteiro. */
  readonly horaLocal?: string;
  readonly duracaoMin?: number;
  readonly origem: OrigemDoEvento;
  readonly estado: EstadoDoEvento;
  readonly procedencia?: ProcedenciaDoEvento;
  /**
   * Chave de deduplicação da detecção, calculada UMA vez, quando a sugestão
   * nasce, e nunca mais alterada — ver `chaveDeDeteccao`.
   */
  readonly chaveDeDeteccao?: string;
  /** Um andamento posterior sugere mudança (cancelada, redesignada…). */
  readonly revisar: boolean;
  /**
   * Data do andamento de mudança mais recente já considerado. Existe para que
   * o mesmo cancelamento, relido a cada sincronização, não volte a acender o
   * aviso depois que o advogado conferiu e editou.
   */
  readonly revisaoAte?: Date;
  /** Cópia do `segredoJustica` do processo: decide o que o feed pode mostrar. */
  readonly segredoJustica: boolean;
  /**
   * A data foi CALCULADA pelo Processo Vivo (v0.39.0, aviso criado a partir da análise por IA)
   * e é a calculada mesmo — a edição da data pelo advogado, no aviso ou depois, apaga o marcador.
   * O feed diz "data calculada pelo Processo Vivo: confira no processo". Ausente = false.
   */
  readonly calculado?: boolean;
  /** Sobe a cada alteração que o calendário do advogado precisa ver (`SEQUENCE`). */
  readonly sequencia: number;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
  readonly confirmadoEm?: Date;
  readonly descartadoEm?: Date;
}

/** O que a detecção produz: um evento ainda sem dono nem id. */
export interface SugestaoDeEvento {
  readonly tipo: TipoDeEvento;
  readonly titulo: string;
  readonly dataLocal: string;
  readonly horaLocal?: string;
  readonly procedencia: ProcedenciaDoEvento;
}

export interface MudancasNoEvento {
  readonly tipo?: TipoDeEvento;
  readonly titulo?: string;
  /** `null` apaga. */
  readonly observacao?: string | null;
  readonly dataLocal?: string;
  /** `null` apaga — o evento passa a ser de dia inteiro. */
  readonly horaLocal?: string | null;
  /** `null` apaga. */
  readonly duracaoMin?: number | null;
}

export class EventoDeCalendario {
  readonly id: string;
  readonly workspace: string;
  readonly numeroProcesso: string;
  readonly tribunal: string;
  readonly tipo: TipoDeEvento;
  readonly titulo: string;
  readonly observacao: string | undefined;
  readonly dataLocal: string;
  readonly horaLocal: string | undefined;
  readonly duracaoMin: number | undefined;
  readonly origem: OrigemDoEvento;
  readonly estado: EstadoDoEvento;
  readonly procedencia: ProcedenciaDoEvento | undefined;
  readonly chaveDeDeteccao: string | undefined;
  readonly revisar: boolean;
  readonly revisaoAte: Date | undefined;
  readonly segredoJustica: boolean;
  readonly calculado: boolean;
  readonly sequencia: number;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
  readonly confirmadoEm: Date | undefined;
  readonly descartadoEm: Date | undefined;

  constructor(props: EventoDeCalendarioProps) {
    validar(props);
    this.id = props.id;
    this.workspace = props.workspace;
    this.numeroProcesso = props.numeroProcesso;
    this.tribunal = props.tribunal;
    this.tipo = props.tipo;
    this.titulo = props.titulo.trim();
    const obs = props.observacao?.trim();
    this.observacao = obs ? obs : undefined;
    this.dataLocal = props.dataLocal;
    this.horaLocal = props.horaLocal;
    this.duracaoMin = props.duracaoMin;
    this.origem = props.origem;
    this.estado = props.estado;
    this.procedencia = props.procedencia
      ? Object.freeze({ ...props.procedencia })
      : undefined;
    this.chaveDeDeteccao = props.chaveDeDeteccao;
    this.revisar = props.revisar;
    this.revisaoAte = props.revisaoAte;
    this.segredoJustica = props.segredoJustica;
    this.calculado = props.calculado === true;
    this.sequencia = props.sequencia;
    this.criadoEm = props.criadoEm;
    this.atualizadoEm = props.atualizadoEm;
    this.confirmadoEm = props.confirmadoEm;
    this.descartadoEm = props.descartadoEm;
    Object.freeze(this);
  }

  /** Criado pelo advogado: vale desde já. */
  static manual(dados: {
    readonly id: string;
    readonly workspace: string;
    readonly numeroProcesso: string;
    readonly tribunal: string;
    readonly segredoJustica: boolean;
    readonly tipo: TipoDeEvento;
    readonly titulo: string;
    readonly observacao?: string;
    readonly dataLocal: string;
    readonly horaLocal?: string;
    readonly duracaoMin?: number;
    /** Prazo calculado pelo sistema (v0.39.0). */
    readonly calculado?: boolean;
    readonly agora: Date;
  }): EventoDeCalendario {
    const { agora, ...resto } = dados;
    return new EventoDeCalendario({
      ...resto,
      origem: 'manual',
      estado: 'confirmado',
      revisar: false,
      sequencia: 0,
      criadoEm: agora,
      atualizadoEm: agora,
      confirmadoEm: agora,
    });
  }

  /** Lido de um andamento: só uma sugestão até o advogado confirmar. */
  static sugerido(dados: {
    readonly id: string;
    readonly workspace: string;
    readonly numeroProcesso: string;
    readonly tribunal: string;
    readonly segredoJustica: boolean;
    readonly sugestao: SugestaoDeEvento;
    readonly agora: Date;
  }): EventoDeCalendario {
    const s = dados.sugestao;
    return new EventoDeCalendario({
      id: dados.id,
      workspace: dados.workspace,
      numeroProcesso: dados.numeroProcesso,
      tribunal: dados.tribunal,
      segredoJustica: dados.segredoJustica,
      tipo: s.tipo,
      titulo: s.titulo,
      dataLocal: s.dataLocal,
      ...(s.horaLocal !== undefined ? { horaLocal: s.horaLocal } : {}),
      origem: 'detectado',
      estado: 'sugerido',
      procedencia: s.procedencia,
      chaveDeDeteccao: chaveDeDeteccao(dados.numeroProcesso, s),
      revisar: false,
      sequencia: 0,
      criadoEm: dados.agora,
      atualizadoEm: dados.agora,
    });
  }

  /**
   * Sugerido → confirmado. Confirmar o que já está confirmado não muda nada
   * (nem a `SEQUENCE`): dois cliques no botão não são duas alterações.
   */
  confirmar(agora: Date): EventoDeCalendario {
    if (this.estado === 'descartado') {
      throw new TransicaoDeEventoInvalidaError('descartado', 'confirmado');
    }
    if (this.estado === 'confirmado') return this;
    return this.copia({
      estado: 'confirmado',
      confirmadoEm: agora,
      revisar: false,
      sequencia: this.sequencia + 1,
      atualizadoEm: agora,
    });
  }

  /**
   * Descartar é final. Um sugerido descartado nunca reaparece — a chave de
   * deduplicação continua no banco, e é ela que barra a releitura do mesmo
   * andamento.
   */
  descartar(agora: Date): EventoDeCalendario {
    if (this.estado === 'descartado') return this;
    return this.copia({
      estado: 'descartado',
      descartadoEm: agora,
      revisar: false,
      sequencia: this.sequencia + 1,
      atualizadoEm: agora,
    });
  }

  /**
   * Editar mantém origem, estado e procedência: um detectado corrigido pelo
   * advogado continua dizendo de onde a data veio. Apaga o aviso de revisão —
   * quem editou conferiu.
   */
  editar(mudancas: MudancasNoEvento, agora: Date): EventoDeCalendario {
    if (this.estado === 'descartado') {
      throw new TransicaoDeEventoInvalidaError('descartado', 'editado');
    }
    const props: EventoDeCalendarioProps = {
      ...this.props(),
      ...(mudancas.tipo !== undefined ? { tipo: mudancas.tipo } : {}),
      ...(mudancas.titulo !== undefined ? { titulo: mudancas.titulo } : {}),
      ...(mudancas.dataLocal !== undefined ? { dataLocal: mudancas.dataLocal } : {}),
      revisar: false,
      sequencia: this.sequencia + 1,
      atualizadoEm: agora,
    };
    // A data que o advogado mexeu deixou de ser a calculada: o feed não pode mais dizer isso.
    if (mudancas.dataLocal !== undefined && mudancas.dataLocal !== this.dataLocal) {
      delete (props as { calculado?: boolean }).calculado;
    }
    return new EventoDeCalendario(
      aplicarOpcional(
        aplicarOpcional(
          aplicarOpcional(props, 'observacao', mudancas.observacao),
          'horaLocal',
          mudancas.horaLocal,
        ),
        'duracaoMin',
        mudancas.duracaoMin,
      ),
    );
  }

  /**
   * Um andamento mais recente sugere que a data mudou.
   *
   * Não mexe na `SEQUENCE`: o evento continua o mesmo no calendário do
   * advogado até ele conferir; o aviso é da tela, não do feed. Devolve o
   * próprio evento quando não há nada a marcar.
   */
  marcarParaRevisao(dataDoAndamento: Date, agora: Date): EventoDeCalendario {
    if (this.estado === 'descartado') return this;
    if (this.revisaoAte && this.revisaoAte.getTime() >= dataDoAndamento.getTime()) {
      return this;
    }
    return this.copia({
      revisar: true,
      revisaoAte: dataDoAndamento,
      atualizadoEm: agora,
    });
  }

  /** Atualiza a cópia do sigilo do processo. Não é alteração do evento. */
  comSegredo(segredoJustica: boolean): EventoDeCalendario {
    if (segredoJustica === this.segredoJustica) return this;
    return this.copia({ segredoJustica });
  }

  props(): EventoDeCalendarioProps {
    return {
      id: this.id,
      workspace: this.workspace,
      numeroProcesso: this.numeroProcesso,
      tribunal: this.tribunal,
      tipo: this.tipo,
      titulo: this.titulo,
      ...(this.observacao !== undefined ? { observacao: this.observacao } : {}),
      dataLocal: this.dataLocal,
      ...(this.horaLocal !== undefined ? { horaLocal: this.horaLocal } : {}),
      ...(this.duracaoMin !== undefined ? { duracaoMin: this.duracaoMin } : {}),
      origem: this.origem,
      estado: this.estado,
      ...(this.procedencia ? { procedencia: this.procedencia } : {}),
      ...(this.chaveDeDeteccao !== undefined
        ? { chaveDeDeteccao: this.chaveDeDeteccao }
        : {}),
      revisar: this.revisar,
      ...(this.revisaoAte ? { revisaoAte: this.revisaoAte } : {}),
      segredoJustica: this.segredoJustica,
      ...(this.calculado ? { calculado: true } : {}),
      sequencia: this.sequencia,
      criadoEm: this.criadoEm,
      atualizadoEm: this.atualizadoEm,
      ...(this.confirmadoEm ? { confirmadoEm: this.confirmadoEm } : {}),
      ...(this.descartadoEm ? { descartadoEm: this.descartadoEm } : {}),
    };
  }

  private copia(mudancas: Partial<EventoDeCalendarioProps>): EventoDeCalendario {
    return new EventoDeCalendario({ ...this.props(), ...mudancas });
  }
}

function aplicarOpcional<K extends 'observacao' | 'horaLocal' | 'duracaoMin'>(
  props: EventoDeCalendarioProps,
  chave: K,
  valor: EventoDeCalendarioProps[K] | null | undefined,
): EventoDeCalendarioProps {
  if (valor === undefined) return props;
  // Propriedade opcional se OMITE, não recebe `undefined`
  // (`exactOptionalPropertyTypes`).
  const { [chave]: _antigo, ...resto } = props;
  // `resto` só perdeu a chave opcional; os campos obrigatórios estão todos lá.
  const base = resto as EventoDeCalendarioProps;
  return valor === null ? base : { ...base, [chave]: valor };
}

/**
 * A identidade de uma sugestão:
 * `(workspace, processo, andamento, tipo, data, hora)` — o workspace mora na
 * coluna ao lado.
 *
 * Calculada quando a sugestão nasce e GRAVADA, nunca recalculada do evento
 * atual. Se fosse recalculada, o advogado que corrigisse a data de uma
 * sugestão faria a releitura do mesmo andamento criar a sugestão original de
 * novo, ao lado da corrigida.
 */
export function chaveDeDeteccao(numeroProcesso: string, s: SugestaoDeEvento): string {
  return [
    numeroProcesso,
    s.procedencia.movimentacaoId,
    s.tipo,
    s.dataLocal,
    s.horaLocal ?? '',
  ].join('|');
}

function validar(p: EventoDeCalendarioProps): void {
  if (!/^\d{20}$/.test(p.numeroProcesso)) {
    throw new EventoDeCalendarioInvalidoError(
      'O número do processo precisa ter 20 dígitos.',
    );
  }
  if (!TIPOS_DE_EVENTO.includes(p.tipo)) {
    throw new EventoDeCalendarioInvalidoError(
      `Tipo de evento desconhecido: "${String(p.tipo)}".`,
    );
  }
  const titulo = p.titulo.trim();
  if (titulo.length === 0 || titulo.length > LIMITE_TITULO) {
    throw new EventoDeCalendarioInvalidoError(
      `O título precisa ter de 1 a ${LIMITE_TITULO} caracteres.`,
    );
  }
  if (p.observacao !== undefined && p.observacao.trim().length > LIMITE_OBSERVACAO) {
    throw new EventoDeCalendarioInvalidoError(
      `A observação pode ter até ${LIMITE_OBSERVACAO} caracteres.`,
    );
  }
  if (!ehDataLocalValida(p.dataLocal)) {
    throw new EventoDeCalendarioInvalidoError(
      `Data inválida: "${p.dataLocal}". Use uma data que exista no calendário (AAAA-MM-DD).`,
    );
  }
  if (p.horaLocal !== undefined && !ehHoraLocalValida(p.horaLocal)) {
    throw new EventoDeCalendarioInvalidoError(
      `Hora inválida: "${p.horaLocal}". Use HH:MM.`,
    );
  }
  if (
    p.duracaoMin !== undefined &&
    (!Number.isInteger(p.duracaoMin) ||
      p.duracaoMin < 1 ||
      p.duracaoMin > DURACAO_MAXIMA_MIN)
  ) {
    throw new EventoDeCalendarioInvalidoError(
      `A duração precisa ser um número inteiro de minutos entre 1 e ${DURACAO_MAXIMA_MIN}.`,
    );
  }
  if (p.duracaoMin !== undefined && p.horaLocal === undefined) {
    throw new EventoDeCalendarioInvalidoError(
      'Evento de dia inteiro não tem duração. Informe a hora ou retire a duração.',
    );
  }
  if (p.origem === 'detectado' && !p.procedencia) {
    throw new EventoDeCalendarioInvalidoError('Evento detectado precisa da procedência.');
  }
  if (p.procedencia && p.procedencia.trecho.length > LIMITE_TRECHO) {
    throw new EventoDeCalendarioInvalidoError(
      `O trecho do andamento pode ter até ${LIMITE_TRECHO} caracteres.`,
    );
  }
  if (p.origem === 'manual' && p.estado === 'sugerido') {
    throw new EventoDeCalendarioInvalidoError(
      'Evento criado pelo advogado não é sugestão.',
    );
  }
}

// ---------------------------------------------------------------------------
// Datas de calendário.
//
// O domínio guarda o QUANDO de um evento como data de calendário (`AAAA-MM-DD`)
// e não como instante, de propósito. "Audiência dia 12/11" é um dia na agenda
// de São Paulo; convertido para instante UTC e de volta, um evento de dia
// inteiro cai no dia 11 em qualquer navegador a oeste de Greenwich — o erro
// clássico que desloca o dia. Aqui a data nunca passa por UTC.
// ---------------------------------------------------------------------------

/**
 * Deslocamento fixo de São Paulo em relação a UTC.
 *
 * Fixo, e não lido de uma base de fusos: o Brasil não tem horário de verão
 * desde 2019 (Decreto 9.772/2019). Se voltar a ter, este número e o
 * `VTIMEZONE` do feed mudam juntos.
 */
export const DESLOCAMENTO_SAO_PAULO_MIN = -180;

const RE_DATA_LOCAL = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_HORA_LOCAL = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function ehDataLocalValida(texto: string): boolean {
  const m = RE_DATA_LOCAL.exec(texto);
  if (!m) return false;
  return dataExiste(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function ehHoraLocalValida(texto: string): boolean {
  return RE_HORA_LOCAL.test(texto);
}

/** 31/02 não existe; 29/02 só em ano bissexto. */
export function dataExiste(ano: number, mes: number, dia: number): boolean {
  if (ano < 1900 || ano > 2999 || mes < 1 || mes > 12 || dia < 1) return false;
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return dia <= ultimo;
}

/** O dia de São Paulo em que o instante cai. */
export function dataLocalEm(instante: Date): string {
  const local = new Date(instante.getTime() + DESLOCAMENTO_SAO_PAULO_MIN * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * Soma dias a uma data de calendário. A conta usa `Date.UTC` só como
 * calculadora de calendário (meio-dia, longe da virada): nunca há fuso no meio.
 */
export function somarDias(dataLocal: string, dias: number): string {
  const m = RE_DATA_LOCAL.exec(dataLocal);
  if (!m) throw new EventoDeCalendarioInvalidoError(`Data inválida: "${dataLocal}".`);
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return new Date(base + dias * 86_400_000).toISOString().slice(0, 10);
}

/** Dias entre duas datas de calendário (`ate - de`). */
export function diasEntre(de: string, ate: string): number {
  const a = RE_DATA_LOCAL.exec(de);
  const b = RE_DATA_LOCAL.exec(ate);
  if (!a || !b) throw new EventoDeCalendarioInvalidoError('Data inválida.');
  const ta = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const tb = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((tb - ta) / 86_400_000);
}

/** `AAAA-MM-DD` → `dd/mm/aaaa`, para texto exibido. */
export function dataBrasileira(dataLocal: string): string {
  const m = RE_DATA_LOCAL.exec(dataLocal);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : dataLocal;
}

// ---------------------------------------------------------------------------
// O que entra no feed.
// ---------------------------------------------------------------------------

/** A janela do feed: de 30 dias atrás a 365 dias à frente. */
export const JANELA_DO_FEED = Object.freeze({ diasAtras: 30, diasAFrente: 365 });

/** Por quanto tempo um descartado continua no feed como `CANCELLED`. */
export const DIAS_DE_CANCELADO_NO_FEED = 30;

/**
 * Quais eventos o feed publica.
 *
 * - `confirmado`: sempre.
 * - `sugerido`: só se o advogado pediu (padrão desligado). Sugestão no
 *   Google Agenda de alguém, sem rótulo, seria lida como compromisso.
 * - `descartado`: por 30 dias, como `CANCELLED`, para o aplicativo do advogado
 *   apagar o que já tinha baixado. Depois disso some — o feed não é arquivo
 *   morto.
 *
 * Tudo dentro da janela (-30/+365 dias da data do evento).
 */
export function selecionarParaFeed(
  eventos: readonly EventoDeCalendario[],
  opcoes: { readonly agora: Date; readonly incluiSugeridos: boolean },
): EventoDeCalendario[] {
  const hoje = dataLocalEm(opcoes.agora);
  const de = somarDias(hoje, -JANELA_DO_FEED.diasAtras);
  const ate = somarDias(hoje, JANELA_DO_FEED.diasAFrente);
  const limiteDescarte = opcoes.agora.getTime() - DIAS_DE_CANCELADO_NO_FEED * 86_400_000;

  return eventos
    .filter((e) => e.dataLocal >= de && e.dataLocal <= ate)
    .filter((e) => {
      if (e.estado === 'confirmado') return true;
      if (e.estado === 'sugerido') return opcoes.incluiSugeridos;
      // Sugestão descartada que nunca foi confirmada só chegou a um feed que
      // publica sugeridos; nos outros, mandar o CANCELLED anunciaria um
      // evento que aquele calendário nunca recebeu.
      if (!e.confirmadoEm && !opcoes.incluiSugeridos) return false;
      return e.descartadoEm !== undefined && e.descartadoEm.getTime() >= limiteDescarte;
    })
    .sort(
      (a, b) =>
        a.dataLocal.localeCompare(b.dataLocal) ||
        (a.horaLocal ?? '').localeCompare(b.horaLocal ?? '') ||
        a.id.localeCompare(b.id),
    );
}
