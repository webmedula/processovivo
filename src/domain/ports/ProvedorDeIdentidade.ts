/**
 * Quem diz "esta pessoa é quem diz ser", de fora (v0.67.0: o Google).
 *
 * É uma porta, e não o adapter do Google em `application/`, pela regra de dependência — e
 * por um motivo de produto: o login social é uma PORTA DE ENTRADA a mais, nunca a conta.
 * A conta continua sendo a de `usuarios`, com o `workspace` de sempre; o provedor só
 * responde "o dono desta conta Google é o sujeito X, com este e-mail, verificado ou não".
 *
 * O que o sistema pede e guarda é o MÍNIMO: o identificador estável do sujeito (`sub`),
 * o e-mail e se o provedor o confirmou, e o nome, para preencher a conta nova. Nada de
 * foto, contatos, agenda, nem token de longa duração: o login não precisa de nada depois
 * de a sessão abrir, então nenhum token do provedor é guardado.
 */
export interface IdentidadeExterna {
  /** Identificador estável do sujeito no provedor. Nunca muda, mesmo que o e-mail mude. */
  readonly sujeito: string;
  readonly email: string;
  /**
   * O provedor confirmou que a pessoa controla o e-mail. Só com `true` a identidade pode
   * ser ligada a uma conta que já existe com aquele e-mail: sem a confirmação, uma conta
   * Google criada com o e-mail de outra pessoa entraria na conta dela.
   */
  readonly emailVerificado: boolean;
  readonly nome: string | undefined;
}

export interface ProvedorDeIdentidade {
  /** Nome estável do provedor, usado como chave da ligação (ex.: `google`). */
  readonly nome: string;

  /** A URL para onde o navegador vai pedir a autorização. Puro: nada sai daqui. */
  urlDeAutorizacao(entrada: {
    readonly estado: string;
    readonly desafio: string;
    readonly uriDeRetorno: string;
  }): string;

  /**
   * Troca o código que o provedor devolveu pela identidade. Uma chamada, sem repetição.
   * @throws {ProviderIndisponivelError} rede, timeout, 5xx.
   * @throws {RespostaInvalidaError} o provedor respondeu fora do contrato, ou recusou o código.
   */
  identidadePeloCodigo(entrada: {
    readonly codigo: string;
    readonly verificador: string;
    readonly uriDeRetorno: string;
  }): Promise<IdentidadeExterna>;
}
