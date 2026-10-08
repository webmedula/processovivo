import { describe, expect, it } from 'vitest';
import { tipoDaComunicacao } from '../../src/domain/entities/tipoDaComunicacao.js';
import { triar } from '../../src/domain/entities/triagem.js';

describe('tipoDaComunicacao', () => {
  it.each([
    ['Intimação', 'intimacao'],
    ['INTIMAÇÃO', 'intimacao'],
    ['  intimacao  ', 'intimacao'],
    ['Intimação eletrônica', 'intimacao'],
    ['Citação', 'citacao'],
    ['CITACAO', 'citacao'],
  ])('reconhece "%s" como %s', (entrada, esperado) => {
    expect(tipoDaComunicacao(entrada)).toBe(esperado);
  });

  it.each([
    ['Edital', 'outro'],
    ['Lista de distribuição', 'outro'],
    // Casa pelo começo da palavra: edital de citação é edital, não citação.
    ['Edital de citação', 'outro'],
    ['Pré-intimação', 'outro'],
    ['', 'outro'],
  ])('trata "%s" como outro', (entrada, esperado) => {
    expect(tipoDaComunicacao(entrada)).toBe(esperado);
  });

  it('valor ausente é outro, nunca providência por palpite', () => {
    expect(tipoDaComunicacao(undefined)).toBe('outro');
    expect(tipoDaComunicacao(null)).toBe('outro');
  });
});

describe('triagem das comunicações do DJEN', () => {
  const data = new Date('2026-09-04T00:00:00-03:00');

  it('"Ato ordinatório" intimado EXIGE ação (antes escapava)', () => {
    const semTipo = triar({ data, titulo: 'Ato ordinatório' });
    expect(semTipo.exigeAcao).toBe(false);

    const intimado = triar({
      data,
      titulo: 'Ato ordinatório',
      tipoComunicacao: 'Intimação',
    });
    expect(intimado.exigeAcao).toBe(true);
  });

  it('citação publicada exige ação', () => {
    expect(
      triar({ data, titulo: 'Despacho', tipoComunicacao: 'Citação' }).exigeAcao,
    ).toBe(true);
  });

  it('exige ação mesmo com o teor indisponível', () => {
    const t = triar({
      data,
      titulo: 'Ato ordinatório',
      tipoComunicacao: 'Intimação',
      teorIndisponivel: true,
    });
    expect(t.exigeAcao).toBe(true);
  });

  it('edital e tipo desconhecido não viram providência por palpite', () => {
    expect(
      triar({ data, titulo: 'Ato ordinatório', tipoComunicacao: 'Edital' }).exigeAcao,
    ).toBe(false);
  });
});
