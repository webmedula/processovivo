import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import {
  chaveDaMovimentacao,
  detectarNovidades,
} from '../../domain/entities/Acompanhamento.js';
import { triar } from '../../domain/entities/triagem.js';
import type { Acompanhamento, Novidade } from '../../domain/entities/Acompanhamento.js';
import {
  AcompanhamentoNaoEncontradoError,
  AtoDaProvidenciaInvalidoError,
  DomainError,
  ProcessoNaoEncontradoError,
  TodasAsFontesFalharamError,
} from '../../domain/errors/index.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { ProcessoProvider } from '../../domain/ports/ProcessoProvider.js';
import type {
  AcompanhamentoResumido,
  FiltroAcompanhamentos,
  FiltroNovidades,
  RepositorioAcompanhamentos,
} from '../../domain/ports/RepositorioAcompanhamentos.js';

export interface ResultadoSincronizacao {
  readonly verificados: number;
  readonly comNovidade: number;
  readonly novidades: number;
  readonly falhas: number;
  readonly duracaoMs: number;
  /** Itens que a rodada tentou (v0.49.3): `verificados + falhas`. */
  readonly total?: number;
  /** Média da duração de UM item, do começo ao fim da consulta (v0.49.3): é a medida que o pool não esconde. */
  readonly duracaoMediaPorItemMs?: number;
  /** Quantos itens a rodada verificou ao mesmo tempo, no máximo (v0.49.3). */
  readonly concorrencia?: number;
}

export interface OpcoesServicoAcompanhamento {
  readonly repositorio: RepositorioAcompanhamentos;
  /** A cadeia de fontes. O serviço não sabe quais são. */
  readonly provider: ProcessoProvider;
  readonly logger: Logger;
  /** Teto de processos por varredura. Padrão: 200. */
  readonly maximoPorVarredura?: number;
  /** Pausa entre consultas, para não martelar a fonte. Padrão: 1500ms. */
  readonly pausaEntreConsultasMs?: number;
  /** Relógio injetável: o limite de espera se testa sem tempo real. */
  readonly agora?: () => Date;
  /** Sem NENHUM progresso por este tempo, a verificação é dita "demorando". Padrão: 5 min. */
  readonly limiteVerificacaoDemoradaMs?: number;
  /**
   * Quantos processos a varredura verifica AO MESMO TEMPO (v0.49.3). Padrão do SERVIÇO: 1, o comportamento de antes —
   * quem quer mais passa pela configuração (`SYNC_CONCORRENCIA`, padrão 3). Fora de 1..`CONCORRENCIA_MAXIMA`, é
   * ajustado: o serviço nunca fica sem trabalhador nem passa do teto.
   */
  readonly concorrencia?: number;
  /** A fonte primeira da cadeia, só para o registro por item dizer "fallback". Opcional. */
  readonly fontePrimaria?: string;
  /** Espera injetável: a pausa por item se testa sem tempo real. */
  readonly dormir?: (ms: number) => Promise<void>;
}

/** O que a configuração usa quando a variável não diz nada (v0.49.3). */
export const CONCORRENCIA_PADRAO = 3;
/**
 * O teto, que nenhuma configuração ultrapassa. Não é limite do CNJ (não há número publicado): é a escolha de projeto
 * que mantém a carga abaixo do que os limitadores de 60 requisições por minuto por fonte já impedem de passar.
 */
export const CONCORRENCIA_MAXIMA = 4;

/** Quanto a tela espera antes de dizer que as fontes estão lentas (v0.37.3). */
export const LIMITE_VERIFICACAO_DEMORADA_MS = 5 * 60_000;

/**
 * O que UMA conta pode saber da varredura. Só fala dos processos dela: a fila
 * global (quantos, de quem) nunca sai daqui.
 */
