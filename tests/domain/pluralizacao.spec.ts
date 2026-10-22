import { describe, expect, it } from 'vitest';
import { contar, pluralizar } from '../../src/domain/entities/pluralizacao.js';

describe('pluralização das telas de IA', () => {
  it('um é singular; zero e dois ou mais são plural', () => {
    expect(pluralizar(0, 'pede', 'pedem')).toBe('pedem');
    expect(pluralizar(1, 'pede', 'pedem')).toBe('pede');
    expect(pluralizar(2, 'pede', 'pedem')).toBe('pedem');
    expect(pluralizar(11, 'pede', 'pedem')).toBe('pedem');
  });

  it('o número vem junto da palavra concordada', () => {
    expect(contar(0, 'ato tem', 'atos têm')).toBe('0 atos têm');
    expect(contar(1, 'ato tem', 'atos têm')).toBe('1 ato tem');
    expect(contar(3, 'ato tem', 'atos têm')).toBe('3 atos têm');
  });

  it('o zero pode virar uma frase própria, sem afetar os outros números', () => {
    expect(contar(0, 'ato', 'atos', 'nenhum ato')).toBe('nenhum ato');
    expect(contar(1, 'ato', 'atos', 'nenhum ato')).toBe('1 ato');
    expect(contar(2, 'ato', 'atos', 'nenhum ato')).toBe('2 atos');
  });

  it('são autocontidas: sobrevivem a toString() para o console', () => {
    const fn = new Function(
      `${contar.toString()}; ${pluralizar.toString()}; return [contar(1,'ato','atos'), pluralizar(2,'foi','foram')];`,
    )() as string[];
    expect(fn).toEqual(['1 ato', 'foram']);
  });
});
