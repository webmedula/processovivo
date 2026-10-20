import { describe, expect, it } from 'vitest';
import {
  CATEGORIAS_BASE,
  LIMITE_DESCRICAO,
  VALOR_MAXIMO_CENTAVOS,
  alterarCusto,
  calcularTotais,
  criarCusto,
  estaACobrar,
  validarDataDoGasto,
  validarDescricao,
  validarNomeDeCategoria,
  validarValor,
} from '../../src/domain/entities/Custo.js';
import type { Custo } from '../../src/domain/entities/Custo.js';
import {
  campoDeCentavos,
  centavosDeTexto,
  reaisDeCentavos,
} from '../../src/domain/entities/valorEmReais.js';
import { CustoInvalidoError } from '../../src/domain/errors/index.js';

/* Valores, descrições e nomes sintéticos. */

const HOJE = '2026-10-20';
const BASE = {
  id: 'c1',
  workspace: 'ws-a',
  numeroProcesso: '12345674720238260100',
  criadoEm: new Date('2026-10-20T12:00:00Z'),
};

function um(extra: Partial<Parameters<typeof criarCusto>[1]> = {}): Custo {
  return criarCusto(
    BASE,
    {
      data: '2026-10-01',
      descricao: 'Guia de custas',
      categoria: 'custas',
      valorCentavos: 12_345,
      reembolsavel: true,
      ...extra,
    },
    HOJE,
  );
}

describe('valor em reais ⇄ centavos', () => {
  it.each([
    ['1.234,56', 123_456],
    ['1234,56', 123_456],
    ['0,01', 1],
    ['0,5', 50],
    ['1234', 123_400],
    ['1.234', 123_400],
    ['R$ 1.234,56', 123_456],
    ['  10,00 ', 1_000],
    ['0', 0],
    ['0,00', 0],
    ['1.000.000,00', 100_000_000],
  ])('lê %s como %i centavos', (texto, centavos) => {
    expect(centavosDeTexto(texto)).toBe(centavos);
  });

  it.each([
    '',
    ' ',
    'abc',
    'NaN',
    'Infinity',
    '-5,00',
    '+5,00',
    '1e3',
    '1234.56',
    '12.34',
    '1,234',
    '1,2,3',
    '1.2345,00',
    '9999999999999,00',
    'R$',
  ])('recusa "%s" (não é um valor)', (texto) => {
    expect(centavosDeTexto(texto)).toBeNull();
  });

  it('recusa o que não é texto', () => {
    expect(centavosDeTexto(undefined)).toBeNull();
    expect(centavosDeTexto(null)).toBeNull();
    expect(centavosDeTexto(12.5)).toBeNull();
    expect(centavosDeTexto(Number.NaN)).toBeNull();
  });

  it('nunca perde precisão: valores em que o ponto flutuante erraria', () => {
    // 0,1 + 0,2 e 1,15 * 100 são os clássicos que erram em `number`.
    expect(centavosDeTexto('0,10')! + centavosDeTexto('0,20')!).toBe(30);
    expect(centavosDeTexto('1,15')).toBe(115);
    expect(centavosDeTexto('4,35')).toBe(435);
    expect(centavosDeTexto('8,20')).toBe(820);
  });

  it('formata em reais e devolve o campo de edição', () => {
    expect(reaisDeCentavos(123_456)).toBe('R$ 1.234,56');
    expect(reaisDeCentavos(1)).toBe('R$ 0,01');
    expect(reaisDeCentavos(0)).toBe('R$ 0,00');
    expect(reaisDeCentavos(100_000_000)).toBe('R$ 1.000.000,00');
    expect(campoDeCentavos(123_456)).toBe('1234,56');
    expect(campoDeCentavos(5)).toBe('0,05');
    expect(centavosDeTexto(campoDeCentavos(98_765))).toBe(98_765);
  });
});

