import { carregarConfig } from '../../infrastructure/config/env.js';
import { montarAplicacao } from '../factories/makeProcessoSearchService.js';
import { ConfiguracaoDeChavesInvalidaError } from './chaves.js';
import { iniciar } from './servidor.js';

/**
 * Ponto de entrada do serviço HTTP — é o comando que o contêiner executa.
 *
 * Tudo que pode dar errado por CONFIGURAÇÃO dá errado aqui, antes do `listen`.
 * Um serviço que sobe com configuração ruim e só falha na primeira requisição
 * do cliente passa no health check e engana o painel de deploy; falhar no
 * arranque deixa o erro no log de deploy, que é onde alguém está olhando.
 */
async function principal(): Promise<void> {
  const config = carregarConfig();
  const app = montarAplicacao(config);
  await iniciar(app, config);
}

principal().catch((erro: unknown) => {
  if (erro instanceof ConfiguracaoDeChavesInvalidaError) {
    // Erro de configuração previsto: mensagem acionável, sem stack trace —
    // quem lê isso no log do Easypanel precisa saber o que corrigir, não onde
    // o Node estourou.
    console.error(`\n[Processo Vivo] Configuração de autenticação recusada.\n${erro.message}\n`);
    process.exit(1);
  }
  console.error('[Processo Vivo] Falha ao iniciar:', erro);
  process.exit(1);
});
