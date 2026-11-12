import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../../domain/ports/Logger.js';

/**
 * Backup do banco, com o serviço em pé.
 *
 * **Por que `VACUUM INTO` e não copiar o arquivo.** Em WAL — que é o modo que
 * este projeto usa —, o arquivo `.db` no disco NÃO é o estado atual: parte dos
 * dados vive no `-wal` até o próximo checkpoint. Copiar só o `.db` produz um
 * arquivo que abre, parece íntegro e está desatualizado; copiar os três
 * arquivos no meio de uma escrita produz um conjunto inconsistente. `VACUUM
 * INTO` pede ao próprio SQLite um arquivo novo, consistente, sem travar quem
 * está escrevendo. É a forma suportada de fazer backup a quente.
 *
 * **O limite honesto:** um backup no MESMO volume protege contra corrupção,
 * migração ruim e exclusão acidental — não contra perder o volume. Cópia
 * externa é um passo separado, e está no runbook de deploy. Um backup ao lado
 * do original é metade de um backup, e é melhor saber disso antes de precisar.
 */

export interface OpcoesBackup {
  /** Caminho do banco em uso. */
  readonly caminhoBanco: string;
  /** Pasta onde as cópias ficam. Padrão: `backups/` ao lado do banco. */
  readonly destino?: string;
  /**
   * Quantas cópias manter. Padrão: 7. A retenção é por DIA (v0.67.3): extras do
   * mesmo dia saem antes de qualquer dia anterior — ver `escolherBackupsParaApagar`.
   */
  readonly manter?: number;
  readonly logger?: Logger;
  /** Injetável para teste; o padrão é a hora de agora. */
  readonly agora?: () => Date;
}

export interface ResultadoBackup {
  readonly caminho: string;
  readonly bytes: number;
  readonly integro: boolean;
  readonly apagados: readonly string[];
}

export class BackupFalhouError extends Error {
  constructor(motivo: string, options?: { cause?: unknown }) {
    super(`Backup não foi concluído: ${motivo}`, options);
    this.name = 'BackupFalhouError';
  }
}

const MANTER_PADRAO = 7;

/**
 * Gera uma cópia e CONFERE que ela presta.
 *
 * A conferência não é zelo excessivo: backup que ninguém abriu é uma suposição,
 * não uma cópia. `PRAGMA integrity_check` é rodado no ARQUIVO NOVO, e a
 * contagem de contas é comparada com a do original — se o arquivo estiver
 * truncado ou vazio, isso aparece aqui e não no dia do desastre.
 *
 * @throws {BackupFalhouError} quando a cópia não passa na conferência. Falhar
 *   alto é proposital: backup silenciosamente quebrado é pior que nenhum,
 *   porque leva a decisões apoiadas nele.
 */
