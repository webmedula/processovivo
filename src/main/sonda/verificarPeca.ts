import type { RespostaDePeca } from './esquemaDePeca.js';
import {
  verificarAnaliseDePeca,
  type ResultadoDaVerificacaoDePeca,
} from '../../application/politicas/verificarAnaliseDePeca.js';

/**
 * Verificação da leitura de uma peça no COMPARADOR (Fase 0). Desde a v0.55.0 não há mais uma
 * segunda implementação: as regras (e a lista de expressões proibidas) são as de PRODUÇÃO
 * (`application/politicas/verificarAnaliseDePeca.ts`), para que o comparador meça o que vai ao ar.
 */
export {
  EXPRESSOES_PROIBIDAS_DE_PECA,
  expressaoProibidaDePecaEm,
  trechoNaPagina,
  type ContagemDeCitacoesDePeca,
  type DescartesDaPeca,
  type PecaNaoVerificada,
  type PecaVerificada,
  type ResultadoDaVerificacaoDePeca,
} from '../../application/politicas/verificarAnaliseDePeca.js';

export function verificarPeca(
  resposta: RespostaDePeca,
  textoEnviado: string,
): ResultadoDaVerificacaoDePeca {
  return verificarAnaliseDePeca(resposta, textoEnviado);
}
