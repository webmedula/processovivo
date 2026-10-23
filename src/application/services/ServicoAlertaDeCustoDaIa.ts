import { diaDeSaoPaulo } from '../../domain/entities/ControleDaIa.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { Notificador } from '../../domain/ports/Notificador.js';
import type { RepositorioDoAlertaDeCusto } from '../../domain/ports/PainelDeIa.js';
import type { ServicoPainelDeIa } from './ServicoPainelDeIa.js';

export const MAXIMO_DE_TENTATIVAS_POR_DIA = 3;

export type DesfechoDoAlerta =
  | 'sem_excesso'
  | 'ja_enviado'
  | 'sem_destino'
  | 'limite_de_tentativas'
  | 'enviado'
  | 'falhou';

export interface OpcoesDoAlertaDeCusto {
  readonly painel: ServicoPainelDeIa;
  readonly repositorio: RepositorioDoAlertaDeCusto;
  readonly notificador: Notificador;
  /** E-mail do operador. Vazio = só o banner. NUNCA vai ao log. */
  readonly destinatario: string;
  /** `PROCESSOVIVO_URL_BASE`; vazio = o e-mail sai sem o link. */
  readonly urlBase: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

const usd = (v: number): string => `US$ ${v.toFixed(2).replace('.', ',')}`;
const dataBr = (dia: string): string =>
  `${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;

/**
 * Alerta de custo diário da IA (v0.58.0). Uma vez por dia de São Paulo, no máximo: se o custo do dia
 * passa do limite do painel, avisa o operador por e-mail (e o /admin mostra o banner, que independe
 * deste envio). O e-mail diz só a data, o valor do dia, o limite e o link da tela "IA" — nenhum nome,
 * conta, número de processo ou texto.
 *
 * Falha de envio NUNCA derruba o agendador: soma uma tentativa (máximo 3 por dia), vai ao log SEM dado
 * pessoal e a próxima tentativa é só no próximo ciclo. Sem e-mail do operador ou sem SMTP de verdade
 * ("log não é entrega") não há envio nem tentativa gasta; o banner continua.
 */
export class ServicoAlertaDeCustoDaIa {
  private readonly log: Logger;

  constructor(private readonly o: OpcoesDoAlertaDeCusto) {
    this.log = o.logger.child({ servico: 'alerta-de-custo-da-ia' });
  }

  async executar(): Promise<DesfechoDoAlerta> {
    const dia = diaDeSaoPaulo(this.o.clock.agora());
    const { usd: custo, alertaUsd, acima } = this.o.painel.custoDoDia();
    if (!acima) return 'sem_excesso';
    const gravado = this.o.repositorio.buscar(dia);
    if (gravado?.enviadoEm) return 'ja_enviado';
    if ((gravado?.tentativas ?? 0) >= MAXIMO_DE_TENTATIVAS_POR_DIA) {
      return 'limite_de_tentativas';
    }
    if (!this.o.destinatario || !this.o.notificador.habilitado) return 'sem_destino';

    const tentativa = this.o.repositorio.registrarTentativa(dia, custo, alertaUsd);
    const link = this.o.urlBase
      ? `\nPainel de IA: ${this.o.urlBase.replace(/\/+$/, '')}/admin#ia\n`
      : '';
    let enviado = false;
    try {
      enviado = await this.o.notificador.enviar({
        para: this.o.destinatario,
        assunto: 'Processo Vivo: o custo da IA passou do limite de hoje',
        texto:
          `Data: ${dataBr(dia)}\n` +
          `Custo da IA no dia: ${usd(custo)}\n` +
          `Limite do alerta: ${usd(alertaUsd)}\n${link}`,
      });
    } catch {
      enviado = false;
    }
    if (enviado) {
      this.o.repositorio.marcarEnviado(dia, this.o.clock.agora());
      this.log.info('alerta de custo da IA enviado', { dia });
      return 'enviado';
    }
    this.log.warn('alerta de custo da IA não enviado', {
      dia,
      tentativa,
      maximo: MAXIMO_DE_TENTATIVAS_POR_DIA,
    });
    return 'falhou';
  }
}
