/**
 * Cliente HTTP mínimo sobre o `fetch` nativo do Node (>= 18), com timeout e
 * retry com backoff exponencial + jitter.
 *
 * Sem axios/undici de propósito: a única coisa que faltava ao fetch nativo era
 * política de timeout e retry, e essa política é decisão do projeto — não de
 * uma dependência. O jitter evita que várias instâncias do serviço retentem em
 * uníssono contra um tribunal já sobrecarregado.
 */

export interface OpcoesHttpClient {
  readonly timeoutMs?: number;
  readonly tentativas?: number;
  readonly backoffInicialMs?: number;
  readonly headersPadrao?: Readonly<Record<string, string>>;
}

export interface RespostaHttp {
  readonly status: number;
  readonly ok: boolean;
  readonly corpo: string;
}

/**
 * Resposta em BYTES, para quando o corpo não é texto.
 *
 * Nasceu do MNI: a resposta vem em `multipart/related` com os PDFs das peças
 * como partes binárias. Lida como string, ela passa por decodificação UTF-8 —
 * que substitui todo byte inválido por U+FFFD e corrompe o arquivo de forma
 * irreversível, sem erro nenhum no caminho. O `content-type` vem junto porque é
 * dele que sai o boundary do multipart.
 */
export interface RespostaHttpBinaria {
  readonly status: number;
  readonly ok: boolean;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/**
 * Ajustes por requisição, sobrepondo os padrões do cliente.
 *
 * Existe porque nem toda chamada merece a mesma política. Uma consulta de
 * usuário compensa esperar e retentar; um health check, não — ele precisa
 * responder rápido, mesmo que a resposta seja "não sei".
 */
export interface OpcoesRequisicao {
  readonly timeoutMs?: number;
  readonly tentativas?: number;
}

export class HttpTimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`Timeout de ${timeoutMs}ms ao chamar ${url}`);
    this.name = 'HttpTimeoutError';
  }
}

export class HttpRedeError extends Error {
  constructor(readonly url: string, causa: unknown) {
    super(`Falha de rede ao chamar ${url}: ${descrever(causa)}`, { cause: causa });
    this.name = 'HttpRedeError';
  }
}

export class HttpClient {
  private readonly timeoutMs: number;
  private readonly tentativas: number;
  private readonly backoffInicialMs: number;
  private readonly headersPadrao: Record<string, string>;

  constructor(opcoes: OpcoesHttpClient = {}) {
    this.timeoutMs = opcoes.timeoutMs ?? 10_000;
    this.tentativas = Math.max(1, opcoes.tentativas ?? 3);
    this.backoffInicialMs = opcoes.backoffInicialMs ?? 300;
    this.headersPadrao = { ...opcoes.headersPadrao };
  }

  async postJson(
    url: string,
    corpo: unknown,
    headers: Record<string, string> = {},
    opcoes?: OpcoesRequisicao,
  ): Promise<RespostaHttp> {
    return this.executar(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...this.headersPadrao,
          ...headers,
        },
        body: JSON.stringify(corpo),
      },
      opcoes,
    );
  }

  /**
   * POST de XML com resposta em bytes — o formato que SOAP exige.
   *
   * Método próprio em vez de um parâmetro em `postJson` porque a diferença não é
   * só o `content-type`: é o caminho inteiro da resposta, que aqui NÃO pode
   * passar por `text()`. Ver `RespostaHttpBinaria`.
   */
  async postXml(
    url: string,
    xml: string,
    headers: Record<string, string> = {},
    opcoes?: OpcoesRequisicao,
  ): Promise<RespostaHttpBinaria> {
    return this.executarBinario(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/xml;charset=UTF-8',
          accept: 'text/xml, multipart/related, application/xop+xml',
          ...this.headersPadrao,
          ...headers,
        },
        body: xml,
      },
      opcoes,
    );
  }

  async get(
    url: string,
    headers: Record<string, string> = {},
    opcoes?: OpcoesRequisicao,
  ): Promise<RespostaHttp> {
    return this.executar(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', ...this.headersPadrao, ...headers },
      },
      opcoes,
    );
  }

  private async executar(
    url: string,
    init: RequestInit,
    opcoes?: OpcoesRequisicao,
  ): Promise<RespostaHttp> {
    return this.comRetry(url, init, opcoes, async (resposta) => ({
      status: resposta.status,
      ok: resposta.ok,
      corpo: await resposta.text(),
    }));
  }

  private async executarBinario(
    url: string,
    init: RequestInit,
    opcoes?: OpcoesRequisicao,
  ): Promise<RespostaHttpBinaria> {
    return this.comRetry(url, init, opcoes, async (resposta) => ({
      status: resposta.status,
      ok: resposta.ok,
      contentType: resposta.headers.get('content-type') ?? '',
      bytes: new Uint8Array(await resposta.arrayBuffer()),
    }));
  }

  /**
   * A política de timeout e retry, uma vez só.
   *
   * O que muda entre texto e bytes é a LEITURA do corpo, não quando retentar —
   * e duplicar o laço para trocar `text()` por `arrayBuffer()` garantiria que um
   * ajuste de backoff fosse aplicado em um caminho e esquecido no outro.
   */
  private async comRetry<T extends { readonly status: number }>(
    url: string,
    init: RequestInit,
    opcoes: OpcoesRequisicao | undefined,
    ler: (resposta: Response) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = opcoes?.timeoutMs ?? this.timeoutMs;
    const tentativas = Math.max(1, opcoes?.tentativas ?? this.tentativas);
    let ultimoErro: unknown;

    for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
      try {
        const resposta = await this.umaTentativa(url, init, timeoutMs, ler);

        // 5xx e 429 são transitórios: vale retentar. 4xx (exceto 429) é erro
        // nosso — retentar só queima cota.
        if (resposta.status >= 500 || resposta.status === 429) {
          ultimoErro = new Error(`HTTP ${resposta.status}`);
          if (tentativa < tentativas) {
            await this.esperar(tentativa);
            continue;
          }
        }
        return resposta;
      } catch (erro) {
        ultimoErro = erro;
        if (tentativa < tentativas) {
          await this.esperar(tentativa);
          continue;
        }
      }
    }

    if (ultimoErro instanceof HttpTimeoutError) throw ultimoErro;
    throw new HttpRedeError(url, ultimoErro);
  }

  private async umaTentativa<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    ler: (resposta: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resposta = await fetch(url, { ...init, signal: controller.signal });
      return await ler(resposta);
    } catch (erro) {
      if (erro instanceof Error && erro.name === 'AbortError') {
        throw new HttpTimeoutError(url, timeoutMs);
      }
      throw erro;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Backoff exponencial com jitter completo. */
  private esperar(tentativa: number): Promise<void> {
    const teto = this.backoffInicialMs * 2 ** (tentativa - 1);
    const atraso = Math.random() * teto;
    return new Promise((resolve) => setTimeout(resolve, atraso));
  }
}

function descrever(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return String(erro);
}
