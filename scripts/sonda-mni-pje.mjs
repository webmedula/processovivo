#!/usr/bin/env node
/**
 * Sonda do MNI do PJe (v1.0.0) — SOMENTE LEITURA, para descobrir se o MNI de um tribunal PJe (o TRT18) aceita a
 * credencial do advogado e devolve a consulta de um processo e dos documentos. NÃO é recurso para clientes.
 *
 * No Console do serviço (a imagem já traz `dist/` e `scripts/`):
 *
 *   node scripts/sonda-mni-pje.mjs --url=<endereço do serviço MNI> --processo=<número CNJ>
 *
 * A credencial NUNCA vai em argumento (ficaria no histórico do shell): o programa pergunta CPF e senha SEM eco,
 * ou lê SONDA_MNI_CPF e SONDA_MNI_SENHA do ambiente daquele comando. Nada é gravado em disco, em log nem no banco; não
 * abre o cofre de produção. Uma tentativa por operação, sem repetição, e para na primeira recusa de
 * autenticação. Não consulta avisos pendentes (risco de ciência). A saída é só contagem e categoria.
 *
 * Toda a lógica está em src/main/sonda/ (testada); este arquivo só liga o terminal. Requer `npm run build`
 * fora da imagem do serviço.
 */
const { executarComandoSondaMniPje } =
  await import('../dist/main/sonda/comandoSondaMniPje.js').catch(() => {
    console.error(
      'Não encontrei dist/. Rode `npm run build` antes (a imagem do serviço já o traz).',
    );
    process.exit(1);
  });

/** Lê uma linha do terminal SEM eco. Sem terminal interativo, devolve `undefined`. */
function perguntarSemEco(rotulo) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.resolve(undefined);
  }
  return new Promise((resolver) => {
    process.stderr.write(rotulo);
    let digitado = '';
    const entrada = process.stdin;
    entrada.setRawMode(true);
    entrada.resume();
    entrada.setEncoding('utf8');
    const fim = (valor) => {
      entrada.setRawMode(false);
      entrada.pause();
      entrada.removeListener('data', aoReceber);
      process.stderr.write('\n');
      resolver(valor);
    };
    const aoReceber = (trecho) => {
      for (const c of trecho) {
        if (c === '\r' || c === '\n') return fim(digitado);
        if (c === '\u0003') {
          process.stderr.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') digitado = digitado.slice(0, -1);
        else digitado += c;
      }
    };
    entrada.on('data', aoReceber);
  });
}

const codigo = await executarComandoSondaMniPje({
  argv: process.argv.slice(2),
  env: process.env,
  perguntarSemEco,
  saida: (linha) => console.log(linha),
  aviso: (linha) => console.error(linha),
});
process.exit(codigo);