describe('validação do lançamento', () => {
  it('o valor é inteiro, maior que zero e tem teto', () => {
    expect(validarValor(1)).toBe(1);
    expect(validarValor(VALOR_MAXIMO_CENTAVOS)).toBe(VALOR_MAXIMO_CENTAVOS);
    for (const ruim of [
      0,
      -1,
      VALOR_MAXIMO_CENTAVOS + 1,
      1.5,
      Number.NaN,
      Infinity,
      '10',
      null,
    ]) {
      expect(() => validarValor(ruim)).toThrow(CustoInvalidoError);
    }
  });

  it('a descrição é obrigatória e tem 200 caracteres no máximo', () => {
    expect(validarDescricao('  Cópias   do processo ')).toBe('Cópias do processo');
    expect(validarDescricao('x'.repeat(LIMITE_DESCRICAO))).toHaveLength(LIMITE_DESCRICAO);
    expect(() => validarDescricao('')).toThrow(CustoInvalidoError);
    expect(() => validarDescricao('   ')).toThrow(CustoInvalidoError);
    expect(() => validarDescricao('x'.repeat(LIMITE_DESCRICAO + 1))).toThrow(
      CustoInvalidoError,
    );
    expect(() => validarDescricao(undefined)).toThrow(CustoInvalidoError);
  });

  it('a data precisa existir no calendário e não pode estar longe no futuro', () => {
    expect(validarDataDoGasto('2026-02-28', HOJE)).toBe('2026-02-28');
    expect(validarDataDoGasto('2028-02-29', '2028-02-29')).toBe('2028-02-29');
    for (const ruim of [
      '2026-02-30',
      '2026-13-01',
      '20/10/2026',
      '',
      'hoje',
      '1999-12-31',
      '2028-10-20',
    ]) {
      expect(() => validarDataDoGasto(ruim, HOJE)).toThrow(CustoInvalidoError);
    }
    expect(() => validarDataDoGasto(null, HOJE)).toThrow(CustoInvalidoError);
  });

  it('as mensagens de erro não repetem o valor nem o texto recebido', () => {
    try {
      validarDescricao('x'.repeat(500));
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('xxxx');
    }
  });

  it('o ressarcimento só existe em lançamento reembolsável', () => {
    expect(um({ ressarcidoEm: '2026-10-10' }).ressarcidoEm).toBe('2026-10-10');
    expect(
      um({ reembolsavel: false, ressarcidoEm: '2026-10-10' }).ressarcidoEm,
    ).toBeUndefined();
  });

  it('desmarcar "cobrar do cliente" apaga o ressarcimento', () => {
    const c = um({ ressarcidoEm: '2026-10-10' });
    const alterado = alterarCusto(c, { reembolsavel: false }, new Date(), HOJE);
    expect(alterado.reembolsavel).toBe(false);
    expect(alterado.ressarcidoEm).toBeUndefined();
  });

  it('o lançamento é imutável: alterar devolve outra instância', () => {
    const c = um();
    const novo = alterarCusto(
      c,
      { descricao: 'Outra' },
      new Date('2026-10-21T00:00:00Z'),
      HOJE,
    );
    expect(Object.isFrozen(c)).toBe(true);
    expect(c.descricao).toBe('Guia de custas');
    expect(novo.descricao).toBe('Outra');
    expect(novo.criadoEm).toEqual(c.criadoEm);
  });

  it('uma data antiga já gravada não é revalidada ao editar só a descrição', () => {
    const c = um({ data: '2026-10-01' });
    expect(alterarCusto(c, { descricao: 'Ajuste' }, new Date(), '2030-01-01').data).toBe(
      '2026-10-01',
    );
  });
});

