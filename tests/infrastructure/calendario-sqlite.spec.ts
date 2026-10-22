import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventoDeCalendario } from '../../src/domain/entities/EventoDeCalendario.js';
import type { SugestaoDeEvento } from '../../src/domain/entities/EventoDeCalendario.js';
import { ServicoAssinaturas } from '../../src/application/services/ServicoAssinaturas.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import {
  MARCA_CALENDARIO_NOS_PLANOS,
  abrirBanco,
} from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDeEventosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeEventosSqlite.js';
import { RepositorioAssinaturasSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAssinaturasSqlite.js';
import {
  RepositorioPlanosSqlite,
  RepositorioRegrasDeAssinaturaSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositorioPlanosSqlite.js';
import { RepositorioUsuariosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioUsuariosSqlite.js';

const AGORA = new Date('2026-10-02T15:00:00.000Z');
const NUMERO = '12345674720238260100';

const SUGESTAO: SugestaoDeEvento = {
  tipo: 'audiencia',
  titulo: 'Audiência',
  dataLocal: '2026-11-12',
  horaLocal: '14:30',
  procedencia: {
    movimentacaoId: 'm1',
    dataDoAndamento: new Date('2026-10-01T12:00:00.000Z'),
    trecho: 'Audiência designada para 12/11/2026 às 14:30.',
  },
};

function sugerido(workspace: string, id: string): EventoDeCalendario {
  return EventoDeCalendario.sugerido({
    id,
    workspace,
    numeroProcesso: NUMERO,
    tribunal: 'TJSP',
    segredoJustica: false,
    sugestao: SUGESTAO,
    agora: AGORA,
  });
}

function manual(workspace: string, id: string): EventoDeCalendario {
  return EventoDeCalendario.manual({
    id,
    workspace,
    numeroProcesso: NUMERO,
    tribunal: 'TJSP',
    segredoJustica: false,
    tipo: 'reuniao',
    titulo: 'Reunião',
    dataLocal: '2026-11-12',
    horaLocal: '10:00',
    duracaoMin: 45,
    observacao: 'só do advogado',
    agora: AGORA,
  });
}

const INTERVALO = { de: '2026-10-01', ate: '2026-12-31' };

describe('RepositorioDeEventosSqlite', () => {
  let db: ReturnType<typeof abrirBanco>;
  let repo: RepositorioDeEventosSqlite;
  beforeEach(() => {
    db = abrirBanco(':memory:');
    repo = new RepositorioDeEventosSqlite(db);
  });
  afterEach(() => db.close());

  it('grava e relê o evento inteiro', async () => {
    const e = manual('A', 'e1');
    await repo.salvar(e);
    expect((await repo.buscar('A', 'e1'))?.props()).toEqual(e.props());
    const s = sugerido('A', 's1').confirmar(AGORA);
    await repo.inserirSeNovo(s);
    expect((await repo.buscar('A', 's1'))?.props()).toEqual(s.props());
  });

  it('o marcador de prazo calculado (v0.39.0) vai e volta do banco, e some ao editar a data', async () => {
    const calculado = EventoDeCalendario.manual({
      id: 'c1',
      workspace: 'A',
      numeroProcesso: NUMERO,
      tribunal: 'TJSP',
      segredoJustica: false,
      tipo: 'prazo',
      titulo: 'Prazo de 15 dias úteis (a conferir)',
      dataLocal: '2026-10-28',
      calculado: true,
      agora: AGORA,
    });
    await repo.salvar(calculado);
    expect((await repo.buscar('A', 'c1'))?.calculado).toBe(true);
    expect((await repo.buscar('A', 'c1'))?.props()).toEqual(calculado.props());
    // Um evento comum continua sem o marcador.
    await repo.salvar(manual('A', 'e1'));
    expect((await repo.buscar('A', 'e1'))?.calculado).toBe(false);
    // Mexer na data apaga o marcador, e o banco acompanha.
    const editado = calculado.editar({ dataLocal: '2026-10-30' }, AGORA);
    await repo.salvar(editado);
    expect((await repo.buscar('A', 'c1'))?.calculado).toBe(false);
    // Mexer só no título não apaga: a data continua a calculada.
    const soTitulo = calculado.editar({ titulo: 'Outro título' }, AGORA);
    expect(soTitulo.calculado).toBe(true);
  });

  it('a mesma sugestão não entra duas vezes — e a descartada não volta', async () => {
    expect(await repo.inserirSeNovo(sugerido('A', 's1'))).toBe(true);
    expect(await repo.inserirSeNovo(sugerido('A', 's2'))).toBe(false);

    const descartado = (await repo.buscar('A', 's1'))?.descartar(AGORA);
    if (descartado) await repo.salvar(descartado);
    expect(await repo.inserirSeNovo(sugerido('A', 's3'))).toBe(false);
    expect((await repo.listar('A', INTERVALO)).map((e) => [e.id, e.estado])).toEqual([
      ['s1', 'descartado'],
    ]);
  });

  it('corrigir a data de uma sugestão não faz a original renascer', async () => {
    await repo.inserirSeNovo(sugerido('A', 's1'));
    const corrigido = (await repo.buscar('A', 's1'))?.editar(
      { dataLocal: '2026-11-13' },
      AGORA,
    );
    if (corrigido) await repo.salvar(corrigido);
    expect(await repo.inserirSeNovo(sugerido('A', 's2'))).toBe(false);
  });

  describe('isolamento por workspace (A × B)', () => {
    beforeEach(async () => {
      await repo.salvar(manual('A', 'e1'));
      await repo.inserirSeNovo(sugerido('A', 's1'));
    });

    it('B não lê evento de A — nem por id, nem por intervalo, nem por processo', async () => {
      expect(await repo.buscar('B', 'e1')).toBeUndefined();
      expect(await repo.listar('B', INTERVALO)).toEqual([]);
      expect(await repo.contar('B', INTERVALO.de, INTERVALO.ate)).toBe(0);
      expect(await repo.detectadosDoProcesso('B', NUMERO)).toEqual([]);
    });

    it('B não altera evento de A: gravar com o mesmo id cria outro, no B', async () => {
      const intruso = new EventoDeCalendario({
        ...manual('B', 'e1').props(),
        titulo: 'invadido',
      });
      await repo.salvar(intruso);
      expect((await repo.buscar('A', 'e1'))?.titulo).toBe('Reunião');
      expect((await repo.buscar('B', 'e1'))?.titulo).toBe('invadido');
    });

    it('a mesma sugestão no B é outra: a deduplicação é por workspace', async () => {
      expect(await repo.inserirSeNovo(sugerido('B', 's9'))).toBe(true);
    });

    it('o sigilo de um processo em A não muda o mesmo processo em B', async () => {
      await repo.inserirSeNovo(sugerido('B', 's9'));
      await repo.atualizarSegredo('A', NUMERO, true);
      expect((await repo.buscar('A', 's1'))?.segredoJustica).toBe(true);
      expect((await repo.buscar('B', 's9'))?.segredoJustica).toBe(false);
    });

    it('feed: cada workspace tem o seu, e revogar o do B não toca o do A', async () => {
      const feed = (
        ws: string,
        hash: string,
      ): Parameters<typeof repo.substituirFeed>[0] => ({
        id: `f-${hash}`,
        workspace: ws,
        tokenHash: hash,
        incluiSugeridos: false,
        // v0.51.0: o feed ganhou lembretes e o contador de revisão; este teste é só de isolamento.
        lembretes: { umDiaAntes: false, umaHoraAntes: false },
        revisaoLembretes: 0,
        criadoEm: AGORA,
      });
      await repo.substituirFeed(feed('A', 'hash-a'));
      await repo.substituirFeed(feed('B', 'hash-b'));
      expect(await repo.revogarFeed('B', AGORA)).toBe(true);
      expect((await repo.feedAtivo('A'))?.tokenHash).toBe('hash-a');
      expect(await repo.feedAtivo('B')).toBeUndefined();
      expect((await repo.feedPorHash('hash-a'))?.workspace).toBe('A');
    });
  });

  it('regenerar revoga o feed anterior na mesma operação', async () => {
    const base = {
      workspace: 'A',
      incluiSugeridos: true,
      lembretes: { umDiaAntes: false, umaHoraAntes: false },
      revisaoLembretes: 0,
      criadoEm: AGORA,
    };
    await repo.substituirFeed({ ...base, id: 'f1', tokenHash: 'h1' });
    await repo.substituirFeed({ ...base, id: 'f2', tokenHash: 'h2' });
    expect((await repo.feedPorHash('h1'))?.revogadoEm).toBeDefined();
    expect((await repo.feedAtivo('A'))?.id).toBe('f2');
  });

  it('retroativo: lista quem tem pasta e ainda não passou, e marca', async () => {
    db.prepare(
      `INSERT INTO acompanhamentos (workspace, numero, criado_em) VALUES ('A', ?, ?), ('B', ?, ?)`,
    ).run(NUMERO, AGORA.toISOString(), NUMERO, AGORA.toISOString());
    expect(await repo.workspacesSemRetroativo(10)).toEqual(['A', 'B']);
    await repo.marcarRetroativo('A', AGORA);
    expect(await repo.workspacesSemRetroativo(10)).toEqual(['B']);
  });
});

describe('retrocarga do calendário nos planos já gravados', () => {
  let pasta: string;
  beforeEach(() => {
    pasta = mkdtempSync(join(tmpdir(), 'pv-cal-'));
  });
  afterEach(() => rmSync(pasta, { recursive: true, force: true }));

  /** Simula um banco da v0.31: planos SEM o calendário e sem a marca. */
  function bancoAntigo(caminho: string): void {
    const db = abrirBanco(caminho);
    for (const { codigo, recursos } of db
      .prepare('SELECT codigo, recursos FROM planos')
      .all() as Array<{
      codigo: string;
      recursos: string;
    }>) {
      const sem = (JSON.parse(recursos) as string[]).filter((r) => r !== 'calendario');
      db.prepare('UPDATE planos SET recursos = ? WHERE codigo = ?').run(
        JSON.stringify(sem),
        codigo,
      );
    }
    db.prepare('DELETE FROM estado WHERE chave = ?').run(MARCA_CALENDARIO_NOS_PLANOS);
    // Uma assinatura gravada antes, no plano base.
    db.prepare(
      `INSERT INTO assinaturas (workspace, plano, inicio_em, vence_em, eh_teste, dias_carencia)
       VALUES ('ws-antigo', 'acompanhamento', ?, ?, 0, 7)`,
    ).run('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
    db.close();
  }

  function recursosDosPlanos(
    db: ReturnType<typeof abrirBanco>,
  ): Record<string, string[]> {
    const linhas = db.prepare('SELECT codigo, recursos FROM planos').all() as Array<{
      codigo: string;
      recursos: string;
    }>;
    return Object.fromEntries(
      linhas.map((l) => [l.codigo, JSON.parse(l.recursos) as string[]]),
    );
  }

  it('assinatura de plano gravado antes enxerga o calendário depois da migração', async () => {
    const caminho = join(pasta, 'processovivo.db');
    bancoAntigo(caminho);

    const db = abrirBanco(caminho);
    for (const recursos of Object.values(recursosDosPlanos(db))) {
      expect(recursos).toContain('calendario');
    }
    const servico = new ServicoAssinaturas({
      repositorio: new RepositorioAssinaturasSqlite(db),
      planos: new RepositorioPlanosSqlite(db),
      regras: new RepositorioRegrasDeAssinaturaSqlite(db),
      usuarios: new RepositorioUsuariosSqlite(db),
      logger: loggerSilencioso,
      agora: () => AGORA,
    });
    await expect(servico.exigir('ws-antigo', 'calendario')).resolves.toBeUndefined();
    db.close();
  });

  it('segunda execução não duplica, e não desfaz a decisão do operador', () => {
    const caminho = join(pasta, 'processovivo.db');
    bancoAntigo(caminho);
    abrirBanco(caminho).close();

    let db = abrirBanco(caminho);
    for (const recursos of Object.values(recursosDosPlanos(db))) {
      expect(recursos.filter((r) => r === 'calendario')).toHaveLength(1);
    }
    // O operador tira o calendário de um plano pelo painel…
    db.prepare('UPDATE planos SET recursos = ? WHERE codigo = ?').run(
      JSON.stringify(['consulta']),
      'ia',
    );
    db.close();
    // …e o próximo arranque respeita.
    db = abrirBanco(caminho);
    expect(recursosDosPlanos(db)['ia']).toEqual(['consulta']);
    db.close();
  });
});
