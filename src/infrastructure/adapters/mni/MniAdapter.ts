import type { ConteudoPeca, Peca } from '../../../domain/entities/Peca.js';
import {
  CredencialTribunalInvalidaError,
  MniBloqueadoError,
  ProcessoNaoEncontradoError,
  ProviderIndisponivelError,
  RespostaInvalidaError,
  SemHabilitacaoNosAutosError,
  TeorNaoAutorizadoError,
} from '../../../domain/errors/index.js';
import type { Clock } from '../../../domain/ports/Clock.js';
import { clockDoSistema } from '../../../domain/ports/Clock.js';
import type { Logger } from '../../../domain/ports/Logger.js';
import type {
  AssinaturaDeMudanca,
  AtosDoProcesso,
  CredencialTribunal,
  LoteDePecas,
  ProvedorDePecas,
} from '../../../domain/ports/ProvedorDePecas.js';
import { loggerSilencioso } from '../../logging/ConsoleLogger.js';
import { HttpClient, HttpTimeoutError } from '../../http/HttpClient.js';
import type { RateLimiter } from '../../ratelimit/TokenBucketRateLimiter.js';
import { TokenBucketRateLimiter } from '../../ratelimit/TokenBucketRateLimiter.js';
import {
  ACAO_CONSULTAR_ALTERACAO,
  ACAO_CONSULTAR_PROCESSO,
  acaoSoap,
  envelopeConsultarAlteracao,
  envelopeConsultarProcesso,
} from './mni.envelope.js';
import {
  NOME_MNI,
  XmlIlegivelError,
  abrirEnvelope,
  extrairAssinatura,
  extrairConteudoDoDocumento,
  extrairConteudosDoLote,
  extrairMovimentos,
  extrairNivelSigiloDoProcesso,
  extrairPecas,
  tribunalEntregouOConteudo,
} from './mni.mapper.js';
import type { ModoDoSoapAction } from './mni.envelope.js';
import type { RespostaMni } from './mni.mapper.js';
import { lerRespostaSoap, MultipartInvalidoError } from './mtom.js';
import type { ParteMultipart } from './mtom.js';

export { NOME_MNI };

/**
 * Endpoint MNI do Projudi/TJGO.
 *
 * Não segue o padrão `/intercomunicacao` do PJe — no Projudi o serviço se chama
 * `IntercomunicacaoService`, e é por isso que procurar pelo caminho do PJe dá
 * 404 e leva à conclusão errada de que o tribunal não tem MNI. O link está na
 * página inicial do próprio Projudi.
 */
const ENDPOINT_PADRAO = 'https://projudi.tjgo.jus.br/IntercomunicacaoService';

/**
 * 90s. Não é folga: `incluirDocumentos` faz o tribunal montar e transmitir os
 * PDFs do processo na mesma resposta, e processo com dezenas de peças passa
 * bastante dos 20s que bastam ao DJEN.
 */
const TIMEOUT_PADRAO_MS = 90_000;

/**
 * UMA tentativa. Retry aqui é ativamente perigoso e essa é a diferença mais
 * importante em relação aos outros adapters: a requisição carrega usuário e
 * senha do advogado, e o Projudi conta tentativa malsucedida para bloquear
 * conta. Uma senha desatualizada com retry vira três recusas por consulta, e a
 * vigilância de hora em hora transforma isso em bloqueio no mesmo dia — deixando
 * o advogado sem acesso ao próprio processo por culpa nossa.
 */
const TENTATIVAS = 1;

/**
 * 30 por minuto, contra os 60 do DataJud. Relatos de MNI em produção falam em
 * teto na casa de 50/min antes de bloqueio de IP com 403 e espera de ~30
 * minutos — e num VPS o IP é compartilhado por todos os assinantes. Metade do
 * teto relatado é a margem que impede um pico de vigilância de derrubar o acesso
 * de todo mundo de uma vez.
 */
const LIMITE_PADRAO_POR_MINUTO = 30;

/**
 * Quanto tempo o MNI inteiro fica parado depois de um 403. Relato de produção:
 * o bloqueio de IP dura ~30 minutos. Ver `MNI_PAUSA_APOS_403_MIN`.
 */
