import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CenarioDePagamento } from '../helpers/pagamentos.js';
import {
  json,
  CHAVE_DE_API,
  avisar,
  cadastrar,
  configDePagamento,
  montarCenarioDePagamento,
  precificar,
} from '../helpers/pagamentos.js';
import { construirServidor } from '../../src/main/http/servidor.js';

/*
 * Cobrança recorrente de ponta a ponta, SEM rede: o servidor real, o SQLite em memória e o
 * `GatewayFalso` no lugar do Mercado Pago. A conferência da assinatura do aviso é a REAL (mesmo HMAC).
 * Nenhum e-mail, token ou id aqui é de verdade.
 */

let c: CenarioDePagamento;
afterEach(async () => {
  await c.servidor.close();
  vi.restoreAllMocks();
});

async function contaComCheckout(email = 'ana@exemplo.test'): Promise<{
  cookie: string;
  workspace: string;
  gatewayId: string;
  referencia: string;
}> {
  const conta = await cadastrar(c, email);
  const r = await c.servidor.inject({
    method: 'POST',
    url: '/v1/assinatura/checkout',
    headers: { cookie: conta.cookie },
    payload: { plano: 'pecas' },
  });
  expect(r.statusCode).toBe(200);
  const pedido = c.gateway.pedidos.at(-1)!;
  const cob = await c.app.pagamentos!.cobrancaDe(conta.workspace);
  return { ...conta, gatewayId: cob!.gatewayId!, referencia: pedido.referencia };
}

/** Aprova uma parcela no "gateway" e entrega o aviso de cobrança recorrente. */
async function aprovar(
  gatewayId: string,
  opcoes: { parcela?: string; pagamento?: string; valor?: number } = {},
) {
  const parcela = opcoes.parcela ?? '4455';
  const pagamento = opcoes.pagamento ?? '900';
  c.gateway.definirEstado(gatewayId, 'autorizada', new Date('2026-11-20T12:00:00.000Z'));
  c.gateway.registrarPagamento(
    gatewayId,
    {
      id: `pg:${pagamento}`,
      pagamentoId: pagamento,
      resultado: 'aprovado',
      valorEmCentavos: opcoes.valor ?? 4990,
      meio: 'cartao',
      ocorridoEm: c.relogio.agora,
    },
    parcela,
  );
  return avisar(c, { topico: 'subscription_authorized_payment', id: parcela });
}

const vencimento = async (workspace: string): Promise<string | undefined> =>
  (await c.app.repositorioAssinaturas.porWorkspace(workspace))?.venceEm.toISOString();

