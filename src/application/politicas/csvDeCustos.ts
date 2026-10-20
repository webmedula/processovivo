/**
 * CSV dos custos (v0.49.0), pensado para o Excel em português: UTF-8 COM BOM, separador ponto e
 * vírgula, vírgula decimal, datas dd/mm/aaaa e fim de linha CRLF.
 *
 * **Proteção contra injeção de fórmula:** célula de TEXTO que começa com `=`, `+`, `-`, `@`, tabulação
 * ou retorno de carro recebe um apóstrofo na frente — o Excel passa a tratá-la como texto, nunca como
 * fórmula. Vale para toda célula que veio de gente (descrição, observação, cliente, número digitado);
 * os valores em dinheiro nascem aqui, nunca negativos, e saem como número.
 */
export const BOM = '﻿';
const SEPARADOR = ';';

const GATILHOS_DE_FORMULA = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Neutraliza a célula de texto e a escapa para o CSV. */
export function celulaDeTexto(valor: string): string {
  const t = valor.split('\u0000').join('');
  const seguro = t.length > 0 && GATILHOS_DE_FORMULA.has(t[0] ?? '') ? `'${t}` : t;
  return escapar(seguro);
}

/** Número já formatado por quem sabe do domínio (ex.: `1234,56`): só escapa. */
export function celulaNumerica(valor: string): string {
  return escapar(valor);
}

function escapar(t: string): string {
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function linhaDeCsv(celulas: readonly string[]): string {
  return celulas.join(SEPARADOR);
}

/** Junta cabeçalho e linhas (já escapadas) no arquivo final: BOM + CRLF. */
export function montarCsv(
  cabecalho: readonly string[],
  linhas: readonly string[],
): string {
  return (
    BOM + [linhaDeCsv(cabecalho.map(celulaDeTexto)), ...linhas].join('\r\n') + '\r\n'
  );
}