const PAUSA_PADRAO_APOS_403_MS = 30 * 60_000;

/**
 * Mensagens do TJGO que significam credencial recusada.
 *
 * `Usuário ou Senha inválida.` foi capturada ao vivo (fixture
 * `mni-tjgo-credencial-invalida-real.txt`). As demais entram por prudência, com
 * casamento por trecho normalizado: o tribunal muda pontuação e acentuação entre
 * versões, e comparar string exata faria a classificação silenciosamente parar
 * de funcionar — devolvendo "processo não encontrado" para senha errada.
 */
const MARCAS_DE_CREDENCIAL = [
  'usuario ou senha',
  'senha invalida',
  'usuario invalido',
  'nao autenticado',
  'nao autorizado',
  'acesso negado',
  'credencial',
];

const MARCAS_DE_NAO_ENCONTRADO = [
  'nao encontrado',
  'nao localizado',
  'inexistente',
  'nenhum processo',
];

export interface OpcoesMniAdapter {
  readonly endpoint?: string;
  readonly tribunais?: readonly string[];
  readonly timeoutMs?: number;
  readonly limitePorMinuto?: number;
  readonly httpClient?: HttpClient;
  readonly rateLimiter?: RateLimiter;
  readonly logger?: Logger;
  /** Duração da pausa global depois de um HTTP 403. */
  readonly pausaApos403Ms?: number;
  readonly clock?: Clock;
  /**
   * Como o `SOAPAction` é escrito (v0.59.0). Padrão `cnj`, o do TJGO. Só a sonda do PJe usa `vazio`.
   */
  readonly soapAction?: ModoDoSoapAction;
}

/** O que `consultarProcessoBruto` devolve: a resposta aberta, sem virar entidade do domínio. */
export interface ConsultaBrutaDoMni {
  readonly resposta: RespostaMni;
  readonly anexos: ReadonlyMap<string, ParteMultipart>;
  readonly bytesResposta: number;
}

/**
 * Adapter do MNI 2.2.2 — Modelo Nacional de Interoperabilidade.
 *
 * É a fonte que entrega o que nenhuma outra entrega: **as peças**. O DJEN
 * publica ato judicial e o DataJud indexa metadado; petição, contestação, laudo
 * e documento juntado pela parte só existem dentro do sistema do tribunal, e o
 * MNI é a porta oficial para eles.
 *
 * Autenticação por `idConsultante` + `senhaConsultante` dentro do envelope — a
 * mesma dupla que o advogado usa no Projudi. Não passa pela tela de login, então
 * não há CAPTCHA nem segundo fator por e-mail no caminho; e não exige
 * certificado digital neste tribunal.
 *
 * **A trava que nenhum código contorna:** o MNI devolve as peças conforme o
 * perfil de acesso do consultante. Sem procuração nos autos, o metadado vem e o
 * conteúdo não. Isso é controle de acesso do processo eletrônico funcionando,
 * não defeito — e é a razão de `TeorNaoAutorizadoError` existir com nome
 * próprio, para a interface dizer "você não está habilitado neste processo" em
 * vez de "erro ao baixar".
 *
 * Implementa `ProvedorDePecas` e NÃO `ProcessoProvider`: entrar na cadeia faria
 * o `CachedProcessoProvider` — que indexa por número de processo, sem workspace
 * na chave — servir a um assinante a resposta obtida com a credencial de outro.
 * Ver o comentário da porta.
 */
export class MniAdapter implements ProvedorDePecas {
  readonly nome = NOME_MNI;
  readonly tribunais: readonly string[];

  private readonly endpoint: string;
  private readonly http: HttpClient;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly pausaApos403Ms: number;
  private readonly soapAction: ModoDoSoapAction;
  /**
   * Disjuntor de 403: até quando o MNI inteiro fica sem consulta.
   *
   * No ADAPTER, e não no job do leitor, porque o bloqueio é do IP do servidor
   * e o IP é um só: enquanto ele durar, a peça avulsa, a régua do processo e o
   * leitor de todos os assinantes iriam bater na mesma porta fechada. Cada
   * batida dessas é mais uma tentativa contra um tribunal que já disse "pare"
   * — e o que se ganha insistindo é bloqueio mais longo.
   *
   * Em memória: um redeploy fecha o disjuntor. Aceito conscientemente — o
   * contêiner novo faz UMA consulta, toma o 403 de novo e reabre.
   */
  private bloqueadoAte: number | undefined;