describe('cobrança recorrente — desligada por padrão', () => {
  it('sem PROCESSOVIVO_PAGAMENTO_HABILITADO nenhuma rota existe (checkout, cancelar e webhook dão 404)', async () => {
    c = montarCenarioDePagamento({ comPagamento: false });
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const h = { cookie: conta.cookie };
    expect(
      (
        await c.servidor.inject({
          method: 'POST',
          url: '/v1/assinatura/checkout',
          headers: h,
          payload: { plano: 'pecas' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await c.servidor.inject({
          method: 'DELETE',
          url: '/v1/assinatura/recorrencia',
          headers: h,
        })
      ).statusCode,
    ).toBe(404);
    const aviso = await c.servidor.inject({
      method: 'POST',
      url: '/v1/pagamentos/webhook/mercadopago?data.id=1&type=payment',
      payload: {},
    });
    expect(aviso.statusCode).toBe(404);
    const estado = await c.servidor.inject({
      method: 'GET',
      url: '/v1/assinatura',
      headers: h,
    });
    expect(json(estado)['pagamento']).toEqual({ habilitado: false });
  });
});

describe('cobrança recorrente — checkout', () => {
  it('plano sem preço não contrata: a rota recusa (422) e o gateway nem é chamado', async () => {
    c = montarCenarioDePagamento();
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { cookie: conta.cookie },
      payload: { plano: 'pecas' },
    });
    expect(r.statusCode).toBe(422);
    expect(json(r)['detalhes'].motivo).toBe('plano_sem_preco');
    expect(c.gateway.pedidos).toHaveLength(0);
  });

  it('a tela só recebe `contratavel` para plano com preço e à venda (a MESMA regra da rota)', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    await precificar(c, 'acompanhamento', null);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const r = await c.servidor.inject({
      method: 'GET',
      url: '/v1/assinatura',
      headers: { cookie: conta.cookie },
    });
    const planos = json(r)['planos'] as Array<Record<string, unknown>>;
    expect(planos.find((p) => p['codigo'] === 'pecas')).toMatchObject({
      contratavel: true,
      valorDoCicloCentavos: 4990,
      ciclo: 'mensal',
    });
    expect(planos.find((p) => p['codigo'] === 'acompanhamento')).toMatchObject({
      contratavel: false,
      valorDoCicloCentavos: null,
    });
  });

  it('plano pausado e ciclo ainda não vendável também recusam', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990, false);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const h = { cookie: conta.cookie };
    let r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: h,
      payload: { plano: 'pecas' },
    });
    expect(json(r)['detalhes'].motivo).toBe('plano_nao_vendavel');
    await precificar(c, 'pecas', 4990, true);
    await c.app.planos.atualizar('pecas', { ciclo: 'anual' });
    r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: h,
      payload: { plano: 'pecas' },
    });
    expect(r.statusCode).toBe(422);
    expect(json(r)['detalhes'].motivo).toBe('ciclo_nao_suportado');
    r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: h,
      payload: { plano: 'nao-existe' },
    });
    expect(json(r)['detalhes'].motivo).toBe('plano_desconhecido');
    expect(c.gateway.pedidos).toHaveLength(0);
  });

  it('cria a assinatura e devolve só a URL hospedada; valor e e-mail vêm do servidor, nunca do cliente', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const h = { cookie: conta.cookie };

    // O corpo aceita só o código do plano.
    const ruim = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: h,
      payload: { plano: 'pecas', valor: 1, email: 'x@y.z' },
    });
    expect(ruim.statusCode).toBe(400);
    expect(c.gateway.pedidos).toHaveLength(0);

    const r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: h,
      payload: { plano: 'pecas' },
    });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({
      urlDeCheckout: 'https://pagamento-falso.exemplo.invalid/checkout/fake-assinatura-1',
    });

    const pedido = c.gateway.pedidos[0]!;
    expect(pedido.valorEmCentavos).toBe(4990);
    expect(pedido.ciclo).toBe('mensal');
    expect(pedido.emailDoPagador).toBe('ana@exemplo.test');
    expect(pedido.urlDeRetorno).toBe('https://app.exemplo.test/?assinatura=retorno');
    expect(pedido.urlDeNotificacao).toBe(
      'https://app.exemplo.test/v1/pagamentos/webhook/mercadopago',
    );
    // O vínculo com o workspace é opaco: nem o e-mail nem o id do workspace em claro.
    expect(pedido.referencia).not.toContain('ana');
    expect(pedido.referencia).not.toContain(conta.workspace);
    expect(pedido.chaveDeIdempotencia).toBe(pedido.referencia);

    // O que fica guardado é só metadado: nenhum e-mail, nome ou dado de cartão.
    const cob = await c.app.pagamentos!.cobrancaDe(conta.workspace);
    expect(cob).toMatchObject({
      plano: 'pecas',
      valorEmCentavos: 4990,
      estado: 'pendente',
      gatewayId: 'fake-assinatura-1',
    });
    expect(JSON.stringify(cob)).not.toContain('ana@');
  });

  it('a referência real é aleatória e de uso único (sem o gerador de teste)', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    await c.servidor.close();
    // Sem injetar `gerarReferencia`, o serviço gera 24 bytes aleatórios em hex.
    const { aplicacaoDeTeste } = await import('../helpers/aplicacao.js');
    const { GatewayFalso } =
      await import('../../src/infrastructure/adapters/pagamento/GatewayFalso.js');
    const { ProviderFalso } = await import('../helpers/fabricas.js');
    const gw = new GatewayFalso();
    const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
      pagamentos: { gateway: gw },
    });
    c = { ...c, servidor: construirServidor(app, configDePagamento()), app, gateway: gw };
    await app.planos.atualizar('pecas', {
      precoMensalCentavos: 4990,
      disponivelParaContratacao: true,
    });
    const a = await cadastrar(c, 'ana@exemplo.test');
    const b = await cadastrar(c, 'beto@exemplo.test');
    for (const conta of [a, b]) {
      await c.servidor.inject({
        method: 'POST',
        url: '/v1/assinatura/checkout',
        headers: { cookie: conta.cookie },
        payload: { plano: 'pecas' },
      });
    }
    const [r1, r2] = gw.pedidos.map((p) => p.referencia);
    expect(r1).toMatch(/^[0-9a-f]{48}$/);
    expect(r2).toMatch(/^[0-9a-f]{48}$/);
    expect(r1).not.toBe(r2);
  });

  it('conta de chave de API (sem e-mail) é recusada com mensagem clara', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { 'x-api-key': CHAVE_DE_API },
      payload: { plano: 'pecas' },
    });
    expect(r.statusCode).toBe(403);
    expect(json(r)['detalhes'].motivo).toBe('conta_sem_email');
    expect(json(r)['mensagem']).toMatch(/e-mail/);
    expect(c.gateway.pedidos).toHaveLength(0);
  });

  it('exige autenticação (sem cookie nem chave, 401)', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      payload: { plano: 'pecas' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('gateway indisponível: 503, a linha não fica "pendente" para sempre e dá para tentar de novo', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const h = { cookie: conta.cookie };
    c.gateway.falharProximaChamada = 'indisponivel';
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: h,
      payload: { plano: 'pecas' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toMatch(/falha simulada/);
    const estado = json(
      await c.servidor.inject({ method: 'GET', url: '/v1/assinatura', headers: h }),
    );
    expect(estado['pagamento'].processando).toBe(false);
    const de_novo = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: h,
      payload: { plano: 'pecas' },
    });
    expect(de_novo.statusCode).toBe(200);
  });

  it('o retorno do checkout mostra "processando" até o servidor confirmar; quem confirma é o webhook', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    const ler = async () =>
      json(
        await c.servidor.inject({
          method: 'GET',
          url: '/v1/assinatura',
          headers: { cookie: conta.cookie },
        }),
      )['pagamento'];
    expect((await ler()).processando).toBe(true);
    expect((await ler()).recorrencia.renovacaoAutomatica).toBe(false);

    c.gateway.definirEstado(
      conta.gatewayId,
      'autorizada',
      new Date('2026-11-20T12:00:00.000Z'),
    );
    const r = await avisar(c, {
      topico: 'subscription_preapproval',
      id: conta.gatewayId,
    });
    expect(r.statusCode).toBe(200);
    const depois = await ler();
    expect(depois.processando).toBe(false);
    expect(depois.recorrencia).toMatchObject({
      estado: 'autorizada',
      renovacaoAutomatica: true,
      proximaCobranca: '2026-11-20T12:00:00.000Z',
    });
  });

  it('quem já tem renovação automática ativa não abre outra (409)', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    c.gateway.definirEstado(conta.gatewayId, 'autorizada');
    await avisar(c, { topico: 'subscription_preapproval', id: conta.gatewayId });
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { cookie: conta.cookie },
      payload: { plano: 'pecas' },
    });
    expect(r.statusCode).toBe(409);
    expect(json(r)['detalhes'].motivo).toBe('ja_assinante');
  });
});

