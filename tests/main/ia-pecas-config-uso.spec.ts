import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modoDaAnaliseDePeca } from '../../src/application/politicas/liberacaoDaAnaliseDePeca.js';
import type { AnaliseDePeca } from '../../src/domain/entities/AnaliseDePeca.js';
import {
  carregarConfig,
  lerListaDeWorkspaces,
} from '../../src/infrastructure/config/env.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAnalisesDePecaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAnalisesDePecaSqlite.js';
import { executarAvaliacoesDeIa } from '../../src/main/sonda/avaliacoesDeIa.js';
import { executarUsoDaAnaliseDePeca } from '../../src/main/sonda/usoDaAnaliseDePeca.js';

/* Liberação por chave + lista de contas, configuração e os relatórios de leitura. Dados sintéticos. */
const BASE = { LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv;
const WS_A = 'a1b2c3d4e5f60718';
const WS_B = '0123456789abcdef0123456789abcdef';
const SEGREDO = 'TRECHO-QUE-NAO-PODE-SAIR-NO-RELATORIO';

describe('configuração da análise de peça', () => {
  it('nasce desligada, sem lista, com o modelo de produção e 30 dias de guarda', () => {
    const p = carregarConfig(BASE).ia.pecas;
    expect(p.habilitada).toBe(false);
    expect(p.workspaces).toEqual([]);
    expect(p.modelo).toBe(carregarConfig(BASE).ia.modelo);
    expect(p.resultadoDias).toBe(30);
  });

  it('a lista aceita ids de 16 e de 32 hex, separados por vírgula, espaço ou ponto e vírgula; ignora repetidos e conta os inválidos sem repeti-los', () => {
    const r = lerListaDeWorkspaces(
      ` ${WS_A.toUpperCase()}, ${WS_B};${WS_A} segredo-torto `,
    );
    expect(r.workspaces).toEqual([WS_A, WS_B]);
    expect(r.workspacesInvalidos).toBe(1);
    expect(JSON.stringify(r)).not.toContain('segredo-torto');
  });

  it('modelo de peça próprio vale; apelido ou variante derruba o arranque', () => {
    expect(
      carregarConfig({ ...BASE, PROCESSOVIVO_IA_PECAS_MODELO: 'fab/modelo-p' }).ia.pecas
        .modelo,
    ).toBe('fab/modelo-p');
    expect(() =>
      carregarConfig({
        ...BASE,
        PROCESSOVIVO_IA_HABILITADA: 'true',
        OPENROUTER_API_KEY: 'sk-or-v1-chave-sintetica-0123456789abcdef',
        PROCESSOVIVO_IA_PECAS_MODELO: '~fab/modelo:online',
      }),
    ).toThrow(/PROCESSOVIVO_IA_PECAS_MODELO/);
  });
});

describe('política de liberação', () => {
  it('sem as duas chaves: ninguém; só a lista: modo avaliação; chave geral: modo geral para todos', () => {
    expect(
      modoDaAnaliseDePeca(WS_A, { habilitada: false, workspaces: [] }),
    ).toBeUndefined();
    expect(modoDaAnaliseDePeca(WS_A, { habilitada: false, workspaces: [WS_A] })).toBe(
      'avaliacao',
    );
    expect(
      modoDaAnaliseDePeca(WS_B, { habilitada: false, workspaces: [WS_A] }),
    ).toBeUndefined();
    expect(modoDaAnaliseDePeca(WS_B, { habilitada: true, workspaces: [WS_A] })).toBe(
      'geral',
    );
    expect(
      modoDaAnaliseDePeca(WS_A.toUpperCase(), { habilitada: false, workspaces: [WS_A] }),
    ).toBe('avaliacao');
  });
});

let pasta: string;
let caminho: string;
beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), 'pv-pecas-uso-'));
  caminho = join(pasta, 'p.db');
});
afterEach(() => rmSync(pasta, { recursive: true, force: true }));

