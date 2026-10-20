import type { Custo } from './Custo.js';
import type { Recebimento } from './Recebimento.js';

/**
 * Histórico dos custos (v0.48.0): uma trilha SOMENTE DE ACRÉSCIMO. Cada criação, edição,
 * cancelamento e reativação de lançamento ou recebimento deixa um evento; nada é alterado nem
 * apagado depois (só a exclusão da conta leva a trilha junto). Sem usuário: só há um por conta.
 *
 * Nas edições, o evento guarda os campos que mudaram com o valor anterior e o novo. A DESCRIÇÃO e a
 * observação são texto livre do advogado: o evento diz que mudaram, mas não copia o texto.
 */
export type EntidadeDoHistorico = 'lancamento' | 'recebimento';
export type OperacaoDoHistorico =
  'criou' | 'editou' | 'cancelou' | 'reativou' | 'anexou' | 'removeu';

export type CampoDoHistorico =
  | 'valor'
  | 'data'
  | 'categoria'
  | 'pago_por'
  | 'reembolsavel'
  | 'descricao'
  | 'observacao';

export interface CampoAlterado {
  readonly campo: CampoDoHistorico;
  /** Valor bruto anterior (centavos, `AAAA-MM-DD`, código, `sim`/`nao`...). Ausente em texto livre. */
  readonly de?: string;
  readonly para?: string;
}

export interface EventoDoHistorico {
  readonly id: string;
  readonly workspace: string;
  readonly numeroProcesso: string;
  readonly entidade: EntidadeDoHistorico;
  readonly entidadeId: string;
  readonly operacao: OperacaoDoHistorico;
  readonly quando: Date;
  readonly campos: readonly CampoAlterado[];
  readonly motivo?: string;
}

export function diferencasDoCusto(antes: Custo, depois: Custo): readonly CampoAlterado[] {
  const r: CampoAlterado[] = [];
  if (antes.valorCentavos !== depois.valorCentavos) {
    r.push({
      campo: 'valor',
      de: String(antes.valorCentavos),
      para: String(depois.valorCentavos),
    });
  }
  if (antes.data !== depois.data)
    r.push({ campo: 'data', de: antes.data, para: depois.data });
  if (antes.categoria !== depois.categoria) {
    r.push({ campo: 'categoria', de: antes.categoria, para: depois.categoria });
  }
  if (antes.pagoPor !== depois.pagoPor) {
    r.push({ campo: 'pago_por', de: antes.pagoPor, para: depois.pagoPor });
  }
  if (antes.reembolsavel !== depois.reembolsavel) {
    r.push({
      campo: 'reembolsavel',
      de: antes.reembolsavel ? 'sim' : 'nao',
      para: depois.reembolsavel ? 'sim' : 'nao',
    });
  }
  if (antes.descricao !== depois.descricao) r.push({ campo: 'descricao' });
  return r;
}

export function diferencasDoRecebimento(
  antes: Recebimento,
  depois: Recebimento,
): readonly CampoAlterado[] {
  const r: CampoAlterado[] = [];
  if (antes.valorCentavos !== depois.valorCentavos) {
    r.push({
      campo: 'valor',
      de: String(antes.valorCentavos),
      para: String(depois.valorCentavos),
    });
  }
  if (antes.data !== depois.data)
    r.push({ campo: 'data', de: antes.data, para: depois.data });
  if ((antes.observacao ?? '') !== (depois.observacao ?? ''))
    r.push({ campo: 'observacao' });
  return r;
}
