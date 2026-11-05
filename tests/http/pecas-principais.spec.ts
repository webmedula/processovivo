import { describe, expect, it } from 'vitest';
import { pecasPrincipais } from '../../src/main/http/ui/pecasPrincipais.js';

/* O atalho "Marcar peças principais" da análise do processo: a MESMA função vai ao navegador por toString(). */

const p = (pecaId: string, rotulo: string, extra: object = {}) => ({
  pecaId,
  rotulo,
  ...extra,
});

describe('pecasPrincipais', () => {
  it('marca inicial, contestação, réplica, decisões e recursos, pelo rótulo do tribunal', () => {
    const ids = pecasPrincipais(
      [
        p('a', 'Petição - inicial'),
        p('b', 'Procuração'),
        p('c', 'Despacho - inicial'),
        p('d', 'Petição - contestação'),
        p('e', 'Petição - Réplica'),
        p('f', 'Decisão'),
        p('g', 'Sentença'),
        p('h', 'Recurso de Apelação'),
        p('i', 'Certidão'),
        p('j', 'Embargos de Declaração'),
      ],
      20,
    );
    expect(ids).toEqual(['a', 'd', 'e', 'f', 'g', 'h', 'j']);
  });

  it('não marca laudo, peça sigilosa nem linha sem peça', () => {
    const ids = pecasPrincipais(
      [
        p('a', 'Laudo pericial'),
        p('b', 'Petição - impugnação ao laudo'),
        p('c', 'Decisão', { estado: 'sigilo' }),
        p('d', 'Sentença', { semPeca: true }),
        p('e', 'Contestação'),
      ],
      20,
    );
    expect(ids).toEqual(['e']);
  });

  it('acima do limite fica com as mais recentes (o fim da lista)', () => {
    const lista = Array.from({ length: 25 }, (_, i) => p(`x${i}`, 'Decisão'));
    const ids = pecasPrincipais(lista, 20);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('x5');
    expect(ids[19]).toBe('x24');
  });

  it('vira código que roda sozinho no navegador (sem depender do módulo)', () => {
    const fn = new Function(
      `return (${pecasPrincipais.toString()})`,
    )() as typeof pecasPrincipais;
    expect(fn([p('a', 'Petição Inicial'), p('b', 'Laudo')], 20)).toEqual(['a']);
  });
});
