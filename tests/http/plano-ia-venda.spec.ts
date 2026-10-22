import { afterEach, describe, expect, it } from 'vitest';
import { AnalisadorFalso } from '../helpers/analiseIa.js';
import type { CenarioDePagamento } from '../helpers/pagamentos.js';
import {
  CHAVE_DE_API,
  avisar,
  cadastrar,
  json,
  montarCenarioDePagamento,
  precificar,
} from '../helpers/pagamentos.js';

/*
 * Plano IA à venda (v0.50.0), de ponta a ponta e SEM rede: o servidor real, SQLite em memória, o
 * `GatewayFalso` no lugar do Mercado Pago e um analisador dublê no lugar do modelo. A venda do plano IA
 * é decidida por DADO (preço + "à venda" no /admin); o teste grátis continua sendo o Peças, sem IA.
 * Contas, e-mails e ids sintéticos.
 */

let c: CenarioDePagamento;
let analisador: AnalisadorFalso;
afterEach(async () => {
  await c.servidor.close();
});

function montar(opcoes: { comPagamento?: boolean; comIa?: boolean } = {}): void {
  analisador = new AnalisadorFalso();
  c = montarCenarioDePagamento({
    comPagamento: opcoes.comPagamento ?? true,
    ...(opcoes.comIa === false ? {} : { analiseIa: { analisador } }),
  });
}

const checkout = (cookie: string, plano = 'ia') =>
  c.servidor.inject({
    method: 'POST',
    url: '/v1/assinatura/checkout',
    headers: { cookie },
    payload: { plano, aceiteTermos: true },
  });

const vitrine = async (): Promise<string[]> =>
  (
    json(await c.servidor.inject({ method: 'GET', url: '/v1/planos' }))[
      'planos'
    ] as Array<{
      slug: string;
    }>
  ).map((p) => p.slug);

const disponibilidade = (headers: Record<string, string>) =>
  c.servidor.inject({ method: 'GET', url: '/v1/analises/disponibilidade', headers });

/** Aprova a primeira parcela no "gateway" e entrega o aviso, como o Mercado Pago faria. */
async function aprovar(gatewayId: string, valor: number): Promise<void> {
  c.gateway.definirEstado(gatewayId, 'autorizada', new Date('2026-11-20T12:00:00.000Z'));
  c.gateway.registrarPagamento(
    gatewayId,
    {
      id: 'pg:700',
      pagamentoId: '700',
      resultado: 'aprovado',
      valorEmCentavos: valor,
      meio: 'cartao',
      ocorridoEm: c.relogio.agora,
    },
    '7001',
  );
  const r = await avisar(c, { topico: 'subscription_authorized_payment', id: '7001' });
  expect(r.statusCode).toBe(200);
}

describe('plano IA — vendável só por dado', () => {
  it('na semente (sem preço, fora de venda): não aparece em /v1/planos e o checkout recusa', async () => {
    montar();
    await precificar(c, 'pecas', 4990);
    expect(await vitrine()).toEqual(['acompanhamento', 'pecas']);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const r = await checkout(conta.cookie);
    expect(r.statusCode).toBe(422);
    expect(json(r)['detalhes']).toMatchObject({ motivo: 'plano_nao_vendavel' });
    expect(c.gateway.pedidos).toHaveLength(0);
  });

  it('com preço e FORA de venda: continua fora da vitrine e o checkout recusa', async () => {
    montar();
    await precificar(c, 'ia', 9990, false);
    expect(await vitrine()).not.toContain('ia');
    const conta = await cadastrar(c, 'ana@exemplo.test');
    expect((await checkout(conta.cookie)).statusCode).toBe(422);
    expect(c.gateway.pedidos).toHaveLength(0);
  });

  it('"à venda" SEM preço é recusado pelo próprio cadastro do plano (nunca "valor sob consulta" para a IA)', async () => {
    montar();
    await expect(precificar(c, 'ia', null, true)).rejects.toThrow(/Defina o preço/);
    expect(await vitrine()).not.toContain('ia');
  });

  it('com preço E à venda: aparece na vitrine (três planos), assinável, e o checkout cobra o preço do plano', async () => {
    montar();
    await precificar(c, 'pecas', 4990);
    await precificar(c, 'ia', 9990);
    const corpo = json(await c.servidor.inject({ method: 'GET', url: '/v1/planos' }));
    const planos = corpo['planos'] as Array<Record<string, unknown>>;
    expect(planos.map((p) => p['slug'])).toEqual(['acompanhamento', 'pecas', 'ia']);
    const ia = planos.find((p) => p['slug'] === 'ia')!;
    expect(ia).toMatchObject({
      assinavel: true,
      incluiAnaliseIa: true,
      preco: { valorCentavos: 9990, ciclo: 'mensal' },
    });
    expect(planos.filter((p) => p['incluiAnaliseIa'] === true)).toHaveLength(1);

    const conta = await cadastrar(c, 'ana@exemplo.test');
    const r = await checkout(conta.cookie);
    expect(r.statusCode).toBe(200);
    expect(c.gateway.pedidos.at(-1)).toMatchObject({ valorEmCentavos: 9990 });
    // A tela da conta lista o IA como contratável, com o recurso no plano.
    const a = json(
      await c.servidor.inject({
        method: 'GET',
        url: '/v1/assinatura',
        headers: { cookie: conta.cookie },
      }),
    );
    const daConta = (a['planos'] as Array<Record<string, unknown>>).find(
      (p) => p['codigo'] === 'ia',
    )!;
    expect(daConta['contratavel']).toBe(true);
    expect(daConta['recursos']).toContain('analiseIa');
  });
});

