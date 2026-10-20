import { codigoAtualDaCategoria } from '../../domain/entities/CatalogoDeCustos.js';
import { calcularTotais } from '../../domain/entities/Custo.js';
import type {
  Custo,
  ItemParaTotais,
  TotaisDeCusto,
} from '../../domain/entities/Custo.js';
import { dataBrasileira } from '../../domain/entities/EventoDeCalendario.js';
import type { ResumoDeTotais } from '../../domain/entities/CustosPorCliente.js';
import { resumirTotais } from '../../domain/entities/CustosPorCliente.js';
import type { Recebimento } from '../../domain/entities/Recebimento.js';
import { reaisDeCentavos } from '../../domain/entities/valorEmReais.js';
import type {
  LinhaDaPrestacao,
  RecebimentoDaPrestacao,
  SubtotalDaPrestacao,
  TotalDaPrestacao,
} from '../../domain/ports/GeradorDePrestacaoDeContas.js';
import type { CategoriaParaTela } from './ServicoCustos.js';

/** O que vai de um processo para o PDF — o mesmo desenho serve ao PDF por processo e ao consolidado. */
export interface SecaoDaPrestacao {
  readonly linhas: readonly LinhaDaPrestacao[];
  readonly depositos: readonly LinhaDaPrestacao[];
  readonly recebimentos: readonly RecebimentoDaPrestacao[];
  readonly subtotais: readonly SubtotalDaPrestacao[];
  readonly totais: readonly TotalDaPrestacao[];
  readonly resultado: TotaisDeCusto;
}

export function itensParaTotais(
  custos: readonly Custo[],
  categorias: readonly CategoriaParaTela[],
): ItemParaTotais[] {
  const porCodigo = new Map(categorias.map((c) => [c.codigo, c]));
  return custos.map((c) => {
    const codigo = codigoAtualDaCategoria(c.categoria);
    return {
      categoria: codigo,
      valorCentavos: c.valorCentavos,
      reembolsavel: c.reembolsavel,
      pagoPor: c.pagoPor,
      deposito: porCodigo.get(codigo)?.deposito === true,
    };
  });
}

export function nomeCompletoDaCategoria(
  categorias: readonly CategoriaParaTela[],
  codigo: string,
): string {
  const atual = codigoAtualDaCategoria(codigo);
  return (
    categorias.find((c) => c.codigo === atual)?.nomeCompleto ??
    'Categoria não identificada'
  );
}

export function situacaoDoLancamento(c: Pick<Custo, 'pagoPor' | 'reembolsavel'>): string {
  return c.pagoPor === 'cliente'
    ? 'Pago pelo cliente'
    : c.reembolsavel
      ? 'Pago pelo escritório · a cobrar do cliente'
      : 'Pago pelo escritório · não cobrado';
}

/** O quadro de totais (texto pronto), na ordem do PDF. */
export function linhasDeTotais(t: Omit<ResumoDeTotais, 'processos'>): TotalDaPrestacao[] {
  const m = reaisDeCentavos;
  return [
    { rotulo: 'Total de despesas', valor: m(t.totalDespesasCentavos) },
    { rotulo: 'Pago pelo escritório', valor: m(t.pagoPeloEscritorioCentavos) },
    { rotulo: 'Pago diretamente pelo cliente', valor: m(t.pagoPeloClienteCentavos) },
    {
      rotulo: 'Total a cobrar do cliente (reembolsável)',
      valor: m(t.totalReembolsavelCentavos),
    },
    ...(t.reembolsavelDeDepositosCentavos > 0
      ? [
          {
            rotulo: 'dos quais depósitos e garantias',
            valor: m(t.reembolsavelDeDepositosCentavos),
            recuado: true,
          },
        ]
      : []),
    { rotulo: 'Total recebido do cliente', valor: m(t.totalRecebidoCentavos) },
    { rotulo: 'Saldo a cobrar', valor: m(t.saldoACobrarCentavos), destaque: true },
    ...(t.creditoDoClienteCentavos > 0
      ? [
          {
            rotulo: 'Crédito do cliente',
            valor: m(t.creditoDoClienteCentavos),
            destaque: true,
          },
        ]
      : []),
    ...(t.depositosCentavos > 0
      ? [
          {
            rotulo: 'Depósitos e garantias (fora do total de despesas)',
            valor: m(t.depositosCentavos),
          },
        ]
      : []),
  ];
}

/**
 * Monta a seção de UM processo para o PDF: despesas e depósitos em blocos separados, recebimentos,
 * subtotais das despesas e o quadro de totais. Os valores vêm de `calcularTotais`. Quem chama passa
 * SÓ o que está ativo — cancelado nunca chega ao documento. `comprovantes` diz quantos anexos cada
 * lançamento tem (só o número: nada de nome de arquivo nem de link).
 */
export function montarSecao(
  custos: readonly Custo[],
  recebimentos: readonly Recebimento[],
  categorias: readonly CategoriaParaTela[],
  comprovantes: ReadonlyMap<string, number>,
): SecaoDaPrestacao {
  const resultado = calcularTotais(itensParaTotais(custos, categorias), recebimentos);
  const ehDeposito = (codigo: string): boolean =>
    categorias.find((c) => c.codigo === codigoAtualDaCategoria(codigo))?.deposito ===
    true;
  const linha = (c: Custo): LinhaDaPrestacao => {
    const n = comprovantes.get(c.id) ?? 0;
    return {
      data: dataBrasileira(c.data),
      descricao: n > 0 ? `${c.descricao} · Comprovantes: ${n}` : c.descricao,
      categoria: nomeCompletoDaCategoria(categorias, c.categoria),
      valor: reaisDeCentavos(c.valorCentavos),
      situacao: situacaoDoLancamento(c),
    };
  };
  return {
    linhas: custos.filter((c) => !ehDeposito(c.categoria)).map(linha),
    depositos: custos.filter((c) => ehDeposito(c.categoria)).map(linha),
    recebimentos: recebimentos.map((r) => ({
      data: dataBrasileira(r.data),
      observacao: r.observacao ?? '',
      valor: reaisDeCentavos(r.valorCentavos),
    })),
    subtotais: resultado.porCategoria.map((s) => ({
      categoria: nomeCompletoDaCategoria(categorias, s.categoria),
      quantidade: s.quantidade,
      valor: reaisDeCentavos(s.totalCentavos),
    })),
    totais: linhasDeTotais({ ...resumirTotais(resultado) }),
    resultado,
  };
}
