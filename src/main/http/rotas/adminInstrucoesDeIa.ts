import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { LIMITE_DA_INSTRUCAO } from '../../../domain/entities/InstrucoesDeIa.js';
import type { ServicoErrosDeInstrucoes } from '../../../application/services/ServicoErrosDeInstrucoes.js';
import type {
  CasoDoExperimento,
  ServicoExperimentoDeInstrucoes,
} from '../../../application/services/ServicoExperimentoDeInstrucoes.js';
import type { ServicoInstrucoesDeIa } from '../../../application/services/ServicoInstrucoesDeIa.js';
import type { ServicoVerificacaoDeInstrucoes } from '../../../application/services/ServicoVerificacaoDeInstrucoes.js';
import { recusarInstrucao } from '../../../application/services/ServicoInstrucoesDeIa.js';
import {
  experimentoParaJson,
  instrucoesParaJson,
  processoDaListaParaJson,
  verificacaoParaJson,
} from './instrucoesDeIaJson.js';

/** Instruções de interpretação editáveis, experimento e conjunto de verificação (Fase C, v0.61.0). */
export const ROTA_ADMIN_IA_INSTRUCOES = '/admin/api/ia/instrucoes';
export const ROTA_ADMIN_IA_INSTRUCOES_RASCUNHO =
  '/admin/api/ia/instrucoes/:funcao/rascunho';
export const ROTA_ADMIN_IA_INSTRUCOES_PREVIA = '/admin/api/ia/instrucoes/:funcao/previa';
export const ROTA_ADMIN_IA_INSTRUCOES_VERSAO =
  '/admin/api/ia/instrucoes/:funcao/versoes/:versao';
export const ROTA_ADMIN_IA_INSTRUCOES_DIFF = '/admin/api/ia/instrucoes/:funcao/diff';
export const ROTA_ADMIN_IA_INSTRUCOES_PUBLICAR =
  '/admin/api/ia/instrucoes/:funcao/publicar';
export const ROTA_ADMIN_IA_INSTRUCOES_REVERTER =
  '/admin/api/ia/instrucoes/:funcao/reverter';
export const ROTA_ADMIN_IA_INSTRUCOES_ERROS = '/admin/api/ia/instrucoes/:funcao/erros';
export const ROTA_ADMIN_IA_INSTRUCOES_EXPERIMENTAR =
  '/admin/api/ia/instrucoes/:funcao/experimentar';
export const ROTA_ADMIN_IA_EXPERIMENTO_PROCESSOS = '/admin/api/ia/experimento/processos';
export const ROTA_ADMIN_IA_EXPERIMENTO_ATOS =
  '/admin/api/ia/experimento/processos/:numero/atos';
export const ROTA_ADMIN_IA_EXPERIMENTO_PECAS =
  '/admin/api/ia/experimento/processos/:numero/pecas';
export const ROTA_ADMIN_IA_VERIFICACAO_ESTIMATIVA =
  '/admin/api/ia/instrucoes/:funcao/verificacao/estimativa';
export const ROTA_ADMIN_IA_VERIFICACAO = '/admin/api/ia/instrucoes/:funcao/verificacao';
export const ROTA_ADMIN_IA_VERIFICACAO_CONSULTA = '/admin/api/ia/verificacoes/:id';
export const ROTA_ADMIN_IA_VERIFICACAO_CANCELAR =
  '/admin/api/ia/verificacoes/:id/cancelar';

export const ROTAS_ADMIN_INSTRUCOES: readonly string[] = [
  ROTA_ADMIN_IA_INSTRUCOES,
  ROTA_ADMIN_IA_INSTRUCOES_RASCUNHO,
  ROTA_ADMIN_IA_INSTRUCOES_PREVIA,
  ROTA_ADMIN_IA_INSTRUCOES_VERSAO,
  ROTA_ADMIN_IA_INSTRUCOES_DIFF,
  ROTA_ADMIN_IA_INSTRUCOES_PUBLICAR,
  ROTA_ADMIN_IA_INSTRUCOES_REVERTER,
  ROTA_ADMIN_IA_INSTRUCOES_ERROS,
  ROTA_ADMIN_IA_INSTRUCOES_EXPERIMENTAR,
  ROTA_ADMIN_IA_EXPERIMENTO_PROCESSOS,
  ROTA_ADMIN_IA_EXPERIMENTO_ATOS,
  ROTA_ADMIN_IA_EXPERIMENTO_PECAS,
  ROTA_ADMIN_IA_VERIFICACAO_ESTIMATIVA,
  ROTA_ADMIN_IA_VERIFICACAO,
  ROTA_ADMIN_IA_VERIFICACAO_CONSULTA,
  ROTA_ADMIN_IA_VERIFICACAO_CANCELAR,
];

