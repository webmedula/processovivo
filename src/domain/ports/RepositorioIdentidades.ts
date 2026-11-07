/**
 * A ligação entre uma conta e uma identidade de fora (v0.67.0: a conta Google).
 *
 * Guarda só (provedor, sujeito, conta, quando). O e-mail do provedor NÃO é guardado: a
 * conta já tem o dela, e uma segunda cópia seria mais um dado pessoal para manter em
 * sincronia e para vazar. Nenhum token do provedor passa por aqui.
 *
 * Uma identidade liga-se a UMA conta, e uma conta tem no máximo UMA identidade por
 * provedor: as duas unicidades são do banco, não de quem chama.
 */
export interface LigacaoDeIdentidade {
  readonly provedor: string;
  readonly usuarioId: string;
  readonly ligadaEm: Date;
}

export interface RepositorioIdentidades {
  /** A conta ligada a este sujeito, se houver. */
  usuarioDe(provedor: string, sujeito: string): Promise<string | undefined>;
  /** A ligação desta conta com o provedor, se houver. */
  ligacaoDe(
    provedor: string,
    usuarioId: string,
  ): Promise<LigacaoDeIdentidade | undefined>;
  /**
   * Liga. Idempotente para o MESMO par (sujeito, conta); sujeito já ligado a OUTRA conta,
   * ou conta já ligada a outro sujeito do mesmo provedor, é erro de unicidade do banco —
   * quem chama confere antes, e o banco é a trava de verdade contra a corrida.
   */
  ligar(provedor: string, sujeito: string, usuarioId: string): Promise<void>;
  /** Desliga. Devolve `false` se não havia ligação. */
  desligar(provedor: string, usuarioId: string): Promise<boolean>;
}
