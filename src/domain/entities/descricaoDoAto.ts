/**
 * Descrição enxuta de um ato (v0.37.1), só para EXIBIÇÃO.
 *
 * O tribunal manda o tipo duas vezes: "Juntada -> Petição — Juntada -> Petição -
 * MANDADO LEVANTAMENTO" (descrição + " — " + complemento, e o complemento começa
 * repetindo a descrição). Com a linha limitada a duas linhas, o corte caía em cima
 * do que importa, o detalhe. Aqui sai só a repetição: `A — A - detalhe` vira
 * `A - detalhe` e `A — A` vira `A`.
 *
 * Nunca corta, resume ou reescreve além disso: sem repetição, o texto volta como
 * está; textos parecidos mas diferentes não colapsam; setas "->" e travessões dentro
 * do texto ficam. O original continua no `title`, nos dados e na API.
 *
 * A função é pura e AUTOCONTIDA de propósito (como `trechoDeTexto`): o console é
 * JavaScript dentro de uma string, o navegador recebe `descricaoDoAto.toString()` e
 * o teste exercita exatamente a mesma função. Nada de helper ou constante de módulo.
 */
export function descricaoDoAto(entrada: unknown): string {
  if (typeof entrada !== 'string') return '';
  // Caixa, acento e espaço repetido não distinguem "A" de "A": é o mesmo tipo escrito
  // duas vezes por sistemas diferentes do tribunal.
  const norm = (s: string): string =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const sep = /\s+—\s+/.exec(entrada);
  if (!sep) return entrada;
  const alvo = norm(entrada.slice(0, sep.index));
  if (!alvo) return entrada;
  const direita = entrada.slice(sep.index + sep[0].length).trim();
  if (norm(direita) === alvo) return direita;
  // A repetição pode ser seguida de " - detalhe". Testa cada hífen separado por
  // espaço, porque o próprio tipo pode conter um.
  const hifen = /\s+-\s+/g;
  let achou = hifen.exec(direita);
  while (achou) {
    if (norm(direita.slice(0, achou.index)) === alvo) return direita;
    achou = hifen.exec(direita);
  }
  return entrada;
}
