import {
  ROTULO_DO_TIPO,
  dataBrasileira,
  dataLocalEm,
  somarDias,
} from '../../domain/entities/EventoDeCalendario.js';
import type { EventoDeCalendario } from '../../domain/entities/EventoDeCalendario.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';

/**
 * Gerador do feed ICS (RFC 5545).
 *
 * O feed SAI DO NOSSO CONTROLE: vai para o Google Agenda, para o celular, para
 * a tela do relógio do advogado, para a sincronização com o computador do
 * escritório. Por isso o que entra aqui é o mínimo — tipo e número do
 * processo. Nada de nome de parte, nada de trecho de andamento, nada da
 * observação que o advogado escreveu para si. Processo em segredo de justiça
 * não leva nem o número.
 */

export interface OpcoesDoFeed {
  /** Instante da geração. */
  readonly agora: Date;
  /** Base pública do sistema, sem barra no fim — para o link "abrir no Processo Vivo". */
  readonly urlBase: string;
}

/** Domínio do `UID`. Fixo: mudar o domínio mudaria todos os UIDs e duplicaria a agenda. */
const DOMINIO_DO_UID = 'processovivo.com.br';
const TZID = 'America/Sao_Paulo';
const CRLF = '\r\n';
const OCTETOS_POR_LINHA = 75;

export function gerarIcs(
  eventos: readonly EventoDeCalendario[],
  opcoes: OpcoesDoFeed,
): string {
  const linhas: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Processo Vivo//Calendario//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Processo Vivo',
    `X-WR-TIMEZONE:${TZID}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    // Fuso fixo em -03:00, sem regra de horário de verão: o Brasil não tem
    // horário de verão desde 2019 (Decreto 9.772/2019). Um VTIMEZONE com a
    // regra antiga faria o aplicativo deslocar audiência em uma hora entre
    // novembro e fevereiro. Se o horário de verão voltar, este bloco muda junto
    // com `DESLOCAMENTO_SAO_PAULO_MIN`.
    'BEGIN:VTIMEZONE',
    `TZID:${TZID}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:-0300',
    'TZOFFSETTO:-0300',
    'TZNAME:-03',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  for (const e of eventos) linhas.push(...vevento(e, opcoes));
  linhas.push('END:VCALENDAR');

  return linhas.map(dobrar).join(CRLF) + CRLF;
}

function vevento(e: EventoDeCalendario, opcoes: OpcoesDoFeed): string[] {
  const linhas = [
    'BEGIN:VEVENT',
    `UID:${e.id}@${DOMINIO_DO_UID}`,
    `DTSTAMP:${instanteUtc(e.atualizadoEm)}`,
    `SEQUENCE:${e.sequencia}`,
  ];

  if (e.horaLocal === undefined) {
    // Dia inteiro: VALUE=DATE, e o DTEND é o dia SEGUINTE (exclusivo). A data
    // sai da string do domínio, sem passar por instante — é o que garante que
    // o dia 12 não vire 11 em nenhum fuso.
    linhas.push(`DTSTART;VALUE=DATE:${compacta(e.dataLocal)}`);
    linhas.push(`DTEND;VALUE=DATE:${compacta(somarDias(e.dataLocal, 1))}`);
  } else {
    linhas.push(`DTSTART;TZID=${TZID}:${localComHora(e.dataLocal, e.horaLocal)}`);
    // Sem duração informada, sem DTEND: inventar uma hora de duração seria
    // afirmar algo que ninguém disse. O RFC lê como evento pontual.
    if (e.duracaoMin !== undefined) {
      linhas.push(
        `DTEND;TZID=${TZID}:${somarMinutos(e.dataLocal, e.horaLocal, e.duracaoMin)}`,
      );
    }
  }

  linhas.push(`SUMMARY:${escapar(resumo(e))}`);
  linhas.push(`DESCRIPTION:${escapar(descricao(e, opcoes))}`);
  linhas.push(
    `STATUS:${e.estado === 'descartado' ? 'CANCELLED' : e.estado === 'sugerido' ? 'TENTATIVE' : 'CONFIRMED'}`,
  );
  linhas.push('TRANSP:OPAQUE');
  linhas.push('END:VEVENT');
  return linhas;
}

