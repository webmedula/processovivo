import { z } from 'zod';
import type {
  AmbienteDoGateway,
  AssinaturaNoGateway,
  CriacaoDeAssinatura,
  EntradaDeWebhook,
  EventoDeWebhook,
  MeioDeCobranca,
  PagamentoNoGateway,
  PedidoDeAssinatura,
} from '../../../domain/entities/Pagamento.js';
import {
  AssinaturaDeWebhookInvalidaError,
  GatewayDePagamentoIndisponivelError,
  GatewayDePagamentoRecusouError,
} from '../../../domain/errors/index.js';
import type { Clock } from '../../../domain/ports/Clock.js';
import { clockDoSistema } from '../../../domain/ports/Clock.js';
import type { GatewayDePagamento } from '../../../domain/ports/GatewayDePagamento.js';
import {
  BASE_DA_API,
  CAMINHOS,
  ESTADO_DA_ASSINATURA,
  MEIO_DO_PAGAMENTO,
  MOEDA,
  RESULTADO_DO_PAGAMENTO,
  STATUS_AO_CRIAR,
  STATUS_PARA_CANCELAR,
  TENTATIVAS_DE_LEITURA,
  TIMEOUT_DO_GATEWAY_MS,
  TIPO_DE_FREQUENCIA,
  TOPICO_DO_AVISO,
} from './mercadoPago.constantes.js';
import type { RespostaDoGateway, TransporteDoGateway } from './TransporteDoGateway.js';
import { validarAssinaturaDoWebhook } from './validacaoDeWebhook.js';
import { MESES_POR_CICLO } from '../../../domain/entities/Plano.js';

export const NOME_MERCADO_PAGO = 'mercadopago';

/*
 * Os esquemas leem SÓ o que o sistema usa. Campo a mais (nome, e-mail, CPF, final de cartão do
 * pagador) é ignorado pelo Zod e nunca chega ao domínio, ao banco nem ao log.
 */
const esquemaDaCriacao = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  init_point: z.string().url(),
});
const esquemaDaAssinatura = z.object({
  id: z.string().min(1),
  status: z.string(),
  external_reference: z.string().nullish(),
  next_payment_date: z.string().nullish(),
  auto_recurring: z.object({ transaction_amount: z.number().nullish() }).nullish(),
});
const esquemaDoPagamentoAninhado = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  status: z.string().optional(),
});
const esquemaDaCobranca = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  preapproval_id: z.string().nullish(),
  status: z.string().optional(),
  transaction_amount: z.number().nullish(),
  date_created: z.string().nullish(),
  last_modified: z.string().nullish(),
  external_reference: z.string().nullish(),
  payment: esquemaDoPagamentoAninhado.nullish(),
});
const esquemaDaBuscaDeCobrancas = z.object({ results: z.array(esquemaDaCobranca) });
const esquemaDoPagamento = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  status: z.string(),
  transaction_amount: z.number().nullish(),
  transaction_amount_refunded: z.number().nullish(),
  date_approved: z.string().nullish(),
  date_created: z.string().nullish(),
  payment_type_id: z.string().nullish(),
  external_reference: z.string().nullish(),
  metadata: z.object({ preapproval_id: z.string().nullish() }).passthrough().nullish(),
});

export interface OpcoesMercadoPagoAdapter {
  /** `MERCADOPAGO_ACCESS_TOKEN`. Nunca vai a log, resposta ou erro. */
  readonly accessToken: string;
  /** `MERCADOPAGO_WEBHOOK_SECRET`. Idem. */
  readonly segredoDoWebhook: string;
  /** Declarado em `PROCESSOVIVO_PAGAMENTO_AMBIENTE`; o prefixo do token NÃO o identifica. */
  readonly ambiente: 'teste' | 'producao';
  readonly transporte: TransporteDoGateway;
  readonly clock?: Clock;
  readonly baseDaApi?: string;
  /** Só para teste: sem espera entre as tentativas de leitura. */
  readonly esperar?: (tentativa: number) => Promise<void>;
}

