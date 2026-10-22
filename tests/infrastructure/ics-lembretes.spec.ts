import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { EventoDeCalendario } from '../../src/domain/entities/EventoDeCalendario.js';
import type { SugestaoDeEvento } from '../../src/domain/entities/EventoDeCalendario.js';
import { gerarIcs } from '../../src/infrastructure/calendario/ics.js';

/*
 * Lembretes (VALARM) do feed, v0.51.0. O que se PROVA aqui é o FORMATO do ICS (o texto, lido também pelo
 * ical.js). O que o Apple Calendário, o Outlook e o Google fazem com o alarme NÃO é provado por teste.
 * Números, nomes e textos: SINTÉTICOS.
 */

const AGORA = new Date('2026-10-02T15:00:00.000Z');
const NUMERO = '12345674720238260100';
const FORMATADO = '1234567-47.2023.8.26.0100';
const BASE = { agora: AGORA, urlBase: 'https://exemplo.invalid' };
const AMBOS = { umDiaAntes: true, umaHoraAntes: true };

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
    observacao: 'OBSERVACAO-PRIVADA',
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

function sugerido(): EventoDeCalendario {
  return EventoDeCalendario.sugerido({
    id: '7d1f3a0e-0000-4000-8000-000000000002',
    workspace: 'ws',
    numeroProcesso: NUMERO,
    tribunal: 'TJSP',
    segredoJustica: false,
    sugestao: SUGESTAO,
    agora: AGORA,
  });
}

const alarmes = (ics: string): string[] =>
  ics.match(/BEGIN:VALARM[\s\S]*?END:VALARM/g) ?? [];
const linhas = (ics: string): string[] => ics.split('\r\n');