  constructor(opcoes: OpcoesMniAdapter = {}) {
    this.endpoint = opcoes.endpoint ?? ENDPOINT_PADRAO;
    this.tribunais = opcoes.tribunais ?? ['TJGO'];
    this.logger = (opcoes.logger ?? loggerSilencioso).child({ provider: this.nome });
    this.clock = opcoes.clock ?? clockDoSistema;
    this.pausaApos403Ms = opcoes.pausaApos403Ms ?? PAUSA_PADRAO_APOS_403_MS;
    this.soapAction = opcoes.soapAction ?? 'cnj';
    this.http =
      opcoes.httpClient ??
      new HttpClient({
        timeoutMs: opcoes.timeoutMs ?? TIMEOUT_PADRAO_MS,
        tentativas: TENTATIVAS,
      });
    this.rateLimiter =
      opcoes.rateLimiter ??
      new TokenBucketRateLimiter({
        capacidade: opcoes.limitePorMinuto ?? LIMITE_PADRAO_POR_MINUTO,
        janelaMs: 60_000,
      });
  }

  /**
   * As peças sozinhas. Delega para `listarAtos` e joga os movimentos fora.
   *
   * Continua existindo porque é o que a porta exige de toda fonte de peças, e
   * porque há chamador que só quer a lista. NÃO faz consulta própria: uma
   * segunda chamada ao tribunal para montar a mesma tela custaria mais dezenas
   * de segundos e mais uma oportunidade de recusa contra a conta do advogado.
   */
  async listarPecas(
    numeroProcesso: string,
    credencial: CredencialTribunal,
  ): Promise<Peca[]> {
    const { pecas } = await this.listarAtos(numeroProcesso, credencial);
    return [...pecas];
  }

  async listarAtos(
    numeroProcesso: string,
    credencial: CredencialTribunal,
  ): Promise<AtosDoProcesso> {
    // `movimentos: true` é OBRIGATÓRIO para a lista de peças aparecer, e isso
    // não está escrito em lugar nenhum do MNI. Medido no TJGO, mesmo processo,
    // mesma credencial, mesmo `incluirDocumentos: true`:
    //
    //   movimentos=false → 4.122 bytes,     0 <documento>, 381 movimentos ocultos
    //   movimentos=true  → 279.653 bytes, 278 <documento>, 381 <movimento>
    //
    // No Projudi o documento é filho do processo mas nasce PENDURADO num
    // movimento (atributo `movimento="47660211"`), e sem pedir a linha do tempo
    // o tribunal devolve só o cabeçalho — com `sucesso: true`, sem aviso
    // nenhum. O sintoma é indistinguível de "processo sem peças", que foi
    // exatamente a pista falsa que custou uma tarde de diagnóstico.
    //
    // `incluirDocumentos: true` com `documentos` vazio parece contraditório e
    // não é: é assim que se pede a FICHA de todos os documentos.
    const { resposta, anexos } = await this.chamar(
      envelopeConsultarProcesso({
        numeroProcesso,
        credencial,
        movimentos: true,
        incluirCabecalho: true,
        incluirDocumentos: true,
      }),
      ACAO_CONSULTAR_PROCESSO,
      numeroProcesso,
    );

    // ANTES de extrair: o tribunal entregou a linha do tempo?
    //
    // Zero movimentos com `movimentos: true` pedido não é "processo vazio", é
    // negativa de acesso disfarçada de sucesso. Sem esta guarda, a lista volta
    // vazia e a tela diz ao advogado que o processo não tem peças — quando o
    // que houve foi o tribunal recusar o conteúdo a quem não tem procuração.
    if (!tribunalEntregouOConteudo(resposta.conteudo)) {
      throw new SemHabilitacaoNosAutosError(numeroProcesso);
    }

    const pecas = extrairPecas(resposta.conteudo, anexos);
    const movimentos = extrairMovimentos(resposta.conteudo);
    const nivelSigiloDoProcesso = extrairNivelSigiloDoProcesso(resposta.conteudo);
    this.logger.debug('peças listadas', {
      numeroProcesso,
      pecas: pecas.length,
      movimentos: movimentos.length,
      comTeor: pecas.filter((p) => p.conteudoDisponivel).length,
    });
    return {
      pecas,
      movimentos,
      ...(nivelSigiloDoProcesso !== undefined ? { nivelSigiloDoProcesso } : {}),
    };
  }

