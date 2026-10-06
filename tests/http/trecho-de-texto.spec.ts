import { describe, expect, it } from 'vitest';
import { trechoDeTexto } from '../../src/main/http/ui/trechoDeTexto.js';
import { SCRIPT_ATUALIZACOES } from '../../src/main/http/ui/atualizacoes.js';

describe('trechoDeTexto (v0.35.1) — só o começo do texto do ato', () => {
  it('texto curto passa inteiro, sem corte', () => {
    expect(trechoDeTexto('Intime-se a parte autora.')).toEqual({
      texto: 'Intime-se a parte autora.',
      cortado: false,
    });
  });

  it('texto longo é cortado em limite de palavra, com no máximo 220 caracteres', () => {
    const longo = 'decisão '.repeat(100);
    const t = trechoDeTexto(longo);
    expect(t.cortado).toBe(true);
    expect(Array.from(t.texto).length).toBeLessThanOrEqual(220);
    expect(t.texto.endsWith('decisão')).toBe(true);
    expect(longo.startsWith(t.texto)).toBe(true);
  });

  it('não parte palavra no meio quando há espaço antes do limite', () => {
    const t = trechoDeTexto('aaaa bbbb cccc', 7);
    expect(t).toEqual({ texto: 'aaaa', cortado: true });
  });

  it('palavra única maior que o limite é cortada no limite (sem espaço para recuar)', () => {
    const t = trechoDeTexto('x'.repeat(300));
    expect(t.cortado).toBe(true);
    expect(Array.from(t.texto)).toHaveLength(220);
  });

  it('quebras de linha e espaços repetidos viram um espaço só', () => {
    expect(trechoDeTexto('  Linha um.\n\n\tLinha   dois.  \r\n').texto).toBe(
      'Linha um. Linha dois.',
    );
  });

  it('texto vazio, só espaços ou que não é texto não gera bloco', () => {
    for (const v of ['', '   \n\t ', undefined, null, 42]) {
      expect(trechoDeTexto(v)).toEqual({ texto: '', cortado: false });
    }
  });

  it('tira pontuação e abertura pendurada antes das reticências', () => {
    const t = trechoDeTexto('Defiro o pedido, ( para tanto', 19);
    expect(t.cortado).toBe(true);
    expect(t.texto).toBe('Defiro o pedido');
  });

  it('acentos (inclusive decompostos) e emoji não são cortados ao meio', () => {
    const emoji = '👩‍⚖️';
    const base = 'ação ' + emoji.repeat(10) + ' fim';
    for (let limite = 1; limite <= 30; limite++) {
      const t = trechoDeTexto(base, limite);
      // sem metade de emoji composto: nenhum ZWJ ou seletor de variação solto no fim
      expect(t.texto).not.toMatch(/(?:‍|️)$/);
      expect(t.texto).not.toMatch(/[\ud800-\udbff]$/);
      expect(base.normalize('NFC').startsWith(t.texto)).toBe(true);
    }
    const decomposto = 'café '.repeat(60);
    const t = trechoDeTexto(decomposto, 9);
    expect(t.texto).not.toMatch(/́$/u.source === '' ? /x^/ : /^́/);
    expect(Array.from(t.texto.normalize('NFC')).every((c) => c !== '́')).toBe(true);
  });

  it('um texto de ~3.000 caracteres vira um trecho curto', () => {
    const t = trechoDeTexto('Julgo procedente o pedido formulado na inicial. '.repeat(64));
    expect(t.cortado).toBe(true);
    expect(Array.from(t.texto).length).toBeLessThanOrEqual(220);
  });
});

describe('módulo de Atualizações usa o trecho', () => {
  it('injeta a mesma função e não imprime o conteúdo inteiro', () => {
    expect(SCRIPT_ATUALIZACOES).toContain('var trechoDeTexto=function trechoDeTexto(');
    expect(SCRIPT_ATUALIZACOES).not.toContain("p.esc(n.conteudo)");
  });

  it('as reticências ficam fora da leitura e há "Abrir processo" quando houve corte', () => {
    expect(SCRIPT_ATUALIZACOES).toContain('aria-hidden="true">…</span>');
    expect(SCRIPT_ATUALIZACOES).toContain('Abrir processo');
  });
});
