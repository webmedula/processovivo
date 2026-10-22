import type {
  AvaliacaoDaAnalise,
  MedidasDaAnalise,
  MotivoDaAvaliacao,
  ProcedenciaDaAnalise,
} from './AnaliseDoAto.js';

/**
 * Análise de UMA peça por IA (v0.55.0, Fase 1; especificação `ia-analise-de-pecas` v1.2.0).
 *
 * O que fica gravado é o resultado COM MARCADORES e com citações CURTAS (o `trecho` de cada item,
 * no máximo 300 caracteres), pelo prazo configurado (padrão 30 dias). **O texto da peça nunca é
 * gravado** — nem integral, nem por página; nem nome de parte, número de processo ou CPF. Apoio à
 * leitura: descreve o que a peça diz ("alega", "pede", "cita"), sem mérito, sem chance de êxito,
 * sem prazo calculado, sem conselho.
 */

export const TIPOS_DE_PECA = [
  'peticao_inicial',
  'contestacao',
  'replica',
  'embargos',
  'recurso',
  'laudo_pericial',
  'manifestacao',
  'outro',
  'indeterminado',
] as const;
export type TipoDePeca = (typeof TIPOS_DE_PECA)[number];

export const PONTOS_DE_ATENCAO_DE_PECA = [
  'peca_longa_demais_para_leitura_completa',
  'texto_incompleto_ou_ilegivel',
  'peca_cita_documentos_nao_anexados',
  'conferir_peca_inteira',
] as const;
export type PontoDeAtencaoDePeca = (typeof PONTOS_DE_ATENCAO_DE_PECA)[number];

/** Limites do resultado de PRODUÇÃO (conciso de propósito; o esquema da Fase 0 era maior). */
export const LIMITES_DA_ANALISE_DE_PECA = Object.freeze({
  umaFrase: 200,
  texto: 160,
  trecho: 300,
  pedidos: 5,
  alegacoes: 4,
  preliminares: 3,
  documentos: 8,
  valores: 5,
  pontosDeAtencao: 3,
  valorLiteral: 60,
  contexto: 120,
  nomeDoDocumento: 120,
});

export interface ItemDaPeca {
  readonly texto: string;
  readonly trecho: string;
  readonly pagina: number;
}
export interface DocumentoDaPeca {
  readonly nome_como_escrito: string;
  readonly pagina: number;
}
export interface ValorDaPeca {
  readonly valor_literal: string;
  readonly contexto_curto: string;
  readonly trecho: string;
  readonly pagina: number;
}

/** O que o modelo devolve, dentro do esquema e ANTES da verificação. É dado de fonte externa. */
export interface RespostaDoModeloDePeca {
  readonly tipo_da_peca: TipoDePeca;
  /** Ausente na leitura da Fase 0 (comparador); o prompt de produção a exige. */
  readonly em_uma_frase?: string;
  readonly pedidos: readonly ItemDaPeca[];
  readonly alegacoes_principais: readonly ItemDaPeca[];
  readonly preliminares_ou_defesas_formais: readonly ItemDaPeca[];
  readonly documentos_citados: readonly DocumentoDaPeca[];
  readonly valores_citados: readonly ValorDaPeca[];
  readonly pontos_de_atencao: readonly PontoDeAtencaoDePeca[];
}

/** O resultado já verificado, ainda com marcadores. */
export type ResultadoDaAnaliseDePeca =
  | {
      readonly estado: 'verificada';
      readonly tipo: TipoDePeca;
      readonly emUmaFrase: string;
      readonly pedidos: readonly ItemDaPeca[];
      readonly alegacoes: readonly ItemDaPeca[];
      readonly preliminares: readonly ItemDaPeca[];
      readonly documentos: readonly DocumentoDaPeca[];
      readonly valores: readonly ValorDaPeca[];
      readonly pontosDeAtencao: readonly PontoDeAtencaoDePeca[];
    }
  | {
      readonly estado: 'nao_verificada';
      readonly motivo: 'expressao_proibida' | 'sem_item_verificado';
    };

/** Contagens do pedido: só números, nunca texto. */
export interface ContagensDaAnaliseDePeca {
  readonly paginas: number;
  readonly caracteres: number;
  /** Itens que o modelo devolveu e a verificação descartou. */
  readonly itensDescartados: number;
  /** Quanto a análise pesou no teto técnico diário (5). */
  readonly peso: number;
}

export interface AnaliseDePeca {
  readonly id: string;
  readonly workspace: string;
  /**
   * Chave OPACA do processo (SHA-256 de conta + número): prende a análise ao processo sem gravar o
   * número CNJ. Quem tem o número e a conta calcula a chave; quem lê o banco não recupera o número.
   */
  readonly processoChave: string;
  /** O identificador INTERNO da peça na listagem (não o nome do arquivo). */
  readonly pecaId: string;
  /** SHA-256 dos bytes do PDF guardado: serve ao reaproveitamento; não revela o conteúdo. */
  readonly hashDosBytes: string;
  readonly resultado: ResultadoDaAnaliseDePeca;
  readonly contagens: ContagensDaAnaliseDePeca;
  readonly procedencia: ProcedenciaDaAnalise;
  /** O modelo que a configuração PEDIU (a procedência guarda o que a resposta diz ter servido). */
  readonly modeloPedido: string;
  readonly medidas: MedidasDaAnalise;
  readonly criadaEm: Date;
  readonly expiraEm: Date;
  readonly avaliacao?: AvaliacaoDaAnalise;
  readonly motivoDaAvaliacao?: MotivoDaAvaliacao;
}
