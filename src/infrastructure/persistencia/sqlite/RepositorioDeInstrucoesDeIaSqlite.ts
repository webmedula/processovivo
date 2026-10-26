import type { DatabaseSync } from 'node:sqlite';
import { FUNCOES_DE_IA, type FuncaoDeIa } from '../../../domain/entities/ControleDaIa.js';
import type {
  EstadoDaInstrucao,
  InstrucaoGravada,
} from '../../../domain/entities/InstrucoesDeIa.js';
import type {
  ErroRecenteDeIa,
  InstrucaoEmProducao,
  LeitorDeErrosDeIa,
  RepositorioDeInstrucoesDeIa,
} from '../../../domain/ports/InstrucoesDeIa.js';
import type { AlteracaoDeConfigDeIa } from '../../../domain/ports/PainelDeIa.js';

interface Linha {
  funcao: string;
  versao: number;
  texto: string;
  autor: string;
  criado_em: string;
  estado: string;
  observacao: string;
  publicado_em: string | null;
  publicado_por: string | null;
}

const ESTADOS: readonly EstadoDaInstrucao[] = ['rascunho', 'publicada', 'substituida'];

function paraGravada(l: Linha): InstrucaoGravada | undefined {
  if (!(FUNCOES_DE_IA as readonly string[]).includes(l.funcao)) return undefined;
  const estado = ESTADOS.find((e) => e === l.estado);
  if (!estado) return undefined;
  const publicadoEm = l.publicado_em ? new Date(l.publicado_em) : undefined;
  return {
    funcao: l.funcao as FuncaoDeIa,
    versao: Number(l.versao),
    texto: l.texto,
    autor: l.autor,
    criadoEm: new Date(l.criado_em),
    estado,
    observacao: l.observacao,
    ...(publicadoEm && !Number.isNaN(publicadoEm.getTime()) ? { publicadoEm } : {}),
    ...(l.publicado_por ? { publicadoPor: l.publicado_por } : {}),
  };
}

/**
 * As instruções de interpretação (Fase C, v0.61.0). A versão em produção mora em `ia_config`
 * (`instrucoes_versao`, `instrucoes_anterior`), junto do liga/desliga e do modelo da Fase A/B: gravar aqui não
 * toca nos tetos nem no modelo, e os `gravar`/`publicar` das outras fases não tocam nas instruções.
 */
export class RepositorioDeInstrucoesDeIaSqlite implements RepositorioDeInstrucoesDeIa {
  constructor(private readonly db: DatabaseSync) {}

  emProducao(funcao: FuncaoDeIa): InstrucaoEmProducao {
    const l = this.db
      .prepare(
        `SELECT c.instrucoes_versao AS versao, c.instrucoes_anterior AS anterior, i.texto AS texto
           FROM ia_config c
           LEFT JOIN ia_instrucoes i ON i.funcao = c.chave AND i.versao = c.instrucoes_versao
          WHERE c.chave = ?`,
      )
      .get(funcao) as unknown as
      | { versao: number | null; anterior: number | null; texto: string | null }
      | undefined;
    const versao = Number(l?.versao ?? 0);
    if (!l || !Number.isInteger(versao) || versao <= 0) {
      return { versao: 0, texto: '', anterior: 0 };
    }
    // Versão apontada e sem texto gravado: linha torta. Lança, e o serviço cai no prompt de sempre.
    if (l.texto === null) throw new Error('instrução publicada sem texto gravado');
    const anterior = Number(l.anterior ?? 0);
    return {
      versao,
      texto: l.texto,
      anterior: Number.isInteger(anterior) && anterior > 0 ? anterior : 0,
    };
  }

  buscar(funcao: FuncaoDeIa, versao: number): InstrucaoGravada | undefined {
    const l = this.db
      .prepare('SELECT * FROM ia_instrucoes WHERE funcao = ? AND versao = ?')
      .get(funcao, versao) as unknown as Linha | undefined;
    return l ? paraGravada(l) : undefined;
  }

