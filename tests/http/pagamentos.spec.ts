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
    payload: { plano: 'pecas', aceiteTermos: true },
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
      payload: { plano: 'pecas', aceiteTermos: true },
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
      payload: { plano: 'pecas', aceiteTermos: true },
    });
    expect(json(r)['detalhes'].motivo).toBe('plano_nao_vendavel');
    await precificar(c, 'pecas', 4990, true);
    await c.app.planos.atualizar('pecas', { ciclo: 'anual' });
    r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: h,
      payload: { plano: 'pecas', aceiteTermos: true },
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
      payload: { plano: 'pecas', aceiteTermos: true, valor: 1, email: 'x@y.z' },
    });
    expect(ruim.statusCode).toBe(400);
    expect(c.gateway.pedidos).toHaveLength(0);

    const r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: h,
      payload: { plano: 'pecas', aceiteTermos: true },
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
        payload: { plano: 'pecas', aceiteTermos: true },
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
      payload: { plano: 'pecas', aceiteTermos: true },
    });
    expect(r.statusCode).toBe(403);
    expect(json(r)['detalhes'].motivo).toBe('conta_sem_email');
    expect(json(r)['mensagem']).toMatch(/e-mail/);
    expect(c.gateway.pedidos).toHaveLength(0);
  });

  it('SEM o aceite dos Termos o checkout é recusado (422) e nada nasce: nem cobrança, nem aceite, nem chamada ao gateway', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    for (const payload of [{ plano: 'pecas' }, { plano: 'pecas', aceiteTermos: false }]) {
      const r = await c.servidor.inject({
        method: 'POST',
        url: '/v1/assinatura/checkout',
        headers: { cookie: conta.cookie },
        payload,
      });
      expect(r.statusCode).toBe(422);
      expect(json(r)['detalhes'].motivo).toBe('termos_nao_aceitos');
      expect(json(r)['mensagem']).toMatch(/Termos/);
    }
    // `aceiteTermos` que não é booleano nem passa da validação do corpo.
    const torto = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { cookie: conta.cookie },
      payload: { plano: 'pecas', aceiteTermos: 'sim' },
    });
    expect(torto.statusCode).toBe(400);
    expect(c.gateway.pedidos).toHaveLength(0);
    expect(await c.app.pagamentos!.cobrancaDe(conta.workspace)).toBeUndefined();
    expect(await c.app.pagamentos!.aceitesDe(conta.workspace)).toEqual([]);
  });

  it('com o aceite, grava versão, plano e data ligados ao workspace — e nenhum dado pessoal', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { cookie: conta.cookie },
      payload: { plano: 'pecas', aceiteTermos: true },
    });
    expect(r.statusCode).toBe(200);
    const aceites = await c.app.pagamentos!.aceitesDe(conta.workspace);
    expect(aceites).toEqual([
      {
        workspace: conta.workspace,
        versao: '1.1',
        plano: 'pecas',
        aceitoEm: c.relogio.agora,
      },
    ]);
    expect(JSON.stringify(aceites)).not.toMatch(/ana@|127\.0\.0\.1/);
  });

  it('plano pago e vigente por liberação manual (Pix) do MESMO plano não abre checkout; o teste não conta', async () => {
    c = montarCenarioDePagamento({ comAssinaturas: true });
    await precificar(c, 'pecas', 4990);
    await precificar(c, 'acompanhamento', 1990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const pedir = (plano: string) =>
      c.servidor.inject({
        method: 'POST',
        url: '/v1/assinatura/checkout',
        headers: { cookie: conta.cookie },
        payload: { plano, aceiteTermos: true },
      });
    // Em teste (a conta nova está no plano do teste): assina normalmente.
    const emTeste = (await c.app.repositorioAssinaturas.porWorkspace(conta.workspace))!;
    expect(emTeste.ehTeste).toBe(true);
    await c.app.assinaturas.liberar({
      workspace: conta.workspace,
      plano: 'pecas',
      meses: 2,
    });
    const vigente = await pedir('pecas');
    expect(vigente.statusCode).toBe(409);
    expect(json(vigente)['detalhes'].motivo).toBe('plano_ja_vigente');
    expect(c.gateway.pedidos).toHaveLength(0);
    expect(await c.app.pagamentos!.aceitesDe(conta.workspace)).toEqual([]);
    // Outro plano (sem renovação automática) não é o mesmo plano vigente: segue.
    expect((await pedir('acompanhamento')).statusCode).toBe(200);
  });

  it('o teste de 14 dias não é assinatura ativa: a conta nova assina o plano do teste', async () => {
    c = montarCenarioDePagamento({ comAssinaturas: true });
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const teste = (await c.app.repositorioAssinaturas.porWorkspace(conta.workspace))!;
    expect(teste.plano).toBe('pecas');
    expect(teste.ehTeste).toBe(true);
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { cookie: conta.cookie },
      payload: { plano: 'pecas', aceiteTermos: true },
    });
    expect(r.statusCode).toBe(200);
  });

  it('exige autenticação (sem cookie nem chave, 401)', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      payload: { plano: 'pecas', aceiteTermos: true },
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
      payload: { plano: 'pecas', aceiteTermos: true },
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
      payload: { plano: 'pecas', aceiteTermos: true },
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
      payload: { plano: 'pecas', aceiteTermos: true },
    });
    expect(r.statusCode).toBe(409);
    expect(json(r)['detalhes'].motivo).toBe('ja_assinante');

    // De QUALQUER plano: um segundo checkout geraria uma segunda cobrança recorrente em paralelo.
    await precificar(c, 'acompanhamento', 1990);
    const outro = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { cookie: conta.cookie },
      payload: { plano: 'acompanhamento', aceiteTermos: true },
    });
    expect(outro.statusCode).toBe(409);
    expect(json(outro)['detalhes'].motivo).toBe('ja_assinante');
    expect(json(outro)['mensagem']).toMatch(/cancele a renovação atual primeiro/);
    expect(c.gateway.pedidos).toHaveLength(1);
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

