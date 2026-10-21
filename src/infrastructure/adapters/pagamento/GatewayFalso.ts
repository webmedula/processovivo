import type {
  AmbienteDoGateway,
  AssinaturaNoGateway,
  CriacaoDeAssinatura,
  EntradaDeWebhook,
  EstadoDaRecorrencia,
  EventoDeWebhook,
  PagamentoNoGateway,
  PedidoDeAssinatura,
} from '../../../domain/entities/Pagamento.js';
import {
  GatewayDePagamentoIndisponivelError,
  GatewayDePagamentoRecusouError,
} from '../../../domain/errors/index.js';
import type { MotivoDoGateway } from '../../../domain/errors/index.js';
import type { Clock } from '../../../domain/ports/Clock.js';
import { clockDoSistema } from '../../../domain/ports/Clock.js';
import type { GatewayDePagamento } from '../../../domain/ports/GatewayDePagamento.js';
import { TOPICO_DO_AVISO } from './mercadoPago.constantes.js';
import { assinarAvisoParaTeste, validarAssinaturaDoWebhook } from './validacaoDeWebhook.js';

export const SEGREDO_DO_GATEWAY_FALSO = 'segredo-sintetico-do-gateway-falso';

interface AssinaturaFalsa {
  id: string;
  estado: EstadoDaRecorrencia;
  referencia: string;
  proximaCobranca?: Date;
  valorEmCentavos: number;
  cobrancas: PagamentoNoGateway[];
}

/**
 * Gateway sem rede, para teste e desenvolvimento. Guarda tudo em memória e deixa o teste CONTAR o que
 * aconteceu do outro lado (`pedidos`, `cancelamentos`, `consultas`) e DIRIGIR o que o "gateway" diz
 * (`definirEstado`, `registrarPagamento`). A conferência da assinatura do aviso é a REAL (mesmo HMAC),
 * com um segredo sintético, para os testes de rota exercitarem o caminho inteiro.
 */
export class GatewayFalso implements GatewayDePagamento {
  readonly nome = 'falso';
  readonly ambiente: AmbienteDoGateway = 'falso';
  readonly pedidos: PedidoDeAssinatura[] = [];
  readonly cancelamentos: string[] = [];
  consultas = 0;
  /** Faz a PRÓXIMA chamada de rede falhar, uma vez (teste do caminho de indisponibilidade). */
  falharProximaChamada: 'indisponivel' | 'recusou' | undefined;
  /** Faz TODO cancelamento falhar (a consulta segue normal), para testar a substituição de pendente. */
  falharCancelamentos = false;
  /** O motivo da PRÓXIMA recusa simulada (v0.45.1). */
  motivoDaRecusa: MotivoDoGateway = 'desconhecido';

  private readonly assinaturas = new Map<string, AssinaturaFalsa>();
  private readonly pagamentos = new Map<string, PagamentoNoGateway>();
  private readonly cobrancas = new Map<string, PagamentoNoGateway>();
  private contador = 0;
  private readonly clock: Clock;
  private readonly segredo: string;

  constructor(opcoes: { clock?: Clock; segredoDoWebhook?: string } = {}) {
    this.clock = opcoes.clock ?? clockDoSistema;
    this.segredo = opcoes.segredoDoWebhook ?? SEGREDO_DO_GATEWAY_FALSO;
  }

  async criarAssinatura(pedido: PedidoDeAssinatura): Promise<CriacaoDeAssinatura> {
    this.disparaFalha();
    // Mesma chave de idempotência = mesma assinatura, como no gateway de verdade.
    const existente = [...this.assinaturas.values()].find(
      (a) => a.referencia === pedido.referencia,
    );
    if (existente) {
      return {
        id: existente.id,
        urlDeCheckout: this.url(existente.id),
        estado: existente.estado,
      };
    }
    this.pedidos.push(pedido);
    const id = `fake-assinatura-${++this.contador}`;
    this.assinaturas.set(id, {
      id,
      estado: 'pendente',
      referencia: pedido.referencia,
      valorEmCentavos: pedido.valorEmCentavos,
      cobrancas: [],
    });
    return { id, urlDeCheckout: this.url(id), estado: 'pendente' };
  }

  async consultarAssinatura(id: string): Promise<AssinaturaNoGateway> {
    this.disparaFalha();
    this.consultas++;
    const a = this.achar(id);
    return {
      id: a.id,
      estado: a.estado,
      referencia: a.referencia,
      valorEmCentavos: a.valorEmCentavos,
      ...(a.proximaCobranca ? { proximaCobranca: a.proximaCobranca } : {}),
    };
  }

