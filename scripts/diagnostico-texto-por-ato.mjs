#!/usr/bin/env node
/**
 * Diagnóstico do texto por ato (v1.0.0) — SOMENTE LEITURA, SEM REDE, SEM MODELO.
 *
 * Responde, por conta (workspace), quantos atos do retrato têm texto suficiente para
 * a análise por IA ler, antes de a Etapa 2 ser construída: atos no total e nos
 * últimos 30 dias, por fonte (DJEN, DataJud, MNI), quantos são o aviso de arquivos
 * indisponíveis, de segredo de justiça ou curtos demais — e, entre os processos que
 * pedem providência hoje, quantos têm o ATO da providência com texto suficiente.
 *
 * No Console do serviço (a imagem já traz `dist/` e `scripts/`):
 *
 *   node scripts/diagnostico-texto-por-ato.mjs
 *   node scripts/diagnostico-texto-por-ato.mjs --workspace=ana@escritorio.com.br
 *   node scripts/diagnostico-texto-por-ato.mjs --janela-dias=30
 *
 * Só contagens: nenhum texto de ato, nenhum número de processo, e-mail mascarado no
 * terminal e ausente do arquivo numérico em os.tmpdir(). Não abre o banco para
 * escrita, não migra, não grava nada além do arquivo de números. Variáveis lidas:
 * PROCESSOVIVO_DB_PATH e PENDENCIA_JANELA_DIAS (as mesmas do serviço).
 *
 * Toda a lógica está em src/main/sonda/diagnosticoDeTextoPorAto.ts (testada). Requer
 * `npm run build` quando rodado fora da imagem.
 */
const { executarDiagnosticoDeTexto } = await import(
  '../dist/main/sonda/diagnosticoDeTextoPorAto.js'
).catch(() => {
  console.error('Não encontrei dist/. Rode `npm run build` antes (a imagem do serviço já o traz).');
  process.exit(1);
});

const pendencia = Number(process.env.PENDENCIA_JANELA_DIAS);
const codigo = executarDiagnosticoDeTexto(process.argv.slice(2), {
  caminhoBanco: process.env.PROCESSOVIVO_DB_PATH ?? './dados/processovivo.db',
  config: Number.isInteger(pendencia) && pendencia > 0 ? { janelaPendenciaDias: pendencia } : {},
  saida: (linha) => console.log(linha),
  aviso: (linha) => console.error(linha),
});
process.exit(codigo);
