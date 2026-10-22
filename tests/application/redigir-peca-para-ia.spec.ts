import { describe, expect, it } from 'vitest';
import {
  criarRedatorDePeca,
  redigirPecaParaIA,
} from '../../src/application/politicas/redigirPecaParaIA.js';

/* Tudo inventado: números e nomes de mentira. */

describe('redação acrescentada para peças (v0.53.0)', () => {
  it('CEP, com e sem rótulo', () => {
    // Sem "Residente na Rua…": desde a v0.55.0 o endereço é redigido por inteiro (e leva o CEP junto),
    // então o CEP é provado aqui sozinho, nas três formas.
    const r = redigirPecaParaIA('CEP 74000-123, e em 74.000-123; CEP: 74000123.');
    expect(r.texto).not.toMatch(/74\.?000-?123/);
    expect(r.texto).toContain('[CEP]');
    expect(r.substituicoes['CEP']).toBeGreaterThanOrEqual(2);
  });

  it('RG e CNH com rótulo; RG com a máscara de RG, mesmo sem rótulo', () => {
    const r = redigirPecaParaIA(
      'Portador do RG nº 1.234.567-X e da CNH 98765432100 expedida em Goiânia.',
    );
    expect(r.texto).not.toContain('1.234.567');
    expect(r.texto).not.toContain('98765432100');
    expect(r.substituicoes['IDENTIDADE']).toBe(1);
    // A CNH de 11 dígitos já cai na redação base (parece CPF): o número sai de qualquer jeito.
    expect(r.substituicoes['DOCUMENTO']).toBe(1);
    // v0.55.0: a máscara de RG (12.345.678-9) é redigida mesmo sem a palavra "RG"...
    expect(redigirPecaParaIA('o lote 1.234.567-8 foi entregue').texto).toBe(
      'o lote [IDENTIDADE] foi entregue',
    );
    // ...mas número solto SEM a máscara continua fora (vale o que está escrito em "não cobre").
    expect(redigirPecaParaIA('o lote 1234567 foi entregue').texto).toContain('1234567');
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

  it('endereço com tipo de via e "residente/domiciliado" é redigido (v0.55.0)', () => {
    const a = redigirPecaParaIA(
      'A autora, na Rua das Palmeiras, nº 120, Setor Central, Goiânia - GO, ajuíza.',
    );
    expect(a.texto).toContain('[ENDEREÇO]');
    expect(a.texto).not.toContain('Palmeiras');
    expect(a.texto).not.toContain('Setor Central');
    expect(a.substituicoes['ENDERECO']).toBe(1);
    const b = redigirPecaParaIA(
      'O réu, residente e domiciliado na Avenida Fictícia, bloco 4, requer.',
    );
    expect(b.texto).toContain('[ENDEREÇO]');
    expect(b.texto).not.toContain('Fictícia');
  });

  it('NÃO promete endereço sem tipo de via, ponto de referência nem nome de terceiro: ficam no texto', () => {
    const r = redigirPecaParaIA(
      'Mora no Setor Sul, em Goiânia, perto do Edifício Aurora. A testemunha Roberto Camargo Lima confirmou.',
    );
    expect(r.texto).toContain('Setor Sul');
    expect(r.texto).toContain('Edifício Aurora');
    expect(r.texto).toContain('Roberto Camargo Lima');
  });

  it('chave aleatória do Pix e cartão em 4 × 4 dígitos (v0.55.0)', () => {
    const r = redigirPecaParaIA(
      'Pix 3f2b8c1e-4a5d-4c7e-9f10-1a2b3c4d5e6f e cartão 4111 1111 1111 1111 usados.',
    );
    expect(r.texto).toContain('[CHAVE]');
    expect(r.texto).toContain('[CARTÃO]');
    expect(r.texto).not.toMatch(/4111|3f2b8c1e/);
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