  async obterConteudo(
    numeroProcesso: string,
    idPeca: string,
    credencial: CredencialTribunal,
  ): Promise<ConteudoPeca> {
    // `movimentos: true` aqui pela MESMA razão de `listarPecas`, e custa caro:
    // a linha do tempo inteira viaja junto do arquivo. Medido no TJGO, pedindo
    // UMA petição de um processo com 381 movimentos:
    //
    //   movimentos=false →     800 bytes, 0 documento, sem anexo
    //   movimentos=true  → 501.753 bytes, 1 documento, anexo MTOM com o PDF
    //
    // Os ~250 KB de movimentos são pedágio, não desperdício evitável: sem eles
    // o tribunal não devolve documento nenhum, nem quando o id é pedido
    // explicitamente. `incluirCabecalho: false` corta só 3 KB, mas corta.
    //
    // O recorte por id continua valendo, e é ele que evita o pior caso: sem
    // `documentos`, viriam as 278 peças de uma vez.
    const { resposta, anexos } = await this.chamar(
      envelopeConsultarProcesso({
        numeroProcesso,
        credencial,
        movimentos: true,
        incluirCabecalho: false,
        incluirDocumentos: true,
        documentos: [idPeca],
      }),
      ACAO_CONSULTAR_PROCESSO,
      numeroProcesso,
    );

    const achado = extrairConteudoDoDocumento(resposta.conteudo, idPeca, anexos);
    if (!achado) throw new TeorNaoAutorizadoError(numeroProcesso, idPeca);

    return {
      id: idPeca,
      mimetype: achado.mimetype,
      // O nome real do tribunal quando ele manda (`certidaosistemadigital.pdf`),
      // e só então um nome montado. Quem baixa 30 peças precisa distinguir os
      // arquivos na pasta de Downloads.
      nomeArquivo:
        achado.nomeArquivo ?? nomeDeArquivo(numeroProcesso, idPeca, achado.mimetype),
      bytes: achado.bytes,
    };
  }

  /**
   * Várias peças numa consulta: o mesmo envelope de `obterConteudo`, com um
   * `<documento>` por id. Medido no TJGO até 20 por chamada, todas idênticas
   * às baixadas uma a uma.
   *
   * Mesma obrigação de `movimentos: true` (sem ela, nenhum documento vem) e
   * mesma ausência de retry — o pedido carrega a senha do advogado.
   */
  async obterConteudosEmLote(
    numeroProcesso: string,
    idsPecas: readonly string[],
    credencial: CredencialTribunal,
  ): Promise<LoteDePecas> {
    // Lista vazia pediria TODAS as peças do processo de uma vez: é o que
    // `documentos` vazio significa no envelope. Nunca é o que se quer aqui.
    if (idsPecas.length === 0) {
      return { conteudos: [], semTeor: [], ausentes: [], bytesResposta: 0 };
    }

    const { resposta, anexos, bytesResposta } = await this.chamar(
      envelopeConsultarProcesso({
        numeroProcesso,
        credencial,
        movimentos: true,
        incluirCabecalho: false,
        incluirDocumentos: true,
        documentos: idsPecas,
      }),
      ACAO_CONSULTAR_PROCESSO,
      numeroProcesso,
    );

    // Mesma guarda da listagem: zero movimento e zero documento com sucesso é
    // negativa de acesso, não "nenhuma das peças existe".
    if (!tribunalEntregouOConteudo(resposta.conteudo)) {
      throw new SemHabilitacaoNosAutosError(numeroProcesso);
    }

    const { obtidos, semTeor, ausentes } = extrairConteudosDoLote(
      resposta.conteudo,
      idsPecas,
      anexos,
    );
    this.logger.debug('lote de peças', {
      numeroProcesso,
      pedidas: idsPecas.length,
      obtidas: obtidos.length,
      semTeor: semTeor.length,
      ausentes: ausentes.length,
      bytesResposta,
    });
    return {
      conteudos: obtidos.map((o) => ({
        id: o.id,
        mimetype: o.mimetype,
        nomeArquivo: o.nomeArquivo ?? nomeDeArquivo(numeroProcesso, o.id, o.mimetype),
        bytes: o.bytes,
      })),
      semTeor,
      ausentes,
      bytesResposta,
    };
  }

