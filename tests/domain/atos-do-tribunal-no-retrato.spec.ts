import { describe, expect, it } from 'vitest';
import { detectarNovidades } from '../../src/domain/entities/Acompanhamento.js';
import {
  FONTE_DO_TRIBUNAL,
  incorporarAtosDoTribunal,
  veioDoTribunal,
} from '../../src/domain/entities/atosDoTribunalNoRetrato.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { NOME_MNI } from '../../src/infrastructure/adapters/mni/mni.mapper.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';

/*
 * v0.72.0 — a varredura junta ao retrato público (DataJud + Diário) a linha do tempo que o próprio
 * tribunal (Projudi, pelo MNI) informou. Tudo sintético: números com DV válido, títulos inventados.
 */
const NUMERO = numeroValido(7101);
const dia = (d: string, h = '13:00'): Date => new Date(`${d}T${h}:00-03:00`);

function retrato(
  provider: string,
  movimentacoes: Movimentacao[],
  extra: { segredoJustica?: boolean } = {},
): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(NUMERO),
    tribunal: 'TJGO',
    movimentacoes,
    ...extra,
    procedencia: { provider, consultadoEm: dia('2026-11-20'), deCache: false },
  });
}

const datajud = (d: string, codigoTpu: number, titulo: string): Movimentacao => ({
  data: dia(d),
  titulo,
  codigoTpu,
  fonte: 'datajud',
});
const djen = (d: string, id: number, titulo = 'Despacho'): Movimentacao => ({
  data: dia(d, '00:00'),
  titulo,
  idExterno: `djen:${id}`,
  conteudo: 'Texto sintético do despacho publicado.',
  fonte: 'djen',
});
const mni = (d: string, id: number, codigoTpu: number, titulo: string): Movimentacao => ({
  data: dia(d, '16:20'),
  titulo,
  codigoTpu,
  idExterno: `mni:${id}`,
  fonte: 'mni',
});

describe('incorporarAtosDoTribunal', () => {
  it('usa o mesmo nome de fonte que o adapter do MNI carimba', () => {
    expect(FONTE_DO_TRIBUNAL).toBe(NOME_MNI);
  });

  it('o tribunal fica com o ato que as duas fontes contam; o Diário fica inteiro', () => {
    const publico = retrato('datajud+djen', [
      datajud('2026-11-03', 11010, 'Mero expediente'),
      djen('2026-11-06', 501),
    ]);
    const tribunal = [
      mni('2026-11-03', 9001, 11010, 'Despacho -> Mero Expediente'),
      mni('2026-11-18', 9002, 85, 'Juntada -> Petição'),
    ];

    const r = incorporarAtosDoTribunal(publico, tribunal, undefined);

    expect(r.movimentacoes.map((m) => m.idExterno ?? m.fonte)).toEqual([
      'mni:9002',
      'djen:501',
      'mni:9001',
    ]);
    // A publicação continua com o texto: é dela que sai a intimação.
    expect(
      r.movimentacoes.find((m) => m.idExterno === 'djen:501')?.conteudo,
    ).toBeTruthy();
    expect(r.procedencia.provider).toBe('datajud+djen+mni');
  });

  it('a contagem de atos nunca diminui: o que o tribunal não cobre no balde fica', () => {
    const publico = retrato('datajud', [
      datajud('2026-11-03', 85, 'Juntada de Petição'),
      datajud('2026-11-03', 85, 'Juntada de Petição'),
      datajud('2026-11-03', 85, 'Juntada de Petição'),
    ]);
    const tribunal = [
      mni('2026-11-03', 1, 85, 'Juntada -> Petição'),
      mni('2026-11-03', 2, 85, 'Juntada -> Petição'),
    ];

    const r = incorporarAtosDoTribunal(publico, tribunal, undefined);

    expect(r.movimentacoes).toHaveLength(3);
    expect(r.movimentacoes.filter(veioDoTribunal)).toHaveLength(2);
  });

  it('sem consulta nova, os andamentos do tribunal do retrato anterior continuam', () => {
    const anterior = incorporarAtosDoTribunal(
      retrato('datajud+djen', [datajud('2026-11-03', 11010, 'Mero expediente')]),
      [mni('2026-11-03', 9001, 11010, 'Despacho -> Mero Expediente')],
      undefined,
    );
    const publicoDeHoje = retrato('datajud+djen', [
      datajud('2026-11-03', 11010, 'Mero expediente'),
    ]);

    const r = incorporarAtosDoTribunal(publicoDeHoje, undefined, anterior);

    expect(r.movimentacoes.map((m) => m.idExterno)).toEqual(['mni:9001']);
    // Nada "novo": a linha do DataJud não volta com chave nova.
    expect(detectarNovidades(anterior, r)).toEqual([]);
  });

  it('sem tribunal agora nem antes, devolve o retrato público como veio', () => {
    const publico = retrato('datajud', [datajud('2026-11-03', 85, 'Juntada de Petição')]);
    expect(incorporarAtosDoTribunal(publico, undefined, undefined)).toBe(publico);
    expect(incorporarAtosDoTribunal(publico, [], undefined)).toBe(publico);
  });

  it('segredo de justiça não se complementa por outra fonte', () => {
    const publico = retrato('datajud', [datajud('2026-11-03', 85, 'Juntada')], {
      segredoJustica: true,
    });
    const r = incorporarAtosDoTribunal(
      publico,
      [mni('2026-11-18', 1, 85, 'Juntada -> Petição')],
      undefined,
    );
    expect(r).toBe(publico);
  });

  it('linhas do tribunal que já vinham no retrato público são trocadas, nunca somadas', () => {
    const publico = retrato('datajud+djen+mni', [
      mni('2026-11-03', 9001, 11010, 'Despacho -> Mero Expediente'),
      djen('2026-11-06', 501),
    ]);
    const r = incorporarAtosDoTribunal(
      publico,
      [mni('2026-11-03', 9001, 11010, 'Despacho -> Mero Expediente')],
      undefined,
    );
    expect(r.movimentacoes.filter(veioDoTribunal)).toHaveLength(1);
    expect(r.procedencia.provider).toBe('datajud+djen+mni');
  });

  it('dá nome pelo código da tabela quando o tribunal só mandou o número', () => {
    const publico = retrato('datajud', [datajud('2026-10-01', 11010, 'Mero expediente')]);
    const r = incorporarAtosDoTribunal(
      publico,
      [mni('2026-11-18', 1, 11010, 'Movimento 11010')],
      undefined,
    );
    expect(r.movimentacoes.find(veioDoTribunal)?.titulo).toBe('Mero expediente');
  });
});

