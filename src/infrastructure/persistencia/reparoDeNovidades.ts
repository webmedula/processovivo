import type { DatabaseSync } from 'node:sqlite';

/**
 * Reparo das novidades que a "avalanche" despejou (v0.37.5).
 *
 * O defeito já está corrigido em `detectarNovidades`; isto cuida do que ele
 * deixou no banco: o histórico inteiro de um processo recém-completado, gravado
 * como novidade "não lida" e "detectada há 2 dias". É uma FERRAMENTA DO OPERADOR
 * (CLI), nunca roda sozinha, e o que ela faz com o que acha é o mínimo:
 *
 *  - `--dry-run` é o padrão: só conta;
 *  - com `--aplicar` apenas MARCA COMO LIDAS (`vista_em`) — nunca apaga;
 *  - guarda os `id` que tocou num arquivo, para `--desfazer` devolver ao estado
 *    anterior (só o que ainda tem a marca que ela pôs: leitura feita depois,
 *    à mão, não é desfeita);
 *  - a saída traz só CONTAGENS por workspace (numerado, sem o identificador) —
 *    nenhum número de processo, nenhum título de ato.
 *
 * Como reconhece uma avalanche: o `registrarSincronizacao` grava todas as
 * novidades de uma sincronização no MESMO instante (`detectada_em`), então um
 * lote grande de um processo, em que quase tudo é de muito antes de o sistema
 * ter percebido, é a assinatura do despejo. O limiar é conservador de
 * propósito — melhor deixar uma avalanche pequena como está do que marcar
 * como lida uma novidade de verdade — e SÓ os atos antigos do lote entram: um
 * ato recente no meio dele continua não lido.
 */
export interface CriteriosDaAvalanche {
  /** Quantas novidades, no mesmo instante e processo, já fazem desconfiar. */
  readonly tamanhoMinimoDoLote: number;
  /** Quantos dias antes da detecção o ato tem de ser para contar como "antigo". */
  readonly diasDeAtraso: number;
  /** Fração mínima do lote que tem de ser de atos antigos. */
  readonly fracaoDeAntigos: number;
}

export const CRITERIOS_PADRAO: CriteriosDaAvalanche = {
  tamanhoMinimoDoLote: 20,
  diasDeAtraso: 30,
  fracaoDeAntigos: 0.8,
};

export interface AvalanchePorWorkspace {
  /** 1, 2, 3… na ordem do banco: o identificador do workspace não sai daqui. */
  readonly ordem: number;
  readonly lotes: number;
  /** Novidades NÃO LIDAS e antigas dentro dos lotes suspeitos — o que o `--aplicar` marcaria. */
  readonly naoLidas: number;
  /** Todas as novidades dos lotes suspeitos, lidas ou não (contexto). */
  readonly noTotal: number;
}

export interface DiagnosticoDaAvalanche {
  readonly workspaces: readonly AvalanchePorWorkspace[];
  readonly totalNaoLidas: number;
  /** Os `id` das novidades que seriam marcadas; só vai para o arquivo de desfazer. */
  readonly ids: readonly number[];
}

interface LinhaDeLote {
  readonly workspace: string;
  readonly numero: string;
  readonly detectada_em: string;
  readonly total: number;
  readonly antigas: number;
}

/** Conta (sem alterar nada) as novidades que parecem avalanche. */
export function diagnosticarAvalanche(
  db: DatabaseSync,
  criterios: CriteriosDaAvalanche = CRITERIOS_PADRAO,
): DiagnosticoDaAvalanche {
  // `julianday` compara os instantes ISO sem depender de relógio nosso.
  const lotes = db
    .prepare(
      `SELECT workspace, numero, detectada_em,
              COUNT(*) AS total,
              SUM(CASE WHEN julianday(detectada_em) - julianday(data) >= ?
                       THEN 1 ELSE 0 END) AS antigas
         FROM novidades
        GROUP BY workspace, numero, detectada_em
       HAVING COUNT(*) >= ?`,
    )
    .all(
      criterios.diasDeAtraso,
      criterios.tamanhoMinimoDoLote,
    ) as unknown as LinhaDeLote[];

  const suspeitos = lotes.filter(
    (l) => Number(l.antigas) / Number(l.total) >= criterios.fracaoDeAntigos,
  );

  const porWorkspace = new Map<string, { lotes: number; noTotal: number }>();
  const ids: number[] = [];
  const naoLidasPorWorkspace = new Map<string, number>();

  const candidatas = db.prepare(
    `SELECT id FROM novidades
      WHERE workspace = ? AND numero = ? AND detectada_em = ?
        AND vista_em IS NULL
        AND julianday(detectada_em) - julianday(data) >= ?`,
  );

  for (const l of suspeitos) {
    const acc = porWorkspace.get(l.workspace) ?? { lotes: 0, noTotal: 0 };
    acc.lotes += 1;
    acc.noTotal += Number(l.total);
    porWorkspace.set(l.workspace, acc);

    const linhas = candidatas.all(
      l.workspace,
      l.numero,
      l.detectada_em,
      criterios.diasDeAtraso,
    ) as unknown as Array<{ id: number }>;
    for (const { id } of linhas) ids.push(Number(id));
    naoLidasPorWorkspace.set(
      l.workspace,
      (naoLidasPorWorkspace.get(l.workspace) ?? 0) + linhas.length,
    );
  }

  const workspaces = [...porWorkspace.entries()].map(([workspace, v], i) => ({
    ordem: i + 1,
    lotes: v.lotes,
    naoLidas: naoLidasPorWorkspace.get(workspace) ?? 0,
    noTotal: v.noTotal,
  }));

  return {
    workspaces,
    totalNaoLidas: ids.length,
    ids,
  };
}

export interface RegistroDoReparo {
  readonly aplicadoEm: string;
  readonly ids: readonly number[];
}

/**
 * Marca como lidas as novidades do diagnóstico. Não apaga nada. Devolve o
 * registro para o arquivo de desfazer.
 */
export function aplicarReparo(
  db: DatabaseSync,
  diagnostico: DiagnosticoDaAvalanche,
  agora: Date,
): RegistroDoReparo {
  const aplicadoEm = agora.toISOString();
  const marcar = db.prepare(
    'UPDATE novidades SET vista_em = ? WHERE id = ? AND vista_em IS NULL',
  );
  const tocadas: number[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of diagnostico.ids) {
      const r = marcar.run(aplicadoEm, id);
      if (Number(r.changes) > 0) tocadas.push(id);
    }
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
  return { aplicadoEm, ids: tocadas };
}

/** Devolve a "não lida" só às que ainda carregam a marca que o reparo pôs. */
export function desfazerReparo(db: DatabaseSync, registro: RegistroDoReparo): number {
  const desfazer = db.prepare(
    'UPDATE novidades SET vista_em = NULL WHERE id = ? AND vista_em = ?',
  );
  let desfeitas = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of registro.ids) {
      desfeitas += Number(desfazer.run(id, registro.aplicadoEm).changes);
    }
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
  return desfeitas;
}
