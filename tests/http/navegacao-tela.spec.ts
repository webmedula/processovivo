import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCRIPT_NAVEGACAO } from '../../src/main/http/ui/navegacao.js';
import { paginaConsole } from '../../src/main/http/ui/pagina.js';

/* Invariantes da navegação por hash (v0.57.0) — o que o navegador não precisa provar de novo. */
// `split('\n').length` de `script.ts` na 0.56.2 (2.340 quebras de linha + a última): os ganchos entraram em linhas que já existiam.
const LINHAS_DO_SCRIPT_ANTES_DA_NAVEGACAO = 2341;

const fonte = (caminho: string): string =>
  readFileSync(resolve(__dirname, '../..', caminho), 'utf8');

describe('navegação por hash', () => {
  it('script.ts NÃO cresce: os ganchos entraram em linhas que já existiam', () => {
    const script = fonte('src/main/http/ui/script.ts');
    expect(script.split('\n').length).toBeLessThanOrEqual(
      LINHAS_DO_SCRIPT_ANTES_DA_NAVEGACAO,
    );
    expect(script).toContain('window.__pvNav.aba(aba)');
    expect(script).toContain('window.__pvNav.processo(numero)');
    expect(script).toContain('window.__pvNav.voltarDoProcesso()');
    expect(script).toContain('window.__pvNav.inicial()');
    expect(script).toContain('window.__pvNav.sair()');
    // A navegação não mora no script do console: ele só a chama.
    expect(script).not.toContain('history.pushState');
    expect(script).not.toContain("'popstate'");
  });

  it('o módulo vai na página, depois do console, e não carrega nada de fora', () => {
    const html = paginaConsole('0.0.0');
    expect(html).toContain(SCRIPT_NAVEGACAO.trim().slice(0, 40));
    expect(SCRIPT_NAVEGACAO).not.toMatch(/https?:\/\//);
    expect(SCRIPT_NAVEGACAO).not.toMatch(/<script|<link/i);
  });

  it('nenhum dado pessoal vai à URL: o endereço usa só identificador opaco, aba e id interno de peça', () => {
    // A rota do processo só aceita o token opaco; o número CNJ e o nome da parte não têm caminho até o hash.
    expect(SCRIPT_NAVEGACAO).toContain("'#/processo/'");
    expect(SCRIPT_NAVEGACAO).toContain('/^[a-z0-9]{6,20}$/');
    expect(SCRIPT_NAVEGACAO).not.toMatch(/location\.hash\s*=[^=]/);
    expect(SCRIPT_NAVEGACAO).not.toMatch(/(pushState|replaceState)\([^)]*numero/);
    // O link "Atualizações → processo" também deixou de levar o número.
    expect(fonte('src/main/http/ui/atualizacoes.ts')).not.toContain('href="/?processo=');
  });

  it('login e logout usam replaceState; só as navegações do usuário empurram entradas', () => {
    expect(SCRIPT_NAVEGACAO).toMatch(/sair:function\(\)\{[\s\S]*history\.replaceState/);
    const empurrar = SCRIPT_NAVEGACAO.match(/history\.pushState/g) ?? [];
    expect(empurrar).toHaveLength(1);
  });
});
