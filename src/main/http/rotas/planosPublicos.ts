import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ServicoPlanos } from '../../../application/services/ServicoPlanos.js';
import { motivoDeNaoContratar } from '../../../application/services/ServicoPagamentos.js';
import {
  cicloDoPlano,
  descricaoDoRecurso,
  planoInclui,
  valorDoCicloEmCentavos,
} from '../../../domain/entities/Plano.js';
import type { Plano } from '../../../domain/entities/Plano.js';

/** Pública para o plugin de autenticação: a vitrine do site de vendas, sem conta nem chave. */
export const ROTA_PLANOS_PUBLICOS = '/v1/planos';

/** Folgado para a vitrine (o site cacheia por 60 s e o navegador também), mas tem teto: é rota aberta. */
const LIMITE_POR_MINUTO = 120;
const CACHE_EM_SEGUNDOS = 60;

export interface PlanoDaVitrine {
  readonly slug: string;
  readonly nome: string;
  readonly resumo: string;
  readonly recursos: readonly string[];
  /** O valor de UMA cobrança no ciclo; `null` = sem preço publicado (o site não mostra valor inventado). */
  readonly preco: { readonly valorCentavos: number; readonly ciclo: string } | null;
  /** O plano pode ser contratado agora (à venda, ciclo vendável, com preço). O site ainda confere `pagamentoDisponivel`. */
  readonly assinavel: boolean;
  /** v0.50.0: o plano inclui a análise com IA — o site destaca, e avisa que o teste grátis não a inclui. */
  readonly incluiAnaliseIa: boolean;
}

/** Só o que o site pode mostrar. Nenhum id de banco, contagem, ordem interna ou configuração. */
export function planoParaVitrine(p: Plano): PlanoDaVitrine {
  const valor = valorDoCicloEmCentavos(p);
  return {
    slug: p.codigo,
    nome: p.nome,
    resumo: p.resumo,
    recursos: p.recursos.map((r) => descricaoDoRecurso(r).nome),
    preco: valor === null ? null : { valorCentavos: valor, ciclo: cicloDoPlano(p) },
    assinavel: motivoDeNaoContratar(p) === undefined,
    incluiAnaliseIa: planoInclui(p, 'analiseIa'),
  };
}

/**
 * `GET /v1/planos`: a vitrine pública (v0.45.0). Só planos À VENDA, só dados que o site já mostraria.
 *
 * - **CORS à mão e só aqui.** `CORS_ORIGINS` (global) abriria a API inteira; esta rota libera UMA
 *   origem, a do site (`PROCESSOVIVO_SITE_URL`), só para `GET`, sem credenciais. Sem a variável não há
 *   cabeçalho nenhum. `Vary: Origin` sempre, para um cache no meio nunca servir o cabeçalho de uma
 *   origem a outra.
 * - **Cache de 60 s** e balde de limite de taxa PRÓPRIO por IP (não gasta nem divide a cota das rotas
 *   autenticadas).
 * - `pagamentoDisponivel` é `false` com a cobrança desligada: o site mostra só o teste grátis.
 */
export function rotasDePlanosPublicos(
  planos: ServicoPlanos,
  extras: { readonly pagamentoDisponivel: boolean; readonly siteUrl: string },
): FastifyPluginAsync {
  return async (servidor) => {
    servidor.get(
      ROTA_PLANOS_PUBLICOS,
      {
        config: {
          rateLimit: {
            max: LIMITE_POR_MINUTO,
            timeWindow: 60_000,
            keyGenerator: (req: FastifyRequest) => `planos:${req.ip}`,
          },
        },
      },
      async (req, resposta) => {
        void resposta.header('vary', 'Origin');
        void resposta.header('cache-control', `public, max-age=${CACHE_EM_SEGUNDOS}`);
        if (extras.siteUrl !== '' && req.headers.origin === extras.siteUrl) {
          void resposta.header('access-control-allow-origin', extras.siteUrl);
          void resposta.header('access-control-allow-methods', 'GET');
        }
        const aVenda = await planos.aVenda();
        return {
          pagamentoDisponivel: extras.pagamentoDisponivel,
          planos: aVenda.map(planoParaVitrine),
        };
      },
    );
  };
}