describe('feed ICS — lembretes (VALARM)', () => {
  it('sem lembretes escolhidos o ICS sai idêntico ao de antes (nenhum VALARM)', () => {
    const e = manual({ horaLocal: '14:30' });
    const sem = gerarIcs([e], BASE);
    expect(sem).not.toContain('VALARM');
    expect(
      gerarIcs([e], { ...BASE, lembretes: { umDiaAntes: false, umaHoraAntes: false } }),
    ).toBe(sem);
  });

  it('evento com hora: gatilho relativo -P1D e -PT1H, ACTION:DISPLAY e DESCRIPTION igual ao SUMMARY', () => {
    const ics = gerarIcs([manual({ horaLocal: '14:30' })], { ...BASE, lembretes: AMBOS });
    const a = alarmes(ics);
    expect(a).toHaveLength(2);
    expect(a[0]).toBe(
      [
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:Audiência — ${FORMATADO}`,
        'TRIGGER:-P1D',
        'END:VALARM',
      ].join('\r\n'),
    );
    expect(a[1]).toContain('TRIGGER:-PT1H');
    // O alarme mora DENTRO do VEVENT.
    expect(ics).toMatch(/END:VALARM\r\nEND:VEVENT/);
  });

  it('dia inteiro: gatilho ABSOLUTO em UTC — 1 dia antes = 09:00 SP do dia anterior; 1 hora = 08:00 SP do dia', () => {
    const ics = gerarIcs([manual({ dataLocal: '2026-11-12' })], {
      ...BASE,
      lembretes: AMBOS,
    });
    expect(ics).toContain('TRIGGER;VALUE=DATE-TIME:20261111T120000Z');
    expect(ics).toContain('TRIGGER;VALUE=DATE-TIME:20261112T110000Z');
    // 12:00Z é 09:00 em São Paulo (-03:00); 11:00Z é 08:00.
    expect(new Date('2026-11-11T12:00:00Z').getTime() - 3 * 3_600_000).toBe(
      new Date('2026-11-11T09:00:00Z').getTime(),
    );
  });

  it('dia inteiro na virada de mês: "1 dia antes" cai no último dia do mês anterior', () => {
    const ics = gerarIcs([manual({ dataLocal: '2026-12-01' })], {
      ...BASE,
      lembretes: { umDiaAntes: true, umaHoraAntes: false },
    });
    expect(ics).toContain('TRIGGER;VALUE=DATE-TIME:20261130T120000Z');
    expect(alarmes(ics)).toHaveLength(1);
  });

  it('só as opções marcadas geram alarme', () => {
    const e = manual({ horaLocal: '09:00' });
    const dia = gerarIcs([e], {
      ...BASE,
      lembretes: { umDiaAntes: true, umaHoraAntes: false },
    });
    const hora = gerarIcs([e], {
      ...BASE,
      lembretes: { umDiaAntes: false, umaHoraAntes: true },
    });
    expect(alarmes(dia)).toHaveLength(1);
    expect(dia).toContain('TRIGGER:-P1D');
    expect(alarmes(hora)).toHaveLength(1);
    expect(hora).toContain('TRIGGER:-PT1H');
  });

  it('nunca em sugerido, nunca em CANCELLED', () => {
    const descartado = manual({ id: '7d1f3a0e-0000-4000-8000-000000000003' }).descartar(
      AGORA,
    );
    const ics = gerarIcs([sugerido(), descartado], { ...BASE, lembretes: AMBOS });
    expect(ics).toContain('STATUS:TENTATIVE');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(alarmes(ics)).toHaveLength(0);
  });

  it('sugerido que o advogado confirma passa a ter alarme', () => {
    const confirmado = sugerido().confirmar(AGORA);
    expect(alarmes(gerarIcs([confirmado], { ...BASE, lembretes: AMBOS }))).toHaveLength(
      2,
    );
  });

  it('só evento futuro: o que já começou (com hora) ou o dia que já passou não leva alarme', () => {
    const jaComecou = manual({ horaLocal: '10:00', dataLocal: '2026-10-02' }); // 10:00 SP = 13:00Z < 15:00Z
    const aindaVem = manual({
      id: '7d1f3a0e-0000-4000-8000-000000000004',
      horaLocal: '13:00',
      dataLocal: '2026-10-02', // 13:00 SP = 16:00Z > 15:00Z
    });
    const ontem = manual({
      id: '7d1f3a0e-0000-4000-8000-000000000005',
      dataLocal: '2026-10-01',
    });
    const hoje = manual({
      id: '7d1f3a0e-0000-4000-8000-000000000006',
      dataLocal: '2026-10-02',
    });
    const ics = gerarIcs([jaComecou, aindaVem, ontem, hoje], {
      ...BASE,
      lembretes: AMBOS,
    });
    // aindaVem (2) + hoje, dia inteiro (2) = 4; jaComecou e ontem: 0.
    expect(alarmes(ics)).toHaveLength(4);
  });

  it('privacidade: DESCRIPTION do alarme sem parte, trecho ou observação; sigilo sem número', () => {
    const sigiloso = manual({
      id: '7d1f3a0e-0000-4000-8000-000000000007',
      segredoJustica: true,
      horaLocal: '14:30',
    });
    const ics = gerarIcs(
      [manual({ horaLocal: '14:30' }), sigiloso, sugerido().confirmar(AGORA)],
      {
        ...BASE,
        lembretes: AMBOS,
      },
    );
    const todos = alarmes(ics).join('\n');
    expect(todos).not.toMatch(
      /FULANA|BELTRANO|TRECHO-SECRETO|OBSERVACAO-PRIVADA|SINTÉTICA/,
    );
    expect(todos).toContain('DESCRIPTION:Audiência (processo sigiloso)');
    expect(alarmes(ics).filter((a) => a.includes('sigiloso'))).toHaveLength(2);
    for (const a of alarmes(ics).filter((x) => x.includes('sigiloso'))) {
      expect(a).not.toContain(FORMATADO);
    }
  });

  it('o DESCRIPTION do alarme é, byte a byte, o SUMMARY do evento', () => {
    const ics = gerarIcs([manual({ horaLocal: '14:30' })], { ...BASE, lembretes: AMBOS });
    const summary = /SUMMARY:(.*)\r\n/.exec(ics)?.[1];
    for (const a of alarmes(ics)) expect(a).toContain(`DESCRIPTION:${summary}`);
  });

  it('CRLF em todo o arquivo e nenhuma linha acima de 75 octetos, alarmes incluídos', () => {
    const ics = gerarIcs(
      [manual({ horaLocal: '14:30' }), manual({ id: 'x2', dataLocal: '2026-11-13' })],
      {
        ...BASE,
        lembretes: AMBOS,
      },
    );
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    for (const l of linhas(ics))
      expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('o ical.js lê o alarme: ação, gatilho relativo e gatilho absoluto', () => {
    const ics = gerarIcs(
      [manual({ horaLocal: '14:30' }), manual({ id: 'dia', dataLocal: '2026-11-13' })],
      { ...BASE, lembretes: AMBOS },
    );
    const cal = new ICAL.Component(ICAL.parse(ics));
    const eventos = cal.getAllSubcomponents('vevent');
    expect(eventos).toHaveLength(2);
    const [comHora, diaInteiro] = eventos as [ICAL.Component, ICAL.Component];
    const a1 = comHora.getAllSubcomponents('valarm');
    expect(a1.map((a) => a.getFirstPropertyValue('action'))).toEqual([
      'DISPLAY',
      'DISPLAY',
    ]);
    expect(String(a1[0]?.getFirstPropertyValue('trigger'))).toBe('-P1D');
    expect(String(a1[1]?.getFirstPropertyValue('trigger'))).toBe('-PT1H');
    const a2 = diaInteiro.getAllSubcomponents('valarm');
    expect(String(a2[0]?.getFirstPropertyValue('trigger'))).toBe('2026-11-12T12:00:00Z');
    expect(String(a2[1]?.getFirstPropertyValue('trigger'))).toBe('2026-11-13T11:00:00Z');
  });

  it('janela: o alarme só vai nos eventos que o chamador já filtrou — nada fora da lista recebida', () => {
    // A janela (-30/+365) é de `selecionarParaFeed`; o gerador não amplia a lista.
    const ics = gerarIcs([], { ...BASE, lembretes: AMBOS });
    expect(alarmes(ics)).toHaveLength(0);
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});

describe('feed ICS — mudar a preferência de lembretes sem duplicar', () => {
  it('mesmo UID; SEQUENCE soma a revisão do feed e o DTSTAMP não recua', () => {
    const e = manual({ horaLocal: '14:30' });
    const antes = gerarIcs([e], BASE);
    const alterado = new Date('2026-10-02T14:00:00.000Z');
    const depois = gerarIcs([e], {
      ...BASE,
      lembretes: AMBOS,
      revisaoLembretes: 1,
      lembretesAlteradosEm: alterado,
    });
    const campo = (ics: string, nome: string): string =>
      new RegExp(`${nome}:(.*)\\r\\n`).exec(ics)?.[1] ?? '';
    expect(campo(depois, 'UID')).toBe(campo(antes, 'UID'));
    expect(campo(antes, 'SEQUENCE')).toBe(String(e.sequencia));
    expect(campo(depois, 'SEQUENCE')).toBe(String(e.sequencia + 1));
    // `e.atualizadoEm` é AGORA (15:00Z); a mudança foi às 14:00Z, então o maior continua sendo o do evento.
    expect(campo(depois, 'DTSTAMP')).toBe('20261002T150000Z');
    expect((depois.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
  });

  it('mudança de lembretes MAIS NOVA que o evento vira o DTSTAMP', () => {
    const e = manual({ horaLocal: '14:30' });
    const alterado = new Date('2026-10-03T09:30:00.000Z');
    const ics = gerarIcs([e], {
      ...BASE,
      lembretes: AMBOS,
      revisaoLembretes: 2,
      lembretesAlteradosEm: alterado,
    });
    expect(ics).toContain('DTSTAMP:20261003T093000Z');
    expect(ics).toContain(`SEQUENCE:${e.sequencia + 2}`);
  });
});
