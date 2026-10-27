import { describe, expect, it } from 'vitest';
import {
  ConfiguracaoDeAdminInvalidaError,
  TAMANHO_MINIMO_SENHA_RESTRITO,
  lerRestritosDoAdmin,
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

describe('lerRestritosDoAdmin (PROCESSOVIVO_ADMIN_RESTRITOS)', () => {
  const S1 = 'senha-ficticia-numero-um-000001';
  const S2 = 'senha-ficticia-numero-dois-00002';

  function mensagemDe(texto: string, dono = 'joao'): string {
    try {
      lerRestritosDoAdmin(texto, dono);
    } catch (erro) {
      expect(erro).toBeInstanceOf(ConfiguracaoDeAdminInvalidaError);
      return erro instanceof Error ? erro.message : '';
    }
    return '';
  }

  it('vazia = nenhum restrito (compatibilidade: só o dono)', () => {
    expect(lerRestritosDoAdmin('', 'joao')).toEqual([]);
    expect(lerRestritosDoAdmin(' , ,', 'joao')).toEqual([]);
  });

  it('lê usuario:senha separados por vírgula; a senha vai depois do primeiro ":"', () => {
    expect(
      lerRestritosDoAdmin(` ana:${S1} , beto_2:${S2}:com:dois-pontos`, 'joao'),
    ).toEqual([
      { usuario: 'ana', senha: S1 },
      { usuario: 'beto_2', senha: `${S2}:com:dois-pontos` },
    ]);
  });

  it('exige o dono configurado', () => {
    expect(mensagemDe(`ana:${S1}`, '')).toMatch(/dono/);
  });

  it(`recusa senha com menos de ${TAMANHO_MINIMO_SENHA_RESTRITO} caracteres`, () => {
    const m = mensagemDe('ana:' + 'x'.repeat(TAMANHO_MINIMO_SENHA_RESTRITO - 1));
    expect(m).toMatch(/entrada 1/);
    expect(m).toMatch(new RegExp(`${TAMANHO_MINIMO_SENHA_RESTRITO} caracteres`));
    expect(mensagemDe('ana:' + 'x'.repeat(TAMANHO_MINIMO_SENHA_RESTRITO))).toBe('');
  });

  it('recusa usuário fora do padrão (minúsculas, números, hífen e sublinhado)', () => {
    for (const nome of ['Ana', 'ana silva', 'ana.silva', 'ana@x', 'ânia', 'a']) {
      expect(mensagemDe(`${nome}:${S1}`), nome).toMatch(/fora do padrão/);
    }
    expect(mensagemDe(`ana-2_x:${S1}`)).toBe('');
  });

  it('recusa usuário repetido, inclusive igual ao do dono (sem diferenciar caixa)', () => {
    expect(mensagemDe(`ana:${S1},beto:${S2},ana:${S2}`)).toMatch(
      /entrada 3 repete o da entrada 1/,
    );
    expect(mensagemDe(`joao:${S1}`)).toMatch(/igual ao do dono/);
    expect(mensagemDe(`joao:${S1}`, 'JOAO')).toMatch(/igual ao do dono/);
  });

  it('recusa entrada sem ":", sem usuário ou sem senha, e senha com espaço', () => {
    for (const ruim of [S1, `:${S1}`, 'ana:', `ana:${S1} extra`]) {
      expect(mensagemDe(ruim), ruim).not.toBe('');
    }
  });

  it('as mensagens nunca repetem nenhum pedaço da senha nem do conteúdo da entrada', () => {
    for (const ruim of [
      S1,
      'ana:curta-demais-123',
      `Ana:${S1}`,
      `ana:${S1} extra`,
      `joao:${S1}`,
      `ana:${S1},ana:${S2}`,
    ]) {
      const m = mensagemDe(ruim);
      for (const trecho of [S1, S2, 'curta-demais', 'extra'])
        expect(m).not.toContain(trecho);
    }
  });

  it('recusa texto de exemplo', () => {
    expect(mensagemDe('COLE_AQUI:COLE_AQUI_A_SENHA_COM_MAIS_DE_VINTE_E_QUATRO')).not.toBe(
      '',
    );
  });

  it('validarConfiguracaoAdmin repassa a validação dos restritos', () => {
    expect(() =>
      validarConfiguracaoAdmin('joao', SENHA_FORTE, `ana:${S1}`),
    ).not.toThrow();
    expect(() => validarConfiguracaoAdmin('joao', SENHA_FORTE, 'ana:curta')).toThrow(
      ConfiguracaoDeAdminInvalidaError,
    );
  });
});
