import { semAcentoMantendoTamanho } from './normalizacaoDeTexto.js';

/**
 * Redação antes de enviar ao modelo (spec ia-analise-do-ato v1.0.0, seção 5).
 *
 * Troca por marcador o que identifica pessoa ou processo: número CNJ, CPF/CNPJ,
 * e-mail, telefone, inscrição na OAB e os NOMES das partes e dos advogados que o
 * retrato já conhece. O texto verificado depois é o texto REDIGIDO — o que de
 * fato saiu do servidor.
 *
 * Princípios que moldam o código:
 *
 * - Na dúvida, redige. Falso positivo custa uma palavra a menos para o modelo;
 *   falso negativo é dado pessoal fora do servidor.
 * - Uma passada só, sobre o texto ORIGINAL. Substituir em cascata deixaria um
 *   marcador (`[PARTE A]`) à mercê da etapa seguinte.
 * - Os marcadores de pessoa são atribuídos pela ordem do RETRATO, não pela
 *   ordem em que aparecem: o texto redigido (e a chave de cache) não dependem de
 *   quais nomes calharam de ser citados.
 * - O mapa marcador→original vive só na instância do redator, em memória.
 */

export interface AdvogadoParaRedigir {
  readonly nome: string;
}

export interface ParteParaRedigir {
  readonly nome: string;
  /** Pessoa física: cada nome próprio isolado também é redigido. */
  readonly pessoaFisica?: boolean;
  readonly advogados?: readonly AdvogadoParaRedigir[];
}

export interface PessoasParaRedigir {
  readonly partes?: readonly ParteParaRedigir[];
  /** Advogados soltos (ex.: os do cadastro do workspace). */
  readonly advogados?: readonly AdvogadoParaRedigir[];
}

export type TipoDeRedacao =
  'PROCESSO' | 'DOCUMENTO' | 'CONTATO' | 'OAB' | 'PARTE' | 'ADVOGADO';

export interface ResultadoDaRedacao {
  readonly texto: string;
  /** Quantas ocorrências foram trocadas, por tipo. Só contagem, nunca o valor. */
  readonly substituicoes: Readonly<Record<TipoDeRedacao, number>>;
  /** Devolve os valores originais no lugar dos marcadores (para exibir ao dono do dado). */
  restaurar(texto: string): string;
}

export interface Redator {
  redigir(texto: string): ResultadoDaRedacao;
  restaurar(texto: string): string;
}

// --- padrões estruturais ---------------------------------------------------

const UFS =
  'AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO';

interface PadraoEstrutural {
  readonly tipo: Exclude<TipoDeRedacao, 'PARTE' | 'ADVOGADO'>;
  readonly regex: RegExp;
}

// A ordem não decide quem ganha (a varredura é pela posição e, empatando, pelo
// trecho mais longo); ela só desempata padrões que começam no mesmo ponto.
const PADROES: readonly PadraoEstrutural[] = [
  {
    tipo: 'PROCESSO',
    regex: /(?<!\d)\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}(?!\d)/g,
  },
  { tipo: 'PROCESSO', regex: /(?<!\d)\d{20}(?!\d)/g },
  // CNPJ antes de CPF por clareza; os formatos não se confundem.
  { tipo: 'DOCUMENTO', regex: /(?<!\d)\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/g },
  { tipo: 'DOCUMENTO', regex: /(?<!\d)\d{14}(?!\d)/g },
  // CPF completo ou mascarado pela fonte pública (***.456.789-**).
  { tipo: 'DOCUMENTO', regex: /(?<![\d*])[\d*]{3}\.\d{3}\.\d{3}-[\d*]{2}(?![\d*])/g },
  { tipo: 'DOCUMENTO', regex: /(?<![\d*])\*{3}\.\d{3}\.\d{3}-\*{2}(?![\d*])/g },
  { tipo: 'DOCUMENTO', regex: /(?<!\d)\d{11}(?!\d)/g },
  { tipo: 'CONTATO', regex: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu },
  // Telefone: exige parênteses, +55 ou hífen — dígitos soltos não são telefone.
  { tipo: 'CONTATO', regex: /(?:\+55\s?)?\(\s?\d{2}\s?\)\s?9?\d{4}[-\s]?\d{4}(?!\d)/g },
  { tipo: 'CONTATO', regex: /(?<!\d)\+55\s?\d{2}\s?9?\d{4}[-\s]?\d{4}(?!\d)/g },
  { tipo: 'CONTATO', regex: /(?<!\d)\d{2}\s9\d{4}-?\d{4}(?!\d)/g },
  { tipo: 'CONTATO', regex: /(?<![\d/.-])9?\d{4}-\d{4}(?![\d/-])/g },
  // OAB: "OAB/GO 12.345", "OAB 12345/GO", "OAB-GO nº 12345", "OAB/GO n. 12345".
  {
    tipo: 'OAB',
    regex: new RegExp(
      `\\bOAB\\b[\\s/:.-]*(?:(?:${UFS})\\b[\\s/:.,-]*)?(?:n[ºo°.]*\\s*)?(?:\\d{1,3}(?:\\.\\d{3})+|\\d{3,6})(?:\\s*[/-]\\s*(?:${UFS})\\b)?`,
      'gi',
    ),
  },
  // Inscrição "nua", como o DJEN a escreve ao listar advogados: 47383/GO.
  {
    tipo: 'OAB',
    regex: new RegExp(`(?<![\\d/])\\d{3,6}\\s?/\\s?(?:${UFS})\\b`, 'g'),
  },
];

