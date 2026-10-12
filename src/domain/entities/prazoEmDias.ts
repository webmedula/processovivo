/**
 * Calculadora de prazo em dias (v0.39.0) — EXCEÇÃO REGISTRADA à regra "o sistema não calcula
 * prazo" (CLAUDE.md, calendário). Ela só roda depois do clique do advogado, só para ato do
 * Diário (que tem a data de disponibilização), e o resultado é SEMPRE uma data "a conferir",
 * devolvida junto das premissas em texto. Quem responde pelo prazo é o advogado.
 *
 * O que ela sabe: sábado, domingo, feriados NACIONAIS fixos, Sexta-feira Santa (pela Páscoa) e
 * o recesso forense de 20/12 a 20/01. O que ela NÃO sabe, e diz: feriado estadual, municipal ou
 * do tribunal, ponto facultativo, suspensão de prazo por ato do tribunal, prazo em dobro e
 * regras de juizado. Por isso a data é uma estimativa e nunca se apresenta como fato.
 *
 * Pura: sem I/O, sem relógio. Datas de calendário são texto `AAAA-MM-DD` (nunca instante), pela
 * mesma razão do resto do calendário: converter para instante joga o dia para o anterior em
 * qualquer fuso a oeste de Greenwich.
 */

export type TipoDePrazo = 'uteis' | 'corridos';

export const DIAS_MINIMOS_DO_PRAZO = 1;
export const DIAS_MAXIMOS_DO_PRAZO = 365;

export const AVISO_DO_PRAZO_CALCULADO =
  'Feriado local e suspensões não considerados. Data calculada pelo Processo Vivo: confira no processo.';

export interface PrazoCalculado {
  /** Primeiro dia útil depois da disponibilização (art. 4º, §3º, da Lei 11.419/2006). */
  readonly dataDaPublicacao: string;
  /** Primeiro dia útil depois da publicação: o dia 1 da contagem (art. 224, §3º, do CPC). */
  readonly inicioDaContagem: string;
  readonly dataFinal: string;
  /** Frases curtas, para a tela, para a observação do evento e para o Autran revisar. */
  readonly premissas: readonly string[];
  readonly aviso: string;
}

const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

function partes(data: string): { ano: number; mes: number; dia: number } {
  const m = RE_DATA.exec(data);
  if (!m) throw new RangeError(`Data inválida: "${data}".`);
  return { ano: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]) };
}

