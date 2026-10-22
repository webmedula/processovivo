#!/usr/bin/env node
/**
 * Medição da camada de texto das peças guardadas (v0.53.0, Fase 0 da análise de peças por IA)
 * — SOMENTE LEITURA, SEM REDE, SÓ AGREGADOS. Nada de texto, nome, número de processo ou workspace
 * sai daqui, e nada é gravado.
 *
 * No Console do serviço (a imagem já traz `dist/`, `scripts/` e o `pdftotext`):
 *
 *   node scripts/pecas-medir-texto.mjs
 *
 * Variáveis lidas (as mesmas do serviço): PROCESSOVIVO_DB_PATH e LEITOR_PASTA.
 * Toda a lógica está em src/main/sonda/medicaoDeTextoDePecas.ts (testada). Requer `npm run build`
 * quando rodado fora da imagem.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const carregar = (caminho) =>
  import(caminho).catch(() => {
    console.error('Não encontrei dist/. Rode `npm run build` antes (a imagem do serviço já o traz).');
    process.exit(1);
  });
const { executarMedicaoDeTexto } = await carregar('../dist/main/sonda/medicaoDeTextoDePecas.js');
const { PdftotextExtrator } = await carregar('../dist/infrastructure/pdf/PdftotextExtrator.js');

const caminhoBanco = resolve(process.env.PROCESSOVIVO_DB_PATH ?? './dados/processovivo.db');
const pastaDasPecas = resolve(process.env.LEITOR_PASTA || join(dirname(caminhoBanco), 'leitor'));

const codigo = await executarMedicaoDeTexto(process.argv.slice(2), {
  caminhoBanco,
  pastaDasPecas,
  extrator: new PdftotextExtrator(),
  lerArquivo: (c) => readFile(c).catch(() => undefined),
  existeArquivo: (c) => existsSync(c),
  agora: () => new Date(),
  saida: (l) => console.log(l),
  aviso: (l) => console.error(l),
});
process.exit(codigo);
