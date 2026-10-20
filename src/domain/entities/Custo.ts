import { CustoInvalidoError } from '../errors/index.js';
import { dataExiste } from './EventoDeCalendario.js';

/**
 * Centro de custos do processo (v0.47.0): as despesas que o advogado lança de cada processo, o que
 * ele cobra do cliente e o que já foi ressarcido. NÃO é sistema financeiro — sem receita, sem
 * honorário, sem parcela, sem comprovante. O valor é dado do cliente do advogado: nunca vai a log.
 *
 * **Valores são sempre CENTAVOS INTEIROS.** Nada aqui usa fração de real.
 */

/** Teto de um lançamento: R$ 1.000.000,00. Acima disso é erro de digitação, não despesa. */
export const VALOR_MAXIMO_CENTAVOS = 100_000_000;
export const LIMITE_DESCRICAO = 200;
export const LIMITE_NOME_DA_CATEGORIA = 40;
export const LIMITE_LANCAMENTOS_POR_PROCESSO = 500;
export const LIMITE_CATEGORIAS_PROPRIAS = 30;

/** A data do gasto pode estar um ano à frente (despesa já contratada); mais que isso é engano. */
export const MAXIMO_DE_DIAS_A_FRENTE = 366;

export interface CategoriaBase {
  readonly codigo: string;
  readonly nome: string;
}

/** A lista base FIXA. O código é o que se grava no lançamento; o nome é o que se mostra. */
export const CATEGORIAS_BASE: readonly CategoriaBase[] = Object.freeze([
  Object.freeze({ codigo: 'custas', nome: 'Custas judiciais' }),
  Object.freeze({ codigo: 'pericia', nome: 'Perícia' }),
  Object.freeze({ codigo: 'diligencia', nome: 'Diligência' }),
  Object.freeze({ codigo: 'deslocamento', nome: 'Deslocamento' }),
  Object.freeze({ codigo: 'copias', nome: 'Cópias e impressões' }),
  Object.freeze({ codigo: 'publicacoes', nome: 'Publicações' }),
  Object.freeze({ codigo: 'outros', nome: 'Outros' }),
]);

/** O código de uma categoria própria é `c-` + o id dela; nunca colide com os da lista base. */
export const PREFIXO_DA_CATEGORIA_PROPRIA = 'c-';

export function ehCategoriaBase(codigo: string): boolean {
  return CATEGORIAS_BASE.some((c) => c.codigo === codigo);
}

