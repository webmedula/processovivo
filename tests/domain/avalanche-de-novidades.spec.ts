import { describe, expect, it } from 'vitest';
import { detectarNovidades } from '../../src/domain/entities/Acompanhamento.js';
import { fundirProcessos } from '../../src/domain/entities/fusaoProcessos.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';

/*
 * A avalanche (v0.37.5): processo descoberto pela vigilância é gravado só com o
 * retrato do DJEN; na primeira varredura regular o retrato vira DataJud+DJEN e a
 * linha do tempo inteira do DataJud "não existia antes". Tudo sintético.
 */
const DIA_DA_VIGILANCIA = new Date('2026-09-05T15:00:00Z');
const DIA_DA_VARREDURA = new Date('2026-09-06T15:00:00Z');

function processo(
  provider: string,
  movimentacoes: Movimentacao[],
  consultadoEm: Date,
): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(NUMERO_TJSP_A),
    tribunal: 'TJSP',
    movimentacoes,
    procedencia: { provider, consultadoEm, deCache: false },
  });
}

const djen = (dia: string, id: number, titulo = 'Decisão'): Movimentacao => ({
  data: new Date(`${dia}T00:00:00-03:00`),
  titulo,
  idExterno: `djen:${id}`,
});

/** 40 andamentos do DataJud, de 2024 até o fim de agosto de 2026. */
function historicoDoDataJud(): Movimentacao[] {
  const base = new Date('2024-01-10T13:00:00Z').getTime();
  return Array.from({ length: 40 }, (_, i) => ({
    data: new Date(base + i * 15 * 86_400_000),
    titulo: `Movimento ${i}`,
  }));
}

describe('fonte que passa a existir no retrato não despeja o passado como novidade', () => {
  const soDjen = processo(
    'djen',
    [djen('2026-08-20', 1), djen('2026-09-01', 2)],
    DIA_DA_VIGILANCIA,
  );
  const datajud = processo('datajud', historicoDoDataJud(), DIA_DA_VARREDURA);
  const completo = fundirProcessos(datajud, soDjen);

  it('premissa: sem a correção, o histórico inteiro do DataJud pareceria novo', () => {
    // O que a regra antiga fazia: tudo o que o retrato anterior não tinha.
    const conhecidas = new Set(soDjen.movimentacoes.map((m) => m.idExterno));
    const naoConhecidas = completo.movimentacoes.filter(
      (m) => !m.idExterno || !conhecidas.has(m.idExterno),
    );
    expect(naoConhecidas).toHaveLength(40);
  });

  it('DJEN-só → DataJud+DJEN: zero novidades herdadas', () => {
    expect(detectarNovidades(soDjen, completo)).toEqual([]);
  });

  it('depois disso, um ato realmente novo gera UMA novidade', () => {
    const maisUm = processo(
      'datajud',
      [
        ...historicoDoDataJud(),
        { data: new Date('2026-09-07T12:00:00Z'), titulo: 'Decisão nova' },
      ],
      new Date('2026-09-08T15:00:00Z'),
    );
    const proximo = fundirProcessos(maisUm, soDjen);

    const novas = detectarNovidades(completo, proximo);

    expect(novas.map((m) => m.titulo)).toEqual(['Decisão nova']);
  });

  it('ato do DataJud POSTERIOR ao último que o retrato conhecia NÃO é histórico: avisa', () => {
    // Dúvida resolve-se para o lado de avisar: falso negativo é prazo perdido.
    const comAtoRecente = processo(
      'datajud',
      [
        ...historicoDoDataJud(),
        { data: new Date('2026-09-05T09:00:00-03:00'), titulo: 'Ato do dia da leitura' },
      ],
      DIA_DA_VARREDURA,
    );

    const novas = detectarNovidades(soDjen, fundirProcessos(comAtoRecente, soDjen));

    expect(novas.map((m) => m.titulo)).toEqual(['Ato do dia da leitura']);
  });

  it('fonte que cai e volta (retrato regravado só com a outra) não reabre o histórico', () => {
    // completo → só DJEN (DataJud fora do ar) → completo de novo.
    const aoVoltar = fundirProcessos(
      processo('datajud', historicoDoDataJud(), new Date('2026-09-10T15:00:00Z')),
      soDjen,
    );
    const durantePane = processo(
      'djen',
      soDjen.movimentacoes.slice(),
      new Date('2026-09-08T15:00:00Z'),
    );

    expect(detectarNovidades(completo, durantePane)).toEqual([]);
    expect(detectarNovidades(durantePane, aoVoltar)).toEqual([]);
  });

  it('publicação do DJEN que chega a um processo que só tinha o DataJud é novidade', () => {
    // O contrário da avalanche: a fonte nova traz um ato posterior ao que se conhecia.
    const soDatajud = processo('datajud', historicoDoDataJud(), DIA_DA_VIGILANCIA);
    const novas = detectarNovidades(soDatajud, fundirProcessos(soDatajud, djenSo()));
    expect(novas.map((m) => m.idExterno)).toEqual(['djen:2']);

    function djenSo(): Processo {
      return processo('djen', [djen('2026-09-04', 2)], DIA_DA_VARREDURA);
    }
  });

  it('retrato anterior sem nenhum ato: uma fonte nova não despeja o passado (usa o dia da consulta)', () => {
    const vazio = processo('djen', [], DIA_DA_VIGILANCIA);
    expect(detectarNovidades(vazio, fundirProcessos(datajud, vazio))).toEqual([]);
  });

  it('mesma fonte nos dois lados: a regra de sempre (só o que não existia)', () => {
    const antes = processo('datajud', historicoDoDataJud(), DIA_DA_VIGILANCIA);
    const depois = processo(
      'datajud',
      [
        ...historicoDoDataJud(),
        {
          data: new Date('2020-01-01T00:00:00Z'),
          titulo: 'Ato antigo que apareceu agora',
        },
      ],
      DIA_DA_VARREDURA,
    );
    // Mesma fonte: um ato antigo que surge continua sendo novidade (o tribunal publicou com atraso).
    expect(detectarNovidades(antes, depois).map((m) => m.titulo)).toEqual([
      'Ato antigo que apareceu agora',
    ]);
  });

  it('a procedência fundida não cresce a cada fusão', () => {
    const uma = fundirProcessos(datajud, soDjen);
    const duas = fundirProcessos(uma, soDjen);
    expect(uma.procedencia.provider).toBe('datajud+djen');
    expect(duas.procedencia.provider).toBe('datajud+djen');
  });
});
