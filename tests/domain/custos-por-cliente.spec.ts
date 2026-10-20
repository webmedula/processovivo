import { describe, expect, it } from 'vitest';
import { calcularTotais } from '../../src/domain/entities/Custo.js';
import type { ItemParaTotais } from '../../src/domain/entities/Custo.js';
import {
  SEM_CLIENTE,
  chaveDoCliente,
  somarTotais,
} from '../../src/domain/entities/CustosPorCliente.js';

const item = (v: number, extra: Partial<ItemParaTotais> = {}): ItemParaTotais => ({
  categoria: 'CUS-020',
  valorCentavos: v,
  reembolsavel: true,
  pagoPor: 'escritorio',
  deposito: false,
  ...extra,
});

describe('chave do cliente', () => {
  it('o mesmo cliente com grafias diferentes cai no mesmo grupo (acento, caixa e espaços)', () => {
    expect(chaveDoCliente('Grupo Lume')).toBe(chaveDoCliente('  grupo   LUME '));
    expect(chaveDoCliente('Ação & Cia')).toBe(chaveDoCliente('acao & cia'));
  });

  it('rótulo ausente ou em branco é "Sem cliente"', () => {
    for (const v of [undefined, '', '   ']) expect(chaveDoCliente(v)).toBe(SEM_CLIENTE);
  });
});

describe('soma dos totais de vários processos', () => {
  it('soma só inteiros e mantém saldo e crédito POR PROCESSO (crédito de um não abate o saldo de outro)', () => {
    const a = calcularTotais([item(10_000)], [{ valorCentavos: 12_000 }]); // crédito 2.000
    const b = calcularTotais([item(5_000)], [{ valorCentavos: 1_000 }]); // saldo 4.000
    const s = somarTotais([a, b]);
    expect(s.processos).toBe(2);
    expect(s.totalDespesasCentavos).toBe(15_000);
    expect(s.totalRecebidoCentavos).toBe(13_000);
    expect(s.saldoACobrarCentavos).toBe(4_000);
    expect(s.creditoDoClienteCentavos).toBe(2_000);
  });

  it('depósitos ficam fora das despesas e dentro do bloco próprio; pago pelo cliente não entra no reembolsável', () => {
    const a = calcularTotais(
      [
        item(1_000),
        item(50_000, { categoria: 'DEP-001', deposito: true }),
        item(700, { pagoPor: 'cliente' }),
      ],
      [],
    );
    const s = somarTotais([a, a]);
    expect(s.totalDespesasCentavos).toBe(3_400);
    expect(s.depositosCentavos).toBe(100_000);
    expect(s.reembolsavelDeDepositosCentavos).toBe(100_000);
    expect(s.pagoPeloClienteCentavos).toBe(1_400);
    expect(s.saldoACobrarCentavos).toBe(102_000);
  });

  it('lista vazia soma zero', () => {
    expect(somarTotais([])).toMatchObject({
      processos: 0,
      saldoACobrarCentavos: 0,
      totalDespesasCentavos: 0,
    });
  });
});
