import type { ArmazemDoLeitor } from '../../domain/ports/ArmazemDoLeitor.js';
import { ListagemDaPastaAusenteError } from '../../domain/errors/index.js';
import type { GuardaDePecas } from './GuardaDePecas.js';
import type { ServicoPasta } from './ServicoPasta.js';
import type { FonteDePecasParaODrive } from './ServicoDrive.js';

/**
 * A Pasta digital vista pelo envio ao Drive (v0.42.0).
 *
 * É o ÚNICO ponto em que o Drive toca a guarda e a Pasta, e só por quatro verbos: listar o que
 * está gravado, ler uma peça já em guarda, pedir uma peça pelo mesmo caminho do clique da Pasta
 * e perguntar como ela está. Nada daqui consulta o tribunal por conta própria: `solicitar` é o
 * `ServicoPasta.solicitar` de sempre (debounce, fila, pausa de 3 s, disjuntor), e só roda porque
 * o advogado clicou "Salvar no Drive" numa peça que saiu da guarda.
 *
 * Localizador de arquivo, caminho em disco e conteúdo nunca saem daqui para o serviço — ele
 * recebe o conteúdo como leitor em pedaços.
 */
export function fonteDePecasDaPasta(deps: {
  readonly pasta: ServicoPasta;
  readonly guarda: GuardaDePecas;
  readonly armazem: ArmazemDoLeitor;
}): FonteDePecasParaODrive {
  const { pasta, guarda, armazem } = deps;
  return {
    async listar(workspace, numero) {
      const v = await pasta.visao(workspace, numero);
      if (!v.listagem) throw new ListagemDaPastaAusenteError(numero);
      return {
        processoSigiloso: v.listagem.processoSigiloso,
        pecas: v.pecas.map((p) => ({
          pecaId: p.pecaId,
          ordem: p.ordem,
          rotulo: p.rotulo,
          data: p.data,
          // O número que a Pasta mostra. Em faixa não há um só: usa-se a posição do ato.
          numeroDoAto:
            p.numeroNoProjudi === undefined
              ? undefined
              : p.numeroNoProjudi.tipo === 'faixa'
                ? p.movimentacao?.posicao
                : p.numeroNoProjudi.n,
          sigilosa: p.estado === 'sigilo' || v.listagem?.processoSigiloso === true,
        })),
      };
    },

    async emGuarda(workspace, numero, pecaId) {
      const entrada = await guarda.obter(workspace, numero, pecaId);
      if (!entrada) return undefined;
      return {
        tamanho: entrada.bytes,
        conversao: entrada.conversao,
        observacao: entrada.observacao,
        ler: (inicio, fim) => armazem.ler(workspace, entrada.localizador, inicio, fim),
      };
    },

    async solicitar(workspace, numero, pecaId) {
      await pasta.solicitar(workspace, numero, pecaId);
    },

    async estado(workspace, numero, pecaId) {
      const e = await pasta.estadoDaPeca(workspace, numero, pecaId);
      return { estado: e?.estado ?? 'sigilo', retomarEm: e?.retomarEm };
    },
  };
}
