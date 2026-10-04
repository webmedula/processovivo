import { detectarNovidades } from '../../domain/entities/Acompanhamento.js';
import { fundirProcessos } from '../../domain/entities/fusaoProcessos.js';
import type { Processo } from '../../domain/entities/Processo.js';
import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import {
  comoDataDjen,
  desdeQuandoVarrer,
} from '../../domain/entities/VigilanciaOab.js';
import type { VigilanciaOab } from '../../domain/entities/VigilanciaOab.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import type { RepositorioVigilancias } from '../../domain/ports/RepositorioVigilancias.js';

/**
 * Fonte capaz de buscar por OAB restrita a um período.
 *
 * Deliberadamente MAIS ESTREITA que `ProcessoProvider`: esta varredura não quer
 * a cadeia inteira, quer a fonte rápida. Passar o orquestrador aqui faria cada
 * ciclo de hora em hora arrastar o DataJud junto — 20 segundos por consulta,
 * cota nacional compartilhada, para buscar num índice que nem indexa advogado.
 */
export interface BuscaPorOabComPeriodo {
  buscarPorOabNoPeriodo(
    oab: string,
    uf: string,
    periodo: { de?: string; ate?: string },
  ): Promise<Processo[]>;
}

export interface OpcoesServicoVigilancia {
  readonly vigilancias: RepositorioVigilancias;
  readonly acompanhamentos: RepositorioAcompanhamentos;
  readonly busca: BuscaPorOabComPeriodo;
  readonly logger: Logger;
  /** Inscrições por ciclo. */
  readonly maximoPorVarredura?: number;
  /** Pausa entre inscrições, para não martelar a API pública do CNJ. */
  readonly pausaMs?: number;
  readonly agora?: () => Date;
}

export interface ResultadoVarredura {
  readonly vigilanciasVarridas: number;
  readonly processosNovos: number;
  readonly novidades: number;
  readonly falhas: number;
  /** Verdadeiro quando outra varredura já estava em curso e esta não rodou. */
  readonly jaEmAndamento?: boolean;
}

/**
 * Varre as inscrições vigiadas e traz para a carteira o que apareceu no diário.
 *
 * O que este serviço faz de fato, em uma frase: pergunta ao DJEN "o que foi
 * publicado no nome deste advogado desde a última vez", e o que voltar vira
 * processo acompanhado — sem ninguém digitar número.
 *
 * Duas situações, dois tratamentos:
 *
 *   processo NOVO      entra na carteira já preenchido com o que o DJEN trouxe.
 *                      NÃO gera novidade: acabou de entrar, tudo nele é novo, e
 *                      avisar tudo seria avisar nada.
 *   processo JÁ SEGUIDO o retrato guardado é FUNDIDO com o que o DJEN trouxe, e
 *                      só as publicações inéditas viram novidade. A fusão é o
 *                      que impede a linha do tempo de encolher — o DJEN sozinho
 *                      não tem os andamentos internos que o DataJud trouxe.
 */
export class ServicoVigilanciaOab {
  private readonly vigilancias: RepositorioVigilancias;
  private readonly acompanhamentos: RepositorioAcompanhamentos;
  private readonly busca: BuscaPorOabComPeriodo;
  private readonly log: Logger;
  private readonly maximo: number;
  private readonly pausaMs: number;
  private readonly agora: () => Date;
  private varrendo = false;

  constructor(opcoes: OpcoesServicoVigilancia) {
    this.vigilancias = opcoes.vigilancias;
    this.acompanhamentos = opcoes.acompanhamentos;
    this.busca = opcoes.busca;
    this.log = opcoes.logger.child({ servico: 'vigilancia-oab' });
    this.maximo = opcoes.maximoPorVarredura ?? 50;
    this.pausaMs = opcoes.pausaMs ?? 1_000;
    this.agora = opcoes.agora ?? ((): Date => new Date());
  }

  async vigiar(
    workspace: string,
    oab: string,
    uf: string,
    apelido?: string,
  ): Promise<VigilanciaOab> {
    const v = await this.vigilancias.vigiar(workspace, oab, uf, apelido);
    this.log.info('OAB sob vigilância', {
      workspace,
      oab: v.oab.numero,
      uf: v.oab.uf,
    });
    return v;
  }

  async parar(workspace: string, oab: string, uf: string): Promise<boolean> {
    return this.vigilancias.parar(workspace, oab, uf);
  }

