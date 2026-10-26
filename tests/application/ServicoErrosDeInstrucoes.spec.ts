import { beforeEach, describe, expect, it } from 'vitest';
import { ServicoErrosDeInstrucoes } from '../../src/application/services/ServicoErrosDeInstrucoes.js';
import { ServicoInstrucoesDeIa } from '../../src/application/services/ServicoInstrucoesDeIa.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import {
  LeitorDeErrosDeIaSqlite,
  RepositorioDeInstrucoesDeIaSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositorioDeInstrucoesDeIaSqlite.js';
import {
  LeitorDeUsoDeIaSqlite,
  RegistroDeOcorrenciasDeIaSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';
import { LoggerColetor } from '../helpers/analiseIa.js';

/*
 * "Onde a IA erra": polegares por EDIÇÃO das instruções, lidos das mesmas tabelas da Fase A, sem o conteúdo
 * da análise. Banco em memória, linhas SINTÉTICAS.
 */

class Relogio implements Clock {
  ms = new Date('2026-10-26T12:00:00.000Z').getTime();
  agora(): Date {
    return new Date(this.ms);
  }
  monotonico(): number {
    return this.ms;
  }
}

let relogio: Relogio;
let db: ReturnType<typeof abrirBanco>;
let servico: ServicoErrosDeInstrucoes;
let instrucoes: ServicoInstrucoesDeIa;
let n = 0;
const WS = 'abcdef0123456789abcdef0123456789';

function analise(
  tabela: 'analises_ia' | 'resumos_ia' | 'analises_pecas_ia',
  v: {
    versao: string;
    avaliacao?: 'util' | 'errado' | 'perigoso' | null;
    motivo?: string | null;
    estado?: string;
    diasAtras?: number;
    ws?: string;
  },
): void {
  const quando = new Date(relogio.ms - (v.diasAtras ?? 1) * 86_400_000).toISOString();
  const resultado = JSON.stringify({
    estado: v.estado ?? (tabela === 'resumos_ia' ? 'verificado' : 'verificada'),
    resumo: 'TEXTO-SECRETO-DA-ANALISE',
  });
  const id = `x-${++n}`;
  const comum = {
    id,
    ws: v.ws ?? WS,
    resultado,
    versao: v.versao,
    quando,
    avaliacao: v.avaliacao ?? null,
  };
  if (tabela === 'analises_ia') {
    db.prepare(
      `INSERT INTO analises_ia (id, workspace, numero, chave_do_ato, resultado, modelo, versao_prompt, provedor, latencia_ms, criada_em, avaliacao)
       VALUES (?, ?, '1', 'c', ?, 'fab/modelo', ?, 'prov', 10, ?, ?)`,
    ).run(
      comum.id,
      comum.ws,
      comum.resultado,
      comum.versao,
      comum.quando,
      comum.avaliacao,
    );
  } else if (tabela === 'resumos_ia') {
    db.prepare(
      `INSERT INTO resumos_ia (id, workspace, numero, resultado, atos_enviados, contagens, modelo, versao_prompt, provedor, latencia_ms, criada_em, avaliacao)
       VALUES (?, ?, '1', ?, '[]', '{}', 'fab/modelo', ?, 'prov', 10, ?, ?)`,
    ).run(
      comum.id,
      comum.ws,
      comum.resultado,
      comum.versao,
      comum.quando,
      comum.avaliacao,
    );
    if (v.motivo) {
      // resumos_ia ganha motivo_avaliacao na v0.52.0 (coluna aditiva)
      db.prepare('UPDATE resumos_ia SET motivo_avaliacao = ? WHERE id = ?').run(
        v.motivo,
        id,
      );
    }
    return;
  } else {
    db.prepare(
      `INSERT INTO analises_pecas_ia (id, workspace, processo_chave, peca_id, hash_bytes, resultado, contagens, modelo, modelo_pedido, versao_prompt, provedor, latencia_ms, criada_em, expira_em, avaliacao)
       VALUES (?, ?, 'k', 'p', 'h', ?, '{}', 'fab/modelo', 'fab/modelo', ?, 'prov', 10, ?, '2099-01-01T00:00:00.000Z', ?)`,
    ).run(
      comum.id,
      comum.ws,
      comum.resultado,
      comum.versao,
      comum.quando,
      comum.avaliacao,
    );
  }
  if (v.motivo) {
    db.prepare(`UPDATE ${tabela} SET motivo_avaliacao = ? WHERE id = ?`).run(
      v.motivo,
      id,
    );
  }
}

beforeEach(() => {
  relogio = new Relogio();
  db = abrirBanco(':memory:');
  n = 0;
  const logger = new LoggerColetor();
  instrucoes = new ServicoInstrucoesDeIa({
    repositorio: new RepositorioDeInstrucoesDeIaSqlite(db),
    textosFixos: {
      ato: { fixa: 'F', formato: '' },
      resumo: { fixa: 'F', formato: '' },
      peca: { fixa: 'F', formato: '' },
    },
    clock: relogio,
    logger,
    validadeDoCacheMs: 0,
  });
  servico = new ServicoErrosDeInstrucoes({
    leitor: new LeitorDeUsoDeIaSqlite(
      db,
      new RegistroDeOcorrenciasDeIaSqlite(db, relogio, logger),
    ),
    erros: new LeitorDeErrosDeIaSqlite(db),
    instrucoes,
    clock: relogio,
  });
});

describe('polegares por edição das instruções', () => {
  it('agrupa por +eN (versão sem sufixo = +e0) e conta útil, errado, perigoso e sem avaliação', () => {
    analise('analises_ia', { versao: 'ato-1.2.0', avaliacao: 'util' });
    analise('analises_ia', {
      versao: 'ato-1.2.0',
      avaliacao: 'errado',
      motivo: 'erro_de_fato',
    });
    analise('analises_ia', { versao: 'ato-1.2.0+e1', avaliacao: 'util' });
    analise('analises_ia', {
      versao: 'ato-1.2.0+e1',
      avaliacao: 'perigoso',
      motivo: 'pode_causar_prejuizo',
    });
    analise('analises_ia', { versao: 'ato-1.2.0+e1', avaliacao: null });
    analise('analises_ia', { versao: 'ato-1.2.0+e1', estado: 'nao_verificada' });
    const r = servico.consultar('ato');
    expect(
      r.porEdicao.map((e) => [
        e.rotulo,
        e.analises,
        e.uteis,
        e.erradas,
        e.perigosas,
        e.semAvaliacao,
        e.naoVerificadas,
      ]),
    ).toEqual([
      ['+e1', 4, 1, 0, 1, 2, 1],
      ['+e0', 2, 1, 1, 0, 0, 0],
    ]);
  });

  it('"a versão atual" é a que está em produção agora, mesmo sem nenhuma análise ainda', () => {
    expect(servico.consultar('resumo').atual).toMatchObject({
      edicao: 0,
      rotulo: '+e0',
      analises: 0,
    });
    analise('resumos_ia', { versao: 'resumo-1.2.0+e1', avaliacao: 'errado' });
    const a = instrucoes.salvarRascunho('ab12cd34', 'resumo', 'Texto', '');
    instrucoes.publicar('ab12cd34', 'resumo', { versao: a.versao, confirmado: true });
    expect(servico.consultar('resumo').atual).toMatchObject({
      edicao: 1,
      rotulo: '+e1',
      analises: 1,
      erradas: 1,
    });
  });

  it('lista os polegares para baixo mais recentes, com o motivo de lista fechada, por versão — nunca o conteúdo', () => {
    analise('analises_ia', {
      versao: 'ato-1.2.0',
      avaliacao: 'errado',
      motivo: 'citacao_inventada',
      diasAtras: 5,
    });
    analise('analises_ia', {
      versao: 'ato-1.2.0+e1',
      avaliacao: 'errado',
      motivo: 'pode_causar_prejuizo',
      diasAtras: 1,
    });
    analise('analises_ia', { versao: 'ato-1.2.0+e1', avaliacao: 'util', diasAtras: 1 });
    analise('analises_ia', {
      versao: 'ato-1.2.0+e1',
      avaliacao: 'errado',
      motivo: null,
      diasAtras: 2,
    });
    const r = servico.consultar('ato');
    expect(
      r.recentes.map((e) => [e.versao, e.avaliacao, e.motivo, e.motivoRotulo]),
    ).toEqual([
      ['ato-1.2.0+e1', 'errado', 'pode_causar_prejuizo', 'pode causar prejuízo'],
      ['ato-1.2.0+e1', 'errado', null, null],
      ['ato-1.2.0+e0', 'errado', 'citacao_inventada', 'citação inventada'],
    ]);
    const tudo = JSON.stringify(r);
    expect(tudo).not.toContain('TEXTO-SECRETO');
    // só 8 caracteres da conta
    expect(r.recentes[0]?.conta).toBe(WS.slice(0, 8));
    expect(tudo).not.toContain(WS);
  });

  it('as três funções, cada uma na sua tabela', () => {
    analise('resumos_ia', {
      versao: 'resumo-1.2.0',
      avaliacao: 'errado',
      motivo: 'deixou_de_fora',
    });
    analise('analises_pecas_ia', {
      versao: 'peca-1.1.0+e2',
      avaliacao: 'errado',
      motivo: 'outro',
    });
    expect(servico.consultar('resumo').recentes.map((e) => e.motivo)).toEqual([
      'deixou_de_fora',
    ]);
    expect(servico.consultar('peca').recentes.map((e) => [e.versao, e.motivo])).toEqual([
      ['peca-1.1.0+e2', 'outro'],
    ]);
    expect(servico.consultar('ato').recentes).toEqual([]);
  });

  it('só olha os últimos 30 dias', () => {
    analise('analises_ia', { versao: 'ato-1.2.0', avaliacao: 'errado', diasAtras: 45 });
    analise('analises_ia', { versao: 'ato-1.2.0', avaliacao: 'errado', diasAtras: 10 });
    const r = servico.consultar('ato');
    expect(r.recentes).toHaveLength(1);
    expect(r.porEdicao[0]?.analises).toBe(1);
  });

  it('função desconhecida é recusada', () => {
    expect(() => servico.consultar('forjada')).toThrow();
  });
});
