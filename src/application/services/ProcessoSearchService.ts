import type { Processo } from '../../domain/entities/Processo.js';
import { fundirProcessos } from '../../domain/entities/fusaoProcessos.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import {
  DomainError,
  OperacaoNaoSuportadaError,
  ProcessoNaoEncontradoError,
  TodasAsFontesFalharamError,
} from '../../domain/errors/index.js';
import type { Logger } from '../../domain/ports/Logger.js';
import { loggerSilencioso } from '../../infrastructure/logging/ConsoleLogger.js';
import type {
  CapacidadesProvider,
  DiagnosticoProvider,
  ProcessoProvider,
} from '../../domain/ports/ProcessoProvider.js';

export type EstrategiaOab = 'PRIMEIRA_RESPOSTA' | 'AGREGAR';

export interface OpcoesProcessoSearchService {
  /**
   * Cadeia ordenada: o primeiro é o primário, os seguintes são fallback.
   * A ordem é decisão de negócio (custo, frescor, riqueza do dado), não técnica —
   * por isso vem de configuração e não está gravada em código.
   */
  readonly providers: readonly ProcessoProvider[];
  readonly logger?: Logger;
  /**
   * `AGREGAR` (padrão) une os resultados de todas as fontes que suportam OAB;
   * `PRIMEIRA_RESPOSTA` para na primeira que responder.
   * Agregar é o padrão porque a carteira de um advogado costuma atravessar
   * tribunais, e cada crawler cobre um — parar no primeiro devolveria carteira
   * pela metade sem avisar ninguém.
   */
  readonly estrategiaOab?: EstrategiaOab;
  /**
   * Faz `healthCheck` antes de consultar cada fonte. Custa uma ida a mais e só
   * compensa quando o provider primário é lento para falhar. Padrão: false.
   */
  readonly verificarSaude?: boolean;
  /**
   * Depois de achar o processo, consulta as fontes SEGUINTES que sabem algo que
   * a vencedora não sabe, e funde os resultados. Padrão: true.
   *
   * É o que transforma a cadeia de fallback numa busca de fato híbrida. Sem
   * isso, quem responde primeiro define o teto do que o usuário vê: o DataJud
   * devolve a linha do tempo completa e nenhuma parte, e o advogado nunca fica
   * sabendo que o nome do adversário e o inteiro teor do despacho estavam
   * disponíveis na fonte seguinte.
   *
   * Custa uma requisição a mais por consulta — e só nas fontes que agregam algo
   * que falta, nunca em todas.
   */
  readonly enriquecer?: boolean;
}

interface Tentativa {
  readonly provider: string;
  readonly erro: string;
}

/**
 * Orquestrador da busca híbrida (Strategy + Chain of Responsibility + Composite).
 *
 * Implementa a PRÓPRIA porta `ProcessoProvider`. Isso é o que mantém o desenho
 * honesto: para os casos de uso, "a cadeia inteira de fontes" é indistinguível
 * de "uma fonte". Dá para aninhar orquestradores, embrulhar em cache ou trocar
 * por um único adapter sem tocar em nada acima.
 *
 * Como as falhas são classificadas — e por que isso importa:
 *
 *   OperacaoNaoSuportadaError  a fonte não faz isso e nunca vai fazer.
 *                              PULA sem contar como falha. É o caso do DataJud
 *                              com busca por OAB.
 *   ProcessoNaoEncontradoError a fonte respondeu e não tem o processo.
 *                              Segue para a próxima (outra base pode ter), mas
 *                              lembra que houve resposta legítima: se TODAS
 *                              as consultadas disserem isso, o erro final é
 *                              "não encontrado". Se alguma FALHOU, o erro final
 *                              é "as fontes falharam" — a que falhou podia ter
 *                              o processo.
 *   ProviderIndisponivelError  rede, timeout, captcha, tribunal fora do ar.
 *                              É o caso que o fallback existe para cobrir.
 *
 * Distinguir "não existe" de "não consegui ver" é a decisão central deste
 * arquivo. Colapsar as duas coisas em um erro genérico faria o produto dizer
 * ao advogado que o processo dele não existe sempre que o TJSP saísse do ar.
 */
