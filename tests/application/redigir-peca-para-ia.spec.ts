import { describe, expect, it } from 'vitest';
import {
  criarRedatorDePeca,
  redigirPecaParaIA,
} from '../../src/application/politicas/redigirPecaParaIA.js';

/* Tudo inventado: números e nomes de mentira. */

describe('redação acrescentada para peças (v0.53.0)', () => {
  it('CEP, com e sem rótulo', () => {
    const r = redigirPecaParaIA(
      'Residente na Rua das Flores, 10, CEP 74000-123, e em 74.000-123; CEP: 74000123.',
    );
    expect(r.texto).not.toMatch(/74\.?000-?123/);
    expect(r.texto).toContain('[CEP]');
    expect(r.substituicoes['CEP']).toBeGreaterThanOrEqual(2);
  });

  it('RG e CNH só com rótulo', () => {
    const r = redigirPecaParaIA(
      'Portador do RG nº 1.234.567-X e da CNH 98765432100 expedida em Goiânia.',
    );
    expect(r.texto).not.toContain('1.234.567');
    expect(r.texto).not.toContain('98765432100');
    expect(r.substituicoes['IDENTIDADE']).toBe(1);
    // A CNH de 11 dígitos já cai na redação base (parece CPF): o número sai de qualquer jeito.
    expect(r.substituicoes['DOCUMENTO']).toBe(1);
    // Número solto, sem rótulo, não é redigido: vale o que está escrito em "não cobre".
    expect(redigirPecaParaIA('o lote 1.234.567-8 foi entregue').texto).toContain(
      '1.234.567-8',
    );
  });

  it('data de nascimento só junto de "nascido/nascimento"', () => {
    const r = redigirPecaParaIA(
      'A autora, nascida em 12/03/1980, e o réu, data de nascimento 5 de maio de 1975, comparecem.',
    );
    expect(r.texto).not.toContain('1980');
    expect(r.texto).not.toContain('1975');
    expect(r.substituicoes['NASCIMENTO']).toBe(2);
    // Data de fato processual não é redigida.
    expect(redigirPecaParaIA('O contrato foi firmado em 12/03/2024.').texto).toContain(
      '12/03/2024',
    );
  });

  it('conta e agência com rótulo', () => {
    const r = redigirPecaParaIA(
      'Depósito na agência 1234, conta corrente 56789-0, e na c/c 11122-3.',
    );
    expect(r.texto).not.toMatch(/1234|56789|11122/);
    expect(r.substituicoes['CONTA']).toBeGreaterThanOrEqual(2);
  });

  it('mantém a redação base (CPF, e-mail, OAB, nome do retrato) e usa o mesmo marcador para o mesmo nome', () => {
    const redator = criarRedatorDePeca({
      partes: [{ nome: 'Marina Albuquerque Sousa', pessoaFisica: true }],
    });
    const p1 = redator.redigir(
      'Marina Albuquerque Sousa, CPF 123.456.789-09, e-mail marina@exemplo.test, CEP 74000-123.',
    );
    const p2 = redator.redigir('Marina Albuquerque Sousa, nascida em 01/02/1990.');
    expect(p1.texto).toContain('[PARTE A]');
    expect(p2.texto).toContain('[PARTE A]');
    expect(p1.texto).not.toMatch(/123\.456\.789|marina@exemplo|74000/);
    expect(p2.texto).not.toContain('1990');
    expect(p1.substituicoes['DOCUMENTO']).toBe(1);
    expect(p1.substituicoes['CONTATO']).toBe(1);
  });

  it('NÃO promete endereço nem nome de terceiro: ficam no texto', () => {
    const r = redigirPecaParaIA(
      'Reside na Rua das Palmeiras, quadra 5, Setor Central, Goiânia. A testemunha Roberto Camargo Lima confirmou.',
    );
    expect(r.texto).toContain('Rua das Palmeiras');
    expect(r.texto).toContain('Roberto Camargo Lima');
  });

  it('é função pura: o mesmo texto dá o mesmo resultado e a entrada não muda', () => {
    const entrada = 'CEP 74000-123 e nascido em 01/01/1970.';
    const a = redigirPecaParaIA(entrada);
    const b = redigirPecaParaIA(entrada);
    expect(a).toEqual(b);
    expect(entrada).toBe('CEP 74000-123 e nascido em 01/01/1970.');
  });

  it('a redação do ato em produção NÃO ganhou os padrões novos', async () => {
    const { redigirParaIA } =
      await import('../../src/application/politicas/redigirParaIA.js');
    expect(redigirParaIA('CEP 74000-123, nascido em 01/01/1970.').texto).toContain(
      '74000-123',
    );
  });
});
