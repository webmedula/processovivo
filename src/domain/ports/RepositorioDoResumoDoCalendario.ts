/**
 * Persistência do resumo por e-mail dos eventos a confirmar (v0.51.0).
 *
 * Nada aqui guarda e-mail, nome de parte, trecho de andamento ou texto de e-mail enviado: só ids,
 * datas e contagens. As consultas que atravessam workspaces (`itensPendentes`) são a exceção
 * nomeada, como `workspacesSemRetroativo`: a tarefa agendada é de todas as contas.
 */

export type MotivoDoItem = 'novo' | 'revisar';

/** Um evento que espera a pessoa. Só o que a mensagem precisa. */
export interface ItemDoResumo {
  readonly workspace: string;
  readonly eventoId: string;
  readonly motivo: MotivoDoItem;
  /** '' para `novo`; a data da revisão para `revisar` (andamento de mudança novo = item novo). */
  readonly chave: string;
  readonly tipo: string;
  /** `AAAA-MM-DD`. */
  readonly dataLocal: string;
  readonly horaLocal?: string;
  /** 20 dígitos. */
  readonly numeroProcesso: string;
  readonly segredoJustica: boolean;
  /** Data do andamento de onde a data foi lida. */
  readonly dataDoAndamento?: Date;
}

export interface RepositorioDoResumoDoCalendario {
  /** Sem linha = LIGADO (o padrão do dono). */
  preferencia(workspace: string): Promise<boolean>;
  definirPreferencia(workspace: string, ativo: boolean, agora: Date): Promise<void>;

  /**
   * Eventos DETECTADOS, não descartados, com data de hoje em diante, que são `sugerido` ou têm
   * `revisar`, ainda não avisados e com menos de `maximoDeTentativas` falhas. De TODOS os
   * workspaces, ordenados por workspace, data e hora.
   */
  itensPendentes(
    desdeDataLocal: string,
    maximoDeTentativas: number,
  ): Promise<ItemDoResumo[]>;

  /** A conta já recebeu resumo neste dia (de São Paulo)? */
  enviadoNoDia(workspace: string, diaLocal: string): Promise<boolean>;

  /** Marca os itens como avisados e registra o envio, numa transação. */
  registrarEnvio(
    workspace: string,
    itens: readonly ItemDoResumo[],
    diaLocal: string,
    agora: Date,
  ): Promise<void>;

  /** Soma uma tentativa falha a cada item. */
  registrarFalha(itens: readonly ItemDoResumo[], agora: Date): Promise<void>;
}
