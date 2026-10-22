#!/usr/bin/env node
/**
 * Comparador de modelos da análise do ato (v0.52.0) — MANUAL, fora do CI, só casos SINTÉTICOS.
 * NÃO consulta tribunal e NÃO abre o banco. ZDR em toda chamada; sem --executar só estima.
 *
 *   node scripts/ia-comparar-modelos.mjs --modelos=a,b               # estima (nada é enviado)
 *   node scripts/ia-comparar-modelos.mjs --modelos=a,b --executar    # roda, com teto de gasto
 *   node scripts/ia-comparar-modelos.mjs --ajuda
 *
 * Variáveis: OPENROUTER_API_KEY (nunca impressa) e PROCESSOVIVO_IA_MODELO (o modelo de produção).
 * Toda a lógica está em src/main/sonda/ (testada). Requer `npm run build`.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as dormir } from 'node:timers/promises';

const raiz = resolve(import.meta.dirname, '..');
const carregar = (caminho) =>
  import(caminho).catch(() => {
    console.error('Não encontrei dist/. Rode `npm run build` antes.');
    process.exit(1);
  });

const { executarComandoComparador } = await carregar('../dist/main/sonda/comandoComparadorIa.js');
const { TransporteOpenRouter } = await carregar('../dist/infrastructure/adapters/modelo/TransporteOpenRouter.js');
const { buscarEndpointsZdr, buscarModelosPublicos, buscarEndpointsPublicosDoModelo } = await carregar('../dist/infrastructure/adapters/modelo/endpointsZdr.js');
const { HttpClient } = await carregar('../dist/infrastructure/http/HttpClient.js');

const http = new HttpClient({ timeoutMs: 30_000, tentativas: 2 });

const codigo = await executarComandoComparador(process.argv.slice(2), {
  env: process.env,
  raizDoRepositorio: raiz,
  lerArquivo: (c) => readFile(c, 'utf8'),
  lerStdin: async () => '',
  gravarArquivo: async (c, conteudo) => {
    await mkdir(dirname(c), { recursive: true });
    await writeFile(c, conteudo, 'utf8');
  },
  existeArquivo: (c) => access(c).then(() => true, () => false),
  criarTransporte: (chave, opcoes) => new TransporteOpenRouter({ chave, ...opcoes }),
  criarTransporteDeDiagnostico: (chave, opcoes) => new TransporteOpenRouter({ chave, ...opcoes }),
  buscarEndpointsZdr: (chave) => buscarEndpointsZdr(http, chave),
  buscarModelosPublicos: () => buscarModelosPublicos(http),
  buscarEndpointsPublicosDoModelo: (modelo) => buscarEndpointsPublicosDoModelo(http, modelo),
  hoje: () => new Date().toISOString().slice(0, 10),
  hora: () => new Date().toISOString().slice(11, 16).replace(':', ''),
  agora: () => performance.now(),
  dormir: (ms) => dormir(ms),
  saida: (l) => console.log(l),
  aviso: (l) => console.error(l),
});
process.exit(codigo);
