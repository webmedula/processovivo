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
 * - **Endereço** sem tipo de via nem "residente/domiciliado" (só "Setor Sul, Goiânia"), nome de
 *   edifício e ponto de referência. Desde a v0.55.0 o logradouro com tipo de via e a oração
 *   "residente e domiciliado na/no/em …" SÃO pegos, mais o CEP.
 * - **Nome de terceiro** que não está no retrato (testemunha, perito, filho, sócio).
 * - Documento sem rótulo e sem máscara de RG (CNH e RG só com dígitos), conta sem a palavra "conta"
 *   ou "agência", data de nascimento sem "nascido"/"nascimento" por perto, chave Pix que não seja
 *   e-mail, telefone, CPF ou chave aleatória (UUID), placa de veículo.
 * Na dúvida redige (falso positivo custa uma palavra); o que está acima continua passando.
 */

export type TipoDeRedacaoDePeca =
  | 'CEP'
  | 'IDENTIDADE'
  | 'NASCIMENTO'
  | 'CONTA'
  | 'ENDERECO'
  | 'CHAVE'
  | 'CARTAO';

/** O marcador que o modelo vê para cada tipo (o endereço leva cedilha, como o texto do produto). */
const ROTULO_DO_MARCADOR: Readonly<Record<TipoDeRedacaoDePeca, string>> = {
  CEP: 'CEP',
  IDENTIDADE: 'IDENTIDADE',
  NASCIMENTO: 'NASCIMENTO',
  CONTA: 'CONTA',
  ENDERECO: 'ENDEREÇO',
  CHAVE: 'CHAVE',
  CARTAO: 'CARTÃO',
};

interface PadraoDePeca {
  readonly tipo: TipoDeRedacaoDePeca;
  readonly regex: RegExp;
}

const MESES =
  'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
const DATA = `(?:\\d{1,2}\\s*[/.-]\\s*\\d{1,2}\\s*[/.-]\\s*\\d{2,4}|\\d{1,2}\\s+de\\s+(?:${MESES})\\s+de\\s+\\d{4})`;
const NUMERO_DE_DOCUMENTO = '\\d[\\d.\\- ]{5,14}[\\dx]';
const NUMERO_DE_CONTA = '\\d[\\d.\\-/ ]{2,12}[\\dx]';
// Logradouro (v0.55.0): tipo da via + nome até a vírgula ou o ponto, número e, se vierem, bairro e
// cidade/UF. Roda no texto sem acento e em minúsculas.
const VIA =
  '(?:rua|avenida|av\\.|alameda|travessa|rodovia|estrada|praca|quadra|qd\\.|largo|viela)';
const NUMERO_DA_VIA = '(?:,?\\s*(?:n[°ºo.]*\\s*)?\\d{1,5}[a-z]?(?:\\s*[-/]\\s*\\w{1,6})?)?';
const COMPLEMENTO_DA_VIA =
  '(?:,\\s*(?:quadra|qd\\.?|lote|lt\\.?|casa|apto\\.?|apartamento|bloco|sala)\\s*\\w{1,6})*';
const BAIRRO =
  '(?:,\\s*(?:bairro|setor|jardim|vila|parque|residencial|conjunto|loteamento|centro)\\b[^,.;\\n]{0,40})?';
const CIDADE_UF = '(?:,\\s*[a-z][a-z ]{2,30}\\s*[-/]\\s*[a-z]{2}\\b)?';

// Os padrões rodam sobre o texto SEM acento e em minúsculas (mesmo tamanho do original), então
// só se escrevem em minúsculas e sem acento.
const PADROES: readonly PadraoDePeca[] = [
  // Endereço rotulado por tipo de via ("Rua das Flores, nº 100, Setor Central, Goiânia - GO") ou por
  // "residente/domiciliado na/no/em ...": é o que se consegue com padrão. Endereço SEM esse jeito de
  // escrever (só "Setor Sul, Goiânia"), nome de edifício ou ponto de referência NÃO é pego.
  {
    tipo: 'ENDERECO',
    regex: new RegExp(
      `\\b${VIA}\\s+[a-z0-9][^,.;\\n]{1,60}${NUMERO_DA_VIA}${COMPLEMENTO_DA_VIA}${BAIRRO}${CIDADE_UF}`,
      'g',
    ),
  },
  {
    tipo: 'ENDERECO',
    regex:
      /\b(?:residentes?|domiciliad[oa]s?|resident[ea]s? e domiciliad[oa]s?)\s+(?:na|no|em|a)\s+[^.;\n]{5,120}/g,
  },
  // RG no layout de máscara (12.345.678-9) sem rótulo; CPF e CNPJ já saem na redação do ato.
  { tipo: 'IDENTIDADE', regex: /(?<![\d.\-/])\d{1,2}\.\d{3}\.\d{3}-[\dx](?![\d-])/g },
  // Chave aleatória do Pix (UUID) e número de cartão (4 × 4 dígitos).
  { tipo: 'CHAVE', regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g },
  { tipo: 'CARTAO', regex: /(?<![\d-])\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}(?![\d-])/g },
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
  /** Devolve os nomes do retrato no lugar dos marcadores `[PARTE A]`… (os dos acréscimos não voltam). */
  restaurar(texto: string): string;
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
    ENDERECO: 0,
    CHAVE: 0,
    CARTAO: 0,
  };
  let saida = '';
  let cursor = 0;
  for (const a of achados) {
    if (a.inicio < cursor) continue; // sobreposto a um trecho já redigido
    saida += texto.slice(cursor, a.inicio) + `[${ROTULO_DO_MARCADOR[a.tipo]}]`;
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
    restaurar: (texto) => base.restaurar(texto),
  };
}

export function redigirPecaParaIA(
  texto: string,
  pessoas: PessoasParaRedigir = {},
): ResultadoDaRedacaoDePeca {
  return criarRedatorDePeca(pessoas).redigir(texto);
}
