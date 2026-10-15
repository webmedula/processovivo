import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { EventoDeCalendario } from '../../src/domain/entities/EventoDeCalendario.js';
import type { SugestaoDeEvento } from '../../src/domain/entities/EventoDeCalendario.js';
import { dobrar, escapar, gerarIcs } from '../../src/infrastructure/calendario/ics.js';

/*
 * O feed é validado de dois jeitos:
 *   1. pelo ical.js (o parser do Thunderbird, dependência de desenvolvimento):
 *      se ele lê o que geramos e devolve as mesmas datas, um aplicativo real lê;
 *   2. por conferência direta dos bytes — CRLF, 75 octetos, escapes — porque
 *      um parser tolerante aceitaria uma linha de 80 octetos sem reclamar.
 *
 * Números de processo, nomes e textos: SINTÉTICOS.
 */

const AGORA = new Date('2026-10-02T15:00:00.000Z');
const NUMERO = '12345674720238260100';
const FORMATADO = '1234567-47.2023.8.26.0100';
const OPCOES = { agora: AGORA, urlBase: 'https://exemplo.invalid' };

function manual(
  s: Partial<Parameters<typeof EventoDeCalendario.manual>[0]> = {},
): EventoDeCalendario {
  return EventoDeCalendario.manual({
    id: '7d1f3a0e-0000-4000-8000-000000000001',
    workspace: 'ws',
    numeroProcesso: NUMERO,
    tribunal: 'TJSP',
    segredoJustica: false,
    tipo: 'audiencia',
    titulo: 'Audiência com FULANA SINTÉTICA',
    observacao: 'Levar a procuração; cliente nervoso',
    dataLocal: '2026-11-12',
    agora: AGORA,
    ...s,
  });
}

const SUGESTAO: SugestaoDeEvento = {
  tipo: 'pericia',
  titulo: 'Perícia',
  dataLocal: '2026-11-20',
  horaLocal: '08:00',
  procedencia: {
    movimentacaoId: 'x',
    dataDoAndamento: new Date('2026-10-01T12:00:00.000Z'),
    trecho: 'TRECHO-SECRETO do andamento com BELTRANO EXEMPLAR',
  },
};

function sugerido(segredoJustica = false): EventoDeCalendario {
  return EventoDeCalendario.sugerido({
    id: '7d1f3a0e-0000-4000-8000-000000000002',
    workspace: 'ws',
    numeroProcesso: NUMERO,
    tribunal: 'TJSP',
    segredoJustica,
    sugestao: SUGESTAO,
    agora: AGORA,
  });
}

function eventosLidos(ics: string): ICAL.Event[] {
  const comp = new ICAL.Component(ICAL.parse(ics));
  return comp.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v));
}