export interface EstadoDaVerificacao {
  readonly emAndamento: boolean;
  /** Processos DESTA conta ainda por verificar nesta rodada. */
  readonly pendentes: number;
  /** Quando a verificação desta conta começou a valer; `null` fora de andamento. */
  readonly desde: Date | null;
  /**
   * A verificação PAROU de avançar (v0.49.3): nenhum item de ninguém foi concluído há mais que o limite. Antes bastava
   * passar o limite desde o início da rodada global para toda conta ficar "demorando", mesmo com a fila andando.
   */
  readonly demorando: boolean;
  /** `na_fila` (esperando outra rodada) e `em_andamento` se distinguem aqui (v0.49.3). */
  readonly situacao: SituacaoDaVerificacao;
  /** Processos DESTA conta nesta rodada; 0 enquanto `na_fila` (a fila ainda não foi montada). */
  readonly total: number;
  /** Quantos deles já foram concluídos nesta rodada (verificados ou com falha registrada). */
  readonly concluidos: number;
  /** O instante do último item concluído desta conta nesta rodada; `null` antes do primeiro. */
  readonly ultimoProgressoEm: Date | null;
}

export type ResultadoDoPedido = 'iniciada' | 'ja_em_andamento' | 'na_fila';

/** `ociosa` não há verificação desta conta; `na_fila` espera a rodada de outra conta terminar; `em_andamento` roda. */
export type SituacaoDaVerificacao = 'ociosa' | 'na_fila' | 'em_andamento';

/**
 * Acompanhamento de processos: adicionar, listar e manter atualizado.
 *
 * É onde o produto deixa de ser consulta avulsa. E é o motivo de existir banco:
 * "o que mudou desde ontem" só pode ser respondido por quem guardou o ontem.
 *
 * A sincronização roda em SEGUNDO PLANO por necessidade, não por elegância. Uma
 * consulta fria ao CNJ leva cerca de 20 segundos; com 100 processos, uma
 * varredura completa passa de meia hora. Ninguém espera isso numa tela — então
 * o usuário sempre lê do banco, e a fila alimenta o banco no seu ritmo.
 */
export class ServicoAcompanhamento {
  private readonly repo: RepositorioAcompanhamentos;
  private readonly provider: ProcessoProvider;
  private readonly log: Logger;
  private readonly maximo: number;
  private readonly pausaMs: number;
  private sincronizando = false;
  /**
   * Por conta: os números que a rodada em curso ainda vai verificar. A varredura
   * global enche isto ao montar a fila e esvazia item a item; é daqui que sai o
   * "verificando agora" de CADA conta, em vez de uma bandeira única para todas.
   */
  private readonly pendentes = new Map<string, Set<string>>();
  /** Contas que pediram "verificar agora" com a varredura de outro rodando. */
  private readonly aguardando = new Set<string>();
  private readonly desde = new Map<string, Date>();
  /** Contas que pediram com a rodada de OUTRA conta ocupando o serviço (distingue `na_fila` de `em_andamento`). */
  private readonly esperandoAVez = new Set<string>();
  /** Por conta, nesta rodada: quantos processos ela tem e quantos já terminaram (v0.49.3). */
  private readonly totais = new Map<string, number>();
  private readonly concluidosPorConta = new Map<string, number>();
  private readonly progressoDaConta = new Map<string, Date>();
  /** Quando QUALQUER item foi concluído pela última vez: se a fila anda, ninguém está "demorando". */
  private progressoGlobal: Date | null = null;
  private readonly relogio: () => Date;
  private readonly limiteDemoradaMs: number;
  private readonly concorrencia: number;
  private readonly fontePrimaria: string | undefined;
  private readonly dormirFn: (ms: number) => Promise<void>;

