import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import type { Processo } from '../../domain/entities/Processo.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import type { ServicoCalendario } from './ServicoCalendario.js';

/**
 * O ponto ÚNICO onde a detecção do calendário encontra a ingestão de
 * andamentos.
 *
 * Decorator sobre a porta das pastas: toda gravação de retrato passa por
 * `registrarSincronizacao` — a varredura, o "acompanhar" e as três da
 * vigilância por OAB —, e embrulhar a porta cobre todas sem que nenhum desses
 * serviços saiba que o calendário existe. Um gancho em cada um seriam cinco
 * lugares para lembrar no dia do sexto.
 *
 * **A detecção roda DEPOIS de gravar e nunca derruba a sincronização.** O
 * andamento é o produto; o calendário é leitura derivada dele. Uma falha aqui
 * vai para o log e a varredura segue — o processo continua sincronizado, e a
 * próxima sincronização (que relê a janela inteira) tenta de novo.
 */
export function comDeteccaoDoCalendario(
  repositorio: RepositorioAcompanhamentos,
  calendario: ServicoCalendario,
  logger: Logger,
): RepositorioAcompanhamentos {
  const log = logger.child({ componente: 'ingestao-calendario' });

  // Cada método da porta é repassado ligado ao original; só um muda.
  return {
    acompanhar: repositorio.acompanhar.bind(repositorio),
    deixarDeAcompanhar: repositorio.deixarDeAcompanhar.bind(repositorio),
    rotular: repositorio.rotular.bind(repositorio),
    marcarCumprido: repositorio.marcarCumprido.bind(repositorio),
    desfazerCumprido: repositorio.desfazerCumprido.bind(repositorio),
    clientes: repositorio.clientes.bind(repositorio),
    buscar: repositorio.buscar.bind(repositorio),
    listar: repositorio.listar.bind(repositorio),
    listarParaSincronizar: repositorio.listarParaSincronizar.bind(repositorio),
    registrarFalha: repositorio.registrarFalha.bind(repositorio),
    listarNovidades: repositorio.listarNovidades.bind(repositorio),
    contarNaoVistas: repositorio.contarNaoVistas.bind(repositorio),
    contarAcompanhamentos: repositorio.contarAcompanhamentos.bind(repositorio),
    marcarComoVistas: repositorio.marcarComoVistas.bind(repositorio),
    facetas: repositorio.facetas.bind(repositorio),
    async registrarSincronizacao(
      workspace: string,
      numero: string,
      processo: Processo,
      novidades: readonly Movimentacao[],
    ): Promise<void> {
      await repositorio.registrarSincronizacao(workspace, numero, processo, novidades);
      try {
        await calendario.processarProcesso(workspace, processo);
      } catch (erro) {
        log.warn('detecção do calendário falhou; a sincronização segue', {
          numero,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      }
    },
  };
}