describe('cobrança recorrente — webhook: autenticação', () => {
  async function cenarioPronto() {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    c.gateway.definirEstado(conta.gatewayId, 'autorizada');
    return conta;
  }

  for (const [nome, assinatura] of [
    ['ausente', null],
    ['malformada', 'lixo'],
    [
      'adulterada',
      'ts=1760961600,v1=00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff',
    ],
  ] as const) {
    it(`assinatura ${nome}: 401 e NADA é gravado nem consultado`, async () => {
      const conta = await cenarioPronto();
      const consultasAntes = c.gateway.consultas;
      const r = await avisar(c, {
        topico: 'subscription_preapproval',
        id: conta.gatewayId,
        assinatura,
      });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ erro: 'ASSINATURA_DE_WEBHOOK_INVALIDA' });
      expect(c.gateway.consultas).toBe(consultasAntes);
      expect((await c.app.pagamentos!.cobrancaDe(conta.workspace))!.estado).toBe(
        'pendente',
      );
    });
  }

  it('assinatura válida de OUTRO recurso (data.id diferente): 401', async () => {
    const conta = await cenarioPronto();
    const assinaturaDoOutro = c.gateway.assinarAviso({
      idDoRecurso: 'outro-id',
      idDaRequisicao: 'req-sintetico-1',
    });
    const r = await avisar(c, {
      topico: 'subscription_preapproval',
      id: conta.gatewayId,
      assinatura: assinaturaDoOutro,
    });
    expect(r.statusCode).toBe(401);
    expect((await c.app.pagamentos!.cobrancaDe(conta.workspace))!.estado).toBe(
      'pendente',
    );
  });

  it('timestamp velho (mais de 5 minutos): 401, mesmo com o hash certo', async () => {
    const conta = await cenarioPronto();
    const velho = Math.floor(c.relogio.agora.getTime() / 1000) - 600;
    const r = await avisar(c, {
      topico: 'subscription_preapproval',
      id: conta.gatewayId,
      ts: velho,
    });
    expect(r.statusCode).toBe(401);
    expect((await c.app.pagamentos!.cobrancaDe(conta.workspace))!.estado).toBe(
      'pendente',
    );
  });

  it('a rota é PÚBLICA: não pede cookie nem chave (com assinatura válida, passa)', async () => {
    const conta = await cenarioPronto();
    const r = await avisar(c, {
      topico: 'subscription_preapproval',
      id: conta.gatewayId,
    });
    expect(r.statusCode).toBe(200);
  });

  it('o corpo do aviso não é fonte de nada: um corpo mentiroso não muda o que a consulta diz', async () => {
    const conta = await cenarioPronto();
    c.gateway.definirEstado(conta.gatewayId, 'pausada');
    const r = await c.servidor.inject({
      method: 'POST',
      url: `/v1/pagamentos/webhook/mercadopago?data.id=${conta.gatewayId}&type=subscription_preapproval`,
      headers: {
        'x-signature': c.gateway.assinarAviso({
          idDoRecurso: conta.gatewayId,
          idDaRequisicao: 'req-1',
        }),
        'x-request-id': 'req-1',
      },
      payload: {
        type: 'subscription_preapproval',
        data: { id: conta.gatewayId },
        status: 'authorized',
        action: 'approved',
      },
    });
    expect(r.statusCode).toBe(200);
    expect((await c.app.pagamentos!.cobrancaDe(conta.workspace))!.estado).toBe('pausada');
  });
});

