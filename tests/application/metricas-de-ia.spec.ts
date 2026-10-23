import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  metricasDeCusto,
  metricasDoConjunto,
} from '../../src/application/politicas/metricasDeIa.js';
import { percentil } from '../../src/application/politicas/estatistica.js';
import { ServicoControleDaIa } from '../../src/application/services/ServicoControleDaIa.js';
import { ServicoPainelDeIa } from '../../src/application/services/ServicoPainelDeIa.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import {
  LeitorDeUsoDeIaSqlite,
  RegistroDeOcorrenciasDeIaSqlite,
  RepositorioDeConfigDeIaSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';
import { agruparAvaliacoes } from '../../src/main/sonda/avaliacoesDeIa.js';
import { LoggerColetor } from '../helpers/analiseIa.js';

/*
 * As métricas do painel de IA (v0.58.0) e a garantia de que o painel e o relatório
 * `scripts/ia-avaliacoes.mjs` fazem a MESMA conta. Banco em memória, linhas SINTÉTICAS.
 */

class Relogio implements Clock {
  ms = new Date('2026-10-05T15:00:00.000Z').getTime();
  agora(): Date {
    return new Date(this.ms);
  }
  monotonico(): number {
    return this.ms;
  }
}

let db: ReturnType<typeof abrirBanco>;
let relogio: Relogio;
let painel: ServicoPainelDeIa;
let ocorrencias: RegistroDeOcorrenciasDeIaSqlite;

interface Linha {
  ws?: string;
  em: string;
  custo: number | null;
  latencia?: number;
  avaliacao?: string | null;
  motivo?: string | null;
  estado?: string;
}

function inserirAto(l: Linha): void {
  db.prepare(
    `INSERT INTO analises_ia (id, workspace, numero, chave_do_ato, resultado, modelo, versao_prompt, provedor,
       custo_usd, latencia_ms, criada_em, avaliacao, motivo_avaliacao, tokens_entrada, tokens_saida)
     VALUES (?, ?, '1', 'c', ?, 'modelo/a', 'ato-1.2.0', 'prov', ?, ?, ?, ?, ?, 100, 20)`,
  ).run(
    `id-${Math.random()}`,
    l.ws ?? 'ws-aaaaaaaa11',
    JSON.stringify({ estado: l.estado ?? 'verificada' }),
    l.custo,
    l.latencia ?? 1000,
    l.em,
    l.avaliacao ?? null,
    l.motivo ?? null,
  );
}

beforeEach(() => {
  db = abrirBanco(':memory:');
  relogio = new Relogio();
  const logger = new LoggerColetor();
  ocorrencias = new RegistroDeOcorrenciasDeIaSqlite(db, relogio, logger);
  painel = new ServicoPainelDeIa({
    controle: new ServicoControleDaIa({
      repositorio: new RepositorioDeConfigDeIaSqlite(db),
      ambiente: {
        permite: { ato: true, resumo: true, peca: true },
        tetoPorContaDoAmbiente: 200,
      },
      clock: relogio,
      logger,
      validadeDoCacheMs: 0,
    }),
    leitor: new LeitorDeUsoDeIaSqlite(db, ocorrencias),
    clock: relogio,
  });
});

describe('metricasDoConjunto', () => {
  it('conta avaliações, motivos e não verificadas; percentis pelo "próximo posto"', () => {
    const m = metricasDoConjunto([
      {
        avaliacao: 'util',
        motivoAvaliacao: null,
        naoVerificada: false,
        latenciaMs: 1000,
        custoUsd: 0.01,
      },
      {
        avaliacao: 'util',
        motivoAvaliacao: null,
        naoVerificada: false,
        latenciaMs: 2000,
        custoUsd: 0.02,
      },
      {
        avaliacao: 'errado',
        motivoAvaliacao: 'erro_de_fato',
        naoVerificada: false,
        latenciaMs: 3000,
        custoUsd: 0.03,
      },
      {
        avaliacao: 'perigoso',
        motivoAvaliacao: 'pode_causar_prejuizo',
        naoVerificada: true,
        latenciaMs: 4000,
        custoUsd: 0.04,
      },
      {
        avaliacao: 'errado',
        motivoAvaliacao: null,
        naoVerificada: false,
        latenciaMs: 5000,
        custoUsd: null,
      },
      {
        avaliacao: null,
        motivoAvaliacao: null,
        naoVerificada: false,
        latenciaMs: 6000,
        custoUsd: 0.1,
      },
    ]);
    expect(m).toMatchObject({
      analises: 6,
      util: 2,
      errado: 2,
      perigoso: 1,
      semAvaliacao: 1,
      naoVerificadas: 1,
      semMotivo: 1,
      latenciaP50Ms: 3000,
      latenciaP95Ms: 6000,
    });
    expect(m.motivos.erro_de_fato).toBe(1);
    expect(m.motivos.pode_causar_prejuizo).toBe(1);
    expect(m.custo.comCusto).toBe(5);
    expect(m.custo.total).toBeCloseTo(0.2);
    expect(m.custo.medio).toBeCloseTo(0.04);
    expect(m.custo.p50).toBe(0.03);
    expect(m.custo.p95).toBe(0.1);
    expect(m.custo.maximo).toBe(0.1);
  });

  it('vazio não inventa número: percentis e média ficam indefinidos', () => {
    const m = metricasDoConjunto([]);
    expect(m.analises).toBe(0);
    expect(m.latenciaP50Ms).toBeUndefined();
    expect(metricasDeCusto([])).toMatchObject({
      total: 0,
      medio: undefined,
      maximo: undefined,
      comCusto: 0,
    });
  });
});

