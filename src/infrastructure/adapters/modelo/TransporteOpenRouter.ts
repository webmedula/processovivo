import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { APICallError, generateText, NoObjectGeneratedError, Output } from 'ai';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
  roteamentoDaFalha,
  SemProvedorQueAtendaError,
  ZdrIndisponivelError,
} from '../../../domain/errors/index.js';
import { esquemaDaResposta } from './esquemaDaAnalise.js';
import { sanearCorpoEnviado } from './diagnosticoDeChamada.js';
import { ehApelidoOuVariante, NOME_DO_OPENROUTER } from './endpointsZdr.js';
import { ehFiltroDePoliticaDeDados, extrairRoteamento } from './roteamentoDoErro.js';

/**
 * Transporte até o modelo de linguagem (infraestrutura, injetável): o OpenRouter, com
 * retenção zero de dados (ZDR) em TODA chamada.
 *
 * Um transporte direto (chave do provedor do modelo) caberia atrás da mesma interface,
 * mas só será escrito quando houver uma razão: código sem uso é código sem teste.
 */
export interface PedidoAoModelo {
  /** Id de um modelo REAL. Apelido (`~…`) e variante (`:…`) são recusados antes de qualquer rede. */
  readonly modelo: string;
  readonly sistema: string;
  readonly usuario: string;
  /**
   * Os provedores a que a chamada fica RESTRITA (`provider.only`, em slugs): os que a lista ZDR
   * indica para este modelo. Obrigatório e não vazio — restringir ANTES de enviar é o que
   * impede o texto de chegar a quem não tem ZDR; conferir depois da resposta não impede.
   */
  readonly provedoresPermitidos: readonly string[];
  /** Cancelamento (a pessoa fechou a tela): aborta a chamada em curso e impede nova tentativa. */
  readonly sinal?: AbortSignal;
  /** Chamado a cada repetição automática da chamada (painel de IA, v0.58.0). Só conta; nunca recebe texto. */
  readonly aoRepetir?: () => void;
  /**
   * Instrução do formato da saída em texto (v0.40.0). Ausente = a do ato
   * (`INSTRUCAO_DE_FORMATO_EM_TEXTO`). O resumo de processo manda a dele.
   */
  readonly instrucaoDeFormato?: string;
  /** Teto de tokens de saída deste pedido; ausente = o dos ajustes. Nada aqui toca a ZDR. */
  readonly maxTokens?: number;
  /** Tempo limite deste pedido; ausente = o do transporte. */
  readonly timeoutMs?: number;
}

/** O que a chamada deixou de rastro, SEM texto e SEM chave (ver `diagnosticoDeChamada.ts`). */
export interface DiagnosticoDaChamada {
  /** O corpo enviado, com o conteúdo das mensagens trocado por marcador de tamanho. */
  readonly corpoEnviado: unknown;
  /** Campo `model` da resposta: o modelo que de fato serviu (um apelido se resolve aqui). */
  readonly modeloResolvido?: string;
  /** Campo `provider` da resposta. */
  readonly provedorDaResposta?: string;
  /** NOMES dos campos do `usage` da resposta (nunca valores): mostra de onde o custo poderia sair. */
  readonly camposDoUsage?: readonly string[];
}

export interface RespostaDoTransporte {
  /** Saída estruturada do modelo, ainda como dado externo (`unknown`). */
  readonly objeto: unknown;
  /** Quem de fato serviu a chamada, como a resposta informa. Vazio/ausente = desconhecido. */
  readonly provedor?: string;
  /** O modelo que a resposta diz ter servido (campo `model`). A conferência ZDR usa ESTE, não o pedido. */
  readonly modeloResolvido?: string;
  readonly diagnostico: DiagnosticoDaChamada;
  readonly tokensEntrada?: number;
  readonly tokensSaida?: number;
  /** Tokens de raciocínio, quando o modelo os informa (fazem parte de `tokensSaida`). */
  readonly tokensRaciocinio?: number;
  /** `usage.cost` da resposta (créditos do OpenRouter = USD), quando vem. */
  readonly custoUsd?: number;
}