// --- nomes -----------------------------------------------------------------

/**
 * Palavras que, sozinhas, não identificam ninguém: ligações de nome e termos
 * comuns em razão social. Um nome é redigido por inteiro SEMPRE; esta lista só
 * decide quais pedaços soltos dele também são.
 */
const NAO_IDENTIFICAM = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
  'em',
  'a',
  'o',
  'para',
  'por',
  'com',
  'banco',
  'estado',
  'municipio',
  'uniao',
  'federal',
  'brasil',
  'brasileiro',
  'empresa',
  'companhia',
  'sociedade',
  'comercio',
  'servicos',
  'industria',
  'ltda',
  'eireli',
  'epp',
  'me',
  'sa',
  's/a',
  'ss',
  'filho',
  'filha',
  'junior',
  'neto',
  'sobrinho',
  'publica',
  'publico',
  'fazenda',
  'ministerio',
  'instituto',
  'associacao',
  'cooperativa',
  'sindicato',
  'agencia',
  'caixa',
  'economica',
  'nacional',
  'regional',
  'geral',
  'central',
]);

function palavrasDoNome(nome: string): string[] {
  return nome
    .split(/[\s]+/)
    .map((p) => p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((p) => p.length > 0);
}

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function letras(indice: number): string {
  let n = indice;
  let saida = '';
  do {
    saida = String.fromCharCode(65 + (n % 26)) + saida;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return saida;
}

interface Pessoa {
  readonly marcador: string;
  readonly tipo: 'PARTE' | 'ADVOGADO';
  readonly nome: string;
  readonly pessoaFisica: boolean;
}

function montarPessoas(entrada: PessoasParaRedigir): Pessoa[] {
  const vistos = new Map<string, Pessoa>();
  const contadores = { PARTE: 0, ADVOGADO: 0 };

  const acrescentar = (
    nomeBruto: string,
    tipo: 'PARTE' | 'ADVOGADO',
    fisica: boolean,
  ): void => {
    const nome = nomeBruto.trim().replace(/\s+/g, ' ');
    if (nome.length < 3) return;
    const chave = semAcentoMantendoTamanho(nome);
    const existente = vistos.get(chave);
    if (existente) return;
    const marcador = `[${tipo === 'PARTE' ? 'PARTE' : 'ADVOGADO'} ${letras(contadores[tipo]++)}]`;
    vistos.set(chave, { marcador, tipo, nome, pessoaFisica: fisica });
  };

  // Partes primeiro (na ordem do retrato), depois os advogados de cada uma e
  // os soltos: a letra de cada um não depende do texto do ato.
  for (const parte of entrada.partes ?? []) {
    acrescentar(parte.nome, 'PARTE', parte.pessoaFisica ?? true);
  }
  for (const parte of entrada.partes ?? []) {
    for (const adv of parte.advogados ?? []) acrescentar(adv.nome, 'ADVOGADO', true);
  }
  for (const adv of entrada.advogados ?? []) acrescentar(adv.nome, 'ADVOGADO', true);
  return [...vistos.values()];
}

interface PadraoDeNome {
  readonly regex: RegExp;
  readonly pessoa: Pessoa;
}

function padroesDoNome(pessoa: Pessoa): PadraoDeNome[] {
  const palavras = palavrasDoNome(pessoa.nome);
  const comoRegex = (lista: readonly string[]): RegExp => {
    const miolo = lista
      .map((p) => escaparRegex(semAcentoMantendoTamanho(p)))
      .join('\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])${miolo}(?![\\p{L}\\p{N}])`, 'gu');
  };

  const padroes: PadraoDeNome[] = [{ regex: comoRegex(palavras), pessoa }];
  if (palavras.length >= 2) {
    // Primeiro + último nome ("Maria Silva" para "Maria Aparecida da Silva").
    const primeiro = palavras[0];
    const ultimo = palavras[palavras.length - 1];
    if (primeiro && ultimo && primeiro !== ultimo) {
      padroes.push({ regex: comoRegex([primeiro, ultimo]), pessoa });
    }
    // Nome isolado: só quando identifica de fato (pessoa; ≥ 4 letras; fora da lista).
    for (const palavra of palavras) {
      const base = semAcentoMantendoTamanho(palavra);
      if (palavra.length < 4 || NAO_IDENTIFICAM.has(base)) continue;
      if (!pessoa.pessoaFisica && pessoa.tipo === 'PARTE') continue;
      padroes.push({ regex: comoRegex([palavra]), pessoa });
    }
  }
  return padroes;
}

// --- o redator --------------------------------------------------------------

interface Candidato {
  readonly inicio: number;
  readonly fim: number;
  readonly tipo: TipoDeRedacao;
  readonly original: string;
  readonly pessoa?: Pessoa;
}

function contagemVazia(): Record<TipoDeRedacao, number> {
  return { PROCESSO: 0, DOCUMENTO: 0, CONTATO: 0, OAB: 0, PARTE: 0, ADVOGADO: 0 };
}

export function criarRedator(pessoas: PessoasParaRedigir = {}): Redator {
  const listaDePessoas = montarPessoas(pessoas);
  const padroesDeNome = listaDePessoas.flatMap(padroesDoNome);
  const mapa = new Map<string, string>(listaDePessoas.map((p) => [p.marcador, p.nome]));
  // valor normalizado → marcador, por tipo, para o mesmo valor ter o mesmo marcador.
  const porValor = new Map<string, string>();
  const usados: Record<string, number> = {};

  const marcadorEstrutural = (tipo: TipoDeRedacao, original: string): string => {
    const chave = `${tipo}|${semAcentoMantendoTamanho(original).replace(/[\s.\-/]/g, '')}`;
    const existente = porValor.get(chave);
    if (existente) return existente;
    const n = (usados[tipo] ?? 0) + 1;
    usados[tipo] = n;
    const marcador = n === 1 ? `[${tipo}]` : `[${tipo} ${n}]`;
    porValor.set(chave, marcador);
    mapa.set(marcador, original.trim());
    return marcador;
  };

  const restaurar = (texto: string): string =>
    texto.replace(
      /\[(?:PROCESSO|DOCUMENTO|CONTATO|OAB|PARTE|ADVOGADO)(?: [A-Z]+| \d+)?\]/g,
      (m) => {
        return mapa.get(m) ?? m;
      },
    );

  const redigir = (texto: string): ResultadoDaRedacao => {
    const plano = semAcentoMantendoTamanho(texto);
    const candidatos: Candidato[] = [];

    for (const { tipo, regex } of PADROES) {
      for (const m of texto.matchAll(new RegExp(regex.source, regex.flags))) {
        const inicio = m.index ?? 0;
        candidatos.push({ inicio, fim: inicio + m[0].length, tipo, original: m[0] });
      }
    }
    for (const { regex, pessoa } of padroesDeNome) {
      for (const m of plano.matchAll(new RegExp(regex.source, regex.flags))) {
        const inicio = m.index ?? 0;
        candidatos.push({
          inicio,
          fim: inicio + m[0].length,
          tipo: pessoa.tipo,
          original: texto.slice(inicio, inicio + m[0].length),
          pessoa,
        });
      }
    }

    // Esquerda para a direita; começando no mesmo ponto, o mais longo.
    candidatos.sort(
      (a, b) => a.inicio - b.inicio || b.fim - b.inicio - (a.fim - a.inicio),
    );

    const contagem = contagemVazia();
    let saida = '';
    let cursor = 0;
    let ultimoMarcador = '';
    for (const c of candidatos) {
      if (c.inicio < cursor) continue; // sobreposto a um trecho já redigido
      const marcador = c.pessoa
        ? c.pessoa.marcador
        : marcadorEstrutural(c.tipo, c.original);
      const entre = texto.slice(cursor, c.inicio);
      // "Maria Aparecida" redigido em dois pedaços vira UM marcador, não dois.
      const colado =
        marcador === ultimoMarcador && entre.length > 0 && /^\s+$/.test(entre);
      if (!colado) saida += entre + marcador;
      contagem[c.tipo] += 1;
      cursor = c.fim;
      ultimoMarcador = marcador;
    }
    saida += texto.slice(cursor);

    return { texto: saida, substituicoes: contagem, restaurar };
  };

  return { redigir, restaurar };
}

/**
 * Atalho de uma chamada: redige UM texto. Para vários textos da mesma requisição
 * (ato + títulos anteriores) use `criarRedator`, que mantém o mesmo mapa.
 */
export function redigirParaIA(
  texto: string,
  pessoas: PessoasParaRedigir = {},
): ResultadoDaRedacao {
  return criarRedator(pessoas).redigir(texto);
}