describe('o painel e o script de avaliações fazem a MESMA conta', () => {
  it('as mesmas linhas dão o mesmo p50/p95/máximo/média e as mesmas contagens', () => {
    const linhas: Linha[] = [
      { em: '2026-10-05T10:00:00.000Z', custo: 0.001, latencia: 900, avaliacao: 'util' },
      {
        em: '2026-10-05T11:00:00.000Z',
        custo: 0.002,
        latencia: 1500,
        avaliacao: 'errado',
        motivo: 'citacao_inventada',
      },
      {
        em: '2026-10-05T12:00:00.000Z',
        custo: 0.009,
        latencia: 7000,
        avaliacao: 'perigoso',
        motivo: 'pode_causar_prejuizo',
      },
      {
        em: '2026-10-05T13:00:00.000Z',
        custo: null,
        latencia: 2000,
        estado: 'nao_verificada',
      },
      { em: '2026-10-05T14:00:00.000Z', custo: 0.004, latencia: 1100 },
    ];
    for (const l of linhas) inserirAto(l);

    const doPainel = painel
      .painel('hoje')
      .funcoes.find((f) => f.funcao === 'ato')!.metricas;
    const doScript = agruparAvaliacoes(
      linhas.map((l) => ({
        modelo: 'modelo/a',
        versao_prompt: 'ato-1.2.0',
        avaliacao: l.avaliacao ?? null,
        nao_verificada: l.estado === 'nao_verificada' ? 1 : 0,
        latencia_ms: l.latencia ?? 1000,
        custo_usd: l.custo,
        motivo_avaliacao: l.motivo ?? null,
      })),
    )[0]!;

    expect(doPainel.analises).toBe(doScript.analises);
    expect(doPainel.util).toBe(doScript.util);
    expect(doPainel.errado).toBe(doScript.errado);
    expect(doPainel.perigoso).toBe(doScript.perigoso);
    expect(doPainel.naoVerificadas).toBe(doScript.naoVerificadas);
    expect(doPainel.latenciaP50Ms).toBe(doScript.latenciaP50Ms);
    expect(doPainel.latenciaP95Ms).toBe(doScript.latenciaP95Ms);
    expect(doPainel.custo.medio).toBe(doScript.custoMedioUsd);
    expect(doPainel.custo.p50).toBe(doScript.custoP50Usd);
    expect(doPainel.custo.p95).toBe(doScript.custoP95Usd);
    expect(doPainel.custo.maximo).toBe(doScript.custoMaximoUsd);
    expect(doPainel.motivos).toEqual(doScript.motivos);
    expect(doPainel.semMotivo).toBe(doScript.semMotivo);
  });

  it('existe UMA implementação de percentil e de média no código (nada duplicado no painel nem no script)', () => {
    const fontes = [
      'src/application/services/ServicoPainelDeIa.ts',
      'src/application/politicas/metricasDeIa.ts',
      'src/main/sonda/avaliacoesDeIa.ts',
    ].map((p) => readFileSync(p, 'utf8'));
    for (const f of fontes) {
      expect(f).not.toMatch(
        /function\s+percentil|function\s+media|\.sort\(\s*\(a,\s*b\)\s*=>\s*a\s*-\s*b\s*\)/,
      );
    }
    expect(percentil([1, 2, 3, 4], 0.5)).toBe(2);
  });
});

