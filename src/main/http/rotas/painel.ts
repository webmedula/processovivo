import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ServicoAcompanhamento } from '../../../application/services/ServicoAcompanhamento.js';
import type { ServicoPecas } from '../../../application/services/ServicoPecas.js';
import { WorkspaceNaoResolvidoError } from '../../../domain/errors/index.js';
import { estadoDaVerificacaoJson } from './acompanhamentos.js';
import { estadoDaPasta } from '../../../domain/entities/estadoDaPasta.js';

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

/**
 * Tudo o que a tela inicial precisa, numa chamada só.
 *
 * Rota própria em vez de encher `/v1/novidades`: os números do painel vêm de
 * três serviços diferentes, e montá-los no cliente seria três requisições em
 * sequência para desenhar a primeira tela que o assinante vê.
 *
 * **Nenhum número aqui é inventado.** A referência visual que originou esta
 * tela trazia "Prazos em 48h" e "Peças baixadas hoje"; o segundo passou a
 * existir com o registro de downloads, e o primeiro não existe — não há prazo
 * cadastrado em lugar nenhum do sistema. O que temos perto disso é "pastas que
 * pedem providência", que é o ato que ABRE um prazo, não o prazo. São coisas
 * diferentes e o nome do card diz qual das duas é.
 */
export function rotasDoPainel(
  acompanhamento: ServicoAcompanhamento,
  pecas: ServicoPecas | undefined,
  pendenciaJanelaDias: number,
): FastifyPluginAsync {
  return async (servidor) => {
    servidor.get('/v1/painel', async (req) => {
      const ws = workspaceDe(req);
      const agora = new Date();
      const inicioDoDia = new Date(agora);
      inicioDoDia.setHours(0, 0, 0, 0);

      /*
       * Uma passada só sobre a carteira, e ela é a mesma consulta que a tela de
       * processos faz. Custa desserializar o retrato de cada pasta — aceitável
       * nas ordens de grandeza de um escritório, e o dia em que doer a saída é
       * desnormalizar o estado numa coluna, não espalhar três consultas aqui.
       */
      const [carteira, baixadas, baixadasHoje] = await Promise.all([
        acompanhamento.listar(ws),
        pecas ? pecas.historicoDeBaixas(ws, { limite: 6 }) : Promise.resolve([]),
        pecas ? pecas.baixadasDesde(ws, inicioDoDia) : Promise.resolve(0),
      ]);

      let ativos = 0;
      let pedemProvidencia = 0;
      let naoVerificados = 0;
      let ultimaVerificacao: Date | undefined;

      for (const a of carteira) {
        const e = estadoDaPasta(
          {
            ...(a.erro !== undefined ? { erro: a.erro } : {}),
            ...(a.sincronizadoEm !== undefined
              ? { sincronizadoEm: a.sincronizadoEm }
              : {}),
            novidadesNaoVistas: a.novidadesNaoVistas,
            ...(a.processo ? { movimentacoes: a.processo.movimentacoes } : {}),
            ...(a.cumprido ? { cumprido: a.cumprido } : {}),
          },
          agora,
          pendenciaJanelaDias,
        );
        if (e.rotulo !== 'ARQUIVADO') ativos += 1;
        if (e.rotulo === 'PROVIDENCIA') pedemProvidencia += 1;
        if (e.naoVerificado) naoVerificados += 1;
        if (
          a.sincronizadoEm &&
          (!ultimaVerificacao || a.sincronizadoEm > ultimaVerificacao)
        ) {
          ultimaVerificacao = a.sincronizadoEm;
        }
      }

      return {
        agora: agora.toISOString(),
        /*
         * Quando a carteira foi vista pela última vez, e quantas pastas estão
         * com a verificação falhando.
         *
         * É o número que decide se dá para confiar na tela, e vem ANTES dos
         * cards de propósito: a mesma razão que obriga o `ServicoNotificacao` a
         * avisar quando NÃO conseguiu verificar. Silêncio só significa "nada
         * aconteceu" enquanto a verificação estiver de pé.
         */
        verificacao: {
          ultimaEm: ultimaVerificacao?.toISOString() ?? null,
          naoVerificados,
          // Por CONTA (v0.37.3): a varredura dos outros assinantes não é desta tela.
          ...estadoDaVerificacaoJson(acompanhamento.estadoDa(ws)),
        },
        cards: {
          ativos,
          totalPastas: carteira.length,
          pedemProvidencia,
          // A mesma janela do selo da carteira: o card diz de quantos dias é.
          pendenciaJanelaDias,
          baixadasHoje,
        },
        pecasBaixadas: baixadas.map((p) => ({
          numero: p.numeroProcesso,
          idPeca: p.idPeca,
          rotulo: p.rotulo,
          mimetype: p.mimetype ?? null,
          bytes: p.bytes,
          baixadaEm: p.baixadaEm.toISOString(),
        })),
      };
    });
  };
}
