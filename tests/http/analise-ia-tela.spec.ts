import { describe, expect, it } from 'vitest';
import { SCRIPT_ANALISE_IA } from '../../src/main/http/ui/analiseIA.js';

/*
 * O botão "Analisar com IA" da tabela de Atualizações (v0.49.2): contrato do arquivo, sem navegador.
 * O comportamento (clique, painel, estados) está em tests/browser/analise-ia-navegador.spec.ts.
 */
describe('"Analisar com IA" em ícone — o contrato do arquivo', () => {
  it('é um botão com aria-label, dica comum do console, texto só para os cartões e o mesmo clique de antes', () => {
    for (const frase of [
      'aria-label="Analisar com IA"',
      'window.__pvProvidencia.comDica(',
      'data-acao="ia"',
      'aria-expanded=',
      'aria-controls="pvia-',
      'class="pvia-btn-t"',
      'ICO_IA',
    ]) {
      expect(SCRIPT_ANALISE_IA, frase).toContain(frase);
    }
    // O texto de botão e o `title` longo antigos saíram.
    expect(SCRIPT_ANALISE_IA).not.toContain('nov-btn pvia-btn');
    expect(SCRIPT_ANALISE_IA).not.toContain('Gera um resumo do ato por IA');
  });

  it('sem IA ligada ou sem chave do ato, não há botão (o ícone não inventa estado)', () => {
    expect(SCRIPT_ANALISE_IA).toContain("if(!habilitada()||!chave)return ''");
  });
});
