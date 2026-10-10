/**
 * Diagnóstico por chamada SEM texto e SEM chave: o corpo que foi enviado ao OpenRouter, com
 * todo conteúdo de mensagem trocado por um marcador de tamanho, para a conferência de "o que
 * saiu" não precisar do texto do ato.
 *
 * Regras: `messages` vira só `{ role, conteudo: "[omitido: N caracteres]" }`; qualquer campo
 * com nome de segredo vira "[omitido]"; qualquer outra string longa (> 120) vira marcador. O
 * que sobra é estrutura: modelo, temperatura, `provider`, `response_format` (o esquema).
 */
const NOMES_DE_SEGREDO = /authorization|api[_-]?key|\bkey\b|token|secret|senha|password/i;
const LIMITE_DE_STRING = 120;

const marcador = (n: number): string => `[omitido: ${n} caracteres]`;

function tamanhoDoConteudo(conteudo: unknown): number {
  if (typeof conteudo === 'string') return conteudo.length;
  if (Array.isArray(conteudo))
    return conteudo.reduce((a: number, p) => a + tamanhoDoConteudo(p), 0);
  if (typeof conteudo === 'object' && conteudo !== null) {
    const texto = (conteudo as Record<string, unknown>)['text'];
    return typeof texto === 'string' ? texto.length : 0;
  }
  return 0;
}

export function sanearCorpoEnviado(valor: unknown, chave = ''): unknown {
  if (NOMES_DE_SEGREDO.test(chave)) return '[omitido]';
  if (chave === 'messages' && Array.isArray(valor)) {
    return valor.map((m: unknown) => {
      const o = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {};
      return {
        role: typeof o['role'] === 'string' ? o['role'] : '?',
        conteudo: marcador(tamanhoDoConteudo(o['content'])),
      };
    });
  }
  if (typeof valor === 'string')
    return valor.length > LIMITE_DE_STRING ? marcador(valor.length) : valor;
  if (Array.isArray(valor)) return valor.map((v) => sanearCorpoEnviado(v));
  if (typeof valor === 'object' && valor !== null) {
    return Object.fromEntries(
      Object.entries(valor as Record<string, unknown>).map(([k, v]) => [
        k,
        sanearCorpoEnviado(v, k),
      ]),
    );
  }
  return valor;
}
