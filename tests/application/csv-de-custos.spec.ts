import { describe, expect, it } from 'vitest';
import {
  BOM,
  celulaDeTexto,
  celulaNumerica,
  linhaDeCsv,
  montarCsv,
} from '../../src/application/politicas/csvDeCustos.js';

describe('CSV dos custos', () => {
  it('começa com BOM UTF-8, separa por ponto e vírgula e termina as linhas com CRLF', () => {
    const csv = montarCsv(
      ['Tipo', 'Valor'],
      [linhaDeCsv([celulaDeTexto('Despesa'), celulaNumerica('1234,56')])],
    );
    expect(csv.startsWith(BOM)).toBe(true);
    expect(BOM).toBe('\uFEFF');
    expect(csv).toBe('\uFEFFTipo;Valor\r\nDespesa;1234,56\r\n');
    // Os bytes de fato começam com EF BB BF.
    expect([...Buffer.from(csv, 'utf8').subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it.each([
    '=1+1',
    '+55',
    '-10',
    '@SOMA(A1)',
    '\t=1',
    '\r=1',
    '=HYPERLINK("http://x","clique")',
    "=cmd|' /C calc'!A0",
  ])('neutraliza fórmula: %j recebe um apóstrofo na frente', (perigo) => {
    const c = celulaDeTexto(perigo);
    const bruto = c.startsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c;
    expect(bruto.startsWith("'")).toBe(true);
    expect(bruto).toBe(`'${perigo}`);
  });

  it('texto comum não é alterado; gatilho no MEIO do texto também não', () => {
    expect(celulaDeTexto('Guia de custas')).toBe('Guia de custas');
    expect(celulaDeTexto('Custas = R$ 10')).toBe('Custas = R$ 10');
    expect(celulaDeTexto('')).toBe('');
    expect(celulaDeTexto('Perícia - laudo')).toBe('Perícia - laudo');
  });

  it('escapa ponto e vírgula, aspas e quebra de linha, sem perder o texto', () => {
    expect(celulaDeTexto('a;b')).toBe('"a;b"');
    expect(celulaDeTexto('disse "oi"')).toBe('"disse ""oi"""');
    expect(celulaDeTexto('linha1\nlinha2')).toBe('"linha1\nlinha2"');
    // Fórmula E ponto e vírgula juntos: neutraliza e depois escapa.
    expect(celulaDeTexto('=A1;B1')).toBe('"\'=A1;B1"');
  });

  it('o cabeçalho também passa pela proteção, e o byte nulo some', () => {
    const csv = montarCsv(['=x'], []);
    expect(csv).toBe("\uFEFF'=x\r\n");
    expect(celulaDeTexto('a\u0000b')).toBe('ab');
  });

  it('acentos e símbolos saem como UTF-8', () => {
    const csv = montarCsv(['Descrição'], [celulaDeTexto('Perícia › honorários')]);
    expect(Buffer.from(csv, 'utf8').toString('utf8')).toContain('Perícia › honorários');
  });
});
