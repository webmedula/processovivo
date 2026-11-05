import type {
  AvaliacaoDaAnalise,
  MedidasDaAnalise,
  MotivoDaAvaliacao,
  ProcedenciaDaAnalise,
} from './AnaliseDoAto.js';
import type { TipoDePeca } from './AnaliseDePeca.js';

/**
 * Análise do PROCESSO pelas peças (v0.66.0; especificação `ia-analise-do-processo` v1.0.0).
 *
 * Duas etapas, por decisão do dono (29/10/2026): (1) cada peça escolhida passa pela análise de peça de
 * sempre (`ServicoAnaliseDePeca`), e (2) uma SÍNTESE cruza só os resultados JÁ VERIFICADOS da etapa 1.
 * O modelo da síntese nunca vê texto de peça: vê os itens curtos da etapa 1, com marcadores, cada um com
 * um identificador (`P2.pedido1`). Ele não escreve citação; aponta identificadores, e o sistema copia o
 * trecho e a página do resultado da etapa 1. Por isso a síntese não tem como inventar citação.
 *
 * O que fica gravado é o resultado da síntese COM MARCADORES e só com identificadores de item — nenhum
 * texto de peça, nenhum trecho a mais do que a etapa 1 já guarda —, pelo mesmo prazo da análise de peça.
 */

/** Decisão do dono: no máximo 20 peças por análise. */
export const LIMITE_DE_PECAS_DA_ANALISE_DO_PROCESSO = 20;
/** Sem duas peças lidas não há o que cruzar. */
export const MINIMO_DE_PECAS_LIDAS_PARA_A_SINTESE = 2;
/** Decisão do dono: a síntese pesa 5 no teto técnico diário (além de 5 por peça NOVA da etapa 1). */
export const PESO_DA_SINTESE_NO_TETO = 5;

export const LIMITES_DA_SINTESE = Object.freeze({
  objeto: 240,
  texto: 200,
  pedidos: 10,
  linhaDoTempo: 12,
  controvertidos: 6,
  refsPorItem: 6,
});

/**
 * De que lado vem a peça, pelo TIPO que a etapa 1 verificou. É o que permite à verificação conferir que
 * uma "defesa" vem da defesa e que um ponto controvertido junta lados diferentes. `outro` = não se sabe.
 */
export type LadoDaPeca = 'autor' | 'reu' | 'juizo' | 'outro';

export function ladoDoTipo(tipo: TipoDePeca): LadoDaPeca {
  if (tipo === 'peticao_inicial' || tipo === 'replica') return 'autor';
  if (tipo === 'contestacao') return 'reu';
  if (tipo === 'despacho' || tipo === 'decisao' || tipo === 'sentenca' || tipo === 'acordao') {
    return 'juizo';
  }
  return 'outro';
}

/**
 * As categorias de item da etapa 1 que entram na síntese (`resumo` é a frase única da peça; documentos ficam
 * no bloco próprio, montado pelo sistema, sem modelo).
 */
export const CATEGORIAS_DE_ITEM = [
  'resumo',
  'pedido',
  'alegacao',
  'preliminar',
  'determinacao',
  'valor',
] as const;
export type CategoriaDeItem = (typeof CATEGORIAS_DE_ITEM)[number];

/** Um item da síntese: o texto escrito pelo modelo e os identificadores dos itens da etapa 1 que o sustentam. */
export interface ItemDaSintese {
  readonly texto: string;
  readonly refs: readonly string[];
}

export interface PedidoDaSintese extends ItemDaSintese {
  readonly defesa: ItemDaSintese | null;
  readonly decisao: ItemDaSintese | null;
}

/** O que o modelo devolve, dentro do esquema e ANTES da verificação. É dado de fonte externa. */
export interface RespostaDoModeloDaSintese {
  readonly objeto: ItemDaSintese;
  readonly pedidos: readonly PedidoDaSintese[];
  readonly linha_do_tempo: readonly ItemDaSintese[];
  readonly pontos_controvertidos: readonly ItemDaSintese[];
}

/** O resultado já verificado, ainda com marcadores. */
export type ResultadoDaSintese =
  | {
      readonly estado: 'verificada';
      readonly objeto: ItemDaSintese;
      readonly pedidos: readonly PedidoDaSintese[];
      readonly linhaDoTempo: readonly ItemDaSintese[];
      readonly controvertidos: readonly ItemDaSintese[];
    }
  | {
      readonly estado: 'nao_verificada';
      readonly motivo: 'sem_objeto_verificado';
    };

/** Contagens da síntese: só números. */
export interface ContagensDaSintese {
  readonly pecas: number;
  readonly itensEnviados: number;
  readonly itensDescartados: number;
  readonly peso: number;
}

export interface SinteseDoProcesso {
  readonly id: string;
  readonly workspace: string;
  /** A mesma chave opaca da análise de peça (SHA-256 de conta + número): o número CNJ não é gravado. */
  readonly processoChave: string;
  /**
   * SHA-256 das análises de peça usadas (ids, em ordem), da versão do prompt e do modelo: a mesma
   * seleção, com as mesmas análises, volta do banco sem chamar o modelo.
   */
  readonly chaveDaSelecao: string;
  /** Os ids das análises de peça da etapa 1, na ordem em que receberam `P1`, `P2`… */
  readonly analises: readonly string[];
  readonly resultado: ResultadoDaSintese;
  readonly contagens: ContagensDaSintese;
  readonly procedencia: ProcedenciaDaAnalise;
  readonly modeloPedido: string;
  readonly medidas: MedidasDaAnalise;
  readonly criadaEm: Date;
  readonly expiraEm: Date;
  readonly avaliacao?: AvaliacaoDaAnalise;
  readonly motivoDaAvaliacao?: MotivoDaAvaliacao;
}