export function gerarBackup(opcoes: OpcoesBackup): ResultadoBackup {
  const { caminhoBanco } = opcoes;
  if (caminhoBanco === ':memory:') {
    throw new BackupFalhouError('o banco está em memória e não tem o que copiar');
  }

  const destino = opcoes.destino ?? pastaDeBackups(caminhoBanco);
  const manter = opcoes.manter ?? MANTER_PADRAO;
  const agora = (opcoes.agora ?? (() => new Date()))();
  const log = opcoes.logger?.child({ componente: 'backup' });

  // 0700 na pasta: a cópia é o banco inteiro — hashes de senha, hashes de token
  // de sessão, e-mail de todos os assinantes. Só o dono do processo precisa
  // ler. (`mode` não se aplica a diretório que já existe; o `chmod` abaixo
  // cuida do caso do volume criado por uma versão anterior.)
  mkdirSync(destino, { recursive: true, mode: 0o700 });
  try {
    chmodSync(destino, 0o700);
  } catch {
    // Volume montado com dono diferente: seguir em frente. Uma permissão larga
    // demais é um problema; não ter backup nenhum é pior.
  }

  // Nome ordenável por texto: ISO com os dois-pontos trocados por hífen, que
  // não vale em nome de arquivo em todo sistema. Ordem alfabética = ordem
  // cronológica, o que faz a poda ser um `slice`.
  const marca = agora.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  const caminho = join(destino, `processovivo-${marca}.db`);

  const origem = new DatabaseSync(caminhoBanco, { readOnly: true });
  let contasNaOrigem: number;
  try {
    contasNaOrigem = contarContas(origem);
    // O caminho vai como literal porque VACUUM INTO não aceita parâmetro
    // ligado. As aspas simples são duplicadas para não fechar a string.
    origem.exec(`VACUUM INTO '${caminho.replace(/'/g, "''")}'`);
  } catch (erro) {
    throw new BackupFalhouError(
      erro instanceof Error ? erro.message : String(erro),
      { cause: erro },
    );
  } finally {
    origem.close();
  }

  // 0600 no arquivo: o `VACUUM INTO` cria com a umask do processo, que em
  // contêiner costuma dar 0644 — legível por qualquer usuário que monte o
  // volume noutro lugar.
  try {
    chmodSync(caminho, 0o600);
  } catch {
    // Ver acima.
  }

  const bytes = statSync(caminho).size;
  const integro = conferirCopia(caminho, contasNaOrigem);
  if (!integro) {
    // A cópia ruim é removida: deixá-la na pasta faria alguém restaurar dela
    // depois, acreditando que era boa.
    rmSync(caminho, { force: true });
    throw new BackupFalhouError(
      'a cópia gerada não passou na verificação de integridade e foi descartada',
    );
  }

  const apagados = podar(destino, manter);
  log?.info('backup concluído', {
    arquivo: basename(caminho),
    bytes,
    contas: contasNaOrigem,
    // Os NOMES, não só a contagem. "apagados: 1" não deixa ninguém descobrir
    // depois qual cópia sumiu — e é exatamente na restauração que a pergunta
    // aparece.
    apagados,
  });

  return { caminho, bytes, integro, apagados };
}

/**
 * Abre a cópia e verifica que ela serve.
 *
 * Duas checagens, porque falham por motivos diferentes: `integrity_check` pega
 * arquivo corrompido ou truncado; a contagem de contas pega arquivo
 * estruturalmente válido e vazio — que é o que acontece quando o `VACUUM INTO`
 * roda contra um banco recém-criado por engano.
 */
function conferirCopia(caminho: string, contasEsperadas: number): boolean {
  let copia: DatabaseSync | undefined;
  try {
    copia = new DatabaseSync(caminho, { readOnly: true });
    const r = copia.prepare('PRAGMA integrity_check').get() as unknown as {
      integrity_check: string;
    };
    if (r.integrity_check !== 'ok') return false;
    return contarContas(copia) === contasEsperadas;
  } catch {
    return false;
  } finally {
    copia?.close();
  }
}

function contarContas(db: DatabaseSync): number {
  try {
    const r = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get() as unknown as {
      n: number;
    };
    return Number(r.n);
  } catch {
    // Banco anterior às contas não tem a tabela. Não é falha de backup.
    return 0;
  }
}

/**
 * O nome que ESTE código gera, e nenhum outro.
 *
 * O padrão é estreito de propósito. Antes bastava começar com `processovivo-` e
 * terminar em `.db`, e isso apagava arquivos que não eram nossos: uma cópia
 * manual guardada como `processovivo-antes-da-migracao.db` casava, ordenava antes
 * das automáticas e sumia na poda seguinte — em silêncio, e justamente a cópia
 * que alguém achou importante o bastante para salvar à mão.
 *
 * A poda só apaga o que a poda mesma criou. Qualquer outro nome na pasta é de
 * outra pessoa e fica onde está.
 *
 * O prefixo `lexflow-` continua reconhecido porque o produto tinha esse nome
 * até a v0.18.0, e as cópias antigas estão no volume de quem já rodava. Sem
 * isso elas nunca mais seriam podadas: a pasta guardaria sete cópias novas MAIS
 * todas as velhas, para sempre, enchendo o disco justamente no volume onde mora
 * o banco.
 */
const NOME_DE_BACKUP =
  /^(?:processovivo|lexflow)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db$/;

