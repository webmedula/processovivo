import { describe, expect, it } from 'vitest';
import {
  GatewayDePagamentoIndisponivelError,
  GatewayDePagamentoRecusouError,
} from '../../src/domain/errors/index.js';
import type { Logger } from '../../src/domain/ports/Logger.js';
import { MercadoPagoAdapter } from '../../src/infrastructure/adapters/pagamento/MercadoPagoAdapter.js';
import type {
  PedidoDoGateway,
  RespostaDoGateway,
  TransporteDoGateway,
} from '../../src/infrastructure/adapters/pagamento/TransporteDoGateway.js';

/*
 * A recusa (4xx) do Mercado Pago no adapter (v0.45.1): o erro carrega o motivo, e UM `warn` diz por quê.
 * Respostas escritas à mão; e-mail, token e ids sintéticos; sem rede.
 */
const TOKEN = 'APP_USR-token-sintetico-0000';
const EMAIL = 'comprador@exemplo.test';

class Transporte implements TransporteDoGateway {
  readonly pedidos: PedidoDoGateway[] = [];
  constructor(private readonly r: RespostaDoGateway) {}
  async requisitar(p: PedidoDoGateway): Promise<RespostaDoGateway> {
    this.pedidos.push(p);
    return this.r;
  }
}

class LoggerEspiao implements Logger {
  readonly linhas: Array<{
    nivel: string;
    mensagem: string;
    contexto: Record<string, unknown>;
  }> = [];
  private reg(nivel: string) {
    return (mensagem: string, contexto: Record<string, unknown> = {}): void => {
      this.linhas.push({ nivel, mensagem, contexto });
    };
  }
  debug = this.reg('debug');
  info = this.reg('info');
  warn = this.reg('warn');
  error = this.reg('error');
  child(): Logger {
    return this;
  }
}

const PEDIDO = {
  referencia: 'ref-sintetica-1',
  motivo: 'Processo Vivo — plano Peças',
  emailDoPagador: EMAIL,
  valorEmCentavos: 4990,
  ciclo: 'mensal' as const,
  urlDeRetorno: 'https://app.exemplo.test/?assinatura=retorno',
  urlDeNotificacao: 'https://app.exemplo.test/v1/pagamentos/webhook/mercadopago',
  chaveDeIdempotencia: 'ref-sintetica-1',
};

