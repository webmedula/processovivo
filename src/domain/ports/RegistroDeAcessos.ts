/**
 * Registros de acesso à aplicação (art. 15 do Marco Civil da Internet, v0.63.0).
 *
 * O provedor de aplicação guarda, por 6 meses, a data e a hora de uso a partir de um endereço IP. É SÓ
 * isso que entra: instante, IP, porta de origem (quando o servidor a enxerga) e a conta. Nada de rota,
 * corpo, cabeçalho, número de processo ou texto — a guarda é obrigação legal, não telemetria.
 */
export interface Acesso {
  readonly instante: Date;
  readonly ip: string;
  /**
   * Porta de origem do cliente. Atrás do proxy do Easypanel o servidor só vê a porta do proxy, que não
   * identifica ninguém: aí ela é OMITIDA, nunca gravada errada.
   */
  readonly porta?: number;
  /** Conta (workspace) autenticada, quando houver. */
  readonly workspace?: string;
}

export interface FiltroDeAcessos {
  readonly desde: Date;
  readonly ate: Date;
  readonly ip?: string;
  readonly workspace?: string;
}

export interface RegistroDeAcessos {
  /** Nunca lança: falha de gravação não pode derrubar a resposta de quem usou o sistema. */
  registrar(acesso: Acesso): void;
  /** Para atender requisição judicial (art. 15, § 3º): só leitura, mais recentes primeiro. */
  listar(filtro: FiltroDeAcessos, limite?: number): Promise<Acesso[]>;
  /** Apaga os registros anteriores a `limite`; devolve quantos saíram. */
  apagarAnterioresA(limite: Date): Promise<number>;
}

/**
 * Prazo de guarda: 6 meses (art. 15). Em DIAS para a conta não depender de calendário: 184 é o maior
 * intervalo que seis meses seguidos podem ter (julho a dezembro), então nunca se apaga antes do prazo.
 */
export const GUARDA_DOS_REGISTROS_DE_ACESSO_DIAS = 184;
