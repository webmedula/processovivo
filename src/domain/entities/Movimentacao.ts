import type { ParaOUsuario } from './destinatarioDaComunicacao.js';

/**
 * Um andamento do processo.
 *
 * `titulo` é sempre preenchido (é o que a lista de andamentos exibe).
 * `conteudo` é o inteiro teor do despacho/decisão quando a fonte o expõe — o
 * DataJud não expõe, o crawler do e-SAJ expõe. Por isso é opcional: o modelo
 * unificado assume que fontes diferentes enriquecem o mesmo processo em graus
 * diferentes, e quem consome deve tratar a ausência, nunca presumir string vazia.
 */
export interface Movimentacao {
  /** Data/hora do andamento. */
  readonly data: Date;
  /** Descrição curta — ex.: "Juntada de Petição de Contestação". */
  readonly titulo: string;
  /** Inteiro teor do despacho/decisão, quando disponível. */
  readonly conteudo?: string;
  /** Código do movimento na Tabela Processual Unificada (TPU) do CNJ, quando houver. */
  readonly codigoTpu?: number;
  /** Complementos do movimento na TPU — ex.: ["tipo_de_documento: petição"]. */
  readonly complementos?: readonly string[];
  /**
   * Identificador do andamento NA FONTE, quando ela expõe um.
   *
   * Existe por causa da detecção de novidades. Sem ele, dois andamentos são
   * "o mesmo" quando coincidem data e título — o que basta para o DataJud, que
   * dá hora cheia, mas quebra no DJEN, que dá só a data: duas decisões
   * publicadas no mesmo dia no mesmo processo viravam uma só, e a segunda
   * nunca era avisada ao advogado.
   *
   * Prefixado pela fonte (`djen:717509066`) para que identificadores de fontes
   * diferentes não colidam.
   */
  readonly idExterno?: string;
  /** Link para o documento na origem, quando a fonte expõe. */
  readonly url?: string;
  /**
   * Qual fonte trouxe este andamento. Preenchido na FUSÃO de fontes.
   *
   * Numa linha do tempo montada de duas bases, "de onde veio esta linha" deixa
   * de ser curiosidade e vira informação de prazo: o DataJud dá hora cheia e o
   * DJEN dá só o dia, então dois andamentos vizinhos podem ter precisões
   * diferentes — e o advogado precisa saber qual está olhando.
   */
  readonly fonte?: string;
  /**
   * A fonte reconhece o ato mas NÃO entrega o texto dele.
   *
   * Distingue três estados que sem isso virariam dois: o ato tem teor e está
   * aqui (`conteudo` preenchido); a fonte não expõe teor nenhum (`conteudo`
   * ausente); e a fonte disse explicitamente que este documento não é público
   * (`teorIndisponivel`). O terceiro caso merece um aviso e um link para o
   * tribunal, não um espaço em branco que parece defeito nosso.
   */
  readonly teorIndisponivel?: boolean;
  /**
   * Tipo da comunicação como o DJEN o entrega ("Intimação", "Citação"…), só nas
   * movimentações que vieram do DJEN. É metadado, não texto do ato: guardado
   * para a triagem reconhecer o que foi ENDEREÇADO a alguém (ver
   * `tipoDaComunicacao.ts`). A data da movimentação já é a de disponibilização
   * e o identificador da comunicação já mora em `idExterno` (`djen:<id>`).
   */
  readonly tipoComunicacao?: string;
  /**
   * Inscrições (`47383/GO`) dos advogados a quem a comunicação do DJEN foi
   * dirigida. TRANSITÓRIO (v0.37.6): vive só em memória até o acompanhamento ser
   * gravado, quando `comIndicadorDeDestinatario` o troca por `paraOUsuario`. Não
   * persiste e não sai na API. Ver `destinatarioDaComunicacao.ts`.
   */
  readonly destinatariosOab?: readonly string[];
  /**
   * A comunicação é dirigida ao workspace? `nao` tira a INTIMAÇÃO/CITAÇÃO da
   * regra de "pede providência por 30 dias" (volta à regra comum do ato).
   * Ausente = `desconhecido`: o comportamento anterior à v0.37.6.
   */
  readonly paraOUsuario?: ParaOUsuario;
  /** Se o ato abre prazo ou pede providência. Ver `triagem.ts`. */
  readonly exigeAcao?: boolean;
}

/** Ordena do andamento mais recente para o mais antigo. */
export function ordenarPorDataDesc(
  movimentacoes: readonly Movimentacao[],
): Movimentacao[] {
  return [...movimentacoes].sort((a, b) => b.data.getTime() - a.data.getTime());
}