  constructor(opcoes: OpcoesServicoAcompanhamento) {
    this.repo = opcoes.repositorio;
    this.provider = opcoes.provider;
    this.log = opcoes.logger.child({ servico: 'acompanhamento' });
    this.maximo = opcoes.maximoPorVarredura ?? 200;
    this.pausaMs = opcoes.pausaEntreConsultasMs ?? 1500;
    this.relogio = opcoes.agora ?? (() => new Date());
    this.limiteDemoradaMs =
      opcoes.limiteVerificacaoDemoradaMs ?? LIMITE_VERIFICACAO_DEMORADA_MS;
    const pedida = Math.floor(opcoes.concorrencia ?? 1);
    this.concorrencia = Math.min(
      CONCORRENCIA_MAXIMA,
      Number.isFinite(pedida) ? Math.max(1, pedida) : 1,
    );
    this.fontePrimaria = opcoes.fontePrimaria;
    this.dormirFn = opcoes.dormir ?? dormir;
  }

  /**
   * Passa a acompanhar um processo e já busca o primeiro retrato.
   *
   * Buscar na hora custa a espera da consulta fria, mas é o que faz o processo
   * aparecer preenchido na lista em vez de como uma linha vazia esperando a
   * próxima varredura.
   */
  async acompanhar(
    workspace: string,
    numeroInformado: string,
    apelido?: string,
  ): Promise<Acompanhamento> {
    const numero = NumeroCNJ.criar(numeroInformado);
    await this.repo.acompanhar(workspace, numero.digitos, apelido);

    try {
      const processo = await this.provider.buscarPorNumero(numero.digitos);
      // Primeira sincronização não gera novidade — ver `detectarNovidades`.
      await this.repo.registrarSincronizacao(workspace, numero.digitos, processo, []);
    } catch (erro) {
      // Falhar a busca NÃO desfaz o acompanhamento: o processo fica na lista
      // com o motivo, e a varredura tenta de novo. Desfazer obrigaria o usuário
      // a readicionar toda vez que o tribunal estivesse fora do ar.
      await this.repo.registrarFalha(workspace, numero.digitos, descrever(erro));
      this.log.warn('primeira busca do acompanhamento falhou', {
        numero: numero.formatado,
        erro: descrever(erro),
      });
    }

    const salvo = await this.repo.buscar(workspace, numero.digitos);
    if (!salvo) throw new Error('acompanhamento não encontrado após gravação');
    return salvo;
  }

  async deixarDeAcompanhar(workspace: string, numeroInformado: string): Promise<boolean> {
    const numero = NumeroCNJ.criar(numeroInformado);
    return this.repo.deixarDeAcompanhar(workspace, numero.digitos);
  }

  /**
   * Rotula a pasta com o nome do cliente. String vazia apaga o rótulo.
   *
   * O número passa por `NumeroCNJ` como em toda operação daqui: sem isso, um
   * dígito trocado rotularia silenciosamente nada, e a tela mostraria sucesso.
   */
  async rotular(
    workspace: string,
    numeroInformado: string,
    cliente: string,
  ): Promise<boolean> {
    const numero = NumeroCNJ.criar(numeroInformado);
    return this.repo.rotular(workspace, numero.digitos, cliente);
  }

  /**
   * "Cumpri o que este ato pedia" (v0.37.5).
   *
   * A marca cobre os atos até a data do ato marcado; um ato posterior que exija
   * ação volta a pedir providência sozinho. NÃO mexe nas novidades nem na "não
   * lida": ler não é cumprir. Só atos que de fato pedem providência podem ser
   * marcados, e o ato vem da tela (não o escolhemos no servidor): se um ato novo
   * chegou entre o desenho da tela e o clique, a marca cobre o que a pessoa viu,
   * não o que ela não viu.
   *
   * Marcar um ato que já está coberto é um no-op: a marca nunca recua.
   *
   * @returns o acompanhamento já com a marca, para a rota responder sem reler tudo
   */
  async marcarComoCumprido(
    workspace: string,
    numeroInformado: string,
    chaveDoAto: string,
    quem: string,
  ): Promise<Acompanhamento> {
    const numero = NumeroCNJ.criar(numeroInformado).digitos;
    const atual = await this.repo.buscar(workspace, numero);
    if (!atual) throw new AcompanhamentoNaoEncontradoError();

    const ato = atual.processo?.movimentacoes.find(
      (m) => chaveDaMovimentacao(m) === chaveDoAto,
    );
    if (!ato) {
      throw new AtoDaProvidenciaInvalidoError(
        'Esse ato não está mais no último retrato do processo. Atualize a tela e confira de novo.',
      );
    }
    if (!(ato.exigeAcao ?? triar(ato).exigeAcao)) {
      throw new AtoDaProvidenciaInvalidoError(
        'Esse ato não está marcado como pedindo providência.',
      );
    }
    if (atual.cumprido && ato.data.getTime() <= atual.cumprido.ate.getTime()) {
      return atual;
    }

    const cumprido = { chave: chaveDoAto, ate: ato.data, em: this.relogio(), por: quem };
    await this.repo.marcarCumprido(workspace, numero, cumprido);
    return { ...atual, cumprido };
  }

