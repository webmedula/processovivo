import { CustoInvalidoError } from '../errors/index.js';
import {
  GRUPO_PADRAO_DAS_PROPRIAS,
  PREFIXO_DA_CATEGORIA_PROPRIA,
  SUBCATEGORIAS_BASE,
  ehGrupoValido,
} from './CatalogoDeCustos.js';
import { dataExiste } from './EventoDeCalendario.js';

/**
 * Centro de custos do processo (v0.47.0, ampliado na v0.48.0): as despesas que o advogado lança de
 * cada processo, quem pagou e o que ele cobra do cliente. O que o cliente pagou de volta são os
 * recebimentos (`Recebimento.ts`). NÃO é sistema financeiro — sem receita, honorário, multa,
 * vencimento, previsto nem alerta. O valor é dado do cliente do advogado: nunca vai a log.
 *
 * **Valores são sempre CENTAVOS INTEIROS.** Nada aqui usa fração de real.
 */

/** Teto de um lançamento: R$ 1.000.000,00. Acima disso é erro de digitação, não despesa. */
export const VALOR_MAXIMO_CENTAVOS = 100_000_000;
export const LIMITE_DESCRICAO = 200;
export const LIMITE_NOME_DA_CATEGORIA = 60;
export const LIMITE_LANCAMENTOS_POR_PROCESSO = 500;
export const LIMITE_CATEGORIAS_PROPRIAS = 60;
/** Motivo (opcional) de um cancelamento. */
export const LIMITE_MOTIVO = 200;

/** A data do gasto pode estar um ano à frente (despesa já contratada); mais que isso é engano. */
export const MAXIMO_DE_DIAS_A_FRENTE = 366;

/** Quem tirou o dinheiro do bolso. Só o que o ESCRITÓRIO pagou pode ser cobrado do cliente. */
export type PagoPor = 'escritorio' | 'cliente';
export const PAGADORES: readonly PagoPor[] = Object.freeze(['escritorio', 'cliente']);

export function ehPagador(valor: unknown): valor is PagoPor {
  return valor === 'escritorio' || valor === 'cliente';
}

/**
 * Subcategoria PRÓPRIA do advogado, dentro de um grupo. Os códigos das pré-cadastradas ficam em
 * `CatalogoDeCustos.ts`; o desta é `c-<id>`. Arquivar a tira do seletor sem tocar nos lançamentos.
 */
export interface CategoriaDeCusto {
  readonly id: string;
  readonly workspace: string;
  readonly nome: string;
  /** Código do grupo (`CatalogoDeCustos`). As próprias da 0.47.0 nasceram no 12. */
  readonly grupo: string;
  readonly arquivada: boolean;
  readonly criadaEm: Date;
}

export function codigoDaCategoriaPropria(id: string): string {
  return PREFIXO_DA_CATEGORIA_PROPRIA + id;
}

export interface Custo {
  readonly id: string;
  readonly workspace: string;
  /** Os 20 dígitos do CNJ, sem máscara — a mesma chave de `acompanhamentos`. */
  readonly numeroProcesso: string;
  /** `AAAA-MM-DD`, data do gasto, sem fuso. */
  readonly data: string;
  readonly descricao: string;
  /** Código de subcategoria base (`CUS-020`) ou `c-<id>` de subcategoria própria. */
  readonly categoria: string;
  readonly valorCentavos: number;
  /** "Cobrar do cliente". Sempre falso quando `pagoPor` é `cliente`. */
  readonly reembolsavel: boolean;
  readonly pagoPor: PagoPor;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
  /** Cancelado fica guardado, fora dos totais, e pode ser reativado. Nunca se apaga. */
  readonly canceladoEm?: Date;
  readonly motivoDoCancelamento?: string;
}

export interface DadosDoCusto {
  readonly data: string;
  readonly descricao: string;
  readonly categoria: string;
  readonly valorCentavos: number;
  readonly reembolsavel: boolean;
  readonly pagoPor?: PagoPor | undefined;
}

