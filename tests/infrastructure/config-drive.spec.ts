import { describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { Cofre } from '../../src/infrastructure/seguranca/cofre.js';

// Valores SINTÉTICOS: nenhum é credencial de verdade.
const COFRE = Cofre.gerarChaveBase64();
const BOM = {
  PROCESSOVIVO_DRIVE_HABILITADO: 'true',
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

describe('configuração do Google Drive (v0.42.0)', () => {
  it('nasce DESLIGADO: sem nenhuma variável, nada é exigido e nada é carregado', () => {
    const c = carregarConfig({} as NodeJS.ProcessEnv);
    expect(c.drive.habilitado).toBe(false);
    expect(c.drive.clientId).toBe('');
    expect(c.drive.clientSecret).toBe('');
    expect(c.drive.uriDeRetorno).toBe('');
  });

  it('desligado, as chaves do Google no ambiente são ignoradas (não vão para a configuração)', () => {
    const c = carregarConfig({
      GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 's',
    } as NodeJS.ProcessEnv);
    expect(c.drive.clientId).toBe('');
    expect(c.drive.clientSecret).toBe('');
  });

  it('habilitado e completo: monta o endereço de retorno a partir da URL base', () => {
    const c = carregarConfig({
      ...BOM,
      PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test/',
    } as NodeJS.ProcessEnv);
    expect(c.drive.habilitado).toBe(true);
    expect(c.drive.uriDeRetorno).toBe('https://app.exemplo.test/v1/drive/retorno');
    expect(c.drive.maxSimultaneos).toBe(2);
  });

  it('o arranque FALHA habilitado e sem ID do cliente, sem segredo, sem URL base ou sem o cofre', () => {
    for (const faltando of [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'PROCESSOVIVO_URL_BASE',
      'PROCESSOVIVO_CREDENCIAL_CHAVE',
    ]) {
      const env: Record<string, string> = { ...BOM };
      delete env[faltando];
      expect(mensagemDe(env), faltando).toContain(`${faltando}: obrigat`);
    }
  });

  it('valor de exemplo no ID ou no segredo é barrado por pareceValorDeExemplo', () => {
    expect(
      mensagemDe({ ...BOM, GOOGLE_CLIENT_ID: 'COLE_AQUI_O_ID_DO_CLIENTE' }),
    ).toContain('GOOGLE_CLIENT_ID: parece um valor de exemplo');
    expect(mensagemDe({ ...BOM, GOOGLE_CLIENT_SECRET: 'COLE_AQUI_O_SEGREDO' })).toContain(
      'GOOGLE_CLIENT_SECRET: parece um valor de exemplo',
    );
  });

  it('a chave do cofre de exemplo também é barrada: o token só é guardado cifrado de verdade', () => {
    expect(
      mensagemDe({ ...BOM, PROCESSOVIVO_CREDENCIAL_CHAVE: 'COLE_AQUI_A_CHAVE' }),
    ).toContain('PROCESSOVIVO_CREDENCIAL_CHAVE');
  });

  it('o Google só aceita retorno em https (ou localhost): URL base http é recusada', () => {
    expect(
      mensagemDe({ ...BOM, PROCESSOVIVO_URL_BASE: 'http://app.exemplo.test' }),
    ).toContain('https');
    expect(() =>
      carregarConfig({
        ...BOM,
        PROCESSOVIVO_URL_BASE: 'http://localhost:3000',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('a mensagem de erro NUNCA traz o valor de nenhuma chave', () => {
    const msg = mensagemDe({
      ...BOM,
      GOOGLE_CLIENT_ID: 'COLE_AQUI_ID-MARCADOR-1',
      GOOGLE_CLIENT_SECRET: 'COLE_AQUI_SEGREDO-MARCADOR-2',
      PROCESSOVIVO_URL_BASE: 'http://marcador-3.exemplo.test',
    });
    expect(msg).not.toContain('MARCADOR-1');
    expect(msg).not.toContain('MARCADOR-2');
    expect(msg).not.toContain(COFRE);
  });

  it('o escopo não é configuração: nenhuma variável permite pedir mais que `drive.file`', () => {
    // O adapter só conhece a constante; não há PROCESSOVIVO_DRIVE_ESCOPO nem parecido.
    const c = carregarConfig({
      ...BOM,
      PROCESSOVIVO_DRIVE_ESCOPO: 'https://www.googleapis.com/auth/drive',
    } as NodeJS.ProcessEnv);
    expect(JSON.stringify(c)).not.toContain('googleapis.com/auth');
  });
});