  /** Desfaz a marca. Sem marca é um no-op; processo de outra conta é "não acompanhado". */
  async desfazerCumprido(
    workspace: string,
    numeroInformado: string,
  ): Promise<Acompanhamento> {
    const numero = NumeroCNJ.criar(numeroInformado).digitos;
    const atual = await this.repo.buscar(workspace, numero);
    if (!atual) throw new AcompanhamentoNaoEncontradoError();
    if (!atual.cumprido) return atual;
    await this.repo.desfazerCumprido(workspace, numero);
    const { cumprido: _removida, ...semMarca } = atual;
    void _removida;
    return semMarca;
  }

  async clientes(workspace: string): Promise<string[]> {
    return this.repo.clientes(workspace);
  }

  async listar(
    workspace: string,
    filtro?: FiltroAcompanhamentos,
  ): Promise<AcompanhamentoResumido[]> {
    return this.repo.listar(workspace, filtro);
  }

  async detalhar(
    workspace: string,
    numeroInformado: string,
  ): Promise<Acompanhamento | undefined> {
    return this.repo.buscar(workspace, NumeroCNJ.criar(numeroInformado).digitos);
  }

  async novidades(workspace: string, filtro?: FiltroNovidades): Promise<Novidade[]> {
    return this.repo.listarNovidades(workspace, filtro);
  }

  async contarAcompanhamentos(workspace: string): Promise<number> {
    return this.repo.contarAcompanhamentos(workspace);
  }

  async contarNaoVistas(workspace: string): Promise<number> {
    return this.repo.contarNaoVistas(workspace);
  }

  async marcarComoVistas(workspace: string, numeroInformado?: string): Promise<number> {
    const numero = numeroInformado ? NumeroCNJ.criar(numeroInformado).digitos : undefined;
    return this.repo.marcarComoVistas(workspace, numero);
  }

  async facetas(workspace: string): Promise<{ tribunais: string[]; classes: string[] }> {
    return this.repo.facetas(workspace);
  }

  /**
   * Varre os acompanhamentos, busca cada um e registra o que mudou.
   *
   * Sequencial e com pausa entre consultas, de propósito. Paralelizar contra a
   * API pública do CNJ — que usa uma chave compartilhada por todo o país —
   * queimaria a cota de todo mundo e renderia bloqueio.
   *
   * Reentrância bloqueada: se a varredura anterior ainda roda (e pode rodar por
   * meia hora), a nova é recusada em vez de duplicar consultas.
   */
  /**
   * @param opcoes `workspace` limita a varredura a um assinante. A varredura
   *   AGENDADA chama sem ele, de propósito: ela é de todo mundo. A rota HTTP
   *   sempre passa o do chamador.
   */
  async sincronizar(
    opcoes: { workspace?: string } = {},
  ): Promise<ResultadoSincronizacao> {
    try {
      return await this.executar(opcoes);
    } finally {
      // Quem pediu enquanto outra varredura rodava vai agora, uma conta por vez.
      void this.drenarPedidos();
    }
  }

