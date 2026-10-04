import { NumeroCNJ } from '../../../domain/entities/NumeroCNJ.js';
import { Oab } from '../../../domain/entities/Oab.js';
import type { Processo } from '../../../domain/entities/Processo.js';
import {
  ProcessoNaoEncontradoError,
  ProviderIndisponivelError,
  RespostaInvalidaError,
} from '../../../domain/errors/index.js';
import type { Clock } from '../../../domain/ports/Clock.js';
import { clockDoSistema } from '../../../domain/ports/Clock.js';
import type { Logger } from '../../../domain/ports/Logger.js';
import { loggerSilencioso } from '../../logging/ConsoleLogger.js';
import type {
  CapacidadesProvider,
  DiagnosticoProvider,
  ProcessoProvider,
} from '../../../domain/ports/ProcessoProvider.js';
import { HttpClient, HttpTimeoutError } from '../../http/HttpClient.js';
import type { RateLimiter } from '../../ratelimit/TokenBucketRateLimiter.js';
import { TokenBucketRateLimiter } from '../../ratelimit/TokenBucketRateLimiter.js';
import { agruparEmProcessos, NOME_DJEN } from './djen.mapper.js';
import { respostaDjenSchema } from './djen.types.js';
import type { ComunicacaoDjen } from './djen.types.js';

export { NOME_DJEN };

const BASE_URL_PADRAO = 'https://comunicaapi.pje.jus.br';
const CAMINHO = '/api/v1/comunicacao';

/**
 * Timeout das consultas. 20s e não os 60s do DataJud porque a latência medida
 * foi outra ordem de grandeza: 185ms, 231ms e 993ms em três chamadas reais
 * (ver cabeçalho de `tests/fixtures/djen-comunica-real.json`). Um teto generoso
 * numa fonte rápida só serve para segurar o usuário quando ela cai.
 */
const TIMEOUT_PADRAO_MS = 20_000;
const TIMEOUT_VERIFICACAO_MS = 8_000;
const TENTATIVAS = 2;

/** Teto por página aceito pela API sem degradar (300 verificado na captura). */
const ITENS_POR_PAGINA = 100;

/**
 * Teto de comunicações lidas numa busca por OAB.
 *
 * Um advogado com 1.871 publicações não quer 1.871 linhas — quer a carteira
 * dele. Com 500 comunicações cobrimos vários meses de atividade, o que já
 * revela praticamente todos os processos vivos, em 5 requisições. Ir até o fim
 * custaria 19 requisições contra uma API pública para desenterrar processos que
 * não se movem há mais de um ano. Quem quiser o histórico completo restringe
 * por data.
 */
const MAX_COMUNICACOES_POR_OAB = 500;

/**
 * Teto de comunicações lidas para UM processo. Mais alto que o da OAB porque
 * aqui o excedente não é ruído: é a linha do tempo do processo que o usuário
 * pediu. 1000 publicações num único processo é caso extremo.
 */
const MAX_COMUNICACOES_POR_PROCESSO = 1_000;

export interface OpcoesDjenAdapter {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly limitePorMinuto?: number;
  readonly maxComunicacoesPorOab?: number;
  readonly httpClient?: HttpClient;
  readonly rateLimiter?: RateLimiter;
  readonly logger?: Logger;
  readonly clock?: Clock;
}

export interface FiltroPeriodo {
  /** Data inicial de disponibilização, inclusive (YYYY-MM-DD). */
  readonly de?: string;
  /** Data final de disponibilização, inclusive (YYYY-MM-DD). */
  readonly ate?: string;
}

/**
 * Adapter do DJEN — Diário de Justiça Eletrônico Nacional, via Comunica API do
 * CNJ.
 *
 * Endpoint: GET {base}/api/v1/comunicacao
 * Auth:     nenhuma. A base é aberta por desenho: é o diário oficial.
 *
 * É a fonte que fecha os buracos do DataJud. O DataJud indexa metadado e a
 * linha do tempo codificada; o DJEN traz **quem são as partes, quem advoga por
 * elas, e o inteiro teor do que foi publicado** — e, sobretudo, permite filtrar
 * por OAB, que no DataJud é impossível porque o campo não existe no índice.
 *
 * O limite honesto, declarado aqui para não ser descoberto em produção: o DJEN
 * só conhece o que foi PUBLICADO no diário. Ato interno sem publicação (juntada,
 * conclusão, expediente de cartório) não aparece. Por isso `retornaPartes` e
 * `retornaConteudoMovimentacoes` são `true`, mas esta fonte não substitui o
 * DataJud — complementa. As duas juntas é que dão o processo inteiro.
 *
 * A cobertura temporal também é curta: consulta a 2020 devolve zero. O DJEN
 * passou a concentrar as publicações nacionais em 2023/2024, e antes disso o
 * histórico está nos diários dos tribunais.
 */
