import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ServicoAssinaturas } from '../../../application/services/ServicoAssinaturas.js';
import type { ServicoPagamentos } from '../../../application/services/ServicoPagamentos.js';
import { motivoDeNaoContratar } from '../../../application/services/ServicoPagamentos.js';
import type { ServicoPlanos } from '../../../application/services/ServicoPlanos.js';
import { cicloDoPlano, valorDoCicloEmCentavos } from '../../../domain/entities/Plano.js';
import type { Plano } from '../../../domain/entities/Plano.js';
import { WorkspaceNaoResolvidoError } from '../../../domain/errors/index.js';

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

/**
 * O que o assinante pode ver sobre o próprio plano.
 *
 * **Não há rota para o ASSINANTE mudar de plano.** A liberação é manual,
 * depois do Pix, pelo CLI ou pela área administrativa (`rotasDeAdmin`) — que
 * tem autenticação própria, à parte desta. Uma rota de troca aqui exigiria um
 * papel de administrador dentro da conta do assinante, e inventar
 * "administrador" como um campo booleano na tabela de usuários é como se
 * constrói, sem perceber, uma escalada de privilégio numa API que já é pública
 * para cadastro.
 */
export function rotasDeAssinaturas(
  servico: ServicoAssinaturas,
  planos: ServicoPlanos,
  extras: {
    /** Cobrança recorrente (v0.44.0); `undefined` = desligada. */
    readonly pagamentos?: ServicoPagamentos | undefined;
    /** Endereço dos Termos de Uso, se houver (`PROCESSOVIVO_TERMOS_URL`). */
    readonly urlDosTermos?: string;
  } = {},
): FastifyPluginAsync {
  return async (servidor) => {
    servidor.get('/v1/assinatura', async (req) => {
      const ws = workspaceDe(req);
      const [resumo, aVenda, pagamento] = await Promise.all([
        servico.resumo(ws),
        planos.aVenda(),
        extras.pagamentos?.visaoDe(ws),
      ]);

      // Sem assinatura NÃO é erro: é o caso das chaves de API, que nunca terão
      // uma. Devolver 404 faria a interface mostrar falha onde não há.
      return {
        assinatura: resumo ?? null,
        // Aditivo: o que já existia segue igual; `ciclo`, `valorDoCicloCentavos` e `contratavel` são
        // novos. `contratavel` é a MESMA regra da rota de checkout (plano sem preço não contrata).
        planos: aVenda.map((p) => planoParaJson(p, pagamento !== undefined)),
        pagamento: pagamento
          ? {
              ...pagamento,
              urlDosTermos: extras.urlDosTermos ? extras.urlDosTermos : null,
            }
          : { habilitado: false },
      };
    });
  };
}

function planoParaJson(p: Plano, comPagamento: boolean): Record<string, unknown> {
  return {
    ...p,
    ciclo: cicloDoPlano(p),
    valorDoCicloCentavos: valorDoCicloEmCentavos(p),
    contratavel: comPagamento && motivoDeNaoContratar(p) === undefined,
  };
}
