import { describe, expect, it } from 'vitest';
import { descricaoDoAto } from '../../src/domain/entities/descricaoDoAto.js';

// Textos sintéticos: o formato é o do tribunal, o conteúdo é inventado.
describe('descricaoDoAto', () => {
  it('sem repetição devolve o texto como está', () => {
    expect(descricaoDoAto('Conclusos para despacho')).toBe('Conclusos para despacho');
    expect(descricaoDoAto('Juntada -> Petição — Tipo X - detalhe')).toBe(
      'Juntada -> Petição — Tipo X - detalhe',
    );
  });

  it('repetição com detalhe: "A — A - detalhe" vira "A - detalhe"', () => {
    expect(
      descricaoDoAto('Juntada -> Petição — Juntada -> Petição - MANDADO FICTÍCIO'),
    ).toBe('Juntada -> Petição - MANDADO FICTÍCIO');
    expect(
      descricaoDoAto('Certidão Expedida — Certidão Expedida - Extrato atualizado - XYZ'),
    ).toBe('Certidão Expedida - Extrato atualizado - XYZ');
  });

  it('repetição sem detalhe: "A — A" vira "A"', () => {
    expect(descricaoDoAto('Certidão Expedida — Certidão Expedida')).toBe(
      'Certidão Expedida',
    );
  });

  it('caixa, acento e espaços repetidos não distinguem a repetição', () => {
    expect(descricaoDoAto('CERTIDÃO  expedida — certidao Expedida - detalhe')).toBe(
      'certidao Expedida - detalhe',
    );
    expect(descricaoDoAto('Juntada   de Petição — Juntada de   petição')).toBe(
      'Juntada de   petição',
    );
  });

  it('textos parecidos mas diferentes não colapsam', () => {
    const t = 'Juntada -> Petição — Juntada -> Petição Inicial - detalhe';
    expect(descricaoDoAto(t)).toBe(t);
    const u = 'Certidão — Certidão Expedida';
    expect(descricaoDoAto(u)).toBe(u);
  });

  it('o tipo pode conter " - " e ainda assim a repetição é reconhecida', () => {
    expect(descricaoDoAto('Ato - Tipo — Ato - Tipo - detalhe')).toBe(
      'Ato - Tipo - detalhe',
    );
  });

  it('texto vazio, não texto e só separador', () => {
    expect(descricaoDoAto('')).toBe('');
    expect(descricaoDoAto(undefined)).toBe('');
    expect(descricaoDoAto(null)).toBe('');
    expect(descricaoDoAto(' — ')).toBe(' — ');
  });

  it('setas e travessões dentro do texto são preservados', () => {
    expect(descricaoDoAto('A -> B — A -> B - c — d')).toBe('A -> B - c — d');
    expect(descricaoDoAto('Sem repetição -> aqui — nem aqui')).toBe(
      'Sem repetição -> aqui — nem aqui',
    );
  });

  it('texto muito longo não é cortado', () => {
    const detalhe = 'x'.repeat(5000);
    expect(descricaoDoAto(`Tipo — Tipo - ${detalhe}`)).toBe(`Tipo - ${detalhe}`);
  });

  it('emoji passa sem alteração', () => {
    expect(descricaoDoAto('Aviso 📎 — Aviso 📎 - ok ✅')).toBe('Aviso 📎 - ok ✅');
  });
});
