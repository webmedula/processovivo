import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ExtracaoDeTextoError } from '../../domain/errors/index.js';
import type { ExtratorDeTextoDePdf } from '../../domain/ports/ExtratorDeTextoDePdf.js';
import { abrirSomenteLeitura } from '../../infrastructure/persistencia/diagnosticoDeProvidencia.js';
import { percentil } from './sondaIaAto.js';

/**
 * Medição da camada de texto das peças guardadas (v0.53.0, Fase 0 da análise de peças).
 *
 * SOMENTE LEITURA e SEM REDE, no molde de `diagnostico-providencia.mjs`: o banco abre com
 * `readOnly` e `query_only` (nunca por `abrirBanco`, que cria esquema e migra), as peças são
 * lidas do disco só para extrair, e a SAÍDA É SÓ AGREGADO — contagens, percentuais e
 * percentis. Nenhum texto de peça, nome, número de processo, localizador ou workspace
 * chega ao terminal, e nada é gravado em lugar nenhum.
 *
 * A amostra é o que está na guarda agora (24 h por padrão): repita em dias diferentes.
 */

export const LIMITE_DE_PAGINAS = 40;
export const LIMITE_DE_CARACTERES = 80_000;
const AMOSTRA_PEQUENA = 30;
const PAGINAS_LIDAS_NA_MEDICAO = 200;

export interface AmbienteDaMedicao {
  readonly caminhoBanco: string;
  /** Raiz da guarda das peças (LEITOR_PASTA, ou `<pasta do banco>/leitor`). */
  readonly pastaDasPecas: string;
  readonly extrator: ExtratorDeTextoDePdf;
  /** Bytes do arquivo, ou `undefined` se não existe. */
  readonly lerArquivo: (caminho: string) => Promise<Uint8Array | undefined>;
  readonly existeArquivo: (caminho: string) => boolean;
  readonly agora: () => Date;
  readonly saida: (linha: string) => void;
  readonly aviso: (linha: string) => void;
}

/** O MESMO caminho que `ArmazemEmDisco` calcula — sem criar pasta (isto é leitura). */
export function caminhoDaPeca(
  raiz: string,
  workspace: string,
  localizador: string,
): string {
  const hash = createHash('sha256')
    .update(`leitor:${workspace}`)
    .digest('hex')
    .slice(0, 32);
  const base = join(resolve(raiz), hash);
  if (isAbsolute(localizador)) throw new Error('localizador absoluto');
  const alvo = resolve(base, localizador);
  const rel = relative(base, alvo);
  if (
    rel === '' ||
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    rel.split(sep).includes('..')
  ) {
    throw new Error('localizador fora da pasta');
  }
  return alvo;
}

interface LinhaDaPeca {
  readonly workspace: string;
  readonly localizador: string;
  readonly paginas: number;
  readonly conversao: string;
}

function pecasVigentes(db: DatabaseSync, agora: Date): LinhaDaPeca[] {
  return db
    .prepare(
      `SELECT workspace, localizador, paginas, conversao FROM pasta_pecas WHERE expira_em > ?`,
    )
    .all(agora.toISOString())
    .map((r) => ({
      workspace: String(r['workspace']),
      localizador: String(r['localizador']),
      paginas: Number(r['paginas']),
      conversao: String(r['conversao']),
    }));
}

const pct = (n: number, d: number): string =>
  d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}% (${n} de ${d})`;
const num = (v: number | undefined, casas = 0): string =>
  v === undefined ? '—' : v.toFixed(casas);
const distribuicao = (valores: readonly number[], unidade = ''): string =>
  valores.length === 0
    ? '—'
    : `p50 ${num(percentil(valores, 0.5))}${unidade} · p95 ${num(percentil(valores, 0.95))}${unidade} · máximo ${num(Math.max(...valores))}${unidade}`;

export interface AgregadosDaMedicao {
  readonly total: number;
  readonly lidas: number;
  readonly arquivoAusente: number;
  readonly comTexto: number;
  readonly semTexto: number;
  readonly acimaDePaginas: number;
  readonly acimaDeCaracteres: number;
  readonly acimaDeQualquerLimite: number;
  readonly elegiveis: number;
  readonly falhas: Readonly<Record<string, number>>;
}

export async function medirPecas(
  linhas: readonly LinhaDaPeca[],
  amb: Pick<AmbienteDaMedicao, 'pastaDasPecas' | 'extrator' | 'lerArquivo'>,
): Promise<{
  agregados: AgregadosDaMedicao;
  paginas: number[];
  caracteres: number[];
  duracoes: number[];
  porConversao: Record<string, number>;
}> {
  const paginas: number[] = linhas.map((l) => l.paginas);
  const caracteres: number[] = [];
  const duracoes: number[] = [];
  const falhas: Record<string, number> = {};
  const porConversao: Record<string, number> = {};
  let lidas = 0;
  let ausentes = 0;
  let comTexto = 0;
  let semTexto = 0;
  let acimaPag = 0;
  let acimaChar = 0;
  let acimaQualquer = 0;
  let elegiveis = 0;

  for (const l of linhas) {
    porConversao[l.conversao] = (porConversao[l.conversao] ?? 0) + 1;
    const acimaDePaginas = l.paginas > LIMITE_DE_PAGINAS;
    if (acimaDePaginas) acimaPag += 1;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await amb.lerArquivo(
        caminhoDaPeca(amb.pastaDasPecas, l.workspace, l.localizador),
      );
    } catch {
      bytes = undefined;
    }
    if (!bytes) {
      ausentes += 1;
      if (acimaDePaginas) acimaQualquer += 1;
      continue;
    }
    try {
      const r = await amb.extrator.extrair(bytes, {
        maxPaginas: PAGINAS_LIDAS_NA_MEDICAO,
        maxCaracteres: LIMITE_DE_CARACTERES,
      });
      lidas += 1;
      caracteres.push(r.contagens.caracteres);
      duracoes.push(r.contagens.duracaoMs);
      if (r.contagens.temTextoPesquisavel) comTexto += 1;
      else semTexto += 1;
      const acimaDeCaracteres = r.contagens.excedeLimiteDeCaracteres;
      if (acimaDeCaracteres) acimaChar += 1;
      if (acimaDePaginas || acimaDeCaracteres) acimaQualquer += 1;
      if (r.contagens.temTextoPesquisavel && !acimaDePaginas && !acimaDeCaracteres) {
        elegiveis += 1;
      }
    } catch (erro) {
      const chave =
        erro instanceof ExtracaoDeTextoError ? erro.motivo : 'erro_inesperado';
      falhas[chave] = (falhas[chave] ?? 0) + 1;
      if (acimaDePaginas) acimaQualquer += 1;
    }
  }
  return {
    agregados: {
      total: linhas.length,
      lidas,
      arquivoAusente: ausentes,
      comTexto,
      semTexto,
      acimaDePaginas: acimaPag,
      acimaDeCaracteres: acimaChar,
      acimaDeQualquerLimite: acimaQualquer,
      elegiveis,
      falhas,
    },
    paginas,
    caracteres,
    duracoes,
    porConversao,
  };
}

const AJUDA = `Medição da camada de texto das peças guardadas (v0.53.0) — SOMENTE LEITURA, SEM REDE.
Mostra só agregados: nenhum texto, nome, número de processo ou workspace.

  node scripts/pecas-medir-texto.mjs