export interface TransporteDeModelo {
  readonly nome: string;
  gerar(pedido: PedidoAoModelo): Promise<RespostaDoTransporte>;
}

/**
 * As preferências de roteamento. `zdr` restringe o roteamento a endpoints com retenção zero e
 * `data_collection: 'deny'` exclui quem guarda dado para treino — estes dois são FIXOS e
 * obrigatórios em TODA chamada, inclusive nas de diagnóstico. `allow_fallbacks: false` porque a
 * documentação consultada não afirma que os provedores de reserva respeitem a ZDR.
 * `require_parameters` e `only` são o que a chamada normal sempre leva; só o diagnóstico em
 * degraus (`gerarDiagnostico`) pode tirá-los, nunca a ZDR.
 */
export interface PreferenciasDeProvedor {
  readonly zdr: true;
  readonly data_collection: 'deny';
  readonly allow_fallbacks: false;
  readonly require_parameters?: true;
  /** Slugs permitidos (`provider.only`): só os endpoints ZDR do modelo, segundo a lista. */
  readonly only?: readonly string[];
}

/** A parte fixa; `only` é acrescentado por chamada, a partir do pedido. */
export const PREFERENCIAS_BASE_DE_PROVEDOR = Object.freeze({
  zdr: true,
  data_collection: 'deny',
  allow_fallbacks: false,
  require_parameters: true,
} as const);

/**
 * Raciocínio do modelo (parâmetro `reasoning` do OpenRouter). `padrao` não envia nada. Os formatos
 * vêm dos tipos do SDK (`effort`: none | minimal | low | …; `enabled`); qual o modelo aceita varia.
 */
export const NIVEIS_DE_RACIOCINIO = [
  'padrao',
  'desligado',
  'nenhum',
  'minimo',
  'baixo',
] as const;
export type NivelDeRaciocinio = (typeof NIVEIS_DE_RACIOCINIO)[number];

export function corpoDoRaciocinio(
  nivel: NivelDeRaciocinio,
): Record<string, unknown> | undefined {
  switch (nivel) {
    case 'padrao':
      return undefined;
    case 'desligado':
      return { enabled: false };
    case 'nenhum':
      return { effort: 'none' };
    case 'minimo':
      return { effort: 'minimal' };
    case 'baixo':
      return { effort: 'low' };
  }
}

/** Ajustes de desempenho. Nada aqui toca a ZDR. */
export interface AjustesDeDesempenho {
  readonly raciocinio?: NivelDeRaciocinio;
  readonly maxTokens?: number;
}

/** Como a saída é pedida: esquema JSON estrito (`json_schema`) ou instrução no texto, validada por nós. */
export type ModoDeSaida = 'esquema' | 'texto';

/** O que vai ao SDK. Tipo próprio para o teste enxergar CADA chamada. */
export interface ChamadaAoSdk {
  readonly modelo: string;
  readonly sistema: string;
  readonly usuario: string;
  readonly temperatura: 0;
  readonly tentativasAutomaticas: 0;
  readonly timeoutMs: number;
  readonly provider: PreferenciasDeProvedor;
  readonly saida: ModoDeSaida;
  readonly raciocinio?: Record<string, unknown>;
  readonly maxTokens?: number;
  readonly sinal?: AbortSignal;
}

export interface ResultadoBrutoDoSdk {
  readonly objeto: unknown;
  readonly provedor?: string | undefined;
  readonly modeloResolvido?: string | undefined;
  /** O corpo enviado, ainda CRU: o transporte o sanea antes de devolver. */
  readonly corpoEnviado?: unknown;
  readonly tokensEntrada?: number | undefined;
  readonly tokensSaida?: number | undefined;
  readonly tokensRaciocinio?: number | undefined;
  readonly custoUsd?: number | undefined;
  readonly camposDoUsage?: readonly string[] | undefined;
}

export type ExecutorDoSdk = (chamada: ChamadaAoSdk) => Promise<ResultadoBrutoDoSdk>;

