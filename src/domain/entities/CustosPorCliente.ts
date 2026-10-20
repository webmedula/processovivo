import { chaveDoNomeDeCategoria } from './Custo.js';
import type { TotaisDeCusto } from './Custo.js';

/**
 * Custos por cliente (v0.49.0). O "cliente" é o RÓTULO que o advogado deu à pasta do processo
 * (`acompanhamentos.cliente`), e só existe para processo ACOMPANHADO. Processo sem rótulo — ou que
 * deixou de ser acompanhado, porque o rótulo vive na pasta — cai em "Sem cliente". Os custos
 * continuam todos lá: o que se perde é só o agrupamento.
 */
export const SEM_CLIENTE = '~sem-cliente';
export const NOME_SEM_CLIENTE = 'Sem cliente';

/**
 * A chave de agrupamento: o mesmo texto sem acento, sem caixa e com espaços colapsados, para
 * "Grupo Lume" e "grupo  lume" serem o mesmo cliente. Rótulo vazio é "Sem cliente".
 */
export function chaveDoCliente(rotulo: string | undefined): string {
  const t = (rotulo ?? '').trim();
  return t ? chaveDoNomeDeCategoria(t) : SEM_CLIENTE;
}

/** Os totais de um conjunto de processos (um cliente, ou o consolidado de um relatório). */
export interface ResumoDeTotais {
  readonly processos: number;
  readonly totalDespesasCentavos: number;
  readonly pagoPeloEscritorioCentavos: number;
  readonly pagoPeloClienteCentavos: number;
  readonly totalReembolsavelCentavos: number;
  readonly reembolsavelDeDepositosCentavos: number;
  readonly depositosCentavos: number;
  readonly totalRecebidoCentavos: number;
  /** Soma dos saldos de CADA processo: recebimento é por processo, e crédito num não abate outro. */
  readonly saldoACobrarCentavos: number;
  readonly creditoDoClienteCentavos: number;
}

export function resumirTotais(t: TotaisDeCusto): Omit<ResumoDeTotais, 'processos'> {
  return {
    totalDespesasCentavos: t.totalDespesasCentavos,
    pagoPeloEscritorioCentavos: t.pagoPeloEscritorioCentavos,
    pagoPeloClienteCentavos: t.pagoPeloClienteCentavos,
    totalReembolsavelCentavos: t.totalReembolsavelCentavos,
    reembolsavelDeDepositosCentavos: t.reembolsavelDeDepositosCentavos,
    depositosCentavos: t.depositos.totalCentavos,
    totalRecebidoCentavos: t.totalRecebidoCentavos,
    saldoACobrarCentavos: t.saldoACobrarCentavos,
    creditoDoClienteCentavos: t.creditoDoClienteCentavos,
  };
}

/**
 * Soma totais JÁ CALCULADOS por `calcularTotais` (um por processo). Só soma inteiros: nenhuma regra
 * de saldo ou crédito é refeita aqui — cada processo traz o seu.
 */
export function somarTotais(lista: readonly TotaisDeCusto[]): ResumoDeTotais {
  const r = {
    processos: lista.length,
    totalDespesasCentavos: 0,
    pagoPeloEscritorioCentavos: 0,
    pagoPeloClienteCentavos: 0,
    totalReembolsavelCentavos: 0,
    reembolsavelDeDepositosCentavos: 0,
    depositosCentavos: 0,
    totalRecebidoCentavos: 0,
    saldoACobrarCentavos: 0,
    creditoDoClienteCentavos: 0,
  };
  for (const t of lista) {
    const x = resumirTotais(t);
    r.totalDespesasCentavos += x.totalDespesasCentavos;
    r.pagoPeloEscritorioCentavos += x.pagoPeloEscritorioCentavos;
    r.pagoPeloClienteCentavos += x.pagoPeloClienteCentavos;
    r.totalReembolsavelCentavos += x.totalReembolsavelCentavos;
    r.reembolsavelDeDepositosCentavos += x.reembolsavelDeDepositosCentavos;
    r.depositosCentavos += x.depositosCentavos;
    r.totalRecebidoCentavos += x.totalRecebidoCentavos;
    r.saldoACobrarCentavos += x.saldoACobrarCentavos;
    r.creditoDoClienteCentavos += x.creditoDoClienteCentavos;
  }
  return Object.freeze(r);
}