const analise = (
  n: number,
  ws: string,
  extra: Partial<AnaliseDePeca> = {},
): AnaliseDePeca => ({
  id: `ap-${n}`,
  workspace: ws,
  processoChave: 'c'.repeat(64),
  pecaId: `peca-${n}`,
  hashDosBytes: 'h'.repeat(64),
  resultado: {
    estado: 'verificada',
    tipo: 'peticao_inicial',
    emUmaFrase: 'x',
    pedidos: [{ texto: 'pede', trecho: SEGREDO, pagina: 1 }],
    alegacoes: [],
    preliminares: [],
    documentos: [],
    valores: [],
    pontosDeAtencao: [],
  },
  contagens: { paginas: 3, caracteres: 900, itensDescartados: 0, peso: 5 },
  procedencia: {
    modelo: 'fab/modelo-a',
    versaoPrompt: 'peca-1.0.0',
    provedor: 'p',
    criadaEm: new Date('2026-10-22T15:00:00Z'),
  },
  modeloPedido: 'fab/modelo-a',
  medidas: { latenciaMs: 1000 * n, custoUsd: 0.002 * n },
  criadaEm: new Date('2026-10-22T15:00:00Z'),
  expiraEm: new Date('2026-11-21T15:00:00Z'),
  ...extra,
});

function uso(): { codigo: number; saida: string } {
  const saida: string[] = [];
  const codigo = executarUsoDaAnaliseDePeca([], {
    caminhoBanco: caminho,
    agora: () => new Date('2026-10-22T18:00:00Z'),
    saida: (l) => saida.push(l),
    aviso: (l) => saida.push(l),
  });
  return { codigo, saida: saida.join('\n') };
}

describe('comando de uso por conta (somente leitura)', () => {
  it('conta as análises vigentes de cada conta, o peso de hoje e o custo — sem nenhum texto', async () => {
    const db = abrirBanco(caminho);
    const repo = new RepositorioAnalisesDePecaSqlite(db);
    await repo.salvar(analise(1, WS_A));
    await repo.salvar(analise(2, WS_A, { avaliacao: 'util' }));
    await repo.salvar(analise(3, WS_B, { criadaEm: new Date('2026-10-20T15:00:00Z') }));
    await repo.salvar(analise(4, WS_B, { expiraEm: new Date('2026-10-21T00:00:00Z') })); // vencida
    db.close();
    const r = uso();
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain(
      `${WS_A} · vigentes 2 · hoje 2 (peso no teto: até 10) · avaliadas 1`,
    );
    expect(r.saida).toContain(`${WS_B} · vigentes 1 · hoje 0`);
    expect(r.saida).toContain('Total: 3 análise(s) vigente(s) em 2 conta(s).');
    expect(r.saida).not.toContain(SEGREDO);
  });

  it('argumento desconhecido: código 2; banco inexistente: código 1', () => {
    expect(
      executarUsoDaAnaliseDePeca(['--x'], {
        caminhoBanco: caminho,
        agora: () => new Date(),
        saida: () => {},
        aviso: () => {},
      }),
    ).toBe(2);
    expect(uso().codigo).toBe(1);
  });
});

describe('ia-avaliacoes: seção de peça', () => {
  it('traz modelo, prompt, avaliações e custo das análises de peça, sem o resultado', async () => {
    const db = abrirBanco(caminho);
    const repo = new RepositorioAnalisesDePecaSqlite(db);
    await repo.salvar(
      analise(1, WS_A, { avaliacao: 'errado', motivoDaAvaliacao: 'erro_de_fato' }),
    );
    await repo.salvar(analise(2, WS_A));
    db.close();
    const saida: string[] = [];
    const codigo = executarAvaliacoesDeIa([], {
      caminhoBanco: caminho,
      saida: (l) => saida.push(l),
      aviso: (l) => saida.push(l),
    });
    const t = saida.join('\n');
    expect(codigo).toBe(0);
    expect(t).toContain('Análises de peça');
    expect(t).toContain('peca-1.0.0');
    expect(t).toContain('fab/modelo-a');
    expect(t).not.toContain(SEGREDO);
  });
});
