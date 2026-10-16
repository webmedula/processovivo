import { describe, expect, it } from 'vitest';
import {
  AssinaturaDeWebhookInvalidaError,
  GatewayDePagamentoIndisponivelError,
  GatewayDePagamentoRecusouError,
} from '../../src/domain/errors/index.js';
import {
  MercadoPagoAdapter,
  ambienteDoToken,
} from '../../src/infrastructure/adapters/pagamento/MercadoPagoAdapter.js';
import type {
  PedidoDoGateway,
  RespostaDoGateway,
  TransporteDoGateway,
} from '../../src/infrastructure/adapters/pagamento/TransporteDoGateway.js';
import { assinarAvisoParaTeste } from '../../src/infrastructure/adapters/pagamento/validacaoDeWebhook.js';

/*
 * O adapter contra respostas ESCRITAS À MÃO, no formato que a documentação do Mercado Pago descreve
 * (sem rede). Nada aqui é captura real: ids, e-mails e valores são sintéticos. O que vem do pagador
 * (nome, e-mail, CPF, final do cartão) está nas respostas DE PROPÓSITO, para provar que não passa.
 */
const TOKEN = 'APP_USR-token-sintetico-0000';
const SEGREDO = 'segredo-sintetico-do-webhook';
const AGORA = new Date('2026-10-20T12:00:00.000Z');

class TransporteGravado implements TransporteDoGateway {
  readonly pedidos: PedidoDoGateway[] = [];
  constructor(private readonly respostas: Array<RespostaDoGateway | Error>) {}
  async requisitar(p: PedidoDoGateway): Promise<RespostaDoGateway> {
    this.pedidos.push(p);
    const r = this.respostas.shift();
    if (!r) throw new Error('resposta gravada esgotada');
    if (r instanceof Error) throw r;
    return r;
  }
}

const ok = (corpo: unknown, status = 200): RespostaDoGateway => ({
  status,
  corpo: JSON.stringify(corpo),
});

function adapter(
  respostas: Array<RespostaDoGateway | Error>,
  token = TOKEN,
): { gw: MercadoPagoAdapter; transporte: TransporteGravado } {
  const transporte = new TransporteGravado(respostas);
  return {
    transporte,
    gw: new MercadoPagoAdapter({
      accessToken: token,
      segredoDoWebhook: SEGREDO,
      transporte,
      clock: { agora: () => AGORA, monotonico: () => 0 },
      esperar: async () => {},
    }),
  };
}

const PEDIDO = {
  referencia: 'ref-sintetica-1',
  motivo: 'Processo Vivo — plano Peças',
  emailDoPagador: 'comprador@exemplo.test',
  valorEmCentavos: 4990,
  ciclo: 'mensal' as const,
  urlDeRetorno: 'https://app.exemplo.test/?assinatura=retorno',
  urlDeNotificacao: 'https://app.exemplo.test/v1/pagamentos/webhook/mercadopago',
  chaveDeIdempotencia: 'ref-sintetica-1',
};

describe('MercadoPagoAdapter — ambiente', () => {
  it('o token define o ambiente: TEST- é teste, o resto é produção', () => {
    expect(ambienteDoToken('TEST-1234')).toBe('teste');
    expect(ambienteDoToken('APP_USR-1234')).toBe('producao');
    expect(adapter([], 'TEST-x').gw.ambiente).toBe('teste');
  });
});

