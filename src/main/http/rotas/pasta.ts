import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServicoAssinaturas } from '../../../application/services/ServicoAssinaturas.js';
import type {
  EstimativaDeBusca,
  ServicoPasta,
  VisaoDaCalibracao,
  VisaoDaPasta,
  VisaoDaPeca,
} from '../../../application/services/ServicoPasta.js';
import {
  OperacaoNaoSuportadaError,
  WorkspaceNaoResolvidoError,
} from '../../../domain/errors/index.js';
import { servirPdf, visaoDoJob } from './leitor.js';

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

/** Um processo real medido tem 279 peças; o teto existe para um corpo malicioso. */
const MAX_PECAS = 5000;

const corpoSelecao = z.object({
  pecas: z.array(z.string().min(1).max(100)).min(1).max(MAX_PECAS),
});

/*
 * `posicao` ausente = o último ato recebido (o atalho "último número que você vê
 * no Projudi"). Zod só confere o formato; o que o número significa (maior ou
 * igual à posição, compatível com os outros) é regra do domínio.
 */
const corpoCalibracao = z.object({
  numeroProjudi: z.number().int().positive().max(1_000_000),
  posicao: z.number().int().positive().max(1_000_000).optional(),
});

const paramsPosicao = z.object({
  numero: z.string(),
  posicao: z.coerce.number().int().positive().max(1_000_000),
});

type ParamsPeca = { numero: string; pecaId: string };

/**
 * Rotas da Pasta digital (v0.33.0).
 *
 * Sem `try/catch`: peça de outro workspace, listagem ausente, peça sigilosa,
 * cota — tudo é erro de domínio, e o `errorHandler` traduz.
 *
 * Ajustes em relação ao que a especificação sugeria (seção 10), todos
 * acrescentos: `POST …/baixar/previa` (a pergunta "quantas peças serão buscadas?"
 * precisa de uma rota que NÃO cria job) e a procedência explícita em toda
 * resposta. O PDF do "Montar pasta completa" e o de "Baixar PDF" saem pelas
 * rotas já existentes do leitor (`/leitor/:jobId`, `/indice`, `/pdf`), porque
 * são jobs do leitor — uma segunda família de rotas para o mesmo arquivo só
 * criaria dois caminhos para manter iguais.
 *
 * Plano: o que CONSULTA o tribunal com a credencial do assinante (pedir peça,
 * montar, baixar) exige o recurso `pecas`; ler o que já está guardado não —
 * como no leitor, trancar a leitura por assinatura vencida seria cobrar para
 * ver o que já se tem.
 */
