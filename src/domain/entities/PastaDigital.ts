import type { MotivoNaoObtida } from './JobLeitor.js';

/**
 * A Pasta digital (v0.33.0): a lista de TODAS as peças do processo e o estado
 * de cada uma, para o advogado abrir uma por vez em vez de montar o PDF inteiro.
 *
 * Estas são as formas de dado. Nada aqui guarda conteúdo de peça: o arquivo
 * mora no armazém, e o que circula (lista, resposta HTTP, log) é metadado.
 */

/**
 * O ato que juntou a peça, COMO O TRIBUNAL O ESCREVEU (v0.33.2).
 *
 * O vínculo é o da própria resposta do MNI: `<documento movimento="N">` aponta
 * para o `<movimento identificadorMovimento="N">` da mesma resposta. É a mesma
 * junção que a régua do processo usa — e a única que existe: número citado no
 * texto do ato ("ev. 382") é texto do cartório e não entra aqui.
 */
export interface MovimentacaoDaPeca {
  /**
   * `identificadorMovimento` do tribunal: CHAVE INTERNA do vínculo peça → ato.
   * NÃO é o número da movimentação que o advogado vê no Projudi (erro da
   * v0.33.2) e nunca sai na API nem na tela.
   */
  readonly numero: number;
  /**
   * Posição do ato (1-based) na ordem cronológica dos atos que o MNI entregou
   * (v0.34.0). Número CALCULADO por nós — pode ficar abaixo do do Projudi se
   * houver atos bloqueados que o MNI não entrega. Ausente em listagem gravada
   * antes da 0.34.0, até a tela recarregar as peças.
   */
  readonly posicao?: number;
  readonly data: Date;
  /** Descrição do ato, como o tribunal a deu. */
  readonly descricao: string;
  /** Complementos do ato (qualificadores), como vieram, separados por "; ". */
  readonly complemento?: string;
}

/** Uma peça como o tribunal a listou. Fica gravada: é a base dos pedidos. */
export interface PecaListada {
  readonly pecaId: string;
  /** Posição nos AUTOS (ordem do MNI achatada), não a do clique. */
  readonly ordem: number;
  readonly rotulo: string;
  readonly data?: Date;
  readonly movimento?: number;
  /**
   * O ato a que a peça pertence, quando a resposta do tribunal trouxe os dois
   * lados do vínculo. Ausente: a linha fica como sempre foi (listagens
   * gravadas antes da 0.33.2 também não têm).
   */
  readonly movimentacao?: MovimentacaoDaPeca;
  readonly mimetype?: string;
  /**
   * Sob sigilo na origem (`nivelSigilo > 0`). Quem decide é o TRIBUNAL, nunca
   * o navegador — por isso o pedido de uma peça confere o id contra esta
   * listagem e não contra o que o cliente disse sobre ela.
   */
  readonly sigilosa: boolean;
}

/**
 * O retrato da listagem do tribunal, gravado quando a tela carrega as peças do
 * processo. Abrir a Pasta lê DAQUI e não consulta o tribunal de novo: cada
 * consulta ao MNI são dezenas de segundos e uma oportunidade de recusa contra
 * a conta do advogado.
 */
export interface ListagemDaPasta {
  readonly numeroProcesso: string;
  readonly tribunal: string;
  readonly listadaEm: Date;
  /** O PROCESSO inteiro está sob segredo de justiça: nada dele é guardado. */
  readonly processoSigiloso: boolean;
  readonly pecas: readonly PecaListada[];
  /**
   * Quantos atos o MNI entregou na resposta que originou esta listagem
   * (v0.34.0): é o "N" do aviso da Pasta. Ausente em listagem anterior.
   */
  readonly totalAtosRecebidos?: number;
  /**
   * `dataHora` de cada ato recebido, na ordem das posições (v0.35.0). Base para
   * guardar e conferir a âncora de calibração sem consultar o tribunal. Ausente
   * em listagem anterior à 0.35.0: sem ela não se aceita âncora nova.
   */
  readonly datasDosAtos?: readonly Date[];
  /**
   * Quantas âncoras a ÚLTIMA listagem invalidou (o ato naquela posição mudou de
   * data). A tela avisa "calibração anterior invalidada" até a pessoa agir.
   */
  readonly ancorasInvalidadas?: number;
}

/** Par informado pelo advogado, com a data do ato para detectar listagem que mudou. */
export interface AncoraGuardada {
  readonly posicao: number;
  readonly numeroProjudi: number;
  readonly dataHoraDoAto: Date;
  readonly criadaEm: Date;
}

/** Como o arquivo guardado foi produzido a partir do que o tribunal entregou. */
export type ConversaoDaPeca = 'nenhuma' | 'imagem' | 'html';

/**
 * Uma peça na guarda por peça. O arquivo é SEMPRE um PDF legível: imagem e
 * HTML do tribunal são convertidos na entrada, e o HTML original não fica.
 */
export interface PecaEmCache {
  readonly workspace: string;
  readonly numeroProcesso: string;
  readonly pecaId: string;
  /** Localizador opaco, entendido só pelo armazém. Nunca vai para a resposta. */
  readonly localizador: string;
  /** O que o tribunal entregou (antes da conversão). */
  readonly mimetypeOriginal: string;
  readonly conversao: ConversaoDaPeca;
  /** O que a conversão deixou de fora; a tela diz que é conversão. */
  readonly observacao?: string;
  readonly bytes: number;
  readonly paginas: number;
  readonly obtidaEm: Date;
  readonly expiraEm: Date;
}

/** Os estados que a lista mostra (especificação, seção 6). */
export type EstadoDaPecaNaPasta =
  'nao_baixada' | 'na_fila' | 'baixando' | 'disponivel' | 'nao_obtida' | 'sigilo';

/** Por que uma peça não pôde ser obtida — os mesmos motivos do leitor. */
export type MotivoDaPasta = MotivoNaoObtida;
