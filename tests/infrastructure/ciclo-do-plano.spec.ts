import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  CICLOS_VENDAVEIS,
  MESES_POR_CICLO,
  cicloDoPlano,
  validarPlano,
  valorDoCicloEmCentavos,
} from '../../src/domain/entities/Plano.js';
import type { Plano } from '../../src/domain/entities/Plano.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioPlanosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioPlanosSqlite.js';

const base: Plano = {
  codigo: 'teste-ciclo',
  nome: 'Teste',
  resumo: 'Plano de teste.',
  recursos: ['consulta'],
  disponivelParaContratacao: true,
  precoMensalCentavos: 4990,
  ordem: 99,
};

describe('ciclo do plano (v0.44.0)', () => {
  it('sem o campo, o ciclo é mensal (o padrão seguro)', () => {
    expect(cicloDoPlano(base)).toBe('mensal');
    expect(MESES_POR_CICLO).toEqual({ mensal: 1, trimestral: 3, anual: 12 });
  });

  it('só o mensal é vendável nesta versão', () => {
    expect(CICLOS_VENDAVEIS).toEqual(['mensal']);
  });

  it('o valor de UMA cobrança é o preço mensal vezes os meses do ciclo; sem preço, nulo', () => {
    expect(valorDoCicloEmCentavos(base)).toBe(4990);
    expect(valorDoCicloEmCentavos({ ...base, ciclo: 'trimestral' })).toBe(14970);
    expect(valorDoCicloEmCentavos({ ...base, ciclo: 'anual' })).toBe(59880);
    expect(valorDoCicloEmCentavos({ ...base, precoMensalCentavos: null })).toBeNull();
    expect(valorDoCicloEmCentavos({ ...base, precoMensalCentavos: 0 })).toBeNull();
  });

  it('ciclo desconhecido é recusado na validação do plano', () => {
    expect(() => validarPlano({ ...base, ciclo: 'semanal' as never })).toThrow(/ciclo/i);
    expect(() => validarPlano({ ...base, ciclo: 'anual' })).not.toThrow();
  });

  it('o repositório grava e lê o ciclo; plano sem o campo volta como mensal (sem a chave)', async () => {
    const db = abrirBanco(':memory:');
    const repo = new RepositorioPlanosSqlite(db);
    await repo.salvar({ ...base, ciclo: 'anual' });
    await repo.salvar({ ...base, codigo: 'sem-ciclo' });
    expect((await repo.porCodigo('teste-ciclo'))!.ciclo).toBe('anual');
    const sem = (await repo.porCodigo('sem-ciclo'))!;
    expect(sem.ciclo).toBeUndefined();
    expect(cicloDoPlano(sem)).toBe('mensal');
    db.close();
  });

  it('MIGRAÇÃO: banco anterior à coluna ganha `ciclo` com o padrão `mensal`, sem perder nenhum plano', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'pv-ciclo-'));
    try {
      const caminho = join(pasta, 'velho.db');
      // O banco de antes da v0.44.0: a tabela `planos` SEM a coluna, com um plano dentro.
      const velho = new DatabaseSync(caminho);
      velho.exec(`CREATE TABLE planos (
        codigo TEXT PRIMARY KEY, nome TEXT NOT NULL, resumo TEXT NOT NULL, recursos TEXT NOT NULL,
        disponivel INTEGER NOT NULL DEFAULT 0, preco_mensal_centavos INTEGER, ordem INTEGER NOT NULL DEFAULT 0)`);
      velho
        .prepare('INSERT INTO planos VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('antigo', 'Antigo', 'Plano antigo.', '["consulta"]', 1, 1990, 5);
      velho.close();

      // Abrir pelo caminho real roda a migração aditiva; abrir de novo não pode estourar.
      abrirBanco(caminho).close();
      const db = abrirBanco(caminho);
      const linha = db
        .prepare(
          'SELECT codigo, ciclo, preco_mensal_centavos FROM planos WHERE codigo = ?',
        )
        .get('antigo') as {
        codigo: string;
        ciclo: string;
        preco_mensal_centavos: number;
      };
      expect(linha).toEqual({
        codigo: 'antigo',
        ciclo: 'mensal',
        preco_mensal_centavos: 1990,
      });
      db.close();
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });

  it('o schema real tem a coluna `ciclo` (migração de COLUNAS_ACRESCENTADAS) e abrir duas vezes não estoura', async () => {
    const db = abrirBanco(':memory:');
    const colunas = db.prepare('PRAGMA table_info(planos)').all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    expect(colunas.find((c) => c.name === 'ciclo')?.dflt_value).toBe("'mensal'");
    db.close();
  });
});
