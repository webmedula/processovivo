import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ESTILOS_LOGIN_GOOGLE,
  SCRIPT_LOGIN_GOOGLE,
} from '../../src/main/http/ui/loginGoogle.js';
import { paginaConsole } from '../../src/main/http/ui/pagina.js';
import { SCRIPT } from '../../src/main/http/ui/script.js';

/* A tela do login com Google (v0.67.0): contrato do arquivo, sem navegador. O comportamento está em login-google-navegador. */

// `split('\n').length` de `script.ts` na 0.66.5 (2.340 quebras de linha + a última).
const LINHAS_DO_SCRIPT_ANTES = 2341;

describe('tela do login com Google — o contrato do arquivo', () => {
  it('o console inclui o script e os estilos, e nada vem de fora', () => {
    const html = paginaConsole('0.0.0');
    expect(html).toContain(SCRIPT_LOGIN_GOOGLE.trim().slice(0, 40));
    expect(html).toContain(ESTILOS_LOGIN_GOOGLE.trim().slice(0, 40));
    expect(SCRIPT_LOGIN_GOOGLE).not.toMatch(
      /<script\s+src|<link\s+href="http|<img\s+src="http/,
    );
  });

  it('script.ts NÃO cresce: os dois ganchos entraram em linhas que já existiam', () => {
    const linhas = readFileSync(
      resolve(__dirname, '../../src/main/http/ui/script.ts'),
      'utf8',
    ).split('\n').length;
    expect(linhas).toBeLessThanOrEqual(LINHAS_DO_SCRIPT_ANTES);
    expect(SCRIPT).toContain('<div id="c-google"></div>');
    expect(SCRIPT).toContain('window.__pvLoginGoogle.entrada(criar)');
    expect(SCRIPT).toContain('<div id="g-cartao"></div>');
    expect(SCRIPT).toContain('window.__pvLoginGoogle.cartao()');
    // A tela não mora no script do console: ele só a chama.
    expect(SCRIPT).not.toContain('/v1/sessoes/google');
    expect(SCRIPT).not.toContain('/v1/eu/google');
  });

  it('só navega para o Google; toda frase de erro é fixa e de lista fechada; o retorno sai da barra', () => {
    expect(SCRIPT_LOGIN_GOOGLE).toContain(
      "r.url.indexOf('https://accounts.google.com/')===0",
    );
    for (const motivo of [
      'negado',
      'estado_invalido',
      'autorizacao_recusada',
      'email_nao_verificado',
      'email_invalido',
      'conta_google_em_uso',
      'sessao_diferente',
      'indisponivel',
    ]) {
      expect(SCRIPT_LOGIN_GOOGLE).toMatch(new RegExp(`\\n  ${motivo}:'`));
    }
    expect(SCRIPT_LOGIN_GOOGLE).toContain("busca.delete('google')");
    expect(SCRIPT_LOGIN_GOOGLE).toContain('history.replaceState');
    // Nunca `localStorage`: nada do login fica no navegador.
    expect(SCRIPT_LOGIN_GOOGLE).not.toContain('localStorage');
    // O texto diz o que é lido, e só isso.
    expect(SCRIPT_LOGIN_GOOGLE).toContain('Usamos só o seu nome e o seu e-mail');
  });
});