/** Status, corpo e roteamento do erro do OpenRouter. SÓ para os controles, com texto sintético. */
export interface DetalheDeErro {
  readonly status?: number;
  readonly corpo?: string;
  /** O corpo que foi enviado, já saneado (sem texto, sem chave). */
  readonly corpoEnviado?: unknown;
  /** `failed_routing_step` do erro, quando o corpo o traz. */
  readonly passo?: string;
  /** `routing_funnel` do erro, quando o corpo o traz. */
  readonly funil?: unknown;
}

export interface OpcoesDoTransporteOpenRouter {
  readonly chave: string;
  readonly timeoutMs?: number;
  readonly ajustes?: AjustesDeDesempenho;
  /** Para teste. Em produção, o SDK. */
  readonly executar?: ExecutorDoSdk;
  /** Para teste de fio: intercepta o HTTP do SDK (o que de fato sai da máquina). */
  readonly fetch?: typeof fetch;
  /** Esperas antes da 2ª e da 3ª tentativas (só 429/5xx/rede). Padrão 1 s e 3 s. */
  readonly esperasEntreTentativasMs?: readonly [number, number];
  readonly dormir?: (ms: number) => Promise<void>;
  /** Recebe status e corpo de cada erro. Nunca ligado numa rodada com caso real. */
  readonly aoFalhar?: (detalhe: DetalheDeErro) => void;
}

/** Os degraus do diagnóstico: cada um tira UMA coisa a mais da chamada. A ZDR nunca sai. */
export const DEGRAUS = ['A', 'B', 'C', 'D'] as const;
export type Degrau = (typeof DEGRAUS)[number];

export const DESCRICAO_DOS_DEGRAUS: Readonly<Record<Degrau, string>> = Object.freeze({
  A: 'esquema estrito (require_parameters, json_schema estrito, provider.only): a chamada de produção até a 0.38.3, hoje só termo de comparação',
  B: 'sem require_parameters',
  C: 'sem json_schema estrito (instrução no texto; validado por nós): a chamada de produção desde a 0.38.4',
  D: 'sem provider.only (zdr continua true)',
});

/** Acrescentada ao sistema quando a saída é pedida "no texto" (degrau C em diante). */
export const INSTRUCAO_DE_FORMATO_EM_TEXTO =
  'FORMATO DA RESPOSTA: responda SOMENTE com um objeto JSON, sem texto antes ou depois e sem cercas de código, com exatamente as chaves parece_pedir, resumo, trecho_chave, acoes_possiveis (lista de objetos {acao}, sem citação) e pontos_de_atencao (lista de códigos) e, opcionalmente, prazo ({dias, tipo} ou null).';

