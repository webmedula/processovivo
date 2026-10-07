import { describe, expect, it } from 'vitest';
import { nomeDaClasse } from '../../src/domain/entities/nomeDaClasse.js';

describe('nomeDaClasse — classe para exibição', () => {
  it('rebaixa a caixa alta e mantém o acento', () => {
    expect(nomeDaClasse('PROCEDIMENTO COMUM CÍVEL')).toBe('Procedimento Comum Cível');
    expect(nomeDaClasse('EXECUÇÃO FISCAL')).toBe('Execução Fiscal');
  });

  it('corrige o acento quebrado do DJEN (maiúsculas com a letra acentuada em minúscula)', () => {
    expect(nomeDaClasse('PROCEDIMENTO COMUM CíVEL')).toBe('Procedimento Comum Cível');
    expect(nomeDaClasse('AçãO TRABALHISTA')).toBe('Ação Trabalhista');
    // Só uma palavra quebrada, no meio de um texto escrito normalmente.
    expect(nomeDaClasse('Procedimento Comum CíVEL')).toBe('Procedimento Comum Cível');
  });

  it('as três escritas da mesma classe dão o mesmo texto', () => {
    const escritas = [
      'Procedimento Comum Cível',
      'PROCEDIMENTO COMUM CÍVEL',
      'PROCEDIMENTO COMUM CíVEL',
      'procedimento comum cível',
    ];
    expect(new Set(escritas.map(nomeDaClasse))).toEqual(
      new Set(['Procedimento Comum Cível']),
    );
  });

  it('preserva preposições em minúscula, menos na primeira palavra', () => {
    expect(nomeDaClasse('CUMPRIMENTO DE SENTENÇA')).toBe('Cumprimento de Sentença');
    expect(nomeDaClasse('EMBARGOS À EXECUÇÃO')).toBe('Embargos à Execução');
    expect(nomeDaClasse('BUSCA E APREENSÃO EM ALIENAÇÃO FIDUCIÁRIA')).toBe(
      'Busca e Apreensão em Alienação Fiduciária',
    );
    expect(nomeDaClasse('DO CONTRATO')).toBe('Do Contrato');
    expect(nomeDaClasse('Cumprimento De Sentença')).toBe('Cumprimento de Sentença');
  });

  it('mantém siglas conhecidas e numerais romanos em maiúsculas', () => {
    expect(nomeDaClasse('AÇÃO CONTRA O INSS')).toBe('Ação contra o INSS');
    expect(nomeDaClasse('LEVANTAMENTO DE FGTS')).toBe('Levantamento de FGTS');
    expect(nomeDaClasse('EXECUÇÃO FISCAL II')).toBe('Execução Fiscal II');
  });

  it('sigla desconhecida num texto bem escrito não é rebaixada', () => {
    expect(nomeDaClasse('Procedimento do JEF Cível')).toBe('Procedimento do JEF Cível');
  });

  it('não toca em grafia própria de palavra ("PJe")', () => {
    expect(nomeDaClasse('Petição PJe')).toBe('Petição PJe');
  });

  it('texto já normalizado volta igual (idempotente)', () => {
    for (const ok of [
      'Procedimento Comum Cível',
      'Execução de Título Extrajudicial',
      'Cumprimento de Sentença',
      'Ação contra o INSS',
    ]) {
      expect(nomeDaClasse(ok)).toBe(ok);
      expect(nomeDaClasse(nomeDaClasse(ok))).toBe(ok);
    }
    expect(nomeDaClasse(nomeDaClasse('AçãO TRABALHISTA'))).toBe('Ação Trabalhista');
  });

  it('vazio, nulo e não-texto devolvem "" — a tela escreve "—", nunca inventa classe', () => {
    for (const v of ['', '   ', null, undefined, 42, {}]) {
      expect(nomeDaClasse(v)).toBe('');
    }
  });

  it('apara e junta espaços repetidos', () => {
    expect(nomeDaClasse('  PROCEDIMENTO   COMUM  ')).toBe('Procedimento Comum');
  });

  it('texto longo passa inteiro, sem corte', () => {
    const longo = 'PROCEDIMENTO ESPECIAL '.repeat(200).trim();
    const saida = nomeDaClasse(longo);
    expect(saida.startsWith('Procedimento Especial Procedimento Especial')).toBe(true);
    expect(saida.split(' ')).toHaveLength(400);
  });

  it('emoji e símbolos ficam onde estão', () => {
    expect(nomeDaClasse('AÇÃO CIVIL ⚖️ PÚBLICA')).toBe('Ação Civil ⚖️ Pública');
    expect(nomeDaClasse('📁')).toBe('📁');
  });

  it('dígitos e pontuação não contam como letra para decidir a caixa', () => {
    expect(nomeDaClasse('RECURSO 123 (CÍVEL)')).toBe('Recurso 123 (Cível)');
  });
});