  /**
   * "Verificar agora" de uma conta. Nunca dispara uma segunda verificação da
   * mesma conta: com uma em curso (ou já na fila) devolve `ja_em_andamento`.
   * Com a varredura de OUTRAS contas ocupando o serviço, o pedido espera a vez
   * (`na_fila`) — a cota do CNJ é compartilhada, então não há duas varreduras
   * ao mesmo tempo — e a conta aparece "em andamento" desde já.
   */
  solicitar(workspace: string): ResultadoDoPedido {
    if (this.estadoDa(workspace).emAndamento) return 'ja_em_andamento';
    if (this.sincronizando) {
      this.aguardando.add(workspace);
      this.esperandoAVez.add(workspace);
      this.desde.set(workspace, this.relogio());
      return 'na_fila';
    }
    // Marca já: entre aqui e a fila montada (uma ida ao banco) a conta precisa
    // aparecer "em andamento", senão a primeira consulta de status diz que acabou.
    this.aguardando.add(workspace);
    this.desde.set(workspace, this.relogio());
    void this.executar({ workspace })
      .catch(() => {
        /* já registrado no log pelo serviço */
      })
      .finally(() => {
        this.aguardando.delete(workspace);
        this.esperandoAVez.delete(workspace);
        this.desde.delete(workspace);
        void this.drenarPedidos();
      });
    return 'iniciada';
  }

  /** O estado desta conta e só dela (v0.37.3; progresso e situação na v0.49.3). */
  estadoDa(workspace: string): EstadoDaVerificacao {
    const pendentes = this.pendentes.get(workspace)?.size ?? 0;
    const emAndamento = pendentes > 0 || this.aguardando.has(workspace);
    const situacao: SituacaoDaVerificacao =
      pendentes > 0
        ? 'em_andamento'
        : this.esperandoAVez.has(workspace)
          ? 'na_fila'
          : emAndamento
            ? 'em_andamento'
            : 'ociosa';
    const desde = emAndamento ? (this.desde.get(workspace) ?? null) : null;
    const daConta = emAndamento ? (this.progressoDaConta.get(workspace) ?? null) : null;
    // "Demorando" é "parou de avançar": o último sinal de vida é o mais recente entre o início desta conta, o último
    // item dela e o último item de QUALQUER conta. Rodada longa com a fila andando não é demora.
    const sinais = [desde, daConta, desde ? this.progressoGlobal : null].filter(
      (d): d is Date => d !== null,
    );
    const ultimoSinal = sinais.length
      ? Math.max(...sinais.map((d) => d.getTime()))
      : null;
    const demorando =
      ultimoSinal !== null &&
      this.relogio().getTime() - ultimoSinal > this.limiteDemoradaMs;
    return {
      emAndamento,
      pendentes,
      desde,
      demorando,
      situacao,
      total: emAndamento ? (this.totais.get(workspace) ?? 0) : 0,
      concluidos: emAndamento ? (this.concluidosPorConta.get(workspace) ?? 0) : 0,
      ultimoProgressoEm: daConta,
    };
  }

  private async drenarPedidos(): Promise<void> {
    while (!this.sincronizando) {
      const proximo = this.aguardando.values().next();
      if (proximo.done) return;
      // Fica na lista até terminar: a conta segue "em andamento" sem intervalo.
      this.esperandoAVez.delete(proximo.value);
      try {
        await this.executar({ workspace: proximo.value });
      } catch (erro) {
        // Outra varredura tomou a vez: o pedido continua na fila para a próxima.
        if (erro instanceof SincronizacaoEmAndamentoError) {
          this.esperandoAVez.add(proximo.value);
          return;
        }
      }
      this.aguardando.delete(proximo.value);
      this.desde.delete(proximo.value);
    }
  }

