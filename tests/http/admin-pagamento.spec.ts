import { afterEach, describe, expect, it } from 'vitest';
import type { CenarioDePagamento, Dados } from '../helpers/pagamentos.js';
import {
  json,
  configDePagamento,
  montarCenarioDePagamento,
  precificar,
  cadastrar,
} from '../helpers/pagamentos.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { ScriptAdminParaTeste } from '../helpers/scriptAdmin.js';

/* /admin (v0.44.0): ambiente do gateway, origem da assinatura, reconciliação e ciclo do plano. */
const ADMIN = { usuario: 'operador', senha: 'uma-senha-administrativa-bem-forte' };
const BASIC =
  'Basic ' + Buffer.from(`${ADMIN.usuario}:${ADMIN.senha}`).toString('base64');
const H = { authorization: BASIC };

let c: CenarioDePagamento;
afterEach(async () => {
  await c.servidor.close();
});

function montar(
  extraEnv: Record<string, string> = {},
  comPagamento = true,
): CenarioDePagamento {
  const base = montarCenarioDePagamento({ comPagamento, admin: ADMIN });
  if (Object.keys(extraEnv).length > 0) {
    const servidor = construirServidor(base.app, configDePagamento(extraEnv));
    return { ...base, servidor };
  }
  return base;
}