describe('ICS — formato (RFC 5545)', () => {
  const ics = gerarIcs([manual(), sugerido()], OPCOES);

  it('toda linha termina em CRLF, e não há LF solto', () => {
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('nenhuma linha passa de 75 OCTETOS', () => {
    for (const linha of ics.split('\r\n')) {
      expect(Buffer.byteLength(linha, 'utf8')).toBeLessThanOrEqual(75);
    }
  });

  it('cabeçalho do calendário', () => {
    expect(ics).toContain('PRODID:-//Processo Vivo//Calendario//PT-BR\r\n');
    expect(ics).toContain('VERSION:2.0\r\n');
    expect(ics).toContain('CALSCALE:GREGORIAN\r\n');
    expect(ics).toContain('X-WR-CALNAME:Processo Vivo\r\n');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n');
    expect(ics).toContain('X-PUBLISHED-TTL:PT1H\r\n');
  });

  it('o ical.js lê o feed inteiro', () => {
    const lidos = eventosLidos(ics);
    expect(lidos).toHaveLength(2);
    expect(lidos.map((e) => e.uid).sort()).toEqual([
      '7d1f3a0e-0000-4000-8000-000000000001@processovivo.com.br',
      '7d1f3a0e-0000-4000-8000-000000000002@processovivo.com.br',
    ]);
  });
});

describe('ICS — dobra e escape', () => {
  it('dobra em 75 octetos contando UTF-8, sem partir caractere acentuado', () => {
    const linha = `SUMMARY:${'Audiência '.repeat(20)}`;
    const dobrada = dobrar(linha);
    const partes = dobrada.split('\r\n');
    expect(partes.length).toBeGreaterThan(2);
    for (const p of partes) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(75);
    for (const p of partes.slice(1)) expect(p.startsWith(' ')).toBe(true);
    // Desdobrar (RFC: tira CRLF + espaço) devolve exatamente a original.
    expect(dobrada.replace(/\r\n /g, '')).toBe(linha);
    expect(dobrada).not.toContain('�');
  });

  it('linha com acento perto do limite: o caractere de 2 bytes vai inteiro para a seguinte', () => {
    const linha = `${'x'.repeat(74)}ê`;
    const [primeira, segunda] = dobrar(linha).split('\r\n');
    expect(primeira).toBe('x'.repeat(74));
    expect(segunda).toBe(' ê');
  });

  it('escapa barra invertida, ponto e vírgula, vírgula e quebra de linha', () => {
    expect(escapar('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });

  it('o ical.js desfaz o escape e chega ao texto original', () => {
    const [lido] = eventosLidos(gerarIcs([manual()], OPCOES));
    expect(lido?.description).toContain('Criado por você.');
    expect(lido?.description).toContain('\n');
  });
});

describe('ICS — quando', () => {
  it('dia inteiro: VALUE=DATE, DTEND no dia seguinte, sem deslocar o dia', () => {
    const ics = gerarIcs([manual({ dataLocal: '2026-12-31' })], OPCOES);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261231\r\n');
    expect(ics).toContain('DTEND;VALUE=DATE:20270101\r\n');
    const [lido] = eventosLidos(ics);
    expect(lido?.startDate.isDate).toBe(true);
    expect(lido?.startDate.toString()).toBe('2026-12-31');
    expect(lido?.endDate.toString()).toBe('2027-01-01');
  });

  it('com hora: TZID de São Paulo, com VTIMEZONE fixo em -0300', () => {
    const ics = gerarIcs(
      [manual({ horaLocal: '14:30', duracaoMin: 90, dataLocal: '2026-11-12' })],
      OPCOES,
    );
    expect(ics).toContain('DTSTART;TZID=America/Sao_Paulo:20261112T143000\r\n');
    expect(ics).toContain('DTEND;TZID=America/Sao_Paulo:20261112T160000\r\n');
    expect(ics).toMatch(/BEGIN:VTIMEZONE\r\nTZID:America\/Sao_Paulo\r\n/);
    expect(ics).toContain('TZOFFSETFROM:-0300\r\n');
    expect(ics).toContain('TZOFFSETTO:-0300\r\n');
    expect(ics).not.toContain('DAYLIGHT');

    // O ical.js resolve o fuso pelo VTIMEZONE do próprio arquivo.
    const comp = new ICAL.Component(ICAL.parse(ics));
    const vtz = comp.getFirstSubcomponent('vtimezone');
    expect(vtz).not.toBeNull();
    if (vtz) ICAL.TimezoneService.register(new ICAL.Timezone(vtz));
    const evento = new ICAL.Event(comp.getFirstSubcomponent('vevent') ?? undefined);
    expect(evento.startDate.toJSDate().toISOString()).toBe('2026-11-12T17:30:00.000Z');
    expect(evento.endDate.toJSDate().toISOString()).toBe('2026-11-12T19:00:00.000Z');
    ICAL.TimezoneService.reset();
  });

  it('com hora e sem duração: não inventa DTEND', () => {
    const ics = gerarIcs([manual({ horaLocal: '09:00' })], OPCOES);
    expect(ics).not.toContain('DTEND');
  });

  it('duração que atravessa a meia-noite muda o dia do fim', () => {
    const ics = gerarIcs([manual({ horaLocal: '23:30', duracaoMin: 60 })], OPCOES);
    expect(ics).toContain('DTEND;TZID=America/Sao_Paulo:20261113T003000\r\n');
  });
});

describe('ICS — identidade e versão', () => {
  it('UID estável entre gerações; SEQUENCE acompanha a alteração; DTSTAMP em UTC', () => {
    const e = manual();
    const editado = e.editar(
      { dataLocal: '2026-11-13' },
      new Date('2026-10-03T10:20:30.000Z'),
    );
    const [a] = eventosLidos(gerarIcs([e], OPCOES));
    const [b] = eventosLidos(gerarIcs([editado], OPCOES));
    expect(a?.uid).toBe(b?.uid);
    expect(a?.sequence).toBe(0);
    expect(b?.sequence).toBe(1);
    expect(gerarIcs([editado], OPCOES)).toContain('DTSTAMP:20261003T102030Z\r\n');
  });

  it('descartado sai como CANCELLED; sugerido como TENTATIVE e com "[sugerido]"', () => {
    const ics = gerarIcs([manual().descartar(AGORA), sugerido()], OPCOES);
    expect(ics).toContain('STATUS:CANCELLED\r\n');
    expect(ics).toContain('STATUS:TENTATIVE\r\n');
    expect(ics).toContain('SUMMARY:[sugerido] Perícia — ');
  });
});

describe('ICS — privacidade', () => {
  const ics = gerarIcs([manual(), sugerido()], OPCOES);
  const desdobrado = ics.replace(/\r\n /g, '');

  it('SUMMARY é tipo e número, nunca o título livre', () => {
    expect(desdobrado).toContain(`SUMMARY:Audiência — ${FORMATADO}\r\n`);
    expect(desdobrado).not.toContain('FULANA');
  });

  it('sem trecho do andamento, sem nome de parte, sem observação', () => {
    expect(desdobrado).not.toContain('TRECHO-SECRETO');
    expect(desdobrado).not.toContain('BELTRANO');
    expect(desdobrado).not.toContain('procuração');
  });

  it('diz de onde veio a data e manda conferir — sem afirmar prazo', () => {
    expect(desdobrado).toContain('Origem: lido do andamento de 01/10/2026.');
    expect(desdobrado).toContain('confira no processo');
    expect(desdobrado).toContain('Criado por você.');
    expect(desdobrado).not.toMatch(/prazo fatal/i);
  });

  it('processo em segredo de justiça: sem número no resumo, na descrição e no link', () => {
    const sigiloso = gerarIcs(
      [sugerido(true), manual({ segredoJustica: true })],
      OPCOES,
    ).replace(/\r\n /g, '');
    expect(sigiloso).toContain('SUMMARY:[sugerido] Perícia (processo sigiloso)\r\n');
    expect(sigiloso).toContain('SUMMARY:Audiência (processo sigiloso)\r\n');
    expect(sigiloso).not.toContain(NUMERO);
    expect(sigiloso).not.toContain(FORMATADO);
    expect(sigiloso).not.toContain('1234567');
    expect(sigiloso).toContain('Abrir no Processo Vivo: https://exemplo.invalid/\r\n');
  });
});

describe('feed ICS — prazo calculado (v0.39.0)', () => {
  const desdobrar = (ics: string): string => ics.replace(/\r\n /g, '');

  it('o evento calculado diz, na descrição, que a data foi calculada pelo Processo Vivo', () => {
    const e = manual({
      tipo: 'prazo',
      titulo: 'Prazo de 15 dias úteis (a conferir)',
      calculado: true,
    });
    const ics = desdobrar(gerarIcs([e], OPCOES));
    expect(ics).toContain('Data calculada pelo Processo Vivo: confira no processo.');
    // O título livre continua fora do feed.
    expect(ics).not.toContain('a conferir)');
    expect(ics).toContain(`SUMMARY:Prazo — ${FORMATADO}`);
  });

  it('evento comum não leva a frase', () => {
    const ics = desdobrar(gerarIcs([manual()], OPCOES));
    expect(ics).not.toContain('Data calculada pelo Processo Vivo');
  });

  it('processo sigiloso: a frase vai, o número não', () => {
    const e = manual({ tipo: 'prazo', calculado: true, segredoJustica: true });
    const ics = desdobrar(gerarIcs([e], OPCOES));
    expect(ics).toContain('Data calculada pelo Processo Vivo: confira no processo.');
    expect(ics).toContain('SUMMARY:Prazo (processo sigiloso)');
    expect(ics).not.toContain(NUMERO);
  });
});