function texto(ano: number, mes: number, dia: number): string {
  return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** Soma dias a uma data de calendário (meio-dia em UTC só como calculadora). */
function somar(data: string, dias: number): string {
  const { ano, mes, dia } = partes(data);
  const d = new Date(Date.UTC(ano, mes - 1, dia + dias, 12));
  return texto(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 0 = domingo … 6 = sábado. */
function diaDaSemana(data: string): number {
  const { ano, mes, dia } = partes(data);
  return new Date(Date.UTC(ano, mes - 1, dia, 12)).getUTCDay();
}

/** Domingo de Páscoa (calendário gregoriano; algoritmo de Meeus/Jones/Butcher). */
export function domingoDePascoa(ano: number): string {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return texto(ano, mes, dia);
}

/** Feriados nacionais fixos (mês-dia). O 20/11 é nacional desde 2024 (Lei 14.759/2023). */
const FERIADOS_FIXOS: ReadonlyArray<{ mes: number; dia: number; desde?: number }> = [
  { mes: 1, dia: 1 },
  { mes: 4, dia: 21 },
  { mes: 5, dia: 1 },
  { mes: 9, dia: 7 },
  { mes: 10, dia: 12 },
  { mes: 11, dia: 2 },
  { mes: 11, dia: 15 },
  { mes: 11, dia: 20, desde: 2024 },
  { mes: 12, dia: 25 },
];

export function ehFeriadoNacional(data: string): boolean {
  const { ano, mes, dia } = partes(data);
  if (FERIADOS_FIXOS.some((f) => f.mes === mes && f.dia === dia && ano >= (f.desde ?? 0))) {
    return true;
  }
  return data === somar(domingoDePascoa(ano), -2);
}

/** Recesso forense: de 20 de dezembro a 20 de janeiro, inclusive (art. 220 do CPC). */
export function estaNoRecesso(data: string): boolean {
  const { mes, dia } = partes(data);
  return (mes === 12 && dia >= 20) || (mes === 1 && dia <= 20);
}

/** Dia útil para a contagem: não é fim de semana, feriado nacional nem recesso. */
export function ehDiaUtil(data: string): boolean {
  const s = diaDaSemana(data);
  if (s === 0 || s === 6) return false;
  return !ehFeriadoNacional(data) && !estaNoRecesso(data);
}

/** Primeiro dia útil ESTRITAMENTE depois de `data`. */
function proximoDiaUtil(data: string): string {
  let d = somar(data, 1);
  // Teto folgado: o maior vão possível é recesso + fim de semana + feriado (menos de 40 dias).
  for (let i = 0; i < 60 && !ehDiaUtil(d); i++) d = somar(d, 1);
  return d;
}

/** Primeiro dia útil igual ou depois de `data`. */
function ateDiaUtil(data: string): string {
  return ehDiaUtil(data) ? data : proximoDiaUtil(data);
}

export interface PedidoDePrazo {
  /** `AAAA-MM-DD` da DISPONIBILIZAÇÃO no Diário. */
  readonly disponibilizacao: string;
  readonly dias: number;
  readonly tipo: TipoDePrazo;
}

/**
 * Lança `RangeError` com data malformada ou `dias` fora de 1–365: quem chama (o serviço)
 * valida antes e traduz para erro de domínio; aqui é defesa.
 */
export function calcularPrazo(pedido: PedidoDePrazo): PrazoCalculado {
  const { disponibilizacao, dias, tipo } = pedido;
  partes(disponibilizacao);
  if (
    !Number.isInteger(dias) ||
    dias < DIAS_MINIMOS_DO_PRAZO ||
    dias > DIAS_MAXIMOS_DO_PRAZO
  ) {
    throw new RangeError(`Prazo fora de ${DIAS_MINIMOS_DO_PRAZO}–${DIAS_MAXIMOS_DO_PRAZO} dias.`);
  }

  const dataDaPublicacao = proximoDiaUtil(disponibilizacao);
  const inicioDaContagem = proximoDiaUtil(dataDaPublicacao);

  let dataFinal: string;
  if (tipo === 'uteis') {
    // O dia 1 é o início da contagem; cada dia útil seguinte conta mais um.
    dataFinal = inicioDaContagem;
    for (let contados = 1; contados < dias; contados++) dataFinal = proximoDiaUtil(dataFinal);
  } else {
    // Corridos: o dia 1 também é o início da contagem; vencendo em dia sem expediente,
    // prorroga para o primeiro dia útil seguinte (art. 224, §1º).
    dataFinal = ateDiaUtil(somar(inicioDaContagem, dias - 1));
  }

  const premissas = [
    `Disponibilização no Diário em ${brasileira(disponibilizacao)}.`,
    `Publicação no primeiro dia útil seguinte: ${brasileira(dataDaPublicacao)}.`,
    `Contagem a partir do primeiro dia útil depois da publicação: ${brasileira(inicioDaContagem)} (dia 1).`,
    tipo === 'uteis'
      ? `${dias} dias úteis, sem contar sábados, domingos, feriados nacionais e o recesso de 20/12 a 20/01.`
      : `${dias} dias corridos; se o último cair em dia sem expediente, passa ao primeiro dia útil seguinte.`,
    'Feriados nacionais considerados: 1/1, Sexta-feira Santa, 21/4, 1/5, 7/9, 12/10, 2/11, 15/11, 20/11 (desde 2024) e 25/12.',
    'Não considerados: feriado estadual, municipal ou do tribunal, ponto facultativo, suspensão por ato do tribunal, prazo em dobro e regras de juizado.',
  ];

  return {
    dataDaPublicacao,
    inicioDaContagem,
    dataFinal,
    premissas,
    aviso: AVISO_DO_PRAZO_CALCULADO,
  };
}

/** `AAAA-MM-DD` → `DD/MM/AAAA`. */
function brasileira(data: string): string {
  const { ano, mes, dia } = partes(data);
  return `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`;
}

/** Título do evento: só campos estruturados — nunca texto da IA nem nome de parte. */
export function tituloDoPrazoCalculado(dias: number, tipo: TipoDePrazo): string {
  const unidade =
    tipo === 'uteis'
      ? dias === 1
        ? 'dia útil'
        : 'dias úteis'
      : dias === 1
        ? 'dia corrido'
        : 'dias corridos';
  return `Prazo de ${dias} ${unidade} (a conferir)`;
}
