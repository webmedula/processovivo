import type { FonteDaAnaliseDoProcesso } from './ServicoAnaliseDoProcesso.js';
import type { ServicoPasta } from './ServicoPasta.js';

/**
 * A Pasta digital vista pela análise do processo (v0.66.0). Três verbos, os mesmos que o envio ao Drive
 * usa: ler a listagem GRAVADA (nunca o tribunal), pedir uma peça pelo caminho do clique da Pasta
 * (`ServicoPasta.solicitar`: debounce, fila, pausa de 3 s, disjuntor) e perguntar como ela está (só banco).
 */
export function fonteDaAnaliseDoProcesso(pasta: ServicoPasta): FonteDaAnaliseDoProcesso {
  return {
    async listar(workspace, numero) {
      const v = await pasta.visao(workspace, numero);
      if (!v.listagem) return undefined;
      const sigiloso = v.listagem.processoSigiloso;
      return {
        tribunal: v.listagem.tribunal,
        processoSigiloso: sigiloso,
        pecas: v.pecas.map((p) => ({
          pecaId: p.pecaId,
          rotulo: p.rotulo,
          data: p.data,
          sigilosa: sigiloso || p.estado === 'sigilo',
          emGuarda: p.estado === 'disponivel',
        })),
      };
    },
    async solicitar(workspace, numero, pecaId) {
      await pasta.solicitar(workspace, numero, pecaId);
    },
    async estado(workspace, numero, pecaId) {
      const e = await pasta.estadoDaPeca(workspace, numero, pecaId);
      return e?.estado ?? 'sigilo';
    },
  };
}
