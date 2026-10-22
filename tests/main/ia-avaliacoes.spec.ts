import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnaliseDoAto } from '../../src/domain/entities/AnaliseDoAto.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioResumosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioResumosSqlite.js';
import { RepositorioAnalisesSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAnalisesSqlite.js';
import { executarAvaliacoesDeIa } from '../../src/main/sonda/avaliacoesDeIa.js';

/* Banco em arquivo temporário, dados sintéticos. */
let pasta: string;
let caminho: string;

function analise(n: number, extra: Partial<AnaliseDoAto> = {}): AnaliseDoAto {
  return {
    id: `a-${n}`,
    workspace: 'ws-segredo',
    numero: '12345674720238260100',
    chaveDoAto: 'chave',
    resultado: {
      estado: 'verificada',
      parecePedir: 'manifestar',
      resumo: 'RESUMO-QUE-NAO-PODE-SAIR',
      acoesPossiveis: [],
      pontosDeAtencao: [],
    },
    procedencia: {
      modelo: 'fab/modelo-a',
      versaoPrompt: 'ato-1.0.0',
      provedor: 'p',
      criadaEm: new Date('2026-10-05T12:00:00Z'),
    },
    medidas: { latenciaMs: 1000 * n, custoUsd: 0.001 * n },
    ...extra,
  };
}

function rodar(): { codigo: number; saida: string; aviso: string } {
  const saida: string[] = [];
  const aviso: string[] = [];
  const codigo = executarAvaliacoesDeIa([], {
    caminhoBanco: caminho,
    saida: (l) => saida.push(l),
    aviso: (l) => aviso.push(l),
  });
  return { codigo, saida: saida.join('\n'), aviso: aviso.join('\n') };
}

beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), 'pv-ia-aval-'));
  caminho = join(pasta, 'p.db');
});
afterEach(() => rmSync(pasta, { recursive: true, force: true }));