  private async executar(
    opcoes: { workspace?: string } = {},
  ): Promise<ResultadoSincronizacao> {
    if (this.sincronizando) {
      throw new SincronizacaoEmAndamentoError();
    }
    this.sincronizando = true;
    const inicio = Date.now();

    const contagem = {
      verificados: 0,
      comNovidade: 0,
      novidades: 0,
      falhas: 0,
      somaDuracoesMs: 0,
    };
    let total = 0;
    let usadas = 0;

    try {
      const fila = await this.repo.listarParaSincronizar(this.maximo, opcoes.workspace);
      total = fila.length;
      usadas = Math.min(this.concorrencia, fila.length);
      this.log.info('varredura iniciada', {
        total: fila.length,
        concorrencia: this.concorrencia,
      });
      const inicioDaRodada = this.relogio();
      this.progressoGlobal = inicioDaRodada;
      for (const item of fila) {
        let set = this.pendentes.get(item.workspace);
        if (!set) {
          set = new Set<string>();
          this.pendentes.set(item.workspace, set);
          // Quem já esperava na fila mantém a hora do pedido.
          if (!this.desde.has(item.workspace))
            this.desde.set(item.workspace, inicioDaRodada);
        }
        set.add(item.numero);
        this.totais.set(item.workspace, (this.totais.get(item.workspace) ?? 0) + 1);
      }

      // POOL (v0.49.3): `concorrencia` trabalhadores tiram da MESMA fila, na MESMA ordem (nunca sincronizados
      // primeiro, depois os de tentativa mais antiga). Cada um pega o próximo índice de forma síncrona, então um item
      // nunca é pego por dois. O número do processo vale mais que o item: duas contas podem acompanhar o MESMO
      // processo, e consultar o CNJ duas vezes ao mesmo tempo desperdiçaria o cache — quem chega depois espera o
      // primeiro terminar e a segunda consulta sai da memória, como na varredura de um só trabalhador.
      let proximo = 0;
      const emVoo = new Map<string, Promise<void>>();
      const trabalhador = async (): Promise<void> => {
        for (;;) {
          const item = fila[proximo++];
          if (!item) return;
          for (
            let anterior = emVoo.get(item.numero);
            anterior;
            anterior = emVoo.get(item.numero)
          ) {
            await anterior;
          }
          const feito = this.verificarItem(item, contagem);
          emVoo.set(item.numero, feito);
          await feito;
          emVoo.delete(item.numero);
          // A pausa é de CADA trabalhador, depois de cada item (falha e cache incluídos), como antes.
          try {
            if (this.pausaMs > 0) await this.dormirFn(this.pausaMs);
          } catch {
            /* uma espera que falha não pode derrubar o trabalhador */
          }
        }
      };
      // allSettled: um trabalhador que morresse não interrompe os outros, e a varredura só acaba quando todos acabam.
      await Promise.allSettled(Array.from({ length: usadas }, () => trabalhador()));
    } finally {
      this.sincronizando = false;
      // Falha no meio da fila não pode deixar conta "verificando" para sempre.
      this.pendentes.clear();
      this.totais.clear();
      this.concluidosPorConta.clear();
      this.progressoDaConta.clear();
      for (const ws of [...this.desde.keys()]) {
        if (!this.aguardando.has(ws)) this.desde.delete(ws);
      }
    }

    const itens = contagem.verificados + contagem.falhas;
    const resultado = {
      verificados: contagem.verificados,
      comNovidade: contagem.comNovidade,
      novidades: contagem.novidades,
      falhas: contagem.falhas,
      duracaoMs: Date.now() - inicio,
      total,
      duracaoMediaPorItemMs: itens > 0 ? Math.round(contagem.somaDuracoesMs / itens) : 0,
      concorrencia: usadas,
    };
    this.log.info('varredura concluída', resultado);
    return resultado;
  }

