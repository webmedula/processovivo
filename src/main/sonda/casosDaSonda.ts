import type { PessoasParaRedigir } from '../../application/politicas/redigirParaIA.js';

/**
 * Casos da sonda de IA do ato: a leitura do CSV (fora do repositório) e do
 * conjunto sintético (dentro dele). Nada aqui toca rede ou disco — quem lê o
 * arquivo é a `AmbienteDaSonda`.
 *
 * Mensagens de erro citam a LINHA, nunca o conteúdo: o CSV pode trazer texto de
 * ato de processo real, e texto de caso real não vai para log nem para terminal.
 */

export type OrigemDoCaso = 'real' | 'sintetico';

export interface CasoDaSonda {
  readonly id: string;
  readonly origem: OrigemDoCaso;
  readonly titulo: string;
  readonly texto: string;
  readonly tipoComunicacao?: string;
  readonly classe?: string;
  readonly data: Date;
  /** Títulos dos andamentos anteriores (para a variante "com títulos"). */
  readonly anteriores: readonly string[];
  readonly pessoas: PessoasParaRedigir;
  /** O texto contém instrução injetada (esperado: o esquema não muda). */
  readonly injecao: boolean;
  /** Cadeia que, aparecendo na saída do modelo, prova que ele obedeceu à injeção. */
  readonly canario?: string;
}

export class CsvDeCasosInvalidoError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'CsvDeCasosInvalidoError';
  }
}

/** CSV com `;`, aspas duplas, `""` como aspa literal e quebra de linha dentro de campo. */
export function lerCsv(texto: string): string[][] {
  const limpo = texto.startsWith('\uFEFF') ? texto.slice(1) : texto;
  const linhas: string[][] = [];
  let campo = '';
  let linha: string[] = [];
  let dentroDeAspas = false;
  for (let i = 0; i < limpo.length; i++) {
    const c = limpo.charAt(i);
    if (dentroDeAspas) {
      if (c === '"') {
        if (limpo.charAt(i + 1) === '"') {
          campo += '"';
          i++;
        } else {
          dentroDeAspas = false;
        }
      } else {
        campo += c;
      }
    } else if (c === '"' && campo === '') {
      dentroDeAspas = true;
    } else if (c === ';') {
      linha.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && limpo.charAt(i + 1) === '\n') i++;
      linha.push(campo);
      campo = '';
      if (linha.some((x) => x.trim() !== '')) linhas.push(linha);
      linha = [];
    } else {
      campo += c;
    }
  }
  if (dentroDeAspas)
    throw new CsvDeCasosInvalidoError('aspas abertas sem fechar no fim do arquivo');
  linha.push(campo);
  if (linha.some((x) => x.trim() !== '')) linhas.push(linha);
  return linhas;
}