describe('cobrança recorrente — falha do gateway (v0.45.1)', () => {
  const MOTIVOS = [
    'email_pagador',
    'credencial',
    'parametro_invalido',
    'desconhecido',
  ] as const;

  async function pedirCheckout(cookie: string) {
    return c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { cookie },
      payload: { plano: 'pecas', aceiteTermos: true },
    });
  }

  it('recusa do gateway é 422 em JSON, com um motivo de lista fechada e uma frase diferente para cada um — nunca 502', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const frases = new Set<string>();
    for (const motivo of MOTIVOS) {
      c.gateway.falharProximaChamada = 'recusou';
      c.gateway.motivoDaRecusa = motivo;
      const r = await pedirCheckout(conta.cookie);
      expect(r.statusCode, motivo).toBe(422);
      expect(r.headers['content-type']).toMatch(/application\/json/);
      expect(json(r)).toMatchObject({
        erro: 'GATEWAY_DE_PAGAMENTO_RECUSOU',
        detalhes: { situacao: 'gateway_recusou', motivo },
      });
      // A frase é NOSSA: o texto do gateway nunca sai.
      expect(r.body).not.toMatch(/recusa simulada|bad_request/);
      frases.add(json(r)['mensagem']);
    }
    expect(frases.size).toBe(MOTIVOS.length);
  });

  it('gateway fora do ar é 503 em JSON com motivo `indisponivel`', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    c.gateway.falharProximaChamada = 'indisponivel';
    const r = await pedirCheckout(conta.cookie);
    expect(r.statusCode).toBe(503);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(json(r)).toMatchObject({
      erro: 'GATEWAY_DE_PAGAMENTO_INDISPONIVEL',
      detalhes: { situacao: 'gateway_indisponivel', motivo: 'indisponivel' },
    });
  });

  it('a falha entra na trilha (operação, status, motivo, código) sem dado do pagador, e a última é a que vale', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    expect(await c.app.pagamentos!.ultimaFalhaDoGateway()).toBeUndefined();
    const conta = await cadastrar(c, 'ana@exemplo.test');
    c.gateway.falharProximaChamada = 'recusou';
    c.gateway.motivoDaRecusa = 'email_pagador';
    await pedirCheckout(conta.cookie);
    expect(await c.app.pagamentos!.ultimaFalhaDoGateway()).toMatchObject({
      operacao: 'criarAssinatura',
      status: 400,
      codigo: 'bad_request',
      motivo: 'email_pagador',
    });
    c.gateway.falharProximaChamada = 'indisponivel';
    await pedirCheckout(conta.cookie);
    expect(await c.app.pagamentos!.ultimaFalhaDoGateway()).toMatchObject({
      motivo: 'indisponivel',
      status: null,
      codigo: null,
    });
    const eventos = await c.app.pagamentos!.eventosDe(
      c.gateway.pedidos.at(-1)?.referencia ?? 'x',
    );
    expect(JSON.stringify(eventos)).not.toContain('ana@');
  });

  it('falha ao cancelar a renovação também é 422/503 em JSON e fica na trilha', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await aprovar(conta.gatewayId);
    c.gateway.falharProximaChamada = 'recusou';
    c.gateway.motivoDaRecusa = 'credencial';
    const r = await c.servidor.inject({
      method: 'DELETE',
      url: '/v1/assinatura/recorrencia',
      headers: { cookie: conta.cookie },
    });
    expect(r.statusCode).toBe(422);
    expect(json(r)['detalhes']).toEqual({
      situacao: 'gateway_recusou',
      motivo: 'credencial',
    });
    expect(await c.app.pagamentos!.ultimaFalhaDoGateway()).toMatchObject({
      operacao: 'cancelarAssinatura',
      motivo: 'credencial',
    });
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
    // v0.49.5: a resposta devolve o e-mail da PRÓPRIA conta, e só no campo `emailDaConta`, para a tela pré-preencher o
    // campo do pagador (antes o teste exigia que o e-mail não aparecesse em lugar nenhum). Em qualquer outro lugar,
    // continua proibido.
    const corpo = json(r)['pagamento'] as Record<string, unknown>;
    expect(corpo['emailDaConta']).toBe('ana@exemplo.test');
    expect(
      JSON.stringify({ ...json(r), pagamento: { ...corpo, emailDaConta: null } }),
    ).not.toContain('ana@exemplo.test');
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

/*
 * v0.49.5: o e-mail de quem paga no Mercado Pago é informado na confirmação (o Mercado Pago recusa o pagamento quando
 * o e-mail do pagador não é o da assinatura), e um checkout novo SUBSTITUI o pendente. Tudo sintético e sem rede.
 */
describe('cobrança recorrente — e-mail do pagador e checkout que substitui o pendente (v0.49.5)', () => {
  const checkout = (cookie: string, extra: Record<string, unknown> = {}) =>
    c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { cookie },
      payload: { plano: 'pecas', aceiteTermos: true, ...extra },
    });

  it('o e-mail informado vai ao gateway como pagador (aparado, em minúsculas); a conta continua com o dela', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const r = await checkout(conta.cookie, {
      emailDoPagador: '  Pagadora.MP@Exemplo.Test ',
    });
    expect(r.statusCode).toBe(200);
    expect(c.gateway.pedidos[0]!.emailDoPagador).toBe('pagadora.mp@exemplo.test');
    expect((await c.app.usuarios.porEmail('ana@exemplo.test'))!.usuario.email).toBe(
      'ana@exemplo.test',
    );
  });

  it('sem o campo (cliente antigo) usa o e-mail da conta, como antes', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    expect((await checkout(conta.cookie)).statusCode).toBe(200);
    expect(c.gateway.pedidos[0]!.emailDoPagador).toBe('ana@exemplo.test');
  });

  it.each([
    ['sem arroba', 'pagadora.exemplo.test'],
    ['com espaço no meio', 'pag adora@exemplo.test'],
    ['sem ponto no domínio', 'pagadora@exemplo'],
    ['vazio', '   '],
    ['maior que 200 caracteres', `${'a'.repeat(195)}@e.test`],
  ])(
    'e-mail do pagador inválido (%s): 422 em português, sem chamar o gateway, sem gravar nada e sem repetir o valor',
    async (_nome, email) => {
      c = montarCenarioDePagamento();
      await precificar(c, 'pecas', 4990);
      const conta = await cadastrar(c, 'ana@exemplo.test');
      const r = await checkout(conta.cookie, { emailDoPagador: email });
      expect(r.statusCode).toBe(422);
      expect(json(r)['detalhes'].motivo).toBe('email_do_pagador_invalido');
      expect(json(r)['mensagem']).toBe('Informe um e-mail válido para o pagamento.');
      if (email.trim()) expect(r.body).not.toContain(email.trim());
      expect(c.gateway.pedidos).toHaveLength(0);
      expect(await c.app.pagamentos!.cobrancaDe(conta.workspace)).toBeUndefined();
      expect(await c.app.pagamentos!.aceitesDe(conta.workspace)).toHaveLength(0);
    },
  );

  it('o campo só aceita texto (não-string é 400) e o corpo continua `.strict()`', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    expect((await checkout(conta.cookie, { emailDoPagador: 42 })).statusCode).toBe(400);
    expect(
      (await checkout(conta.cookie, { emailDoPagador: 'a@b.test', outro: 1 })).statusCode,
    ).toBe(400);
    expect(c.gateway.pedidos).toHaveLength(0);
  });

  it('novo checkout (com outro e-mail) CANCELA a pendente no gateway e nunca deixa duas vivas', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    expect(
      (await checkout(conta.cookie, { emailDoPagador: 'errado@exemplo.test' }))
        .statusCode,
    ).toBe(200);
    const primeira = (await c.app.pagamentos!.cobrancaDe(conta.workspace))!;
    expect(c.gateway.cancelamentos).toEqual([]);

    expect(
      (await checkout(conta.cookie, { emailDoPagador: 'certo@exemplo.test' })).statusCode,
    ).toBe(200);
    expect(c.gateway.cancelamentos).toEqual([primeira.gatewayId]);
    expect(c.gateway.pedidos.map((p) => p.emailDoPagador)).toEqual([
      'errado@exemplo.test',
      'certo@exemplo.test',
    ]);
    const todas = await c.app.pagamentos!.todasAsCobrancas();
    const pendentes = todas.filter(
      (x) => x.workspace === conta.workspace && x.estado === 'pendente',
    );
    expect(pendentes).toHaveLength(1);
    expect(pendentes[0]!.gatewayId).not.toBe(primeira.gatewayId);
    expect(todas.find((x) => x.referencia === primeira.referencia)!.estado).toBe(
      'cancelada',
    );
    // A conta vê só a nova, ainda "processando".
    const ver = json(
      await c.servidor.inject({
        method: 'GET',
        url: '/v1/assinatura',
        headers: { cookie: conta.cookie },
      }),
    )['pagamento'];
    expect(ver.processando).toBe(true);
    expect(ver.recorrencia.estado).toBe('pendente');
    // O aviso (webhook) da assinatura cancelada de propósito não avisa a conta de "renovação encerrada".
    c.notificador.enviadas.length = 0;
    await avisar(c, { topico: 'subscription_preapproval', id: primeira.gatewayId! });
    expect(c.notificador.enviadas).toHaveLength(0);
  });

  it('se o cancelamento da pendente falha, o checkout novo sai do mesmo jeito; a falha vai à trilha sem dado pessoal e a pendente fica para a reconciliação', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    await checkout(conta.cookie, { emailDoPagador: 'errado@exemplo.test' });
    const primeira = (await c.app.pagamentos!.cobrancaDe(conta.workspace))!;
    c.gateway.falharCancelamentos = true;
    const r = await checkout(conta.cookie, { emailDoPagador: 'certo@exemplo.test' });
    expect(r.statusCode).toBe(200);
    expect(c.gateway.pedidos).toHaveLength(2);
    expect(
      (await c.app.pagamentos!.todasAsCobrancas()).find(
        (x) => x.referencia === primeira.referencia,
      )!.estado,
    ).toBe('pendente');
    const eventos = await c.app.pagamentos!.eventosDe(primeira.referencia);
    expect(eventos.map((e) => e.tipo)).toContain('pendente_nao_substituida');
    expect(eventos.map((e) => e.tipo)).toContain('gateway_falhou');
    expect(JSON.stringify(eventos)).not.toMatch(/errado@|certo@|ana@/);
    // A reconciliação (inalterada) consulta as abertas, inclusive a que ficou.
    c.gateway.falharCancelamentos = false;
    const rec = await c.app.pagamentos!.reconciliar({ workspace: conta.workspace });
    expect(rec.verificadas).toBe(2);
  });

  it('se não dá nem para consultar a pendente, o checkout novo sai e nada é cancelado às cegas', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    await checkout(conta.cookie);
    c.gateway.falharProximaChamada = 'indisponivel';
    expect((await checkout(conta.cookie)).statusCode).toBe(200);
    expect(c.gateway.cancelamentos).toEqual([]);
    expect(c.gateway.pedidos).toHaveLength(2);
  });

  it('se o gateway diz que a pendente JÁ foi autorizada, a conta já assinou: 409, nada é cancelado nem criado', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    c.gateway.definirEstado(
      conta.gatewayId,
      'autorizada',
      new Date('2026-11-20T12:00:00.000Z'),
    );
    // (sem nenhum aviso chegar: o webhook ainda não veio)
    const r = await checkout(conta.cookie, { emailDoPagador: 'outro@exemplo.test' });
    expect(r.statusCode).toBe(409);
    expect(json(r)['detalhes'].motivo).toBe('ja_assinante');
    expect(c.gateway.cancelamentos).toEqual([]);
    expect(c.gateway.pedidos).toHaveLength(1);
    expect((await c.app.pagamentos!.cobrancaDe(conta.workspace))!.estado).toBe(
      'autorizada',
    );
  });

  it('isolamento: o checkout de uma conta nunca cancela a pendente de outra', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const a = await cadastrar(c, 'ana@exemplo.test');
    const b = await cadastrar(c, 'bruno@exemplo.test');
    await checkout(a.cookie);
    await checkout(b.cookie);
    const deA = (await c.app.pagamentos!.cobrancaDe(a.workspace))!;
    await checkout(b.cookie, { emailDoPagador: 'outro@exemplo.test' });
    expect(c.gateway.cancelamentos).not.toContain(deA.gatewayId);
    expect(c.gateway.cancelamentos).toHaveLength(1);
    expect(
      (await c.app.pagamentos!.todasAsCobrancas()).find(
        (x) => x.referencia === deA.referencia,
      )!.estado,
    ).toBe('pendente');
  });

  it('a tela recebe o e-mail da PRÓPRIA conta para pré-preencher, e nunca o do pagador digitado nem o de outra conta', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const a = await cadastrar(c, 'ana@exemplo.test');
    const b = await cadastrar(c, 'bruno@exemplo.test');
    await checkout(a.cookie, { emailDoPagador: 'pagadora@exemplo.test' });
    const ler = async (cookie: string) =>
      c.servidor.inject({ method: 'GET', url: '/v1/assinatura', headers: { cookie } });
    const deA = await ler(a.cookie);
    expect(json(deA)['pagamento'].emailDaConta).toBe('ana@exemplo.test');
    expect(deA.body).not.toContain('pagadora@');
    expect(deA.body).not.toContain('bruno@');
    const deB = await ler(b.cookie);
    expect(json(deB)['pagamento'].emailDaConta).toBe('bruno@exemplo.test');
    expect(deB.body).not.toMatch(/ana@|pagadora@/);
  });

  it('o e-mail do pagador não vai ao log, à trilha, ao registro da cobrança nem ao /admin', async () => {
    const linhas: string[] = [];
    const logger = {
      debug: (m: string, x?: unknown) => void linhas.push(m + JSON.stringify(x ?? {})),
      info: (m: string, x?: unknown) => void linhas.push(m + JSON.stringify(x ?? {})),
      warn: (m: string, x?: unknown) => void linhas.push(m + JSON.stringify(x ?? {})),
      error: (m: string, x?: unknown) => void linhas.push(m + JSON.stringify(x ?? {})),
      child: () => logger,
    };
    c = montarCenarioDePagamento({ logger } as never);
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    await checkout(conta.cookie, { emailDoPagador: 'secreto.pagador@exemplo.test' });
    c.gateway.falharCancelamentos = true;
    await checkout(conta.cookie, { emailDoPagador: 'secreto.pagador@exemplo.test' });
    const cob = (await c.app.pagamentos!.cobrancaDe(conta.workspace))!;
    const tudo = JSON.stringify({
      cob,
      eventos: await c.app.pagamentos!.eventosDe(cob.referencia),
      todas: await c.app.pagamentos!.todasAsCobrancas(),
      ultima: await c.app.pagamentos!.ultimaFalhaDoGateway(),
      log: linhas,
    });
    expect(tudo).not.toContain('secreto.pagador');
    expect(linhas.join('\n')).not.toContain('secreto.pagador');
  });

  it('conta de chave de API (sem e-mail) continua recusada no checkout, mesmo informando um e-mail', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { 'x-api-key': CHAVE_DE_API },
      payload: {
        plano: 'pecas',
        aceiteTermos: true,
        emailDoPagador: 'qualquer@exemplo.test',
      },
    });
    expect(r.statusCode).toBe(403);
    expect(json(r)['detalhes'].motivo).toBe('conta_sem_email');
    expect(c.gateway.pedidos).toHaveLength(0);
  });
});