  /**
   * Verifica UM item e nunca lança: o erro de um processo não pode parar os outros trabalhadores.
   * Deixa um registro `info` por item (v0.49.3) — número, fonte que respondeu, duração e resultado —, que é o que
   * permite medir em produção quanto cada consulta leva de verdade. Sem nome de parte, sem texto de ato.
   */
  private async verificarItem(
    item: Acompanhamento,
    contagem: {
      verificados: number;
      comNovidade: number;
      novidades: number;
      falhas: number;
      somaDuracoesMs: number;
    },
  ): Promise<void> {
    const inicio = Date.now();
    try {
      const atual = await this.provider.buscarPorNumero(item.numero);
      const novas = detectarNovidades(item.processo, atual);

      await this.repo.registrarSincronizacao(item.workspace, item.numero, atual, novas);

      contagem.verificados++;
      if (novas.length > 0) {
        contagem.comNovidade++;
        contagem.novidades += novas.length;
        this.log.info('novidade detectada', {
          numero: item.numero,
          quantas: novas.length,
        });
      }
      const duracaoMs = Date.now() - inicio;
      contagem.somaDuracoesMs += duracaoMs;
      const fonte = atual.procedencia.provider;
      const fontes = fonte.split('+').filter(Boolean);
      this.log.info('processo verificado', {
        numero: item.numero,
        resultado:
          this.fontePrimaria && !fontes.includes(this.fontePrimaria) ? 'fallback' : 'ok',
        fonte,
        fontes: fontes.length,
        deCache: atual.procedencia.deCache,
        duracaoMs,
      });
    } catch (erro) {
      contagem.falhas++;
      const duracaoMs = Date.now() - inicio;
      contagem.somaDuracoesMs += duracaoMs;
      // "Não encontrado" também é falha do ponto de vista da varredura, mas
      // não é ruído de sistema: o processo pode ter sido arquivado ou o
      // tribunal saído da cobertura. Registramos e seguimos.
      const nivel = erro instanceof ProcessoNaoEncontradoError ? 'debug' : 'warn';
      this.log[nivel]('falha ao sincronizar processo', {
        numero: item.numero,
        erro: descrever(erro),
      });
      this.log.info('processo verificado', {
        numero: item.numero,
        resultado: 'falha',
        ...(erro instanceof DomainError ? { codigo: erro.codigo } : {}),
        ...(erro instanceof TodasAsFontesFalharamError
          ? { fontesTentadas: erro.tentativas.length }
          : {}),
        duracaoMs,
      });
      try {
        await this.repo.registrarFalha(item.workspace, item.numero, descrever(erro));
      } catch (falhaAoRegistrar) {
        this.log.warn('não foi possível registrar a falha do processo', {
          numero: item.numero,
          erro: descrever(falhaAoRegistrar),
        });
      }
    } finally {
      this.concluirItem(item.workspace, item.numero);
    }
  }

  /** Há varredura rodando (de qualquer conta). Uso interno e do guarda de reentrância — a API pública usa `estadoDa`. */
  get emAndamento(): boolean {
    return this.sincronizando;
  }

  private concluirItem(workspace: string, numero: string): void {
    const agora = this.relogio();
    this.progressoGlobal = agora;
    this.progressoDaConta.set(workspace, agora);
    this.concluidosPorConta.set(
      workspace,
      (this.concluidosPorConta.get(workspace) ?? 0) + 1,
    );
    const set = this.pendentes.get(workspace);
    if (!set) return;
    set.delete(numero);
    if (set.size === 0) {
      this.pendentes.delete(workspace);
      this.totais.delete(workspace);
      this.concluidosPorConta.delete(workspace);
      this.progressoDaConta.delete(workspace);
      if (!this.aguardando.has(workspace)) this.desde.delete(workspace);
    }
  }
}

export class SincronizacaoEmAndamentoError extends Error {
  readonly codigo = 'SINCRONIZACAO_EM_ANDAMENTO';
  constructor() {
    super('Já existe uma varredura em andamento. Aguarde a atual terminar.');
    this.name = 'SincronizacaoEmAndamentoError';
  }
}

function descrever(erro: unknown): string {
  if (erro instanceof DomainError) return `${erro.codigo}: ${erro.message}`;
  if (erro instanceof Error) return erro.message;
  return String(erro);
}

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
