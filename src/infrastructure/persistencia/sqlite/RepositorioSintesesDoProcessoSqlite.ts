import type { DatabaseSync } from 'node:sqlite';
import {
  AVALIACOES_DA_ANALISE,
  MOTIVOS_DA_AVALIACAO,
  type AvaliacaoDaAnalise,
  type MotivoDaAvaliacao,
} from '../../../domain/entities/AnaliseDoAto.js';
import type {
  ContagensDaSintese,
  ResultadoDaSintese,
  SinteseDoProcesso,
} from '../../../domain/entities/AnaliseDoProcesso.js';
import type { RepositorioSintesesDoProcesso } from '../../../domain/ports/RepositorioSintesesDoProcesso.js';

interface Linha {
  id: string;
  workspace: string;
  processo_chave: string;
  chave_selecao: string;
  analises: string;
  resultado: string;
  contagens: string;
  modelo: string;
  modelo_pedido: string;
  versao_prompt: string;
  provedor: string;
  tokens_entrada: number | null;
  tokens_saida: number | null;
  custo_usd: number | null;
  latencia_ms: number;
  criada_em: string;
  expira_em: string;
  avaliacao: string | null;
  motivo_avaliacao: string | null;
}

/**
 * Sínteses do processo (v0.66.0). Guarda o resultado COM MARCADORES e identificadores de item — o texto
 * das peças nunca chega aqui. Toda consulta filtra por `workspace`; o que venceu não volta.
 */
export class RepositorioSintesesDoProcessoSqlite implements RepositorioSintesesDoProcesso {
  constructor(private readonly db: DatabaseSync) {}

  async salvar(s: SinteseDoProcesso): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sinteses_processo_ia
           (id, workspace, processo_chave, chave_selecao, analises, resultado, contagens, modelo,
            modelo_pedido, versao_prompt, provedor, tokens_entrada, tokens_saida, custo_usd,
            latencia_ms, criada_em, expira_em, avaliacao, motivo_avaliacao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.workspace,
        s.processoChave,
        s.chaveDaSelecao,
        JSON.stringify(s.analises),
        JSON.stringify(s.resultado),
        JSON.stringify(s.contagens),
        s.procedencia.modelo,
        s.modeloPedido,
        s.procedencia.versaoPrompt,
        s.procedencia.provedor,
        s.medidas.tokensEntrada ?? null,
        s.medidas.tokensSaida ?? null,
        s.medidas.custoUsd ?? null,
        s.medidas.latenciaMs,
        s.criadaEm.toISOString(),
        s.expiraEm.toISOString(),
        s.avaliacao ?? null,
        s.motivoDaAvaliacao ?? null,
      );
  }

  async buscarReaproveitavel(
    workspace: string,
    chaveDaSelecao: string,
    agora: Date,
  ): Promise<SinteseDoProcesso | undefined> {
    // Só resultado VERIFICADO é reaproveitado: um "não verificado" merece outra tentativa.
    const l = this.db
      .prepare(
        `SELECT * FROM sinteses_processo_ia
          WHERE workspace = ? AND chave_selecao = ? AND expira_em > ?
            AND resultado LIKE '{"estado":"verificada"%'
          ORDER BY criada_em DESC LIMIT 1`,
      )
      .get(workspace, chaveDaSelecao, agora.toISOString()) as unknown as Linha | undefined;
    return l ? paraSintese(l) : undefined;
  }

  async avaliar(
    workspace: string,
    id: string,
    avaliacao: AvaliacaoDaAnalise,
    motivo?: MotivoDaAvaliacao,
  ): Promise<boolean> {
    const guardado = avaliacao === 'util' ? null : (motivo ?? null);
    const r = this.db
      .prepare(
        'UPDATE sinteses_processo_ia SET avaliacao = ?, motivo_avaliacao = ? WHERE workspace = ? AND id = ?',
      )
      .run(avaliacao, guardado, workspace, id);
    return Number(r.changes) > 0;
  }

  async apagarVencidas(agora: Date): Promise<number> {
    const r = this.db
      .prepare('DELETE FROM sinteses_processo_ia WHERE expira_em <= ?')
      .run(agora.toISOString());
    return Number(r.changes);
  }

  async apagarDoWorkspace(workspace: string): Promise<number> {
    const r = this.db
      .prepare('DELETE FROM sinteses_processo_ia WHERE workspace = ?')
      .run(workspace);
    return Number(r.changes);
  }
}

function paraSintese(l: Linha): SinteseDoProcesso {
  return {
    id: l.id,
    workspace: l.workspace,
    processoChave: l.processo_chave,
    chaveDaSelecao: l.chave_selecao,
    analises: JSON.parse(l.analises) as string[],
    resultado: JSON.parse(l.resultado) as ResultadoDaSintese,
    contagens: JSON.parse(l.contagens) as ContagensDaSintese,
    procedencia: {
      modelo: l.modelo,
      versaoPrompt: l.versao_prompt,
      provedor: l.provedor,
      criadaEm: new Date(l.criada_em),
    },
    modeloPedido: l.modelo_pedido,
    medidas: {
      latenciaMs: Number(l.latencia_ms),
      ...(l.tokens_entrada !== null ? { tokensEntrada: Number(l.tokens_entrada) } : {}),
      ...(l.tokens_saida !== null ? { tokensSaida: Number(l.tokens_saida) } : {}),
      ...(l.custo_usd !== null ? { custoUsd: Number(l.custo_usd) } : {}),
    },
    criadaEm: new Date(l.criada_em),
    expiraEm: new Date(l.expira_em),
    ...(l.avaliacao !== null &&
    (AVALIACOES_DA_ANALISE as readonly string[]).includes(l.avaliacao)
      ? { avaliacao: l.avaliacao as AvaliacaoDaAnalise }
      : {}),
    ...(l.motivo_avaliacao !== null &&
    (MOTIVOS_DA_AVALIACAO as readonly string[]).includes(l.motivo_avaliacao)
      ? { motivoDaAvaliacao: l.motivo_avaliacao as MotivoDaAvaliacao }
      : {}),
  };
}