export function escreverCsv(linhas: readonly (readonly string[])[]): string {
  const campo = (v: string): string =>
    /[";\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
  return linhas.map((l) => l.map(campo).join(';')).join('\n') + '\n';
}

const COLUNAS_OBRIGATORIAS = ['id', 'texto'] as const;

function interpretarData(valor: string | undefined, linha: number): Date {
  if (!valor || valor.trim() === '') return new Date('2026-01-15T00:00:00-03:00');
  const v = valor.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const partes = br ? [br[3], br[2], br[1]] : iso ? [iso[1], iso[2], iso[3]] : undefined;
  if (!partes)
    throw new CsvDeCasosInvalidoError(`linha ${linha}: data em formato desconhecido`);
  const data = new Date(`${partes[0]}-${partes[1]}-${partes[2]}T00:00:00-03:00`);
  if (Number.isNaN(data.getTime())) {
    throw new CsvDeCasosInvalidoError(`linha ${linha}: data inexistente`);
  }
  return data;
}

/**
 * Colunas: `id;tipo_comunicacao;classe;texto` (as quatro combinadas). Opcionais:
 * `titulo`, `data` (dd/mm/aaaa), `anteriores` (títulos separados por `|`, para a
 * variante "com títulos") e `injecao` (sim/nao).
 */
export function lerCasosCsv(texto: string): CasoDaSonda[] {
  const linhas = lerCsv(texto);
  const cabecalho = linhas[0]?.map((c) => c.trim().toLowerCase());
  if (!cabecalho) throw new CsvDeCasosInvalidoError('arquivo vazio');
  for (const obrigatoria of COLUNAS_OBRIGATORIAS) {
    if (!cabecalho.includes(obrigatoria)) {
      throw new CsvDeCasosInvalidoError(
        `falta a coluna "${obrigatoria}" (esperado: id;tipo_comunicacao;classe;texto)`,
      );
    }
  }
  const col = (nome: string): number => cabecalho.indexOf(nome);
  const casos: CasoDaSonda[] = [];
  const ids = new Set<string>();

  linhas.slice(1).forEach((celulas, i) => {
    const numeroDaLinha = i + 2;
    const pegar = (nome: string): string | undefined => {
      const indice = col(nome);
      return indice >= 0 ? celulas[indice]?.trim() || undefined : undefined;
    };
    if (celulas.length > cabecalho.length) {
      throw new CsvDeCasosInvalidoError(
        `linha ${numeroDaLinha}: mais colunas do que o cabeçalho (texto com ";" precisa de aspas)`,
      );
    }
    const id = pegar('id');
    const textoDoAto = pegar('texto');
    if (!id) throw new CsvDeCasosInvalidoError(`linha ${numeroDaLinha}: id vazio`);
    if (!textoDoAto)
      throw new CsvDeCasosInvalidoError(`linha ${numeroDaLinha}: texto vazio`);
    if (ids.has(id))
      throw new CsvDeCasosInvalidoError(`linha ${numeroDaLinha}: id repetido`);
    ids.add(id);

    const tipo = pegar('tipo_comunicacao');
    const classe = pegar('classe');
    const anteriores = (pegar('anteriores') ?? '')
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 5);
    casos.push({
      id,
      origem: 'real',
      titulo: pegar('titulo') ?? tipo ?? 'Publicação',
      texto: textoDoAto,
      ...(tipo ? { tipoComunicacao: tipo } : {}),
      ...(classe ? { classe } : {}),
      data: interpretarData(pegar('data'), numeroDaLinha),
      anteriores,
      pessoas: {},
      injecao: /^(sim|s|true|1)$/i.test(pegar('injecao') ?? ''),
    });
  });
  return casos;
}

interface CasoSinteticoSerializado {
  id: string;
  titulo: string;
  texto: string;
  tipo_comunicacao?: string;
  classe?: string;
  data: string;
  anteriores: string[];
  partes?: Array<{
    nome: string;
    pessoaFisica?: boolean;
    advogados?: Array<{ nome: string }>;
  }>;
  injecao?: boolean;
  canario?: string;
}

/** Lê `tests/fixtures/ia-ato/casos-sinteticos.json` (tudo inventado). */
export function lerCasosSinteticos(json: string): CasoDaSonda[] {
  const bruto: unknown = JSON.parse(json);
  if (!Array.isArray(bruto))
    throw new CsvDeCasosInvalidoError('casos sintéticos: esperado array');
  return (bruto as CasoSinteticoSerializado[]).map((c) => ({
    id: c.id,
    origem: 'sintetico' as const,
    titulo: c.titulo,
    texto: c.texto,
    ...(c.tipo_comunicacao ? { tipoComunicacao: c.tipo_comunicacao } : {}),
    ...(c.classe ? { classe: c.classe } : {}),
    data: new Date(`${c.data}T00:00:00-03:00`),
    anteriores: c.anteriores,
    pessoas: {
      partes: (c.partes ?? []).map((p) => ({
        nome: p.nome,
        ...(p.pessoaFisica !== undefined ? { pessoaFisica: p.pessoaFisica } : {}),
        ...(p.advogados ? { advogados: p.advogados } : {}),
      })),
    },
    injecao: c.injecao === true,
    ...(c.canario ? { canario: c.canario } : {}),
  }));
}
