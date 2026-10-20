import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cancelarCusto, criarCusto } from '../../src/domain/entities/Custo.js';
import { criarRecebimento } from '../../src/domain/entities/Recebimento.js';
import { gerarBackup } from '../../src/infrastructure/persistencia/backup.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDeCustosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeCustosSqlite.js';

/* v0.47.0: os custos entram no backup do banco como os demais dados. Valores sintéticos. */
describe('backup do banco com o centro de custos', () => {
  let pasta: string;
  beforeEach(() => {
    pasta = mkdtempSync(join(tmpdir(), 'pv-backup-custos-'));
  });
  afterEach(() => rmSync(pasta, { recursive: true, force: true }));

  it('lançamentos, cancelados, recebimentos, histórico e subcategorias próprias voltam do arquivo de backup', async () => {
    const caminho = join(pasta, 'processovivo.db');
    const db = abrirBanco(caminho);
    const repo = new RepositorioDeCustosSqlite(db);
    const criadoEm = new Date('2026-10-20T12:00:00Z');
    const base = { workspace: 'ws-a', numeroProcesso: '12345674720238260100', criadoEm };
    const custo = criarCusto(
      { id: 'c1', ...base },
      {
        data: '2026-10-01',
        descricao: 'Guia de custas',
        categoria: 'CUS-020',
        valorCentavos: 12_345,
        reembolsavel: true,
      },
      '2026-10-20',
    );
    const evento = (
      id: string,
      entidade: 'lancamento' | 'recebimento',
      entidadeId: string,
    ) => ({
      id,
      workspace: 'ws-a',
      numeroProcesso: base.numeroProcesso,
      entidade,
      entidadeId,
      operacao: 'criou' as const,
      quando: criadoEm,
      campos: [],
    });
    await repo.inserir(custo, evento('e1', 'lancamento', 'c1'));
    // Um lançamento CANCELADO também vai no backup: cancelar não apaga.
    await repo.inserir(
      cancelarCusto(
        criarCusto(
          { id: 'c2', ...base },
          {
            data: '2026-10-02',
            descricao: 'Cancelado',
            categoria: 'OUT-001',
            valorCentavos: 100,
            reembolsavel: false,
          },
          '2026-10-20',
        ),
        'engano',
        new Date('2026-10-21T12:00:00Z'),
      ),
      evento('e2', 'lancamento', 'c2'),
    );
    await repo.inserirRecebimento(
      criarRecebimento(
        { id: 'r1', ...base },
        { data: '2026-10-05', valorCentavos: 5_000 },
        '2026-10-20',
      ),
      evento('e3', 'recebimento', 'r1'),
    );
    // v0.49.0: o vínculo do comprovante (o ARQUIVO mora no Drive; aqui só id, link, nome, tamanho).
    await repo.inserirComprovante(
      {
        id: 'k1',
        workspace: 'ws-a',
        custoId: 'c1',
        numeroProcesso: base.numeroProcesso,
        arquivoId: 'arquivo-no-drive',
        link: 'https://drive.google.com/file/d/arquivo-no-drive/view',
        nome: 'guia.pdf',
        tipo: 'application/pdf',
        tamanho: 1234,
        anexadoEm: criadoEm,
      },
      5,
      evento('e4', 'lancamento', 'c1'),
    );
    await repo.inserirCategoria({
      id: 'k1',
      workspace: 'ws-a',
      nome: 'Cartório',
      grupo: '06',
      arquivada: false,
      criadaEm: criadoEm,
    });

    const r = gerarBackup({
      caminhoBanco: caminho,
      destino: join(pasta, 'backups'),
      manter: 3,
    });
    db.close();
    expect(r.integro).toBe(true);

    const copia = new DatabaseSync(r.caminho, { readOnly: true });
    expect(
      copia
        .prepare('SELECT valor_centavos AS v FROM custos_processo WHERE id = ?')
        .get('c1'),
    ).toMatchObject({ v: 12_345 });
    expect(
      copia
        .prepare('SELECT nome, grupo FROM categorias_custo WHERE workspace = ?')
        .get('ws-a'),
    ).toMatchObject({ nome: 'Cartório', grupo: '06' });
    expect(
      copia
        .prepare('SELECT cancelado_motivo AS m FROM custos_processo WHERE id = ?')
        .get('c2'),
    ).toMatchObject({ m: 'engano' });
    expect(
      copia
        .prepare('SELECT valor_centavos AS v FROM recebimentos_processo WHERE id = ?')
        .get('r1'),
    ).toMatchObject({ v: 5_000 });
    expect(
      copia
        .prepare('SELECT COUNT(*) AS n FROM historico_custos WHERE workspace = ?')
        .get('ws-a'),
    ).toMatchObject({ n: 4 });
    expect(
      copia
        .prepare(
          'SELECT arquivo_id AS a, tamanho AS t FROM comprovantes_custo WHERE id = ?',
        )
        .get('k1'),
    ).toMatchObject({ a: 'arquivo-no-drive', t: 1234 });
    copia.close();
  });
});