describe('cobrança recorrente — pagamento aprovado renova pelo MESMO caminho do manual', () => {
  it('o resultado é idêntico ao de `assinatura liberar` (vencimento, carência, plano, fim do teste)', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const paga = await contaComCheckout('paga@exemplo.test');
    const manual = await cadastrar(c, 'manual@exemplo.test');

    const r = await aprovar(paga.gatewayId);
    expect(r.statusCode).toBe(200);
    await c.app.assinaturas.liberar({
      workspace: manual.workspace,
      plano: 'pecas',
      meses: 1,
    });

    const a = (await c.app.repositorioAssinaturas.porWorkspace(paga.workspace))!;
    const b = (await c.app.repositorioAssinaturas.porWorkspace(manual.workspace))!;
    expect(a.plano).toBe('pecas');
    expect(a.ehTeste).toBe(false);
    expect(a.venceEm.toISOString()).toBe(b.venceEm.toISOString());
    expect(a.diasDeCarencia).toBe(b.diasDeCarencia);
    expect(a.estaVigenteEm(c.relogio.agora)).toBe(true);
    expect(a.observacao).toMatch(/recorrente/i);
  });

  it('o mesmo aviso 3 vezes renova UMA vez só', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId);
    const depoisDa1 = await vencimento(conta.workspace);
    expect(
      (await avisar(c, { topico: 'subscription_authorized_payment', id: '4455' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await avisar(c, { topico: 'subscription_authorized_payment', id: '4455' }))
        .statusCode,
    ).toBe(200);
    expect(await vencimento(conta.workspace)).toBe(depoisDa1 as string);
  });

  it('o aviso de `payment` do MESMO pagamento não renova de novo (a chave é a do pagamento)', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId);
    const antes = await vencimento(conta.workspace);
    const r = await avisar(c, { topico: 'payment', id: '900' });
    expect(r.statusCode).toBe(200);
    expect(await vencimento(conta.workspace)).toBe(antes);
  });

  it('o ciclo seguinte (outro pagamento) renova de novo, a partir do vencimento', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId, { parcela: '1', pagamento: '10' });
    const primeiro = new Date((await vencimento(conta.workspace))!);
    await aprovar(conta.gatewayId, { parcela: '2', pagamento: '11' });
    const segundo = new Date((await vencimento(conta.workspace))!);
    expect(segundo.getTime()).toBeGreaterThan(primeiro.getTime());
    const dias = (segundo.getTime() - primeiro.getTime()) / 86_400_000;
    expect(dias).toBeGreaterThanOrEqual(28);
    expect(dias).toBeLessThanOrEqual(31);
  });

  it('aprovado antes do aviso da assinatura (fora de ordem): renova e já marca como autorizada', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId);
    const cob = (await c.app.pagamentos!.cobrancaDe(conta.workspace))!;
    expect(cob.estado).toBe('autorizada');
    expect(cob.ultimoPagamento).toBe('aprovado');
    expect(cob.meio).toBe('cartao');
  });

  it('assinatura DESCONHECIDA (de outro sistema): 200, nada é gravado e nada renova', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    c.gateway.registrarPagamento(
      conta.gatewayId,
      {
        id: 'pg:1',
        pagamentoId: '1',
        resultado: 'aprovado',
        valorEmCentavos: 1000,
        assinaturaId: 'de-outro-sistema',
      },
      '77',
    );
    const antes = await vencimento(conta.workspace);
    const r = await avisar(c, { topico: 'subscription_authorized_payment', id: '77' });
    expect(r.statusCode).toBe(200);
    expect(await vencimento(conta.workspace)).toBe(antes);
  });

  it('falha ao renovar NÃO deixa o pagamento "processado": o aviso repetido tenta de novo e renova', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    vi.spyOn(c.app.assinaturas, 'liberar').mockRejectedValueOnce(
      new Error('falha simulada'),
    );
    const primeira = await aprovar(conta.gatewayId);
    expect(primeira.statusCode).toBe(500);
    expect(
      await c.app.repositorioAssinaturas.porWorkspace(conta.workspace),
    ).toBeUndefined();
    const segunda = await avisar(c, {
      topico: 'subscription_authorized_payment',
      id: '4455',
    });
    expect(segunda.statusCode).toBe(200);
    expect(await vencimento(conta.workspace)).toBeDefined();
  });

  it('gateway indisponível na consulta: 503 (para o gateway repetir) e nada é registrado', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    c.gateway.definirEstado(conta.gatewayId, 'autorizada');
    c.gateway.registrarPagamento(
      conta.gatewayId,
      { id: 'pg:900', pagamentoId: '900', resultado: 'aprovado', valorEmCentavos: 4990 },
      '4455',
    );
    c.gateway.falharProximaChamada = 'indisponivel';
    const r = await avisar(c, { topico: 'subscription_authorized_payment', id: '4455' });
    expect(r.statusCode).toBe(503);
    const de_novo = await avisar(c, {
      topico: 'subscription_authorized_payment',
      id: '4455',
    });
    expect(de_novo.statusCode).toBe(200);
    expect(await vencimento(conta.workspace)).toBeDefined();
  });

  it('o gateway recusa a consulta (id que não existe, aviso de teste do painel): 200, para ele não insistir', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const r = await avisar(c, {
      topico: 'subscription_authorized_payment',
      id: 'nao-existe',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ignorado: true });
  });
});

