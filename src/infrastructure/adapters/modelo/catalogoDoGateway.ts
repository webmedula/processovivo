import { createGateway } from 'ai';

export interface PrecoDoModelo {
  /** USD por token. */
  readonly entrada: number;
  readonly saida: number;
}

/**
 * Preço por token de cada modelo do catálogo do gateway. Só metadados públicos:
 * nenhum texto de ato viaja nesta chamada. A sonda usa para estimar custo quando
 * a resposta não traz o custo; a data da consulta sai junto da tabela.
 */
export async function precosDoCatalogo(
  chave: string,
): Promise<Map<string, PrecoDoModelo>> {
  const catalogo = await createGateway({ apiKey: chave }).getAvailableModels();
  const precos = new Map<string, PrecoDoModelo>();
  for (const m of catalogo.models) {
    const entrada = Number(m.pricing?.input);
    const saida = Number(m.pricing?.output);
    if (Number.isFinite(entrada) && Number.isFinite(saida))
      precos.set(m.id, { entrada, saida });
  }
  return precos;
}
