import { describe, expect, it } from 'vitest';
import {
  lerRecusa,
  nomesDosCampos,
  sanearTexto,
} from '../../src/infrastructure/adapters/pagamento/recusaDoMercadoPago.js';

/*
 * Como a RECUSA (4xx) do Mercado Pago vira motivo e diagnóstico (v0.45.1). Os corpos abaixo são
 * ESCRITOS À MÃO no formato `{ message, error, status, cause: [{ code, description }] }`; nada é captura
 * real, e todo e-mail, token e id é sintético. Sem rede.
 */
const corpo = (o: unknown): string => JSON.stringify(o);
const ler = (status: number, o: unknown, campos: string[] = []) =>
  lerRecusa({
    operacao: 'criarAssinatura',
    status,
    corpo: corpo(o),
    camposEnviados: campos,
  });

describe('lerRecusa — o motivo, em lista fechada', () => {
  it('causa que cita payer_email → email_pagador', () => {
    const r = ler(400, {
      message: 'Invalid value for field',
      error: 'bad_request',
      status: 400,
      cause: [{ code: '123', description: 'Invalid value for payer_email' }],
    });
    expect(r.motivo).toBe('email_pagador');
  });

  it('"Invalid users involved" (comprador e vendedor de teste misturados) → email_pagador', () => {
    expect(
      ler(400, {
        message: 'Invalid users involved',
        error: 'bad_request',
        status: 400,
        cause: [],
      }).motivo,
    ).toBe('email_pagador');
    expect(
      ler(400, { message: 'Cannot operate between different countries', status: 400 })
        .motivo,
    ).toBe('email_pagador');
  });

  it('cada campo do pedido (menos o e-mail) → parametro_invalido', () => {
    for (const campo of [
      'back_url',
      'notification_url',
      'transaction_amount',
      'frequency',
      'frequency_type',
      'external_reference',
      'end_date',
      'currency_id',
    ]) {
      const r = ler(400, {
        message: 'bad request',
        error: 'bad_request',
        status: 400,
        cause: [{ code: '1', description: `Invalid value for ${campo}` }],
      });
      expect(r.motivo, campo).toBe('parametro_invalido');
    }
  });

  it('401 e 403 → credencial, com ou sem corpo', () => {
    expect(ler(401, { message: 'invalid access token', status: 401 }).motivo).toBe(
      'credencial',
    );
    expect(
      lerRecusa({ operacao: 'x', status: 403, corpo: '', camposEnviados: [] }).motivo,
    ).toBe('credencial');
  });

  it('400 com frase de token inválido → credencial', () => {
    expect(ler(400, { message: 'Invalid access token', status: 400 }).motivo).toBe(
      'credencial',
    );
  });

  it('400 sem evidência nenhuma → desconhecido (palavra solta não decide: "email" e "invalid" não bastam)', () => {
    expect(
      ler(400, { message: 'Something is invalid', error: 'bad_request', status: 400 })
        .motivo,
    ).toBe('desconhecido');
    expect(ler(400, { message: 'check your email provider', status: 400 }).motivo).toBe(
      'desconhecido',
    );
    expect(ler(400, {}).motivo).toBe('desconhecido');
  });

  it('corpo que não é JSON (ou é um array) → desconhecido, sem lançar', () => {
    for (const bruto of ['<html>erro</html>', '', '[1,2]', 'null']) {
      const r = lerRecusa({
        operacao: 'x',
        status: 400,
        corpo: bruto,
        camposEnviados: [],
      });
      expect(r.motivo).toBe('desconhecido');
      expect(r.diagnostico.causas).toEqual([]);
    }
  });

  it('com várias evidências, a credencial vence o e-mail e o e-mail vence os demais campos', () => {
    expect(
      ler(401, { message: 'x', cause: [{ description: 'payer_email' }] }).motivo,
    ).toBe('credencial');
    expect(
      ler(400, { cause: [{ description: 'back_url' }, { description: 'payer_email' }] })
        .motivo,
    ).toBe('email_pagador');
  });
});

describe('lerRecusa — o diagnóstico saneado', () => {
  it('guarda status, error, message e, de cada causa, só code e description', () => {
    const r = ler(
      400,
      {
        message: 'bad',
        error: 'bad_request',
        status: 400,
        cause: [{ code: 'E1', description: 'campo x', extra: 'ignorado' }, { code: 7 }],
        payer: { nome: 'Fulano', cpf: '000' },
      },
      ['payer_email'],
    );
    expect(r.diagnostico).toEqual({
      operacao: 'criarAssinatura',
      status: 400,
      erro: 'bad_request',
      mensagem: 'bad',
      causas: [{ codigo: 'E1', descricao: 'campo x' }, { codigo: '7' }],
      camposEnviados: ['payer_email'],
    });
    expect(JSON.stringify(r.diagnostico)).not.toMatch(/Fulano|000|ignorado/);
  });

  it('e-mail é mascarado em qualquer texto, e token é apagado', () => {
    const r = ler(400, {
      message:
        'Payer comprador@exemplo.test não pode usar o token APP_USR-abc123def456 nem Bearer xyz.123',
      error: 'bad_request',
      cause: [
        { code: 'X', description: 'e-mail ana.silva+teste@escritorio.com.br inválido' },
      ],
    });
    const texto = JSON.stringify(r.diagnostico);
    expect(texto).not.toMatch(/comprador@|ana\.silva|escritorio|APP_USR|abc123|xyz\.123/);
    expect(r.diagnostico.mensagem).toContain('c***@e***.test');
    expect(r.diagnostico.causas[0]?.descricao).toContain('a***@e***.com.br');
    expect(texto).toContain('[token]');
  });

  it('corta textos longos e limita o número de causas', () => {
    const r = ler(400, {
      message: 'm'.repeat(5000),
      cause: Array.from({ length: 50 }, (_, i) => ({
        code: String(i),
        description: 'd'.repeat(900),
      })),
    });
    expect(r.diagnostico.mensagem?.length).toBe(300);
    expect(r.diagnostico.causas).toHaveLength(10);
    expect(r.diagnostico.causas[0]?.descricao?.length).toBe(300);
  });
});

describe('nomesDosCampos e sanearTexto', () => {
  it('lista só os NOMES dos campos, um nível de objeto, nunca os valores', () => {
    const nomes = nomesDosCampos(
      JSON.stringify({
        reason: 'segredo-do-valor',
        payer_email: 'comprador@exemplo.test',
        auto_recurring: { frequency: 1, transaction_amount: 49.9 },
        lista: [1, 2],
      }),
    );
    expect(nomes).toEqual([
      'reason',
      'payer_email',
      'auto_recurring.frequency',
      'auto_recurring.transaction_amount',
      'lista',
    ]);
    expect(nomes.join()).not.toMatch(/segredo|comprador|49/);
  });

  it('corpo ausente, quebrado ou que não é objeto → lista vazia', () => {
    expect(nomesDosCampos(undefined)).toEqual([]);
    expect(nomesDosCampos('{quebrado')).toEqual([]);
    expect(nomesDosCampos('[1]')).toEqual([]);
  });

  it('sanearTexto ignora o que não é texto ou número e devolve undefined para vazio', () => {
    expect(sanearTexto({})).toBeUndefined();
    expect(sanearTexto('   ')).toBeUndefined();
    expect(sanearTexto(42)).toBe('42');
  });
});