const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `AAAA-MM-DD` de um dia que existe no calendário. 31/02 não passa. */
export function ehDataDeCustoValida(texto: unknown): texto is string {
  if (typeof texto !== 'string') return false;
  const m = RE_DATA.exec(texto);
  if (!m) return false;
  return dataExiste(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function validarValor(centavos: unknown): number {
  if (typeof centavos !== 'number' || !Number.isInteger(centavos)) {
    throw new CustoInvalidoError('Informe o valor em reais, por exemplo 1.234,56.');
  }
  if (centavos <= 0) throw new CustoInvalidoError('O valor precisa ser maior que zero.');
  if (centavos > VALOR_MAXIMO_CENTAVOS) {
    throw new CustoInvalidoError('O valor máximo de um lançamento é R$ 1.000.000,00.');
  }
  return centavos;
}

export function validarDescricao(texto: unknown): string {
  const t = typeof texto === 'string' ? texto.replace(/\s+/g, ' ').trim() : '';
  if (t.length === 0) throw new CustoInvalidoError('Informe a descrição.');
  if (t.length > LIMITE_DESCRICAO) {
    throw new CustoInvalidoError(
      `A descrição pode ter até ${LIMITE_DESCRICAO} caracteres.`,
    );
  }
  return t;
}

/** Motivo do cancelamento: opcional, até 200 caracteres. Vazio = sem motivo (`undefined`). */
export function validarMotivo(texto: unknown): string | undefined {
  if (texto === undefined || texto === null) return undefined;
  const t = typeof texto === 'string' ? texto.replace(/\s+/g, ' ').trim() : '';
  if (typeof texto !== 'string') throw new CustoInvalidoError('Motivo inválido.');
  if (t.length > LIMITE_MOTIVO) {
    throw new CustoInvalidoError(`O motivo pode ter até ${LIMITE_MOTIVO} caracteres.`);
  }
  return t.length === 0 ? undefined : t;
}

/**
 * Confere a data do gasto. `hoje` é o dia de São Paulo (do `Clock`, nunca do relógio da máquina)
 * e fixa o limite da frente; para trás, só o formato e a existência do dia.
 */
export function validarDataDoGasto(texto: unknown, hoje: string): string {
  if (!ehDataDeCustoValida(texto)) {
    throw new CustoInvalidoError('Informe uma data válida (dd/mm/aaaa).');
  }
  if (texto < '2000-01-01')
    throw new CustoInvalidoError('A data não pode ser anterior a 2000.');
  if (texto > somarDiasSimples(hoje, MAXIMO_DE_DIAS_A_FRENTE)) {
    throw new CustoInvalidoError('A data está longe demais no futuro.');
  }
  return texto;
}

export function somarDiasSimples(data: string, dias: number): string {
  const m = RE_DATA.exec(data);
  if (!m) return data;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return new Date(base + dias * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Nome de subcategoria para COMPARAR: sem acento, caixa baixa, espaços colapsados. "Perícia" e
 * "pericia " são a mesma — duplicar uma da lista base por diferença de acento seria o jeito de
 * burlar a regra.
 */
export function chaveDoNomeDeCategoria(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Nome de subcategoria própria: 1 a 60 caracteres, espaços colapsados. */
export function validarNomeDeCategoria(texto: unknown): string {
  const t = typeof texto === 'string' ? texto.replace(/\s+/g, ' ').trim() : '';
  if (t.length === 0) throw new CustoInvalidoError('Informe o nome da subcategoria.');
  if (t.length > LIMITE_NOME_DA_CATEGORIA) {
    throw new CustoInvalidoError(
      `O nome da subcategoria pode ter até ${LIMITE_NOME_DA_CATEGORIA} caracteres.`,
    );
  }
  return t;
}

/** Grupo informado pelo advogado; sem grupo, a subcategoria própria cai em "Outras despesas". */
export function validarGrupo(texto: unknown): string {
  if (texto === undefined) return GRUPO_PADRAO_DAS_PROPRIAS;
  if (!ehGrupoValido(texto)) throw new CustoInvalidoError('Escolha um grupo da lista.');
  return texto;
}

/** Chave de unicidade DENTRO do grupo (o mesmo nome pode existir em grupos diferentes). */
export function chaveDeUnicidadeDaCategoria(grupo: string, nome: string): string {
  return `${grupo}:${chaveDoNomeDeCategoria(nome)}`;
}

/** Existe uma subcategoria PRÉ-CADASTRADA com este nome neste grupo? */
export function nomeRepetidoNaBase(grupo: string, nome: string): boolean {
  const chave = chaveDoNomeDeCategoria(nome);
  return SUBCATEGORIAS_BASE.some(
    (c) => c.grupo === grupo && chaveDoNomeDeCategoria(c.nome) === chave,
  );
}

/**
 * Monta um lançamento VALIDADO e congelado. Quem pagou é o escritório, a menos que se diga o
 * contrário; despesa que o CLIENTE pagou nunca é reembolsável (não há o que cobrar de volta).
 */
export function criarCusto(
  base: Pick<Custo, 'id' | 'workspace' | 'numeroProcesso' | 'criadoEm'>,
  dados: DadosDoCusto,
  hoje: string,
): Custo {
  const valida = validarDados(dados, hoje);
  return Object.freeze({
    ...base,
    ...valida,
    atualizadoEm: base.criadoEm,
  });
}

export function alterarCusto(
  atual: Custo,
  mudancas: Partial<DadosDoCusto>,
  agora: Date,
  hoje: string,
): Custo {
  const valida = validarDados(
    {
      data: mudancas.data ?? atual.data,
      descricao: mudancas.descricao ?? atual.descricao,
      categoria: mudancas.categoria ?? atual.categoria,
      valorCentavos: mudancas.valorCentavos ?? atual.valorCentavos,
      reembolsavel: mudancas.reembolsavel ?? atual.reembolsavel,
      pagoPor: mudancas.pagoPor ?? atual.pagoPor,
    },
    hoje,
    // A data que já estava gravada não é revalidada contra o "hoje" de agora: o lançamento
    // antigo continua editável mesmo que a regra da frente tenha passado.
    mudancas.data === undefined,
  );
  const { criadoEm, id, workspace, numeroProcesso, canceladoEm, motivoDoCancelamento } =
    atual;
  return Object.freeze({
    id,
    workspace,
    numeroProcesso,
    criadoEm,
    ...valida,
    atualizadoEm: agora,
    ...(canceladoEm ? { canceladoEm } : {}),
    ...(motivoDoCancelamento ? { motivoDoCancelamento } : {}),
  });
}

export function cancelarCusto(atual: Custo, motivo: unknown, agora: Date): Custo {
  const m = validarMotivo(motivo);
  const { canceladoEm: _c, motivoDoCancelamento: _m, ...resto } = atual;
  return Object.freeze({
    ...resto,
    atualizadoEm: agora,
    canceladoEm: agora,
    ...(m ? { motivoDoCancelamento: m } : {}),
  });
}

export function reativarCusto(atual: Custo, agora: Date): Custo {
  const { canceladoEm: _c, motivoDoCancelamento: _m, ...resto } = atual;
  return Object.freeze({ ...resto, atualizadoEm: agora });
}

function validarDados(
  d: DadosDoCusto,
  hoje: string,
  dataJaGravada = false,
): Omit<
  Custo,
  | 'id'
  | 'workspace'
  | 'numeroProcesso'
  | 'criadoEm'
  | 'atualizadoEm'
  | 'canceladoEm'
  | 'motivoDoCancelamento'
> {
  const data = dataJaGravada ? d.data : validarDataDoGasto(d.data, hoje);
  const descricao = validarDescricao(d.descricao);
  const valorCentavos = validarValor(d.valorCentavos);
  if (
    typeof d.categoria !== 'string' ||
    d.categoria.length === 0 ||
    d.categoria.length > 80
  ) {
    throw new CustoInvalidoError('Escolha a subcategoria.');
  }
  const pagoPor = d.pagoPor ?? 'escritorio';
  if (!ehPagador(pagoPor)) throw new CustoInvalidoError('Informe quem pagou.');
  return {
    data,
    descricao,
    categoria: d.categoria,
    valorCentavos,
    pagoPor,
    // Despesa paga pelo cliente não gera valor reembolsável nem saldo: a caixa é desligada à força.
    reembolsavel: pagoPor === 'escritorio' && d.reembolsavel === true,
  };
}

export interface SubtotalDaCategoria {
  readonly categoria: string;
  readonly totalCentavos: number;
  readonly quantidade: number;
}

/** O que `calcularTotais` precisa de um lançamento. `deposito` vem do GRUPO da subcategoria. */
export interface ItemParaTotais {
  readonly categoria: string;
  readonly valorCentavos: number;
  readonly reembolsavel: boolean;
  readonly pagoPor: PagoPor;
  readonly deposito: boolean;
}

export interface TotaisDeDepositos {
  readonly quantidade: number;
  readonly totalCentavos: number;
  readonly pagoPeloEscritorioCentavos: number;
  readonly pagoPeloClienteCentavos: number;
  readonly porCategoria: readonly SubtotalDaCategoria[];
}

export interface TotaisDeCusto {
  /** Lançamentos ativos: despesas e depósitos. */
  readonly quantidade: number;
  /** Só DESPESAS. Depósitos e garantias têm bloco próprio e nunca entram aqui. */
  readonly totalDespesasCentavos: number;
  readonly pagoPeloEscritorioCentavos: number;
  readonly pagoPeloClienteCentavos: number;
  /** Cobrável do cliente: o que o escritório pagou e marcou "Cobrar do cliente" (inclui depósito). */
  readonly totalReembolsavelCentavos: number;
  /** Parte do reembolsável que é depósito ou garantia ("dos quais depósitos e garantias"). */
  readonly reembolsavelDeDepositosCentavos: number;
  /** Soma dos recebimentos ativos. */
  readonly totalRecebidoCentavos: number;
  /** reembolsável − recebido, nunca negativo. */
  readonly saldoACobrarCentavos: number;
  /** recebido − reembolsável, quando positivo: o excedente é CRÉDITO, nunca saldo negativo. */
  readonly creditoDoClienteCentavos: number;
  /** Subtotais das despesas, maior total primeiro; o código desempata para a lista nunca "pular". */
  readonly porCategoria: readonly SubtotalDaCategoria[];
  readonly depositos: TotaisDeDepositos;
}

function subtotais(
  mapa: Map<string, { total: number; quantidade: number }>,
): readonly SubtotalDaCategoria[] {
  return Object.freeze(
    [...mapa.entries()]
      .map(([categoria, v]) =>
        Object.freeze({ categoria, totalCentavos: v.total, quantidade: v.quantidade }),
      )
      .sort(
        (a, b) =>
          b.totalCentavos - a.totalCentavos || a.categoria.localeCompare(b.categoria),
      ),
  );
}

/**
 * Totais e subtotais, só com aritmética de inteiro. É o ÚNICO lugar que soma: a tela, a API e o PDF
 * mostram o que esta função devolveu. Quem chama passa SÓ o que está ativo (cancelado não entra).
 */
export function calcularTotais(
  itens: readonly ItemParaTotais[],
  recebimentos: readonly { readonly valorCentavos: number }[],
): TotaisDeCusto {
  let despesas = 0;
  let escritorio = 0;
  let cliente = 0;
  let reembolsavel = 0;
  let reembolsavelDeDepositos = 0;
  let depTotal = 0;
  let depEscritorio = 0;
  let depCliente = 0;
  let depQuantidade = 0;
  const porCategoria = new Map<string, { total: number; quantidade: number }>();
  const porCategoriaDep = new Map<string, { total: number; quantidade: number }>();
  for (const c of itens) {
    const alvo = c.deposito ? porCategoriaDep : porCategoria;
    const sub = alvo.get(c.categoria) ?? { total: 0, quantidade: 0 };
    sub.total += c.valorCentavos;
    sub.quantidade += 1;
    alvo.set(c.categoria, sub);
    if (c.deposito) {
      depQuantidade += 1;
      depTotal += c.valorCentavos;
      if (c.pagoPor === 'cliente') depCliente += c.valorCentavos;
      else depEscritorio += c.valorCentavos;
    } else {
      despesas += c.valorCentavos;
      if (c.pagoPor === 'cliente') cliente += c.valorCentavos;
      else escritorio += c.valorCentavos;
    }
    if (c.pagoPor === 'escritorio' && c.reembolsavel) {
      reembolsavel += c.valorCentavos;
      if (c.deposito) reembolsavelDeDepositos += c.valorCentavos;
    }
  }
  const recebido = recebimentos.reduce((soma, r) => soma + r.valorCentavos, 0);
  return Object.freeze({
    quantidade: itens.length,
    totalDespesasCentavos: despesas,
    pagoPeloEscritorioCentavos: escritorio,
    pagoPeloClienteCentavos: cliente,
    totalReembolsavelCentavos: reembolsavel,
    reembolsavelDeDepositosCentavos: reembolsavelDeDepositos,
    totalRecebidoCentavos: recebido,
    saldoACobrarCentavos: Math.max(0, reembolsavel - recebido),
    creditoDoClienteCentavos: Math.max(0, recebido - reembolsavel),
    porCategoria: subtotais(porCategoria),
    depositos: Object.freeze({
      quantidade: depQuantidade,
      totalCentavos: depTotal,
      pagoPeloEscritorioCentavos: depEscritorio,
      pagoPeloClienteCentavos: depCliente,
      porCategoria: subtotais(porCategoriaDep),
    }),
  });
}

/** O que ainda se pode cobrar de um lançamento isolado: reembolsável pago pelo escritório. */
export function estaACobrar(c: Pick<Custo, 'reembolsavel' | 'pagoPor'>): boolean {
  return c.reembolsavel && c.pagoPor === 'escritorio';
}