export class ProcessoSearchService implements ProcessoProvider {
  readonly nome = 'orquestrador';

  private readonly providers: readonly ProcessoProvider[];
  private readonly logger: Logger;
  private readonly estrategiaOab: EstrategiaOab;
  private readonly verificarSaude: boolean;
  private readonly enriquecer: boolean;

  constructor(opcoes: OpcoesProcessoSearchService) {
    if (opcoes.providers.length === 0) {
      throw new Error('ProcessoSearchService exige ao menos um provider na cadeia.');
    }
    this.providers = opcoes.providers;
    this.logger = (opcoes.logger ?? loggerSilencioso).child({ provider: this.nome });
    this.estrategiaOab = opcoes.estrategiaOab ?? 'AGREGAR';
    this.verificarSaude = opcoes.verificarSaude ?? false;
    this.enriquecer = opcoes.enriquecer ?? true;
  }

  /**
   * Completa o processo com o que as fontes seguintes sabem e a vencedora não.
   *
   * Só consulta quem AGREGA: uma fonte que não traz partes nem inteiro teor,
   * quando já temos os dois, é uma requisição jogada fora. E falha de
   * enriquecimento nunca derruba a consulta — o usuário já tem um resultado
   * válido na mão; perder o extra é degradação, não erro.
   */
  private async complementar(
    processo: Processo,
    sigla: string | null,
    vencedora: ProcessoProvider,
    jaDescartadas: ReadonlySet<ProcessoProvider>,
  ): Promise<Processo> {
    let atual = processo;
    // Linha do tempo é o único "buraco" que não dá para enxergar olhando o
    // resultado: 8 movimentações podem ser o processo inteiro ou um recorte, e
    // só a fonte sabe qual. Por isso aqui a resposta vem da capacidade
    // declarada, não do dado.
    let temLinhaCompleta = vencedora.capacidades.retornaLinhaDoTempoCompleta;

    for (const provider of this.providers) {
      if (jaDescartadas.has(provider)) continue;
      if (!provider.capacidades.buscarPorNumero) continue;
      // A sigla é a do número CONSULTADO, não a do processo devolvido: são a
      // mesma coisa quando tudo está certo, e quando não estão é a consulta que
      // manda — senão uma fonte que devolveu o processo errado passaria a
      // decidir quem mais é chamado.
      if (!this.atendeTribunal(provider, sigla)) continue;
      if (this.verificarSaude && !(await this.estaSaudavel(provider))) continue;

      const traPartes = provider.capacidades.retornaPartes && atual.partes.length === 0;
      const traTeor =
        provider.capacidades.retornaConteudoMovimentacoes &&
        !atual.movimentacoes.some((m) => m.conteudo);
      const traLinha =
        provider.capacidades.retornaLinhaDoTempoCompleta && !temLinhaCompleta;
      if (!traPartes && !traTeor && !traLinha) continue;

      try {
        const extra = await provider.buscarPorNumero(atual.numero.digitos);
        atual = fundirProcessos(atual, extra);
        if (traLinha) temLinhaCompleta = true;
        this.logger.info('processo enriquecido por fonte complementar', {
          fonte: provider.nome,
          partes: atual.partes.length,
          movimentacoes: atual.movimentacoes.length,
        });
      } catch (erro) {
        this.logger.debug('fonte complementar não acrescentou nada', {
          fonte: provider.nome,
          erro: descrever(erro),
        });
      }
    }

    return atual;
  }

  /** União das capacidades da cadeia — o que o conjunto consegue fazer. */
  get capacidades(): CapacidadesProvider {
    const tribunais = new Set<string>();
    for (const p of this.providers) {
      for (const t of p.capacidades.tribunais) tribunais.add(t);
    }
    return {
      buscarPorNumero: this.providers.some((p) => p.capacidades.buscarPorNumero),
      buscarPorOab: this.providers.some((p) => p.capacidades.buscarPorOab),
      retornaPartes: this.providers.some((p) => p.capacidades.retornaPartes),
      retornaConteudoMovimentacoes: this.providers.some(
        (p) => p.capacidades.retornaConteudoMovimentacoes,
      ),
      retornaLinhaDoTempoCompleta: this.providers.some(
        (p) => p.capacidades.retornaLinhaDoTempoCompleta,
      ),
      tribunais: tribunais.has('*') ? ['*'] : [...tribunais],
    };
  }

