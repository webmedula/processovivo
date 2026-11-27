import type { Parte } from '../entities/Parte.js';

/**
 * As partes que o TRIBUNAL informou no cabeçalho dos autos (v0.71.0), por processo e por conta.
 *
 * Existe porque o retrato das fontes públicas só tem as partes do Diário, e o DJEN só conhece
 * quem foi intimado: num cumprimento de sentença com uma publicação, a carteira e as
 * Atualizações mostravam só o exequente. A lista do tribunal chega de graça na MESMA consulta
 * que traz as peças (nenhuma consulta nova), e é guardada aqui para as colunas "Partes" a
 * usarem sem ir ao tribunal.
 *
 * Por WORKSPACE, nunca no retrato compartilhado: a lista vem com a credencial de quem tem
 * procuração nos autos. Só nome, polo, tipo de pessoa e advogados (nome, OAB, UF) — nunca
 * CPF/CNPJ nem endereço, que o tribunal entrega sem máscara.
 */
export interface RepositorioPartesDoTribunal {
  /** Substitui a lista anterior do processo: a resposta mais nova do tribunal vale mais. */
  guardar(
    workspace: string,
    numeroProcesso: string,
    partes: readonly Parte[],
    em: Date,
  ): Promise<void>;
  /** Tira a lista do processo (o tribunal passou a declarar sigilo). */
  remover(workspace: string, numeroProcesso: string): Promise<void>;
  /** Todas as listas da conta, por número (20 dígitos). Uma leitura para a carteira inteira. */
  doWorkspace(workspace: string): Promise<ReadonlyMap<string, readonly Parte[]>>;
  /** Exclusão de conta. @returns quantas linhas saíram. */
  apagarDoWorkspace(workspace: string): Promise<number>;
}