const TIMEOUT_PADRAO_MS = 60_000;
const ESPERAS_PADRAO_MS = [1_000, 3_000] as const;

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function numero(valor: unknown): number | undefined {
  const n = typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : valor;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Tira o primeiro objeto JSON de um texto (cercas de código e frases em volta são toleradas). */
export function jsonDoTexto(texto: string): unknown {
  const limpo = texto.replace(/```(?:json)?/gi, '');
  const inicio = limpo.indexOf('{');
  const fim = limpo.lastIndexOf('}');
  if (inicio < 0 || fim <= inicio) {
    throw new RespostaInvalidaError(
      NOME_DO_OPENROUTER,
      'a resposta em texto não trouxe um objeto JSON',
    );
  }
  try {
    return JSON.parse(limpo.slice(inicio, fim + 1)) as unknown;
  } catch {
    throw new RespostaInvalidaError(
      NOME_DO_OPENROUTER,
      'o JSON da resposta em texto é inválido',
    );
  }
}

function executorPadrao(chave: string, fetchImpl?: typeof fetch): ExecutorDoSdk {
  const openrouter = createOpenRouter({
    apiKey: chave,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return async (chamada) => {
    const { only, ...restoDoProvider } = chamada.provider;
    const resultado = await generateText({
      model: openrouter.chat(chamada.modelo, {
        provider: { ...restoDoProvider, ...(only ? { only: [...only] } : {}) },
        // `usage.include` pede a contabilização de uso (hoje pode ser redundante); o custo é lido da resposta.
        usage: { include: true },
        ...(chamada.raciocinio ? { extraBody: { reasoning: chamada.raciocinio } } : {}),
      }),
      system: chamada.sistema,
      prompt: chamada.usuario,
      ...(chamada.saida === 'esquema'
        ? { output: Output.object({ schema: esquemaDaResposta }) }
        : {}),
      ...(chamada.maxTokens !== undefined ? { maxOutputTokens: chamada.maxTokens } : {}),
      temperature: chamada.temperatura,
      // Nenhuma repetição escondida no SDK: cada tentativa é decisão nossa e passa
      // por `montarChamada`, sempre com a ZDR.
      maxRetries: chamada.tentativasAutomaticas,
      timeout: chamada.timeoutMs,
      ...(chamada.sinal ? { abortSignal: chamada.sinal } : {}),
      // O padrão do SDK descarta o corpo enviado e o recebido; o diagnóstico precisa dos dois.
      include: { requestBody: true, responseBody: true },
    });
    const meta = ehObjeto(resultado.providerMetadata)
      ? resultado.providerMetadata['openrouter']
      : undefined;
    const corpoDaResposta: unknown = (
      resultado.response as { body?: unknown } | undefined
    )?.body;
    const doCorpo = (campo: string): string | undefined =>
      ehObjeto(corpoDaResposta) && typeof corpoDaResposta[campo] === 'string'
        ? corpoDaResposta[campo]
        : undefined;
    const provedor =
      doCorpo('provider') ??
      (ehObjeto(meta) && typeof meta['provider'] === 'string'
        ? meta['provider']
        : undefined);
    const modeloResolvido = doCorpo('model') ?? resultado.response?.modelId;
    // Custo: primeiro do `usage` que o SDK já mapeou; depois do `usage` CRU da resposta.
    const usoMapeado = ehObjeto(meta) ? meta['usage'] : undefined;
    const usoCru = ehObjeto(corpoDaResposta) ? corpoDaResposta['usage'] : undefined;
    const custoUsd =
      (ehObjeto(usoMapeado) ? numero(usoMapeado['cost']) : undefined) ??
      (ehObjeto(usoCru) ? numero(usoCru['cost']) : undefined);
    return {
      objeto:
        chamada.saida === 'esquema' ? resultado.output : jsonDoTexto(resultado.text),
      provedor,
      modeloResolvido,
      corpoEnviado: (resultado.request as { body?: unknown } | undefined)?.body,
      tokensEntrada: resultado.usage?.inputTokens,
      tokensSaida: resultado.usage?.outputTokens,
      tokensRaciocinio: resultado.usage?.outputTokenDetails?.reasoningTokens,
      custoUsd,
      camposDoUsage: ehObjeto(usoCru) ? Object.keys(usoCru).sort() : undefined,
    };
  };
}

/** Frases de "nenhum provedor atendeu". O texto exato NÃO está na documentação consultada. */
const SEM_PROVEDOR =
  /no endpoints found|no allowed providers|no provider|zero.?data.?retention|\bzdr\b|data.?polic|provider.?routing|requirements/i;

/** O erro (400/404) é do tipo "nenhum provedor atendeu" — pelo passo informado ou pela frase? */
export function indicaSemProvedor(status: number | undefined, corpo: string): boolean {
  if (status !== 404 && status !== 400) return false;
  return extrairRoteamento(corpo).passo !== undefined || SEM_PROVEDOR.test(corpo);
}

function statusDe(erro: unknown): number | undefined {
  if (APICallError.isInstance(erro)) return erro.statusCode;
  return ehObjeto(erro) ? numero(erro['statusCode']) : undefined;
}

function corpoDe(erro: unknown): string {
  if (APICallError.isInstance(erro)) return erro.responseBody ?? '';
  return ehObjeto(erro) && typeof erro['responseBody'] === 'string'
    ? erro['responseBody']
    : '';
}

/** Erro que vale NOVA tentativa (com a mesma ZDR): limite de taxa, 5xx, rede, tempo. */
function ehTransitorio(erro: unknown): boolean {
  const status = statusDe(erro);
  if (status !== undefined) return status === 429 || status >= 500;
  // Sem status: rede ou tempo esgotado. Esquema inválido NÃO é transitório.
  return (
    !NoObjectGeneratedError.isInstance(erro) && !(erro instanceof RespostaInvalidaError)
  );
}

/**
 * Traduz o erro do SDK para erro de domínio. NUNCA copia a mensagem nem o corpo
 * originais: o erro de um roteador pode ecoar trecho do pedido, e o pedido leva texto de ato.
 *
 * "Nenhum provedor atendeu" só vira "sem ZDR" quando o PASSO que falhou é o filtro de política
 * de dados; nos demais casos o erro carrega o passo e o funil, e a causa fica visível.
 */
function traduzirErro(erro: unknown, modelo: string): Error {
  if (erro instanceof RespostaInvalidaError) return erro;
  if (NoObjectGeneratedError.isInstance(erro)) {
    return new RespostaInvalidaError(
      NOME_DO_OPENROUTER,
      'a resposta do modelo não cumpriu o esquema fechado',
    );
  }
  const status = statusDe(erro);
  const corpo = corpoDe(erro);
  // Só status, passo e funil SANEADOS vão para o erro (e dele para o log): o corpo cru e a
  // mensagem do SDK não são copiados em lugar nenhum.
  const { passo, funil } = extrairRoteamento(corpo);
  const roteamento = roteamentoDaFalha(status, passo, funil);
  if (indicaSemProvedor(status, corpo)) {
    return ehFiltroDePoliticaDeDados(passo)
      ? new ZdrIndisponivelError(NOME_DO_OPENROUTER, modelo, passo, funil, status)
      : new SemProvedorQueAtendaError(NOME_DO_OPENROUTER, modelo, passo, funil, status);
  }
  if (
    erro instanceof Error &&
    (erro.name === 'TimeoutError' || erro.name === 'AbortError')
  ) {
    return new ProviderIndisponivelError(NOME_DO_OPENROUTER, 'tempo esgotado', {
      roteamento,
    });
  }
  const motivo =
    status === 401 || status === 403
      ? `chave recusada (HTTP ${status})`
      : status === 402
        ? 'sem créditos ou limite de gasto da chave atingido (HTTP 402)'
        : status === 429
          ? 'limite de requisições (HTTP 429)'
          : status !== undefined
            ? `o OpenRouter respondeu HTTP ${status}`
            : 'falha de rede ao chamar o OpenRouter';
  return new ProviderIndisponivelError(NOME_DO_OPENROUTER, motivo, { roteamento });
}

export class TransporteOpenRouter implements TransporteDeModelo {
  readonly nome = NOME_DO_OPENROUTER;
  private readonly executar: ExecutorDoSdk;
  private readonly timeoutMs: number;
  private readonly ajustes: AjustesDeDesempenho;
  private readonly esperas: readonly [number, number];
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly aoFalhar: ((d: DetalheDeErro) => void) | undefined;

  constructor(opcoes: OpcoesDoTransporteOpenRouter) {
    this.executar = opcoes.executar ?? executorPadrao(opcoes.chave, opcoes.fetch);
    this.timeoutMs = opcoes.timeoutMs ?? TIMEOUT_PADRAO_MS;
    this.ajustes = opcoes.ajustes ?? {};
    this.esperas = opcoes.esperasEntreTentativasMs ?? ESPERAS_PADRAO_MS;
    this.dormir = opcoes.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.aoFalhar = opcoes.aoFalhar;
  }

  /**
   * A chamada de produção (e da rodada da sonda): ZDR, `data_collection: deny`, `allow_fallbacks:
   * false` e `only` SEMPRE; formato em texto (degrau C), sem `require_parameters` e sem
   * `response_format`. Desde a 0.38.4: com o filtro "Filter by Parameters" ligado, o único endpoint
   * ZDR do modelo caía (404) por não declarar saída estruturada. O JSON é extraído por
   * `jsonDoTexto` e validado pelo Zod `.strict()` do nosso lado; nada disso afrouxa a ZDR.
   */
  async gerar(pedido: PedidoAoModelo): Promise<RespostaDoTransporte> {
    return this.executarComTentativas(pedido, 'C');
  }

  /**
   * SÓ para o diagnóstico em degraus (texto sintético). Cada degrau tira uma coisa a mais da
   * chamada — `require_parameters`, o esquema estrito, `provider.only` —, mas `zdr: true` e
   * `data_collection: 'deny'` seguem em TODOS: não existe degrau sem eles.
   */
  async gerarDiagnostico(
    pedido: PedidoAoModelo,
    degrau: Degrau,
  ): Promise<RespostaDoTransporte> {
    return this.executarComTentativas(pedido, degrau);
  }

  private async executarComTentativas(
    pedido: PedidoAoModelo,
    degrau: Degrau,
  ): Promise<RespostaDoTransporte> {
    let ultimo: unknown;
    const todos = pedido.provedoresPermitidos;
    // Rodízio por provedor (v0.38.3): a 1ª tentativa leva TODOS os permitidos em `only`. Depois de
    // um 429/5xx, cada nova tentativa restringe `only` a UM provedor da lista, em ordem — sem
    // depender de o corpo do erro dizer quem limitou e SEM `allow_fallbacks` (continua false):
    // o texto só pode chegar a quem está na lista, e a lista inteira esgotada falha.
    // Com um único provedor não há para onde rodar: repete como antes. O degrau D (diagnóstico,
    // sem `only`) também.
    const rodizio = degrau !== 'D' && todos.length > 1;
    const repeticoes = rodizio
      ? Math.max(this.esperas.length, todos.length)
      : this.esperas.length;
    let only: readonly string[] = todos;
    let proximo = 0;
    for (let tentativa = 0; tentativa <= repeticoes; tentativa++) {
      const chamada = this.montarChamada(pedido, degrau, only);
      exigirZdr(chamada, { admiteSemRestricao: degrau === 'D' });
      try {
        const bruto = await this.executar(chamada);
        return {
          objeto: bruto.objeto,
          diagnostico: {
            corpoEnviado: sanearCorpoEnviado(bruto.corpoEnviado),
            ...(bruto.modeloResolvido ? { modeloResolvido: bruto.modeloResolvido } : {}),
            ...(bruto.provedor ? { provedorDaResposta: bruto.provedor } : {}),
            ...(bruto.camposDoUsage ? { camposDoUsage: bruto.camposDoUsage } : {}),
          },
          ...(bruto.modeloResolvido ? { modeloResolvido: bruto.modeloResolvido } : {}),
          ...(bruto.provedor !== undefined ? { provedor: bruto.provedor } : {}),
          ...(bruto.tokensEntrada !== undefined
            ? { tokensEntrada: bruto.tokensEntrada }
            : {}),
          ...(bruto.tokensSaida !== undefined ? { tokensSaida: bruto.tokensSaida } : {}),
          ...(bruto.tokensRaciocinio !== undefined
            ? { tokensRaciocinio: bruto.tokensRaciocinio }
            : {}),
          ...(bruto.custoUsd !== undefined ? { custoUsd: bruto.custoUsd } : {}),
        };
      } catch (erro) {
        ultimo = erro;
        const status = statusDe(erro);
        const roteamento = extrairRoteamento(corpoDe(erro));
        this.aoFalhar?.({
          ...(status !== undefined ? { status } : {}),
          corpo: corpoDe(erro),
          ...(APICallError.isInstance(erro)
            ? { corpoEnviado: sanearCorpoEnviado(erro.requestBodyValues) }
            : {}),
          ...(roteamento.passo !== undefined ? { passo: roteamento.passo } : {}),
          ...(roteamento.funil !== undefined ? { funil: roteamento.funil } : {}),
        });
        const traduzido = traduzirErro(erro, pedido.modelo);
        // Limite de taxa ou falha do provedor: a próxima tentativa muda de provedor.
        const trocaProvedor =
          rodizio && status !== undefined && (status === 429 || status >= 500);
        const listaEsgotada = trocaProvedor && proximo >= todos.length;
        const podeRepetir =
          pedido.sinal?.aborted !== true &&
          ehTransitorio(erro) &&
          !(traduzido instanceof ZdrIndisponivelError) &&
          !(traduzido instanceof SemProvedorQueAtendaError) &&
          !listaEsgotada &&
          tentativa < repeticoes;
        if (!podeRepetir) throw traduzido;
        pedido.aoRepetir?.();
        if (trocaProvedor) {
          const proximoProvedor = todos[proximo++];
          if (proximoProvedor !== undefined) only = [proximoProvedor];
        }
        await this.dormir(
          this.esperas[Math.min(tentativa, this.esperas.length - 1)] ?? 0,
        );
      }
    }
    throw traduzirErro(ultimo, pedido.modelo);
  }

  private montarChamada(
    pedido: PedidoAoModelo,
    degrau: Degrau,
    only: readonly string[] = pedido.provedoresPermitidos,
  ): ChamadaAoSdk {
    const raciocinio = corpoDoRaciocinio(this.ajustes.raciocinio ?? 'padrao');
    return {
      modelo: pedido.modelo,
      // No modo "texto" o formato vai por instrução; o resto do sistema não muda.
      sistema:
        degrau === 'C' || degrau === 'D'
          ? `${pedido.sistema}\n\n${pedido.instrucaoDeFormato ?? INSTRUCAO_DE_FORMATO_EM_TEXTO}`
          : pedido.sistema,
      usuario: pedido.usuario,
      temperatura: 0,
      tentativasAutomaticas: 0,
      timeoutMs: pedido.timeoutMs ?? this.timeoutMs,
      provider: {
        zdr: PREFERENCIAS_BASE_DE_PROVEDOR.zdr,
        data_collection: PREFERENCIAS_BASE_DE_PROVEDOR.data_collection,
        allow_fallbacks: PREFERENCIAS_BASE_DE_PROVEDOR.allow_fallbacks,
        ...(degrau === 'A' ? { require_parameters: true as const } : {}),
        ...(degrau !== 'D' ? { only: [...only] } : {}),
      },
      saida: degrau === 'A' || degrau === 'B' ? 'esquema' : 'texto',
      ...(raciocinio ? { raciocinio } : {}),
      ...((pedido.maxTokens ?? this.ajustes.maxTokens) !== undefined
        ? { maxTokens: (pedido.maxTokens ?? this.ajustes.maxTokens) as number }
        : {}),
      ...(pedido.sinal ? { sinal: pedido.sinal } : {}),
    };
  }
}

/**
 * Cinto e suspensório: o tipo já impede, e esta checagem impede também um `as` futuro. Sem
 * `provider.zdr === true` e `data_collection: 'deny'`, nada sai — a exceção é lançada ANTES de
 * qualquer rede. Também exige a restrição `only` NÃO vazia, salvo no degrau D do diagnóstico
 * (`admiteSemRestricao`), e recusa apelido (`~…`) e variante (`:…`) de modelo.
 */
export function exigirZdr(
  chamada: ChamadaAoSdk,
  opcoes: { readonly admiteSemRestricao?: boolean } = {},
): void {
  const p = chamada.provider as unknown;
  const recusa = (motivo: string): never => {
    throw new ProviderIndisponivelError(
      NOME_DO_OPENROUTER,
      `chamada recusada: ${motivo}`,
    );
  };
  if (!ehObjeto(p) || p['zdr'] !== true || p['data_collection'] !== 'deny') {
    recusa('a retenção zero (provider.zdr) não está ativa neste pedido');
  }
  if (opcoes.admiteSemRestricao !== true) {
    const only = ehObjeto(p) ? p['only'] : undefined;
    if (
      !Array.isArray(only) ||
      only.length === 0 ||
      !only.every((x) => typeof x === 'string' && x.trim() !== '')
    ) {
      recusa(
        'a restrição aos provedores ZDR do modelo (provider.only) está ausente ou vazia',
      );
    }
  }
  if (ehApelidoOuVariante(chamada.modelo)) {
    recusa('o id do modelo é um apelido ou variante (~ ou :), não um modelo real');
  }
}