  async listar(workspace: string): Promise<VigilanciaOab[]> {
    return this.vigilancias.listar(workspace);
  }

  emAndamento(): boolean {
    return this.varrendo;
  }

  /**
   * Um ciclo completo.
   *
   * Sequencial e com pausa, como a varredura de processos: a API do CNJ é
   * pública e compartilhada por todo o país, e paralelismo aqui é o tipo de
   * coisa que faz o CNJ bloquear o IP de todo mundo que usa a chave.
   */
  /**
   * @param opcoes `workspace` limita a um assinante — é o que a rota HTTP
   *   sempre passa. A varredura agendada chama sem ele.
   */
  async varrer(opcoes: { workspace?: string } = {}): Promise<ResultadoVarredura> {
    if (this.varrendo) {
      this.log.warn('varredura de OAB ignorada: outra em andamento');
      return {
        vigilanciasVarridas: 0,
        processosNovos: 0,
        novidades: 0,
        falhas: 0,
        jaEmAndamento: true,
      };
    }
    this.varrendo = true;

    let processosNovos = 0;
    let novidades = 0;
    let falhas = 0;
    let varridas = 0;

    try {
      const fila = await this.vigilancias.listarParaVarrer(this.maximo, opcoes.workspace);
      if (fila.length === 0) {
        return { vigilanciasVarridas: 0, processosNovos: 0, novidades: 0, falhas: 0 };
      }

      this.log.info('varredura de OAB iniciada', { inscricoes: fila.length });

      for (const [indice, vigilancia] of fila.entries()) {
        if (indice > 0) await this.pausar();
        try {
          const r = await this.varrerUma(vigilancia);
          processosNovos += r.novos;
          novidades += r.novidades;
          varridas++;
        } catch (erro) {
          falhas++;
          const motivo = erro instanceof Error ? erro.message : String(erro);
          await this.vigilancias.registrarFalha(
            vigilancia.workspace,
            vigilancia.oab.numero,
            vigilancia.oab.uf,
            motivo,
          );
          this.log.warn('falha ao varrer inscrição', {
            oab: vigilancia.oab.numero,
            uf: vigilancia.oab.uf,
            erro: motivo,
          });
        }
      }

      this.log.info('varredura de OAB concluída', {
        varridas,
        processosNovos,
        novidades,
        falhas,
      });
      return { vigilanciasVarridas: varridas, processosNovos, novidades, falhas };
    } finally {
      this.varrendo = false;
    }
  }

  private async varrerUma(
    vigilancia: VigilanciaOab,
  ): Promise<{ novos: number; novidades: number }> {
    const inicio = this.agora();
    const desde = desdeQuandoVarrer(vigilancia, inicio);

    const encontrados = await this.busca.buscarPorOabNoPeriodo(
      vigilancia.oab.numero,
      vigilancia.oab.uf,
      { de: comoDataDjen(desde) },
    );

    let novos = 0;
    let novidades = 0;

    for (const processo of encontrados) {
      const numero = processo.numero.digitos;
      const existente = await this.acompanhamentos.buscar(
        vigilancia.workspace,
        numero,
      );

      if (!existente) {
        await this.acompanhamentos.acompanhar(vigilancia.workspace, numero);
        await this.acompanhamentos.registrarSincronizacao(
          vigilancia.workspace,
          numero,
          processo,
          [],
        );
        novos++;
        continue;
      }

      const guardado = existente.processo;
      if (!guardado) {
        // Estava acompanhado mas nunca sincronizou (a primeira consulta falhou).
        // A varredura resolve de graça o que a fila de sincronização tentaria de
        // novo daqui a doze horas.
        await this.acompanhamentos.registrarSincronizacao(
          vigilancia.workspace,
          numero,
          processo,
          [],
        );
        continue;
      }

      const fundido = fundirProcessos(guardado, processo);
      const novas: Movimentacao[] = detectarNovidades(guardado, fundido);
      if (novas.length === 0) continue;

      await this.acompanhamentos.registrarSincronizacao(
        vigilancia.workspace,
        numero,
        fundido,
        novas,
      );
      novidades += novas.length;
    }

    await this.vigilancias.registrarVarredura(
      vigilancia.workspace,
      vigilancia.oab.numero,
      vigilancia.oab.uf,
      inicio,
      novos,
    );

    return { novos, novidades };
  }

  private pausar(): Promise<void> {
    if (this.pausaMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.pausaMs));
  }
}