describe('ia-avaliacoes — somente leitura e sem texto', () => {
  it('agrupa por modelo e versão do prompt com avaliações, não verificadas, p50/p95 e custo médio', async () => {
    const db = abrirBanco(caminho);
    const repo = new RepositorioAnalisesSqlite(db);
    for (let n = 1; n <= 4; n++) await repo.salvar(analise(n));
    await repo.salvar(
      analise(5, {
        resultado: { estado: 'nao_verificada', motivo: 'sem_citacao_valida' },
      }),
    );
    await repo.salvar(
      analise(6, {
        procedencia: {
          modelo: 'fab/modelo-b',
          versaoPrompt: 'ato-1.0.0',
          provedor: 'p',
          criadaEm: new Date('2026-10-05T12:00:00Z'),
        },
        medidas: { latenciaMs: 500 },
      }),
    );
    await repo.avaliar('ws-segredo', 'a-1', 'util');
    await repo.avaliar('ws-segredo', 'a-2', 'util');
    await repo.avaliar('ws-segredo', 'a-3', 'errado');
    await repo.avaliar('ws-segredo', 'a-4', 'perigoso');
    db.close();

    const { codigo, saida } = rodar();
    expect(codigo).toBe(0);
    expect(saida).toContain('Modelo fab/modelo-a · prompt ato-1.0.0');
    expect(saida).toContain('Análises: 5 · avaliadas: 4 · sem avaliação: 1');
    expect(saida).toContain('Útil: 2 (50%) · Errado: 1 (25%) · Perigoso: 1 (25%)');
    expect(saida).toContain('Não verificadas: 1 (20%)');
    expect(saida).toContain('p50 3.0 s · p95 5.0 s');
    expect(saida).toContain('Modelo fab/modelo-b · prompt ato-1.0.0');
    expect(saida).toContain('informado em 0 de 1');
  });

  it('custo: p50, p95 e máximo por modelo e prompt (nearest-rank), além da média (v1.1.0)', async () => {
    const db = abrirBanco(caminho);
    const repo = new RepositorioAnalisesSqlite(db);
    // Custos 0,001 · 0,002 · … · 0,010 (dez análises): p50 = 5º, p95 = 10º (nearest-rank), máximo = 0,010.
    for (let n = 1; n <= 10; n++) {
      await repo.salvar(
        analise(n, { medidas: { latenciaMs: 1000, custoUsd: 0.001 * n } }),
      );
    }
    // Uma sem custo informado não entra nas medidas de custo, e a linha diz quantas tinham.
    await repo.salvar(analise(11, { medidas: { latenciaMs: 1000 } }));
    db.close();
    const { saida } = rodar();
    expect(saida).toContain(
      'Custo médio por análise: US$ 0.00550 (informado em 10 de 11)',
    );
    expect(saida).toContain(
      'Custo p50 US$ 0.00500 · p95 US$ 0.01000 · máximo US$ 0.01000',
    );
  });

  it('sem custo informado em nenhuma análise: p50/p95/máximo dizem "não informado"', async () => {
    const db = abrirBanco(caminho);
    await new RepositorioAnalisesSqlite(db).salvar(
      analise(1, { medidas: { latenciaMs: 1000 } }),
    );
    db.close();
    expect(rodar().saida).toContain(
      'Custo p50 não informado · p95 não informado · máximo não informado',
    );
  });

  it('motivos: conta por motivo só entre Errado/Perigoso, com "sem motivo" e sem tocar em Útil (v1.1.0)', async () => {
    const db = abrirBanco(caminho);
    const repo = new RepositorioAnalisesSqlite(db);
    for (let n = 1; n <= 6; n++) await repo.salvar(analise(n));
    await repo.avaliar('ws-segredo', 'a-1', 'errado', 'erro_de_fato');
    await repo.avaliar('ws-segredo', 'a-2', 'errado', 'erro_de_fato');
    await repo.avaliar('ws-segredo', 'a-3', 'perigoso', 'concluiu_prazo');
    await repo.avaliar('ws-segredo', 'a-4', 'errado'); // sem motivo
    await repo.avaliar('ws-segredo', 'a-5', 'util', 'outro'); // útil nunca guarda motivo
    db.close();
    const { saida } = rodar();
    expect(saida).toContain(
      'Motivos (Errado/Perigoso): erro de fato 2 · citação inventada 0 · concluiu prazo 1 · deixou de fora algo importante 0 · outro 0 · sem motivo 1',
    );
  });

  it('sem nenhuma avaliação errado/perigoso, a linha de motivos não aparece', async () => {
    const db = abrirBanco(caminho);
    const repo = new RepositorioAnalisesSqlite(db);
    await repo.salvar(analise(1));
    await repo.avaliar('ws-segredo', 'a-1', 'util');
    db.close();
    expect(rodar().saida).not.toContain('Motivos (Errado/Perigoso)');
  });

  it('banco de ANTES da v0.52.0 (sem a coluna do motivo) continua sendo lido, sem motivos', async () => {
    const db = abrirBanco(caminho);
    await new RepositorioAnalisesSqlite(db).salvar(analise(1));
    db.exec("UPDATE analises_ia SET avaliacao = 'errado'");
    db.exec('ALTER TABLE analises_ia DROP COLUMN motivo_avaliacao');
    db.close();
    const r = rodar();
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('Errado: 1');
    expect(r.saida).toContain('sem motivo 1');
  });

  it('nunca imprime texto de análise, número de processo nem workspace', async () => {
    const db = abrirBanco(caminho);
    await new RepositorioAnalisesSqlite(db).salvar(analise(1));
    db.close();
    const { saida } = rodar();
    expect(saida).not.toContain('RESUMO-QUE-NAO-PODE-SAIR');
    expect(saida).not.toContain('12345674720238260100');
    expect(saida).not.toContain('ws-segredo');
  });

  it('não escreve no banco (arquivo idêntico antes e depois) e não cria banco que não existe', async () => {
    const db = abrirBanco(caminho);
    await new RepositorioAnalisesSqlite(db).salvar(analise(1));
    db.close();
    const antes = readFileSync(caminho);
    const mtime = statSync(caminho).mtimeMs;
    rodar();
    expect(readFileSync(caminho).equals(antes)).toBe(true);
    expect(statSync(caminho).mtimeMs).toBe(mtime);

    caminho = join(pasta, 'inexistente.db');
    const r = rodar();
    expect(r.codigo).toBe(1);
  });

  it('banco sem análises: diz isso, sem erro', () => {
    abrirBanco(caminho).close();
    const r = rodar();
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('Nenhuma análise registrada ainda.');
  });
  it('lê os resumos de processo em seção separada, sem misturar com as análises de ato', async () => {
    const db = abrirBanco(caminho);
    await new RepositorioAnalisesSqlite(db).salvar(analise(1));
    const repo = new RepositorioResumosSqlite(db);
    const base = {
      workspace: 'ws-segredo',
      numero: '12345674720238260100',
      atosEnviados: [],
      contagens: {
        atosNoProcesso: 1,
        atosComTexto: 1,
        atosSoTitulo: 0,
        foraDoResumo: 0,
        itensDescartados: 0,
        providenciasDoSistema: 0,
        providenciasNaoCitadas: 0,
      },
      procedencia: {
        modelo: 'fab/modelo-r',
        versaoPrompt: 'resumo-1.0.0',
        provedor: 'p',
        criadaEm: new Date('2026-10-05T12:00:00Z'),
      },
      medidas: { latenciaMs: 2000 },
    };
    await repo.salvar({
      ...base,
      id: 'r-1',
      resultado: {
        estado: 'verificado',
        situacao: [{ texto: 'RESUMO-SECRETO', chaveDoAto: 'k', trecho: 't' }],
        pendencias: [],
        pontosDeAtencao: [],
      },
    });
    await repo.salvar({
      ...base,
      id: 'r-2',
      resultado: { estado: 'nao_verificado', motivo: 'sem_item_verificado' },
    });
    await repo.avaliar('ws-segredo', 'r-1', 'util');
    db.close();

    const { codigo, saida } = rodar();
    expect(codigo).toBe(0);
    const [antes, depois] = saida.split('Resumos de processo');
    expect(antes).toContain('Modelo fab/modelo-a · prompt ato-1.0.0');
    expect(antes).not.toContain('resumo-1.0.0');
    expect(depois).toContain('Modelo fab/modelo-r · prompt resumo-1.0.0');
    expect(depois).toContain('Não verificadas: 1 (50%)');
    expect(saida).not.toContain('RESUMO-SECRETO');
    expect(saida).not.toContain('ws-segredo');
  });
});
