import type { DatabaseSync } from 'node:sqlite';
import {
  AVALIACOES_DA_ANALISE,
  type AvaliacaoDaAnalise,
} from '../../../domain/entities/AnaliseDoAto.js';
import type {
  AtoEnviadoAoResumo,
  ContagensDoResumo,
  ResultadoDoResumo,
  ResumoDoProcesso,
} from '../../../domain/entities/ResumoDoProcesso.js';
import type { RepositorioResumos } from '../../../domain/ports/RepositorioResumos.js';

interface Linha {
  id: string;
  workspace: string;
  numero: string;
  resultado: string;
  atos_enviados: string;
  contagens: string;
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

export class RepositorioResumosSqlite implements RepositorioResumos {
  constructor(private readonly db: DatabaseSync) {}

  async salvar(r: ResumoDoProcesso): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO resumos_ia
           (id, workspace, numero, resultado, atos_enviados, contagens, modelo, versao_prompt,
            provedor, tokens_entrada, tokens_saida, custo_usd, latencia_ms, criada_em, avaliacao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.workspace,
        r.numero,
        JSON.stringify(r.resultado),
        JSON.stringify(
          r.atosEnviados.map((a) => ({
            chaveDoAto: a.chaveDoAto,
            data: a.data.toISOString(),
            comTexto: a.comTexto,
          })),
        ),
        JSON.stringify(r.contagens),
        r.procedencia.modelo,
        r.procedencia.versaoPrompt,
        r.procedencia.provedor,
        r.medidas.tokensEntrada ?? null,
        r.medidas.tokensSaida ?? null,
        r.medidas.custoUsd ?? null,
        r.medidas.latenciaMs,
        r.procedencia.criadaEm.toISOString(),
        r.avaliacao ?? null,
      );
  }

  async buscar(workspace: string, id: string): Promise<ResumoDoProcesso | undefined> {
    const l = this.db
      .prepare('SELECT * FROM resumos_ia WHERE workspace = ? AND id = ?')
      .get(workspace, id) as unknown as Linha | undefined;
    if (!l) return undefined;
    const atos = JSON.parse(l.atos_enviados) as Array<{
      chaveDoAto: string;
      data: string;
      comTexto: boolean;
    }>;
    return {
      id: l.id,
      workspace: l.workspace,
      numero: l.numero,
      resultado: JSON.parse(l.resultado) as ResultadoDoResumo,
      atosEnviados: atos.map((a): AtoEnviadoAoResumo => ({
        chaveDoAto: a.chaveDoAto,
        data: new Date(a.data),
        comTexto: a.comTexto,
      })),
      contagens: JSON.parse(l.contagens) as ContagensDoResumo,
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
  ): Promise<boolean> {
    const r = this.db
      .prepare('UPDATE resumos_ia SET avaliacao = ? WHERE workspace = ? AND id = ?')
      .run(avaliacao, workspace, id);
    return Number(r.changes) > 0;
  }
}

function ehAvaliacao(v: string): v is AvaliacaoDaAnalise {
  return (AVALIACOES_DA_ANALISE as readonly string[]).includes(v);
}
