/**
 * Nome de classe processual para EXIBIÇÃO (v0.37.2).
 *
 * A mesma classe chega escrita de jeitos diferentes: o DataJud manda
 * "Procedimento Comum Cível"; o DJEN manda CAIXA ALTA com o acento minúsculo
 * ("PROCEDIMENTO COMUM CíVEL", "AçãO TRABALHISTA"). Na tela isso virava duas
 * escritas da mesma classe e, no filtro de "Meus processos", duas opções.
 *
 * Só a exibição muda: o valor guardado e a API seguem como vieram, e o texto cru
 * vai no `title` quando difere. Regras:
 * - caixa alta só é rebaixada quando o TEXTO é majoritariamente alto (70% das
 *   letras — o corte que o `titulo()` do console já usava) ou quando a PALAVRA é
 *   a do acento quebrado do DJEN (maiúsculas com só minúsculas acentuadas:
 *   "CíVEL", "AçãO"). Sigla solta num texto bem escrito ("JEF") fica como está;
 * - preposições (de, da, do, e…) ficam minúsculas, menos na primeira palavra;
 * - siglas conhecidas voltam para maiúsculas (INSS, FGTS, CPC…);
 * - palavra minúscula ganha a inicial maiúscula ("comum" → "Comum"); o resto da
 *   palavra bem escrita não é tocado (nada de lower-case em "PJe").
 *
 * Idempotente: texto já normalizado volta igual. Entrada ausente ou não-texto
 * devolve '' — a tela escreve "—"; classe não se inventa.
 *
 * Função pura e AUTOCONTIDA de propósito (como `descricaoDoAto`): o console é
 * JavaScript dentro de uma string, recebe `nomeDaClasse.toString()` e o teste
 * exercita exatamente a mesma função. Nada de helper ou constante de módulo.
 */
export function nomeDaClasse(entrada: unknown): string {
  if (typeof entrada !== 'string') return '';
  const texto = entrada.replace(/\s+/g, ' ').trim();
  if (!texto) return '';

  const miudas = ['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas'];
  miudas.push('a', 'o', 'ao', 'à', 'por', 'com', 'para', 'sem', 'sob', 'contra');
  const siglas = ['INSS', 'FGTS', 'CPC', 'CDC', 'OAB', 'CNJ', 'ME', 'EPP', 'LTDA', 'PIS'];
  siglas.push('COFINS', 'ICMS', 'IPTU', 'IPVA', 'ISS', 'IRPF', 'MP', 'TJ', 'STJ', 'STF');
  siglas.push('I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X');

  const letras = texto.match(/\p{L}/gu) ?? [];
  if (letras.length === 0) return texto;
  const altas = letras.filter((c) => c !== c.toLowerCase()).length;
  const tudoAlto = altas / letras.length >= 0.7;

  let indice = -1;
  return texto.replace(/\p{L}+/gu, (palavra) => {
    indice += 1;
    const cs = Array.from(palavra);
    const maiusculas = cs.filter((c) => c !== c.toLowerCase());
    const minusculas = cs.filter((c) => c !== c.toUpperCase());
    // "CíVEL": maiúsculas e minúsculas, mas toda minúscula é acentuada — é o DJEN
    // escrevendo em caixa alta, e não uma palavra de grafia própria como "PJe".
    const quebrada =
      maiusculas.length >= 2 &&
      minusculas.length > 0 &&
      minusculas.every((c) => c.charCodeAt(0) > 127);
    const alta = maiusculas.length === cs.length && cs.length > 0;
    const baixa = palavra.toLowerCase();
    const inicial = (p: string): string => {
      const [primeira = '', ...resto] = Array.from(p);
      return primeira.toUpperCase() + resto.join('');
    };

    if (alta && siglas.includes(palavra)) return palavra;
    if (alta || quebrada) {
      // Sigla desconhecida em texto bem escrito: ou é sigla, ou não sabemos — fica.
      if (!tudoAlto && !quebrada) return palavra;
      if (indice > 0 && miudas.includes(baixa)) return baixa;
      return inicial(baixa);
    }
    if (indice > 0 && miudas.includes(baixa)) return baixa;
    return inicial(palavra);
  });
}