describe('MercadoPagoAdapter — criar assinatura (sem plano, pagamento pendente)', () => {
  it('faz POST /preapproval com status pending, valor em reais, ciclo em meses, idempotência e notification_url', async () => {
    const { gw, transporte } = adapter([
      ok(
        {
          id: 'sintetica-assinatura-1',
          status: 'pending',
          init_point: 'https://checkout.exemplo.test/sub/1',
          payer_id: 7,
          next_payment_date: '2026-11-20T12:00:00.000-04:00',
        },
        201,
      ),
    ]);
    const r = await gw.criarAssinatura(PEDIDO);

    expect(r).toEqual({
      id: 'sintetica-assinatura-1',
      urlDeCheckout: 'https://checkout.exemplo.test/sub/1',
      estado: 'pendente',
    });
    expect(transporte.pedidos).toHaveLength(1);
    const p = transporte.pedidos[0]!;
    expect(p.metodo).toBe('POST');
    expect(p.url).toBe('https://api.mercadopago.com/preapproval');
    expect(p.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(p.headers['x-idempotency-key']).toBe('ref-sintetica-1');
    expect(JSON.parse(p.corpo!)).toEqual({
      reason: 'Processo Vivo — plano Peças',
      external_reference: 'ref-sintetica-1',
      payer_email: 'comprador@exemplo.test',
      back_url: 'https://app.exemplo.test/?assinatura=retorno',
      notification_url: 'https://app.exemplo.test/v1/pagamentos/webhook/mercadopago',
      status: 'pending',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: 49.9,
        currency_id: 'BRL',
      },
    });
  });

  it('o corpo NUNCA leva dado de cartão (o sistema não o tem)', async () => {
    const { gw, transporte } = adapter([
      ok({ id: 'x', init_point: 'https://c.exemplo.test/1' }, 201),
    ]);
    await gw.criarAssinatura(PEDIDO);
    expect(transporte.pedidos[0]!.corpo).not.toMatch(/card|cartao|cvv|security_code/i);
  });

  it('o ciclo vira frequência em meses (anual = 12)', async () => {
    const { gw, transporte } = adapter([
      ok({ id: 'x', init_point: 'https://c.exemplo.test/1' }, 201),
    ]);
    await gw.criarAssinatura({ ...PEDIDO, ciclo: 'anual', valorEmCentavos: 59880 });
    const corpo = JSON.parse(transporte.pedidos[0]!.corpo!) as {
      auto_recurring: { frequency: number; transaction_amount: number };
    };
    expect(corpo.auto_recurring.frequency).toBe(12);
    expect(corpo.auto_recurring.transaction_amount).toBe(598.8);
  });

  it('NUNCA repete a criação: 500 vira indisponível com UMA chamada só', async () => {
    const { gw, transporte } = adapter([
      ok({}, 500),
      ok({ id: 'x', init_point: 'https://c.exemplo.test/1' }, 201),
    ]);
    await expect(gw.criarAssinatura(PEDIDO)).rejects.toBeInstanceOf(
      GatewayDePagamentoIndisponivelError,
    );
    expect(transporte.pedidos).toHaveLength(1);
  });

  it('falha de rede na criação também não repete', async () => {
    const { gw, transporte } = adapter([
      new GatewayDePagamentoIndisponivelError('mercadopago', 'sem resposta'),
    ]);
    await expect(gw.criarAssinatura(PEDIDO)).rejects.toBeInstanceOf(
      GatewayDePagamentoIndisponivelError,
    );
    expect(transporte.pedidos).toHaveLength(1);
  });

  it('resposta sem init_point é recusa (sem checkout não há o que mostrar)', async () => {
    const { gw } = adapter([ok({ id: 'x', status: 'pending' }, 201)]);
    await expect(gw.criarAssinatura(PEDIDO)).rejects.toBeInstanceOf(
      GatewayDePagamentoRecusouError,
    );
  });

  it('4xx é recusa definitiva; 401/403 diz "credencial recusada" sem ecoar token nem corpo', async () => {
    const { gw } = adapter([
      ok(
        {
          message: `token ${TOKEN} inválido`,
          cause: [{ description: 'payer@exemplo.test' }],
        },
        401,
      ),
    ]);
    const erro = (await gw.criarAssinatura(PEDIDO).catch((e: unknown) => e)) as Error;
    expect(erro).toBeInstanceOf(GatewayDePagamentoRecusouError);
    expect(erro.message).not.toContain(TOKEN);
    expect(erro.message).not.toContain('exemplo.test');
    const { gw: gw2 } = adapter([ok({ message: 'bad_request' }, 400)]);
    await expect(gw2.criarAssinatura(PEDIDO)).rejects.toMatchObject({ status: 400 });
  });
});

