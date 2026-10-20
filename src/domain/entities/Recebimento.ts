import { CustoInvalidoError } from '../errors/index.js';
import {
  MAXIMO_DE_DIAS_A_FRENTE,
  somarDiasSimples,
  validarMotivo,
  validarValor,
} from './Custo.js';
import { ehDataDeCustoValida } from './Custo.js';

/**
 * Recebimento do cliente (v0.48.0): dinheiro que o cliente devolveu ao advogado, por processo,
 * parcial e quantas vezes for. SUBSTITUI o "Ressarcido" por lançamento da 0.47.0 — o reembolso não é
 * mais alocado a uma despesa. Não é receita nem honorário: só abate o que se cobra do cliente.
 *
 * Valor em centavos inteiros. Cancelado fica guardado, fora dos totais, e pode ser reativado.
 */
export const LIMITE_OBSERVACAO_DO_RECEBIMENTO = 200;
export const LIMITE_RECEBIMENTOS_POR_PROCESSO = 500;

export interface Recebimento {
  readonly id: string;
  readonly workspace: string;
  readonly numeroProcesso: string;
  /** `AAAA-MM-DD`, sem fuso. */
  readonly data: string;
  readonly valorCentavos: number;
  readonly observacao?: string;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
  readonly canceladoEm?: Date;
  readonly motivoDoCancelamento?: string;
}

export interface DadosDoRecebimento {
  readonly data: string;
  readonly valorCentavos: number;
  readonly observacao?: string | undefined;
}

export function validarObservacao(texto: unknown): string | undefined {
  if (texto === undefined || texto === null) return undefined;
  if (typeof texto !== 'string') throw new CustoInvalidoError('Observação inválida.');
  const t = texto.replace(/\s+/g, ' ').trim();
  if (t.length > LIMITE_OBSERVACAO_DO_RECEBIMENTO) {
    throw new CustoInvalidoError(
      `A observação pode ter até ${LIMITE_OBSERVACAO_DO_RECEBIMENTO} caracteres.`,
    );
  }
  return t.length === 0 ? undefined : t;
}

export function validarDataDoRecebimento(texto: unknown, hoje: string): string {
  if (!ehDataDeCustoValida(texto)) {
    throw new CustoInvalidoError('Informe uma data de recebimento válida (dd/mm/aaaa).');
  }
  if (texto < '2000-01-01' || texto > somarDiasSimples(hoje, MAXIMO_DE_DIAS_A_FRENTE)) {
    throw new CustoInvalidoError('A data do recebimento está fora do intervalo aceito.');
  }
  return texto;
}

function validar(
  d: DadosDoRecebimento,
  hoje: string,
  dataJaGravada: boolean,
): Pick<Recebimento, 'data' | 'valorCentavos' | 'observacao'> {
  const observacao = validarObservacao(d.observacao);
  return {
    data: dataJaGravada ? d.data : validarDataDoRecebimento(d.data, hoje),
    valorCentavos: validarValor(d.valorCentavos),
    ...(observacao ? { observacao } : {}),
  };
}

export function criarRecebimento(
  base: Pick<Recebimento, 'id' | 'workspace' | 'numeroProcesso' | 'criadoEm'>,
  dados: DadosDoRecebimento,
  hoje: string,
): Recebimento {
  return Object.freeze({
    ...base,
    ...validar(dados, hoje, false),
    atualizadoEm: base.criadoEm,
  });
}

export function alterarRecebimento(
  atual: Recebimento,
  mudancas: { data?: string; valorCentavos?: number; observacao?: string | null },
  agora: Date,
  hoje: string,
): Recebimento {
  const observacao =
    mudancas.observacao === undefined
      ? atual.observacao
      : (mudancas.observacao ?? undefined);
  const { id, workspace, numeroProcesso, criadoEm, canceladoEm, motivoDoCancelamento } =
    atual;
  return Object.freeze({
    id,
    workspace,
    numeroProcesso,
    criadoEm,
    ...validar(
      {
        data: mudancas.data ?? atual.data,
        valorCentavos: mudancas.valorCentavos ?? atual.valorCentavos,
        observacao,
      },
      hoje,
      mudancas.data === undefined,
    ),
    atualizadoEm: agora,
    ...(canceladoEm ? { canceladoEm } : {}),
    ...(motivoDoCancelamento ? { motivoDoCancelamento } : {}),
  });
}

export function cancelarRecebimento(
  atual: Recebimento,
  motivo: unknown,
  agora: Date,
): Recebimento {
  const m = validarMotivo(motivo);
  const { canceladoEm: _c, motivoDoCancelamento: _m, ...resto } = atual;
  return Object.freeze({
    ...resto,
    atualizadoEm: agora,
    canceladoEm: agora,
    ...(m ? { motivoDoCancelamento: m } : {}),
  });
}

export function reativarRecebimento(atual: Recebimento, agora: Date): Recebimento {
  const { canceladoEm: _c, motivoDoCancelamento: _m, ...resto } = atual;
  return Object.freeze({ ...resto, atualizadoEm: agora });
}