  async consultarCobranca(id: string): Promise<PagamentoNoGateway> {
    this.disparaFalha();
    this.consultas++;
    const p = this.cobrancas.get(id) ?? this.pagamentos.get(id);
    if (!p) throw new GatewayDePagamentoRecusouError(this.nome, 404, 'cobrança inexistente');
    return p;
  }

  async consultarPagamento(id: string): Promise<PagamentoNoGateway> {
    this.disparaFalha();
    this.consultas++;
    const p = this.pagamentos.get(id) ?? this.pagamentos.get(`pg:${id}`);
    if (!p) throw new GatewayDePagamentoRecusouError(this.nome, 404, 'pagamento inexistente');
    return p;
  }

  async listarCobrancasDaAssinatura(id: string): Promise<readonly PagamentoNoGateway[]> {
    this.disparaFalha();
    this.consultas++;
    return [...this.achar(id).cobrancas];
  }

  async cancelarAssinatura(id: string): Promise<void> {
    this.disparaFalha();
    if (this.falharCancelamentos) throw new GatewayDePagamentoIndisponivelError(this.nome, 'cancelamento simulado');
    this.achar(id).estado = 'cancelada';
    this.cancelamentos.push(id);
  }

  validarWebhook(entrada: EntradaDeWebhook): EventoDeWebhook {
    validarAssinaturaDoWebhook({
      assinatura: entrada.assinatura,
      idDaRequisicao: entrada.idDaRequisicao,
      idDoRecurso: entrada.idDoRecurso,
      segredo: this.segredo,
      agora: this.clock.agora(),
    });
    const topico = entrada.topico ? TOPICO_DO_AVISO[entrada.topico] : undefined;
    return { topico: topico ?? 'outro', recursoId: entrada.idDoRecurso ?? '' };
  }

  // --- o que o teste dirige ----------------------------------------------------------------------

  definirEstado(id: string, estado: EstadoDaRecorrencia, proximaCobranca?: Date): void {
    const a = this.achar(id);
    a.estado = estado;
    if (proximaCobranca) a.proximaCobranca = proximaCobranca;
  }

  /**
   * Registra um pagamento (ou parcela) para as consultas devolverem. `pagamento.id` é a chave de
   * idempotência; `idDaCobranca` é o id da PARCELA que o aviso de cobrança recorrente traz (sem ele,
   * a consulta de cobrança usa a própria chave).
   */
  registrarPagamento(
    assinaturaId: string,
    pagamento: PagamentoNoGateway,
    idDaCobranca?: string,
  ): void {
    const a = this.achar(assinaturaId);
    const completo: PagamentoNoGateway = { assinaturaId, ...pagamento };
    this.pagamentos.set(completo.id, completo);
    if (completo.pagamentoId) this.pagamentos.set(completo.pagamentoId, completo);
    if (idDaCobranca) this.cobrancas.set(idDaCobranca, completo);
    a.cobrancas.push(completo);
  }

  /** O cabeçalho `x-signature` que o gateway de verdade mandaria para este aviso. */
  assinarAviso(opcoes: {
    ts?: number;
    idDoRecurso?: string;
    idDaRequisicao?: string;
  }): string {
    return assinarAvisoParaTeste({
      segredo: this.segredo,
      ts: opcoes.ts ?? Math.floor(this.clock.agora().getTime() / 1000),
      ...(opcoes.idDoRecurso !== undefined ? { idDoRecurso: opcoes.idDoRecurso } : {}),
      ...(opcoes.idDaRequisicao !== undefined ? { idDaRequisicao: opcoes.idDaRequisicao } : {}),
    });
  }

  private url(id: string): string {
    return `https://pagamento-falso.exemplo.invalid/checkout/${id}`;
  }

  private achar(id: string): AssinaturaFalsa {
    const a = this.assinaturas.get(id);
    if (!a) throw new GatewayDePagamentoRecusouError(this.nome, 404, 'assinatura inexistente');
    return a;
  }

  private disparaFalha(): void {
    const falha = this.falharProximaChamada;
    this.falharProximaChamada = undefined;
    if (falha === 'indisponivel') {
      throw new GatewayDePagamentoIndisponivelError(this.nome, 'falha simulada');
    }
    if (falha === 'recusou') {
      throw new GatewayDePagamentoRecusouError(this.nome, 400, 'recusa simulada', {
        motivoDoGateway: this.motivoDaRecusa,
        diagnostico: {
          operacao: 'simulada',
          status: 400,
          erro: 'bad_request',
          causas: [{ codigo: '123', descricao: 'recusa simulada' }],
          camposEnviados: [],
        },
      });
    }
  }
}
