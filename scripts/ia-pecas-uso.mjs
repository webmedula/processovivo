#!/usr/bin/env node
/**
 * Uso da análise de PEÇA por IA, por conta (v0.55.0) — SOMENTE LEITURA, SEM REDE, SEM MODELO.
 *
 * Mostra quantas análises de peça cada conta fez (vigentes, hoje, o peso no teto diário, avaliadas e
 * o custo). Só contagens e o identificador do workspace — o mesmo que vai na lista
 * `PROCESSOVIVO_IA_PECAS_WORKSPACES`. Nunca resultado, trecho, número de processo nem e-mail.
 *
 * No Console do serviço (a imagem já traz `dist/` e `scripts/`):
 *
 *   node scripts/ia-pecas-uso.mjs
 *
 * Variável lida: PROCESSOVIVO_DB_PATH (a mesma do serviço). Lógica testada em
 * src/main/sonda/usoDaAnaliseDePeca.ts. Requer `npm run build` quando rodado fora da imagem.
 */
const { executarUsoDaAnaliseDePeca } =
  await import('../dist/main/sonda/usoDaAnaliseDePeca.js').catch(() => {
    console.error(
      'Não encontrei dist/. Rode `npm run build` antes (a imagem do serviço já o traz).',
    );
    process.exit(1);
  });

const codigo = executarUsoDaAnaliseDePeca(process.argv.slice(2), {
  caminhoBanco: process.env.PROCESSOVIVO_DB_PATH ?? './dados/processovivo.db',
  agora: () => new Date(),
  saida: (linha) => console.log(linha),
  aviso: (linha) => console.error(linha),
});
process.exit(codigo);
