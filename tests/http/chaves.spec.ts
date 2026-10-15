import { describe, expect, it } from 'vitest';
import {
  ConfiguracaoDeChavesInvalidaError,
  TAMANHO_MINIMO_CHAVE,
  identificarChave,
  validarChavesDeApi,
} from '../../src/main/http/chaves.js';

const CHAVE_FORTE = 'a'.repeat(64);
const OUTRA_FORTE = 'b'.repeat(64);

describe('validarChavesDeApi', () => {
  it('aceita uma chave forte', () => {
    expect(() => validarChavesDeApi([CHAVE_FORTE], false)).not.toThrow();
  });

  it('recusa subir sem nenhuma chave', () => {
    expect(() => validarChavesDeApi([], false)).toThrow(
      ConfiguracaoDeChavesInvalidaError,
    );
    expect(() => validarChavesDeApi([], false)).toThrow(
      /PROCESSOVIVO_API_KEYS não definida/,
    );
  });

  it('recusa chave curta — pior que nenhuma, porque parece segura', () => {
    expect(() => validarChavesDeApi(['123456'], false)).toThrow(
      new RegExp(`${TAMANHO_MINIMO_CHAVE} caracteres`),
    );
  });

  it('nunca ecoa a chave na mensagem de erro', () => {
    const fraca = 'senha-do-joao';
    const erro = capturar(() => validarChavesDeApi([fraca], false));
    expect(erro?.message).not.toContain(fraca);
  });

  it('recusa o texto de exemplo, mesmo sendo longo o bastante', () => {
    // 35 caracteres: passaria na checagem de tamanho e viraria a chave de
    // produção do serviço.
    expect(() =>
      validarChavesDeApi(['COLE_AQUI_A_CHAVE_GERADA_NO_PASSO_1'], false),
    ).toThrow(/texto de exemplo/);
  });

  it('recusa chaves repetidas — revogar uma derrubaria as outras', () => {
    expect(() => validarChavesDeApi([CHAVE_FORTE, CHAVE_FORTE], false)).toThrow(
      /repetidas/,
    );
  });

  it('aceita várias chaves distintas e fortes', () => {
    expect(() => validarChavesDeApi([CHAVE_FORTE, OUTRA_FORTE], false)).not.toThrow();
  });

  it('aceita autenticação desativada sem chaves', () => {
    expect(() => validarChavesDeApi([], true)).not.toThrow();
  });

  it('recusa a combinação ambígua: desativada COM chaves configuradas', () => {
    // As duas juntas escondem qual está valendo — e a resposta ("a desativação
    // vence") é exatamente a que ninguém quer descobrir em produção.
    expect(() => validarChavesDeApi([CHAVE_FORTE], true)).toThrow(/Escolha um dos dois/);
  });
});

describe('identificarChave', () => {
  it('é estável para a mesma chave', () => {
    expect(identificarChave(CHAVE_FORTE)).toBe(identificarChave(CHAVE_FORTE));
  });

  it('distingue chaves que compartilham prefixo', () => {
    // O identificador anterior usava os 4 primeiros caracteres e colapsava
    // qualquer convenção de prefixo (lf_prod_…). O hash não.
    const a = identificarChave('lf_prod_aaaaaaaaaaaaaaaaaaaaaaaa');
    const b = identificarChave('lf_prod_bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(a).not.toBe(b);
  });

  it('não vaza nenhum trecho da chave', () => {
    const chave = 'chave-secreta-que-nao-pode-vazar-nunca';
    const id = identificarChave(chave);
    expect(chave).not.toContain(id);
    expect(id).toHaveLength(8);
  });
});

function capturar(fn: () => void): Error | undefined {
  try {
    fn();
    return undefined;
  } catch (erro) {
    return erro as Error;
  }
}
