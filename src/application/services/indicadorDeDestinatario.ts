import { calcularParaOUsuario } from '../../domain/entities/destinatarioDaComunicacao.js';
import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import type { Processo } from '../../domain/entities/Processo.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { OabsDoWorkspace } from '../../domain/ports/OabsDoWorkspace.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';

/**
 * O ponto ÚNICO onde "para quem é esta comunicação" é calculado (v0.37.6).
 *
 * Mesmo desenho de `comDeteccaoDoCalendario`: toda gravação de retrato passa por
 * `registrarSincronizacao` (varredura, "acompanhar", as três da vigilância), e
 * embrulhar a porta cobre todas. Aqui, e só aqui, as inscrições de advogado que o
 * mapper do DJEN deixou em memória (`destinatariosOab`) são comparadas com as
 * OABs do workspace e trocadas por `paraOUsuario` — `sim`, `nao` ou
 * `desconhecido`. Nome e inscrição de terceiros NÃO chegam ao repositório.
 *
 * Migração sem retrocarga, de propósito: a comunicação já gravada não tem as
 * inscrições (só o DJEN as informa, e consultá-lo sem a sincronização seguir seu
 * curso não é o que esta camada faz). Fica `desconhecido` até a próxima
 * sincronização que a traga de novo; enquanto isso, o valor já conhecido de uma
 * sincronização anterior é mantido — uma resposta sem as inscrições (cache velho,
 * fonte que respondeu só com o DataJud) não apaga o que já se sabia.
 *
 * Nunca derruba a sincronização: se a leitura das OABs falhar, o retrato é
 * gravado sem o indicador (e sem as inscrições) e o erro vai para o log.
 */
export function comIndicadorDeDestinatario(
  repositorio: RepositorioAcompanhamentos,
  oabs: OabsDoWorkspace,
  logger: Logger,
): RepositorioAcompanhamentos {
  const log = logger.child({ componente: 'indicador-de-destinatario' });

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
      let gravar = processo;
      try {
        const conjunto = await oabs.chaves(workspace);
        const anterior = await repositorio.buscar(workspace, numero);
        gravar = comIndicador(processo, conjunto, anterior?.processo);
      } catch (erro) {
        log.warn('indicador de destinatário falhou; o retrato segue sem ele', {
          numero,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
        gravar = semInscricoes(processo);
      }
      await repositorio.registrarSincronizacao(workspace, numero, gravar, novidades);
    },
  };
}

function comIndicador(
  processo: Processo,
  oabs: ReadonlySet<string>,
  anterior: Processo | undefined,
): Processo {
  const conhecido = new Map<string, NonNullable<Movimentacao['paraOUsuario']>>();
  for (const m of anterior?.movimentacoes ?? []) {
    if (m.idExterno && m.paraOUsuario && m.paraOUsuario !== 'desconhecido') {
      conhecido.set(m.idExterno, m.paraOUsuario);
    }
  }

  const movimentacoes = processo.movimentacoes.map((m): Movimentacao => {
    const { destinatariosOab, ...resto } = m;
    // Só a comunicação do DJEN tem destinatário; o resto do retrato não se toca.
    if (m.tipoComunicacao === undefined) return resto;

    const calculado =
      destinatariosOab !== undefined
        ? calcularParaOUsuario(destinatariosOab, oabs)
        : undefined;
    const herdado = m.idExterno ? conhecido.get(m.idExterno) : undefined;
    // Cálculo novo vence; sem inscrições na resposta, vale o que já se sabia.
    const valor =
      calculado !== undefined && calculado !== 'desconhecido'
        ? calculado
        : (herdado ?? calculado ?? m.paraOUsuario);
    if (valor === undefined) return resto;

    if (valor === 'nao') {
      // O `exigeAcao` gravado pode ter nascido da cláusula da intimação: sai, e a
      // triagem recalcula sem ela na construção do `Processo`.
      const { exigeAcao: _recalcular, ...semFlag } = resto;
      return { ...semFlag, paraOUsuario: valor };
    }
    return { ...resto, paraOUsuario: valor };
  });
  return processo.comAlteracoes({ movimentacoes });
}

function semInscricoes(processo: Processo): Processo {
  return processo.comAlteracoes({
    movimentacoes: processo.movimentacoes.map((m) => {
      const { destinatariosOab: _transitorio, ...resto } = m;
      return resto;
    }),
  });
}
