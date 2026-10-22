import type { DatabaseSync } from 'node:sqlite';
import {
  AVALIACOES_DA_ANALISE,
  type AvaliacaoDaAnalise,
  type MotivoDaAvaliacao,
} from '../../../domain/entities/AnaliseDoAto.js';
import type {
  AnaliseDePeca,
  ContagensDaAnaliseDePeca,
  ResultadoDaAnaliseDePeca,
} from '../../../domain/entities/AnaliseDePeca.js';
import type { RepositorioAnalisesDePeca } from '../../../domain/ports/RepositorioAnalisesDePeca.js';

interface Linha {
  id: string;
  workspace: string;
  processo_chave: string;
  peca_id: string;
  hash_bytes: string;
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
 * Análises de peça (v0.55.0). Guarda o resultado COM MARCADORES e citações curtas — o `resultado` é o
 * JSON do que passou na verificação, nada mais; o texto da peça nunca chega aqui. Toda consulta filtra
 * por `workspace`, e o que venceu não é devolvido nem pelo reaproveitamento nem pela leitura.
 */
export class RepositorioAnalisesDePecaSqlite implements RepositorioAnalisesDePeca {
  constructor(private readonly db: DatabaseSync) {}

  async salvar(a: AnaliseDePeca): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO analises_pecas_ia
           (id, workspace, processo_chave, peca_id, hash_bytes, resultado, contagens, modelo,
            modelo_pedido, versao_prompt, provedor, tokens_entrada, tokens_saida, custo_usd,
            latencia_ms, criada_em, expira_em, avaliacao, motivo_avaliacao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.workspace,
        a.processoChave,
        a.pecaId,
        a.hashDosBytes,
        JSON.stringify(a.resultado),
        JSON.stringify(a.contagens),
        a.procedencia.modelo,
        a.modeloPedido,
        a.procedencia.versaoPrompt,
        a.procedencia.provedor,
        a.medidas.tokensEntrada ?? null,
        a.medidas.tokensSaida ?? null,
        a.medidas.custoUsd ?? null,
        a.medidas.latenciaMs,
        a.criadaEm.toISOString(),
        a.expiraEm.toISOString(),
        a.avaliacao ?? null,
        a.motivoDaAvaliacao ?? null,
      );
  }

  async buscar(workspace: string, id: string): Promise<AnaliseDePeca | undefined> {
    const l = this.db
      .prepare('SELECT * FROM analises_pecas_ia WHERE workspace = ? AND id = ?')
      .get(workspace, id) as unknown as Linha | undefined;
    return l ? paraAnalise(l) : undefined;
  }

  async buscarReaproveitavel(
    workspace: string,
    chave: {
      readonly processoChave: string;
      readonly pecaId: string;
      readonly hashDosBytes: string;
      readonly versaoPrompt: string;
      readonly modeloPedido: string;
    },
    agora: Date,
  ): Promise<AnaliseDePeca | undefined> {
    // Só resultado VERIFICADO é reaproveitado: um "não verificado" merece outra tentativa.
    const l = this.db
      .prepare(
        `SELECT * FROM analises_pecas_ia
          WHERE workspace = ? AND processo_chave = ? AND peca_id = ? AND hash_bytes = ?
            AND versao_prompt = ? AND modelo_pedido = ? AND expira_em > ?
            AND resultado LIKE '{"estado":"verificada"%'
          ORDER BY criada_em DESC LIMIT 1`,
      )
      .get(
        workspace,
        chave.processoChave,
        chave.pecaId,
        chave.hashDosBytes,
        chave.versaoPrompt,
        chave.modeloPedido,
        agora.toISOString(),
      ) as unknown as Linha | undefined;
    return l ? paraAnalise(l) : undefined;
  }

  async avaliar(
    workspace: string,
    id: string,
    avaliacao: AvaliacaoDaAnalise,
    motivo?: MotivoDaAvaliacao,
  ): Promise<boolean> {
    // O motivo só acompanha "errado" e "perigoso"; avaliar de novo (inclusive como "útil") o apaga ou troca.
    const guardado = avaliacao === 'util' ? null : (motivo ?? null);
    const r = this.db
      .prepare(
        'UPDATE analises_pecas_ia SET avaliacao = ?, motivo_avaliacao = ? WHERE workspace = ? AND id = ?',
      )
      .run(avaliacao, guardado, workspace, id);
    return Number(r.changes) > 0;
  }

  async apagarVencidas(agora: Date): Promise<number> {
    const r = this.db
      .prepare('DELETE FROM analises_pecas_ia WHERE expira_em <= ?')
      .run(agora.toISOString());
    return Number(r.changes);
  }

  async apagarDoWorkspace(workspace: string): Promise<number> {
    const r = this.db
      .prepare('DELETE FROM analises_pecas_ia WHERE workspace = ?')
      .run(workspace);
    return Number(r.changes);
  }
}

function paraAnalise(l: Linha): AnaliseDePeca {
  return {
    id: l.id,
    workspace: l.workspace,
    processoChave: l.processo_chave,
    pecaId: l.peca_id,
    hashDosBytes: l.hash_bytes,
    resultado: JSON.parse(l.resultado) as ResultadoDaAnaliseDePeca,
    contagens: JSON.parse(l.contagens) as ContagensDaAnaliseDePeca,
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
    ...(l.avaliacao !== null && ehAvaliacao(l.avaliacao) ? { avaliacao: l.avaliacao } : {}),
  };
}

function ehAvaliacao(v: string): v is AvaliacaoDaAnalise {
  return (AVALIACOES_DA_ANALISE as readonly string[]).includes(v);
}
