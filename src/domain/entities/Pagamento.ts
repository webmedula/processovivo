import type { CicloDoPlano } from './Plano.js';

/**
 * O vocabulário de cobrança do SISTEMA. O do gateway (`preapproval`, `authorized`, `charged_back`…)
 * morre na borda, no adapter — como o do CNJ morre em `datajud.mapper.ts`.
 */

/** Onde o gateway cobra de verdade. `falso` só existe em teste e desenvolvimento. */
export type AmbienteDoGateway = 'teste' | 'producao' | 'falso';

/**
 * O estado da RECORRÊNCIA no gateway (não do acesso: o acesso é da vigência em `Assinatura`).
 * `pendente`: criada, o comprador ainda não concluiu. `autorizada`: o meio de pagamento está
 * definido e o gateway cobra a cada ciclo. `pausada` e `cancelada`: sem nova cobrança.
 */
export type EstadoDaRecorrencia = 'pendente' | 'autorizada' | 'pausada' | 'cancelada';

/** O que acontece com uma cobrança, na linguagem do sistema. */
export type ResultadoDoPagamento =
  | 'aprovado'
  | 'recusado'
  | 'pendente'
  | 'estornado'
  | 'contestado';

/** Os meios de cobrança. A RECORRÊNCIA só aceita `cartao`; `pix` e `boleto` são da parte 2 (avulso). */
export type MeioDeCobranca = 'cartao' | 'pix' | 'boleto';

export interface PedidoDeAssinatura {
  /** Opaco e de uso único: vai ao gateway como `external_reference` e volta nas consultas. */
  readonly referencia: string;
  /** O texto que o comprador lê na página do gateway ("Processo Vivo — plano Peças"). */
  readonly motivo: string;
  /** O e-mail do pagador que o gateway exige. Nunca é gravado por nós. */
  readonly emailDoPagador: string;
  readonly valorEmCentavos: number;
  readonly ciclo: CicloDoPlano;
  readonly urlDeRetorno: string;
  readonly urlDeNotificacao: string;
  /** Repetir a criação com a mesma chave NÃO cria outra assinatura. */
  readonly chaveDeIdempotencia: string;
}

export interface CriacaoDeAssinatura {
  readonly id: string;
  readonly urlDeCheckout: string;
  readonly estado: EstadoDaRecorrencia;
}

export interface AssinaturaNoGateway {
  readonly id: string;
  readonly estado: EstadoDaRecorrencia;
  readonly referencia?: string;
  readonly proximaCobranca?: Date;
  readonly valorEmCentavos?: number;
}

/**
 * Uma cobrança (ou pagamento) já lida do gateway. `id` é a CHAVE ESTÁVEL de idempotência, escolhida
 * pelo adapter: a mesma cobrança tem o mesmo `id` venha o aviso pelo tópico que vier.
 */
export interface PagamentoNoGateway {
  readonly id: string;
  /** O id do PAGAMENTO no gateway (não o da parcela), quando já existe — é por ele que chega o estorno. */
  readonly pagamentoId?: string;
  readonly assinaturaId?: string;
  /** O `external_reference` que o gateway devolve, quando o devolve — outro caminho até o workspace. */
  readonly referencia?: string;
  readonly resultado: ResultadoDoPagamento;
  readonly valorEmCentavos: number;
  readonly ocorridoEm?: Date;
  /** Só o TIPO do meio ("cartao"); nunca bandeira, final de cartão ou nome. */
  readonly meio?: MeioDeCobranca;
}

/** Sobre o que o aviso é. O corpo do aviso NUNCA é fonte: só o id serve para consultar o gateway. */
export type TopicoDeWebhook = 'assinatura' | 'cobranca' | 'pagamento' | 'outro';

export interface EventoDeWebhook {
  readonly topico: TopicoDeWebhook;
  readonly recursoId: string;
}

/** O que a rota entrega ao gateway para validar: os valores BRUTOS, sem normalizar. */
export interface EntradaDeWebhook {
  /** Cabeçalho `x-signature`. */
  readonly assinatura: string | undefined;
  /** Cabeçalho `x-request-id`. */
  readonly idDaRequisicao: string | undefined;
  /** `data.id` da query string. */
  readonly idDoRecurso: string | undefined;
  /** O tipo do aviso (`type`/`topic`), como veio. */
  readonly topico: string | undefined;
}

/** Cobrança AVULSA — parte 2 (Pix e boleto por período). Só o formato; nada implementa ainda. */
export interface PedidoDeCobrancaAvulsa {
  readonly referencia: string;
  readonly motivo: string;
  readonly emailDoPagador: string;
  readonly valorEmCentavos: number;
  readonly meio: Exclude<MeioDeCobranca, 'cartao'>;
  readonly urlDeNotificacao: string;
  readonly chaveDeIdempotencia: string;
}