// O limite de tamanho NÃO é validado aqui (o Zod só confere a forma): a recusa por tamanho é do serviço, que responde
// 422 com o motivo `texto_grande` e a frase nossa. O teto de 8× é só para o corpo da requisição não crescer sem fim.
const TETO_DO_CORPO = LIMITE_DA_INSTRUCAO * 8;
const corpoDoRascunho = z
  .object({
    texto: z.string().max(TETO_DO_CORPO),
    observacao: z.string().max(1000).optional(),
  })
  .strict();
const corpoDaPrevia = z.object({ texto: z.string().max(TETO_DO_CORPO) }).strict();
const corpoDaPublicacao = z
  .object({ versao: z.number().int().min(1), confirmado: z.boolean().optional() })
  .strict();
const corpoDaReversao = z.object({ confirmado: z.boolean().optional() }).strict();
const corpoDoExperimento = z
  .object({
    numero: z.string().trim().min(1).max(40),
    chaveDoAto: z.string().min(1).max(500).optional(),
    pecaId: z.string().min(1).max(200).optional(),
    texto: z.string().max(TETO_DO_CORPO).optional(),
  })
  .strict();
const corpoDaEstimativa = z
  .object({ texto: z.string().max(TETO_DO_CORPO).optional() })
  .strict();
const corpoDaVerificacao = z
  .object({
    texto: z.string().max(TETO_DO_CORPO).optional(),
    confirmado: z.boolean().optional(),
  })
  .strict();
const consultaDoDiff = z.object({
  de: z.coerce.number().int(),
  para: z.coerce.number().int(),
});

export interface OpcoesRotasInstrucoes {
  readonly autor: string;
  readonly instrucoes: ServicoInstrucoesDeIa;
  readonly experimento: ServicoExperimentoDeInstrucoes;
  readonly verificacao: ServicoVerificacaoDeInstrucoes;
  readonly erros: ServicoErrosDeInstrucoes;
}

/**
 * Só o operador do /admin chega aqui (o hook de Basic Auth vale para todo o plugin; sessão de assinante e chave
 * de API recebem 401). As respostas nunca saem em cache. Salvar, publicar, reverter, experimentar e verificar
 * recusam com `InstrucaoDeIaRecusadaError` (motivo + frase nossa, que não repete o texto recebido).
 */