  rascunho(funcao: FuncaoDeIa): InstrucaoGravada | undefined {
    const l = this.db
      .prepare("SELECT * FROM ia_instrucoes WHERE funcao = ? AND estado = 'rascunho'")
      .get(funcao) as unknown as Linha | undefined;
    return l ? paraGravada(l) : undefined;
  }

  historico(funcao: FuncaoDeIa, limite: number): InstrucaoGravada[] {
    const linhas = this.db
      .prepare(
        'SELECT * FROM ia_instrucoes WHERE funcao = ? ORDER BY versao DESC LIMIT ?',
      )
      .all(funcao, limite) as unknown as Linha[];
    return linhas.flatMap((l) => {
      const g = paraGravada(l);
      return g ? [g] : [];
    });
  }

  salvarRascunho(
    funcao: FuncaoDeIa,
    texto: string,
    observacao: string,
    autor: string,
    agora: Date,
  ): InstrucaoGravada {
    this.transacao(() => {
      const existente = this.rascunho(funcao);
      if (existente) {
        this.db
          .prepare(
            'UPDATE ia_instrucoes SET texto = ?, observacao = ?, autor = ?, criado_em = ? WHERE funcao = ? AND versao = ?',
          )
          .run(texto, observacao, autor, agora.toISOString(), funcao, existente.versao);
        return;
      }
      const maior = this.db
        .prepare(
          'SELECT COALESCE(MAX(versao), 0) AS maior FROM ia_instrucoes WHERE funcao = ?',
        )
        .get(funcao) as unknown as { maior: number };
      this.db
        .prepare(
          `INSERT INTO ia_instrucoes (funcao, versao, texto, autor, criado_em, estado, observacao)
           VALUES (?, ?, ?, ?, ?, 'rascunho', ?)`,
        )
        .run(
          funcao,
          Number(maior.maior) + 1,
          texto,
          autor,
          agora.toISOString(),
          observacao,
        );
    });
    const salvo = this.rascunho(funcao);
    if (!salvo) throw new Error('rascunho não gravado');
    return salvo;
  }

  publicar(
    funcao: FuncaoDeIa,
    versao: number,
    autor: string,
    agora: Date,
    alteracao: AlteracaoDeConfigDeIa,
  ): void {
    const em = agora.toISOString();
    this.transacao(() => {
      const rascunho = this.rascunho(funcao);
      if (!rascunho || rascunho.versao !== versao) throw new Error('rascunho mudou');
      const atual = this.emProducao(funcao);
      if (atual.versao > 0) {
        this.db
          .prepare(
            "UPDATE ia_instrucoes SET estado = 'substituida' WHERE funcao = ? AND versao = ?",
          )
          .run(funcao, atual.versao);
      }
      this.db
        .prepare(
          `UPDATE ia_instrucoes SET estado = 'publicada', publicado_em = ?, publicado_por = ?
            WHERE funcao = ? AND versao = ?`,
        )
        .run(em, autor, funcao, versao);
      this.db
        .prepare(
          `INSERT INTO ia_config (chave, instrucoes_versao, instrucoes_anterior, atualizado_em)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(chave) DO UPDATE SET
             instrucoes_versao = excluded.instrucoes_versao,
             instrucoes_anterior = excluded.instrucoes_anterior,
             atualizado_em = excluded.atualizado_em`,
        )
        .run(funcao, versao, atual.versao > 0 ? atual.versao : null, em);
      this.registrar(alteracao, em);
    });
  }

