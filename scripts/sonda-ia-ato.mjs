#!/usr/bin/env node
/**
 * Sonda de IA do ato (v1.1.1) — NÃO consulta tribunal e NÃO abre o banco.
 *
 * Compara 3 ou 4 modelos pelo OpenRouter, SEMPRE com retenção zero de
 * dados (ZDR) por requisição (`provider.zdr: true`), na tarefa "ler o ato e dizer o que ele parece
 * pedir, com citação literal verificada". Imprime métricas e gera a planilha
 * de avaliação do Autran.
 *
 *   node scripts/sonda-ia-ato.mjs --listar-modelos-zdr[=filtro]      # modelos com endpoint ZDR
 *   node scripts/sonda-ia-ato.mjs --modelos=a,b,c                    # casos sintéticos
 *   node scripts/sonda-ia-ato.mjs --modelos=a,b,c --arquivo=/dados/casos.csv
 *   cat casos.csv | node scripts/sonda-ia-ato.mjs --modelos=a,b,c --stdin
 *   node scripts/sonda-ia-ato.mjs --avaliacao=/dados/sonda-ia-ato/planilha-AAAA-MM-DD.csv
 *   node scripts/sonda-ia-ato.mjs --controle-positivo[=modelo]       # 1 chamada, texto sintético, modelo COM ZDR
 *   node scripts/sonda-ia-ato.mjs --controle-negativo[=modelo]       # 1 chamada, texto sintético, modelo SEM ZDR
 *   node scripts/sonda-ia-ato.mjs --ajuda
 *
 * Variável: OPENROUTER_API_KEY (nunca impressa). Toda a lógica está em
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
const { TransporteOpenRouter } = await carregar('../dist/infrastructure/adapters/modelo/TransporteOpenRouter.js');
const { buscarEndpointsZdr, buscarModelosPublicos, buscarEndpointsPublicosDoModelo } = await carregar('../dist/infrastructure/adapters/modelo/endpointsZdr.js');
const { HttpClient } = await carregar('../dist/infrastructure/http/HttpClient.js');

const http = new HttpClient({ timeoutMs: 30_000, tentativas: 2 });

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
  criarTransporte: (chave, opcoes) => new TransporteOpenRouter({ chave, ...opcoes }),
  buscarEndpointsZdr: (chave) => buscarEndpointsZdr(http, chave),
  buscarModelosPublicos: () => buscarModelosPublicos(http),
  buscarEndpointsPublicosDoModelo: (modelo) => buscarEndpointsPublicosDoModelo(http, modelo),
  hoje: () => new Date().toISOString().slice(0, 10),
  agora: () => performance.now(),
  dormir: (ms) => dormir(ms),
  saida: (l) => console.log(l),
  aviso: (l) => console.error(l),
});
process.exit(codigo);
