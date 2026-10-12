import { describe, expect, it } from 'vitest';
import type { ResumoDoProcesso } from '../../src/domain/entities/ResumoDoProcesso.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioResumosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioResumosSqlite.js';

const RESUMO: ResumoDoProcesso = {
  id: 'r-1',
  workspace: 'ws-a',
  numero: '12345674720238260100',
  resultado: {
    estado: 'verificado',
    situacao: [{ texto: '[PARTE A] foi intimada.', chaveDoAto: 'k1', trecho: 'trecho' }],
    pendencias: [],
    pontosDeAtencao: ['texto_incompleto'],
  },
  atosEnviados: [
    { chaveDoAto: 'k1', data: new Date('2026-10-05T12:00:00Z'), comTexto: true },
  ],
  contagens: {
    atosNoProcesso: 1,
    atosComTexto: 1,
    atosSoTitulo: 0,
    foraDoResumo: 0,
    itensDescartados: 0,
    providenciasDoSistema: 1,
    providenciasNaoCitadas: 0,
  },
  procedencia: {
    modelo: 'm',
    versaoPrompt: 'resumo-1.0.0',
    provedor: 'p',
    criadaEm: new Date('2026-10-06T15:00:00Z'),
  },
  medidas: { latenciaMs: 1234, tokensEntrada: 10, tokensSaida: 5, custoUsd: 0.001 },
};

describe('RepositorioResumosSqlite', () => {
  it('guarda e devolve o resumo igual, só para o workspace dono', async () => {
    const repo = new RepositorioResumosSqlite(abrirBanco(':memory:'));
    await repo.salvar(RESUMO);
    expect(await repo.buscar('ws-a', 'r-1')).toMatchObject({
      id: 'r-1',
      resultado: RESUMO.resultado,
      contagens: RESUMO.contagens,
      medidas: RESUMO.medidas,
    });
    expect(await repo.buscar('ws-b', 'r-1')).toBeUndefined();
  });

  it('avaliação: o dono grava e corrige; outra conta recebe false', async () => {
    const repo = new RepositorioResumosSqlite(abrirBanco(':memory:'));
    await repo.salvar(RESUMO);
    expect(await repo.avaliar('ws-a', 'r-1', 'util')).toBe(true);
    expect(await repo.avaliar('ws-a', 'r-1', 'errado')).toBe(true);
    expect((await repo.buscar('ws-a', 'r-1'))?.avaliacao).toBe('errado');
    expect(await repo.avaliar('ws-b', 'r-1', 'perigoso')).toBe(false);
    expect(await repo.avaliar('ws-a', 'nao-existe', 'util')).toBe(false);
    expect((await repo.buscar('ws-a', 'r-1'))?.avaliacao).toBe('errado');
  });

  it('a migração é aditiva: abrir o banco duas vezes não estoura', () => {
    expect(() => {
      abrirBanco(':memory:');
      abrirBanco(':memory:');
    }).not.toThrow();
  });
});