/*
 * v0.49.6 (só INVESTIGAÇÃO, nenhum comportamento muda): quanto "Vale até" um pagamento aprovado dá. O serviço chama o
 * MESMO `ServicoAssinaturas.liberar` do manual, com `meses = MESES_POR_CICLO[ciclo]` (mensal = 1), e `renovada` soma a
 * partir do vencimento ATUAL quando ele ainda está no futuro (para quem renova cedo não perder dias).
 */
describe('cobrança recorrente — "Vale até" depois do pagamento aprovado (v0.49.6)', () => {
  const umMesDepois = (d: Date): string => {
    const x = new Date(d.getTime());
    x.setMonth(x.getMonth() + 1);
    return x.toISOString();
  };

  it('conta sem vigência anterior: o primeiro pagamento de um plano MENSAL vale 1 mês a partir de agora, com a carência padrão', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    expect(
      await c.app.repositorioAssinaturas.porWorkspace(conta.workspace),
    ).toBeUndefined();
    expect((await aprovar(conta.gatewayId)).statusCode).toBe(200);
    const a = (await c.app.repositorioAssinaturas.porWorkspace(conta.workspace))!;
    expect(a.venceEm.toISOString()).toBe(umMesDepois(c.relogio.agora));
    expect(a.diasDeCarencia).toBe(7);
    expect(a.ehTeste).toBe(false);
  });

  it('conta no teste de 14 dias: o pagamento soma 1 mês AO FIM do teste (comportamento atual, documentado)', async () => {
    c = montarCenarioDePagamento({ comAssinaturas: true });
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    const teste = (await c.app.repositorioAssinaturas.porWorkspace(conta.workspace))!;
    expect(teste.ehTeste).toBe(true);
    await aprovar(conta.gatewayId);
    const a = (await c.app.repositorioAssinaturas.porWorkspace(conta.workspace))!;
    expect(a.venceEm.toISOString()).toBe(umMesDepois(teste.venceEm));
    expect(a.ehTeste).toBe(false);
  });

  it('conta com liberação manual LONGA de outro plano: o pagamento mensal soma 1 mês ao vencimento antigo e TROCA o plano (a origem do "Vale até 2029")', async () => {
    c = montarCenarioDePagamento();
    await precificar(c, 'pecas', 4990);
    const conta = await contaComCheckout();
    await c.app.assinaturas.liberar({
      workspace: conta.workspace,
      plano: 'acompanhamento',
      meses: 36,
    });
    const antes = (await c.app.repositorioAssinaturas.porWorkspace(conta.workspace))!;
    await aprovar(conta.gatewayId);
    const a = (await c.app.repositorioAssinaturas.porWorkspace(conta.workspace))!;
    expect(a.plano).toBe('pecas');
    expect(a.venceEm.toISOString()).toBe(umMesDepois(antes.venceEm));
    expect(a.venceEm.getUTCFullYear()).toBe(2029);
  });
});