  reverter(
    funcao: FuncaoDeIa,
    autor: string,
    agora: Date,
    alteracao: (de: number, para: number) => AlteracaoDeConfigDeIa,
  ): { readonly de: number; readonly para: number } | undefined {
    const em = agora.toISOString();
    let resultado: { de: number; para: number } | undefined;
    this.transacao(() => {
      const atual = this.emProducao(funcao);
      if (atual.versao <= 0) return;
      const para = atual.anterior;
      this.db
        .prepare(
          "UPDATE ia_instrucoes SET estado = 'substituida' WHERE funcao = ? AND versao = ?",
        )
        .run(funcao, atual.versao);
      if (para > 0) {
        this.db
          .prepare(
            `UPDATE ia_instrucoes SET estado = 'publicada', publicado_em = ?, publicado_por = ?
              WHERE funcao = ? AND versao = ?`,
          )
          .run(em, autor, funcao, para);
      }
      this.db
        .prepare(
          `UPDATE ia_config SET instrucoes_versao = ?, instrucoes_anterior = NULL, atualizado_em = ?
            WHERE chave = ?`,
        )
        .run(para > 0 ? para : null, em, funcao);
      this.registrar(alteracao(atual.versao, para), em);
      resultado = { de: atual.versao, para };
    });
    return resultado;
  }

  private registrar(a: AlteracaoDeConfigDeIa, em: string): void {
    this.db
      .prepare(
        `INSERT INTO ia_alteracoes (em, autor, funcao, tipo, valor_anterior, valor_novo)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(em, a.autor, a.funcao, a.tipo, a.anterior, a.novo);
  }

  private transacao(corpo: () => void): void {
    this.db.exec('BEGIN');
    try {
      corpo();
      this.db.exec('COMMIT');
    } catch (erro) {
      this.db.exec('ROLLBACK');
      throw erro;
    }
  }
}

const TABELA_DA_FUNCAO: Readonly<Record<FuncaoDeIa, { tabela: string; ruim: string }>> = {
  ato: { tabela: 'analises_ia', ruim: 'nao_verificada' },
  resumo: { tabela: 'resumos_ia', ruim: 'nao_verificado' },
  peca: { tabela: 'analises_pecas_ia', ruim: 'nao_verificada' },
};

/**
 * As avaliações "errado" e "perigoso" das três tabelas, SEM o conteúdo da análise: só a data, a versão do
 * prompt, a avaliação, o motivo de lista fechada, o modelo e os 8 primeiros caracteres da conta.
 */
export class LeitorDeErrosDeIaSqlite implements LeitorDeErrosDeIa {
  constructor(private readonly db: DatabaseSync) {}

  errosRecentes(funcao: FuncaoDeIa, desde: Date, limite: number): ErroRecenteDeIa[] {
    const { tabela, ruim } = TABELA_DA_FUNCAO[funcao];
    const comMotivo = (
      this.db.prepare(`PRAGMA table_info(${tabela})`).all() as Array<{ name: string }>
    ).some((c) => c.name === 'motivo_avaliacao');
    const linhas = this.db
      .prepare(
        `SELECT criada_em, versao_prompt, avaliacao, modelo, workspace,
                ${comMotivo ? 'motivo_avaliacao' : 'NULL AS motivo_avaliacao'},
                CASE WHEN json_extract(resultado, '$.estado') = '${ruim}' THEN 1 ELSE 0 END AS nao_verificada
           FROM ${tabela}
          WHERE criada_em >= ? AND avaliacao IN ('errado', 'perigoso')
          ORDER BY criada_em DESC LIMIT ?`,
      )
      .all(desde.toISOString(), limite) as unknown as Array<{
      criada_em: string;
      versao_prompt: string;
      avaliacao: 'errado' | 'perigoso';
      modelo: string;
      workspace: string;
      motivo_avaliacao: string | null;
      nao_verificada: number;
    }>;
    return linhas.map((l) => ({
      em: new Date(l.criada_em),
      versaoPrompt: l.versao_prompt,
      avaliacao: l.avaliacao,
      motivo: l.motivo_avaliacao,
      modelo: l.modelo,
      naoVerificada: Number(l.nao_verificada) === 1,
      conta: l.workspace.slice(0, 8),
    }));
  }
}