export interface CategoriaDeCusto {
  readonly id: string;
  readonly workspace: string;
  readonly nome: string;
  /** Arquivada some do seletor de lançamentos novos; os lançamentos antigos a mantêm. */
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
  /** Código de categoria base ou `c-<id>` de categoria própria. */
  readonly categoria: string;
  readonly valorCentavos: number;
  /** "Cobrar do cliente". */
  readonly reembolsavel: boolean;
  /** `AAAA-MM-DD`; só existe em lançamento reembolsável. Ausente = ainda não ressarcido. */
  readonly ressarcidoEm?: string;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export interface DadosDoCusto {
  readonly data: string;
  readonly descricao: string;
  readonly categoria: string;
  readonly valorCentavos: number;
  readonly reembolsavel: boolean;
  readonly ressarcidoEm?: string | undefined;
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

export function validarDataDoRessarcimento(texto: unknown, hoje: string): string {
  if (!ehDataDeCustoValida(texto)) {
    throw new CustoInvalidoError(
      'Informe uma data de ressarcimento válida (dd/mm/aaaa).',
    );
  }
  if (texto < '2000-01-01' || texto > somarDiasSimples(hoje, MAXIMO_DE_DIAS_A_FRENTE)) {
    throw new CustoInvalidoError(
      'A data do ressarcimento está fora do intervalo aceito.',
    );
  }
  return texto;
}

function somarDiasSimples(data: string, dias: number): string {
  const m = RE_DATA.exec(data);
  if (!m) return data;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return new Date(base + dias * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Nome de categoria para COMPARAR: sem acento, caixa baixa, espaços colapsados. "Perícia" e
 * "pericia " são a mesma — duplicar a da lista base por diferença de acento seria o jeito de
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

/** Nome de categoria própria: 1 a 40 caracteres, espaços colapsados, e que NÃO repita a lista base. */
export function validarNomeDeCategoria(texto: unknown): string {
  const t = typeof texto === 'string' ? texto.replace(/\s+/g, ' ').trim() : '';
  if (t.length === 0) throw new CustoInvalidoError('Informe o nome da categoria.');
  if (t.length > LIMITE_NOME_DA_CATEGORIA) {
    throw new CustoInvalidoError(
      `O nome da categoria pode ter até ${LIMITE_NOME_DA_CATEGORIA} caracteres.`,
    );
  }
  const chave = chaveDoNomeDeCategoria(t);
  if (CATEGORIAS_BASE.some((c) => chaveDoNomeDeCategoria(c.nome) === chave)) {
    throw new CustoInvalidoError('Essa categoria já existe na lista padrão.');
  }
  return t;
}

/**
 * Monta um lançamento VALIDADO e congelado. O ressarcimento só existe em lançamento reembolsável:
 * não há "ressarcido" de despesa que o advogado não cobra do cliente.
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
  mudancas: Partial<Omit<DadosDoCusto, 'ressarcidoEm'>> & {
    readonly ressarcidoEm?: string | null | undefined;
  },
  agora: Date,
  hoje: string,
): Custo {
  const ressarcidoEm =
    mudancas.ressarcidoEm === undefined
      ? atual.ressarcidoEm
      : (mudancas.ressarcidoEm ?? undefined);
  const valida = validarDados(
    {
      data: mudancas.data ?? atual.data,
      descricao: mudancas.descricao ?? atual.descricao,
      categoria: mudancas.categoria ?? atual.categoria,
      valorCentavos: mudancas.valorCentavos ?? atual.valorCentavos,
      reembolsavel: mudancas.reembolsavel ?? atual.reembolsavel,
      ressarcidoEm,
    },
    hoje,
    // Data e ressarcimento que já estavam gravados não são revalidados contra o "hoje" de agora:
    // o lançamento antigo continua editável mesmo que a regra da frente tenha passado.
    {
      data: mudancas.data === undefined,
      ressarcimento: mudancas.ressarcidoEm === undefined,
    },
  );
  const { criadoEm, id, workspace, numeroProcesso } = atual;
  return Object.freeze({
    id,
    workspace,
    numeroProcesso,
    criadoEm,
    ...valida,
    atualizadoEm: agora,
  });
}

function validarDados(
  d: DadosDoCusto,
  hoje: string,
  jaGravados: { readonly data: boolean; readonly ressarcimento: boolean } = {
    data: false,
    ressarcimento: false,
  },
): Omit<Custo, 'id' | 'workspace' | 'numeroProcesso' | 'criadoEm' | 'atualizadoEm'> {
  const data = jaGravados.data ? d.data : validarDataDoGasto(d.data, hoje);
  const descricao = validarDescricao(d.descricao);
  const valorCentavos = validarValor(d.valorCentavos);
  if (
    typeof d.categoria !== 'string' ||
    d.categoria.length === 0 ||
    d.categoria.length > 80
  ) {
    throw new CustoInvalidoError('Escolha a categoria.');
  }
  const reembolsavel = d.reembolsavel === true;
  let ressarcidoEm: string | undefined;
  if (d.ressarcidoEm !== undefined) {
    if (!reembolsavel) {
      // Desmarcar "cobrar do cliente" apaga o ressarcimento: despesa que não se cobra não se ressarce.
      ressarcidoEm = undefined;
    } else {
      ressarcidoEm = jaGravados.ressarcimento
        ? d.ressarcidoEm
        : validarDataDoRessarcimento(d.ressarcidoEm, hoje);
    }
  }
  return {
    data,
    descricao,
    categoria: d.categoria,
    valorCentavos,
    reembolsavel,
    ...(ressarcidoEm !== undefined ? { ressarcidoEm } : {}),
  };
}

export interface SubtotalDaCategoria {
  readonly categoria: string;
  readonly totalCentavos: number;
  readonly quantidade: number;
}

export interface TotaisDeCusto {
  readonly quantidade: number;
  /** Tudo o que foi lançado. */
  readonly totalGastoCentavos: number;
  /** Parte que o advogado cobra do cliente. */
  readonly totalReembolsavelCentavos: number;
  /** Parte reembolsável que já foi ressarcida. */
  readonly totalRessarcidoCentavos: number;
  /** reembolsável − ressarcido. Nunca negativo: ressarcido é sempre parte do reembolsável. */
  readonly saldoACobrarCentavos: number;
  /** Maior total primeiro; o código desempata para a lista nunca "pular". */
  readonly porCategoria: readonly SubtotalDaCategoria[];
}

/** O que ainda se pode cobrar: reembolsável e não ressarcido. */
export function estaACobrar(c: Pick<Custo, 'reembolsavel' | 'ressarcidoEm'>): boolean {
  return c.reembolsavel && c.ressarcidoEm === undefined;
}

/**
 * Totais e subtotais, só com aritmética de inteiro. É o ÚNICO lugar que soma: a tela, a API e o PDF
 * mostram o que esta função devolveu, e nenhum deles refaz a conta.
 */
export function calcularTotais(
  custos: readonly Pick<
    Custo,
    'categoria' | 'valorCentavos' | 'reembolsavel' | 'ressarcidoEm'
  >[],
): TotaisDeCusto {
  let gasto = 0;
  let reembolsavel = 0;
  let ressarcido = 0;
  const porCategoria = new Map<string, { total: number; quantidade: number }>();
  for (const c of custos) {
    gasto += c.valorCentavos;
    if (c.reembolsavel) {
      reembolsavel += c.valorCentavos;
      if (c.ressarcidoEm !== undefined) ressarcido += c.valorCentavos;
    }
    const sub = porCategoria.get(c.categoria) ?? { total: 0, quantidade: 0 };
    sub.total += c.valorCentavos;
    sub.quantidade += 1;
    porCategoria.set(c.categoria, sub);
  }
  return Object.freeze({
    quantidade: custos.length,
    totalGastoCentavos: gasto,
    totalReembolsavelCentavos: reembolsavel,
    totalRessarcidoCentavos: ressarcido,
    saldoACobrarCentavos: reembolsavel - ressarcido,
    porCategoria: Object.freeze(
      [...porCategoria.entries()]
        .map(([categoria, v]) =>
          Object.freeze({ categoria, totalCentavos: v.total, quantidade: v.quantidade }),
        )
        .sort(
          (a, b) =>
            b.totalCentavos - a.totalCentavos || a.categoria.localeCompare(b.categoria),
        ),
    ),
  });
}
