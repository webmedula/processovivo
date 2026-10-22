import { dataLocalEm } from '../../domain/entities/EventoDeCalendario.js';
import {
  AssinaturaInativaError,
  PlanoDesconhecidoError,
  RecursoNaoIncluidoNoPlanoError,
} from '../../domain/errors/index.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { Notificador } from '../../domain/ports/Notificador.js';
import type {
  ItemDoResumo,
  RepositorioDoResumoDoCalendario,
} from '../../domain/ports/RepositorioDoResumoDoCalendario.js';
import type { RepositorioUsuarios } from '../../domain/ports/RepositorioUsuarios.js';
import { montarResumoDoCalendario } from '../politicas/mensagemDoResumoDoCalendario.js';
import type { ServicoAssinaturas } from './ServicoAssinaturas.js';

/** O resumo sai a partir das 08:00 de São Paulo… */
export const HORA_DO_RESUMO = 8;
/** …e só até 12:00: servidor que ficou fora do ar de manhã não manda "bom dia" às 22h. */
export const HORA_LIMITE_DO_RESUMO = 12;
/** Por item: depois de 3 falhas ele não é mais tentado (nunca inunda a caixa nem o SMTP). */
export const MAXIMO_DE_TENTATIVAS_POR_ITEM = 3;

export interface OpcoesServicoResumoDoCalendario {
  readonly repositorio: RepositorioDoResumoDoCalendario;
  readonly usuarios: RepositorioUsuarios;
  /** Tem de ENTREGAR de verdade: o composition root só monta o serviço com SMTP real. */
  readonly notificador: Notificador;
  readonly logger: Logger;
  readonly urlBase: string;
  /** `PROCESSOVIVO_CALENDARIO_RESUMO_HABILITADO`. Desligado: nenhum envio e a tela não mostra a opção. */
  readonly habilitado: boolean;
  readonly assinaturas?: ServicoAssinaturas;
  readonly agora?: () => Date;
}

export interface ResultadoDoResumo {
  readonly contas: number;
  readonly itens: number;
  readonly enviados: number;
  readonly falhas: number;
}

/**
 * Resumo por e-mail dos eventos do calendário que esperam confirmação (v0.51.0).
 *
 * Um e-mail por conta, no máximo um por dia (de São Paulo), entre 08:00 e 12:00, só se houver item
 * NOVO. O envio de uma conta nunca derruba o das outras nem o agendador, e o log leva só contagens:
 * nem e-mail, nem número de processo, nem texto.
 */
export class ServicoResumoDoCalendario {
  private readonly agora: () => Date;
  private readonly log: Logger;
  private emAndamento = false;

  constructor(private readonly o: OpcoesServicoResumoDoCalendario) {
    this.agora = o.agora ?? ((): Date => new Date());
    this.log = o.logger.child({ servico: 'resumo-do-calendario' });
  }

  get habilitado(): boolean {
    return this.o.habilitado;
  }

  async preferencia(workspace: string): Promise<boolean> {
    return this.o.repositorio.preferencia(workspace);
  }

  async definirPreferencia(workspace: string, ativo: boolean): Promise<void> {
    await this.o.repositorio.definirPreferencia(workspace, ativo, this.agora());
  }