export class DjenAdapter implements ProcessoProvider {
  readonly nome = NOME_DJEN;

  readonly capacidades: CapacidadesProvider = {
    buscarPorNumero: true,
    buscarPorOab: true,
    retornaPartes: true,
    retornaConteudoMovimentacoes: true,
    // Só o que foi publicado no diário. É o limite honesto desta fonte, e é o
    // que faz o orquestrador continuar perguntando ao DataJud.
    retornaLinhaDoTempoCompleta: false,
    // A base é nacional: 90+ tribunais publicam no mesmo diário. Não há lista
    // de siglas a manter — e foi comprovado que o filtro por OAB atravessa
    // tribunais (uma busca por OAB/GO devolveu processo do TJSP).
    tribunais: ['*'],
  };

  private readonly baseUrl: string;
  private readonly http: HttpClient;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly maxComunicacoesPorOab: number;

  constructor(opcoes: OpcoesDjenAdapter = {}) {
    this.baseUrl = (opcoes.baseUrl ?? BASE_URL_PADRAO).replace(/\/+$/, '');
    this.clock = opcoes.clock ?? clockDoSistema;
    this.logger = (opcoes.logger ?? loggerSilencioso).child({ provider: this.nome });
    this.maxComunicacoesPorOab =
      opcoes.maxComunicacoesPorOab ?? MAX_COMUNICACOES_POR_OAB;
    this.http =
      opcoes.httpClient ??
      new HttpClient({
        timeoutMs: opcoes.timeoutMs ?? TIMEOUT_PADRAO_MS,
        tentativas: TENTATIVAS,
      });
    this.rateLimiter =
      opcoes.rateLimiter ??
      new TokenBucketRateLimiter({
        capacidade: opcoes.limitePorMinuto ?? 60,
        janelaMs: 60_000,
        ...(opcoes.clock ? { clock: opcoes.clock } : {}),
      });
  }

  async buscarPorNumero(numeroProcesso: string): Promise<Processo> {
    const numero = NumeroCNJ.criar(numeroProcesso);
    // A API casa pelo número COM máscara; os 20 dígitos crus não retornam nada.
    //
    // Pagina, e não uma chamada só: um processo antigo e movimentado passa das
    // 100 comunicações de uma página (o 0311517-22.2015.8.09.0051, que usamos
    // para teste, tem 62). Sem paginar, o excedente sumiria em silêncio — e
    // andamento que some é prazo perdido.
    const itens = await this.consultarPaginado(
      { numeroProcesso: numero.formatado },
      MAX_COMUNICACOES_POR_PROCESSO,
    );

    const { processos, descartadas } = agruparEmProcessos(itens, this.clock.agora());
    this.registrarDescartes(descartadas);

    const encontrado = processos[0];
    if (!encontrado) {
      throw new ProcessoNaoEncontradoError(`número ${numero.formatado}`, this.nome);
    }

    // Agrupamos por número; mais de um grupo significaria que a API devolveu
    // comunicações de OUTRO processo para este filtro — contrato quebrado, e
    // não algo a resolver escolhendo o primeiro.
    if (processos.length > 1) {
      throw new RespostaInvalidaError(
        this.nome,
        `a consulta por ${numero.formatado} devolveu ${processos.length} processos distintos`,
      );
    }
    return encontrado;
  }

  /**
   * A busca que só esta fonte faz.
   *
   * Devolve os processos em que o advogado aparece como destinatário de alguma
   * publicação — não a totalidade da carteira dele. Processo em que ele atua mas
   * que nunca teve publicação no período lido não aparece, e isso não é falha:
   * é o que "diário de justiça" significa.
   */
  async buscarPorOab(oab: string, uf: string): Promise<Processo[]> {
    return this.buscarPorOabNoPeriodo(oab, uf, {});
  }

  async buscarPorOabNoPeriodo(
    oab: string,
    uf: string,
    periodo: FiltroPeriodo,
  ): Promise<Processo[]> {
    const inscricao = Oab.criar(oab, uf);
    const itens = await this.consultarPaginado(
      {
        numeroOab: inscricao.numero,
        ufOab: inscricao.uf,
        ...(periodo.de ? { dataDisponibilizacaoInicio: periodo.de } : {}),
        ...(periodo.ate ? { dataDisponibilizacaoFim: periodo.ate } : {}),
      },
      this.maxComunicacoesPorOab,
    );

    const { processos, descartadas } = agruparEmProcessos(itens, this.clock.agora());
    this.registrarDescartes(descartadas);

    this.logger.debug('busca por OAB concluída', {
      oab: inscricao.numero,
      uf: inscricao.uf,
      comunicacoes: itens.length,
      processos: processos.length,
    });

    return processos;
  }