/** O dia (UTC, `AAAA-MM-DD`) que o nome do arquivo carrega. */
function diaDoBackup(arquivo: string): string {
  return arquivo.replace(/^[a-z]+-/, '').slice(0, 10);
}

/**
 * Quais cópias sair, mantendo no máximo `manter` (v0.67.3). Pura: só nomes.
 *
 * A retenção é POR DIA, não por contagem. Antes, a poda era "as N últimas": quatro
 * reinícios no mesmo dia geravam quatro cópias de hoje e apagavam quatro DIAS de
 * histórico. Agora uma cópia a mais do mesmo dia nunca tira um dia anterior da
 * lista: enquanto sobrar arquivo, sai primeiro o EXTRA de um dia que tem mais de
 * uma cópia (o mais antigo deles; a última cópia de cada dia fica), e só quando
 * cada dia tem uma cópia só é que sai o dia mais antigo.
 */
export function escolherBackupsParaApagar(
  arquivos: readonly string[],
  manter: number,
): string[] {
  if (manter <= 0) return [];
  const ordenadas = [...arquivos].sort(
    (a, b) =>
      diaDoBackup(a).localeCompare(diaDoBackup(b)) ||
      a.slice(-23).localeCompare(b.slice(-23)),
  );
  const ultimaDoDia = new Map<string, string>();
  for (const f of ordenadas) ultimaDoDia.set(diaDoBackup(f), f);
  const extras = ordenadas.filter((f) => ultimaDoDia.get(diaDoBackup(f)) !== f);
  const diarias = ordenadas.filter((f) => ultimaDoDia.get(diaDoBackup(f)) === f);

  const apagar: string[] = [];
  let sobra = ordenadas.length - manter;
  for (const f of [...extras, ...diarias]) {
    if (sobra <= 0) break;
    apagar.push(f);
    sobra--;
  }
  return apagar.sort();
}

/** Apaga o que `escolherBackupsParaApagar` indicar. */
function podar(destino: string, manter: number): string[] {
  const copias = readdirSync(destino).filter((f) => NOME_DE_BACKUP.test(f));
  const sobrando = escolherBackupsParaApagar(copias, manter);
  for (const f of sobrando) rmSync(join(destino, f), { force: true });
  return sobrando;
}

/** A pasta padrão das cópias: `backups/` ao lado do banco. */
export function pastaDeBackups(caminhoBanco: string): string {
  return join(dirname(caminhoBanco), 'backups');
}

/**
 * O instante da cópia mais recente, lido do NOME do arquivo (v0.67.3).
 *
 * Do nome e não do `mtime`: restaurar ou copiar a pasta muda a data do arquivo,
 * e o nome é o instante em que a cópia foi tirada. `undefined` sem cópia nenhuma.
 */
export function ultimoBackupEm(destino: string): Date | undefined {
  let nomes: string[];
  try {
    nomes = readdirSync(destino);
  } catch {
    return undefined;
  }
  const marcas = nomes
    .filter((f) => NOME_DE_BACKUP.test(f))
    .map((f) => f.slice(-23, -3))
    .sort();
  const ultima = marcas[marcas.length - 1];
  if (!ultima) return undefined;
  // `2026-11-12T11-15-00Z` → `2026-11-12T11:15:00Z`
  const iso = `${ultima.slice(0, 13)}:${ultima.slice(14, 16)}:${ultima.slice(17)}`;
  const quando = new Date(iso);
  return Number.isNaN(quando.getTime()) ? undefined : quando;
}

/** As cópias existentes, da mais nova para a mais antiga. */
export function listarBackups(destino: string): Array<{
  readonly arquivo: string;
  readonly bytes: number;
  readonly em: Date;
}> {
  let nomes: string[];
  try {
    nomes = readdirSync(destino);
  } catch {
    return [];
  }
  return nomes
    .filter((f) => NOME_DE_BACKUP.test(f))
    .sort()
    .reverse()
    .map((arquivo) => {
      const s = statSync(join(destino, arquivo));
      return { arquivo, bytes: s.size, em: s.mtime };
    });
}
