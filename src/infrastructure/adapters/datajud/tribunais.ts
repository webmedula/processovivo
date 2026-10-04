/**
 * A API Pública do DataJud não tem um índice único: cada tribunal é um alias
 * próprio (`api_publica_tjsp`, `api_publica_trf3`, ...). Ou seja, é preciso
 * saber a sigla do tribunal ANTES de montar a URL — e ela sai do próprio número
 * CNJ, pelos campos J.TR.
 *
 * Essa restrição é a razão de o adapter recusar números cujo segmento/tribunal
 * ele não reconhece, em vez de chutar um índice e receber 404.
 */

/**
 * Siglas cobertas: Justiça Estadual, Federal e do Trabalho.
 *
 * A Justiça do Trabalho entrou depois, e vale registrar por quê: não faltava
 * nada além DESTA lista e do mapa J.TR em `NumeroCNJ`. O DataJud usa a mesma
 * chave pública do CNJ para todos os tribunais, e o endereço de cada um é
 * montado mecanicamente a partir da sigla. Sem credencial nova, sem adapter
 * novo, sem acordo com ninguém — 31 linhas, e um segmento inteiro da advocacia
 * deixou de receber "tribunal não suportado".
 *
 * Fica como lembrete de que "o produto não atende X" às vezes é uma lista
 * desatualizada se passando por limitação de arquitetura.
 */
export const TRIBUNAIS_SUPORTADOS: readonly string[] = [
  'TJAC', 'TJAL', 'TJAP', 'TJAM', 'TJBA', 'TJCE', 'TJDFT', 'TJES', 'TJGO',
  'TJMA', 'TJMT', 'TJMS', 'TJMG', 'TJPA', 'TJPB', 'TJPR', 'TJPE', 'TJPI',
  'TJRJ', 'TJRN', 'TJRS', 'TJRO', 'TJRR', 'TJSC', 'TJSE', 'TJSP', 'TJTO',
  'TRF1', 'TRF2', 'TRF3', 'TRF4', 'TRF5', 'TRF6',
  'TRT1', 'TRT2', 'TRT3', 'TRT4', 'TRT5', 'TRT6', 'TRT7', 'TRT8',
  'TRT9', 'TRT10', 'TRT11', 'TRT12', 'TRT13', 'TRT14', 'TRT15', 'TRT16',
  'TRT17', 'TRT18', 'TRT19', 'TRT20', 'TRT21', 'TRT22', 'TRT23', 'TRT24',
  'TST',
];

const SUPORTADOS = new Set(TRIBUNAIS_SUPORTADOS);

export function ehTribunalSuportado(sigla: string): boolean {
  return SUPORTADOS.has(sigla.toUpperCase());
}

/** "TJSP" → "api_publica_tjsp" */
export function aliasDoTribunal(sigla: string): string {
  return `api_publica_${sigla.toLowerCase()}`;
}

/** "TJSP" → ".../api_publica_tjsp/_search" */
export function urlDeBusca(baseUrl: string, sigla: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/${aliasDoTribunal(sigla)}/_search`;
}
