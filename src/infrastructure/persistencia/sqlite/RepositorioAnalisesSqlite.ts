import type { DatabaseSync } from 'node:sqlite';
import {
  AVALIACOES_DA_ANALISE,
  type AnaliseDoAto,
  type AvaliacaoDaAnalise,
  type MotivoDaAvaliacao,
  type ResultadoDaAnalise,
} from '../../../domain/entities/AnaliseDoAto.js';
import type { RepositorioAnalises } from '../../../domain/ports/RepositorioAnalises.js';

interface Linha {
  id: string;
  workspace: string;
  numero: string;
  chave_do_ato: string;
  resultado: string;
  modelo: string;
  versao_prompt: string;
  provedor: string;
  tokens_entrada: number | null;
  tokens_saida: number | null;
  custo_usd: number | null;
  latencia_ms: number;
  criada_em: string;
  avaliacao: string | null;
}

export class RepositorioAnalisesSqlite implements RepositorioAnalises {
  constructor(private readonly db: DatabaseSync) {}

  async salvar(a: AnaliseDoAto): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO analises_ia
           (id, workspace, numero, chave_do_ato, resultado, modelo, versao_prompt, provedor,
            tokens_entrada, tokens_saida, custo_usd, latencia_ms, criada_em, avaliacao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.workspace,
        a.numero,
        a.chaveDoAto,
        JSON.stringify(a.resultado),
        a.procedencia.modelo,
        a.procedencia.versaoPrompt,
        a.procedencia.provedor,
        a.medidas.tokensEntrada ?? null,
        a.medidas.tokensSaida ?? null,
        a.medidas.custoUsd ?? null,
        a.medidas.latenciaMs,
        a.procedencia.criadaEm.toISOString(),
        a.avaliacao ?? null,
      );
  }

  async buscar(workspace: string, id: string): Promise<AnaliseDoAto | undefined> {
    const l = this.db
      .prepare('SELECT * FROM analises_ia WHERE workspace = ? AND id = ?')
      .get(workspace, id) as unknown as Linha | undefined;
    if (!l) return undefined;
    return {
      id: l.id,
      workspace: l.workspace,
      numero: l.numero,
      chaveDoAto: l.chave_do_ato,
      resultado: JSON.parse(l.resultado) as ResultadoDaAnalise,
      procedencia: {
        modelo: l.modelo,
        versaoPrompt: l.versao_prompt,
        provedor: l.provedor,
        criadaEm: new Date(l.criada_em),
      },
      medidas: {
        latenciaMs: Number(l.latencia_ms),
        ...(l.tokens_entrada !== null ? { tokensEntrada: Number(l.tokens_entrada) } : {}),
        ...(l.tokens_saida !== null ? { tokensSaida: Number(l.tokens_saida) } : {}),
        ...(l.custo_usd !== null ? { custoUsd: Number(l.custo_usd) } : {}),
      },
      ...(l.avaliacao !== null && ehAvaliacao(l.avaliacao)
        ? { avaliacao: l.avaliacao }
        : {}),
    };
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
        'UPDATE analises_ia SET avaliacao = ?, motivo_avaliacao = ? WHERE workspace = ? AND id = ?',
      )
      .run(avaliacao, guardado, workspace, id);
    return Number(r.changes) > 0;
  }
}

function ehAvaliacao(v: string): v is AvaliacaoDaAnalise {
  return (AVALIACOES_DA_ANALISE as readonly string[]).includes(v);
}
