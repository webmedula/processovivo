import { describe, expect, it } from 'vitest';
import {
  AVISO_DO_PRAZO_CALCULADO,
  calcularPrazo,
  domingoDePascoa,
  ehDiaUtil,
  ehFeriadoNacional,
  estaNoRecesso,
  tituloDoPrazoCalculado,
} from '../../src/domain/entities/prazoEmDias.js';

/* Datas SINTÉTICAS. Conferidas à mão no calendário de 2026/2027:
   02/10/2026 é sexta; 12/10/2026 (segunda) é feriado nacional; 18/12/2026 é sexta. */

describe('calculadora de prazo — dias úteis e fim de semana', () => {
  it('sábado e domingo não são dias úteis', () => {
    expect(ehDiaUtil('2026-10-02')).toBe(true); // sexta
    expect(ehDiaUtil('2026-10-03')).toBe(false); // sábado
    expect(ehDiaUtil('2026-10-04')).toBe(false); // domingo
    expect(ehDiaUtil('2026-10-05')).toBe(true); // segunda
  });

  it('disponibilizado na sexta: publica na segunda, conta a partir da terça', () => {
    const p = calcularPrazo({ disponibilizacao: '2026-10-02', dias: 1, tipo: 'uteis' });
    expect(p.dataDaPublicacao).toBe('2026-10-05');
    expect(p.inicioDaContagem).toBe('2026-10-06');
    expect(p.dataFinal).toBe('2026-10-06');
  });

  it('feriado nacional fixo é pulado (12/10/2026, segunda)', () => {
    // dia 1 = terça 06/10; 06, 07, 08, 09 e — pulando segunda 12/10 — 13/10.
    const p = calcularPrazo({ disponibilizacao: '2026-10-02', dias: 5, tipo: 'uteis' });
    expect(p.dataFinal).toBe('2026-10-13');
  });

  it('disponibilizado em véspera de feriado: a publicação pula o feriado', () => {
    // 09/10/2026 é sexta; 10 e 11 são fim de semana e 12 é feriado → publica terça 13/10.
    const p = calcularPrazo({ disponibilizacao: '2026-10-09', dias: 1, tipo: 'uteis' });
    expect(p.dataDaPublicacao).toBe('2026-10-13');
    expect(p.inicioDaContagem).toBe('2026-10-14');
    expect(p.dataFinal).toBe('2026-10-14');
  });
});

describe('calculadora de prazo — feriados nacionais e Páscoa', () => {
  it('a Páscoa sai do cálculo, não de uma tabela', () => {
    expect(domingoDePascoa(2024)).toBe('2024-03-31');
    expect(domingoDePascoa(2025)).toBe('2025-04-20');
    expect(domingoDePascoa(2026)).toBe('2026-04-05');
    expect(domingoDePascoa(2027)).toBe('2027-03-28');
  });

  it('Sexta-feira Santa é feriado, o sábado seguinte não é o feriado', () => {
    expect(ehFeriadoNacional('2026-04-03')).toBe(true);
    expect(ehFeriadoNacional('2027-03-26')).toBe(true);
    expect(ehFeriadoNacional('2026-04-02')).toBe(false); // quinta
    expect(ehDiaUtil('2026-04-03')).toBe(false);
  });

  it('prazo que atravessa a Sexta-feira Santa a pula', () => {
    // 01/04/2026 é quarta. Publica quinta 02/04, conta da sexta (feriado) → segunda 06/04.
    const p = calcularPrazo({ disponibilizacao: '2026-04-01', dias: 1, tipo: 'uteis' });
    expect(p.dataDaPublicacao).toBe('2026-04-02');
    expect(p.inicioDaContagem).toBe('2026-04-06');
    expect(p.dataFinal).toBe('2026-04-06');
  });

  it('feriados fixos listados, e o 20/11 só vale a partir de 2024', () => {
    for (const d of [
      '2026-01-01',
      '2026-04-21',
      '2026-05-01',
      '2026-09-07',
      '2026-10-12',
      '2026-11-02',
      '2026-11-15',
      '2026-12-25',
    ]) {
      expect(ehFeriadoNacional(d)).toBe(true);
    }
    expect(ehFeriadoNacional('2023-11-20')).toBe(false);
    expect(ehFeriadoNacional('2024-11-20')).toBe(true);
  });

  it('feriado local e ponto facultativo NÃO são considerados (e a calculadora diz isso)', () => {
    expect(ehFeriadoNacional('2026-02-17')).toBe(false); // terça de carnaval
    expect(ehFeriadoNacional('2026-06-04')).toBe(false); // Corpus Christi
    const p = calcularPrazo({ disponibilizacao: '2026-10-02', dias: 5, tipo: 'uteis' });
    expect(p.aviso).toBe(AVISO_DO_PRAZO_CALCULADO);
    expect(p.aviso).toContain('Feriado local e suspensões não considerados');
    expect(p.premissas.join(' ')).toContain('Não considerados: feriado estadual');
  });
});

