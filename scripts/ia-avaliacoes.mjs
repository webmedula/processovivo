#!/usr/bin/env node
/**
 * Avaliações da análise por IA (v1.0.0) — SOMENTE LEITURA, SEM REDE, SEM MODELO.
 *
 * Mostra, por modelo e por versão do prompt: quantas análises foram feitas, quantas
 * foram avaliadas como Útil / Errado / Perigoso pelos advogados, a taxa de "não
 * verificado", a latência p50/p95 e o custo médio. É assim que o dono decide, com uso
 * real, se o modelo serve.
 *
 * No Console do serviço (a imagem já traz `dist/` e `scripts/`):
 *
 *   node scripts/ia-avaliacoes.mjs
 *
 * Só números: nenhum texto de ato, nenhum resultado de análise, nenhum número de
 * processo, nenhuma conta. Não abre o banco para escrita, não migra, não grava nada.
 * Variável lida: PROCESSOVIVO_DB_PATH (a mesma do serviço). Lógica testada em
 * src/main/sonda/avaliacoesDeIa.ts. Requer `npm run build` quando rodado fora da imagem.
 */
const { executarAvaliacoesDeIa } =
  await import('../dist/main/sonda/avaliacoesDeIa.js').catch(() => {
    console.error(
      'Não encontrei dist/. Rode `npm run build` antes (a imagem do serviço já o traz).',
    );
    process.exit(1);
  });

const codigo = executarAvaliacoesDeIa(process.argv.slice(2), {
  caminhoBanco: process.env.PROCESSOVIVO_DB_PATH ?? './dados/processovivo.db',
  saida: (linha) => console.log(linha),
  aviso: (linha) => console.error(linha),
});
process.exit(codigo);
