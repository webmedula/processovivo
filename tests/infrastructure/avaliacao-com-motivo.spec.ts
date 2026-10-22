import { describe, expect, it } from 'vitest';
import type { AnaliseDoAto } from '../../src/domain/entities/AnaliseDoAto.js';
import type { ResumoDoProcesso } from '../../src/domain/entities/ResumoDoProcesso.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAnalisesSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAnalisesSqlite.js';
import { RepositorioResumosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioResumosSqlite.js';

/*
 * v0.52.0: o motivo da avaliação ("errado"/"perigoso") nas duas tabelas. Coluna aditiva `motivo_avaliacao`,
 * só da lista fechada (a rota valida; aqui se prova a gravação), apagada por "útil" e isolada por workspace.
 */
const ANALISE: AnaliseDoAto = {
  id: 'a-1',
  workspace: 'ws-a',
  numero: '12345674720238260100',
  chaveDoAto: 'k1',
  resultado: { estado: 'nao_verificada', motivo: 'sem_citacao_valida' },
  procedencia: {
    modelo: 'm',
    versaoPrompt: 'ato-1.2.0',
    provedor: 'p',
    criadaEm: new Date('2026-10-05T12:00:00Z'),
  },
  medidas: { latenciaMs: 1000 },
};
const RESUMO: ResumoDoProcesso = {
  id: 'r-1',
  workspace: 'ws-a',
  numero: '12345674720238260100',
  resultado: { estado: 'nao_verificado', motivo: 'sem_item_verificado' },
  atosEnviados: [],
  contagens: {
    atosNoProcesso: 0,
    atosComTexto: 0,
    atosSoTitulo: 0,
    foraDoResumo: 0,
    itensDescartados: 0,
    providenciasDoSistema: 0,
    providenciasNaoCitadas: 0,
  },
  procedencia: {
    modelo: 'm',
    versaoPrompt: 'resumo-1.0.0',
    provedor: 'p',
    criadaEm: new Date('2026-10-05T12:00:00Z'),
  },
  medidas: { latenciaMs: 1000 },
};

describe.each([
  ['analises_ia', 'a-1'],
  ['resumos_ia', 'r-1'],
] as const)('motivo da avaliação em %s', (tabela, id) => {
  async function montar() {
    const db = abrirBanco(':memory:');
    if (tabela === 'analises_ia') {
      const repo = new RepositorioAnalisesSqlite(db);
      await repo.salvar(ANALISE);
      return { db, avaliar: repo.avaliar.bind(repo) };
    }
    const repo = new RepositorioResumosSqlite(db);
    await repo.salvar(RESUMO);
    return { db, avaliar: repo.avaliar.bind(repo) };
  }
  const lido = (db: ReturnType<typeof abrirBanco>) =>
    db
      .prepare(`SELECT avaliacao, motivo_avaliacao AS motivo FROM ${tabela} WHERE id = ?`)
      .get(id) as { avaliacao: string | null; motivo: string | null };

  it('grava o motivo com errado e perigoso; sem motivo fica nulo', async () => {
    const { db, avaliar } = await montar();
    expect(await avaliar('ws-a', id, 'errado', 'erro_de_fato')).toBe(true);
    expect(lido(db)).toEqual({ avaliacao: 'errado', motivo: 'erro_de_fato' });
    expect(await avaliar('ws-a', id, 'perigoso')).toBe(true);
    expect(lido(db)).toEqual({ avaliacao: 'perigoso', motivo: null });
  });

  it('"útil" apaga o motivo mesmo que um venha junto; avaliar de novo troca o motivo', async () => {
    const { db, avaliar } = await montar();
    await avaliar('ws-a', id, 'errado', 'citacao_inventada');
    await avaliar('ws-a', id, 'errado', 'deixou_de_fora');
    expect(lido(db).motivo).toBe('deixou_de_fora');
    await avaliar('ws-a', id, 'util', 'outro');
    expect(lido(db)).toEqual({ avaliacao: 'util', motivo: null });
  });

  it('isolamento: outra conta não grava motivo e a avaliação do dono fica intacta', async () => {
    const { db, avaliar } = await montar();
    await avaliar('ws-a', id, 'errado', 'outro');
    expect(await avaliar('ws-b', id, 'perigoso', 'concluiu_prazo')).toBe(false);
    expect(lido(db)).toEqual({ avaliacao: 'errado', motivo: 'outro' });
  });

  it('a migração aditiva cria a coluna na tabela', async () => {
    const { db } = await montar();
    const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all() as Array<{
      name: string;
    }>;
    expect(colunas.map((c) => c.name)).toContain('motivo_avaliacao');
  });
});
