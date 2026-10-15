import { describe, expect, it } from 'vitest';
import {
  ConfiguracaoDeAdminInvalidaError,
  TAMANHO_MINIMO_SENHA_ADMIN,
  adminHabilitado,
  validarConfiguracaoAdmin,
} from '../../src/main/http/adminAuth.js';

const SENHA_FORTE = 'uma-senha-bastante-longa-de-verdade';

describe('validarConfiguracaoAdmin', () => {
  it('aceita as duas variáveis vazias — área desligada', () => {
    expect(() => validarConfiguracaoAdmin('', '')).not.toThrow();
  });

  it('aceita usuário e senha fortes definidos', () => {
    expect(() => validarConfiguracaoAdmin('joao', SENHA_FORTE)).not.toThrow();
  });

  it('recusa só o usuário definido', () => {
    expect(() => validarConfiguracaoAdmin('joao', '')).toThrow(
      ConfiguracaoDeAdminInvalidaError,
    );
    expect(() => validarConfiguracaoAdmin('joao', '')).toThrow(/precisam ser definidas/);
  });

  it('recusa só a senha definida', () => {
    expect(() => validarConfiguracaoAdmin('', SENHA_FORTE)).toThrow(
      ConfiguracaoDeAdminInvalidaError,
    );
  });

  it('recusa senha curta demais', () => {
    expect(() => validarConfiguracaoAdmin('joao', '123456')).toThrow(
      new RegExp(`${TAMANHO_MINIMO_SENHA_ADMIN} caracteres`),
    );
  });

  it('nunca ecoa a senha na mensagem de erro', () => {
    const senhaFraca = 'senha-do-joao';
    let mensagem = '';
    try {
      validarConfiguracaoAdmin('joao', senhaFraca);
    } catch (erro) {
      mensagem = erro instanceof Error ? erro.message : '';
    }
    expect(mensagem).not.toContain(senhaFraca);
  });

  it('recusa texto de exemplo mesmo sendo longo o bastante', () => {
    expect(() => validarConfiguracaoAdmin('COLE_AQUI_O_USUARIO', SENHA_FORTE)).toThrow(
      /texto de exemplo/,
    );
  });
});

describe('adminHabilitado', () => {
  it('é falso com as duas vazias', () => {
    expect(adminHabilitado('', '')).toBe(false);
  });

  it('é verdadeiro com as duas definidas', () => {
    expect(adminHabilitado('joao', SENHA_FORTE)).toBe(true);
  });
});