  async buscarPorNumero(numeroProcesso: string): Promise<Processo> {
    const numero = NumeroCNJ.criar(numeroProcesso);
    const sigla = numero.siglaTribunal;
    const criterio = `número ${numero.formatado}`;

    const tentativas: Tentativa[] = [];
    let algumaFonteRespondeuSemAchar = false;
    /**
     * Alguma fonte NÃO conseguiu responder (rede, timeout, limite, 5xx, payload
     * inválido, health check negativo). Enquanto houver uma, "não encontrado" de
     * outra não prova nada: o DJEN só conhece o que foi publicado, então ele
     * dizer "não tenho" com o DataJud em limite de requisições é "não consegui
     * ver", não "não existe" (v0.67.3).
     */
    let algumaFonteFalhou = false;

    /**
     * Fontes que já foram descartadas NESTA consulta — porque falharam, porque
     * não cobrem o tribunal ou porque reprovaram no health check. O
     * enriquecimento não pode reabri-las: perguntar de novo a quem acabou de dar
     * timeout dobra o tempo da resposta para não acrescentar nada.
     */
    const jaDescartadas = new Set<ProcessoProvider>();

    for (const provider of this.providers) {
      if (!provider.capacidades.buscarPorNumero) continue;
      if (!this.atendeTribunal(provider, sigla)) {
        jaDescartadas.add(provider);
        this.logger.debug('fonte ignorada: não cobre o tribunal', {
          fonte: provider.nome,
          tribunal: sigla,
        });
        continue;
      }
      if (this.verificarSaude && !(await this.estaSaudavel(provider))) {
        jaDescartadas.add(provider);
        algumaFonteFalhou = true;
        tentativas.push({ provider: provider.nome, erro: 'healthCheck negativo' });
        continue;
      }

      try {
        const processo = await provider.buscarPorNumero(numero.digitos);
        this.logger.info('processo localizado', {
          fonte: provider.nome,
          numero: numero.formatado,
          tentativasAnteriores: tentativas.length,
        });
        jaDescartadas.add(provider);
        return this.enriquecer
          ? await this.complementar(processo, sigla, provider, jaDescartadas)
          : processo;
      } catch (erro) {
        jaDescartadas.add(provider);
        if (erro instanceof OperacaoNaoSuportadaError) {
          this.logger.debug('fonte não suporta a operação', { fonte: provider.nome });
          continue;
        }
        if (erro instanceof ProcessoNaoEncontradoError) {
          algumaFonteRespondeuSemAchar = true;
          tentativas.push({ provider: provider.nome, erro: 'não encontrado' });
          this.logger.debug('fonte respondeu sem resultado', {
            fonte: provider.nome,
          });
          continue;
        }
        algumaFonteFalhou = true;
        tentativas.push({ provider: provider.nome, erro: descrever(erro) });
        this.logger.warn('fonte falhou, acionando fallback', {
          fonte: provider.nome,
          erro: descrever(erro),
        });
      }
    }

    // "Não existe" só quando TODA fonte consultada respondeu isso. Uma falha
    // passageira no meio deixa o resultado como "não consegui ver".
    if (algumaFonteRespondeuSemAchar && !algumaFonteFalhou) {
      throw new ProcessoNaoEncontradoError(criterio);
    }
    throw new TodasAsFontesFalharamError(criterio, tentativas);
  }

