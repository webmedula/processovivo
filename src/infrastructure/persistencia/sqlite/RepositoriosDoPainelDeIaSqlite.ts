import type { DatabaseSync } from 'node:sqlite';
import {
  CONFIG_PADRAO_DO_PAINEL,
  FUNCOES_DE_IA,
  alertaValido,
  diaDeSaoPaulo,
  tetoValido,
  type ConfigDoPainel,
  type FuncaoDeIa,
} from '../../../domain/entities/ControleDaIa.js';
import {
  MOTIVOS_DE_OCORRENCIA_DA_IA,
  type AlertaDeCustoGravado,
  type AlteracaoDeConfigDeIa,
  type LeitorDeUsoDeIa,
  type LinhaDeUsoDeIa,
  type MotivoDeOcorrenciaDaIa,
  type OcorrenciaAgregada,
  type RegistroDeOcorrenciasDeIa,
  type RepositorioDeConfigDeIa,
  type RepositorioDoAlertaDeCusto,
  type TipoDeAlteracao,
} from '../../../domain/ports/PainelDeIa.js';
import type { Clock } from '../../../domain/ports/Clock.js';
import type { Logger } from '../../../domain/ports/Logger.js';

interface LinhaDeConfig {
  chave: string;
  ligada: number | null;
  teto_dia_conta: number | null;
  teto_dia_global: number | null;
  alerta_custo_dia_usd: number | null;
}

/**
 * Configuração do painel de IA. Valor corrompido na linha (teto fora da faixa, alerta absurdo) é
 * IGNORADO e vale o padrão: o painel nunca pode transformar uma linha torta em IA fora do ar.
 */
export class RepositorioDeConfigDeIaSqlite implements RepositorioDeConfigDeIa {
  constructor(private readonly db: DatabaseSync) {}

  ler(): ConfigDoPainel {
    const linhas = this.db
      .prepare(
        'SELECT chave, ligada, teto_dia_conta, teto_dia_global, alerta_custo_dia_usd FROM ia_config',
      )
      .all() as unknown as LinhaDeConfig[];
    const porChave = new Map(linhas.map((l) => [l.chave, l]));
    const funcao = (f: FuncaoDeIa): ConfigDoPainel['funcoes'][FuncaoDeIa] => {
      const l = porChave.get(f);
      const padrao = CONFIG_PADRAO_DO_PAINEL.funcoes[f];
      if (!l) return padrao;
      return {
        ligada: l.ligada === null ? padrao.ligada : l.ligada !== 0,
        tetoPorConta: tetoValido(l.teto_dia_conta) ? l.teto_dia_conta : null,
      };
    };
    const g = porChave.get('global');
    return {
      funcoes: { ato: funcao('ato'), resumo: funcao('resumo'), peca: funcao('peca') },
      tetoGlobal: g && tetoValido(g.teto_dia_global) ? g.teto_dia_global : null,
      alertaCustoDiaUsd:
        g && alertaValido(g.alerta_custo_dia_usd)
          ? g.alerta_custo_dia_usd
          : CONFIG_PADRAO_DO_PAINEL.alertaCustoDiaUsd,
    };
  }

