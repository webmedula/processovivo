import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { resumoParaATela } from '../../src/application/services/ServicoResumoDoProcesso.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioResumosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioResumosSqlite.js';

/*
 * Resumos gravados por versões anteriores do prompt continuam legíveis (v0.56.0). Não existe cache de resumo — cada
 * clique chama o modelo de novo, e a versão do prompt vai gravada em cada linha —, então "cache por versão" é isto:
 * a linha antiga e a nova convivem na mesma tabela, cada uma com a sua versão.
 */
describe('resumos gravados por versões antigas do prompt', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = abrirBanco(':memory:');
  });

  function gravarCru(
    id: string,
    versao: string,
    resultado: object,
    contagens: object,
  ): void {
    db.prepare(
      `INSERT INTO resumos_ia
         (id, workspace, numero, resultado, atos_enviados, contagens, modelo, versao_prompt,
          provedor, latencia_ms, criada_em)
       VALUES (?, 'ws-a', '99999019620268099999', ?, '[]', ?, 'modelo/teste', ?, 'p', 100, '2026-10-01T12:00:00.000Z')`,
    ).run(id, JSON.stringify(resultado), JSON.stringify(contagens), versao);
  }

  it('uma linha da 1.0.0 (sem os campos de 0.54.0 e 0.56.0) volta inteira e vira resposta de tela', async () => {
    gravarCru(
      'r-velho',
      'resumo-1.0.0',
      {
        estado: 'verificado',
        situacao: [{ texto: 'x', chaveDoAto: 'c1', trecho: 't' }],
        pendencias: [],
        pontosDeAtencao: [],
      },
      {
        atosNoProcesso: 3,
        atosComTexto: 2,
        atosSoTitulo: 1,
        foraDoResumo: 0,
        itensDescartados: 0,
        providenciasDoSistema: 0,
        providenciasNaoCitadas: 0,
      },
    );
    const r = await new RepositorioResumosSqlite(db).buscar('ws-a', 'r-velho');
    expect(r?.procedencia.versaoPrompt).toBe('resumo-1.0.0');
    const tela = resumoParaATela(r!, new Map(), (t) => t);
    expect(tela.estado).toBe('verificado');
    expect(tela.versaoPrompt).toBe('resumo-1.0.0');
    expect(tela.pontosDoAto).toEqual([]);
    expect(tela.contagens.maisRecenteLido).toBeUndefined();
  });

  it('um "não verificado" por falta do ato mais recente (1.2.0) também volta, ao lado da linha antiga', async () => {
    gravarCru(
      'r-novo',
      'resumo-1.2.0',
      { estado: 'nao_verificado', motivo: 'sem_ato_mais_recente' },
      {
        atosNoProcesso: 3,
        atosComTexto: 2,
        atosSoTitulo: 1,
        foraDoResumo: 0,
        itensDescartados: 1,
        providenciasDoSistema: 0,
        providenciasNaoCitadas: 0,
        maisRecenteLido: true,
      },
    );
    const repo = new RepositorioResumosSqlite(db);
    const r = await repo.buscar('ws-a', 'r-novo');
    expect(r?.resultado).toEqual({
      estado: 'nao_verificado',
      motivo: 'sem_ato_mais_recente',
    });
    expect(resumoParaATela(r!, new Map(), (t) => t).estado).toBe('nao_verificado');
    // A conta errada não lê a linha: "não existe" e "é de outra conta" são o mesmo.
    expect(await repo.buscar('ws-b', 'r-novo')).toBeUndefined();
  });
});