describe('MercadoPagoAdapter — consultar assinatura', () => {
  const corpo = (status: string): unknown => ({
    id: 'sintetica-assinatura-1',
    status,
    external_reference: 'ref-sintetica-1',
    next_payment_date: '2026-11-20T12:00:00.000-04:00',
    auto_recurring: { transaction_amount: 49.9, frequency: 1, frequency_type: 'months' },
    // O que o gateway sabe do pagador — e que NÃO pode atravessar o adapter:
    payer_id: 123,
    payer_email: 'comprador@exemplo.test',
    card_id: 'cartao-sintetico',
  });

  it('mapeia os quatro status e devolve só o que o sistema usa', async () => {
    for (const [mp, nosso] of [
      ['pending', 'pendente'],
      ['authorized', 'autorizada'],
      ['paused', 'pausada'],
      ['cancelled', 'cancelada'],
    ] as const) {
      const { gw } = adapter([ok(corpo(mp))]);
      const r = await gw.consultarAssinatura('sintetica-assinatura-1');
      expect(r.estado).toBe(nosso);
      expect(r.referencia).toBe('ref-sintetica-1');
      expect(r.valorEmCentavos).toBe(4990);
      expect(r.proximaCobranca?.toISOString()).toBe('2026-11-20T16:00:00.000Z');
      expect(JSON.stringify(r)).not.toContain('exemplo.test');
      expect(JSON.stringify(r)).not.toContain('cartao');
    }
  });

  it('status desconhecido é recusa (não se adivinha estado de cobrança)', async () => {
    const { gw } = adapter([ok(corpo('algo_novo'))]);
    await expect(gw.consultarAssinatura('x')).rejects.toBeInstanceOf(
      GatewayDePagamentoRecusouError,
    );
  });

  it('LEITURA repete (503, depois 200): três tentativas no máximo', async () => {
    const { gw, transporte } = adapter([
      ok({}, 503),
      ok({}, 429),
      ok(corpo('authorized')),
    ]);
    const r = await gw.consultarAssinatura('x');
    expect(r.estado).toBe('autorizada');
    expect(transporte.pedidos).toHaveLength(3);
    const { gw: gw2, transporte: t2 } = adapter([
      ok({}, 503),
      ok({}, 503),
      ok({}, 503),
      ok(corpo('authorized')),
    ]);
    await expect(gw2.consultarAssinatura('x')).rejects.toBeInstanceOf(
      GatewayDePagamentoIndisponivelError,
    );
    expect(t2.pedidos).toHaveLength(3);
  });

  it('404 não repete e vira recusa', async () => {
    const { gw, transporte } = adapter([ok({}, 404)]);
    await expect(gw.consultarAssinatura('x')).rejects.toMatchObject({ status: 404 });
    expect(transporte.pedidos).toHaveLength(1);
  });
});

