/**
 * Dinheiro do centro de custos: texto digitado ⇄ CENTAVOS INTEIROS (v0.47.0).
 *
 * Valor monetário nunca é ponto flutuante neste sistema: `0,1 + 0,2` não é `0,3` em `number`, e
 * uma prestação de contas que fecha com um centavo a mais é uma prestação de contas errada. O
 * texto vira inteiro por manipulação de STRING — nada aqui multiplica um decimal por 100.
 *
 * As funções são PURAS e AUTOCONTIDAS (sem import, sem constante de fora): o console as recebe por
 * `toString()`, como `descricaoDoAto`, então o navegador e os testes exercitam o MESMO código.
 */

/**
 * Aceita `1.234,56`, `1234,56`, `1234`, `0,5` (= 50 centavos) e `R$ 1.234,56`. O ponto só vale
 * como separador de milhar, em grupos de três ("1.234"); `1234.56` e `12.34` NÃO são aceitos —
 * ponto decimal é ambíguo com milhar em português, e adivinhar erra o valor sem avisar.
 *
 * Devolve `null` para tudo o que não é um valor: vazio, texto, `NaN`, negativo, sinal, notação
 * científica, mais de duas casas decimais. Devolve `0` para `0` e `0,00` (é um valor, e quem
 * decide que não serve é a validação). Mais de 12 dígitos inteiros também é `null`: acima disso
 * o número já não cabe com exatidão num `number`, e nenhum custo chega perto.
 */
export function centavosDeTexto(texto: unknown): number | null {
  if (typeof texto !== 'string') return null;
  const t = texto
    .replace(/^\s*R\$\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const inteiro = (m[1] ?? '').replace(/\./g, '');
  if (inteiro.length > 12) return null;
  const decimais = ((m[2] ?? '') + '00').slice(0, 2);
  return Number(inteiro) * 100 + Number(decimais);
}

/** `123456` → `R$ 1.234,56`. Só aritmética de inteiro. */
export function reaisDeCentavos(centavos: number): string {
  const negativo = centavos < 0;
  const c = Math.abs(Math.trunc(centavos));
  const inteiro = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const resto = String(c % 100).padStart(2, '0');
  return (negativo ? '-' : '') + 'R$ ' + inteiro + ',' + resto;
}

/** `123456` → `1234,56`: o que o campo de edição mostra (sem R$ e sem milhar). */
export function campoDeCentavos(centavos: number): string {
  const c = Math.abs(Math.trunc(centavos));
  return String(Math.floor(c / 100)) + ',' + String(c % 100).padStart(2, '0');
}