describe('cobrança recorrente — recusa, cancelamento, pausa e estorno', () => {
  it('recusado: o plano segue, a conta é avisada (sem dado do cartão) e a mesma parcela avisa UMA vez', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId, { parcela: '1', pagamento: '10' });
    const venceAntes = await vencimento(conta.workspace);
    c.notificador.enviadas.length = 0;

    c.gateway.registrarPagamento(
      conta.gatewayId,
      { id: 'cob:2', resultado: 'recusado', valorEmCentavos: 4990 },
      '2',
    );
    expect(
      (await avisar(c, { topico: 'subscription_authorized_payment', id: '2' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await avisar(c, { topico: 'subscription_authorized_payment', id: '2' }))
        .statusCode,
    ).toBe(200);

    expect(await vencimento(conta.workspace)).toBe(venceAntes);
    expect(c.notificador.enviadas).toHaveLength(1);
    const e = c.notificador.enviadas[0]!;
    expect(e.para).toBe('ana@exemplo.test');
    expect(e.assunto).toMatch(/não conseguimos cobrar/);
    expect(e.texto).toMatch(/continua valendo até/);
    expect(e.texto).not.toMatch(/final \d|\d{4} \d{4}|cvv|bandeira/i);
    expect((await c.app.pagamentos!.cobrancaDe(conta.workspace))!.ultimoPagamento).toBe(
      'recusado',
    );
  });

  it('o tópico `payment` com pagamento recusado não dobra o aviso (só a parcela fala de recusa)', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    c.notificador.enviadas.length = 0;
    c.gateway.registrarPagamento(conta.gatewayId, {
      id: 'pg:55',
      pagamentoId: '55',
      resultado: 'recusado',
      valorEmCentavos: 4990,
    });
    await avisar(c, { topico: 'payment', id: '55' });
    expect(c.notificador.enviadas).toHaveLength(0);
  });

  it('assinatura cancelada no gateway: "sem renovação", o plano SEGUE até o fim do período pago e a conta é avisada', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId);
    const vence = await vencimento(conta.workspace);
    c.notificador.enviadas.length = 0;

    c.gateway.definirEstado(conta.gatewayId, 'cancelada');
    expect(
      (await avisar(c, { topico: 'subscription_preapproval', id: conta.gatewayId }))
        .statusCode,
    ).toBe(200);

    const cob = (await c.app.pagamentos!.cobrancaDe(conta.workspace))!;
    expect(cob.estado).toBe('cancelada');
    expect(cob.renovacaoCanceladaEm).toBeDefined();
    expect(await vencimento(conta.workspace)).toBe(vence);
    const a = (await c.app.repositorioAssinaturas.porWorkspace(conta.workspace))!;
    expect(a.canceladaEm).toBeUndefined();
    expect(a.estaVigenteEm(c.relogio.agora)).toBe(true);
    expect(c.notificador.enviadas).toHaveLength(1);
    expect(c.notificador.enviadas[0]!.assunto).toMatch(
      /renovação automática foi encerrada/,
    );
  });

  it('assinatura pausada também vira "sem renovação" e o plano segue', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId);
    c.gateway.definirEstado(conta.gatewayId, 'pausada');
    await avisar(c, { topico: 'subscription_preapproval', id: conta.gatewayId });
    const cob = (await c.app.pagamentos!.cobrancaDe(conta.workspace))!;
    expect(cob).toMatchObject({ estado: 'pausada' });
    expect(cob.renovacaoCanceladaEm).toBeDefined();
    const estado = json(
      await c.servidor.inject({
        method: 'GET',
        url: '/v1/assinatura',
        headers: { cookie: conta.cookie },
      }),
    );
    expect(estado['pagamento'].recorrencia.renovacaoAutomatica).toBe(false);
  });

  it('estorno: registra, avisa o operador e NÃO revoga o acesso sozinho', async () => {
    c = montarCenarioDePagamento({ emailDoOperador: 'operador@exemplo.test' });
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId);
    const vence = await vencimento(conta.workspace);
    c.notificador.enviadas.length = 0;

    c.gateway.registrarPagamento(conta.gatewayId, {
      id: 'pg:900',
      pagamentoId: '900',
      resultado: 'estornado',
      valorEmCentavos: 4990,
    });
    expect((await avisar(c, { topico: 'payment', id: '900' })).statusCode).toBe(200);
    // Repetido: não avisa de novo.
    await avisar(c, { topico: 'payment', id: '900' });

    expect(await vencimento(conta.workspace)).toBe(vence);
    const a = (await c.app.repositorioAssinaturas.porWorkspace(conta.workspace))!;
    expect(a.estaVigenteEm(c.relogio.agora)).toBe(true);
    expect(c.notificador.enviadas).toHaveLength(1);
    expect(c.notificador.enviadas[0]!.para).toBe('operador@exemplo.test');
    expect(c.notificador.enviadas[0]!.texto).toMatch(/NÃO revogou/);
    expect(c.notificador.enviadas[0]!.texto).not.toContain(conta.workspace);
    expect((await c.app.pagamentos!.cobrancaDe(conta.workspace))!.ultimoPagamento).toBe(
      'estornado',
    );
  });

  it('contestação (chargeback) segue a mesma regra do estorno', async () => {
    c = montarCenarioDePagamento({ emailDoOperador: 'operador@exemplo.test' });
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId);
    c.notificador.enviadas.length = 0;
    c.gateway.registrarPagamento(conta.gatewayId, {
      id: 'pg:900',
      pagamentoId: '900',
      resultado: 'contestado',
      valorEmCentavos: 4990,
    });
    await avisar(c, { topico: 'payment', id: '900' });
    expect(c.notificador.enviadas[0]!.assunto).toMatch(/contestado/);
    expect((await c.app.pagamentos!.cobrancaDe(conta.workspace))!.ultimoPagamento).toBe(
      'contestado',
    );
  });

  it('estorno que chega ANTES da aprovação: a aprovação depois NÃO renova um pagamento já devolvido', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    c.gateway.definirEstado(conta.gatewayId, 'autorizada');
    c.gateway.registrarPagamento(conta.gatewayId, {
      id: 'pg:900',
      pagamentoId: '900',
      resultado: 'estornado',
      valorEmCentavos: 4990,
    });
    await avisar(c, { topico: 'payment', id: '900' });
    c.gateway.registrarPagamento(
      conta.gatewayId,
      { id: 'pg:900', pagamentoId: '900', resultado: 'aprovado', valorEmCentavos: 4990 },
      '4455',
    );
    await avisar(c, { topico: 'subscription_authorized_payment', id: '4455' });
    expect(
      await c.app.repositorioAssinaturas.porWorkspace(conta.workspace),
    ).toBeUndefined();
  });
});

