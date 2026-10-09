#!/usr/bin/env node
/**
 * Sonda de diagnóstico da providência (v1.0.0) — SOMENTE LEITURA, SEM REDE.
 *
 * Explica, processo a processo, por que um processo aparece ou não aparece em
 * Atualizações → "Pedem providência" (TJGO + Últimos 15 dias), para comparar com a
 * tela de Intimações do Projudi. Não consulta tribunal, não grava nada no banco,
 * não roda migração, não lê senha nem XML.
 *
 * No Console do serviço (a imagem já traz `dist/` e `scripts/`):
 *
 *   node scripts/diagnostico-providencia.mjs --lista-filtro
 *   node scripts/diagnostico-providencia.mjs --lista-filtro --workspace=ana@escritorio.com.br
 *   node scripts/diagnostico-providencia.mjs --numeros=0000000-00.2026.8.09.0000,… --mostrar
 *   node scripts/diagnostico-providencia.mjs --arquivo=numeros.txt
 *
 * Sem --mostrar os números saem mascarados. Com mais de um workspace, --workspace
 * é obrigatório (aceita o identificador ou o e-mail da conta). Variáveis lidas:
 * PROCESSOVIVO_DB_PATH, NOVIDADES_JANELA_DIAS e PENDENCIA_JANELA_DIAS — as mesmas
 * do serviço, para a sonda e a tela concordarem.
 *
 * Toda a lógica está em src/infrastructure/persistencia/diagnosticoDeProvidencia.ts
 * (testada); este arquivo só liga os argumentos e o terminal. Requer `npm run build`
 * quando rodado fora da imagem.
 */
const { executarDiagnostico } = await import(
  '../dist/infrastructure/persistencia/diagnosticoDeProvidencia.js'
).catch(() => {
  console.error('Não encontrei dist/. Rode `npm run build` antes (a imagem do serviço já o traz).');
  process.exit(1);
});

const inteiro = (valor) => {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
const periodo = inteiro(process.env.NOVIDADES_JANELA_DIAS);
const pendencia = inteiro(process.env.PENDENCIA_JANELA_DIAS);

const codigo = executarDiagnostico(process.argv.slice(2), {
  caminhoBanco: process.env.PROCESSOVIVO_DB_PATH ?? './dados/processovivo.db',
  config: {
    ...(periodo ? { janelaPeriodoDias: periodo } : {}),
    ...(pendencia ? { janelaPendenciaDias: pendencia } : {}),
  },
  saida: (linha) => console.log(linha),
  aviso: (linha) => console.error(linha),
});
process.exit(codigo);