describe('calculadora de prazo — recesso e virada de ano', () => {
  it('recesso de 20/12 a 20/01, inclusive', () => {
    expect(estaNoRecesso('2026-12-19')).toBe(false);
    expect(estaNoRecesso('2026-12-20')).toBe(true);
    expect(estaNoRecesso('2027-01-01')).toBe(true);
    expect(estaNoRecesso('2027-01-20')).toBe(true);
    expect(estaNoRecesso('2027-01-21')).toBe(false);
  });

  it('disponibilizado antes do recesso: publica e conta só depois de 20/01', () => {
    // 18/12/2026 é sexta. Sábado 19, depois recesso até 20/01/2027 (quarta).
    const p = calcularPrazo({ disponibilizacao: '2026-12-18', dias: 5, tipo: 'uteis' });
    expect(p.dataDaPublicacao).toBe('2027-01-21');
    expect(p.inicioDaContagem).toBe('2027-01-22');
    expect(p.dataFinal).toBe('2027-01-28');
  });

  it('prazo em andamento atravessa a virada de ano sem contar o recesso', () => {
    // 01/12/2026 é terça. Publica quarta 02/12, dia 1 = quinta 03/12.
    // Dias úteis de 03/12 até 18/12 = 12 (3,4,7,8,9,10,11,14,15,16,17,18); o 13º é 21/01/2027.
    const p = calcularPrazo({ disponibilizacao: '2026-12-01', dias: 13, tipo: 'uteis' });
    expect(p.inicioDaContagem).toBe('2026-12-03');
    expect(p.dataFinal).toBe('2027-01-21');
  });
});

describe('calculadora de prazo — dias corridos', () => {
  it('conta todos os dias a partir do primeiro dia útil depois da publicação', () => {
    const p = calcularPrazo({
      disponibilizacao: '2026-10-02',
      dias: 15,
      tipo: 'corridos',
    });
    expect(p.inicioDaContagem).toBe('2026-10-06');
    expect(p.dataFinal).toBe('2026-10-20'); // terça
  });

  it('vencendo em dia sem expediente, passa ao primeiro dia útil seguinte', () => {
    // dia 1 = 06/10; 12º dia = sábado 17/10 → segunda 19/10.
    const p = calcularPrazo({
      disponibilizacao: '2026-10-02',
      dias: 12,
      tipo: 'corridos',
    });
    expect(p.dataFinal).toBe('2026-10-19');
  });
});

describe('calculadora de prazo — premissas, título e entradas inválidas', () => {
  it('devolve as premissas em frases curtas', () => {
    const p = calcularPrazo({ disponibilizacao: '2026-10-02', dias: 15, tipo: 'uteis' });
    expect(p.premissas).toHaveLength(6);
    expect(p.premissas[0]).toBe('Disponibilização no Diário em 02/10/2026.');
    for (const frase of p.premissas) expect(frase.length).toBeLessThan(200);
  });

  it('título só com campos estruturados', () => {
    expect(tituloDoPrazoCalculado(15, 'uteis')).toBe(
      'Prazo de 15 dias úteis (a conferir)',
    );
    expect(tituloDoPrazoCalculado(1, 'uteis')).toBe('Prazo de 1 dia útil (a conferir)');
    expect(tituloDoPrazoCalculado(10, 'corridos')).toBe(
      'Prazo de 10 dias corridos (a conferir)',
    );
  });

  it('recusa dias fora de 1–365 e data malformada', () => {
    for (const dias of [0, -1, 366, 1.5, Number.NaN]) {
      expect(() =>
        calcularPrazo({ disponibilizacao: '2026-10-02', dias, tipo: 'uteis' }),
      ).toThrow(RangeError);
    }
    expect(() =>
      calcularPrazo({ disponibilizacao: '02/10/2026', dias: 5, tipo: 'uteis' }),
    ).toThrow(RangeError);
  });
});