  /** A tarefa do agendador (tick de ~15 min). */
  async executar(): Promise<ResultadoDoResumo> {
    const vazio: ResultadoDoResumo = { contas: 0, itens: 0, enviados: 0, falhas: 0 };
    if (!this.o.habilitado || this.emAndamento) return vazio;
    const agora = this.agora();
    if (!dentroDaJanela(agora)) return vazio;

    this.emAndamento = true;
    try {
      const diaLocal = dataLocalEm(agora);
      const contas = await this.contasElegiveis(agora);
      let enviados = 0;
      let falhas = 0;
      let itens = 0;
      for (const c of contas) {
        itens += c.itens.length;
        try {
          const mensagem = montarResumoDoCalendario(c.itens, { urlBase: this.o.urlBase });
          const ok = await this.o.notificador.enviar({ para: c.email, ...mensagem });
          if (ok) {
            await this.o.repositorio.registrarEnvio(
              c.workspace,
              c.itens,
              diaLocal,
              this.agora(),
            );
            enviados++;
          } else {
            await this.o.repositorio.registrarFalha(c.itens, this.agora());
            falhas++;
          }
        } catch {
          // Uma conta com problema não impede as seguintes. Sem a mensagem do erro: ela pode ecoar o endereço.
          falhas++;
          await this.o.repositorio
            .registrarFalha(c.itens, this.agora())
            .catch(() => undefined);
        }
      }
      if (contas.length > 0) {
        this.log.info('resumo do calendário processado', {
          contas: contas.length,
          itens,
          enviados,
          falhas,
        });
      }
      return { contas: contas.length, itens, enviados, falhas };
    } finally {
      this.emAndamento = false;
    }
  }

  /**
   * Quantas contas receberiam o resumo AGORA e quantos itens, sem enviar e sem expor e-mail ou conteúdo.
   * Ignora a janela de 08:00 (é a pergunta "e se fosse agora?"); respeita todo o resto.
   */
  async previa(): Promise<ResultadoDoResumo> {
    const contas = await this.contasElegiveis(this.agora());
    return {
      contas: contas.length,
      itens: contas.reduce((n, c) => n + c.itens.length, 0),
      enviados: 0,
      falhas: 0,
    };
  }

  private async contasElegiveis(
    agora: Date,
  ): Promise<Array<{ workspace: string; email: string; itens: ItemDoResumo[] }>> {
    const diaLocal = dataLocalEm(agora);
    const pendentes = await this.o.repositorio.itensPendentes(
      diaLocal,
      MAXIMO_DE_TENTATIVAS_POR_ITEM,
    );
    const porConta = new Map<string, ItemDoResumo[]>();
    for (const i of pendentes) {
      const lista = porConta.get(i.workspace);
      if (lista) lista.push(i);
      else porConta.set(i.workspace, [i]);
    }

    const contas: Array<{ workspace: string; email: string; itens: ItemDoResumo[] }> = [];
    for (const [workspace, itens] of porConta) {
      try {
        if (!(await this.o.repositorio.preferencia(workspace))) continue;
        if (await this.o.repositorio.enviadoNoDia(workspace, diaLocal)) continue;
        if (!(await this.temOCalendario(workspace))) continue;
        // Conta de chave de API não tem pessoa nem e-mail: não recebe resumo.
        const usuario = await this.o.usuarios.porWorkspace(workspace);
        if (!usuario) continue;
        contas.push({ workspace, email: usuario.email, itens });
      } catch {
        // Uma conta que não deu para conferir fica para o próximo ciclo; as outras seguem.
        this.log.warn('conta do resumo do calendário não pôde ser conferida');
      }
    }
    return contas;
  }

  private async temOCalendario(workspace: string): Promise<boolean> {
    if (!this.o.assinaturas) return true;
    try {
      await this.o.assinaturas.exigir(workspace, 'calendario');
      return true;
    } catch (erro) {
      if (
        erro instanceof AssinaturaInativaError ||
        erro instanceof RecursoNaoIncluidoNoPlanoError ||
        erro instanceof PlanoDesconhecidoError
      ) {
        return false;
      }
      throw erro;
    }
  }
}

/** De 08:00 (inclusive) a 12:00 (exclusive) em São Paulo, fuso fixo de -03:00. */
export function dentroDaJanela(agora: Date): boolean {
  const horaLocal = new Date(agora.getTime() - 3 * 3_600_000).getUTCHours();
  return horaLocal >= HORA_DO_RESUMO && horaLocal < HORA_LIMITE_DO_RESUMO;
}