export function rotasDaPasta(
  servico: ServicoPasta | undefined,
  assinaturas?: ServicoAssinaturas,
): FastifyPluginAsync {
  return async (servidor) => {
    async function exigirPlano(req: FastifyRequest): Promise<void> {
      await assinaturas?.exigir(workspaceDe(req), 'pecas');
    }

    function exigirServico(): ServicoPasta {
      if (!servico) {
        throw new OperacaoNaoSuportadaError(
          'pasta',
          'pastaDigital',
          'a Pasta digital não está configurada — exige o acesso a peças ' +
            '(PROCESSOVIVO_CREDENCIAL_CHAVE) e o qpdf instalado no servidor',
        );
      }
      return servico;
    }

    /*
     * A lista de peças e o estado de cada uma. NÃO consulta o tribunal: junta a
     * listagem que a tela do processo já provocou, a guarda por peça, a fila e
     * os jobs. `listagem: null` = a tela ainda não carregou as peças do
     * processo (GET /v1/processos/:numero/pecas) — não é erro.
     */
    servidor.get<{ Params: { numero: string } }>(
      '/v1/processos/:numero/pasta',
      async (req) => {
        const visao = await exigirServico().visao(workspaceDe(req), req.params.numero);
        return visaoDaPasta(visao);
      },
    );

    /*
     * Calibração do número com o Projudi (v0.35.0). Nenhuma destas rotas toca o
     * tribunal: guardam o que o advogado leu na tela do Projudi. PUT exige o
     * plano da Pasta; limpar o que é dele não — trancar a remoção por assinatura
     * vencida seria deixá-lo preso a um número que ele quer tirar.
     */
    servidor.put<{ Params: { numero: string }; Body: unknown }>(
      '/v1/processos/:numero/pasta/calibracao',
      async (req) => {
        await exigirPlano(req);
        const corpo = corpoCalibracao.parse(req.body ?? {});
        const ws = workspaceDe(req);
        const r =
          corpo.posicao === undefined
            ? await exigirServico().calibrarPeloUltimoNumero(
                ws,
                req.params.numero,
                corpo.numeroProjudi,
              )
            : await exigirServico().calibrar(
                ws,
                req.params.numero,
                corpo.posicao,
                corpo.numeroProjudi,
              );
        return visaoDaCalibracao(r);
      },
    );

    servidor.delete<{ Params: { numero: string } }>(
      '/v1/processos/:numero/pasta/calibracao',
      async (req) =>
        visaoDaCalibracao(
          await exigirServico().limparCalibracao(workspaceDe(req), req.params.numero),
        ),
    );

    servidor.delete<{ Params: { numero: string; posicao: string } }>(
      '/v1/processos/:numero/pasta/calibracao/:posicao',
      async (req) => {
        const { numero, posicao } = paramsPosicao.parse(req.params);
        return visaoDaCalibracao(
          await exigirServico().removerAncora(workspaceDe(req), numero, posicao),
        );
      },
    );

    /*
     * Pede UMA peça. Idempotente. 200 = já está guardada (nenhuma chamada ao
     * tribunal); 202 = entrou na fila — a tela consulta o estado em
     * `GET …/pasta`. Clique em peça diferente antes do despacho troca o pedido
     * pendente: o anterior nunca vai ao tribunal.
     */
    servidor.post<{ Params: ParamsPeca }>(
      '/v1/processos/:numero/pasta/pecas/:pecaId',
      async (req, resposta) => {
        await exigirPlano(req);
        const r = await exigirServico().solicitar(
          workspaceDe(req),
          req.params.numero,
          req.params.pecaId,
        );
        void resposta.code(r.estado === 'disponivel' ? 200 : 202);
        return {
          pecaId: req.params.pecaId,
          estado: r.estado === 'disponivel' ? 'disponivel' : 'na_fila',
          obtidaEm: r.entrada?.obtidaEm.toISOString() ?? null,
          expiraEm: r.entrada?.expiraEm.toISOString() ?? null,
          aoVivo: false,
        };
      },
    );

    // O PDF da peça, com Range, para o PDF.js.
    servidor.get<{ Params: ParamsPeca }>(
      '/v1/processos/:numero/pasta/pecas/:pecaId/arquivo',
      async (req, resposta) => {
        const arquivo = await exigirServico().abrirPeca(
          workspaceDe(req),
          req.params.numero,
          req.params.pecaId,
        );
        void resposta.header('x-processovivo-expira-em', arquivo.expiraEm.toISOString());
        return servirPdf(req, resposta, arquivo);
      },
    );

    servidor.post<{ Params: { numero: string } }>(
      '/v1/processos/:numero/pasta/montar',
      async (req, resposta) => {
        await exigirPlano(req);
        const r = await exigirServico().montar(workspaceDe(req), req.params.numero);
        void resposta.code(r.jaExistia ? 200 : 202);
        return {
          jaExistia: r.jaExistia,
          job: visaoDoJob(r.job),
          estimativa: visaoDaEstimativa(r.estimativa),
        };
      },
    );

    // Quantas peças da seleção irão ao tribunal. Não cria nada.
    servidor.post<{ Params: { numero: string }; Body: unknown }>(
      '/v1/processos/:numero/pasta/baixar/previa',
      async (req) => {
        const { pecas } = corpoSelecao.parse(req.body ?? {});
        const e = await exigirServico().previaDaSelecao(
          workspaceDe(req),
          req.params.numero,
          pecas,
        );
        return visaoDaEstimativa(e);
      },
    );

    servidor.post<{ Params: { numero: string }; Body: unknown }>(
      '/v1/processos/:numero/pasta/baixar',
      async (req, resposta) => {
        await exigirPlano(req);
        const { pecas } = corpoSelecao.parse(req.body ?? {});
        const r = await exigirServico().baixarSelecao(
          workspaceDe(req),
          req.params.numero,
          pecas,
        );
        void resposta.code(202);
        return {
          job: visaoDoJob(r.job),
          estimativa: visaoDaEstimativa(r.estimativa),
        };
      },
    );
  };
}

function visaoDaCalibracao(c: VisaoDaCalibracao): Record<string, unknown> {
  return {
    ancoras: c.ancoras.map((a) => ({
      posicao: a.posicao,
      numeroProjudi: a.numeroProjudi,
      dataHoraDoAto: a.dataHoraDoAto.toISOString(),
      criadaEm: a.criadaEm.toISOString(),
    })),
    atos: c.atos,
    // Âncoras que a última listagem descartou: a tela avisa "calibração anterior
    // invalidada" em vez de sumir com o número em silêncio.
    invalidadas: c.invalidadas,
  };
}

