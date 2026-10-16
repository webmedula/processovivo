import { describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';

// Valores SINTÉTICOS: nenhum é credencial de verdade.
const BOM = {
  PROCESSOVIVO_PAGAMENTO_HABILITADO: 'true',
  MERCADOPAGO_ACCESS_TOKEN: 'APP_USR-token-sintetico-0000',
  MERCADOPAGO_WEBHOOK_SECRET: 'segredo-sintetico-do-webhook',
  PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test',
};

function mensagemDe(env: Record<string, string>): string {
  try {
    carregarConfig(env as NodeJS.ProcessEnv);
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

describe('configuração da cobrança recorrente (v0.44.0)', () => {
  it('nasce DESLIGADA: nada é exigido nem carregado', () => {
    const c = carregarConfig({} as NodeJS.ProcessEnv);
    expect(c.pagamento).toMatchObject({
      habilitado: false,
      accessToken: '',
      segredoDoWebhook: '',
      urlBase: '',
    });
  });

  it('desligada, as credenciais no ambiente são ignoradas (não vão para a configuração)', () => {
    const c = carregarConfig({
      MERCADOPAGO_ACCESS_TOKEN: 'APP_USR-x',
      MERCADOPAGO_WEBHOOK_SECRET: 'y',
    } as NodeJS.ProcessEnv);
    expect(c.pagamento.accessToken).toBe('');
    expect(c.pagamento.segredoDoWebhook).toBe('');
  });

  it('habilitada e completa: carrega as credenciais e a URL base sem a barra final', () => {
    const c = carregarConfig({
      ...BOM,
      PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test/',
    } as NodeJS.ProcessEnv);
    expect(c.pagamento).toMatchObject({
      habilitado: true,
      gateway: 'mercadopago',
      accessToken: 'APP_USR-token-sintetico-0000',
      segredoDoWebhook: 'segredo-sintetico-do-webhook',
      urlBase: 'https://app.exemplo.test',
    });
  });

  it('FAIL-CLOSED: habilitada sem credencial, não sobe — e diz o que falta, sem imprimir segredo', () => {
    const msg = mensagemDe({ PROCESSOVIVO_PAGAMENTO_HABILITADO: 'true' });
    expect(msg).toMatch(/MERCADOPAGO_ACCESS_TOKEN: obrigatório/);
    expect(msg).toMatch(/MERCADOPAGO_WEBHOOK_SECRET: obrigatória/);
    expect(msg).toMatch(/PROCESSOVIVO_URL_BASE: obrigatória/);
  });

  it('valor de exemplo no token ou no segredo não passa por "preenchido"', () => {
    expect(mensagemDe({ ...BOM, MERCADOPAGO_ACCESS_TOKEN: 'COLE_AQUI_O_TOKEN' })).toMatch(
      /parece um valor de exemplo/,
    );
    expect(
      mensagemDe({ ...BOM, MERCADOPAGO_WEBHOOK_SECRET: 'COLE_AQUI_O_SEGREDO' }),
    ).toMatch(/parece um valor de exemplo/);
  });

  it('a mensagem de erro nunca traz o valor das credenciais', () => {
    const msg = mensagemDe({
      ...BOM,
      MERCADOPAGO_ACCESS_TOKEN: 'COLE_AQUI_O_TOKEN',
      PROCESSOVIVO_URL_BASE: 'http://inseguro.exemplo.test',
    });
    expect(msg).not.toContain('COLE_AQUI_O_TOKEN');
    expect(msg).not.toContain('segredo-sintetico-do-webhook');
  });

  it('a URL base precisa ser https (ou localhost)', () => {
    expect(
      mensagemDe({ ...BOM, PROCESSOVIVO_URL_BASE: 'http://app.exemplo.test' }),
    ).toMatch(/https/);
    expect(mensagemDe({ ...BOM, PROCESSOVIVO_URL_BASE: 'http://localhost:3000' })).toBe(
      '',
    );
  });

  it('token de TESTE em produção é recusado, a não ser que seja proposital', () => {
    const teste = {
      ...BOM,
      MERCADOPAGO_ACCESS_TOKEN: 'TEST-token-sintetico-0000',
      NODE_ENV: 'production',
    };
    expect(mensagemDe(teste)).toMatch(/token de TESTE/);
    expect(mensagemDe({ ...teste, PROCESSOVIVO_PAGAMENTO_PERMITIR_TESTE: 'true' })).toBe(
      '',
    );
    // Fora de produção, token de teste é o esperado.
    expect(
      mensagemDe({ ...BOM, MERCADOPAGO_ACCESS_TOKEN: 'TEST-token-sintetico-0000' }),
    ).toBe('');
  });

  it('o gateway "falso" não sobe em produção e dispensa credenciais fora dela', () => {
    expect(
      mensagemDe({
        PROCESSOVIVO_PAGAMENTO_HABILITADO: 'true',
        PROCESSOVIVO_PAGAMENTO_GATEWAY: 'falso',
        PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test',
        NODE_ENV: 'production',
      }),
    ).toMatch(/não sobe em produção/);
    const c = carregarConfig({
      PROCESSOVIVO_PAGAMENTO_HABILITADO: 'true',
      PROCESSOVIVO_PAGAMENTO_GATEWAY: 'falso',
      PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test',
    } as NodeJS.ProcessEnv);
    expect(c.pagamento.gateway).toBe('falso');
    expect(c.pagamento.accessToken).toBe('');
  });

  it('o endereço dos Termos só vale se for http(s)', () => {
    expect(
      carregarConfig({
        PROCESSOVIVO_TERMOS_URL: 'https://exemplo.test/termos',
      } as NodeJS.ProcessEnv).pagamento.urlDosTermos,
    ).toBe('https://exemplo.test/termos');
    expect(
      carregarConfig({
        PROCESSOVIVO_TERMOS_URL: 'javascript:alert(1)',
      } as NodeJS.ProcessEnv).pagamento.urlDosTermos,
    ).toBe('');
  });
});
