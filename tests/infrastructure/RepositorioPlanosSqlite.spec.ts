import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLANOS_INICIAIS } from '../../src/domain/entities/Plano.js';
import { REGRAS_PADRAO } from '../../src/domain/entities/RegrasDeAssinatura.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import {
  RepositorioPlanosSqlite,
  RepositorioRegrasDeAssinaturaSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositorioPlanosSqlite.js';

describe('RepositorioPlanosSqlite', () => {
  let db: DatabaseSync;
  let repo: RepositorioPlanosSqlite;

  beforeEach(() => {
    db = abrirBanco(':memory:');
    repo = new RepositorioPlanosSqlite(db);
  });
  afterEach(() => db.close());

  it('o banco novo já nasce com os três planos da semente, idênticos', async () => {
    // As assinaturas de antes da v0.28.0 apontam para estes códigos: se a
    // semente não entrasse, a primeira consulta de cada assinante falharia.
    expect(await repo.listar()).toEqual(
      PLANOS_INICIAIS.map((p) => ({ ...p, recursos: [...p.recursos] })),
    );
  });

  it('salva e lê um plano novo, com preço nulo ou inteiro', async () => {
    await repo.salvar({
      codigo: 'escritorio',
      nome: 'Escritório',
      resumo: 'Tudo do Peças.',
      recursos: ['consulta', 'pecas'],
      disponivelParaContratacao: true,
      precoMensalCentavos: 19900,
      ordem: 40,
    });
    const lido = await repo.porCodigo('escritorio');
    expect(lido?.precoMensalCentavos).toBe(19900);
    expect(lido?.recursos).toEqual(['consulta', 'pecas']);
    expect(lido?.disponivelParaContratacao).toBe(true);
  });

  it('salvar de novo substitui pelo código', async () => {
    const pecas = await repo.porCodigo('pecas');
    if (!pecas) throw new Error('semente sem pecas');
    await repo.salvar({ ...pecas, nome: 'Peças Pro', precoMensalCentavos: 9990 });

    expect((await repo.porCodigo('pecas'))?.nome).toBe('Peças Pro');
    expect(await repo.listar()).toHaveLength(3);
  });

  it('recurso desconhecido gravado à mão não entra no domínio', async () => {
    db.prepare("UPDATE planos SET recursos = ? WHERE codigo = 'pecas'").run(
      JSON.stringify(['consulta', 'teletransporte']),
    );
    expect((await repo.porCodigo('pecas'))?.recursos).toEqual(['consulta']);
  });

  it('plano inexistente é undefined', async () => {
    expect(await repo.porCodigo('platina')).toBeUndefined();
  });
});

describe('semente de planos no arranque', () => {
  let pasta: string;
  let caminho: string;

  beforeEach(() => {
    pasta = mkdtempSync(join(tmpdir(), 'processovivo-planos-'));
    caminho = join(pasta, 'processovivo.db');
  });
  afterEach(() => rmSync(pasta, { recursive: true, force: true }));

  it('NÃO reescreve o catálogo que o operador editou', async () => {
    const primeira = abrirBanco(caminho);
    const repo = new RepositorioPlanosSqlite(primeira);
    const pecas = await repo.porCodigo('pecas');
    if (!pecas) throw new Error('semente sem pecas');
    await repo.salvar({ ...pecas, nome: 'Peças Premium', precoMensalCentavos: 12900 });
    primeira.close();

    const segunda = abrirBanco(caminho);
    const lido = await new RepositorioPlanosSqlite(segunda).porCodigo('pecas');
    expect(lido?.nome).toBe('Peças Premium');
    expect(lido?.precoMensalCentavos).toBe(12900);
    segunda.close();
  });
});

describe('RepositorioRegrasDeAssinaturaSqlite', () => {
  let db: DatabaseSync;
  let repo: RepositorioRegrasDeAssinaturaSqlite;

  beforeEach(() => {
    db = abrirBanco(':memory:');
    repo = new RepositorioRegrasDeAssinaturaSqlite(db);
  });
  afterEach(() => db.close());

  it('sem nada gravado, valem as regras padrão', async () => {
    expect(await repo.ler()).toEqual(REGRAS_PADRAO);
  });

  it('grava e regrava a linha única', async () => {
    await repo.salvar({
      diasDeTeste: 7,
      planoDoTeste: 'acompanhamento',
      diasDeCarencia: 3,
    });
    await repo.salvar({ diasDeTeste: 10, planoDoTeste: 'pecas', diasDeCarencia: 5 });

    expect(await repo.ler()).toEqual({
      diasDeTeste: 10,
      planoDoTeste: 'pecas',
      diasDeCarencia: 5,
    });
    const { total } = db
      .prepare('SELECT COUNT(*) AS total FROM regras_assinatura')
      .get() as {
      total: number;
    };
    expect(total).toBe(1);
  });
});
