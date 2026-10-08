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
  /** Passado esse tempo, a verificação da conta é dita "demorando". Padrão: 5 min. */
  readonly limiteVerificacaoDemoradaMs?: number;
}

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
  /** Passou do limite de espera: a tela para de girar e diz que as fontes estão lentas. */
  readonly demorando: boolean;
}

export type ResultadoDoPedido = 'iniciada' | 'ja_em_andamento' | 'na_fila';

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
  private readonly relogio: () => Date;
  private readonly limiteDemoradaMs: number;

  constructor(opcoes: OpcoesServicoAcompanhamento) {
    this.repo = opcoes.repositorio;
    this.provider = opcoes.provider;
    this.log = opcoes.logger.child({ servico: 'acompanhamento' });
    this.maximo = opcoes.maximoPorVarredura ?? 200;
    this.pausaMs = opcoes.pausaEntreConsultasMs ?? 1500;
    this.relogio = opcoes.agora ?? (() => new Date());
    this.limiteDemoradaMs =
      opcoes.limiteVerificacaoDemoradaMs ?? LIMITE_VERIFICACAO_DEMORADA_MS;
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
        this.desde.delete(workspace);
        void this.drenarPedidos();
      });
    return 'iniciada';
  }

  /** O estado desta conta e só dela (v0.37.3). */
  estadoDa(workspace: string): EstadoDaVerificacao {
    const pendentes = this.pendentes.get(workspace)?.size ?? 0;
    const emAndamento = pendentes > 0 || this.aguardando.has(workspace);
    const desde = emAndamento ? (this.desde.get(workspace) ?? null) : null;
    const demorando =
      desde !== null && this.relogio().getTime() - desde.getTime() > this.limiteDemoradaMs;
    return { emAndamento, pendentes, desde, demorando };
  }

  private async drenarPedidos(): Promise<void> {
    while (!this.sincronizando) {
      const proximo = this.aguardando.values().next();
      if (proximo.done) return;
      // Fica na lista até terminar: a conta segue "em andamento" sem intervalo.
      try {
        await this.executar({ workspace: proximo.value });
      } catch (erro) {
        // Outra varredura tomou a vez: o pedido continua na fila para a próxima.
        if (erro instanceof SincronizacaoEmAndamentoError) return;
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

    let verificados = 0;
    let comNovidade = 0;
    let novidades = 0;
    let falhas = 0;

    try {
      const fila = await this.repo.listarParaSincronizar(this.maximo, opcoes.workspace);
      this.log.info('varredura iniciada', { total: fila.length });
      const inicioDaRodada = this.relogio();
      for (const item of fila) {
        let set = this.pendentes.get(item.workspace);
        if (!set) {
          set = new Set<string>();
          this.pendentes.set(item.workspace, set);
          // Quem já esperava na fila mantém a hora do pedido.
          if (!this.desde.has(item.workspace)) this.desde.set(item.workspace, inicioDaRodada);
        }
        set.add(item.numero);
      }

      for (const item of fila) {
        try {
          const atual = await this.provider.buscarPorNumero(item.numero);
          const novas = detectarNovidades(item.processo, atual);

          await this.repo.registrarSincronizacao(
            item.workspace,
            item.numero,
            atual,
            novas,
          );

          verificados++;
          if (novas.length > 0) {
            comNovidade++;
            novidades += novas.length;
            this.log.info('novidade detectada', {
              numero: item.numero,
              quantas: novas.length,
            });
          }
        } catch (erro) {
          falhas++;
          // "Não encontrado" também é falha do ponto de vista da varredura, mas
          // não é ruído de sistema: o processo pode ter sido arquivado ou o
          // tribunal saído da cobertura. Registramos e seguimos.
          const nivel = erro instanceof ProcessoNaoEncontradoError ? 'debug' : 'warn';
          this.log[nivel]('falha ao sincronizar processo', {
            numero: item.numero,
            erro: descrever(erro),
          });
          await this.repo.registrarFalha(item.workspace, item.numero, descrever(erro));
        } finally {
          this.concluirItem(item.workspace, item.numero);
        }

        if (this.pausaMs > 0) await dormir(this.pausaMs);
      }
    } finally {
      this.sincronizando = false;
      // Falha no meio da fila não pode deixar conta "verificando" para sempre.
      this.pendentes.clear();
      for (const ws of [...this.desde.keys()]) {
        if (!this.aguardando.has(ws)) this.desde.delete(ws);
      }
    }

    const resultado = {
      verificados,
      comNovidade,
      novidades,
      falhas,
      duracaoMs: Date.now() - inicio,
    };
    this.log.info('varredura concluída', resultado);
    return resultado;
  }

  /** Há varredura rodando (de qualquer conta). Uso interno e do guarda de reentrância — a API pública usa `estadoDa`. */
  get emAndamento(): boolean {
    return this.sincronizando;
  }

  private concluirItem(workspace: string, numero: string): void {
    const set = this.pendentes.get(workspace);
    if (!set) return;
    set.delete(numero);
    if (set.size === 0) {
      this.pendentes.delete(workspace);
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