  /**
   * UMA `consultarProcesso`, sem virar `Peca`/`Movimentacao` (v0.59.0, sonda do PJe).
   *
   * Existe para quem precisa CONTAR o que o tribunal devolveu (partes, tipos de arquivo, documentos sem
   * teor) sem que o adapter conheça esse relatório. É SÓ consulta: monta `consultarProcesso` e nenhum outro
   * envelope — não há aqui como pedir manifestação, ciência ou aviso. Mesmo balde, mesmo disjuntor de 403 e
   * mesma ausência de retry de todo o resto. `movimentos: true` sempre, porque no Projudi é o que destrava os
   * documentos e no PJe é inofensivo.
   */
  async consultarProcessoBruto(
    numeroProcesso: string,
    credencial: CredencialTribunal,
    opcoes: { readonly incluirCabecalho: boolean; readonly incluirDocumentos: boolean },
  ): Promise<ConsultaBrutaDoMni> {
    return this.chamar(
      envelopeConsultarProcesso({
        numeroProcesso,
        credencial,
        movimentos: true,
        incluirCabecalho: opcoes.incluirCabecalho,
        incluirDocumentos: opcoes.incluirDocumentos,
      }),
      ACAO_CONSULTAR_PROCESSO,
      numeroProcesso,
    );
  }

  async assinaturaDeMudanca(
    numeroProcesso: string,
    credencial: CredencialTribunal,
  ): Promise<AssinaturaDeMudanca> {
    const { resposta } = await this.chamar(
      envelopeConsultarAlteracao(numeroProcesso, credencial),
      ACAO_CONSULTAR_ALTERACAO,
      numeroProcesso,
    );
    return extrairAssinatura(resposta.conteudo);
  }

  private async chamar(
    xml: string,
    acao: string,
    numeroProcesso: string,
  ): Promise<{
    readonly resposta: RespostaMni;
    readonly anexos: ReadonlyMap<string, ParteMultipart>;
    readonly bytesResposta: number;
  }> {
    // Antes do balde: enquanto o disjuntor está aberto, nem ficha se gasta.
    this.conferirDisjuntor();
    await this.rateLimiter.adquirir();
    // De novo depois: a espera pela ficha pode ter atravessado um 403 tomado
    // por outra consulta concorrente.
    this.conferirDisjuntor();

    let bruta;
    try {
      bruta = await this.http.postXml(this.endpoint, xml, {
        SOAPAction: acaoSoap(acao, this.soapAction),
      });
    } catch (erro) {
      throw new ProviderIndisponivelError(
        this.nome,
        erro instanceof HttpTimeoutError ? 'timeout' : 'falha de rede',
        { cause: erro },
      );
    }

    // 403 tem tratamento próprio porque tem CAUSA própria e conhecida: MNI
    // bloqueia IP de datacenter. Num VPS isso atinge todos os assinantes ao
    // mesmo tempo, e a mensagem precisa dizer o que fazer — esperar, não trocar
    // a senha do cliente.
    //
    // E abre o disjuntor: até `bloqueadoAte`, nenhuma consulta MNI sai deste
    // processo, de nenhum assinante.
    if (bruta.status === 403) {
      const ate = this.clock.agora().getTime() + this.pausaApos403Ms;
      this.bloqueadoAte = Math.max(this.bloqueadoAte ?? 0, ate);
      this.logger.warn('MNI pausado: o tribunal respondeu 403', {
        numeroProcesso,
        retomarEm: new Date(this.bloqueadoAte).toISOString(),
        acao: 'nada a fazer: as consultas voltam sozinhas depois da pausa',
      });
      throw new MniBloqueadoError(this.nome, new Date(this.bloqueadoAte));
    }
    if (bruta.status === 429 || bruta.status >= 500) {
      throw new ProviderIndisponivelError(this.nome, `HTTP ${bruta.status}`);
    }

    let resposta: RespostaMni;
    let anexos: ReadonlyMap<string, ParteMultipart>;
    try {
      const lida = lerRespostaSoap(bruta.contentType, bruta.bytes);
      anexos = lida.anexos;
      resposta = abrirEnvelope(lida.xml);
    } catch (erro) {
      if (erro instanceof MultipartInvalidoError || erro instanceof XmlIlegivelError) {
        throw new RespostaInvalidaError(this.nome, erro.message, { cause: erro });
      }
      throw erro;
    }

    if (!resposta.sucesso) this.classificarRecusa(resposta.mensagem, numeroProcesso);

    return { resposta, anexos, bytesResposta: bruta.bytes.length };
  }