  async healthCheck(): Promise<boolean> {
    return (await this.diagnosticar()).saudavel;
  }

  async diagnosticar(): Promise<DiagnosticoProvider> {
    // Consulta mínima: uma página de um item. Diferente do DataJud, aqui não há
    // chave para validar — a pergunta é só "a API responde?".
    const url = this.montarUrl({ itensPorPagina: '1' });

    let resposta;
    try {
      resposta = await this.http.get(url, {}, {
        timeoutMs: TIMEOUT_VERIFICACAO_MS,
        tentativas: 1,
      });
    } catch (erro) {
      return {
        saudavel: false,
        motivo:
          erro instanceof HttpTimeoutError
            ? 'timeout ao contatar o DJEN (comunicaapi.pje.jus.br)'
            : 'falha de rede ao contatar o DJEN (comunicaapi.pje.jus.br)',
      };
    }

    if (resposta.ok) return { saudavel: true };
    if (resposta.status === 429) {
      return {
        saudavel: false,
        motivo: 'limite de requisições excedido no DJEN (HTTP 429)',
      };
    }
    if (resposta.status >= 500) {
      return { saudavel: false, motivo: `DJEN fora do ar (HTTP ${resposta.status})` };
    }
    // Mesma classificação do DataJud: 4xx que não é 429 significa que a fonte
    // respondeu e não gostou da CONSULTA. A fonte está de pé.
    return {
      saudavel: true,
      motivo:
        `alcançável, mas a consulta de verificação foi recusada ` +
        `(HTTP ${resposta.status}). As buscas devem funcionar normalmente.`,
    };
  }

  private montarUrl(parametros: Record<string, string>): string {
    const url = new URL(this.baseUrl + CAMINHO);
    for (const [chave, valor] of Object.entries(parametros)) {
      url.searchParams.set(chave, valor);
    }
    return url.toString();
  }

  /**
   * Percorre as páginas até o teto ou até o fim do conjunto.
   *
   * Uma página menor que `ITENS_POR_PAGINA` é o fim: a API não tem "próxima"
   * explícita, e insistir depois disso só gasta requisição contra uma base
   * pública.
   */
  private async consultarPaginado(
    filtro: Record<string, string>,
    teto: number,
  ): Promise<ComunicacaoDjen[]> {
    const itens: ComunicacaoDjen[] = [];

    for (let pagina = 1; itens.length < teto; pagina++) {
      const lote = await this.consultar({
        ...filtro,
        pagina: String(pagina),
        itensPorPagina: String(ITENS_POR_PAGINA),
      });
      itens.push(...lote);
      if (lote.length < ITENS_POR_PAGINA) break;
    }

    return itens.slice(0, teto);
  }

  private async consultar(
    parametros: Record<string, string>,
  ): Promise<ComunicacaoDjen[]> {
    const url = this.montarUrl(parametros);
    await this.rateLimiter.adquirir();

    let resposta;
    try {
      resposta = await this.http.get(url);
    } catch (erro) {
      throw new ProviderIndisponivelError(
        this.nome,
        erro instanceof HttpTimeoutError ? 'timeout' : 'falha de rede',
        { cause: erro },
      );
    }

    if (resposta.status === 429) {
      throw new ProviderIndisponivelError(this.nome, 'limite de requisições excedido');
    }
    if (!resposta.ok) {
      throw new ProviderIndisponivelError(this.nome, `HTTP ${resposta.status}`);
    }

    return this.interpretar(resposta.corpo).items;
  }

  private interpretar(corpo: string): ReturnType<typeof respostaDjenSchema.parse> {
    let json: unknown;
    try {
      json = JSON.parse(corpo);
    } catch (erro) {
      throw new RespostaInvalidaError(this.nome, 'corpo não é JSON válido', {
        cause: erro,
      });
    }

    const resultado = respostaDjenSchema.safeParse(json);
    if (!resultado.success) {
      throw new RespostaInvalidaError(
        this.nome,
        `payload fora do contrato esperado: ${resultado.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        { cause: resultado.error },
      );
    }
    return resultado.data;
  }

  private registrarDescartes(
    descartadas: readonly { readonly numero: string; readonly motivo: string }[],
  ): void {
    if (descartadas.length === 0) return;
    this.logger.warn('comunicações descartadas por número CNJ inválido', {
      quantidade: descartadas.length,
      exemplos: descartadas.slice(0, 3).map((d) => d.numero),
    });
  }
}
