/**
 * Extração de texto de um PDF, página por página (v0.53.0, Fase 0 da análise de peças).
 *
 * Porta INTERNA: sem rota, sem botão e sem uso em produção nesta versão — só o comando de
 * medição e os testes a chamam. Sem OCR: PDF escaneado volta sem texto e é CONTADO, não lido.
 *
 * O texto devolvido existe só em memória, na mão de quem chamou. Nada aqui o grava, e nenhum
 * erro ou log o repete.
 */

export interface ContagensDoTexto {
  /** Páginas efetivamente lidas (no máximo `maxPaginas`). */
  readonly paginasLidas: number;
  /** O PDF tem mais páginas do que o limite: só as primeiras foram lidas. */
  readonly truncadoPorPaginas: boolean;
  /** Caracteres das páginas lidas, com espaços e quebras colapsados — o que iria ao modelo. */
  readonly caracteres: number;
  /** Páginas com texto próprio (>= 50 caracteres que não são espaço). */
  readonly paginasComTexto: number;
  /** Pelo menos metade das páginas lidas tem texto: dá para ler sem OCR. */
  readonly temTextoPesquisavel: boolean;
  /** `caracteres` passa do limite por peça. */
  readonly excedeLimiteDeCaracteres: boolean;
  readonly duracaoMs: number;
}

export interface TextoExtraido {
  /** Uma entrada por página lida, na ordem do PDF (página 1 = índice 0). */
  readonly paginas: readonly string[];
  readonly contagens: ContagensDoTexto;
}

export interface OpcoesDeExtracao {
  /** Páginas lidas, no máximo. Padrão 40 (decisão do dono para a Fase 1). */
  readonly maxPaginas?: number;
  /** Limite de caracteres por peça (só sinaliza; não corta). Padrão 80 mil. */
  readonly maxCaracteres?: number;
}

export interface ExtratorDeTextoDePdf {
  /** @throws {ExtracaoDeTextoError} PDF vazio, grande demais, inválido, protegido, lento demais… */
  extrair(bytes: Uint8Array, opcoes?: OpcoesDeExtracao): Promise<TextoExtraido>;
}