describe('/admin — cobrança recorrente', () => {
  it('desligada: o ambiente diz `habilitado: false` e reconciliar é 404', async () => {
    c = montar({}, false);
    expect(
      json(
        await c.servidor.inject({
          method: 'GET',
          url: '/admin/api/pagamento',
          headers: H,
        }),
      ),
    ).toEqual({ habilitado: false });
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/admin/api/pagamento/reconciliar',
      headers: H,
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });

  it('exige a credencial do operador (nenhuma conta de assinante serve)', async () => {
    c = montar();
    const conta = await cadastrar(c, 'ana@exemplo.test');
    expect(
      (await c.servidor.inject({ method: 'GET', url: '/admin/api/pagamento' }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await c.servidor.inject({
          method: 'GET',
          url: '/admin/api/pagamento',
          headers: { cookie: conta.cookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await c.servidor.inject({
          method: 'POST',
          url: '/admin/api/pagamento/reconciliar',
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });

  it('mostra o ambiente em destaque: modo de TESTE avisa; com token de teste em produção, avisa mais forte', async () => {
    c = montar();
    const r = json(
      await c.servidor.inject({ method: 'GET', url: '/admin/api/pagamento', headers: H }),
    );
    expect(r).toMatchObject({
      habilitado: true,
      gateway: 'falso',
      ambiente: 'falso',
      modoDeTeste: true,
    });
    expect(r['aviso']).toMatch(/TESTE/);
    expect(r['aviso']).not.toMatch(/PRODUÇÃO/);
    await c.servidor.close();

    c = montar({ NODE_ENV: 'production' });
    const prod = json(
      await c.servidor.inject({ method: 'GET', url: '/admin/api/pagamento', headers: H }),
    );
    expect(prod['aviso']).toMatch(/PRODUÇÃO com a cobrança em ambiente de TESTE/);
  });

  it('a lista de assinaturas diz a ORIGEM: manual ou gateway, com estado, id e último pagamento (sem dado pessoal)', async () => {
    c = montar();
    await precificar(c, 'pecas', 4990);
    const paga = await cadastrar(c, 'paga@exemplo.test');
    const manual = await cadastrar(c, 'manual@exemplo.test');
    await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { cookie: paga.cookie },
      payload: { plano: 'pecas' },
    });
    await c.app.assinaturas.liberar({
      workspace: manual.workspace,
      plano: 'pecas',
      meses: 1,
      observacao: 'Pix por fora',
    });
    await c.app.assinaturas.liberar({
      workspace: paga.workspace,
      plano: 'pecas',
      meses: 1,
    });

    const r = json(
      await c.servidor.inject({
        method: 'GET',
        url: '/admin/api/assinaturas',
        headers: H,
      }),
    );
    const a = (r['assinaturas'] as Dados[]).find(
      (x) => String(x['email']) === 'paga@exemplo.test',
    )!;
    const b = (r['assinaturas'] as Dados[]).find(
      (x) => String(x['email']) === 'manual@exemplo.test',
    )!;
    expect(b['origem']).toBe('manual');
    expect(b['pagamento']).toBeNull();
    expect(a['origem']).toBe('gateway');
    expect(a['pagamento']).toMatchObject({
      gateway: 'falso',
      gatewayId: 'fake-assinatura-1',
      estadoNoGateway: 'pendente',
      valorEmCentavos: 4990,
    });
    expect(JSON.stringify(a['pagamento'])).not.toMatch(/exemplo\.test/);
  });

  it('o botão "reconciliar" (uma conta ou todas) corrige e devolve só contagens', async () => {
    c = montar();
    await precificar(c, 'pecas', 4990);
    const conta = await cadastrar(c, 'ana@exemplo.test');
    await c.servidor.inject({
      method: 'POST',
      url: '/v1/assinatura/checkout',
      headers: { cookie: conta.cookie },
      payload: { plano: 'pecas' },
    });
    c.gateway.definirEstado('fake-assinatura-1', 'autorizada');
    c.gateway.registrarPagamento(
      'fake-assinatura-1',
      { id: 'pg:9', pagamentoId: '9', resultado: 'aprovado', valorEmCentavos: 4990 },
      '1',
    );

    const r = await c.servidor.inject({
      method: 'POST',
      url: '/admin/api/pagamento/reconciliar',
      headers: H,
      payload: { workspace: conta.workspace },
    });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({
      verificadas: 1,
      corrigidas: 1,
      pagamentosNovos: 1,
      falhas: 0,
    });
    const todas = await c.servidor.inject({
      method: 'POST',
      url: '/admin/api/pagamento/reconciliar',
      headers: H,
      payload: {},
    });
    expect(json(todas)).toMatchObject({ verificadas: 1, pagamentosNovos: 0 });
  });

  it('reconciliar com workspace inexistente é recusado (nada é consultado)', async () => {
    c = montar();
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/admin/api/pagamento/reconciliar',
      headers: H,
      payload: { workspace: '0123456789abcdef' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('o plano tem ciclo editável: aceita mensal, trimestral e anual; recusa o resto; sem o campo, mantém', async () => {
    c = montar();
    const mudar = (payload: object) =>
      c.servidor.inject({
        method: 'PUT',
        url: '/admin/api/planos/pecas',
        headers: H,
        payload,
      });
    let r = await mudar({ ciclo: 'anual' });
    expect(r.statusCode).toBe(200);
    expect(json(r)['ciclo']).toBe('anual');
    r = await mudar({ precoMensalCentavos: 5500 });
    expect(json(r)['ciclo']).toBe('anual');
    r = await mudar({ ciclo: 'semanal' });
    expect(r.statusCode).toBe(400);
    const lista = json(
      await c.servidor.inject({ method: 'GET', url: '/admin/api/planos', headers: H }),
    );
    expect(
      (lista['planos'] as Array<Record<string, unknown>>).find(
        (p) => p['codigo'] === 'pecas',
      ),
    ).toMatchObject({ ciclo: 'anual' });
  });

  it('criar plano aceita o ciclo; preço e "à venda" são os campos de sempre', async () => {
    c = montar();
    const r = await c.servidor.inject({
      method: 'POST',
      url: '/admin/api/planos',
      headers: H,
      payload: {
        codigo: 'pecas-trimestral',
        nome: 'Peças trimestral',
        resumo: 'Peças a cada 3 meses.',
        recursos: ['consulta', 'pecas'],
        disponivelParaContratacao: true,
        precoMensalCentavos: 4500,
        ciclo: 'trimestral',
      },
    });
    expect(r.statusCode).toBe(201);
    expect(json(r)).toMatchObject({
      ciclo: 'trimestral',
      precoMensalCentavos: 4500,
      disponivelParaContratacao: true,
    });
  });
});

describe('/admin — tela', () => {
  it('a tela mostra o ambiente, o ciclo e o botão de reconciliar, sem carregar nada de fora', () => {
    const script = ScriptAdminParaTeste();
    expect(script).toContain('/admin/api/pagamento');
    expect(script).toContain('TESTE');
    expect(script).toContain('pl-ciclo');
    expect(script).toContain('data-reconciliar');
    expect(script).toContain('/admin/api/pagamento/reconciliar');
    expect(script).not.toMatch(/https?:\/\//);
  });
});