describe('categorias', () => {
  it('a lista base tem as sete categorias do dono, na ordem', () => {
    expect(CATEGORIAS_BASE.map((c) => c.nome)).toEqual([
      'Custas judiciais',
      'Perícia',
      'Diligência',
      'Deslocamento',
      'Cópias e impressões',
      'Publicações',
      'Outros',
    ]);
  });

  it('o nome próprio tem 1 a 40 caracteres e não duplica a lista base (nem sem acento ou caixa)', () => {
    expect(validarNomeDeCategoria('  Cartório   do 2º ofício ')).toBe(
      'Cartório do 2º ofício',
    );
    expect(() => validarNomeDeCategoria('')).toThrow(CustoInvalidoError);
    expect(() => validarNomeDeCategoria('x'.repeat(41))).toThrow(CustoInvalidoError);
    expect(validarNomeDeCategoria('x'.repeat(40))).toHaveLength(40);
    for (const dup of [
      'Perícia',
      'pericia',
      ' PERÍCIA ',
      'custas JUDICIAIS',
      'outros',
      'Copias e impressoes',
    ]) {
      expect(() => validarNomeDeCategoria(dup)).toThrow(CustoInvalidoError);
    }
  });
});

describe('totais e subtotais', () => {
  it('sem lançamentos, tudo é zero', () => {
    const t = calcularTotais([]);
    expect(t).toMatchObject({
      quantidade: 0,
      totalGastoCentavos: 0,
      totalReembolsavelCentavos: 0,
      totalRessarcidoCentavos: 0,
      saldoACobrarCentavos: 0,
    });
    expect(t.porCategoria).toEqual([]);
  });

  it('gasto, reembolsável, ressarcido e saldo, com ressarcimento parcial', () => {
    const t = calcularTotais([
      um({ valorCentavos: 10_000, reembolsavel: true, ressarcidoEm: '2026-10-05' }),
      um({ valorCentavos: 25_050, reembolsavel: true }),
      um({ valorCentavos: 4_999, reembolsavel: false, categoria: 'outros' }),
      um({ valorCentavos: 1, reembolsavel: true, categoria: 'pericia' }),
    ]);
    expect(t.totalGastoCentavos).toBe(40_050);
    expect(t.totalReembolsavelCentavos).toBe(35_051);
    expect(t.totalRessarcidoCentavos).toBe(10_000);
    expect(t.saldoACobrarCentavos).toBe(25_051);
    expect(t.saldoACobrarCentavos).toBe(
      t.totalReembolsavelCentavos - t.totalRessarcidoCentavos,
    );
  });

  it('soma em inteiros: dez lançamentos de R$ 0,10 dão exatamente R$ 1,00', () => {
    const dez = Array.from({ length: 10 }, () => um({ valorCentavos: 10 }));
    expect(calcularTotais(dez).totalGastoCentavos).toBe(100);
  });

  it('subtotais por categoria, do maior para o menor, com desempate pelo código', () => {
    const t = calcularTotais([
      um({ categoria: 'pericia', valorCentavos: 500 }),
      um({ categoria: 'custas', valorCentavos: 300 }),
      um({ categoria: 'custas', valorCentavos: 300 }),
      um({ categoria: 'outros', valorCentavos: 600 }),
    ]);
    expect(t.porCategoria).toEqual([
      { categoria: 'custas', totalCentavos: 600, quantidade: 2 },
      { categoria: 'outros', totalCentavos: 600, quantidade: 1 },
      { categoria: 'pericia', totalCentavos: 500, quantidade: 1 },
    ]);
    expect(t.porCategoria.reduce((s, c) => s + c.totalCentavos, 0)).toBe(
      t.totalGastoCentavos,
    );
  });

  it('a mais de R$ 1 milhão por lançamento e 500 lançamentos, ainda é exato', () => {
    const muitos = Array.from({ length: 500 }, () =>
      um({ valorCentavos: VALOR_MAXIMO_CENTAVOS }),
    );
    expect(calcularTotais(muitos).totalGastoCentavos).toBe(500 * VALOR_MAXIMO_CENTAVOS);
  });

  it('a conta é de quem não está ressarcido: "a cobrar" = reembolsável sem data', () => {
    expect(estaACobrar(um())).toBe(true);
    expect(estaACobrar(um({ ressarcidoEm: '2026-10-05' }))).toBe(false);
    expect(estaACobrar(um({ reembolsavel: false }))).toBe(false);
  });
});