/** `<Tipo> — <número CNJ>`, ou `<Tipo> (processo sigiloso)`. Nunca o título livre. */
function resumo(e: EventoDeCalendario): string {
  const tipo = ROTULO_DO_TIPO[e.tipo];
  const base = e.segredoJustica
    ? `${tipo} (processo sigiloso)`
    : `${tipo} — ${numeroFormatado(e.numeroProcesso)}`;
  return e.estado === 'sugerido' ? `[sugerido] ${base}` : base;
}

function descricao(e: EventoDeCalendario, opcoes: OpcoesDoFeed): string {
  const linhas: string[] = [];
  if (e.origem === 'detectado' && e.procedencia) {
    linhas.push(
      `Origem: lido do andamento de ${dataBrasileira(dataLocalEm(e.procedencia.dataDoAndamento))}.`,
    );
    linhas.push(
      'A data foi lida automaticamente do texto do andamento: confira no processo.',
    );
    if (e.estado === 'sugerido') linhas.push('Sugestão ainda não confirmada por você.');
  } else {
    linhas.push('Criado por você.');
  }
  // v0.39.0: prazo calculado pelo sistema. A data é uma estimativa e o feed tem de dizer.
  if (e.calculado) {
    linhas.push('Data calculada pelo Processo Vivo: confira no processo.');
  }
  if (opcoes.urlBase) {
    // Sigiloso: o link não leva o número — vai para a entrada do sistema.
    linhas.push(
      e.segredoJustica
        ? `Abrir no Processo Vivo: ${opcoes.urlBase}/`
        : `Abrir no Processo Vivo: ${opcoes.urlBase}/?processo=${e.numeroProcesso}`,
    );
  }
  return linhas.join('\n');
}

function numeroFormatado(digitos: string): string {
  try {
    return NumeroCNJ.criar(digitos).formatado;
  } catch {
    // Número gravado que não passa no dígito verificador: mostra cru em vez de
    // derrubar o feed inteiro por causa de um evento.
    return digitos;
  }
}

/** Escape de TEXT (RFC 5545, 3.3.11): `\`, `;`, `,` e quebra de linha. */
export function escapar(texto: string): string {
  return texto
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Dobra a linha em 75 OCTETOS (RFC 5545, 3.1) — contando bytes de UTF-8, não
 * caracteres: "Audiência" tem 9 caracteres e 10 octetos. A continuação começa
 * com um espaço, que conta dentro dos 75 dela. Nunca corta um caractere de
 * vários bytes no meio, senão o aplicativo mostra "Audi�ncia".
 */
export function dobrar(linha: string): string {
  const partes: string[] = [];
  let atual = '';
  let octetos = 0;
  for (const c of linha) {
    const tamanho = Buffer.byteLength(c, 'utf8');
    if (octetos + tamanho > OCTETOS_POR_LINHA) {
      partes.push(atual);
      atual = ' ';
      octetos = 1;
    }
    atual += c;
    octetos += tamanho;
  }
  partes.push(atual);
  return partes.join(CRLF);
}

function compacta(dataLocal: string): string {
  return dataLocal.replace(/-/g, '');
}

function localComHora(dataLocal: string, hora: string): string {
  return `${compacta(dataLocal)}T${hora.replace(':', '')}00`;
}

/** Soma minutos a uma data e hora de parede, sem fuso no meio. */
function somarMinutos(dataLocal: string, hora: string, minutos: number): string {
  const [h, m] = hora.split(':').map(Number);
  const total = (h ?? 0) * 60 + (m ?? 0) + minutos;
  const dias = Math.floor(total / 1440);
  const resto = total - dias * 1440;
  const hh = String(Math.floor(resto / 60)).padStart(2, '0');
  const mm = String(resto % 60).padStart(2, '0');
  return localComHora(somarDias(dataLocal, dias), `${hh}:${mm}`);
}

function instanteUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
