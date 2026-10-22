#!/usr/bin/env node
/**
 * Diagnóstico do resumo por IA (v1.0.0, 0.54.0) — SOMENTE LEITURA, SEM REDE, SÓ NÚMEROS.
 * Mostra, para um processo acompanhado, de onde vem o texto que o resumo conta como "utilizável"
 * e por que o ato mais recente entrou (ou não) com texto. Nenhum texto, título, nome, número de
 * processo, identificador de ato ou conta sai daqui, e nada é gravado.
 *
 * No Console do serviço (a imagem já traz `dist/` e `scripts/`):
 *
 *   node scripts/diagnostico-resumo.mjs <número do processo>
 *   node scripts/diagnostico-resumo.mjs <número do processo> --workspace=<id ou e-mail>
 *
 * O número é argumento em tempo de execução: nunca entra no repositório, em teste ou em log.
 * Variáveis lidas: PROCESSOVIVO_DB_PATH e PENDENCIA_JANELA_DIAS (as do serviço).
 * Toda a lógica está em src/main/sonda/diagnosticoDoResumo.ts (testada). Requer `npm run build`
 * quando rodado fora da imagem.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const { executarDiagnosticoDoResumo } =
  await import('../dist/main/sonda/diagnosticoDoResumo.js').catch(() => {
    console.error(
      'Não encontrei dist/. Rode `npm run build` antes (a imagem do serviço já o traz).',
    );
    process.exit(1);
  });

const janela = Number(process.env.PENDENCIA_JANELA_DIAS);
const codigo = executarDiagnosticoDoResumo(process.argv.slice(2), {
  caminhoBanco: resolve(process.env.PROCESSOVIVO_DB_PATH ?? './dados/processovivo.db'),
  existeArquivo: (c) => existsSync(c),
  agora: () => new Date(),
  janelaDePendenciaDias: Number.isInteger(janela) && janela > 0 ? janela : 10,
  saida: (l) => console.log(l),
  aviso: (l) => console.error(l),
});
process.exit(codigo);
