import { describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { Cofre } from '../../src/infrastructure/seguranca/cofre.js';

// Valores SINTÉTICOS: nenhum é credencial de verdade.
const COFRE = Cofre.gerarChaveBase64();
const BOM = {
  PROCESSOVIVO_LOGIN_GOOGLE_HABILITADO: 'true',
  GOOGLE_CLIENT_ID: 'cliente-sintetico.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'segredo-sintetico-do-cliente',
  PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test',
  PROCESSOVIVO_CREDENCIAL_CHAVE: COFRE,
};

function mensagemDe(env: Record<string, string>): string {
  try {
    carregarConfig(env as NodeJS.ProcessEnv);
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

describe('configuração do login com Google (v0.67.0)', () => {
  it('nasce DESLIGADO: sem a chave, nada é exigido e as credenciais do ambiente não entram', () => {
    const c = carregarConfig({
      GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 's',
    } as NodeJS.ProcessEnv);
    expect(c.loginGoogle).toEqual({
      habilitado: false,
      clientId: '',
      clientSecret: '',
      uriDeRetorno: '',
    });
  });

  it('habilitado e completo: monta o endereço de retorno próprio, ao lado do do Drive', () => {
    const c = carregarConfig({
      ...BOM,
      PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test/',
    } as NodeJS.ProcessEnv);
    expect(c.loginGoogle.habilitado).toBe(true);
    expect(c.loginGoogle.uriDeRetorno).toBe(
      'https://app.exemplo.test/v1/sessoes/google/retorno',
    );
    expect(c.loginGoogle.clientId).toBe(BOM.GOOGLE_CLIENT_ID);
    // Liga só o login: o Drive continua desligado.
    expect(c.drive.habilitado).toBe(false);
  });

  it('habilitado sem cliente, com valor de exemplo, sem https ou sem cofre: recusa subir e diz qual variável', () => {
    expect(mensagemDe({ ...BOM, GOOGLE_CLIENT_ID: '' })).toContain(
      'GOOGLE_CLIENT_ID: obrigatório com PROCESSOVIVO_LOGIN_GOOGLE_HABILITADO=true',
    );
    expect(mensagemDe({ ...BOM, GOOGLE_CLIENT_SECRET: 'COLE_AQUI_O_SEGREDO' })).toContain(
      'parece um valor de exemplo',
    );
    expect(
      mensagemDe({ ...BOM, PROCESSOVIVO_URL_BASE: 'http://app.exemplo.test' }),
    ).toContain('https');
    expect(mensagemDe({ ...BOM, PROCESSOVIVO_URL_BASE: '' })).toContain(
      '/v1/sessoes/google/retorno',
    );
    expect(mensagemDe({ ...BOM, PROCESSOVIVO_CREDENCIAL_CHAVE: '' })).toContain(
      'PROCESSOVIVO_CREDENCIAL_CHAVE',
    );
    // Nunca ecoa o segredo.
    expect(mensagemDe({ ...BOM, GOOGLE_CLIENT_ID: '' })).not.toContain(
      BOM.GOOGLE_CLIENT_SECRET,
    );
  });
});