  async buscarPorOab(oab: string, uf: string): Promise<Processo[]> {
    const criterio = `OAB ${oab}/${uf.toUpperCase()}`;
    const tentativas: Tentativa[] = [];
    const agregado = new Map<string, Processo>();
    let algumaFonteRespondeu = false;

    for (const provider of this.providers) {
      if (!provider.capacidades.buscarPorOab) {
        this.logger.debug('fonte não busca por OAB', { fonte: provider.nome });
        continue;
      }
      if (this.verificarSaude && !(await this.estaSaudavel(provider))) {
        tentativas.push({ provider: provider.nome, erro: 'healthCheck negativo' });
        continue;
      }

      try {
        const processos = await provider.buscarPorOab(oab, uf);
        algumaFonteRespondeu = true;

        if (this.estrategiaOab === 'PRIMEIRA_RESPOSTA') {
          this.logger.info('carteira obtida', {
            fonte: provider.nome,
            total: processos.length,
          });
          return processos;
        }

        // Dedupe pelo número CNJ: a primeira fonte da cadeia vence, o que faz a
        // ordem dos providers valer também como ordem de PREFERÊNCIA de dado.
        for (const processo of processos) {
          const chave = processo.numero.digitos;
          if (!agregado.has(chave)) agregado.set(chave, processo);
        }
      } catch (erro) {
        if (erro instanceof OperacaoNaoSuportadaError) continue;
        tentativas.push({ provider: provider.nome, erro: descrever(erro) });
        this.logger.warn('fonte falhou na busca por OAB', {
          fonte: provider.nome,
          erro: descrever(erro),
        });
      }
    }

    // Resultado parcial vale mais do que erro: se ao menos uma fonte respondeu,
    // devolvemos o que há. A falha das demais fica no log, não na cara do usuário.
    if (algumaFonteRespondeu) {
      this.logger.info('carteira agregada', {
        total: agregado.size,
        fontesComFalha: tentativas.length,
      });
      return [...agregado.values()];
    }

    throw new TodasAsFontesFalharamError(criterio, tentativas);
  }

  /** Saudável se PELO MENOS UMA fonte da cadeia responder — é o ponto do fallback. */
  async healthCheck(): Promise<boolean> {
    const resultados = await Promise.all(this.providers.map((p) => this.estaSaudavel(p)));
    return resultados.some(Boolean);
  }

  /**
   * Diagnóstico por fonte, para o endpoint de readiness e para o CLI.
   * Traz o MOTIVO quando a fonte o expõe — sem isso, "saudavel: false" é um
   * beco sem saída para quem está tentando descobrir o que configurar.
   */
  async diagnostico(): Promise<
    Array<{ provider: string; saudavel: boolean; lenta?: true; motivo?: string }>
  > {
    return Promise.all(
      this.providers.map(async (p) => {
        const resultado = await this.diagnosticarProvider(p);
        return {
          provider: p.nome,
          saudavel: resultado.saudavel,
          ...(resultado.lenta ? { lenta: true as const } : {}),
          ...(resultado.motivo !== undefined ? { motivo: resultado.motivo } : {}),
        };
      }),
    );
  }

  private atendeTribunal(provider: ProcessoProvider, sigla: string | null): boolean {
    const { tribunais } = provider.capacidades;
    if (tribunais.includes('*')) return true;
    if (!sigla) return false;
    return tribunais.includes(sigla);
  }

  private async estaSaudavel(provider: ProcessoProvider): Promise<boolean> {
    return (await this.diagnosticarProvider(provider)).saudavel;
  }

  /**
   * Usa `diagnosticar()` quando a fonte oferece; cai para `healthCheck()` quando
   * não. O contrato diz que nenhum dos dois lança — mas o try/catch fica, porque
   * "não deveria lançar" e "não lança" são coisas diferentes, e um adapter mal
   * comportado não pode derrubar o diagnóstico da cadeia inteira.
   */
  private async diagnosticarProvider(
    provider: ProcessoProvider,
  ): Promise<DiagnosticoProvider> {
    try {
      if (provider.diagnosticar) return await provider.diagnosticar();
      return { saudavel: await provider.healthCheck() };
    } catch (erro) {
      return { saudavel: false, motivo: `health check falhou: ${descrever(erro)}` };
    }
  }
}

function descrever(erro: unknown): string {
  if (erro instanceof DomainError) return `${erro.codigo}: ${erro.message}`;
  if (erro instanceof Error) return erro.message;
  return String(erro);
}