const esperaPadrao = (tentativa: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 300 * 2 ** (tentativa - 1)));

function centavos(valor: number | null | undefined): number {
  return valor === null || valor === undefined ? 0 : Math.round(valor * 100);
}

function data(texto: string | null | undefined): Date | undefined {
  if (!texto) return undefined;
  const d = new Date(texto);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Mercado Pago por REST, sem o SDK (a dependência inteira só serviria para cinco chamadas, e o
 * `HttpClient` do projeto já dá timeout; o que o SDK tem de útil, a conferência da assinatura do aviso,
 * está reproduzido em `validacaoDeWebhook.ts` com a fonte citada).
 *
 * Regras que não mudam: o sistema NUNCA recebe nem guarda dado de cartão (o comprador paga na página
 * hospedada); só LEITURA repete sozinha; criação leva chave de idempotência e nunca repete aqui; nenhum
 * erro carrega token, segredo, corpo do gateway nem dado do pagador.
 */
export class MercadoPagoAdapter implements GatewayDePagamento {
  readonly nome = NOME_MERCADO_PAGO;
  readonly ambiente: AmbienteDoGateway;
  private readonly clock: Clock;
  private readonly base: string;
  private readonly esperar: (tentativa: number) => Promise<void>;

  constructor(private readonly opcoes: OpcoesMercadoPagoAdapter) {
    this.ambiente = opcoes.ambiente;
    this.clock = opcoes.clock ?? clockDoSistema;
    this.base = (opcoes.baseDaApi ?? BASE_DA_API).replace(/\/+$/, '');
    this.esperar = opcoes.esperar ?? esperaPadrao;
  }

  async criarAssinatura(pedido: PedidoDeAssinatura): Promise<CriacaoDeAssinatura> {
    const corpo = {
      reason: pedido.motivo,
      external_reference: pedido.referencia,
      payer_email: pedido.emailDoPagador,
      back_url: pedido.urlDeRetorno,
      notification_url: pedido.urlDeNotificacao,
      status: STATUS_AO_CRIAR,
      auto_recurring: {
        frequency: MESES_POR_CICLO[pedido.ciclo],
        frequency_type: TIPO_DE_FREQUENCIA,
        transaction_amount: Number((pedido.valorEmCentavos / 100).toFixed(2)),
        currency_id: MOEDA,
      },
    };
    const r = await this.chamar('POST', CAMINHOS.assinaturas, {
      corpo: JSON.stringify(corpo),
      idempotencia: pedido.chaveDeIdempotencia,
      repetirLeitura: false,
    });
    const lido = esquemaDaCriacao.safeParse(this.json(r));
    if (!lido.success) {
      throw new GatewayDePagamentoRecusouError(
        this.nome,
        r.status,
        'resposta sem o endereço do checkout',
      );
    }
    const estado = lido.data.status ? ESTADO_DA_ASSINATURA[lido.data.status] : undefined;
    return {
      id: lido.data.id,
      urlDeCheckout: lido.data.init_point,
      estado: estado ?? 'pendente',
    };
  }

  async consultarAssinatura(id: string): Promise<AssinaturaNoGateway> {
    const r = await this.chamar('GET', `${CAMINHOS.assinaturas}/${encodeURIComponent(id)}`);
    const lido = esquemaDaAssinatura.safeParse(this.json(r));
    if (!lido.success) {
      throw new GatewayDePagamentoRecusouError(this.nome, r.status, 'assinatura fora do contrato');
    }
    const estado = ESTADO_DA_ASSINATURA[lido.data.status];
    if (!estado) {
      throw new GatewayDePagamentoRecusouError(this.nome, r.status, 'status de assinatura desconhecido');
    }
    const proxima = data(lido.data.next_payment_date);
    const valor = lido.data.auto_recurring?.transaction_amount;
    return {
      id: lido.data.id,
      estado,
      ...(lido.data.external_reference ? { referencia: lido.data.external_reference } : {}),
      ...(proxima ? { proximaCobranca: proxima } : {}),
      ...(valor !== null && valor !== undefined ? { valorEmCentavos: centavos(valor) } : {}),
    };
  }

  async consultarCobranca(id: string): Promise<PagamentoNoGateway> {
    const r = await this.chamar('GET', `${CAMINHOS.cobrancas}/${encodeURIComponent(id)}`);
    const lido = esquemaDaCobranca.safeParse(this.json(r));
    if (!lido.success) {
      throw new GatewayDePagamentoRecusouError(this.nome, r.status, 'cobrança fora do contrato');
    }
    return this.daCobranca(lido.data);
  }

  async consultarPagamento(id: string): Promise<PagamentoNoGateway> {
    const r = await this.chamar('GET', `${CAMINHOS.pagamentos}/${encodeURIComponent(id)}`);
    const lido = esquemaDoPagamento.safeParse(this.json(r));
    if (!lido.success) {
      throw new GatewayDePagamentoRecusouError(this.nome, r.status, 'pagamento fora do contrato');
    }
    const p = lido.data;
    // Estorno parcial chega como `approved` com valor devolvido: para o sistema, é estorno.
    const devolvido = (p.transaction_amount_refunded ?? 0) > 0;
    const resultado = devolvido ? 'estornado' : RESULTADO_DO_PAGAMENTO[p.status];
    if (!resultado) {
      throw new GatewayDePagamentoRecusouError(this.nome, r.status, 'status de pagamento desconhecido');
    }
    const meio: MeioDeCobranca | undefined = p.payment_type_id
      ? MEIO_DO_PAGAMENTO[p.payment_type_id]
      : undefined;
    const quando = data(p.date_approved) ?? data(p.date_created);
    return {
      id: `pg:${p.id}`,
      pagamentoId: p.id,
      ...(p.metadata?.preapproval_id ? { assinaturaId: p.metadata.preapproval_id } : {}),
      ...(p.external_reference ? { referencia: p.external_reference } : {}),
      resultado,
      valorEmCentavos: centavos(p.transaction_amount),
      ...(quando ? { ocorridoEm: quando } : {}),
      ...(meio ? { meio } : {}),
    };
  }

  async listarCobrancasDaAssinatura(
    assinaturaId: string,
  ): Promise<readonly PagamentoNoGateway[]> {
    const r = await this.chamar(
      'GET',
      `${CAMINHOS.buscaDeCobrancas}?preapproval_id=${encodeURIComponent(assinaturaId)}`,
    );
    const lido = esquemaDaBuscaDeCobrancas.safeParse(this.json(r));
    if (!lido.success) {
      throw new GatewayDePagamentoRecusouError(this.nome, r.status, 'busca fora do contrato');
    }
    return lido.data.results.map((c) => this.daCobranca({ ...c, preapproval_id: assinaturaId }));
  }

  async cancelarAssinatura(id: string): Promise<void> {
    await this.chamar('PUT', `${CAMINHOS.assinaturas}/${encodeURIComponent(id)}`, {
      corpo: JSON.stringify({ status: STATUS_PARA_CANCELAR }),
      repetirLeitura: false,
    });
  }

  validarWebhook(entrada: EntradaDeWebhook): EventoDeWebhook {
    validarAssinaturaDoWebhook({
      assinatura: entrada.assinatura,
      idDaRequisicao: entrada.idDaRequisicao,
      idDoRecurso: entrada.idDoRecurso,
      segredo: this.opcoes.segredoDoWebhook,
      agora: this.clock.agora(),
    });
    // Sem id não há o que consultar: um aviso assinado sem `data.id` não serve a ninguém.
    if (entrada.idDoRecurso === undefined || entrada.idDoRecurso === '') {
      throw new AssinaturaDeWebhookInvalidaError('malformada');
    }
    const topico = entrada.topico ? TOPICO_DO_AVISO[entrada.topico] : undefined;
    return { topico: topico ?? 'outro', recursoId: entrada.idDoRecurso };
  }

  /**
   * A parcela recorrente → o pagamento do sistema. A chave de idempotência é o id do PAGAMENTO
   * quando a parcela já tem um aprovado/estornado (`pg:`), e o da PARCELA nos demais casos (`cob:`):
   * assim as tentativas recusadas de uma mesma parcela viram UM registro (e um e-mail), e o
   * pagamento aprovado depois é outro registro — e é o único que renova.
   */
  private daCobranca(c: z.infer<typeof esquemaDaCobranca>): PagamentoNoGateway {
    const pagamento = c.payment;
    const resultado = pagamento?.status ? RESULTADO_DO_PAGAMENTO[pagamento.status] : undefined;
    const desfecho = resultado ?? 'pendente';
    const comPagamento = pagamento && (desfecho === 'aprovado' || desfecho === 'estornado');
    const quando = data(c.last_modified) ?? data(c.date_created);
    return {
      id: comPagamento ? `pg:${pagamento.id}` : `cob:${c.id}`,
      ...(pagamento ? { pagamentoId: pagamento.id } : {}),
      ...(c.preapproval_id ? { assinaturaId: c.preapproval_id } : {}),
      ...(c.external_reference ? { referencia: c.external_reference } : {}),
      resultado: desfecho,
      valorEmCentavos: centavos(c.transaction_amount),
      ...(quando ? { ocorridoEm: quando } : {}),
    };
  }

  private json(r: RespostaDoGateway): unknown {
    try {
      return JSON.parse(r.corpo);
    } catch {
      throw new GatewayDePagamentoRecusouError(this.nome, r.status, 'resposta que não é JSON');
    }
  }

  /**
   * Uma chamada, com a política certa: só LEITURA repete (rede, timeout, 429, 5xx); criar e cancelar
   * NUNCA. 4xx definitivo vira `Recusou`; 401/403 diz "credencial" sem ecoar nada; 5xx/429/rede vira
   * `Indisponivel`.
   */
  private async chamar(
    metodo: 'GET' | 'POST' | 'PUT',
    caminho: string,
    extra: { corpo?: string; idempotencia?: string; repetirLeitura?: boolean } = {},
  ): Promise<RespostaDoGateway> {
    const repete = metodo === 'GET' && extra.repetirLeitura !== false;
    const tentativas = repete ? TENTATIVAS_DE_LEITURA : 1;
    let ultimo: unknown;
    for (let t = 1; t <= tentativas; t++) {
      try {
        const r = await this.opcoes.transporte.requisitar({
          metodo,
          url: `${this.base}${caminho}`,
          headers: {
            authorization: `Bearer ${this.opcoes.accessToken}`,
            accept: 'application/json',
            ...(extra.corpo !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(extra.idempotencia ? { 'x-idempotency-key': extra.idempotencia } : {}),
          },
          ...(extra.corpo !== undefined ? { corpo: extra.corpo } : {}),
          timeoutMs: TIMEOUT_DO_GATEWAY_MS,
        });
        if (r.status >= 500 || r.status === 429) {
          ultimo = new GatewayDePagamentoIndisponivelError(this.nome, `HTTP ${r.status}`);
        } else if (r.status === 401 || r.status === 403) {
          throw new GatewayDePagamentoRecusouError(this.nome, r.status, 'credencial recusada');
        } else if (r.status >= 400) {
          throw new GatewayDePagamentoRecusouError(this.nome, r.status, `HTTP ${r.status}`);
        } else {
          return r;
        }
      } catch (erro) {
        if (erro instanceof GatewayDePagamentoRecusouError) throw erro;
        ultimo = erro;
      }
      if (t < tentativas) await this.esperar(t);
    }
    if (ultimo instanceof GatewayDePagamentoIndisponivelError) throw ultimo;
    throw new GatewayDePagamentoIndisponivelError(this.nome, 'sem resposta');
  }
}
