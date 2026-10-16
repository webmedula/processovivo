import { GatewayDePagamentoIndisponivelError } from '../../../domain/errors/index.js';
import type { HttpClient } from '../../http/HttpClient.js';

/** O transporte HTTP do adapter de pagamento: a única coisa que o teste troca. */
export interface PedidoDoGateway {
  readonly metodo: 'GET' | 'POST' | 'PUT';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly corpo?: string;
  readonly timeoutMs: number;
}

export interface RespostaDoGateway {
  readonly status: number;
  readonly corpo: string;
}

export interface TransporteDoGateway {
  requisitar(pedido: PedidoDoGateway): Promise<RespostaDoGateway>;
}

/**
 * Sobre o `HttpClient` do projeto. `tentativas: 1`: a política de repetição é do ADAPTER (só leitura
 * repete; criar e cancelar nunca), e o retry cego do cliente repetiria um POST.
 *
 * Falha de rede ou timeout vira `GatewayDePagamentoIndisponivelError` SEM a mensagem original, que
 * carrega a URL.
 */
export class TransporteComHttpClient implements TransporteDoGateway {
  constructor(
    private readonly http: HttpClient,
    private readonly nomeDoGateway: string,
  ) {}

  async requisitar(pedido: PedidoDoGateway): Promise<RespostaDoGateway> {
    try {
      const r = await this.http.requisitar(
        {
          metodo: pedido.metodo,
          url: pedido.url,
          headers: pedido.headers,
          ...(pedido.corpo !== undefined ? { corpo: pedido.corpo } : {}),
        },
        { tentativas: 1, timeoutMs: pedido.timeoutMs },
      );
      return { status: r.status, corpo: new TextDecoder().decode(r.bytes) };
    } catch {
      throw new GatewayDePagamentoIndisponivelError(this.nomeDoGateway, 'sem resposta');
    }
  }
}