describe('cobrança recorrente — cancelar a renovação (pela conta)', () => {
  it('cancela no gateway, o plano continua até o fim do período pago e o evento fica registrado', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId);
    const vence = await vencimento(conta.workspace);

    const r = await c.servidor.inject({
      method: 'DELETE',
      url: '/v1/assinatura/recorrencia',
      headers: { cookie: conta.cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(c.gateway.cancelamentos).toEqual([conta.gatewayId]);
    expect(json(r)['pagamento'].recorrencia).toMatchObject({
      estado: 'cancelada',
      renovacaoAutomatica: false,
    });
    expect(json(r)['pagamento'].recorrencia.renovacaoCanceladaEm).toBeTruthy();

    expect(await vencimento(conta.workspace)).toBe(vence);
    const a = (await c.app.repositorioAssinaturas.porWorkspace(conta.workspace))!;
    expect(a.estaVigenteEm(c.relogio.agora)).toBe(true);
    expect(a.canceladaEm).toBeUndefined();

    const eventos = await c.app.pagamentos!.eventosDe(conta.referencia);
    expect(eventos.map((e) => e.tipo)).toContain('renovacao_cancelada_pelo_usuario');
  });

  it('sem renovação para cancelar: 409', async () => {
    c = montarCenarioDePagamento();
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const r = await c.servidor.inject({
      method: 'DELETE',
      url: '/v1/assinatura/recorrencia',
      headers: { cookie: conta.cookie },
    });
    expect(r.statusCode).toBe(409);
    expect(json(r)['detalhes'].motivo).toBe('sem_recorrencia');
  });

  it('falha do gateway ao cancelar: erro 503 e NADA muda do nosso lado (continua ativa)', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId);
    c.gateway.falharProximaChamada = 'indisponivel';
    const r = await c.servidor.inject({
      method: 'DELETE',
      url: '/v1/assinatura/recorrencia',
      headers: { cookie: conta.cookie },
    });
    expect(r.statusCode).toBe(503);
    expect((await c.app.pagamentos!.cobrancaDe(conta.workspace))!.estado).toBe(
      'autorizada',
    );
  });

  it('ISOLAMENTO: uma conta não vê nem cancela a assinatura da outra', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const a = await contaComCheckout('a@exemplo.test');
    await aprovar(a.gatewayId);
    const b = await cadastrar(c, 'b@exemplo.test');

    const verB = json(
      await c.servidor.inject({
        method: 'GET',
        url: '/v1/assinatura',
        headers: { cookie: b.cookie },
      }),
    );
    expect(verB['pagamento'].recorrencia).toBeNull();
    expect(JSON.stringify(verB)).not.toContain(a.gatewayId);

    const r = await c.servidor.inject({
      method: 'DELETE',
      url: '/v1/assinatura/recorrencia',
      headers: { cookie: b.cookie },
    });
    expect(r.statusCode).toBe(409);
    expect(c.gateway.cancelamentos).toHaveLength(0);
    expect((await c.app.pagamentos!.cobrancaDe(a.workspace))!.estado).toBe('autorizada');
  });

  it('GET /v1/assinatura não expõe segredo, id do gateway nem a referência', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId);
    const r = await c.servidor.inject({
      method: 'GET',
      url: '/v1/assinatura',
      headers: { cookie: conta.cookie },
    });
    expect(r.body).not.toContain(conta.gatewayId);
    expect(r.body).not.toContain(conta.referencia);
    expect(r.body).not.toContain('ana@exemplo.test');
  });
});