describe('MercadoPagoAdapter — cobranças e pagamentos', () => {
  const parcela = (extra: Record<string, unknown>): unknown => ({
    id: 4455,
    preapproval_id: 'sintetica-assinatura-1',
    status: 'processed',
    transaction_amount: 49.9,
    last_modified: '2026-10-20T12:00:00.000Z',
    external_reference: 'ref-sintetica-1',
    ...extra,
  });

  it('parcela com pagamento aprovado: chave `pg:<pagamento>` (a que renova)', async () => {
    const { gw, transporte } = adapter([
      ok(parcela({ payment: { id: 900, status: 'approved' } })),
    ]);
    const r = await gw.consultarCobranca('4455');
    expect(transporte.pedidos[0]!.url).toBe(
      'https://api.mercadopago.com/authorized_payments/4455',
    );
    expect(r).toMatchObject({
      id: 'pg:900',
      pagamentoId: '900',
      assinaturaId: 'sintetica-assinatura-1',
      referencia: 'ref-sintetica-1',
      resultado: 'aprovado',
      valorEmCentavos: 4990,
    });
  });

  it('parcela recusada: chave `cob:<parcela>` (as tentativas viram UM registro)', async () => {
    const { gw } = adapter([
      ok(parcela({ status: 'recycling', payment: { id: 901, status: 'rejected' } })),
      ok(parcela({ status: 'recycling', payment: { id: 902, status: 'rejected' } })),
    ]);
    const a = await gw.consultarCobranca('4455');
    const b = await gw.consultarCobranca('4455');
    expect(a.resultado).toBe('recusado');
    expect(a.id).toBe('cob:4455');
    expect(b.id).toBe(a.id);
  });

  it('parcela agendada, sem pagamento ainda: pendente', async () => {
    const { gw } = adapter([ok(parcela({ status: 'scheduled' }))]);
    expect(await gw.consultarCobranca('4455')).toMatchObject({
      resultado: 'pendente',
      id: 'cob:4455',
    });
  });

  it('pagamento: status → resultado, meio só como tipo, e nada do pagador atravessa', async () => {
    const { gw, transporte } = adapter([
      ok({
        id: 900,
        status: 'approved',
        transaction_amount: 49.9,
        date_approved: '2026-10-20T12:00:00.000-04:00',
        payment_type_id: 'credit_card',
        external_reference: 'ref-sintetica-1',
        metadata: { preapproval_id: 'sintetica-assinatura-1' },
        payer: {
          email: 'comprador@exemplo.test',
          identification: { number: '00000000000' },
        },
        card: { last_four_digits: '0000', cardholder: { name: 'NOME SINTETICO' } },
      }),
    ]);
    const r = await gw.consultarPagamento('900');
    expect(transporte.pedidos[0]!.url).toBe(
      'https://api.mercadopago.com/v1/payments/900',
    );
    expect(r).toMatchObject({
      id: 'pg:900',
      assinaturaId: 'sintetica-assinatura-1',
      referencia: 'ref-sintetica-1',
      resultado: 'aprovado',
      meio: 'cartao',
      valorEmCentavos: 4990,
    });
    const texto = JSON.stringify(r);
    expect(texto).not.toMatch(/exemplo\.test|00000000000|0000"|SINTETICO/);
  });

  it('estorno total, contestação e estorno PARCIAL (approved com valor devolvido) são cobertos', async () => {
    const base = { id: 900, transaction_amount: 49.9, payment_type_id: 'credit_card' };
    const { gw } = adapter([
      ok({ ...base, status: 'refunded' }),
      ok({ ...base, status: 'charged_back' }),
      ok({ ...base, status: 'approved', transaction_amount_refunded: 10 }),
      ok({ ...base, status: 'rejected' }),
    ]);
    expect((await gw.consultarPagamento('900')).resultado).toBe('estornado');
    expect((await gw.consultarPagamento('900')).resultado).toBe('contestado');
    expect((await gw.consultarPagamento('900')).resultado).toBe('estornado');
    expect((await gw.consultarPagamento('900')).resultado).toBe('recusado');
  });

  it('o meio boleto/Pix só existe como tipo (a recorrência é de cartão)', async () => {
    const { gw } = adapter([
      ok({
        id: 1,
        status: 'approved',
        transaction_amount: 1,
        payment_type_id: 'bank_transfer',
      }),
    ]);
    expect((await gw.consultarPagamento('1')).meio).toBe('pix');
  });

  it('lista as parcelas de uma assinatura (reconciliação)', async () => {
    const { gw, transporte } = adapter([
      ok({
        results: [
          parcela({ id: 1, payment: { id: 10, status: 'approved' } }),
          parcela({ id: 2, status: 'scheduled' }),
        ],
      }),
    ]);
    const lista = await gw.listarCobrancasDaAssinatura('sintetica-assinatura-1');
    expect(transporte.pedidos[0]!.url).toBe(
      'https://api.mercadopago.com/authorized_payments/search?preapproval_id=sintetica-assinatura-1',
    );
    expect(lista.map((p) => p.id)).toEqual(['pg:10', 'cob:2']);
    expect(lista.every((p) => p.assinaturaId === 'sintetica-assinatura-1')).toBe(true);
  });
});

describe('MercadoPagoAdapter — cancelar', () => {
  it('faz PUT /preapproval/{id} com { status: "cancelled" } e nunca repete', async () => {
    const { gw, transporte } = adapter([
      ok({}, 500),
      ok({ id: 'x', status: 'cancelled' }),
    ]);
    await expect(gw.cancelarAssinatura('sintetica-assinatura-1')).rejects.toBeInstanceOf(
      GatewayDePagamentoIndisponivelError,
    );
    expect(transporte.pedidos).toHaveLength(1);
    const { gw: gw2, transporte: t2 } = adapter([ok({ id: 'x', status: 'cancelled' })]);
    await gw2.cancelarAssinatura('sintetica-assinatura-1');
    expect(t2.pedidos[0]!.metodo).toBe('PUT');
    expect(t2.pedidos[0]!.url).toBe(
      'https://api.mercadopago.com/preapproval/sintetica-assinatura-1',
    );
    expect(JSON.parse(t2.pedidos[0]!.corpo!)).toEqual({ status: 'cancelled' });
  });
});

describe('MercadoPagoAdapter — webhook', () => {
  const ts = Math.floor(AGORA.getTime() / 1000);
  const assinar = (id: string): string =>
    assinarAvisoParaTeste({
      segredo: SEGREDO,
      ts,
      idDoRecurso: id,
      idDaRequisicao: 'req-1',
    });

  it('valida e devolve o tópico e o id a consultar (nada do corpo)', () => {
    const { gw } = adapter([]);
    expect(
      gw.validarWebhook({
        assinatura: assinar('4455'),
        idDaRequisicao: 'req-1',
        idDoRecurso: '4455',
        topico: 'subscription_authorized_payment',
      }),
    ).toEqual({ topico: 'cobranca', recursoId: '4455' });
    expect(
      gw.validarWebhook({
        assinatura: assinar('1'),
        idDaRequisicao: 'req-1',
        idDoRecurso: '1',
        topico: 'subscription_preapproval',
      }).topico,
    ).toBe('assinatura');
    expect(
      gw.validarWebhook({
        assinatura: assinar('2'),
        idDaRequisicao: 'req-1',
        idDoRecurso: '2',
        topico: 'payment',
      }).topico,
    ).toBe('pagamento');
    expect(
      gw.validarWebhook({
        assinatura: assinar('3'),
        idDaRequisicao: 'req-1',
        idDoRecurso: '3',
        topico: 'merchant_order',
      }).topico,
    ).toBe('outro');
  });

  it('recusa assinatura inválida e aviso assinado sem id', () => {
    const { gw } = adapter([]);
    expect(() =>
      gw.validarWebhook({
        assinatura: 'ts=1,v1=00',
        idDaRequisicao: 'req-1',
        idDoRecurso: '4455',
        topico: 'payment',
      }),
    ).toThrow(AssinaturaDeWebhookInvalidaError);
    const semId = assinarAvisoParaTeste({
      segredo: SEGREDO,
      ts,
      idDaRequisicao: 'req-1',
    });
    expect(() =>
      gw.validarWebhook({
        assinatura: semId,
        idDaRequisicao: 'req-1',
        idDoRecurso: undefined,
        topico: 'payment',
      }),
    ).toThrow(AssinaturaDeWebhookInvalidaError);
  });
});