Variáveis lidas (as mesmas do serviço): PROCESSOVIVO_DB_PATH e LEITOR_PASTA.
A amostra é o que está na guarda agora (24 h): repita em dias diferentes.`;

export async function executarMedicaoDeTexto(
  argv: readonly string[],
  amb: AmbienteDaMedicao,
): Promise<number> {
  if (argv.includes('--ajuda')) {
    amb.saida(AJUDA);
    return 0;
  }
  if (!amb.existeArquivo(amb.caminhoBanco)) {
    amb.aviso('Não encontrei o banco (PROCESSOVIVO_DB_PATH). Nada foi lido.');
    return 1;
  }
  let db: DatabaseSync;
  try {
    db = abrirSomenteLeitura(amb.caminhoBanco);
  } catch {
    amb.aviso('Não consegui abrir o banco em modo somente leitura.');
    return 1;
  }
  let linhas: LinhaDaPeca[];
  try {
    linhas = pecasVigentes(db, amb.agora());
  } catch {
    amb.aviso(
      'O banco não tem a tabela das peças guardadas (a Pasta digital nunca foi usada?).',
    );
    return 1;
  } finally {
    db.close();
  }
  if (linhas.length === 0) {
    amb.saida('Nenhuma peça na guarda agora. Nada a medir.');
    return 0;
  }

  const {
    agregados: a,
    paginas,
    caracteres,
    duracoes,
    porConversao,
  } = await medirPecas(linhas, amb);
  amb.saida(
    `Medição da camada de texto das peças (v0.53.0) · ${amb.agora().toISOString().slice(0, 10)}`,
  );
  amb.saida(
    `Peças na guarda: ${a.total} · lidas: ${a.lidas} · arquivo ausente: ${a.arquivoAusente}`,
  );
  if (a.total < AMOSTRA_PEQUENA) {
    amb.saida(
      `ATENÇÃO: amostra pequena (menos de ${AMOSTRA_PEQUENA} peças). Os percentuais variam muito; repita em outros dias.`,
    );
  }
  amb.saida(`Com texto pesquisável: ${pct(a.comTexto, a.lidas)}`);
  amb.saida(`Sem texto (escaneadas, sem OCR): ${pct(a.semTexto, a.lidas)}`);
  amb.saida(`Páginas (de todas as peças): ${distribuicao(paginas)}`);
  amb.saida(
    `Caracteres (das lidas, até ${PAGINAS_LIDAS_NA_MEDICAO} páginas cada): ${distribuicao(caracteres)}`,
  );
  amb.saida(`Acima de ${LIMITE_DE_PAGINAS} páginas: ${pct(a.acimaDePaginas, a.total)}`);
  amb.saida(
    `Acima de ${LIMITE_DE_CARACTERES} caracteres: ${pct(a.acimaDeCaracteres, a.lidas)}`,
  );
  amb.saida(`Acima de qualquer limite: ${pct(a.acimaDeQualquerLimite, a.total)}`);
  amb.saida(
    `Elegíveis para análise (texto pesquisável e dentro dos dois limites): ${pct(a.elegiveis, a.lidas)}`,
  );
  const falhasEmTexto = Object.entries(a.falhas)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([tipo, n]) => `${tipo}: ${n}`);
  const totalFalhas = Object.values(a.falhas).reduce((s, n) => s + n, 0);
  amb.saida(
    `Falhas de extração: ${pct(totalFalhas, a.total - a.arquivoAusente)}${falhasEmTexto.length > 0 ? ` · ${falhasEmTexto.join(' · ')}` : ''}`,
  );
  amb.saida(`Tempo de extração por peça: ${distribuicao(duracoes, ' ms')}`);
  amb.saida(
    `Origem do arquivo guardado: ${Object.entries(porConversao)
      .sort(([x], [y]) => x.localeCompare(y))
      .map(
        ([k, n]) => `${k === 'nenhuma' ? 'PDF do tribunal' : `convertido de ${k}`}: ${n}`,
      )
      .join(' · ')}`,
  );
  return 0;
}
