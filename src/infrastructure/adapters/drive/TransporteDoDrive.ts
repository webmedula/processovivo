import { DestinoIndisponivelError } from '../../../domain/errors/index.js';
import type { HttpClient } from '../../http/HttpClient.js';

/**
 * O transporte HTTP do adapter do Drive: a única coisa que o teste troca.
 *
 * Existe como interface (e não como `fetch` solto) para o teste entregar respostas
 * escritas à mão, sem rede, e para o adapter ver `Location` e `Retry-After`, que o
 * `HttpClient` comum não devolve. Os cabeçalhos da resposta vêm em minúsculas.
 */
export interface PedidoDoTransporte {
  readonly metodo: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly corpo?: string | Uint8Array;
  readonly timeoutMs?: number;
}

export interface RespostaDoTransporte {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}

export interface TransporteDoDrive {
  requisitar(pedido: PedidoDoTransporte): Promise<RespostaDoTransporte>;
}

/**
 * O transporte de produção, sobre o `HttpClient` do projeto (timeout, sem dependência
 * nova). `tentativas: 1` de propósito: a política de repetição é do ADAPTER e do serviço,
 * que respeitam `Retry-After` e têm teto — o retry cego do cliente o ignoraria.
 *
 * Falha de rede ou timeout vira `DestinoIndisponivelError` SEM a mensagem original, que
 * carrega a URL (e, no upload resumível, o endereço da sessão).
 */
export class TransporteComHttpClient implements TransporteDoDrive {
  constructor(
    private readonly http: HttpClient,
    private readonly timeoutPadraoMs = 60_000,
  ) {}

  async requisitar(pedido: PedidoDoTransporte): Promise<RespostaDoTransporte> {
    try {
      const r = await this.http.requisitar(
        {
          metodo: pedido.metodo,
          url: pedido.url,
          ...(pedido.headers ? { headers: pedido.headers } : {}),
          ...(pedido.corpo !== undefined ? { corpo: pedido.corpo } : {}),
        },
        { tentativas: 1, timeoutMs: pedido.timeoutMs ?? this.timeoutPadraoMs },
      );
      return { status: r.status, headers: r.headers, bytes: r.bytes };
    } catch {
      throw new DestinoIndisponivelError(undefined);
    }
  }
}