  gravar(config: ConfigDoPainel, a: AlteracaoDeConfigDeIa, agora: Date): void {
    const em = agora.toISOString();
    this.db.exec('BEGIN');
    try {
      const upsert = this.db.prepare(
        `INSERT INTO ia_config (chave, ligada, teto_dia_conta, teto_dia_global, alerta_custo_dia_usd, atualizado_em)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chave) DO UPDATE SET
           ligada = excluded.ligada,
           teto_dia_conta = excluded.teto_dia_conta,
           teto_dia_global = excluded.teto_dia_global,
           alerta_custo_dia_usd = excluded.alerta_custo_dia_usd,
           atualizado_em = excluded.atualizado_em`,
      );
      for (const f of FUNCOES_DE_IA) {
        const c = config.funcoes[f];
        upsert.run(f, c.ligada ? 1 : 0, c.tetoPorConta, null, null, em);
      }
      upsert.run('global', null, null, config.tetoGlobal, config.alertaCustoDiaUsd, em);
      this.db
        .prepare(
          `INSERT INTO ia_alteracoes (em, autor, funcao, tipo, valor_anterior, valor_novo)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(em, a.autor, a.funcao, a.tipo, a.anterior, a.novo);
      this.db.exec('COMMIT');
    } catch (erro) {
      this.db.exec('ROLLBACK');
      throw erro;
    }
  }

  alteracoes(limite: number): AlteracaoDeConfigDeIa[] {
    const linhas = this.db
      .prepare(
        `SELECT id, em, autor, funcao, tipo, valor_anterior, valor_novo
           FROM ia_alteracoes ORDER BY id DESC LIMIT ?`,
      )
      .all(limite) as unknown as Array<{
      id: number;
      em: string;
      autor: string;
      funcao: string;
      tipo: string;
      valor_anterior: string;
      valor_novo: string;
    }>;
    return linhas.map((l) => ({
      id: l.id,
      em: new Date(l.em),
      autor: l.autor,
      funcao: l.funcao as AlteracaoDeConfigDeIa['funcao'],
      tipo: l.tipo as TipoDeAlteracao,
      anterior: l.valor_anterior,
      novo: l.valor_novo,
    }));
  }
}

/** Contagem de falhas de verificação e repetições, por dia de São Paulo, função e motivo. */
export class RegistroDeOcorrenciasDeIaSqlite
  implements RegistroDeOcorrenciasDeIa, Pick<LeitorDeUsoDeIa, 'ocorrencias'>
{
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  registrar(funcao: FuncaoDeIa, motivo: MotivoDeOcorrenciaDaIa, quantidade = 1): void {
    if (quantidade <= 0) return;
    try {
      this.db
        .prepare(
          `INSERT INTO ia_ocorrencias_dia (dia, funcao, motivo, contagem) VALUES (?, ?, ?, ?)
           ON CONFLICT(dia, funcao, motivo) DO UPDATE SET contagem = contagem + excluded.contagem`,
        )
        .run(diaDeSaoPaulo(this.clock.agora()), funcao, motivo, quantidade);
    } catch {
      // Contar não pode derrubar a análise. Sem a causa no log: só o fato.
      this.logger.warn('ocorrência de IA não registrada');
    }
  }

  ocorrencias(desdeDia: string): OcorrenciaAgregada[] {
    const linhas = this.db
      .prepare(
        `SELECT funcao, motivo, SUM(contagem) AS contagem FROM ia_ocorrencias_dia
          WHERE dia >= ? GROUP BY funcao, motivo`,
      )
      .all(desdeDia) as unknown as Array<{
      funcao: string;
      motivo: string;
      contagem: number;
    }>;
    return linhas
      .filter(
        (l) =>
          (FUNCOES_DE_IA as readonly string[]).includes(l.funcao) &&
          (MOTIVOS_DE_OCORRENCIA_DA_IA as readonly string[]).includes(l.motivo),
      )
      .map((l) => ({
        funcao: l.funcao as FuncaoDeIa,
        motivo: l.motivo as MotivoDeOcorrenciaDaIa,
        contagem: Number(l.contagem),
      }));
  }
}

const TABELA_DA_FUNCAO: Readonly<Record<FuncaoDeIa, { tabela: string; ruim: string }>> = {
  ato: { tabela: 'analises_ia', ruim: 'nao_verificada' },
  resumo: { tabela: 'resumos_ia', ruim: 'nao_verificado' },
  peca: { tabela: 'analises_pecas_ia', ruim: 'nao_verificada' },
};

/**
 * Lê o uso das três tabelas SEM tocar no `resultado` além do campo `estado`: nunca o conteúdo da
 * análise, o número do processo, o texto ou a chave do ato. O workspace sai só para o ranking de contas
 * (o serviço o encurta antes de mostrar).
 */
export class LeitorDeUsoDeIaSqlite implements LeitorDeUsoDeIa {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ocorrenciasDoDia: Pick<LeitorDeUsoDeIa, 'ocorrencias'>,
  ) {}

  linhas(funcao: FuncaoDeIa, desde: Date): LinhaDeUsoDeIa[] {
    const { tabela, ruim } = TABELA_DA_FUNCAO[funcao];
    const comMotivo = this.temColuna(tabela, 'motivo_avaliacao');
    const linhas = this.db
      .prepare(
        `SELECT workspace, modelo, versao_prompt, avaliacao, latencia_ms, custo_usd,
                tokens_entrada, tokens_saida,
                ${comMotivo ? 'motivo_avaliacao' : 'NULL AS motivo_avaliacao'},
                CASE WHEN json_extract(resultado, '$.estado') = '${ruim}' THEN 1 ELSE 0 END AS nao_verificada
           FROM ${tabela} WHERE criada_em >= ?`,
      )
      .all(desde.toISOString()) as unknown as Array<{
      workspace: string;
      modelo: string;
      versao_prompt: string;
      avaliacao: string | null;
      motivo_avaliacao: string | null;
      latencia_ms: number;
      custo_usd: number | null;
      tokens_entrada: number | null;
      tokens_saida: number | null;
      nao_verificada: number;
    }>;
    return linhas.map((l) => ({
      workspace: l.workspace,
      modelo: l.modelo,
      versaoPrompt: l.versao_prompt,
      avaliacao: l.avaliacao,
      motivoAvaliacao: l.motivo_avaliacao,
      naoVerificada: Number(l.nao_verificada) === 1,
      latenciaMs: Number(l.latencia_ms),
      custoUsd: l.custo_usd === null ? null : Number(l.custo_usd),
      tokensEntrada: l.tokens_entrada === null ? null : Number(l.tokens_entrada),
      tokensSaida: l.tokens_saida === null ? null : Number(l.tokens_saida),
    }));
  }

  custoDesde(desde: Date): number {
    let total = 0;
    for (const f of FUNCOES_DE_IA) {
      const { tabela } = TABELA_DA_FUNCAO[f];
      const r = this.db
        .prepare(
          `SELECT COALESCE(SUM(custo_usd), 0) AS total FROM ${tabela} WHERE criada_em >= ?`,
        )
        .get(desde.toISOString()) as unknown as { total: number };
      total += Number(r.total);
    }
    return total;
  }

  ocorrencias(desdeDia: string): OcorrenciaAgregada[] {
    return this.ocorrenciasDoDia.ocorrencias(desdeDia);
  }

  private temColuna(tabela: string, coluna: string): boolean {
    const colunas = this.db.prepare(`PRAGMA table_info(${tabela})`).all() as Array<{
      name: string;
    }>;
    return colunas.some((c) => c.name === coluna);
  }
}

export class RepositorioDoAlertaDeCustoSqlite implements RepositorioDoAlertaDeCusto {
  constructor(private readonly db: DatabaseSync) {}

  buscar(dia: string): AlertaDeCustoGravado | undefined {
    const l = this.db
      .prepare(
        'SELECT dia, valor_usd, limite_usd, tentativas, enviado_em FROM ia_alertas_custo WHERE dia = ?',
      )
      .get(dia) as unknown as
      | {
          dia: string;
          valor_usd: number;
          limite_usd: number;
          tentativas: number;
          enviado_em: string | null;
        }
      | undefined;
    if (!l) return undefined;
    return {
      dia: l.dia,
      valorUsd: Number(l.valor_usd),
      limiteUsd: Number(l.limite_usd),
      tentativas: Number(l.tentativas),
      enviadoEm: l.enviado_em ? new Date(l.enviado_em) : undefined,
    };
  }

  registrarTentativa(dia: string, valorUsd: number, limiteUsd: number): number {
    this.db
      .prepare(
        `INSERT INTO ia_alertas_custo (dia, valor_usd, limite_usd, tentativas) VALUES (?, ?, ?, 1)
         ON CONFLICT(dia) DO UPDATE SET tentativas = tentativas + 1,
           valor_usd = excluded.valor_usd, limite_usd = excluded.limite_usd`,
      )
      .run(dia, valorUsd, limiteUsd);
    return this.buscar(dia)?.tentativas ?? 1;
  }

  marcarEnviado(dia: string, em: Date): void {
    this.db
      .prepare('UPDATE ia_alertas_custo SET enviado_em = ? WHERE dia = ?')
      .run(em.toISOString(), dia);
  }
}
