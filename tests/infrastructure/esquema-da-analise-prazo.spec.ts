import { describe, expect, it } from 'vitest';
import {
  INSTRUCAO_DO_SISTEMA,
  VERSAO_PROMPT,
} from '../../src/application/politicas/entradaDoModelo.js';
import { lerRespostaDoModelo } from '../../src/infrastructure/adapters/modelo/esquemaDaAnalise.js';
import { INSTRUCAO_DE_FORMATO_EM_TEXTO } from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';

const BASE = {
  parece_pedir: 'manifestar',
  resumo: 'r',
  trecho_chave: 'se manifeste sobre o laudo',
  acoes_possiveis: [],
  pontos_de_atencao: [],
};

describe('esquema da análise — campo prazo (v0.39.0)', () => {
  it('prazo é opcional: ausente, null e preenchido passam', () => {
    expect(lerRespostaDoModelo(BASE)).toBeDefined();
    expect(lerRespostaDoModelo({ ...BASE, prazo: null })).toBeDefined();
    expect(
      lerRespostaDoModelo({ ...BASE, prazo: { dias: 15, tipo: 'uteis' } }),
    ).toMatchObject({ prazo: { dias: 15, tipo: 'uteis' } });
    expect(
      lerRespostaDoModelo({ ...BASE, prazo: { dias: 15, tipo: null } }),
    ).toBeDefined();
  });

  it('o modelo não consegue mandar data: campo a mais no prazo invalida a resposta', () => {
    expect(
      lerRespostaDoModelo({
        ...BASE,
        prazo: { dias: 15, tipo: 'uteis', data: '2026-10-30' },
      }),
    ).toBeUndefined();
    expect(
      lerRespostaDoModelo({ ...BASE, prazo: { data: '2026-10-30' } }),
    ).toBeUndefined();
  });

  it('dias fora de faixa NÃO derrubam a resposta no esquema (quem descarta é a verificação)', () => {
    expect(
      lerRespostaDoModelo({ ...BASE, prazo: { dias: 999, tipo: null } }),
    ).toBeDefined();
  });

  it('o prompt ato-1.2.0 e a instrução em texto falam do prazo e proíbem data', () => {
    expect(VERSAO_PROMPT).toBe('ato-1.2.0');
    expect(INSTRUCAO_DO_SISTEMA).toContain('- prazo: { dias, tipo } ou null');
    expect(INSTRUCAO_DO_SISTEMA).toContain('NUNCA escreva data');
    expect(INSTRUCAO_DE_FORMATO_EM_TEXTO).toContain('prazo ({dias, tipo} ou null)');
  });
});