export function rotasDeInstrucoesDeIa(
  servidor: FastifyInstance,
  o: OpcoesRotasInstrucoes | undefined,
  semPainel: (resposta: FastifyReply) => { erro: string; mensagem: string },
): void {
  const semCache = (resposta: FastifyReply): void => {
    void resposta.header('cache-control', 'no-store');
  };

  servidor.get(ROTA_ADMIN_IA_INSTRUCOES, async (_req, resposta) => {
    if (!o) return semPainel(resposta);
    semCache(resposta);
    return instrucoesParaJson(o.instrucoes, o.experimento, o.verificacao);
  });

  servidor.put<{ Params: { funcao: string }; Body: unknown }>(
    ROTA_ADMIN_IA_INSTRUCOES_RASCUNHO,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      const c = corpoDoRascunho.parse(req.body);
      o.instrucoes.salvarRascunho(
        o.autor,
        req.params.funcao,
        c.texto,
        c.observacao ?? '',
      );
      semCache(resposta);
      return instrucoesParaJson(o.instrucoes, o.experimento, o.verificacao);
    },
  );

  servidor.post<{ Params: { funcao: string }; Body: unknown }>(
    ROTA_ADMIN_IA_INSTRUCOES_PREVIA,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      const c = corpoDaPrevia.parse(req.body);
      semCache(resposta);
      return o.instrucoes.previa(req.params.funcao, c.texto);
    },
  );

  servidor.get<{ Params: { funcao: string; versao: string } }>(
    ROTA_ADMIN_IA_INSTRUCOES_VERSAO,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      semCache(resposta);
      const n = Number(req.params.versao);
      if (!Number.isInteger(n) || n < 0) throw recusarInstrucao('versao_inexistente');
      return o.instrucoes.textoDaVersao(req.params.funcao, n);
    },
  );

  servidor.get<{ Params: { funcao: string }; Querystring: unknown }>(
    ROTA_ADMIN_IA_INSTRUCOES_DIFF,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      semCache(resposta);
      const q = consultaDoDiff.safeParse(req.query ?? {});
      if (!q.success) throw recusarInstrucao('versoes_invalidas');
      return o.instrucoes.diferenca(req.params.funcao, q.data.de, q.data.para);
    },
  );

  servidor.post<{ Params: { funcao: string }; Body: unknown }>(
    ROTA_ADMIN_IA_INSTRUCOES_PUBLICAR,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      const c = corpoDaPublicacao.parse(req.body);
      o.instrucoes.publicar(o.autor, req.params.funcao, {
        versao: c.versao,
        confirmado: c.confirmado === true,
      });
      semCache(resposta);
      return instrucoesParaJson(o.instrucoes, o.experimento, o.verificacao);
    },
  );

  servidor.post<{ Params: { funcao: string }; Body: unknown }>(
    ROTA_ADMIN_IA_INSTRUCOES_REVERTER,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      const c = corpoDaReversao.parse(req.body);
      o.instrucoes.reverter(o.autor, req.params.funcao, c.confirmado === true);
      semCache(resposta);
      return instrucoesParaJson(o.instrucoes, o.experimento, o.verificacao);
    },
  );

  servidor.get<{ Params: { funcao: string } }>(
    ROTA_ADMIN_IA_INSTRUCOES_ERROS,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      semCache(resposta);
      return o.erros.consultar(req.params.funcao);
    },
  );

  // --- experimento sobre um caso real da conta do operador --------------------------------------------------------
  servidor.get(ROTA_ADMIN_IA_EXPERIMENTO_PROCESSOS, async (_req, resposta) => {
    if (!o) return semPainel(resposta);
    semCache(resposta);
    return { processos: (await o.experimento.processos()).map(processoDaListaParaJson) };
  });

  servidor.get<{ Params: { numero: string } }>(
    ROTA_ADMIN_IA_EXPERIMENTO_ATOS,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      semCache(resposta);
      const r = await o.experimento.atos(req.params.numero);
      return {
        sigiloso: r.sigiloso,
        atos: r.atos.map((a) => ({
          chaveDoAto: a.chaveDoAto,
          data: a.data.toISOString(),
          titulo: a.titulo,
          tipoComunicacao: a.tipoComunicacao,
          legivel: a.legivel,
        })),
      };
    },
  );

  servidor.get<{ Params: { numero: string } }>(
    ROTA_ADMIN_IA_EXPERIMENTO_PECAS,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      semCache(resposta);
      const r = await o.experimento.pecas(req.params.numero);
      return {
        sigiloso: r.sigiloso,
        pecas: r.pecas.map((p) => ({
          pecaId: p.pecaId,
          rotulo: p.rotulo,
          data: p.data ? p.data.toISOString() : null,
          paginas: p.paginas,
        })),
      };
    },
  );

  servidor.post<{ Params: { funcao: string }; Body: unknown }>(
    ROTA_ADMIN_IA_INSTRUCOES_EXPERIMENTAR,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      const c = corpoDoExperimento.parse(req.body);
      const f = req.params.funcao;
      if (f !== 'ato' && f !== 'resumo' && f !== 'peca')
        throw recusarInstrucao('funcao_desconhecida');
      const caso: CasoDoExperimento =
        f === 'ato'
          ? { funcao: 'ato', numero: c.numero, chaveDoAto: c.chaveDoAto ?? '' }
          : f === 'peca'
            ? { funcao: 'peca', numero: c.numero, pecaId: c.pecaId ?? '' }
            : { funcao: 'resumo', numero: c.numero };
      // Se a pessoa fechar a aba, a chamada ao modelo é abortada junto.
      const aborto = new AbortController();
      req.raw.once('close', () => {
        if (!resposta.raw.writableEnded) aborto.abort();
      });
      const r = await o.experimento.experimentar(caso, c.texto, aborto.signal);
      semCache(resposta);
      return experimentoParaJson(r);
    },
  );

  // --- conjunto de verificação (opcional, nunca bloqueia) ---------------------------------------------------------
  servidor.post<{ Params: { funcao: string }; Body: unknown }>(
    ROTA_ADMIN_IA_VERIFICACAO_ESTIMATIVA,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      const c = corpoDaEstimativa.parse(req.body ?? {});
      semCache(resposta);
      return o.verificacao.estimar(req.params.funcao, c.texto);
    },
  );

  servidor.post<{ Params: { funcao: string }; Body: unknown }>(
    ROTA_ADMIN_IA_VERIFICACAO,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      const c = corpoDaVerificacao.parse(req.body ?? {});
      const t = o.verificacao.iniciar(
        o.autor,
        req.params.funcao,
        c.texto,
        c.confirmado === true,
      );
      void resposta.code(202);
      semCache(resposta);
      return verificacaoParaJson(t);
    },
  );

  servidor.get<{ Params: { id: string } }>(
    ROTA_ADMIN_IA_VERIFICACAO_CONSULTA,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      semCache(resposta);
      return verificacaoParaJson(o.verificacao.consultar(req.params.id));
    },
  );

  servidor.post<{ Params: { id: string } }>(
    ROTA_ADMIN_IA_VERIFICACAO_CANCELAR,
    async (req, resposta) => {
      if (!o) return semPainel(resposta);
      semCache(resposta);
      return verificacaoParaJson(o.verificacao.cancelar(req.params.id));
    },
  );
}
