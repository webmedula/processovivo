import { Linter } from 'eslint';
import globals from 'globals';
import { describe, expect, it } from 'vitest';
import { SCRIPT_IA_ADMIN } from '../../src/main/http/ui/iaAdmin.js';
import { SCRIPT_IA_ADMIN_MODELOS } from '../../src/main/http/ui/iaAdminModelos.js';
import { SCRIPT_ADMIN } from '../../src/main/http/ui/scriptAdmin.js';

/*
 * A área administrativa é JavaScript dentro de uma string, pelo mesmo motivo
 * do console do assinante — ver `tests/http/console-script.spec.ts` para o
 * incidente de produção que originou este teste. `tsc` e `eslint` não
 * enxergam nada dentro de um `String.raw`; isto tira a string do arquivo e
 * manda o ESLint olhar o que ela tem dentro.
 */
describe.each([
  ['da administração', SCRIPT_ADMIN],
  ['da tela de IA (v0.58.0)', SCRIPT_IA_ADMIN],
  ['dos modelos da tela de IA (v0.60.0)', SCRIPT_IA_ADMIN_MODELOS],
])('área administrativa — o JavaScript %s', (_nome, SCRIPT) => {
  const linter = new Linter();

  function analisar() {
    return linter.verify(SCRIPT, {
      languageOptions: {
        ecmaVersion: 2020,
        sourceType: 'script',
        globals: { ...globals.browser },
      },
      rules: {
        'no-undef': 'error',
        'no-dupe-keys': 'error',
        'no-dupe-args': 'error',
        'no-unreachable': 'error',
        'no-const-assign': 'error',
        'no-func-assign': 'error',
        'no-unused-expressions': 'error',
      },
    });
  }

  it('não usa nenhuma variável que não existe', () => {
    const problemas = analisar().filter((m) => m.ruleId === 'no-undef');
    expect(
      problemas.map((m) => `linha ${m.line}: ${m.message}`),
      'variável usada e nunca declarada no script da administração',
    ).toEqual([]);
  });

  it('não larga pedaço de HTML fora da concatenação', () => {
    const problemas = analisar().filter((m) => m.ruleId === 'no-unused-expressions');
    expect(
      problemas.map((m) => `linha ${m.line}: ${m.message}`),
      'expressão avaliada e descartada — em geral é um "+" que faltou numa concatenação',
    ).toEqual([]);
  });

  it('não tem erro de sintaxe', () => {
    const fatais = analisar().filter((m) => m.fatal);
    expect(fatais.map((m) => `linha ${m.line}: ${m.message}`)).toEqual([]);
  });

  it('passa nas demais regras de erro provável', () => {
    const problemas = analisar().filter((m) => !m.fatal && m.ruleId !== 'no-undef');
    expect(problemas.map((m) => `linha ${m.line}: ${m.ruleId} — ${m.message}`)).toEqual(
      [],
    );
  });
});
