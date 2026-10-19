import { describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';

// Valores SINTÉTICOS: nenhum é credencial de verdade.
const BOM = {
  PROCESSOVIVO_PAGAMENTO_HABILITADO: 'true',
  PROCESSOVIVO_PAGAMENTO_AMBIENTE: 'producao',
  MERCADOPAGO_ACCESS_TOKEN: 'APP_USR-token-sintetico-0000',
  MERCADOPAGO_WEBHOOK_SECRET: 'segredo-sintetico-do-webhook',
  PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test',
  PROCESSOVIVO_TERMOS_VERSAO: '1.1',
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
    expect(msg).toMatch(/PROCESSOVIVO_PAGAMENTO_AMBIENTE: obrigatória/);
    expect(msg).toMatch(/MERCADOPAGO_ACCESS_TOKEN: obrigatório/);
    expect(msg).toMatch(/MERCADOPAGO_WEBHOOK_SECRET: obrigatória/);
    expect(msg).toMatch(/PROCESSOVIVO_TERMOS_VERSAO: obrigatória/);
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

  it('o ambiente é obrigatório e sem padrão: ausente ou inválido não sobe, sem imprimir segredo', () => {
    const { PROCESSOVIVO_PAGAMENTO_AMBIENTE: _a, ...semAmbiente } = BOM;
    const ausente = mensagemDe(semAmbiente);
    expect(ausente).toMatch(/PROCESSOVIVO_PAGAMENTO_AMBIENTE: obrigatória/);
    expect(ausente).not.toContain(BOM.MERCADOPAGO_ACCESS_TOKEN);
    expect(mensagemDe({ ...BOM, PROCESSOVIVO_PAGAMENTO_AMBIENTE: 'sandbox' })).toMatch(
      /AMBIENTE: valor inválido/,
    );
    expect(mensagemDe({ ...BOM, PROCESSOVIVO_PAGAMENTO_AMBIENTE: 'teste' })).toBe('');
  });

  it('desligada, a variável de ambiente não é exigida', () => {
    expect(carregarConfig({} as NodeJS.ProcessEnv).pagamento.ambiente).toBeNull();
  });

  it('ambiente de TESTE em produção é recusado, a não ser que seja proposital — o prefixo do token é irrelevante', () => {
    const teste = {
      ...BOM,
      PROCESSOVIVO_PAGAMENTO_AMBIENTE: 'teste',
      MERCADOPAGO_ACCESS_TOKEN: 'APP_USR-token-sintetico-0000',
      NODE_ENV: 'production',
    };
    expect(mensagemDe(teste)).toMatch(/"teste" com o servidor em produção/);
    expect(mensagemDe({ ...teste, PROCESSOVIVO_PAGAMENTO_PERMITIR_TESTE: 'true' })).toBe('');
    // Fora de produção, teste é o esperado.
    expect(mensagemDe({ ...teste, NODE_ENV: 'development' })).toBe('');
    // Em produção declarada, token APP_USR- passa (é o caso real de produção).
    expect(mensagemDe({ ...BOM, NODE_ENV: 'production' })).toBe('');
  });

  it('token TEST- com ambiente producao não sobe', () => {
    const msg = mensagemDe({ ...BOM, MERCADOPAGO_ACCESS_TOKEN: 'TEST-token-sintetico-0000' });
    expect(msg).toMatch(/começa por TEST-.*AMBIENTE=producao/);
    expect(msg).not.toContain('TEST-token-sintetico-0000');
    expect(
      mensagemDe({
        ...BOM,
        PROCESSOVIVO_PAGAMENTO_AMBIENTE: 'teste',
        MERCADOPAGO_ACCESS_TOKEN: 'TEST-token-sintetico-0000',
      }),
    ).toBe('');
  });

  it('o gateway "falso" não sobe em produção e dispensa credenciais fora dela', () => {
    expect(
      mensagemDe({
        PROCESSOVIVO_PAGAMENTO_HABILITADO: 'true',
        PROCESSOVIVO_PAGAMENTO_GATEWAY: 'falso',
        PROCESSOVIVO_PAGAMENTO_AMBIENTE: 'teste',
        PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test',
        NODE_ENV: 'production',
      }),
    ).toMatch(/não sobe em produção/);
    const c = carregarConfig({
      PROCESSOVIVO_PAGAMENTO_HABILITADO: 'true',
      PROCESSOVIVO_PAGAMENTO_GATEWAY: 'falso',
      PROCESSOVIVO_PAGAMENTO_AMBIENTE: 'teste',
      PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test',
      PROCESSOVIVO_TERMOS_VERSAO: '1.1',
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

  it('v0.45.0: a versão dos Termos é OBRIGATÓRIA com o pagamento ligado e vai à configuração', () => {
    const { PROCESSOVIVO_TERMOS_VERSAO: _v, ...semVersao } = BOM;
    expect(mensagemDe(semVersao)).toMatch(/PROCESSOVIVO_TERMOS_VERSAO: obrigatória/);
    expect(mensagemDe({ ...BOM, PROCESSOVIVO_TERMOS_VERSAO: '   ' })).toMatch(
      /PROCESSOVIVO_TERMOS_VERSAO: obrigatória/,
    );
    expect(mensagemDe({ ...BOM, PROCESSOVIVO_TERMOS_VERSAO: 'v 1.1; DROP' })).toMatch(
      /PROCESSOVIVO_TERMOS_VERSAO: use até 20 caracteres/,
    );
    expect(carregarConfig({ ...BOM, PROCESSOVIVO_TERMOS_VERSAO: ' 1.2 ' } as NodeJS.ProcessEnv).pagamento.versaoDosTermos).toBe('1.2');
  });

  it('v0.45.0: com o pagamento desligado a versão dos Termos não é exigida', () => {
    expect(mensagemDe({})).toBe('');
  });
});

describe('PROCESSOVIVO_SITE_URL (v0.45.0)', () => {
  it('vazio (padrão) = sem CORS', () => {
    expect(carregarConfig({} as NodeJS.ProcessEnv).http.siteUrl).toBe('');
  });

  it('normaliza para a ORIGEM: sem barra final, em minúsculas', () => {
    const c = carregarConfig({ PROCESSOVIVO_SITE_URL: ' https://WWW.Exemplo.test/ ' } as NodeJS.ProcessEnv);
    expect(c.http.siteUrl).toBe('https://www.exemplo.test');
    const porta = carregarConfig({ PROCESSOVIVO_SITE_URL: 'http://localhost:8080' } as NodeJS.ProcessEnv);
    expect(porta.http.siteUrl).toBe('http://localhost:8080');
  });

  it('valor torto derruba o arranque, sem ecoar o valor: curinga, caminho, http fora de localhost, credencial', () => {
    for (const ruim of [
      '*',
      'https://*.exemplo.test',
      'https://exemplo.test/planos',
      'https://exemplo.test/?a=1',
      'http://exemplo.test',
      'https://usuario:senha@exemplo.test',
      'nao-e-url',
    ]) {
      const msg = mensagemDe({ PROCESSOVIVO_SITE_URL: ruim });
      expect(msg, ruim).toMatch(/PROCESSOVIVO_SITE_URL/);
      expect(msg, ruim).not.toContain(ruim === '*' ? 'zzz' : ruim);
    }
  });
});