function visaoDaEstimativa(e: EstimativaDeBusca): Record<string, unknown> {
  return {
    total: e.total,
    abuscar: e.abuscar,
    emGuarda: e.emGuarda,
    sigilosas: e.sigilosas,
    minimoSegundos: e.minimoSegundos,
    maximoSegundos: e.maximoSegundos,
    confirmarAcimaDe: e.confirmarAcimaDe,
    exigeConfirmacao: e.exigeConfirmacao,
  };
}

/**
 * O que a pessoa vê. Localizador, caminho em disco e bytes de peça nunca saem
 * daqui — há teste que fixa as chaves. O total SEM filtro vai junto: a tela
 * filtra, e quem filtra diz quantas escondeu.
 */
function visaoDaPasta(v: VisaoDaPasta): Record<string, unknown> {
  const conta = (estado: VisaoDaPeca['estado']): number =>
    v.pecas.filter((p) => p.estado === estado).length;
  return {
    listagem: v.listagem
      ? {
          tribunal: v.listagem.tribunal,
          listadaEm: v.listagem.listadaEm.toISOString(),
          processoSigiloso: v.listagem.processoSigiloso,
        }
      : null,
    // Explícito para nenhuma tela confundir arquivo guardado com consulta.
    procedencia: {
      fonte: 'mni',
      tribunal: v.listagem?.tribunal ?? null,
      listadaEm: v.listagem?.listadaEm.toISOString() ?? null,
      aoVivo: false,
    },
    // Quantos atos o MNI entregou: base do aviso de numeração da tela. null =
    // listagem gravada antes da 0.34.0 (ou sem movimentos na resposta).
    totalAtosRecebidos: v.totalAtosRecebidos ?? null,
    calibracao: v.calibracao ? visaoDaCalibracao(v.calibracao) : null,
    pausadoAte: v.pausadoAte?.toISOString() ?? null,
    totais: {
      pecas: v.pecas.length,
      disponiveis: conta('disponivel'),
      sigilosas: conta('sigilo'),
      naFila: conta('na_fila') + conta('baixando'),
      naoObtidas: conta('nao_obtida'),
      naoBaixadas: conta('nao_baixada'),
    },
    estimativaDaMontagem: v.estimativaDaMontagem
      ? visaoDaEstimativa(v.estimativaDaMontagem)
      : null,
    montagem: v.montagem ? visaoDoJob(v.montagem) : null,
    selecionadas: v.selecionadas ? visaoDoJob(v.selecionadas) : null,
    pecas: v.pecas.map(visaoDaPeca),
  };
}

function visaoDaPeca(p: VisaoDaPeca): Record<string, unknown> {
  return {
    pecaId: p.pecaId,
    ordem: p.ordem,
    rotulo: p.rotulo,
    data: p.data?.toISOString() ?? null,
    movimento: p.movimento ?? null,
    // Texto do tribunal, como está. `posicao` é CALCULADA por nós (ordem dos atos
    // recebidos); o `identificadorMovimento` é a chave interna do vínculo e
    // nunca sai aqui como número.
    movimentacao: p.movimentacao
      ? {
          posicao: p.movimentacao.posicao ?? null,
          // O número do Projudi com o grau de certeza: `posicao` (sem calibração),
          // `exato` (provado pelas âncoras), `faixa` ou `estimado`. Nunca o
          // identificadorMovimento, que continua chave interna.
          numero: p.numeroNoProjudi ?? null,
          data: p.movimentacao.data.toISOString(),
          descricao: p.movimentacao.descricao,
          complemento: p.movimentacao.complemento ?? null,
        }
      : null,
    mimetype: p.mimetype ?? null,
    estado: p.estado,
    motivo: p.motivo ?? null,
    descricaoDoMotivo: p.descricaoDoMotivo ?? null,
    retomarEm: p.retomarEm?.toISOString() ?? null,
    desde: p.desde?.toISOString() ?? null,
    substituida: p.substituida,
    obtidaEm: p.obtidaEm?.toISOString() ?? null,
    expiraEm: p.expiraEm?.toISOString() ?? null,
    bytes: p.bytes ?? null,
    paginasDaPeca: p.paginasDaPeca ?? null,
    conversao: p.conversao ?? null,
    observacao: p.observacao ?? null,
    intervalo: p.intervalo ?? null,
    aoVivo: false,
  };
}
