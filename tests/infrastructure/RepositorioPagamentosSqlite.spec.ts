import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioPagamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioPagamentosSqlite.js';
import type { CobrancaRecorrente } from '../../src/domain/ports/RepositorioPagamentos.js';

const AGORA = new Date('2026-10-20T12:00:00.000Z');
const cobranca = (extra: Partial<CobrancaRecorrente> = {}): CobrancaRecorrente => ({
  referencia: 'ref-1',
  workspace: 'ws-1',
  plano: 'pecas',
  ciclo: 'mensal',
  valorEmCentavos: 4990,
  gateway: 'falso',
  estado: 'pendente',
  criadaEm: AGORA,
  atualizadaEm: AGORA,
  ...extra,
});

describe('RepositorioPagamentosSqlite', () => {
  let db: DatabaseSync;
  let repo: RepositorioPagamentosSqlite;
  beforeEach(() => {
    db = abrirBanco(':memory:');
    repo = new RepositorioPagamentosSqlite(db);
  });
  afterEach(() => db.close());

  it('cria, atualiza e acha por referência, por id do gateway e por workspace (o mais recente)', async () => {
    await repo.criar(cobranca());
    await repo.criar(
      cobranca({
        referencia: 'ref-2',
        criadaEm: new Date(AGORA.getTime() + 1000),
        atualizadaEm: AGORA,
      }),
    );
    await repo.atualizar({
      ...cobranca(),
      gatewayId: 'gw-1',
      estado: 'autorizada',
      meio: 'cartao',
      proximaCobranca: new Date('2026-11-20T12:00:00.000Z'),
    });
    expect((await repo.porGatewayId('gw-1'))!.referencia).toBe('ref-1');
    expect(await repo.porReferencia('ref-1')).toMatchObject({
      estado: 'autorizada',
      meio: 'cartao',
    });
    expect((await repo.maisRecenteDoWorkspace('ws-1'))!.referencia).toBe('ref-2');
    expect(await repo.maisRecenteDoWorkspace('outro')).toBeUndefined();
  });

  it('o id do gateway é único (duas linhas não apontam para a mesma assinatura)', async () => {
    await repo.criar(cobranca({ gatewayId: 'gw-1' }));
    await expect(
      repo.criar(cobranca({ referencia: 'ref-2', gatewayId: 'gw-1' })),
    ).rejects.toThrow();
  });

  it('"abertas" são as que ainda cobram e têm id no gateway', async () => {
    await repo.criar(
      cobranca({ referencia: 'a', gatewayId: 'g-a', estado: 'autorizada' }),
    );
    await repo.criar(
      cobranca({ referencia: 'b', gatewayId: 'g-b', estado: 'cancelada' }),
    );
    await repo.criar(cobranca({ referencia: 'c', estado: 'pendente' }));
    expect((await repo.abertas()).map((c) => c.referencia)).toEqual(['a']);
  });

  it('IDEMPOTÊNCIA: a mesma chave só é registrada uma vez (restrição de unicidade)', async () => {
    const p = {
      chave: 'pg:900',
      referencia: 'ref-1',
      workspace: 'ws-1',
      resultado: 'aprovado' as const,
      valorEmCentavos: 4990,
      registradoEm: AGORA,
    };
    expect(await repo.registrarPagamento(p)).toBe(true);
    expect(await repo.registrarPagamento(p)).toBe(false);
    expect(await repo.registrarPagamento(p)).toBe(false);
    const n = db.prepare('SELECT COUNT(*) AS n FROM pagamentos_processados').get() as {
      n: number;
    };
    expect(n.n).toBe(1);
    await repo.desfazerRegistro('pg:900');
    expect(await repo.registrarPagamento(p)).toBe(true);
  });

  it('atualiza o resultado de um pagamento registrado (estorno)', async () => {
    await repo.registrarPagamento({
      chave: 'pg:1',
      referencia: 'r',
      workspace: 'w',
      resultado: 'aprovado',
      valorEmCentavos: 1,
      registradoEm: AGORA,
    });
    await repo.atualizarResultado('pg:1', 'estornado');
    expect((await repo.pagamentoPorChave('pg:1'))!.resultado).toBe('estornado');
  });

  it('as tabelas guardam só metadado: nenhuma coluna de cartão, CPF, nome ou e-mail', () => {
    for (const tabela of [
      'cobrancas_recorrentes',
      'pagamentos_processados',
      'eventos_de_pagamento',
    ]) {
      const nomes = (
        db.prepare(`PRAGMA table_info(${tabela})`).all() as Array<{ name: string }>
      )
        .map((c) => c.name)
        .join(',');
      expect(nomes, tabela).not.toMatch(/cartao|card|cpf|nome|email|payer|documento/i);
    }
  });

  it('registra e lê a trilha de auditoria por referência', async () => {
    await repo.registrarEvento({
      referencia: 'ref-1',
      workspace: 'ws-1',
      tipo: 'renovacao_cancelada_pelo_usuario',
      criadoEm: AGORA,
    });
    await repo.registrarEvento({ referencia: 'ref-2', tipo: 'outro', criadoEm: AGORA });
    const e = await repo.eventosDe('ref-1');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      tipo: 'renovacao_cancelada_pelo_usuario',
      workspace: 'ws-1',
    });
  });
});
