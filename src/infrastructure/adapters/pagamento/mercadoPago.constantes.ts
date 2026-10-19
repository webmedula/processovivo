import type {
  EstadoDaRecorrencia,
  MeioDeCobranca,
  ResultadoDoPagamento,
  TopicoDeWebhook,
} from '../../../domain/entities/Pagamento.js';

/**
 * TUDO o que é "o jeito do Mercado Pago" e ainda pode precisar de ajuste depois do primeiro teste com
 * credenciais de verdade mora aqui, num arquivo só: caminhos, valores de status, tópicos, tolerância.
 * Os itens marcados `CONFIRMAR` vêm da documentação lida de segunda mão (a página oficial não estava
 * acessível ao escrever isto) e entram no roteiro de teste do dono.
 */

export const BASE_DA_API = 'https://api.mercadopago.com';

export const CAMINHOS = {
  /** Criar (POST), consultar (GET) e alterar/cancelar (PUT `/{id}`) a assinatura. */
  assinaturas: '/preapproval',
  /** A parcela recorrente: GET `/{id}`. */
  cobrancas: '/authorized_payments',
  /** CONFIRMAR: a busca das parcelas de uma assinatura (`?preapproval_id=`), usada na reconciliação. */
  buscaDeCobrancas: '/authorized_payments/search',
  /** O pagamento em si: GET `/{id}`. */
  pagamentos: '/v1/payments',
} as const;

/** CONFIRMAR: o valor que cancela a recorrência (`PUT /preapproval/{id}`). Pausar seria `paused`. */
export const STATUS_PARA_CANCELAR = 'cancelled';

/**
 * Criação SEM plano e com pagamento PENDENTE: a assinatura nasce sem meio de pagamento e o comprador o
 * define na página hospedada (o sistema nunca vê cartão). É o único valor aceito nesse modelo.
 */
export const STATUS_AO_CRIAR = 'pending';

/** `frequency_type` da criação. CONFIRMAR se o ciclo anual aceita `months` com `frequency: 12`. */
export const TIPO_DE_FREQUENCIA = 'months';
export const MOEDA = 'BRL';

/** O status da assinatura no Mercado Pago → o do sistema. Status desconhecido NÃO é mapeado (erro). */
export const ESTADO_DA_ASSINATURA: Readonly<Record<string, EstadoDaRecorrencia>> =
  Object.freeze({
    pending: 'pendente',
    authorized: 'autorizada',
    paused: 'pausada',
    cancelled: 'cancelada',
  });

/** O status do PAGAMENTO → o resultado do sistema. CONFIRMAR `authorized` (cartão pré-autorizado). */
export const RESULTADO_DO_PAGAMENTO: Readonly<Record<string, ResultadoDoPagamento>> =
  Object.freeze({
    approved: 'aprovado',
    authorized: 'pendente',
    pending: 'pendente',
    in_process: 'pendente',
    in_mediation: 'contestado',
    rejected: 'recusado',
    cancelled: 'recusado',
    refunded: 'estornado',
    charged_back: 'contestado',
  });

/** O tipo do meio de pagamento → o meio do sistema. A recorrência só conhece `cartao`. */
export const MEIO_DO_PAGAMENTO: Readonly<Record<string, MeioDeCobranca>> = Object.freeze({
  credit_card: 'cartao',
  debit_card: 'cartao',
  prepaid_card: 'cartao',
  bank_transfer: 'pix',
  ticket: 'boleto',
});

/** O `type` do aviso → o tópico do sistema. */
export const TOPICO_DO_AVISO: Readonly<Record<string, TopicoDeWebhook>> = Object.freeze({
  subscription_preapproval: 'assinatura',
  subscription_authorized_payment: 'cobranca',
  payment: 'pagamento',
});

/** Segundos de diferença aceitos entre o `ts` do aviso e o relógio do servidor (o mesmo do SDK oficial). */
export const TOLERANCIA_DO_AVISO_SEGUNDOS = 300;

/**
 * Prefixo antigo das credenciais de TESTE. NÃO identifica o ambiente: o Mercado Pago passou a emitir
 * credencial de teste com `APP_USR-` (v0.44.1). Serve só para recusar a contradição `TEST-` + `producao`.
 */
export const PREFIXO_DO_TOKEN_DE_TESTE = 'TEST-';

/** Leituras (GET) repetem até este número de tentativas; a criação e o cancelamento NUNCA repetem sozinhos. */
export const TENTATIVAS_DE_LEITURA = 3;
export const TIMEOUT_DO_GATEWAY_MS = 15_000;
