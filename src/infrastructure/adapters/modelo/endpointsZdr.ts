import { z } from 'zod';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
} from '../../../domain/errors/index.js';
import type { HttpClient } from '../../http/HttpClient.js';

export const NOME_DO_OPENROUTER = 'openrouter';
export const URL_BASE_DO_OPENROUTER = 'https://openrouter.ai/api/v1';

/**
 * A lista pública de endpoints com retenção zero (ZDR) do OpenRouter e a lista
 * pública de modelos.
 *
 * Os campos usados foram tirados da referência da API e de um esquema de terceiros,
 * NÃO de uma captura real (a rede estava fechada quando isto foi escrito): por isso o
 * esquema é frouxo (`passthrough`, campos opcionais) e a falta do campo esperado vira
 * RECUSA, nunca palpite. `--listar-modelos-zdr` imprime os NOMES dos campos que viu
 * quando não consegue extrair modelo nenhum, para o ajuste ser de uma linha.
 */
const esquemaDoEndpoint = z
  .object({
    model_id: z.string().optional(),
    model_name: z.string().optional(),
    name: z.string().optional(),
    provider_name: z.string().optional(),
    tag: z.string().optional(),
    pricing: z
      .object({ prompt: z.unknown().optional(), completion: z.unknown().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const esquemaDaListaZdr = z.object({ data: z.array(esquemaDoEndpoint) }).passthrough();

const esquemaDosModelos = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string(),
          pricing: z.object({ prompt: z.unknown().optional() }).passthrough().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface EndpointZdr {
  readonly modelo: string;
  readonly provedor: string;
  readonly tag: string;
  /** USD por token, quando a lista informa. */
  readonly precoEntrada?: number;
  readonly precoSaida?: number;
}

export interface ModeloPublico {
  readonly id: string;
  readonly precoEntrada?: number;
}

/** Os nomes dos campos do primeiro item (nunca os valores): diagnóstico de formato inesperado. */
export interface ListaZdrLida {
  readonly endpoints: readonly EndpointZdr[];
  readonly itensRecebidos: number;
  readonly camposDoPrimeiroItem: readonly string[];
}

const numero = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Minúsculas e só letras/dígitos: "Amazon Bedrock" == "amazon-bedrock". */
export const normalizarNome = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function lerListaZdr(corpo: unknown): ListaZdrLida {
  const lido = esquemaDaListaZdr.safeParse(corpo);
  if (!lido.success) {
    throw new RespostaInvalidaError(
      NOME_DO_OPENROUTER,
      'a lista de endpoints ZDR veio em formato inesperado',
    );
  }
  const endpoints: EndpointZdr[] = [];
  for (const e of lido.data.data) {
    const modelo = e.model_id?.trim();
    const provedor = (e.provider_name ?? '').trim();
    const tag = (e.tag ?? '').trim();
    if (!modelo || (provedor === '' && tag === '')) continue;
    const entrada = numero(e.pricing?.prompt);
    const saida = numero(e.pricing?.completion);
    endpoints.push({
      modelo,
      provedor,
      tag,
      ...(entrada !== undefined ? { precoEntrada: entrada } : {}),
      ...(saida !== undefined ? { precoSaida: saida } : {}),
    });
  }
  const primeiro = lido.data.data[0];
  return {
    endpoints,
    itensRecebidos: lido.data.data.length,
    camposDoPrimeiroItem: primeiro ? Object.keys(primeiro).sort() : [],
  };
}

export function lerModelosPublicos(corpo: unknown): ModeloPublico[] {
  const lido = esquemaDosModelos.safeParse(corpo);
  if (!lido.success) {
    throw new RespostaInvalidaError(
      NOME_DO_OPENROUTER,
      'a lista de modelos veio em formato inesperado',
    );
  }
  return lido.data.data.map((m) => {
    const p = numero(m.pricing?.prompt);
    return { id: m.id, ...(p !== undefined ? { precoEntrada: p } : {}) };
  });
}

async function buscarJson(
  http: HttpClient,
  url: string,
  chave?: string,
): Promise<unknown> {
  let resposta;
  try {
    resposta = await http.get(url, chave ? { authorization: `Bearer ${chave}` } : {});
  } catch {
    // Mensagem fixa: a causa de baixo pode trazer a URL, e o cabeçalho nunca entra em texto de erro.
    throw new ProviderIndisponivelError(
      NOME_DO_OPENROUTER,
      'falha de rede ao consultar a lista pública',
    );
  }
  if (!resposta.ok) {
    throw new ProviderIndisponivelError(
      NOME_DO_OPENROUTER,
      resposta.status === 401 || resposta.status === 403
        ? `chave recusada pela lista de endpoints (HTTP ${resposta.status})`
        : `a lista pública respondeu HTTP ${resposta.status}`,
    );
  }
  try {
    return JSON.parse(resposta.corpo) as unknown;
  } catch {
    throw new RespostaInvalidaError(
      NOME_DO_OPENROUTER,
      'a lista pública não veio em JSON',
    );
  }
}

/** Precisa da chave (a referência da API exige o cabeçalho de autorização); não envia texto de caso. */
export async function buscarEndpointsZdr(
  http: HttpClient,
  chave: string,
): Promise<ListaZdrLida> {
  return lerListaZdr(
    await buscarJson(http, `${URL_BASE_DO_OPENROUTER}/endpoints/zdr`, chave),
  );
}

/** Lista pública de modelos (sem chave). Só usada pelo teste de falha fechada. */
export async function buscarModelosPublicos(http: HttpClient): Promise<ModeloPublico[]> {
  return lerModelosPublicos(await buscarJson(http, `${URL_BASE_DO_OPENROUTER}/models`));
}

// --- consultas puras sobre a lista -------------------------------------------------

/** Ids de modelo com ao menos um endpoint ZDR, ordenados; `filtro` casa por texto, sem caixa. */
export function modelosComZdr(
  endpoints: readonly EndpointZdr[],
  filtro?: string,
): string[] {
  const f = filtro?.trim().toLowerCase();
  const ids = new Set(endpoints.map((e) => e.modelo));
  return [...ids].filter((id) => !f || id.toLowerCase().includes(f)).sort();
}

export function modeloTemZdr(endpoints: readonly EndpointZdr[], modelo: string): boolean {
  return endpoints.some((e) => e.modelo === modelo);
}

/**
 * O provedor que serviu a chamada consta entre os endpoints ZDR DESTE modelo? Compara o
 * nome devolvido pela resposta com `provider_name` e com `tag` (inteira e só o trecho
 * antes de "/"), sem caixa nem pontuação. Nome ausente ou desconhecido = NÃO confirmado.
 */
export function provedorConfirmadoZdr(
  endpoints: readonly EndpointZdr[],
  modelo: string,
  provedor: string | undefined,
): boolean {
  const servido = normalizarNome(provedor ?? '');
  if (servido === '') return false;
  return endpoints
    .filter((e) => e.modelo === modelo)
    .some((e) =>
      [e.provedor, e.tag, e.tag.split('/')[0] ?? ''].some(
        (nome) => nome !== '' && normalizarNome(nome) === servido,
      ),
    );
}

/** Preço de ESTIMATIVA por modelo: o MAIOR entre os endpoints ZDR (conservador). */
export function precosEstimados(
  endpoints: readonly EndpointZdr[],
): Map<string, { entrada: number; saida: number }> {
  const mapa = new Map<string, { entrada: number; saida: number }>();
  for (const e of endpoints) {
    if (e.precoEntrada === undefined || e.precoSaida === undefined) continue;
    const atual = mapa.get(e.modelo);
    mapa.set(e.modelo, {
      entrada: Math.max(atual?.entrada ?? 0, e.precoEntrada),
      saida: Math.max(atual?.saida ?? 0, e.precoSaida),
    });
  }
  return mapa;
}
