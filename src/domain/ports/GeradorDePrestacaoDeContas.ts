/**
 * Gera o PDF da prestação de contas (v0.47.0). A porta recebe TEXTO PRONTO — datas em dd/mm/aaaa e
 * valores em "R$ 1.234,56", já formatados por quem sabe do domínio —, então o gerador só desenha:
 * não soma, não formata dinheiro, não decide o que entra.
 *
 * O documento não tem lugar para parte, texto de ato nem dado do processo além de número, tribunal
 * e rótulo de cliente: o que não está neste tipo não chega ao arquivo que o advogado envia para fora.
 */
export interface LinhaDaPrestacao {
  readonly data: string;
  readonly descricao: string;
  readonly categoria: string;
  readonly valor: string;
  /** "A cobrar", "Ressarcido em dd/mm/aaaa" ou "Não cobrado". */
  readonly situacao: string;
}

export interface SubtotalDaPrestacao {
  readonly categoria: string;
  readonly quantidade: number;
  readonly valor: string;
}

export interface DocumentoDePrestacao {
  /** Formatado: NNNNNNN-DD.AAAA.J.TR.OOOO. */
  readonly numeroProcesso: string;
  readonly tribunal: string;
  readonly cliente?: string;
  readonly advogado?: { readonly nome: string; readonly oab?: string };
  /** "dd/mm/aaaa HH:MM", horário de São Paulo. */
  readonly geradoEm: string;
  /** Frases do que foi filtrado ("Período: de … até …"). Vazio = tudo. */
  readonly filtros: readonly string[];
  readonly versao: string;
  readonly linhas: readonly LinhaDaPrestacao[];
  readonly subtotais: readonly SubtotalDaPrestacao[];
  readonly totais: {
    readonly gasto: string;
    readonly reembolsavel: string;
    readonly ressarcido: string;
    readonly saldoACobrar: string;
  };
}

export interface GeradorDePrestacaoDeContas {
  /** Os bytes do PDF, em memória. Nunca grava em disco. */
  gerar(documento: DocumentoDePrestacao): Promise<Uint8Array>;
}
