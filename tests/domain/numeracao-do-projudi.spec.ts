import { describe, expect, it } from 'vitest';
import {
  MAX_ANCORAS_POR_PROCESSO,
  motivoDeRecusaDaAncora,
  numeroDoProjudi,
  resumirNumeracao,
} from '../../src/domain/entities/numeracaoDoProjudi.js';
import type { AncoraDeNumeracao } from '../../src/domain/entities/numeracaoDoProjudi.js';

const a = (posicao: number, numeroProjudi: number): AncoraDeNumeracao => ({
  posicao,
  numeroProjudi,
});

describe('número do Projudi a partir das âncoras do advogado', () => {
  // Dados sintéticos: 20 atos recebidos.
  const TOTAL = 20;
  const casos: Array<{
    nome: string;
    ancoras: AncoraDeNumeracao[];
    posicao: number;
    esperado: ReturnType<typeof numeroDoProjudi>;
  }> = [
    {
      nome: 'sem âncora: a posição, dita como posição',
      ancoras: [],
      posicao: 7,
      esperado: { tipo: 'posicao', n: 7 },
    },
    {
      nome: 'o próprio ato ancorado é exato',
      ancoras: [a(20, 21)],
      posicao: 20,
      esperado: { tipo: 'exato', n: 21 },
    },
    {
      nome: 'uma âncora com d = 0 no fim: antes dela tudo é exato',
      ancoras: [a(20, 20)],
      posicao: 5,
      esperado: { tipo: 'exato', n: 5 },
    },
    {
      nome: 'uma âncora com d = 1 no fim: antes dela é faixa [pos, pos+1]',
      ancoras: [a(20, 21)],
      posicao: 5,
      esperado: { tipo: 'faixa', min: 5, max: 6 },
    },
    {
      nome: 'duas âncoras com d igual: exato entre elas',
      ancoras: [a(10, 11), a(18, 19)],
      posicao: 14,
      esperado: { tipo: 'exato', n: 15 },
    },
    {
      nome: 'duas âncoras com d diferente: faixa entre elas',
      ancoras: [a(10, 10), a(18, 19)],
      posicao: 14,
      esperado: { tipo: 'faixa', min: 14, max: 15 },
    },
    {
      nome: 'antes da primeira com d = 0: exato',
      ancoras: [a(10, 10), a(18, 19)],
      posicao: 3,
      esperado: { tipo: 'exato', n: 3 },
    },
    {
      nome: 'antes da primeira com d = 2: faixa de 0 a 2 bloqueados',
      ancoras: [a(10, 12)],
      posicao: 3,
      esperado: { tipo: 'faixa', min: 3, max: 5 },
    },
    {
      nome: 'depois da última: estimado com o deslocamento dela',
      ancoras: [a(10, 11)],
      posicao: 15,
      esperado: { tipo: 'estimado', n: 16 },
    },
    {
      nome: 'depois da última com d = 0 continua estimado (pode ter surgido bloqueado)',
      ancoras: [a(10, 10)],
      posicao: 15,
      esperado: { tipo: 'estimado', n: 15 },
    },
  ];
  it.each(casos)('$nome', ({ ancoras, posicao, esperado }) => {
    expect(numeroDoProjudi(posicao, ancoras, TOTAL)).toEqual(esperado);
  });

  it('não depende da ordem em que as âncoras vieram', () => {
    expect(numeroDoProjudi(14, [a(18, 19), a(10, 10)], TOTAL)).toEqual({
      tipo: 'faixa',
      min: 14,
      max: 15,
    });
  });

  it('resume quantos atos são exatos, faixa e estimados', () => {
    expect(resumirNumeracao([a(10, 11)], TOTAL)).toEqual({
      exatos: 1,
      faixas: 9,
      estimados: 10,
      total: 20,
    });
    expect(resumirNumeracao([], TOTAL)).toEqual({
      exatos: 0,
      faixas: 0,
      estimados: 0,
      total: 20,
    });
  });
});

describe('recusa de âncora', () => {
  it('aceita a primeira e a compatível, substituindo a da mesma posição', () => {
    expect(motivoDeRecusaDaAncora(a(10, 11), [], 20)).toBeUndefined();
    expect(motivoDeRecusaDaAncora(a(18, 19), [a(10, 11)], 20)).toBeUndefined();
    // Trocar a âncora da posição 10 por outra compatível com a de 18.
    expect(motivoDeRecusaDaAncora(a(10, 10), [a(10, 11), a(18, 19)], 20)).toBeUndefined();
  });

  it('recusa número abaixo da posição (d negativo)', () => {
    expect(motivoDeRecusaDaAncora(a(10, 9), [], 20)).toMatch(/menor que 10/);
  });

  it('recusa o que faria o deslocamento diminuir, com a mensagem pedida', () => {
    expect(motivoDeRecusaDaAncora(a(5, 7), [a(10, 11)], 20)).toBe(
      'Esse número não é compatível com os outros que você informou.',
    );
    expect(motivoDeRecusaDaAncora(a(15, 15), [a(10, 11)], 20)).toMatch(
      /não é compatível/,
    );
  });

  it('recusa posição fora dos atos recebidos e número absurdo', () => {
    expect(motivoDeRecusaDaAncora(a(21, 30), [], 20)).toMatch(/entre 1 e 20/);
    expect(motivoDeRecusaDaAncora(a(0, 1), [], 20)).toMatch(/entre 1 e 20/);
    expect(motivoDeRecusaDaAncora(a(5, 1_000_000_000), [], 20)).toMatch(
      /inteiro positivo/,
    );
  });

  it('limita o número de âncoras por processo, mas deixa substituir', () => {
    const cheias = Array.from({ length: MAX_ANCORAS_POR_PROCESSO }, (_, i) =>
      a(i + 1, i + 1),
    );
    expect(motivoDeRecusaDaAncora(a(51, 51), cheias, 60)).toMatch(/já tem 50/);
    expect(motivoDeRecusaDaAncora(a(5, 5), cheias, 60)).toBeUndefined();
  });
});
