import type { Logger } from '../../domain/ports/Logger.js';

export interface OpcoesAgendador {
  readonly intervaloHoras: number;
  /** Espera antes da primeira execução. Padrão: 2 min. */
  readonly atrasoInicialMs?: number;
  readonly logger: Logger;
  readonly tarefa: () => Promise<unknown>;
  /**
   * Quando a tarefa rodou (com sucesso) pela última vez, lido de algo que
   * SOBREVIVE ao reinício — arquivo, banco (v0.67.3). Com isso, a primeira
   * execução depois da subida espera completar o intervalo desde aquela, em vez
   * de rodar 2 min depois de todo deploy. `undefined` (ou sem a opção) mantém o
   * comportamento de sempre: primeira execução depois do atraso inicial.
   *
   * Nunca lança para fora: leitura que falha vale como "sem registro".
   */
  readonly ultimaExecucaoEm?: () => Date | undefined;
  /** A frase do log quando a subida NÃO executa por causa de `ultimaExecucaoEm`. */
  readonly avisoAoAdiar?: string;
  /** Relógio injetável. */
  readonly agora?: () => Date;
}

/**
 * Agendador simples, em processo.
 *
 * `setInterval` e não cron externo porque há UMA instância: subir um worker
 * separado para disparar uma função a cada N horas seria mais infraestrutura
 * para manter do que o problema pede. Quando houver várias instâncias, isso
 * precisa virar um agendador com trava distribuída — senão todas varrem juntas.
 *
 * Três decisões que evitam dor:
 *
 * - **Atraso inicial.** Não varrer no instante do arranque. Em redeploy, o
 *   contêiner novo sobe enquanto o antigo ainda drena; começar a martelar o CNJ
 *   nesse momento é o pior instante possível.
 * - **Reinício não é motivo para rodar de novo** (v0.67.3). Com
 *   `ultimaExecucaoEm`, a primeira execução espera o intervalo desde a última
 *   registrada: quatro deploys no mesmo dia eram quatro varreduras completas
 *   (estourando a cota do DataJud) e quatro backups.
 * - **`unref()`** no timer, para o processo não ficar vivo só por causa dele
 *   durante o desligamento gracioso.
 */
export class Agendador {
  private timer: NodeJS.Timeout | undefined;
  private inicial: NodeJS.Timeout | undefined;
  private readonly log: Logger;

  constructor(private readonly opcoes: OpcoesAgendador) {
    this.log = opcoes.logger.child({ componente: 'agendador' });
  }

  iniciar(): void {
    const intervaloMs = this.opcoes.intervaloHoras * 3_600_000;
    if (intervaloMs <= 0) {
      this.log.info('agendamento desligado por configuração');
      return;
    }

    const atrasoPadrao = this.opcoes.atrasoInicialMs ?? 120_000;
    let atraso = atrasoPadrao;
    const ultima = this.ultimaExecucao();
    if (ultima) {
      const agora = (this.opcoes.agora ?? (() => new Date()))().getTime();
      // Marca no futuro (relógio do servidor acertado para trás) não pode adiar
      // além de um intervalo: no pior caso, espera o que esperaria um ciclo.
      const falta = Math.min(intervaloMs, ultima.getTime() + intervaloMs - agora);
      if (falta > atrasoPadrao) {
        atraso = falta;
        this.log.info(this.opcoes.avisoAoAdiar ?? 'execução adiada na subida', {
          idadeHoras: Math.round(((agora - ultima.getTime()) / 3_600_000) * 10) / 10,
          proximaEmSegundos: Math.round(falta / 1000),
        });
      }
    }

    this.inicial = setTimeout(() => {
      void this.executar();
      this.timer = setInterval(() => void this.executar(), intervaloMs);
      this.timer.unref();
    }, atraso);
    this.inicial.unref();

    this.log.info('agendamento ativo', {
      intervaloHoras: this.opcoes.intervaloHoras,
      primeiraEmSegundos: Math.round(atraso / 1000),
    });
  }

  parar(): void {
    if (this.inicial) clearTimeout(this.inicial);
    if (this.timer) clearInterval(this.timer);
    this.inicial = undefined;
    this.timer = undefined;
  }

  private ultimaExecucao(): Date | undefined {
    try {
      const quando = this.opcoes.ultimaExecucaoEm?.();
      return quando && !Number.isNaN(quando.getTime()) ? quando : undefined;
    } catch {
      return undefined;
    }
  }

  private async executar(): Promise<void> {
    try {
      await this.opcoes.tarefa();
    } catch (erro) {
      // Uma varredura que falha não pode derrubar o agendamento — senão a
      // primeira instabilidade do tribunal para as atualizações para sempre.
      this.log.error('tarefa agendada falhou', {
        erro: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }
}
