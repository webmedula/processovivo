import type { DatabaseSync } from 'node:sqlite';
import type {
  EstadoDaRecorrencia,
  MeioDeCobranca,
  ResultadoDoPagamento,
} from '../../../domain/entities/Pagamento.js';
import type { CicloDoPlano } from '../../../domain/entities/Plano.js';
import type {
  AceiteDeTermos,
  CobrancaRecorrente,
  EventoDePagamento,
  PagamentoProcessado,
  RepositorioPagamentos,
} from '../../../domain/ports/RepositorioPagamentos.js';

interface LinhaCobranca {
  referencia: string;
  workspace: string;
  plano: string;
  ciclo: string;
  valor_centavos: number;
  gateway: string;
  gateway_id: string | null;
  estado: string;
  proxima_cobranca: string | null;
  metodo: string | null;
  ultimo_pagamento_em: string | null;
  ultimo_pagamento: string | null;
  renovacao_cancelada_em: string | null;
  criada_em: string;
  atualizada_em: string;
}

interface LinhaPagamento {
  chave: string;
  referencia: string;
  workspace: string;
  resultado: string;
  valor_centavos: number;
  ocorrido_em: string | null;
  registrado_em: string;
}

interface LinhaEvento {
  workspace: string | null;
  referencia: string | null;
  tipo: string;
  detalhe: string | null;
  criado_em: string;
}

function paraCobranca(l: LinhaCobranca): CobrancaRecorrente {
  return {
    referencia: l.referencia,
    workspace: l.workspace,
    plano: l.plano,
    ciclo: l.ciclo as CicloDoPlano,
    valorEmCentavos: l.valor_centavos,
    gateway: l.gateway,
    ...(l.gateway_id ? { gatewayId: l.gateway_id } : {}),
    estado: l.estado as EstadoDaRecorrencia,
    ...(l.proxima_cobranca ? { proximaCobranca: new Date(l.proxima_cobranca) } : {}),
    ...(l.metodo ? { meio: l.metodo as MeioDeCobranca } : {}),
    ...(l.ultimo_pagamento_em ? { ultimoPagamentoEm: new Date(l.ultimo_pagamento_em) } : {}),
    ...(l.ultimo_pagamento ? { ultimoPagamento: l.ultimo_pagamento as ResultadoDoPagamento } : {}),
    ...(l.renovacao_cancelada_em
      ? { renovacaoCanceladaEm: new Date(l.renovacao_cancelada_em) }
      : {}),
    criadaEm: new Date(l.criada_em),
    atualizadaEm: new Date(l.atualizada_em),
  };
}

function paraPagamento(l: LinhaPagamento): PagamentoProcessado {
  return {
    chave: l.chave,
    referencia: l.referencia,
    workspace: l.workspace,
    resultado: l.resultado as ResultadoDoPagamento,
    valorEmCentavos: l.valor_centavos,
    ...(l.ocorrido_em ? { ocorridoEm: new Date(l.ocorrido_em) } : {}),
    registradoEm: new Date(l.registrado_em),
  };
}

function paraEvento(l: LinhaEvento): EventoDePagamento {
  return {
    ...(l.workspace ? { workspace: l.workspace } : {}),
    ...(l.referencia ? { referencia: l.referencia } : {}),
    tipo: l.tipo,
    ...(l.detalhe ? { detalhe: l.detalhe } : {}),
    criadoEm: new Date(l.criado_em),
  };
}

const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);

/**
 * Cobranças do gateway. Só metadado: id, estado, valor, datas e o TIPO do meio. Nunca cartão, CPF,
 * nome ou e-mail do pagador — o domínio nem tem campo para isso.
 */
export class RepositorioPagamentosSqlite implements RepositorioPagamentos {
  constructor(private readonly db: DatabaseSync) {}

  async registrarAceiteDeTermos(a: AceiteDeTermos): Promise<void> {
    this.db
      .prepare('INSERT INTO aceites_termos (workspace, versao, plano, aceito_em) VALUES (?, ?, ?, ?)')
      .run(a.workspace, a.versao, a.plano, a.aceitoEm.toISOString());
  }

  async aceitesDe(workspace: string): Promise<readonly AceiteDeTermos[]> {
    const linhas = this.db
      .prepare('SELECT * FROM aceites_termos WHERE workspace = ? ORDER BY id ASC')
      .all(workspace) as unknown as Array<{
      workspace: string;
      versao: string;
      plano: string;
      aceito_em: string;
    }>;
    return linhas.map((l) => ({
      workspace: l.workspace,
      versao: l.versao,
      plano: l.plano,
      aceitoEm: new Date(l.aceito_em),
    }));
  }