describe('o painel por período', () => {
  it('"hoje" começa à meia-noite de São Paulo; 7 e 30 dias incluem o dia de hoje', () => {
    // Hoje (SP) = 2026-10-05. 02:59Z do dia 5 ainda é dia 4 em São Paulo.
    inserirAto({ em: '2026-10-05T02:59:00.000Z', custo: 1 });
    inserirAto({ em: '2026-10-05T03:00:00.000Z', custo: 2 });
    inserirAto({ em: '2026-09-29T03:00:00.000Z', custo: 4 }); // 6 dias antes = limite de "7 dias"
    inserirAto({ em: '2026-09-29T02:59:00.000Z', custo: 8 }); // fora de "7 dias", dentro de "30 dias"
    inserirAto({ em: '2026-09-06T02:59:00.000Z', custo: 16 }); // fora de "30 dias"
    const total = (p: 'hoje' | '7d' | '30d'): number =>
      painel.painel(p).funcoes.find((f) => f.funcao === 'ato')!.metricas.custo.total;
    expect(total('hoje')).toBe(2);
    expect(total('7d')).toBe(7);
    expect(total('30d')).toBe(15);
    expect(painel.painel('hoje').desde).toBe('2026-10-05');
    expect(painel.painel('7d').desde).toBe('2026-09-29');
    expect(painel.painel('30d').desde).toBe('2026-09-06');
  });

  it('as contas aparecem só com o id curto, ordenadas por uso', () => {
    for (let i = 0; i < 3; i++)
      inserirAto({
        ws: 'aaaaaaaa-1111-2222-3333-444444444444',
        em: '2026-10-05T10:00:00.000Z',
        custo: 0.1,
      });
    inserirAto({
      ws: 'bbbbbbbb-1111-2222-3333-444444444444',
      em: '2026-10-05T10:00:00.000Z',
      custo: 0.1,
    });
    const contas = painel.painel('hoje').contas;
    expect(contas).toEqual([
      { conta: 'aaaaaaaa', analises: 3 },
      { conta: 'bbbbbbbb', analises: 1 },
    ]);
    expect(JSON.stringify(painel.painel('hoje'))).not.toContain('1111-2222');
  });

  it('as falhas de verificação e as repetições vêm das contagens, por motivo e por dia', () => {
    ocorrencias.registrar('ato', 'citacao_invalida');
    ocorrencias.registrar('ato', 'citacao_invalida', 2);
    ocorrencias.registrar('ato', 'repeticao_automatica', 4);
    ocorrencias.registrar('ato', 'chamada_falhou');
    ocorrencias.registrar('ato', 'tempo_esgotado');
    ocorrencias.registrar('resumo', 'ato_recente_fora');
    relogio.ms = new Date('2026-10-06T15:00:00.000Z').getTime();
    ocorrencias.registrar('ato', 'expressao_proibida');
    // Mesmo dia da última (06/10): só ela. Em 7 dias: todas.
    const hoje = painel.painel('hoje').funcoes.find((f) => f.funcao === 'ato')!;
    expect(hoje.falhasDeVerificacao).toEqual([
      { motivo: 'expressao_proibida', contagem: 1 },
    ]);
    const semana = painel.painel('7d').funcoes.find((f) => f.funcao === 'ato')!;
    expect(semana.falhasDeVerificacao).toEqual(
      expect.arrayContaining([
        { motivo: 'citacao_invalida', contagem: 3 },
        { motivo: 'expressao_proibida', contagem: 1 },
        { motivo: 'chamada_falhou', contagem: 1 },
        { motivo: 'tempo_esgotado', contagem: 1 },
      ]),
    );
    expect(semana.repeticoesAutomaticas).toBe(4);
    expect(semana.chamadasQueFalharam).toBe(2);
    const resumo = painel.painel('7d').funcoes.find((f) => f.funcao === 'resumo')!;
    expect(resumo.falhasDeVerificacao).toEqual([
      { motivo: 'ato_recente_fora', contagem: 1 },
    ]);
  });

  it('a taxa de "não foi possível" soma as não verificadas e as chamadas que falharam', () => {
    for (let i = 0; i < 6; i++)
      inserirAto({ em: '2026-10-05T10:00:00.000Z', custo: 0.01 });
    inserirAto({ em: '2026-10-05T10:00:00.000Z', custo: 0.01, estado: 'nao_verificada' });
    ocorrencias.registrar('ato', 'chamada_falhou', 1);
    const f = painel.painel('hoje').funcoes.find((x) => x.funcao === 'ato')!;
    expect(f.naoFoiPossivel).toBe(2);
    expect(f.taxaNaoFoiPossivel).toBeCloseTo(2 / 8);
    expect(f.taxaNaoVerificado).toBeCloseTo(1 / 7);
  });

  it('ocorrência com motivo ou função fora da lista é ignorada na leitura (sem lançar)', () => {
    db.prepare(
      "INSERT INTO ia_ocorrencias_dia VALUES ('2026-10-05','ato','texto_do_ato_aqui',9)",
    ).run();
    db.prepare(
      "INSERT INTO ia_ocorrencias_dia VALUES ('2026-10-05','outra','forma',9)",
    ).run();
    const f = painel.painel('hoje').funcoes.find((x) => x.funcao === 'ato')!;
    expect(f.falhasDeVerificacao).toEqual([]);
  });

  it('o painel não tem como carregar texto de ato: o JSON só traz números e rótulos de lista fechada', () => {
    inserirAto({ em: '2026-10-05T10:00:00.000Z', custo: 0.1 });
    db.prepare(
      'UPDATE analises_ia SET resultado = \'{"estado":"verificada","resumo":"TEXTO-SECRETO-DO-ATO"}\'',
    ).run();
    expect(JSON.stringify(painel.painel('30d'))).not.toContain('TEXTO-SECRETO-DO-ATO');
  });
});
