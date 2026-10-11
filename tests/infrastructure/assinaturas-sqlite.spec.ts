import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Assinatura, assinaturaDeTeste } from '../../src/domain/entities/Assinatura.js';
import { PlanoDesconhecidoError } from '../../src/domain/errors/index.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAssinaturasSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAssinaturasSqlite.js';
import {
  RepositorioPlanosSqlite,
  RepositorioRegrasDeAssinaturaSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositorioPlanosSqlite.js';
import { ServicoAssinaturas } from '../../src/application/services/ServicoAssinaturas.js';
import { PLANOS_INICIAIS } from '../../src/domain/entities/Plano.js';
import type { RepositorioUsuarios } from '../../src/domain/ports/RepositorioUsuarios.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';

const T0 = new Date('2026-09-22T12:00:00.000Z');
const dias = (n: number): Date => new Date(T0.getTime() + n * 86_400_000);

function inserirConta(db: DatabaseSync, id: string, workspace: string): void {
  db.prepare(
    `INSERT INTO usuarios (id, email, nome, senha, workspace, criado_em)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, `${id}@a.com.br`, id, 'scrypt$x', workspace, T0.toISOString());
}

describe('RepositorioAssinaturasSqlite', () => {
  let db: DatabaseSync;
  let repo: RepositorioAssinaturasSqlite;

  beforeEach(() => {
    db = abrirBanco(':memory:');
    repo = new RepositorioAssinaturasSqlite(db);
  });

  afterEach(() => db.close());

  it('guarda e devolve a assinatura inteira', async () => {
    const a = new Assinatura({
      workspace: 'ws1',
      plano: 'pecas',
      inicioEm: T0,
      venceEm: dias(30),
      ehTeste: false,
      diasDeCarencia: 7,
      observacao: 'Pix 22/09',
    });
    await repo.salvar(a);

    const lido = await repo.porWorkspace('ws1');
    expect(lido?.plano).toBe('pecas');
    expect(lido?.venceEm.toISOString()).toBe(dias(30).toISOString());
    expect(lido?.diasDeCarencia).toBe(7);
    expect(lido?.observacao).toBe('Pix 22/09');
    expect(lido?.statusEm(T0)).toBe('ativa');
  });

  it('workspace sem assinatura devolve indefinido, não erro', async () => {
    expect(await repo.porWorkspace('ninguem')).toBeUndefined();
  });

  it('salvar de novo substitui, não duplica', async () => {
    const a = assinaturaDeTeste({ workspace: 'ws1', plano: 'pecas', agora: T0 });
    await repo.salvar(a);
    await repo.salvar(a.renovada({ meses: 6, agora: dias(3) }));

    const todas = await repo.todas();
    expect(todas).toHaveLength(1);
    expect(todas[0]?.ehTeste).toBe(false);
  });

  it('renovar zera a escrituração de aviso', async () => {
    /*
     * Sem isto, quem recebesse o aviso de vencimento e renovasse ficaria com o
     * campo preso em 'vencendo' — e nunca mais seria avisado, em nenhum ciclo
     * seguinte. O silêncio pareceria normal até a assinatura cair.
     */
    const a = new Assinatura({
      workspace: 'ws1',
      plano: 'pecas',
      inicioEm: T0,
      venceEm: dias(2),
      ehTeste: false,
      diasDeCarencia: 7,
    });
    await repo.salvar(a);
    await repo.registrarAviso('ws1', 'vencendo');
    expect(await repo.ultimoAviso('ws1')).toBe('vencendo');

    await repo.salvar(a.renovada({ meses: 1, agora: dias(1) }));
    expect(await repo.ultimoAviso('ws1')).toBeUndefined();
  });

  it('a vencer não traz as canceladas', async () => {
    // Insistir por e-mail com quem já cancelou é o caminho mais curto para ser
    // marcado como spam — e o remetente marcado leva junto o aviso de prazo.
    await repo.salvar(
      new Assinatura({
        workspace: 'viva',
        plano: 'pecas',
        inicioEm: T0,
        venceEm: dias(3),
        ehTeste: false,
        diasDeCarencia: 7,
      }),
    );
    await repo.salvar(
      new Assinatura({
        workspace: 'cancelada',
        plano: 'pecas',
        inicioEm: T0,
        venceEm: dias(3),
        ehTeste: false,
        diasDeCarencia: 7,
        canceladaEm: dias(1),
      }),
    );

    const lista = await repo.aVencerAte(dias(10));
    expect(lista.map((a) => a.workspace)).toEqual(['viva']);
  });

  it('a vencer respeita o limite de data', async () => {
    for (const [ws, d] of [
      ['perto', 2],
      ['longe', 60],
    ] as const) {
      await repo.salvar(
        new Assinatura({
          workspace: ws,
          plano: 'pecas',
          inicioEm: T0,
          venceEm: dias(d),
          ehTeste: false,
          diasDeCarencia: 7,
        }),
      );
    }

    expect((await repo.aVencerAte(dias(5))).map((a) => a.workspace)).toEqual(['perto']);
  });

  it('plano desconhecido no banco vira erro nomeado ao ser resolvido, não objeto inválido', async () => {
    // Linha editada à mão. Desde a v0.28.0 o repositório de assinaturas não
    // conhece o catálogo (os planos são dado, em outra tabela); quem resolve
    // o código em plano é o serviço — e é lá que o erro nomeado precisa sair,
    // em vez de um "plano undefined" circulando até estourar longe da causa.
    db.prepare(
      `INSERT INTO assinaturas (workspace, plano, inicio_em, vence_em, eh_teste, dias_carencia)
       VALUES ('ws1', 'platina', ?, ?, 0, 7)`,
    ).run(T0.toISOString(), dias(30).toISOString());

    const servico = new ServicoAssinaturas({
      repositorio: repo,
      planos: new RepositorioPlanosSqlite(db),
      regras: new RepositorioRegrasDeAssinaturaSqlite(db),
      usuarios: {} as RepositorioUsuarios,
      logger: loggerSilencioso,
    });
    await expect(servico.exigir('ws1', 'consulta')).rejects.toThrow(
      PlanoDesconhecidoError,
    );
    await expect(servico.resumo('ws1')).rejects.toThrow(PlanoDesconhecidoError);
  });
});

describe('retrocarga de assinaturas no arranque', () => {
  let pasta: string;
  let caminho: string;

  beforeEach(() => {
    pasta = mkdtempSync(join(tmpdir(), 'processovivo-assin-'));
    caminho = join(pasta, 'processovivo.db');
  });

  afterEach(() => rmSync(pasta, { recursive: true, force: true }));

  it('conta que já existia ganha assinatura ativa ao subir', async () => {
    /*
     * O teste que evita transformar a entrega da cobrança num bloqueio em
     * massa. Sem retrocarga, o advogado que usou o sistema ontem abre hoje e
     * encontra "sua assinatura venceu" sobre a carteira que ele montou à mão —
     * e a vigilância dele teria parado em silêncio no meio.
     */
    const antes = abrirBanco(caminho);
    inserirConta(antes, 'u1', 'ws-antiga');
    // Apaga a assinatura que a própria abertura criou, para simular o banco
    // como ele estava ANTES desta versão existir.
    antes.exec("DELETE FROM assinaturas WHERE workspace = 'ws-antiga'");
    antes.close();

    const depois = abrirBanco(caminho);
    const repo = new RepositorioAssinaturasSqlite(depois);
    const a = await repo.porWorkspace('ws-antiga');

    expect(a).toBeDefined();
    expect(a?.estaVigenteEm(new Date())).toBe(true);
    expect(a?.ehTeste).toBe(false);
    // No plano mais completo à venda: quem entrou antes da cobrança existir
    // não pode ser rebaixado por uma atualização.
    expect(a?.plano).toBe('pecas');
    const pecas = PLANOS_INICIAIS.find((p) => p.codigo === 'pecas');
    if (!pecas) throw new Error('semente sem o plano pecas');
    expect(a?.permite('pecas', new Date(), pecas)).toBe(true);
    depois.close();
  });

  it('não mexe em quem já tem assinatura', async () => {
    const db = abrirBanco(caminho);
    inserirConta(db, 'u1', 'ws1');
    const repo = new RepositorioAssinaturasSqlite(db);
    await repo.salvar(
      new Assinatura({
        workspace: 'ws1',
        plano: 'acompanhamento',
        inicioEm: T0,
        venceEm: dias(10),
        ehTeste: false,
        diasDeCarencia: 7,
        observacao: 'combinado com o cliente',
      }),
    );
    db.close();

    // Sobe de novo: a retrocarga roda em toda abertura e precisa ser inócua
    // para quem já está resolvido. Sem isso, cada deploy promoveria todo mundo
    // ao plano de cima por mais um ano.
    const db2 = abrirBanco(caminho);
    const a = await new RepositorioAssinaturasSqlite(db2).porWorkspace('ws1');
    expect(a?.plano).toBe('acompanhamento');
    expect(a?.venceEm.toISOString()).toBe(dias(10).toISOString());
    expect(a?.observacao).toBe('combinado com o cliente');
    db2.close();
  });
});
