/**
 * O catálogo de custos em dois níveis, Grupo › Subcategoria (v0.48.0).
 *
 * É um cadastro de CLASSIFICAÇÃO: serve para o advogado organizar o que lançou. Ele NÃO afirma que
 * determinada cobrança seja exigível em um processo — isso depende da lei, da tabela do tribunal e
 * da situação processual — e não calcula custas.
 *
 * **Códigos são permanentes.** Nunca se apaga nem se renumera um código: o lançamento guarda o
 * código da subcategoria, e mudar o código reclassificaria, calado, tudo o que já foi lançado. Os
 * grupos 09 (multas) e 10 (honorários) NÃO existem de propósito: o módulo é de custos para prestar
 * contas, não de financeiro.
 */

export interface GrupoDeCusto {
  readonly codigo: string;
  readonly nome: string;
}

/** Depósitos e garantias não são despesa definitiva: ficam fora do total de despesas. */
export const GRUPO_DE_DEPOSITOS = '08';
/** Onde caem as categorias próprias da 0.47.0 e as subcategorias novas sem grupo escolhido. */
export const GRUPO_PADRAO_DAS_PROPRIAS = '12';

export const GRUPOS_DE_CUSTO: readonly GrupoDeCusto[] = Object.freeze(
  (
    [
      ['01', 'Custas e taxas judiciais'],
      ['02', 'Recursos judiciais'],
      ['03', 'Diligências e comunicações'],
      ['04', 'Perícias e avaliações'],
      ['05', 'Execução e expropriação'],
      ['06', 'Cartórios e registros'],
      ['07', 'Pesquisas e certidões'],
      ['08', 'Depósitos e garantias'],
      ['11', 'Despesas administrativas'],
      ['12', 'Outras despesas'],
    ] as const
  ).map(([codigo, nome]) => Object.freeze({ codigo, nome })),
);

export interface SubcategoriaBase {
  readonly codigo: string;
  readonly nome: string;
  readonly grupo: string;
}

const BASE: ReadonlyArray<
  readonly [string, string, readonly (readonly [string, string])[]]
> = [
  [
    '01',
    'CUS',
    [
      ['001', 'Custas iniciais'],
      ['002', 'Custas complementares'],
      ['005', 'Custas de distribuição'],
      ['011', 'Taxa judiciária'],
      ['012', 'Complementação de taxa judiciária'],
      ['019', 'Emolumentos judiciais'],
      ['020', 'Outras custas judiciais'],
    ],
  ],
  [
    '02',
    'REC',
    [
      ['001', 'Preparo de apelação'],
      ['002', 'Preparo de agravo de instrumento'],
      ['008', 'Preparo de outros recursos'],
      ['010', 'Porte de remessa e retorno'],
    ],
  ],
  [
    '03',
    'DIL',
    [
      ['001', 'Diligência de oficial de justiça'],
      ['002', 'Citação postal'],
      ['003', 'Intimação postal'],
      ['004', 'Publicação de edital'],
      ['008', 'Despesas com testemunhas'],
      ['010', 'Outras diligências'],
    ],
  ],
  [
    '04',
    'PER',
    [
      ['001', 'Honorários de perito judicial'],
      ['002', 'Honorários de assistente técnico'],
      ['003', 'Avaliação judicial de bens'],
      ['009', 'Complementação de honorários periciais'],
    ],
  ],
  [
    '05',
    'EXE',
    [
      ['001', 'Diligência de penhora'],
      ['002', 'Avaliação de bens penhorados'],
      ['005', 'Despesas de leilão'],
      ['006', 'Comissão de leiloeiro'],
    ],
  ],
  [
    '06',
    'CAR',
    [
      ['001', 'Certidão de matrícula imobiliária'],
      ['002', 'Averbação imobiliária'],
      ['003', 'Registro de penhora'],
      ['008', 'Autenticação de documentos'],
    ],
  ],
  [
    '07',
    'PES',
    [
      ['001', 'Pesquisa patrimonial'],
      ['006', 'Certidão judicial'],
      ['007', 'Certidão administrativa'],
    ],
  ],
  [
    '08',
    'DEP',
    [
      ['001', 'Depósito judicial'],
      ['002', 'Depósito recursal trabalhista'],
      ['003', 'Caução judicial'],
      ['005', 'Fiança criminal'],
      ['006', 'Depósito para garantia de execução'],
    ],
  ],
  [
    '11',
    'ADM',
    [
      ['001', 'Deslocamentos'],
      ['002', 'Hospedagem'],
      ['003', 'Alimentação em diligência'],
      ['004', 'Cópias e digitalizações'],
      ['005', 'Correspondências e postagens'],
      ['006', 'Serviços de terceiros'],
    ],
  ],
  [
    '12',
    'OUT',
    [
      ['001', 'Despesa processual não classificada'],
      ['002', 'Despesa administrativa não classificada'],
    ],
  ],
];

/** As subcategorias pré-cadastradas, FIXAS. O código é o que se grava no lançamento. */
export const SUBCATEGORIAS_BASE: readonly SubcategoriaBase[] = Object.freeze(
  BASE.flatMap(([grupo, prefixo, itens]) =>
    itens.map(([numero, nome]) =>
      Object.freeze({ codigo: `${prefixo}-${numero}`, nome, grupo }),
    ),
  ),
);

/**
 * As sete categorias da 0.47.0 e para onde cada uma foi (decisão do dono). "Custas judiciais" e
 * "Publicações" eram genéricas, então vão para as subcategorias genéricas do grupo — não se
 * afirma um tipo específico de custa nem de publicação que o advogado nunca disse.
 */
export const MAPA_DE_CATEGORIAS_ANTIGAS: Readonly<Record<string, string>> = Object.freeze(
  {
    custas: 'CUS-020',
    pericia: 'PER-001',
    diligencia: 'DIL-001',
    deslocamento: 'ADM-001',
    copias: 'ADM-004',
    publicacoes: 'DIL-010',
    outros: 'OUT-001',
  },
);

/** O código de uma subcategoria própria é `c-` + o id dela; nunca colide com os da base. */
export const PREFIXO_DA_CATEGORIA_PROPRIA = 'c-';

/** Código da 0.47.0 vira o novo; qualquer outro volta como veio. */
export function codigoAtualDaCategoria(codigo: string): string {
  return MAPA_DE_CATEGORIAS_ANTIGAS[codigo] ?? codigo;
}

export function ehCategoriaBase(codigo: string): boolean {
  return SUBCATEGORIAS_BASE.some((c) => c.codigo === codigo);
}

export function subcategoriaBase(codigo: string): SubcategoriaBase | undefined {
  return SUBCATEGORIAS_BASE.find((c) => c.codigo === codigo);
}

export function grupoDeCusto(codigo: string): GrupoDeCusto | undefined {
  return GRUPOS_DE_CUSTO.find((g) => g.codigo === codigo);
}

export function ehGrupoValido(codigo: unknown): codigo is string {
  return typeof codigo === 'string' && grupoDeCusto(codigo) !== undefined;
}

/** A natureza (depósito × despesa) sai SÓ do grupo; não há campo solto que possa discordar dele. */
export function ehGrupoDeDeposito(grupo: string): boolean {
  return grupo === GRUPO_DE_DEPOSITOS;
}
