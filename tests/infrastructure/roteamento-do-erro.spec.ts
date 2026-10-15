import { describe, expect, it } from 'vitest';
import {
  ehFiltroDePoliticaDeDados,
  extrairRoteamento,
  funilEmTexto,
} from '../../src/infrastructure/adapters/modelo/roteamentoDoErro.js';

describe('extrairRoteamento', () => {
  it('acha failed_routing_step e routing_funnel em qualquer nível', () => {
    const r = extrairRoteamento(
      JSON.stringify({
        error: {
          code: 404,
          metadata: {
            failed_routing_step: 'only_filter',
            routing_funnel: { total: 5, after_only: 0 },
          },
        },
      }),
    );
    expect(r).toEqual({ passo: 'only_filter', funil: { total: 5, after_only: 0 } });
  });

  it('acha também dentro de um JSON embutido em string (metadata.raw)', () => {
    const interno = JSON.stringify({
      failed_routing_step: 'parametros',
      routing_funnel: [{ step: 'parametros', remaining: 0 }],
    });
    const r = extrairRoteamento(
      JSON.stringify({ error: { metadata: { raw: interno } } }),
    );
    expect(r.passo).toBe('parametros');
    expect(r.funil).toEqual([{ step: 'parametros', remaining: 0 }]);
  });

  it('corpo vazio, não-JSON ou sem os campos: nada é inventado', () => {
    expect(extrairRoteamento('')).toEqual({});
    expect(extrairRoteamento('<html>')).toEqual({});
    expect(extrairRoteamento('{"error":{"message":"x"}}')).toEqual({});
  });

  it('o passo é reduzido a um token curto e seguro; o funil sai saneado (string longa vira marcador)', () => {
    const r = extrairRoteamento(
      JSON.stringify({
        failed_routing_step: 'passo <script>x</script> '.repeat(10),
        routing_funnel: { texto: 'a'.repeat(300) },
      }),
    );
    expect(r.passo?.length).toBeLessThanOrEqual(80);
    expect(r.passo).not.toContain('<');
    expect(r.funil).toEqual({ texto: '[omitido: 300 caracteres]' });
  });
});

describe('ehFiltroDePoliticaDeDados', () => {
  it.each([
    'data_policy',
    'data_policy_filter',
    'zdr',
    'ZDR_filter',
    'retention',
    'privacy',
    'data_collection',
    'training_filter',
  ])('"%s" é o filtro de política de dados', (passo) =>
    expect(ehFiltroDePoliticaDeDados(passo)).toBe(true),
  );
  it.each([
    'parameters',
    'provider_only',
    'only',
    'quantization',
    'max_price',
    'context_length',
    undefined,
  ])('"%s" NÃO é', (passo) => expect(ehFiltroDePoliticaDeDados(passo)).toBe(false));
});

describe('funilEmTexto', () => {
  it('ausente, curto e truncado', () => {
    expect(funilEmTexto(undefined)).toBe('(ausente)');
    expect(funilEmTexto({ a: 1 })).toBe('{"a":1}');
    expect(funilEmTexto({ a: 'x'.repeat(100) }, 20)).toMatch(/…$/);
  });
});
