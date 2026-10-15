import { describe, expect, it } from 'vitest';
import {
  criarRedator,
  redigirParaIA,
} from '../../src/application/politicas/redigirParaIA.js';

// Tudo inventado. Os números de processo têm dígito verificador válido.
const CNJ = '1000001-12.2025.8.09.0051';

describe('redigirParaIA — padrões estruturais', () => {
  it('troca o número CNJ, formatado ou corrido, por [PROCESSO]', () => {
    const r = redigirParaIA(`Autos ${CNJ} e também 10000011220258090051.`);
    expect(r.texto).toBe('Autos [PROCESSO] e também [PROCESSO].');
    expect(r.substituicoes.PROCESSO).toBe(2);
  });

  it('dá marcador numerado a processo diferente, e o mesmo marcador ao repetido', () => {
    const r = redigirParaIA(`${CNJ}; 1000002-44.2025.8.09.0100; ${CNJ}`);
    expect(r.texto).toBe('[PROCESSO]; [PROCESSO 2]; [PROCESSO]');
    expect(r.restaurar('veja [PROCESSO 2]')).toBe('veja 1000002-44.2025.8.09.0100');
  });

  it.each([
    ['CPF formatado', 'CPF 000.000.001-91 consta', 'CPF [DOCUMENTO] consta'],
    ['CPF mascarado pela fonte', 'CPF ***.456.789-** consta', 'CPF [DOCUMENTO] consta'],
    ['CPF só dígitos', 'CPF 00000000191 consta', 'CPF [DOCUMENTO] consta'],
    ['CNPJ formatado', 'CNPJ 00.000.000/0001-91 consta', 'CNPJ [DOCUMENTO] consta'],
    ['CNPJ só dígitos', 'CNPJ 00000000000191 consta', 'CNPJ [DOCUMENTO] consta'],
  ])('%s vira [DOCUMENTO]', (_nome, entrada, esperado) => {
    expect(redigirParaIA(entrada).texto).toBe(esperado);
  });

  it.each([
    [
      'e-mail',
      'escreva a fulano.fake+x@exemplo.invalid hoje',
      'escreva a [CONTATO] hoje',
    ],
    [
      'telefone com DDD entre parênteses',
      'ligue (62) 99999-0000 hoje',
      'ligue [CONTATO] hoje',
    ],
    ['telefone com +55', 'ligue +55 62 99999-0000 hoje', 'ligue [CONTATO] hoje'],
    ['telefone sem DDD', 'ligue 3000-0000 hoje', 'ligue [CONTATO] hoje'],
  ])('%s vira [CONTATO]', (_nome, entrada, esperado) => {
    expect(redigirParaIA(entrada).texto).toBe(esperado);
  });

  it.each([
    ['OAB/UF número', 'Dr. (OAB/GO 90001) pede', 'Dr. ([OAB]) pede'],
    ['OAB número/UF', 'Dr. OAB 90001/GO pede', 'Dr. [OAB] pede'],
    ['OAB com ponto e nº', 'Dr. OAB/SP nº 123.456 pede', 'Dr. [OAB] pede'],
    ['inscrição nua do DJEN', 'advogado 47383/GO intimado', 'advogado [OAB] intimado'],
  ])('%s vira [OAB]', (_nome, entrada, esperado) => {
    expect(redigirParaIA(entrada).texto).toBe(esperado);
  });

  it('não mexe em prazo, data nem valor em dinheiro', () => {
    const texto =
      'No prazo de 15 (quinze) dias, até 10/11/2026, valor de R$ 12.500,00, art. 523.';
    const r = redigirParaIA(texto);
    expect(r.texto).toBe(texto);
    expect(Object.values(r.substituicoes).every((n) => n === 0)).toBe(true);
  });

  it('devolve o texto intacto quando não há nada a redigir', () => {
    const texto = 'Aguarde-se o decurso do prazo.';
    expect(redigirParaIA(texto).texto).toBe(texto);
  });
});

describe('redigirParaIA — nomes do retrato', () => {
  const pessoas = {
    partes: [
      {
        nome: 'Horácio Brandão Teixeira',
        pessoaFisica: true,
        advogados: [{ nome: 'Lívia Carvalhais Mota' }],
      },
      { nome: 'Comercial Rio Verde Ltda', pessoaFisica: false },
    ],
    advogados: [{ nome: 'Tiago Nogueira Pimentel' }],
  };

  it('numera as partes e os advogados pela ordem do retrato, não do texto', () => {
    const r = redigirParaIA(
      'Tiago Nogueira Pimentel e Comercial Rio Verde Ltda e Horácio Brandão Teixeira e Lívia Carvalhais Mota',
      pessoas,
    );
    expect(r.texto).toBe('[ADVOGADO B] e [PARTE B] e [PARTE A] e [ADVOGADO A]');
  });

  it('casa sem diferença de caixa nem de acento', () => {
    const r = redigirParaIA('HORACIO BRANDAO TEIXEIRA foi intimado', pessoas);
    expect(r.texto).toBe('[PARTE A] foi intimado');
  });

  it('nome parcial: primeiro + último nome e nome isolado de pessoa física', () => {
    expect(redigirParaIA('Horácio Teixeira apresentou', pessoas).texto).toBe(
      '[PARTE A] apresentou',
    );
    expect(redigirParaIA('o autor Brandão apresentou', pessoas).texto).toBe(
      'o autor [PARTE A] apresentou',
    );
  });

  it('dois pedaços do mesmo nome seguidos viram UM marcador', () => {
    expect(redigirParaIA('Lívia Mota e Lívia Carvalhais', pessoas).texto).toBe(
      '[ADVOGADO A] e [ADVOGADO A]',
    );
  });

  it('pessoa jurídica: o nome inteiro é redigido, palavra genérica solta não', () => {
    const r = redigirParaIA(
      'O Comercial Rio Verde Ltda pagou no comércio local',
      pessoas,
    );
    expect(r.texto).toBe('O [PARTE B] pagou no comércio local');
  });

  it('não confunde palavra que contém o nome como pedaço', () => {
    const p = { partes: [{ nome: 'Rosa Dias Lima', pessoaFisica: true }] };
    expect(redigirParaIA('Diaspora e Limatao', p).texto).toBe('Diaspora e Limatao');
  });

  it('o marcador de uma pessoa não é re-redigido pelo nome de outra (uma passada só)', () => {
    const p = {
      partes: [
        { nome: 'Parte Autora Silva', pessoaFisica: true },
        { nome: 'Joana Silva', pessoaFisica: true },
      ],
    };
    const r = redigirParaIA('Joana Silva e Parte Autora Silva', p);
    expect(r.texto).toBe('[PARTE B] e [PARTE A]');
  });

  it('restaurar devolve o nome do retrato no lugar do marcador', () => {
    const r = redigirParaIA('Horácio Teixeira foi intimado', pessoas);
    expect(r.restaurar('[PARTE A] deve se manifestar')).toBe(
      'Horácio Brandão Teixeira deve se manifestar',
    );
  });

  it('o mesmo redator mantém marcadores iguais entre textos (ato e títulos)', () => {
    const redator = criarRedator(pessoas);
    const a = redator.redigir(`Processo ${CNJ} Horácio Brandão Teixeira`);
    const b = redator.redigir(`Juntada em ${CNJ} por Horácio Brandão Teixeira`);
    expect(a.texto).toBe('Processo [PROCESSO] [PARTE A]');
    expect(b.texto).toBe('Juntada em [PROCESSO] por [PARTE A]');
  });
});
