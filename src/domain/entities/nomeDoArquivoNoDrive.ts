/**
 * O nome do arquivo de uma peça no Drive do advogado (v0.42.0).
 *
 * Forma: `NNNN - Rótulo - dd-mm-aaaa.pdf`, por exemplo `0382 - Decisão - 14-10-2026.pdf`.
 *
 * - **NNNN** é o número que a Pasta digital mostra para o ato que juntou a peça
 *   (posição calculada, ou o número do Projudi quando a calibração do advogado o
 *   provou). Ausente quando a Pasta não mostra número — o nome não inventa um.
 *   Ele ordena os arquivos na pasta do Drive; **não é** "o número oficial".
 * - **Rótulo** é o do tribunal, como a Pasta o mostra.
 * - **Data** do ato, no fuso de São Paulo (o mesmo do calendário).
 * - Peça CONVERTIDA (HTML ou imagem do tribunal virou PDF) leva um marcador no
 *   nome — a Pasta diz que é conversão, e o arquivo que sai dela também diz.
 *
 * O nome é SANEADO para o Drive e para quem baixa o arquivo depois: sem `/`, sem
 * caractere de controle, sem os que o Windows proíbe, espaços colapsados, tamanho
 * limitado. Nome vazio depois da limpeza cai num nome a partir do id da peça.
 *
 * Pura e sem I/O: o teste exercita ESTA função.
 */

/** Tamanho máximo do nome inteiro, em caracteres. O Drive aceita bem mais; o disco do advogado, não. */
export const LIMITE_DO_NOME_DO_ARQUIVO = 150;

export type ConversaoParaONome = 'nenhuma' | 'imagem' | 'html';

export interface EntradaDoNomeNoDrive {
  /** Número do ato como a Pasta o mostra. Ausente = sem prefixo. */
  readonly numeroDoAto?: number | undefined;
  readonly rotulo: string;
  readonly data?: Date | undefined;
  readonly conversao?: ConversaoParaONome | undefined;
  readonly pecaId: string;
  /** Peças do mesmo processo com nome igual, na ordem dos autos: 1 = a primeira. */
  readonly ocorrencia?: number | undefined;
}

// Controle (C0, DEL e C1 — `\p{Cc}`) e os caracteres que o Windows proíbe em nome de arquivo.
const PROIBIDOS = /[\p{Cc}/\\:*?"<>|]+/gu;

export function sanearParteDoNome(texto: string): string {
  return texto
    .replace(PROIBIDOS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim();
}

function dataDoNome(data: Date): string | undefined {
  if (Number.isNaN(data.getTime())) return undefined;
  return data
    .toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
    .replace(/\//g, '-');
}

function marcador(conversao: ConversaoParaONome | undefined): string {
  if (conversao === 'html') return ' (conversão de HTML)';
  if (conversao === 'imagem') return ' (conversão de imagem)';
  return '';
}

export function nomeDoArquivoNoDrive(e: EntradaDoNomeNoDrive): string {
  const numero =
    e.numeroDoAto !== undefined && Number.isInteger(e.numeroDoAto) && e.numeroDoAto > 0
      ? String(e.numeroDoAto).padStart(4, '0')
      : undefined;
  const data = e.data ? dataDoNome(e.data) : undefined;
  const prefixo = numero ? `${numero} - ` : '';
  const sufixoData = data ? ` - ${data}` : '';
  const sufixoOcorrencia =
    e.ocorrencia !== undefined && e.ocorrencia > 1 ? ` (${e.ocorrencia})` : '';
  const sufixo = `${sufixoData}${marcador(e.conversao)}${sufixoOcorrencia}.pdf`;

  let rotulo = sanearParteDoNome(e.rotulo);
  if (rotulo === '')
    rotulo = `peça ${sanearParteDoNome(e.pecaId).slice(0, 12) || 'sem id'}`;

  // O rótulo é o que cede: prefixo e sufixo carregam a ordem, a data e a conversão.
  const folga = Math.max(10, LIMITE_DO_NOME_DO_ARQUIVO - prefixo.length - sufixo.length);
  if (rotulo.length > folga) rotulo = `${rotulo.slice(0, folga - 1).trimEnd()}…`;

  return `${prefixo}${rotulo}${sufixo}`;
}
