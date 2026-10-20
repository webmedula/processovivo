import { describe, expect, it } from 'vitest';
import {
  GRUPOS_DE_CUSTO,
  MAPA_DE_CATEGORIAS_ANTIGAS,
  SUBCATEGORIAS_BASE,
  codigoAtualDaCategoria,
  ehGrupoDeDeposito,
} from '../../src/domain/entities/CatalogoDeCustos.js';
import {
  LIMITE_DESCRICAO,
  LIMITE_MOTIVO,
  VALOR_MAXIMO_CENTAVOS,
  alterarCusto,
  calcularTotais,
  cancelarCusto,
  chaveDeUnicidadeDaCategoria,
  criarCusto,
  estaACobrar,
  nomeRepetidoNaBase,
  reativarCusto,
  validarDataDoGasto,
  validarDescricao,
  validarGrupo,
  validarMotivo,
  validarNomeDeCategoria,
  validarValor,
} from '../../src/domain/entities/Custo.js';
import type { Custo, ItemParaTotais } from '../../src/domain/entities/Custo.js';
import {
  diferencasDoCusto,
  diferencasDoRecebimento,
} from '../../src/domain/entities/HistoricoDeCustos.js';
import {
  alterarRecebimento,
  criarRecebimento,
  validarObservacao,
} from '../../src/domain/entities/Recebimento.js';
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
      categoria: 'CUS-020',
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

  it('despesa paga pelo cliente nunca é reembolsável: a caixa é desligada à força', () => {
    expect(um({ pagoPor: 'cliente', reembolsavel: true }).reembolsavel).toBe(false);
    expect(um({ pagoPor: 'escritorio', reembolsavel: true }).reembolsavel).toBe(true);
    // Sem dizer quem pagou, foi o escritório (é o que os lançamentos da 0.47.0 viram).
    expect(um().pagoPor).toBe('escritorio');
    const c = um();
    expect(alterarCusto(c, { pagoPor: 'cliente' }, new Date(), HOJE).reembolsavel).toBe(
      false,
    );
    expect(() => um({ pagoPor: 'banco' as never })).toThrow(CustoInvalidoError);
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

describe('catálogo em dois níveis', () => {
  it('tem os dez grupos do dono, com códigos permanentes, e nunca multas nem honorários', () => {
    expect(GRUPOS_DE_CUSTO.map((g) => g.codigo)).toEqual([
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
      '07',
      '08',
      '11',
      '12',
    ]);
    expect(GRUPOS_DE_CUSTO.find((g) => g.codigo === '08')?.nome).toBe(
      'Depósitos e garantias',
    );
    const nomes = GRUPOS_DE_CUSTO.map((g) => g.nome.toLowerCase()).join('|');
    expect(nomes).not.toContain('multa');
    expect(nomes).not.toContain('honor');
  });

  it('as subcategorias pré-cadastradas são as do dono, com código único e grupo existente', () => {
    expect(SUBCATEGORIAS_BASE).toHaveLength(45);
    const codigos = SUBCATEGORIAS_BASE.map((c) => c.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const c of SUBCATEGORIAS_BASE) {
      expect(GRUPOS_DE_CUSTO.some((g) => g.codigo === c.grupo)).toBe(true);
    }
    const por = (cod: string) => SUBCATEGORIAS_BASE.find((c) => c.codigo === cod);
    expect(por('CUS-020')).toMatchObject({
      nome: 'Outras custas judiciais',
      grupo: '01',
    });
    expect(por('DIL-010')).toMatchObject({ nome: 'Outras diligências', grupo: '03' });
    expect(por('DEP-006')).toMatchObject({ grupo: '08' });
    expect(por('OUT-002')).toMatchObject({ grupo: '12' });
    // Nunca se renumera: os códigos que o dono nomeou existem exatamente assim (com lacunas).
    expect(por('CUS-003')).toBeUndefined();
    expect(por('PER-009')).toBeDefined();
  });

  it('a natureza (depósito × despesa) sai SÓ do grupo 08', () => {
    expect(ehGrupoDeDeposito('08')).toBe(true);
    for (const g of GRUPOS_DE_CUSTO.filter((x) => x.codigo !== '08')) {
      expect(ehGrupoDeDeposito(g.codigo)).toBe(false);
    }
    expect(
      SUBCATEGORIAS_BASE.filter((c) => c.grupo === '08').map((c) => c.codigo),
    ).toEqual(['DEP-001', 'DEP-002', 'DEP-003', 'DEP-005', 'DEP-006']);
  });

  it('mapeia as sete categorias da 0.47.0 (Publicações vai para DIL-010)', () => {
    expect(MAPA_DE_CATEGORIAS_ANTIGAS).toEqual({
      custas: 'CUS-020',
      pericia: 'PER-001',
      diligencia: 'DIL-001',
      deslocamento: 'ADM-001',
      copias: 'ADM-004',
      publicacoes: 'DIL-010',
      outros: 'OUT-001',
    });
    for (const novo of Object.values(MAPA_DE_CATEGORIAS_ANTIGAS)) {
      expect(SUBCATEGORIAS_BASE.some((c) => c.codigo === novo)).toBe(true);
    }
    expect(codigoAtualDaCategoria('custas')).toBe('CUS-020');
    // Código novo e categoria própria passam como vieram.
    expect(codigoAtualDaCategoria('CUS-020')).toBe('CUS-020');
    expect(codigoAtualDaCategoria('c-abc')).toBe('c-abc');
  });

  it('o nome próprio tem 1 a 60 caracteres; a unicidade é DENTRO do grupo, sem acento nem caixa', () => {
    expect(validarNomeDeCategoria('  Cartório   do 2º ofício ')).toBe(
      'Cartório do 2º ofício',
    );
    expect(() => validarNomeDeCategoria('')).toThrow(CustoInvalidoError);
    expect(() => validarNomeDeCategoria('x'.repeat(61))).toThrow(CustoInvalidoError);
    expect(validarNomeDeCategoria('x'.repeat(60))).toHaveLength(60);
    // Repetir uma pré-cadastrada DO MESMO grupo é recusado (mesmo sem acento ou caixa)...
    for (const dup of ['Taxa judiciária', 'taxa judiciaria', ' TAXA   JUDICIÁRIA ']) {
      expect(nomeRepetidoNaBase('01', dup)).toBe(true);
    }
    // ...mas o mesmo nome em outro grupo é outra subcategoria.
    expect(nomeRepetidoNaBase('12', 'Taxa judiciária')).toBe(false);
    expect(chaveDeUnicidadeDaCategoria('01', 'Perícia X')).not.toBe(
      chaveDeUnicidadeDaCategoria('12', 'Perícia X'),
    );
    expect(chaveDeUnicidadeDaCategoria('12', 'Perícia X')).toBe(
      chaveDeUnicidadeDaCategoria('12', ' pericia   x'),
    );
  });

  it('o grupo da subcategoria própria é validado; sem grupo, cai em "Outras despesas" (12)', () => {
    expect(validarGrupo(undefined)).toBe('12');
    expect(validarGrupo('08')).toBe('08');
    for (const ruim of ['09', '10', '99', '', 8, null]) {
      expect(() => validarGrupo(ruim)).toThrow(CustoInvalidoError);
    }
  });
});

function item(extra: Partial<ItemParaTotais> = {}): ItemParaTotais {
  return {
    categoria: 'CUS-020',
    valorCentavos: 1_000,
    reembolsavel: true,
    pagoPor: 'escritorio',
    deposito: false,
    ...extra,
  };
}

describe('totais, saldo e crédito', () => {
  it('sem nada, tudo é zero', () => {
    const t = calcularTotais([], []);
    expect(t).toMatchObject({
      quantidade: 0,
      totalDespesasCentavos: 0,
      totalReembolsavelCentavos: 0,
      totalRecebidoCentavos: 0,
      saldoACobrarCentavos: 0,
      creditoDoClienteCentavos: 0,
    });
    expect(t.porCategoria).toEqual([]);
    expect(t.depositos.quantidade).toBe(0);
  });

  it('recebimento parcial: o saldo é reembolsável − recebido', () => {
    const t = calcularTotais(
      [item({ valorCentavos: 10_000 }), item({ valorCentavos: 25_050 })],
      [{ valorCentavos: 12_345 }],
    );
    expect(t.totalReembolsavelCentavos).toBe(35_050);
    expect(t.totalRecebidoCentavos).toBe(12_345);
    expect(t.saldoACobrarCentavos).toBe(22_705);
    expect(t.creditoDoClienteCentavos).toBe(0);
  });

  it('vários recebimentos somam; recebimento igual ao reembolsável zera o saldo sem crédito', () => {
    const t = calcularTotais(
      [item({ valorCentavos: 10_000 })],
      [{ valorCentavos: 3_333 }, { valorCentavos: 3_333 }, { valorCentavos: 3_334 }],
    );
    expect(t.totalRecebidoCentavos).toBe(10_000);
    expect(t.saldoACobrarCentavos).toBe(0);
    expect(t.creditoDoClienteCentavos).toBe(0);
  });

  it('recebimento maior que o reembolsável vira CRÉDITO do cliente, nunca saldo negativo', () => {
    const t = calcularTotais(
      [item({ valorCentavos: 10_000 })],
      [{ valorCentavos: 10_001 }],
    );
    expect(t.saldoACobrarCentavos).toBe(0);
    expect(t.creditoDoClienteCentavos).toBe(1);
    const semReembolsavel = calcularTotais(
      [item({ reembolsavel: false })],
      [{ valorCentavos: 500 }],
    );
    expect(semReembolsavel.saldoACobrarCentavos).toBe(0);
    expect(semReembolsavel.creditoDoClienteCentavos).toBe(500);
  });

  it('despesa paga pelo cliente conta nas despesas, mas não gera reembolsável nem saldo', () => {
    const t = calcularTotais(
      [
        item({ valorCentavos: 4_000 }),
        item({ valorCentavos: 6_000, reembolsavel: false }),
        item({ valorCentavos: 9_000, pagoPor: 'cliente', reembolsavel: true }),
      ],
      [],
    );
    expect(t.totalDespesasCentavos).toBe(19_000);
    expect(t.pagoPeloEscritorioCentavos).toBe(10_000);
    expect(t.pagoPeloClienteCentavos).toBe(9_000);
    expect(t.totalReembolsavelCentavos).toBe(4_000);
    expect(t.saldoACobrarCentavos).toBe(4_000);
  });

  it('depósitos e garantias ficam em bloco separado e fora do total de despesas e dos subtotais', () => {
    const t = calcularTotais(
      [
        item({ valorCentavos: 1_000 }),
        item({
          categoria: 'DEP-001',
          deposito: true,
          valorCentavos: 50_000,
          reembolsavel: true,
        }),
        item({
          categoria: 'DEP-003',
          deposito: true,
          valorCentavos: 7_000,
          reembolsavel: false,
        }),
        item({
          categoria: 'DEP-001',
          deposito: true,
          valorCentavos: 2_000,
          pagoPor: 'cliente',
        }),
      ],
      [],
    );
    expect(t.totalDespesasCentavos).toBe(1_000);
    expect(t.porCategoria.map((s) => s.categoria)).toEqual(['CUS-020']);
    expect(t.depositos).toMatchObject({
      quantidade: 3,
      totalCentavos: 59_000,
      pagoPeloEscritorioCentavos: 57_000,
      pagoPeloClienteCentavos: 2_000,
    });
    // O depósito adiantado e marcado "cobrar do cliente" ENTRA no saldo, identificado como depósito.
    expect(t.totalReembolsavelCentavos).toBe(51_000);
    expect(t.reembolsavelDeDepositosCentavos).toBe(50_000);
    expect(t.saldoACobrarCentavos).toBe(51_000);
  });

  it('soma em inteiros: dez lançamentos de R$ 0,10 dão exatamente R$ 1,00', () => {
    const dez = Array.from({ length: 10 }, () => item({ valorCentavos: 10 }));
    expect(calcularTotais(dez, []).totalDespesasCentavos).toBe(100);
    const recs = Array.from({ length: 3 }, () => ({ valorCentavos: 33 }));
    expect(calcularTotais(dez, recs).saldoACobrarCentavos).toBe(1);
  });

  it('subtotais por subcategoria, do maior para o menor, com desempate pelo código', () => {
    const t = calcularTotais(
      [
        item({ categoria: 'PER-001', valorCentavos: 500 }),
        item({ categoria: 'CUS-020', valorCentavos: 300 }),
        item({ categoria: 'CUS-020', valorCentavos: 300 }),
        item({ categoria: 'OUT-001', valorCentavos: 600 }),
      ],
      [],
    );
    expect(t.porCategoria).toEqual([
      { categoria: 'CUS-020', totalCentavos: 600, quantidade: 2 },
      { categoria: 'OUT-001', totalCentavos: 600, quantidade: 1 },
      { categoria: 'PER-001', totalCentavos: 500, quantidade: 1 },
    ]);
    expect(t.porCategoria.reduce((s, c) => s + c.totalCentavos, 0)).toBe(
      t.totalDespesasCentavos,
    );
  });

  it('a R$ 1 milhão por lançamento e 500 lançamentos, ainda é exato', () => {
    const muitos = Array.from({ length: 500 }, () =>
      item({ valorCentavos: VALOR_MAXIMO_CENTAVOS }),
    );
    expect(calcularTotais(muitos, []).totalDespesasCentavos).toBe(
      500 * VALOR_MAXIMO_CENTAVOS,
    );
  });

  it('"a cobrar" é reembolsável pago pelo escritório', () => {
    expect(estaACobrar(um())).toBe(true);
    expect(estaACobrar(um({ reembolsavel: false }))).toBe(false);
    expect(estaACobrar(um({ pagoPor: 'cliente' }))).toBe(false);
  });
});

describe('recebimentos do cliente', () => {
  const baseR = {
    id: 'r1',
    workspace: 'ws-a',
    numeroProcesso: BASE.numeroProcesso,
    criadoEm: BASE.criadoEm,
  };

  it('valida valor em centavos inteiros, data real e observação de até 200 caracteres', () => {
    const r = criarRecebimento(
      baseR,
      { data: '2026-10-10', valorCentavos: 5_050, observacao: '  Pix   parcial ' },
      HOJE,
    );
    expect(r).toMatchObject({ valorCentavos: 5_050, observacao: 'Pix parcial' });
    expect(Object.isFrozen(r)).toBe(true);
    for (const ruim of [0, -5, 1.5, VALOR_MAXIMO_CENTAVOS + 1]) {
      expect(() =>
        criarRecebimento(baseR, { data: '2026-10-10', valorCentavos: ruim }, HOJE),
      ).toThrow(CustoInvalidoError);
    }
    expect(() =>
      criarRecebimento(baseR, { data: '2026-02-30', valorCentavos: 100 }, HOJE),
    ).toThrow(CustoInvalidoError);
    expect(validarObservacao('x'.repeat(200))).toHaveLength(200);
    expect(() => validarObservacao('x'.repeat(201))).toThrow(CustoInvalidoError);
    expect(validarObservacao('   ')).toBeUndefined();
  });

  it('edita sem revalidar a data antiga e apaga a observação com null', () => {
    const r = criarRecebimento(
      baseR,
      { data: '2026-10-10', valorCentavos: 100, observacao: 'a' },
      HOJE,
    );
    const novo = alterarRecebimento(
      r,
      { valorCentavos: 200, observacao: null },
      new Date(),
      '2031-01-01',
    );
    expect(novo.valorCentavos).toBe(200);
    expect(novo.observacao).toBeUndefined();
    expect(novo.data).toBe('2026-10-10');
  });
});

describe('cancelar e reativar', () => {
  it('cancelar guarda o instante e o motivo; reativar devolve o lançamento sem apagar nada', () => {
    const c = um();
    const t0 = new Date('2026-10-21T10:00:00Z');
    const cancelado = cancelarCusto(c, '  Lançado   no processo errado ', t0);
    expect(cancelado.canceladoEm).toEqual(t0);
    expect(cancelado.motivoDoCancelamento).toBe('Lançado no processo errado');
    expect(cancelado.valorCentavos).toBe(c.valorCentavos);
    const de_novo = reativarCusto(cancelado, new Date('2026-10-22T10:00:00Z'));
    expect(de_novo.canceladoEm).toBeUndefined();
    expect(de_novo.motivoDoCancelamento).toBeUndefined();
    expect(de_novo.descricao).toBe(c.descricao);
    expect(cancelarCusto(c, undefined, t0).motivoDoCancelamento).toBeUndefined();
  });

  it('o motivo tem até 200 caracteres e é opcional', () => {
    expect(validarMotivo(undefined)).toBeUndefined();
    expect(validarMotivo('')).toBeUndefined();
    expect(validarMotivo('x'.repeat(LIMITE_MOTIVO))).toHaveLength(LIMITE_MOTIVO);
    expect(() => validarMotivo('x'.repeat(LIMITE_MOTIVO + 1))).toThrow(
      CustoInvalidoError,
    );
    expect(() => validarMotivo(12)).toThrow(CustoInvalidoError);
  });
});

describe('histórico: diferenças de uma edição', () => {
  it('registra valor, data, categoria, pago por e reembolsável com o anterior e o novo', () => {
    const antes = um();
    const depois = alterarCusto(
      antes,
      {
        valorCentavos: 20_000,
        data: '2026-10-02',
        categoria: 'PER-001',
        pagoPor: 'cliente',
        descricao: 'Outra descrição',
      },
      new Date(),
      HOJE,
    );
    const campos = diferencasDoCusto(antes, depois);
    expect(campos).toEqual([
      { campo: 'valor', de: '12345', para: '20000' },
      { campo: 'data', de: '2026-10-01', para: '2026-10-02' },
      { campo: 'categoria', de: 'CUS-020', para: 'PER-001' },
      { campo: 'pago_por', de: 'escritorio', para: 'cliente' },
      { campo: 'reembolsavel', de: 'sim', para: 'nao' },
      { campo: 'descricao' },
    ]);
  });

  it('a descrição e a observação mudam sem copiar o texto; sem mudança, nada é registrado', () => {
    const antes = um();
    const depois = alterarCusto(
      antes,
      { descricao: 'Texto novo secreto' },
      new Date(),
      HOJE,
    );
    const [c] = diferencasDoCusto(antes, depois);
    expect(JSON.stringify(c)).not.toContain('secreto');
    expect(diferencasDoCusto(antes, antes)).toEqual([]);
    const r1 = criarRecebimento(
      {
        id: 'r',
        workspace: 'w',
        numeroProcesso: BASE.numeroProcesso,
        criadoEm: new Date(),
      },
      { data: '2026-10-10', valorCentavos: 100, observacao: 'a' },
      HOJE,
    );
    const r2 = alterarRecebimento(r1, { observacao: 'b' }, new Date(), HOJE);
    expect(diferencasDoRecebimento(r1, r2)).toEqual([{ campo: 'observacao' }]);
  });
});
