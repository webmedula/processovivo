import { abrirSomenteLeitura } from '../../infrastructure/persistencia/diagnosticoDeProvidencia.js';
import { PESO_DA_PECA_NO_TETO } from '../../application/politicas/entradaDaPeca.js';

/**
 * Uso da análise de PEÇA por conta (`scripts/ia-pecas-uso.mjs`, v0.55.0) — SOMENTE LEITURA.
 *
 * Lista, por identificador de workspace, quantas análises de peça cada conta fez: no total vigente,
 * hoje (dia de São Paulo), o peso que isso representa no teto diário, quantas foram avaliadas e o custo
 * onde o gateway informou. **Só contagens e identificadores de conta** (o que o dono precisa para
 * conferir quem está na lista): nunca resultado, trecho, número de processo, nome ou e-mail. O banco
 * abre com `readOnly` + `query_only`, nunca por `abrirBanco`.
 *
 * "Hoje × 5" é uma conta feita sobre o banco: o teto de verdade está em memória do processo e zera ao
 * reiniciar, então esta coluna é um limite superior do que o teto viu hoje, não o valor dele.
 */
export const VERSAO_DO_USO_DE_PECA = '1.0.0';

export const USO_DO_USO_DE_PECA = `Uso: node scripts/ia-pecas-uso.mjs
Mostra, por conta (identificador de workspace), quantas análises de peça vigentes ela fez, quantas hoje (e o peso delas no teto diário), quantas foram avaliadas e o custo. Só contagens.`;

export interface LinhaDeUsoDePeca {
  readonly workspace: string;
  readonly total: number;
  readonly hoje: number;
  readonly avaliadas: number;
  readonly custoUsd: number;
  readonly comCusto: number;
}

export interface DependenciasDoUsoDePeca {
  readonly caminhoBanco: string;
  readonly agora: () => Date;
  readonly saida: (linha: string) => void;
  readonly aviso: (linha: string) => void;
}

const FUSO_DE_SAO_PAULO_MS = -3 * 3_600_000;
const diaDe = (d: Date): string =>
  new Date(d.getTime() + FUSO_DE_SAO_PAULO_MS).toISOString().slice(0, 10);

export function executarUsoDaAnaliseDePeca(
  argv: readonly string[],
  deps: DependenciasDoUsoDePeca,
): number {
  if (argv.includes('--ajuda')) {
    deps.saida(USO_DO_USO_DE_PECA);
    return 0;
  }
  if (argv.length > 0) {
    deps.aviso(`argumento desconhecido: ${argv[0] ?? ''}`);
    deps.aviso(USO_DO_USO_DE_PECA);
    return 2;
  }
  let db;
  try {
    db = abrirSomenteLeitura(deps.caminhoBanco);
  } catch {
    deps.aviso('Não consegui abrir o banco em modo somente leitura (caminho ou permissão).');
    return 1;
  }
  try {
    const existe =
      db
        .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'analises_pecas_ia'")
        .get() !== undefined;
    deps.saida(
      `Uso da análise de peça por IA v${VERSAO_DO_USO_DE_PECA} — somente leitura; só contagens, nenhum texto.`,
    );
    if (!existe) {
      deps.saida('Nenhuma análise de peça registrada ainda.');
      return 0;
    }
    const agora = deps.agora();
    const hoje = diaDe(agora);
    const linhas = db
      .prepare(
        `SELECT workspace, criada_em, avaliacao, custo_usd FROM analises_pecas_ia WHERE expira_em > ?`,
      )
      .all(agora.toISOString()) as unknown as Array<{
      workspace: string;
      criada_em: string;
      avaliacao: string | null;
      custo_usd: number | null;
    }>;
    const porConta = new Map<string, LinhaDeUsoDePeca>();
    for (const l of linhas) {
      const a = porConta.get(l.workspace) ?? {
        workspace: l.workspace,
        total: 0,
        hoje: 0,
        avaliadas: 0,
        custoUsd: 0,
        comCusto: 0,
      };
      porConta.set(l.workspace, {
        ...a,
        total: a.total + 1,
        hoje: a.hoje + (diaDe(new Date(l.criada_em)) === hoje ? 1 : 0),
        avaliadas: a.avaliadas + (l.avaliacao === null ? 0 : 1),
        custoUsd: a.custoUsd + (l.custo_usd === null ? 0 : Number(l.custo_usd)),
        comCusto: a.comCusto + (l.custo_usd === null ? 0 : 1),
      });
    }
    const contas = [...porConta.values()].sort(
      (a, b) => b.total - a.total || a.workspace.localeCompare(b.workspace),
    );
    if (contas.length === 0) {
      deps.saida('Nenhuma análise de peça vigente.');
      return 0;
    }
    deps.saida('');
    for (const c of contas) {
      deps.saida(
        `${c.workspace} · vigentes ${c.total} · hoje ${c.hoje} (peso no teto: até ${c.hoje * PESO_DA_PECA_NO_TETO}) · avaliadas ${c.avaliadas} · custo US$ ${c.custoUsd.toFixed(5)}${c.comCusto < c.total ? ` (informado em ${c.comCusto} de ${c.total})` : ''}`,
      );
    }
    const total = contas.reduce((s, c) => s + c.total, 0);
    deps.saida('');
    deps.saida(`Total: ${total} análise(s) vigente(s) em ${contas.length} conta(s).`);
    return 0;
  } finally {
    db.close();
  }
}
