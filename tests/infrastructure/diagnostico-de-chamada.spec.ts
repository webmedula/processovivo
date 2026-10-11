import { describe, expect, it } from 'vitest';
import { sanearCorpoEnviado } from '../../src/infrastructure/adapters/modelo/diagnosticoDeChamada.js';

describe('sanearCorpoEnviado', () => {
  const corpo = {
    model: 'fab/modelo',
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: [{ type: 'text', text: 'INSTRUCAO-LONGA '.repeat(10) }],
      },
      { role: 'user', content: 'TEXTO-DO-ATO-SINTETICO '.repeat(5) },
    ],
    provider: { zdr: true, only: ['alfa'] },
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'response', strict: true, schema: { type: 'object' } },
    },
    authorization: 'Bearer sk-or-segredo',
    api_key: 'sk-or-segredo',
  };

  it('troca o conteúdo das mensagens por marcador de tamanho e mantém o papel', () => {
    const r = sanearCorpoEnviado(corpo) as {
      messages: Array<{ role: string; conteudo: string }>;
    };
    expect(r.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(r.messages[0]?.conteudo).toBe('[omitido: 160 caracteres]');
    expect(r.messages[1]?.conteudo).toBe('[omitido: 115 caracteres]');
  });

  it('mantém a estrutura (modelo, provider, esquema) e tira os campos de segredo', () => {
    const r = sanearCorpoEnviado(corpo) as Record<string, unknown>;
    expect(r['model']).toBe('fab/modelo');
    expect(r['provider']).toEqual({ zdr: true, only: ['alfa'] });
    expect(JSON.stringify(r['response_format'])).toContain('json_schema');
    expect(r['authorization']).toBe('[omitido]');
    expect(r['api_key']).toBe('[omitido]');
    expect(JSON.stringify(r)).not.toMatch(/TEXTO-DO-ATO|INSTRUCAO|sk-or/);
  });

  it('string longa em qualquer outro campo também vira marcador; ausência vira undefined', () => {
    expect(sanearCorpoEnviado({ x: 'a'.repeat(300) })).toEqual({
      x: '[omitido: 300 caracteres]',
    });
    expect(sanearCorpoEnviado(undefined)).toBeUndefined();
  });
});
