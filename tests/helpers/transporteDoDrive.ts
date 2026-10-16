import type {
  PedidoDoTransporte,
  RespostaDoTransporte,
  TransporteDoDrive,
} from '../../src/infrastructure/adapters/drive/TransporteDoDrive.js';
import type { ConteudoParaEnvio } from '../../src/domain/entities/DestinoDePecas.js';

/**
 * Valores SINTÉTICOS (o repositório é público): nenhum id, token ou segredo é real. Os
 * marcadores existem para os testes procurarem vazamento: se um deles aparecer num log, num
 * erro ou numa resposta, o teste vê.
 */
export const TOKEN_DE_ACESSO = 'ya29.TOKEN-DE-ACESSO-SINTETICO';
export const TOKEN_DE_RENOVACAO = '1//TOKEN-DE-RENOVACAO-SINTETICO';
export const CODIGO_DO_GOOGLE = 'CODIGO-DE-AUTORIZACAO-SINTETICO';
export const CLIENT_ID = 'cliente-sintetico.apps.googleusercontent.com';
export const CLIENT_SECRET = 'SEGREDO-DO-CLIENTE-SINTETICO';

type Roteiro =
  | RespostaDoTransporte
  | Error
  | ((p: PedidoDoTransporte) => RespostaDoTransporte | Promise<RespostaDoTransporte>);

/** Responde o que o teste escreveu, na ordem, e guarda cada pedido para conferência. */
export class TransporteFalso implements TransporteDoDrive {
  readonly pedidos: PedidoDoTransporte[] = [];
  private readonly fila: Roteiro[] = [];

  responder(...respostas: Roteiro[]): this {
    this.fila.push(...respostas);
    return this;
  }

  async requisitar(pedido: PedidoDoTransporte): Promise<RespostaDoTransporte> {
    this.pedidos.push(pedido);
    const r = this.fila.shift();
    if (r === undefined)
      throw new Error(`resposta não escrita para ${pedido.metodo} ${pedido.url}`);
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(pedido) : r;
  }

  get restantes(): number {
    return this.fila.length;
  }
}

export function resposta(
  status: number,
  corpo: unknown = {},
  headers: Record<string, string> = {},
): RespostaDoTransporte {
  const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  return { status, headers, bytes: new TextEncoder().encode(texto) };
}

/** O erro no formato do Google: só o `reason` interessa ao adapter; a mensagem é de enfeite. */
export function erroDoGoogle(
  status: number,
  reason: string,
  headers: Record<string, string> = {},
) {
  return resposta(
    status,
    {
      error: {
        code: status,
        message: 'MENSAGEM-DO-GOOGLE-NAO-PODE-VAZAR',
        errors: [{ reason }],
      },
    },
    headers,
  );
}

export function arquivoJson(
  id: string,
  extra: Record<string, unknown> = {},
): RespostaDoTransporte {
  return resposta(200, {
    id,
    webViewLink: `https://drive.google.com/drive/folders/${id}`,
    ...extra,
  });
}

export function tokenJson(extra: Record<string, unknown> = {}): RespostaDoTransporte {
  return resposta(200, {
    access_token: TOKEN_DE_ACESSO,
    expires_in: 3599,
    refresh_token: TOKEN_DE_RENOVACAO,
    scope: 'https://www.googleapis.com/auth/drive.file',
    token_type: 'Bearer',
    ...extra,
  });
}

/** Um arquivo em memória, lido em pedaços, como a guarda faz. */
export function conteudoDeBytes(
  bytes: Uint8Array,
  tamanhoDoPedaco = 7,
): ConteudoParaEnvio {
  return {
    tamanho: bytes.length,
    ler: async function* (inicio, fim) {
      for (let i = inicio; i <= fim; i += tamanhoDoPedaco) {
        yield bytes.slice(i, Math.min(i + tamanhoDoPedaco, fim + 1));
      }
    },
  };
}

export function bytesDeTexto(texto: string): Uint8Array {
  return new TextEncoder().encode(texto);
}

export function textoDoCorpo(p: PedidoDoTransporte): string {
  return typeof p.corpo === 'string'
    ? p.corpo
    : p.corpo
      ? new TextDecoder().decode(p.corpo)
      : '';
}
