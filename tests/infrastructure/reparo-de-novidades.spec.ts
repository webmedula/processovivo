import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  aplicarReparo,
  desfazerReparo,
  diagnosticarAvalanche,
} from '../../src/infrastructure/persistencia/reparoDeNovidades.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';

/*
 * O reparo da avalanche: dry-run por padrão, só marca como lida, nunca apaga,
 * desfaz, e a saída são contagens. Tudo sintético, relógio fixo.
 */
const DETECTADA = '2026-10-06T12:00:00.000Z';
const AGORA = new Date('2026-10-08T12:00:00Z');

describe('reparo das novidades da avalanche', () => {
  let db: DatabaseSync;

  function inserir(
    workspace: string,
    numero: string,
    quantas: number,
    opcoes: { detectada?: string; anoDoAto?: number; vista?: boolean } = {},
  ): void {
    const ins = db.prepare(
      `INSERT INTO novidades (workspace, numero, data, titulo, detectada_em, vista_em)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < quantas; i++) {
      const data = new Date(Date.UTC(opcoes.anoDoAto ?? 2024, 0, 1 + i)).toISOString();
      ins.run(
        workspace,
        numero,
        data,
        `Ato ${numero}-${i}`,
        opcoes.detectada ?? DETECTADA,
        opcoes.vista ? DETECTADA : null,
      );
    }
  }
  const naoLidas = (ws: string): number =>
    Number(
      (
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM novidades WHERE workspace = ? AND vista_em IS NULL',
          )
          .get(ws) as { n: number }
      ).n,
    );
  const total = (): number =>
    Number((db.prepare('SELECT COUNT(*) AS n FROM novidades').get() as { n: number }).n);

  beforeEach(() => {
    db = abrirBanco(':memory:');
  });
  afterEach(() => db.close());

  it('dry-run: conta as novidades de lote grande e antigo, e não altera nada', () => {
    inserir('ws-a', 'p1', 60); // 60 atos de 2024 detectados num mesmo instante
    inserir('ws-a', 'p2', 3, { anoDoAto: 2026 }); // 3 novidades normais
    inserir('ws-b', 'p3', 25);

    const d = diagnosticarAvalanche(db);

    expect(d.totalNaoLidas).toBe(85);
    expect(d.workspaces.map((w) => [w.ordem, w.lotes, w.naoLidas])).toEqual([
      [1, 1, 60],
      [2, 1, 25],
    ]);
    expect(naoLidas('ws-a')).toBe(63);
    expect(total()).toBe(88);
  });

  it('a saída não carrega número de processo nem identificador do workspace', () => {
    inserir('ws-a', '12345674720238260100', 30);
    const { workspaces } = diagnosticarAvalanche(db);
    const texto = JSON.stringify(workspaces);
    expect(texto).not.toContain('12345674720238260100');
    expect(texto).not.toContain('ws-a');
  });

  it('lote pequeno não é avalanche', () => {
    inserir('ws-a', 'p1', 19); // abaixo do tamanho mínimo
    expect(diagnosticarAvalanche(db).totalNaoLidas).toBe(0);
  });

  describe('resíduo que o critério da 0.37.5 deixa (v0.37.6, investigação; nada é aplicado)', () => {
    // O critério complementar PROPOSTO: lote menor, mas só se TODOS os atos forem antigos.
    const PROPOSTO = { tamanhoMinimoDoLote: 5, diasDeAtraso: 30, fracaoDeAntigos: 1 };

    it('um lote de 12 novidades antigas detectadas juntas FICA DE FORA do critério atual', () => {
      inserir('ws-a', 'p1', 12); // 12 atos de 2024 no mesmo instante: a assinatura do despejo, em tamanho menor
      expect(diagnosticarAvalanche(db).totalNaoLidas).toBe(0);
    });

    it('o critério complementar proposto (5+ e 100% antigos) o pegaria', () => {
      inserir('ws-a', 'p1', 12);
      expect(diagnosticarAvalanche(db, PROPOSTO).totalNaoLidas).toBe(12);
    });

    it('e continuaria deixando em paz o lote pequeno de atos recentes e o lote misto', () => {
      const ins = db.prepare(
        `INSERT INTO novidades (workspace, numero, data, titulo, detectada_em) VALUES ('w', ?, ?, ?, ?)`,
      );
      for (let i = 0; i < 6; i++) {
        ins.run('recente', new Date(Date.parse(DETECTADA) - i * 3_600_000).toISOString(), `Ato ${i}`, DETECTADA);
      }
      // 7 antigos + 1 recente: não é 100% antigo, então o complemento não o toca.
      inserir('w', 'misto', 7);
      ins.run('misto', new Date(Date.parse(DETECTADA) - 3_600_000).toISOString(), 'Ato novo', DETECTADA);
      expect(diagnosticarAvalanche(db, PROPOSTO).totalNaoLidas).toBe(0);
    });

    it('ato de 16 dias detectado "há 2 dias" (o caso 21/09) NÃO é pego por nenhum dos dois: 30 dias de atraso é o piso', () => {
      const ins = db.prepare(
        `INSERT INTO novidades (workspace, numero, data, titulo, detectada_em) VALUES ('w', 'p', ?, ?, ?)`,
      );
      for (let i = 0; i < 25; i++) {
        ins.run(new Date(Date.parse(DETECTADA) - (16 + i * 0.01) * 86_400_000).toISOString(), `Ato ${i}`, DETECTADA);
      }
      expect(diagnosticarAvalanche(db).totalNaoLidas).toBe(0);
      expect(diagnosticarAvalanche(db, PROPOSTO).totalNaoLidas).toBe(0);
      // Só baixar o piso o pegaria — e ele passaria a pegar também o atraso legítimo do DataJud.
      expect(diagnosticarAvalanche(db, { ...PROPOSTO, diasDeAtraso: 14 }).totalNaoLidas).toBe(25);
    });
  });

  it('lote grande de atos RECENTES não é avalanche: é uma publicação em massa de verdade', () => {
    const ins = db.prepare(
      `INSERT INTO novidades (workspace, numero, data, titulo, detectada_em) VALUES ('w', 'p', ?, ?, ?)`,
    );
    for (let i = 0; i < 40; i++) {
      ins.run(
        new Date(Date.parse(DETECTADA) - i * 3_600_000).toISOString(),
        `Ato ${i}`,
        DETECTADA,
      );
    }
    expect(diagnosticarAvalanche(db).totalNaoLidas).toBe(0);
  });

  it('um ato RECENTE no meio do lote continua não lido', () => {
    inserir('ws-a', 'p1', 40);
    db.prepare(
      `INSERT INTO novidades (workspace, numero, data, titulo, detectada_em)
       VALUES ('ws-a', 'p1', ?, 'Ato de verdade', ?)`,
    ).run('2026-10-05T12:00:00.000Z', DETECTADA);

    const d = diagnosticarAvalanche(db);
    aplicarReparo(db, d, AGORA);

    expect(naoLidas('ws-a')).toBe(1);
    const restante = db
      .prepare('SELECT titulo FROM novidades WHERE vista_em IS NULL')
      .get() as {
      titulo: string;
    };
    expect(restante.titulo).toBe('Ato de verdade');
  });

  it('--aplicar só marca como lida: nada é apagado', () => {
    inserir('ws-a', 'p1', 60);
    const antes = total();

    const registro = aplicarReparo(db, diagnosticarAvalanche(db), AGORA);

    expect(registro.ids).toHaveLength(60);
    expect(total()).toBe(antes);
    expect(naoLidas('ws-a')).toBe(0);
    // Idempotente: rodar de novo não acha mais nada a marcar.
    expect(diagnosticarAvalanche(db).totalNaoLidas).toBe(0);
  });

  it('já lidas não entram na contagem', () => {
    inserir('ws-a', 'p1', 30, { vista: true });
    expect(diagnosticarAvalanche(db).totalNaoLidas).toBe(0);
  });

  it('--desfazer devolve o "não lida", mas só ao que ainda tem a marca do reparo', () => {
    inserir('ws-a', 'p1', 30);
    const registro = aplicarReparo(db, diagnosticarAvalanche(db), AGORA);
    // Uma delas é relida à mão depois do reparo: não deve ser mexida.
    const id = registro.ids[0] as number;
    db.prepare('UPDATE novidades SET vista_em = ? WHERE id = ?').run(
      '2026-10-09T00:00:00.000Z',
      id,
    );

    const desfeitas = desfazerReparo(db, registro);

    expect(desfeitas).toBe(29);
    expect(naoLidas('ws-a')).toBe(29);
  });
});