describe('cobrança recorrente — reconciliação (aviso perdido)', () => {
  it('corrige o estado e renova um pagamento cujo aviso se perdeu — uma vez só', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    c.gateway.definirEstado(
      conta.gatewayId,
      'autorizada',
      new Date('2026-11-20T12:00:00.000Z'),
    );
    c.gateway.registrarPagamento(
      conta.gatewayId,
      {
        id: 'pg:900',
        pagamentoId: '900',
        resultado: 'aprovado',
        valorEmCentavos: 4990,
        meio: 'cartao',
      },
      '4455',
    );

    const r1 = await c.app.pagamentos!.reconciliar();
    expect(r1).toEqual({ verificadas: 1, corrigidas: 1, pagamentosNovos: 1, falhas: 0 });
    const apos = await vencimento(conta.workspace);
    expect(apos).toBeDefined();
    expect((await c.app.pagamentos!.cobrancaDe(conta.workspace))!.estado).toBe(
      'autorizada',
    );

    const r2 = await c.app.pagamentos!.reconciliar({ workspace: conta.workspace });
    expect(r2).toMatchObject({ verificadas: 1, corrigidas: 0, pagamentosNovos: 0 });
    expect(await vencimento(conta.workspace)).toBe(apos);
  });

  it('uma falha numa conta não interrompe as outras', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const a = await contaComCheckout('a@exemplo.test');
    const b = await contaComCheckout('b@exemplo.test');
    c.gateway.definirEstado(b.gatewayId, 'autorizada');
    c.gateway.falharProximaChamada = 'indisponivel'; // derruba a consulta da PRIMEIRA (a)
    const r = await c.app.pagamentos!.reconciliar();
    expect(r.verificadas).toBe(2);
    expect(r.falhas).toBe(1);
    expect((await c.app.pagamentos!.cobrancaDe(b.workspace))!.estado).toBe('autorizada');
    expect(a.workspace).not.toBe(b.workspace);
  });

  it('a CLI/rota de reconciliar sem a cobrança habilitada não existe como serviço', async () => {
    c = montarCenarioDePagamento({ comPagamento: false });
    expect(c.app.pagamentos).toBeUndefined();
  });
});
