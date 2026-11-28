import { describe, expect, it } from 'vitest';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioPartesDoTribunalSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioPartesDoTribunalSqlite.js';
import type { Parte } from '../../src/domain/entities/Parte.js';

/** Partes do cabeçalho dos autos guardadas por conta (v0.73.0). Nomes e números inventados. */
const NUMERO = '00000000000000000001';
const PARTES: Parte[] = [
  {
    nome: 'BANCO SINTETICO S.A',
    polo: 'ATIVO',
    tipoPessoa: 'JURIDICA',
    documento: '00000000000191',
    advogados: [{ nome: 'ADVOGADA SINTETICA', oab: '99999', ufOab: 'GO' }],
  },
  { nome: 'EXECUTADO SINTETICO', polo: 'PASSIVO', tipoPessoa: 'FISICA', advogados: [] },
];

describe('RepositorioPartesDoTribunalSqlite', () => {
  it('guarda e devolve só nome, polo, tipo e advogados — o documento nunca vai ao banco', async () => {
    const db = abrirBanco(':memory:');
    const repo = new RepositorioPartesDoTribunalSqlite(db);
    await repo.guardar('ws-a', NUMERO, PARTES, new Date('2026-11-27T12:00:00Z'));
    const bruto = db
      .prepare('SELECT partes FROM partes_do_tribunal WHERE workspace = ?')
      .get('ws-a') as unknown as { partes: string };
    expect(bruto.partes).not.toContain('00000000000191');
    expect(bruto.partes).not.toContain('documento');
    const lido = (await repo.doWorkspace('ws-a')).get(NUMERO);
    expect(lido).toEqual([
      {
        nome: 'BANCO SINTETICO S.A',
        polo: 'ATIVO',
        tipoPessoa: 'JURIDICA',
        advogados: [{ nome: 'ADVOGADA SINTETICA', oab: '99999', ufOab: 'GO' }],
      },
      {
        nome: 'EXECUTADO SINTETICO',
        polo: 'PASSIVO',
        tipoPessoa: 'FISICA',
        advogados: [],
      },
    ]);
  });

  it('é por conta: a lista de uma nunca aparece para a outra', async () => {
    const repo = new RepositorioPartesDoTribunalSqlite(abrirBanco(':memory:'));
    await repo.guardar('ws-a', NUMERO, PARTES, new Date());
    expect((await repo.doWorkspace('ws-b')).size).toBe(0);
  });

  it('a gravação nova substitui a anterior; remover e apagar a conta tiram a linha', async () => {
    const repo = new RepositorioPartesDoTribunalSqlite(abrirBanco(':memory:'));
    await repo.guardar('ws-a', NUMERO, PARTES, new Date());
    await repo.guardar('ws-a', NUMERO, [PARTES[1] as Parte], new Date());
    expect((await repo.doWorkspace('ws-a')).get(NUMERO)?.map((p) => p.nome)).toEqual([
      'EXECUTADO SINTETICO',
    ]);
    await repo.remover('ws-a', NUMERO);
    expect((await repo.doWorkspace('ws-a')).size).toBe(0);
    await repo.guardar('ws-a', NUMERO, PARTES, new Date());
    expect(await repo.apagarDoWorkspace('ws-a')).toBe(1);
  });

  it('linha torta é ignorada (aquele processo volta às partes do Diário), as outras seguem', async () => {
    const db = abrirBanco(':memory:');
    const repo = new RepositorioPartesDoTribunalSqlite(db);
    await repo.guardar('ws-a', NUMERO, PARTES, new Date());
    db.prepare(
      "INSERT INTO partes_do_tribunal (workspace, numero, partes, gravadas_em) VALUES ('ws-a', '2', '{torto', 'x')",
    ).run();
    const mapa = await repo.doWorkspace('ws-a');
    expect(mapa.has(NUMERO)).toBe(true);
    expect(mapa.has('2')).toBe(false);
  });
});