function montar(status: number, corpo: unknown) {
  const transporte = new Transporte({
    status,
    corpo: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
  const logger = new LoggerEspiao();
  const gw = new MercadoPagoAdapter({
    accessToken: TOKEN,
    ambiente: 'teste',
    segredoDoWebhook: 'segredo-sintetico',
    transporte,
    logger,
    esperar: async () => {},
  });
  return { gw, transporte, logger };
}

describe('MercadoPagoAdapter — 400 na criação da assinatura', () => {
  it('payer_email recusado: erro com motivo email_pagador e UM warn com status, error, message, causas e campos', async () => {
    const { gw, logger, transporte } = montar(400, {
      message: `Invalid value for payer_email ${EMAIL}`,
      error: 'bad_request',
      status: 400,
      cause: [{ code: 'E_MAIL', description: `payer_email ${EMAIL} is not valid` }],
    });
    const erro = await gw.criarAssinatura(PEDIDO).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(GatewayDePagamentoRecusouError);
    const recusou = erro as GatewayDePagamentoRecusouError;
    expect(recusou.status).toBe(400);
    expect(recusou.motivoDoGateway).toBe('email_pagador');
    expect(recusou.diagnostico?.camposEnviados).toEqual([
      'reason',
      'external_reference',
      'payer_email',
      'back_url',
      'notification_url',
      'status',
      'auto_recurring.frequency',
      'auto_recurring.frequency_type',
      'auto_recurring.transaction_amount',
      'auto_recurring.currency_id',
    ]);
    // Criar nunca repete sozinho.
    expect(transporte.pedidos).toHaveLength(1);

    const avisos = logger.linhas.filter((l) => l.nivel === 'warn');
    expect(avisos).toHaveLength(1);
    const c = avisos[0]!.contexto;
    expect(c).toMatchObject({
      operacao: 'criarAssinatura',
      status: 400,
      motivo: 'email_pagador',
      erro: 'bad_request',
    });
    expect(c['causas']).toEqual([
      { codigo: 'E_MAIL', descricao: 'payer_email c***@e***.test is not valid' },
    ]);
  });

  it('o log e o erro NUNCA levam token, e-mail em claro, valores do pedido nem corpo bruto', async () => {
    const { gw, logger } = montar(400, {
      message: `bad ${EMAIL} ${TOKEN}`,
      error: 'bad_request',
      cause: [{ code: 'X', description: `usuario ${EMAIL}` }],
      eco_do_pedido: {
        reason: 'Processo Vivo — plano Peças',
        external_reference: 'ref-sintetica-1',
      },
    });
    const erro = await gw.criarAssinatura(PEDIDO).catch((e: unknown) => e);
    const tudo = JSON.stringify([
      logger.linhas,
      (erro as Error).message,
      (erro as GatewayDePagamentoRecusouError).diagnostico,
    ]);
    expect(tudo).not.toContain(TOKEN);
    expect(tudo).not.toContain('APP_USR');
    expect(tudo).not.toContain(EMAIL);
    expect(tudo).not.toContain('eco_do_pedido');
    // Nomes dos campos sim; valores não.
    expect(tudo).toContain('payer_email');
    expect(tudo).not.toContain('Processo Vivo');
    expect(tudo).not.toContain('ref-sintetica-1');
    expect(tudo).not.toContain('app.exemplo.test');
    expect(tudo).not.toContain('49.9');
  });

  it('back_url recusada: motivo parametro_invalido', async () => {
    const { gw } = montar(400, {
      message: 'bad_request',
      error: 'bad_request',
      cause: [{ code: 'back_url', description: 'back_url must be a valid https url' }],
    });
    await expect(gw.criarAssinatura(PEDIDO)).rejects.toMatchObject({
      motivoDoGateway: 'parametro_invalido',
    });
  });

  it('401: credencial', async () => {
    const { gw, logger } = montar(401, { message: 'invalid access token', status: 401 });
    await expect(gw.criarAssinatura(PEDIDO)).rejects.toMatchObject({
      status: 401,
      motivoDoGateway: 'credencial',
    });
    expect(logger.linhas.find((l) => l.nivel === 'warn')?.contexto).toMatchObject({
      motivo: 'credencial',
      status: 401,
    });
  });

  it('corpo HTML (proxy no meio) ou vazio: desconhecido, ainda com warn', async () => {
    const { gw, logger } = montar(400, '<html>Bad Request</html>');
    await expect(gw.criarAssinatura(PEDIDO)).rejects.toMatchObject({
      motivoDoGateway: 'desconhecido',
    });
    expect(logger.linhas.filter((l) => l.nivel === 'warn')).toHaveLength(1);
  });

  it('5xx e 429: indisponível (não é recusa), sem repetir a criação', async () => {
    for (const status of [500, 503, 429]) {
      const { gw, transporte, logger } = montar(status, { message: 'x' });
      const erro = await gw.criarAssinatura(PEDIDO).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(GatewayDePagamentoIndisponivelError);
      expect((erro as GatewayDePagamentoIndisponivelError).motivoDoGateway).toBe(
        'indisponivel',
      );
      expect(transporte.pedidos).toHaveLength(1);
      expect(logger.linhas.find((l) => l.nivel === 'warn')?.contexto).toMatchObject({
        status,
        operacao: 'criarAssinatura',
      });
    }
  });

  it('sem logger configurado, a recusa ainda vira o erro com o motivo (o log é opcional)', async () => {
    const transporte = new Transporte({
      status: 400,
      corpo: JSON.stringify({ message: 'payer_email' }),
    });
    const gw = new MercadoPagoAdapter({
      accessToken: TOKEN,
      ambiente: 'teste',
      segredoDoWebhook: 'segredo-sintetico',
      transporte,
    });
    await expect(gw.criarAssinatura(PEDIDO)).rejects.toMatchObject({
      motivoDoGateway: 'email_pagador',
    });
  });
});