  /** Até quando o MNI está pausado por 403; `undefined` com o disjuntor fechado. */
  pausadoAte(): Date | undefined {
    if (this.bloqueadoAte === undefined) return undefined;
    if (this.clock.agora().getTime() >= this.bloqueadoAte) {
      this.bloqueadoAte = undefined;
      return undefined;
    }
    return new Date(this.bloqueadoAte);
  }

  private conferirDisjuntor(): void {
    const ate = this.pausadoAte();
    if (ate) throw new MniBloqueadoError(this.nome, ate);
  }

  /**
   * Traduz `sucesso: false` + mensagem em erro de domínio.
   *
   * O MNI responde **HTTP 200 em toda recusa** — verificado na captura real. A
   * única informação sobre o que deu errado é uma frase em português livre, e é
   * dela que sai a decisão entre "avise a pessoa para corrigir a senha" e "tente
   * outra fonte". Errar essa classificação para o lado do fallback é o pior caso:
   * o sistema insistiria com uma credencial recusada até a conta do advogado ser
   * bloqueada pelo tribunal.
   */
  private classificarRecusa(mensagem: string, numeroProcesso: string): never {
    const normalizada = normalizar(mensagem);

    if (MARCAS_DE_CREDENCIAL.some((m) => normalizada.includes(m))) {
      // A mensagem do tribunal vai junto porque é o que a pessoa precisa ler.
      // A credencial NÃO vai — nem aqui, nem no log.
      throw new CredencialTribunalInvalidaError(this.nome, mensagem);
    }

    if (MARCAS_DE_NAO_ENCONTRADO.some((m) => normalizada.includes(m))) {
      throw new ProcessoNaoEncontradoError(`número ${numeroProcesso}`, this.nome);
    }

    // Recusa que não sabemos ler vira indisponibilidade, e não "não encontrado":
    // dizer ao advogado que o processo dele não existe por causa de uma mensagem
    // nova do tribunal é o erro que este projeto se recusa a cometer.
    this.logger.warn('recusa do MNI sem classificação conhecida', {
      numeroProcesso,
      mensagem,
    });
    throw new ProviderIndisponivelError(
      this.nome,
      `o tribunal recusou a consulta: ${mensagem || 'sem mensagem'}`,
    );
  }
}

function nomeDeArquivo(numeroProcesso: string, idPeca: string, mimetype: string): string {
  return `${numeroProcesso}-peca-${idPeca}.${extensaoDe(mimetype)}`;
}

function extensaoDe(mimetype: string): string {
  const tipo = mimetype.toLowerCase();
  if (tipo.includes('pdf')) return 'pdf';
  if (tipo.includes('html')) return 'html';
  if (tipo.includes('jpeg') || tipo.includes('jpg')) return 'jpg';
  if (tipo.includes('png')) return 'png';
  if (tipo.includes('xml')) return 'xml';
  if (tipo.includes('plain')) return 'txt';
  return 'bin';
}

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}