describe('o que a varredura passa a avisar', () => {
  const antes = retrato('datajud+djen', [
    datajud('2026-11-03', 11010, 'Mero expediente'),
    djen('2026-11-06', 501),
  ]);

  it('na primeira leitura do tribunal, o histórico é linha de base e o ato ainda não publicado é novidade', () => {
    const depois = incorporarAtosDoTribunal(
      antes,
      [
        mni('2026-10-20', 9000, 85, 'Juntada -> Petição'),
        mni('2026-11-03', 9001, 11010, 'Despacho -> Mero Expediente'),
        mni('2026-11-24', 9003, 11010, 'Despacho -> Mero Expediente'),
      ],
      undefined,
    );

    const novas = detectarNovidades(antes, depois);

    expect(novas.map((m) => m.idExterno)).toEqual(['mni:9003']);
  });

  it('quando o DataJud alcança o Projudi, o mesmo ato não vira novidade de novo', () => {
    const comTribunal = incorporarAtosDoTribunal(
      antes,
      [
        mni('2026-11-03', 9001, 11010, 'Despacho -> Mero Expediente'),
        mni('2026-11-24', 9003, 11010, 'Despacho -> Mero Expediente'),
      ],
      undefined,
    );
    const dataJudAtualizado = retrato('datajud+djen', [
      datajud('2026-11-03', 11010, 'Mero expediente'),
      datajud('2026-11-24', 11010, 'Mero expediente'),
      djen('2026-11-06', 501),
    ]);

    const seguinte = incorporarAtosDoTribunal(dataJudAtualizado, undefined, comTribunal);

    expect(detectarNovidades(comTribunal, seguinte)).toEqual([]);
  });

  it('a publicação do ato no Diário, depois, é novidade: é dela que conta a intimação', () => {
    const comTribunal = incorporarAtosDoTribunal(
      antes,
      [mni('2026-11-24', 9003, 11010, 'Despacho -> Mero Expediente')],
      undefined,
    );
    const comPublicacao = retrato('datajud+djen', [
      datajud('2026-11-03', 11010, 'Mero expediente'),
      djen('2026-11-06', 501),
      djen('2026-11-27', 502),
    ]);

    const seguinte = incorporarAtosDoTribunal(comPublicacao, undefined, comTribunal);

    expect(detectarNovidades(comTribunal, seguinte).map((m) => m.idExterno)).toEqual([
      'djen:502',
    ]);
  });
});
