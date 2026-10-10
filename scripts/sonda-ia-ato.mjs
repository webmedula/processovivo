#!/usr/bin/env node
/**
 * Sonda de IA do ato (v1.0.0) — NÃO consulta tribunal e NÃO abre o banco.
 *
 * Compara 3 ou 4 modelos do AI Gateway da Vercel, SEMPRE com retenção zero de
 * dados (ZDR) por requisição, na tarefa "ler o ato e dizer o que ele parece
 * pedir, com citação literal verificada". Imprime métricas e gera a planilha
 * de avaliação do Autran.
 *
 *   node scripts/sonda-ia-ato.mjs --modelos=a,b,c                    # casos sintéticos
 *   node scripts/sonda-ia-ato.mjs --modelos=a,b,c --arquivo=/dados/casos.csv
 *   cat casos.csv | node scripts/sonda-ia-ato.mjs --modelos=a,b,c --stdin
 *   node scripts/sonda-ia-ato.mjs --avaliacao=/dados/sonda-ia-ato/planilha-AAAA-MM-DD.csv
 *   node scripts/sonda-ia-ato.mjs --ajuda
 *
 * Variável: AI_GATEWAY_API_KEY (nunca impressa). Toda a lógica está em
 * src/main/sonda/ (testada); este arquivo só liga o terminal. Requer
 * `npm run build` fora da imagem do serviço, que já traz `dist/`.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as dormir } from 'node:timers/promises';

const raiz = resolve(import.meta.dirname, '..');
const carregar = (caminho) =>
  import(caminho).catch(() => {
    console.error('Não encontrei dist/. Rode `npm run build` antes (a imagem do serviço já o traz).');
    process.exit(1);
  });

const { executarComandoSondaIa } = await carregar('../dist/main/sonda/comandoSondaIa.js');
const { TransporteGateway } = await carregar('../dist/infrastructure/adapters/modelo/TransporteGateway.js');
const { precosDoCatalogo } = await carregar('../dist/infrastructure/adapters/modelo/catalogoDoGateway.js');

const lerStdin = async () => {
  const pedacos = [];
  for await (const p of process.stdin) pedacos.push(p);
  return Buffer.concat(pedacos).toString('utf8');
};

const codigo = await executarComandoSondaIa(process.argv.slice(2), {
  env: process.env,
  raizDoRepositorio: raiz,
  lerArquivo: (c) => readFile(c, 'utf8'),
  lerStdin,
  gravarArquivo: async (c, conteudo) => {
    await mkdir(dirname(c), { recursive: true });
    await writeFile(c, conteudo, 'utf8');
  },
  existeArquivo: (c) => access(c).then(() => true, () => false),
  criarTransporte: (chave) => new TransporteGateway({ chave }),
  precosDoCatalogo,
  hoje: () => new Date().toISOString().slice(0, 10),
  agora: () => performance.now(),
  dormir: (ms) => dormir(ms),
  saida: (l) => console.log(l),
  aviso: (l) => console.error(l),
});
process.exit(codigo);