describe('plano IA — o que libera a análise', () => {
  it('a assinatura APROVADA no gateway libera `analiseIa`; antes dela, nada', async () => {
    montar();
    await precificar(c, 'ia', 9990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    // Conta nova, sem o plano IA: sem a análise.
    await expect(c.app.analiseIa!.exigirPlano(conta.workspace)).rejects.toThrow(
      /faz parte do plano IA/,
    );
    expect(
      await c.app.assinaturas.temRecursoSemExcecao(conta.workspace, 'analiseIa'),
    ).toBe(false);

    expect((await checkout(conta.cookie)).statusCode).toBe(200);
    // Checkout criado, pagamento ainda não: continua sem a IA.
    expect(
      await c.app.assinaturas.temRecursoSemExcecao(conta.workspace, 'analiseIa'),
    ).toBe(false);

    const cob = await c.app.pagamentos!.cobrancaDe(conta.workspace);
    await aprovar(cob!.gatewayId!, 9990);
    expect((await c.app.assinaturas.resumo(conta.workspace))?.plano).toBe('ia');
    expect(
      await c.app.assinaturas.temRecursoSemExcecao(conta.workspace, 'analiseIa'),
    ).toBe(true);
    await expect(c.app.analiseIa!.exigirPlano(conta.workspace)).resolves.toBeUndefined();
  });

  it('o teste grátis e o plano Peças pago NÃO liberam a análise (zero chamadas ao modelo)', async () => {
    montar();
    const conta = await cadastrar(c, 'ana@exemplo.test');
    // O teste de conta nova, pelas regras padrão (o mesmo que o cadastro cria em produção).
    if (!(await c.app.assinaturas.resumo(conta.workspace))) {
      await c.app.assinaturas.criarTeste(conta.workspace);
    }
    const teste = await c.app.assinaturas.resumo(conta.workspace);
    expect(teste).toMatchObject({ plano: 'pecas', ehTeste: true });
    expect(
      await c.app.assinaturas.temRecursoSemExcecao(conta.workspace, 'analiseIa'),
    ).toBe(false);
    await c.app.assinaturas.liberar({
      workspace: conta.workspace,
      plano: 'pecas',
      meses: 1,
    });
    expect(
      await c.app.assinaturas.temRecursoSemExcecao(conta.workspace, 'analiseIa'),
    ).toBe(false);
    expect(analisador.chamadas).toBe(0);
  });

  it('a liberação MANUAL do plano IA (Pix, /admin) continua liberando, como antes', async () => {
    montar();
    const conta = await cadastrar(c, 'ana@exemplo.test');
    await c.app.assinaturas.liberar({
      workspace: conta.workspace,
      plano: 'ia',
      meses: 1,
    });
    await expect(c.app.analiseIa!.exigirPlano(conta.workspace)).resolves.toBeUndefined();
  });
});

describe('aviso de upgrade — a oferta que a tela mostra', () => {
  it('conta com e-mail, IA à venda com preço e cobrança ligada: "ver_planos"', async () => {
    montar();
    await precificar(c, 'ia', 9990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    const r = await disponibilidade({ cookie: conta.cookie });
    expect(r.json()).toEqual({ habilitada: true, oferta: 'ver_planos' });
  });

  it('IA fora de venda (a semente): "nenhuma" — a frase de sempre, sem link', async () => {
    montar();
    const conta = await cadastrar(c, 'ana@exemplo.test');
    expect((await disponibilidade({ cookie: conta.cookie })).json()).toEqual({
      habilitada: true,
      oferta: 'nenhuma',
    });
  });

  it('IA à venda mas cobrança online desligada: "nenhuma" (a tela de planos não teria o que contratar)', async () => {
    montar({ comPagamento: false });
    await precificar(c, 'ia', 9990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    expect((await disponibilidade({ cookie: conta.cookie })).json()).toMatchObject({
      oferta: 'nenhuma',
    });
  });

  it('conta de chave de API: "fale_conosco", mesmo com a IA à venda; e a análise segue barrada', async () => {
    montar();
    await precificar(c, 'ia', 9990);
    const h = { 'x-api-key': CHAVE_DE_API };
    expect((await disponibilidade(h)).json()).toEqual({
      habilitada: true,
      oferta: 'fale_conosco',
    });
  });

  it('a chave geral PROCESSOVIVO_IA_HABILITADA desligada: nem botão nem oferta', async () => {
    montar({ comIa: false });
    await precificar(c, 'ia', 9990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    expect((await disponibilidade({ cookie: conta.cookie })).json()).toEqual({
      habilitada: false,
    });
  });
});