  async criar(c: CobrancaRecorrente): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO cobrancas_recorrentes
           (referencia, workspace, plano, ciclo, valor_centavos, gateway, gateway_id, estado,
            proxima_cobranca, metodo, ultimo_pagamento_em, ultimo_pagamento,
            renovacao_cancelada_em, criada_em, atualizada_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...this.valores(c));
  }

  async porReferencia(referencia: string): Promise<CobrancaRecorrente | undefined> {
    const l = this.db
      .prepare('SELECT * FROM cobrancas_recorrentes WHERE referencia = ?')
      .get(referencia) as unknown as LinhaCobranca | undefined;
    return l ? paraCobranca(l) : undefined;
  }

  async porGatewayId(gatewayId: string): Promise<CobrancaRecorrente | undefined> {
    const l = this.db
      .prepare('SELECT * FROM cobrancas_recorrentes WHERE gateway_id = ?')
      .get(gatewayId) as unknown as LinhaCobranca | undefined;
    return l ? paraCobranca(l) : undefined;
  }

  async maisRecenteDoWorkspace(workspace: string): Promise<CobrancaRecorrente | undefined> {
    const l = this.db
      .prepare(
        `SELECT * FROM cobrancas_recorrentes WHERE workspace = ?
          ORDER BY criada_em DESC, rowid DESC LIMIT 1`,
      )
      .get(workspace) as unknown as LinhaCobranca | undefined;
    return l ? paraCobranca(l) : undefined;
  }

  async abertas(): Promise<readonly CobrancaRecorrente[]> {
    const linhas = this.db
      .prepare(
        `SELECT * FROM cobrancas_recorrentes
          WHERE gateway_id IS NOT NULL AND estado IN ('pendente', 'autorizada', 'pausada')
          ORDER BY criada_em ASC`,
      )
      .all() as unknown as LinhaCobranca[];
    return linhas.map(paraCobranca);
  }

  async todas(): Promise<readonly CobrancaRecorrente[]> {
    const linhas = this.db
      .prepare('SELECT * FROM cobrancas_recorrentes ORDER BY criada_em ASC')
      .all() as unknown as LinhaCobranca[];
    return linhas.map(paraCobranca);
  }

  async atualizar(c: CobrancaRecorrente): Promise<void> {
    this.db
      .prepare(
        `UPDATE cobrancas_recorrentes SET
           workspace = ?, plano = ?, ciclo = ?, valor_centavos = ?, gateway = ?, gateway_id = ?,
           estado = ?, proxima_cobranca = ?, metodo = ?, ultimo_pagamento_em = ?,
           ultimo_pagamento = ?, renovacao_cancelada_em = ?, atualizada_em = ?
         WHERE referencia = ?`,
      )
      .run(
        c.workspace,
        c.plano,
        c.ciclo,
        c.valorEmCentavos,
        c.gateway,
        c.gatewayId ?? null,
        c.estado,
        iso(c.proximaCobranca),
        c.meio ?? null,
        iso(c.ultimoPagamentoEm),
        c.ultimoPagamento ?? null,
        iso(c.renovacaoCanceladaEm),
        c.atualizadaEm.toISOString(),
        c.referencia,
      );
  }

  async registrarPagamento(p: PagamentoProcessado): Promise<boolean> {
    // A chave primária é a idempotência: `INSERT OR IGNORE` diz, pelo número de linhas, se FOI a primeira vez.
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO pagamentos_processados
           (chave, referencia, workspace, resultado, valor_centavos, ocorrido_em, registrado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.chave,
        p.referencia,
        p.workspace,
        p.resultado,
        p.valorEmCentavos,
        iso(p.ocorridoEm),
        p.registradoEm.toISOString(),
      );
    return Number(r.changes) === 1;
  }

  async desfazerRegistro(chave: string): Promise<void> {
    this.db.prepare('DELETE FROM pagamentos_processados WHERE chave = ?').run(chave);
  }

  async pagamentoPorChave(chave: string): Promise<PagamentoProcessado | undefined> {
    const l = this.db
      .prepare('SELECT * FROM pagamentos_processados WHERE chave = ?')
      .get(chave) as unknown as LinhaPagamento | undefined;
    return l ? paraPagamento(l) : undefined;
  }

  async atualizarResultado(chave: string, resultado: ResultadoDoPagamento): Promise<void> {
    this.db
      .prepare('UPDATE pagamentos_processados SET resultado = ? WHERE chave = ?')
      .run(resultado, chave);
  }

  async registrarEvento(e: EventoDePagamento): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO eventos_de_pagamento (workspace, referencia, tipo, detalhe, criado_em)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(e.workspace ?? null, e.referencia ?? null, e.tipo, e.detalhe ?? null, e.criadoEm.toISOString());
  }

  async ultimoEventoDoTipo(tipo: string): Promise<EventoDePagamento | undefined> {
    const l = this.db
      .prepare('SELECT * FROM eventos_de_pagamento WHERE tipo = ? ORDER BY id DESC LIMIT 1')
      .get(tipo) as unknown as LinhaEvento | undefined;
    return l ? paraEvento(l) : undefined;
  }

  async eventosDe(referencia: string): Promise<readonly EventoDePagamento[]> {
    const linhas = this.db
      .prepare('SELECT * FROM eventos_de_pagamento WHERE referencia = ? ORDER BY id ASC')
      .all(referencia) as unknown as LinhaEvento[];
    return linhas.map(paraEvento);
  }

  private valores(c: CobrancaRecorrente): Array<string | number | null> {
    return [
      c.referencia,
      c.workspace,
      c.plano,
      c.ciclo,
      c.valorEmCentavos,
      c.gateway,
      c.gatewayId ?? null,
      c.estado,
      iso(c.proximaCobranca),
      c.meio ?? null,
      iso(c.ultimoPagamentoEm),
      c.ultimoPagamento ?? null,
      iso(c.renovacaoCanceladaEm),
      c.criadaEm.toISOString(),
      c.atualizadaEm.toISOString(),
    ];
  }
}
