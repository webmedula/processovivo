import { semAcentoMantendoTamanho } from './normalizacaoDeTexto.js';
import {
  criarRedator,
  type PessoasParaRedigir,
  type ResultadoDaRedacao,
} from './redigirParaIA.js';

/**
 * Redação ACRESCENTADA para peças (v0.53.0, Fase 0). Roda DEPOIS da redação do ato
 * (`redigirParaIA`: CNJ, CPF/CNPJ, e-mail, telefone, OAB e nomes do retrato) e cobre o que uma
 * peça traz e um andamento quase nunca traz: CEP, RG/CNH com rótulo, data de nascimento e
 * conta/agência com rótulo.
 *
 * Fica em módulo PRÓPRIO de propósito: `redigirParaIA` é o da análise do ato em produção, e a
 * Fase 0 não muda produção. Função pura, sem I/O.
 *
 * O QUE ESTA REDAÇÃO NÃO GARANTE — e nenhum texto do produto pode prometer:
 * - **Endereço**: logradouro, bairro e cidade não têm padrão confiável (só o CEP é pego).
 * - **Nome de terceiro** que não está no retrato (testemunha, perito, filho, sócio).
 * - Documento sem rótulo ("12.345.678-9" solto), conta sem a palavra "conta" ou "agência",
 *   data de nascimento sem "nascido"/"nascimento" por perto, chave Pix, placa, cartão.
 * Na dúvida redige (falso positivo custa uma palavra); o que está acima continua passando.
 */

export type TipoDeRedacaoDePeca = 'CEP' | 'IDENTIDADE' | 'NASCIMENTO' | 'CONTA';

interface PadraoDePeca {
  readonly tipo: TipoDeRedacaoDePeca;
  readonly regex: RegExp;
}

const MESES =
  'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
const DATA = `(?:\\d{1,2}\\s*[/.-]\\s*\\d{1,2}\\s*[/.-]\\s*\\d{2,4}|\\d{1,2}\\s+de\\s+(?:${MESES})\\s+de\\s+\\d{4})`;
const NUMERO_DE_DOCUMENTO = '\\d[\\d.\\- ]{5,14}[\\dx]';
const NUMERO_DE_CONTA = '\\d[\\d.\\-/ ]{2,12}[\\dx]';

// Os padrões rodam sobre o texto SEM acento e em minúsculas (mesmo tamanho do original), então
// só se escrevem em minúsculas e sem acento.
const PADROES: readonly PadraoDePeca[] = [
  { tipo: 'CEP', regex: /(?<![\d.\-/])\d{2}\.?\d{3}-\d{3}(?!\d)/g },
  { tipo: 'CEP', regex: /\bcep\b[\s:.n°ºo-]{0,6}\d{8}(?!\d)/g },
  {
    tipo: 'IDENTIDADE',
    regex: new RegExp(
      `\\b(?:rg|r\\.g\\.|cnh|identidade|carteira de identidade|registro geral|carteira nacional de habilitacao)\\b[\\s:.,\\-n°ºo]{0,12}(?:numero\\s*)?${NUMERO_DE_DOCUMENTO}`,
      'g',
    ),
  },
  {
    tipo: 'NASCIMENTO',
    regex: new RegExp(
      `\\b(?:nascid[oa]|nascimento|nasc\\.)\\b[^\\d\\n]{0,25}${DATA}`,
      'g',
    ),
  },
  {
    tipo: 'CONTA',
    regex: new RegExp(
      `\\b(?:agencia|ag\\.|conta corrente|conta poupanca|conta|c/c|c\\.c\\.)[\\s:.,\\-n°ºo]{0,8}${NUMERO_DE_CONTA}`,
      'g',
    ),
  },
];

export interface ResultadoDaRedacaoDePeca {
  readonly texto: string;
  /** Só contagens, por tipo — nunca o valor. Inclui os tipos do redator base. */
  readonly substituicoes: Readonly<Record<string, number>>;
}

export interface RedatorDePeca {
  redigir(texto: string): ResultadoDaRedacaoDePeca;
}

function redigirAcrescimos(texto: string): {
  texto: string;
  contagem: Record<TipoDeRedacaoDePeca, number>;
} {
  const plano = semAcentoMantendoTamanho(texto);
  const achados: { inicio: number; fim: number; tipo: TipoDeRedacaoDePeca }[] = [];
  for (const { tipo, regex } of PADROES) {
    for (const m of plano.matchAll(new RegExp(regex.source, regex.flags))) {
      const inicio = m.index ?? 0;
      achados.push({ inicio, fim: inicio + m[0].length, tipo });
    }
  }
  achados.sort((a, b) => a.inicio - b.inicio || b.fim - b.inicio - (a.fim - a.inicio));
  const contagem: Record<TipoDeRedacaoDePeca, number> = {
    CEP: 0,
    IDENTIDADE: 0,
    NASCIMENTO: 0,
    CONTA: 0,
  };
  let saida = '';
  let cursor = 0;
  for (const a of achados) {
    if (a.inicio < cursor) continue; // sobreposto a um trecho já redigido
    saida += texto.slice(cursor, a.inicio) + `[${a.tipo}]`;
    contagem[a.tipo] += 1;
    cursor = a.fim;
  }
  saida += texto.slice(cursor);
  return { texto: saida, contagem };
}

/**
 * Um redator para a PEÇA inteira: o mesmo nome vira o mesmo marcador em todas as páginas
 * (o redator do ato guarda o mapa), e os acréscimos entram em cada página depois dele.
 */
export function criarRedatorDePeca(pessoas: PessoasParaRedigir = {}): RedatorDePeca {
  const base = criarRedator(pessoas);
  return {
    redigir(texto: string): ResultadoDaRedacaoDePeca {
      const primeira: ResultadoDaRedacao = base.redigir(texto);
      const { texto: final, contagem } = redigirAcrescimos(primeira.texto);
      return { texto: final, substituicoes: { ...primeira.substituicoes, ...contagem } };
    },
  };
}

export function redigirPecaParaIA(
  texto: string,
  pessoas: PessoasParaRedigir = {},
): ResultadoDaRedacaoDePeca {
  return criarRedatorDePeca(pessoas).redigir(texto);
}
