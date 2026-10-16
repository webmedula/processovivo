import type {
  AmbienteDoGateway,
  AssinaturaNoGateway,
  CriacaoDeAssinatura,
  EntradaDeWebhook,
  EventoDeWebhook,
  PagamentoNoGateway,
  PedidoDeAssinatura,
  PedidoDeCobrancaAvulsa,
} from '../entities/Pagamento.js';

/**
 * PORTA de pagamento. O resto do sistema só conhece esta interface; quem fala Mercado Pago é
 * `MercadoPagoAdapter`, e quem fala "nada" (teste e desenvolvimento) é `GatewayFalso`.
 *
 * **O gateway é a fonte da verdade do PAGAMENTO, e o webhook é só um despertador.** Nenhum método
 * aqui devolve estado tirado do corpo de um aviso: `validarWebhook` só prova que o aviso é do
 * gateway e diz o que consultar; o estado vem de `consultar*`. O acesso, por sua vez, continua
 * sendo da vigência em `Assinatura` — o pagamento aprovado apenas a renova, pelo mesmo `liberar`
 * do fluxo manual.
 *
 * Erros: só os de `domain/errors`. Falha de rede, timeout e 5xx do gateway são
 * `GatewayDePagamentoIndisponivelError`; o que o gateway recusa de forma definitiva é
 * `GatewayDePagamentoRecusouError`. Nada aqui carrega dado de cartão, token ou texto cru do gateway.
 */
export interface GatewayDePagamento {
  /** Estável: vai para log e para a coluna `gateway`. */
  readonly nome: string;
  readonly ambiente: AmbienteDoGateway;

  /**
   * Cria a recorrência e devolve a URL do checkout HOSPEDADA pelo gateway: o comprador paga lá e o
   * sistema nunca recebe nem guarda dado de cartão. NUNCA repete sozinho: a criação só é repetida
   * por quem chama, e então com a MESMA `chaveDeIdempotencia`.
   */
  criarAssinatura(pedido: PedidoDeAssinatura): Promise<CriacaoDeAssinatura>;

  consultarAssinatura(id: string): Promise<AssinaturaNoGateway>;

  /** A parcela recorrente (tópico de cobrança recorrente). */
  consultarCobranca(id: string): Promise<PagamentoNoGateway>;

  /** O pagamento em si (tópico de pagamento: aprovação, recusa, estorno). */
  consultarPagamento(id: string): Promise<PagamentoNoGateway>;

  /** As cobranças já geradas por uma assinatura — para a reconciliação, quando um aviso se perdeu. */
  listarCobrancasDaAssinatura(assinaturaId: string): Promise<readonly PagamentoNoGateway[]>;

  /** Encerra a RENOVAÇÃO. O que já foi pago continua valendo: quem decide isso é a vigência. */
  cancelarAssinatura(id: string): Promise<void>;

  /**
   * Confere a assinatura do aviso e devolve o que consultar. Não consulta a rede.
   * @throws {AssinaturaDeWebhookInvalidaError} ausente, malformada, adulterada ou velha demais.
   */
  validarWebhook(entrada: EntradaDeWebhook): EventoDeWebhook;

  /**
   * PARTE 2 (Pix e boleto avulsos, por período): o gancho está na porta para o resto do sistema não
   * mudar quando ela vier. Nenhum adapter implementa isto na v0.44.0; quem chama checa a existência.
   */
  criarCobrancaAvulsa?(pedido: PedidoDeCobrancaAvulsa): Promise<CriacaoDeAssinatura>;
}
