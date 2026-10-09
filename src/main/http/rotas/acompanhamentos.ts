import { z } from 'zod';
import { WorkspaceNaoResolvidoError } from '../../../domain/errors/index.js';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type {
  EstadoDaVerificacao,
  ServicoAcompanhamento,
} from '../../../application/services/ServicoAcompanhamento.js';
import type {
  Acompanhamento,
  Novidade,
} from '../../../domain/entities/Acompanhamento.js';
import type { AcompanhamentoResumido } from '../../../domain/ports/RepositorioAcompanhamentos.js';
import {
  PENDENCIA_INTIMACAO_JANELA_DIAS,
  estadoDaPasta,
} from '../../../domain/entities/estadoDaPasta.js';
import type {
  AtoDaProvidencia,
  LeituraDaProvidencia,
} from '../../../domain/entities/estadoDaPasta.js';
import { triar } from '../../../domain/entities/triagem.js';
import { agruparNovidades } from '../../../domain/entities/agruparNovidades.js';
import type { GrupoDeNovidades } from '../../../domain/entities/agruparNovidades.js';

/**
 * O workspace vem da chave de API, resolvido no plugin de autenticação. Estas
 * rotas nunca leem um workspace do corpo ou da query — se lessem, qualquer
 * cliente autenticado poderia pedir a carteira de outro.
 */
function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

/**
 * `?ultimosDias=x` chegava como `Number('x')` = NaN, virava `new Date(NaN)` e
 * estourava `RangeError` — ou seja, 500 e alarme de produção por um parâmetro
 * de query digitado errado.
 */
function diasValidos(bruto: string | undefined): number | undefined {
  if (!bruto) return undefined;
  const n = Number(bruto);
  return Number.isInteger(n) && n > 0 && n <= 3650 ? n : undefined;
}

/** O que a tela sabe da verificação da conta: sem fila global, sem outras contas. */
export function estadoDaVerificacaoJson(e: EstadoDaVerificacao): Record<string, unknown> {
  return {
    emAndamento: e.emAndamento,
    pendentes: e.pendentes,
    desde: e.desde?.toISOString() ?? null,
    demorando: e.demorando,
  };
}

function resumoJson(
  a: AcompanhamentoResumido,
  pendenciaJanelaDias: number,
  agora: Date,
): Record<string, unknown> {
  const p = a.processo;
  return {
    numero: p ? p.numero.formatado : a.numero,
    apelido: a.apelido,
    tribunal: p?.tribunal,
    grau: p?.grau,
    classe: p?.classe,
    assunto: p?.assunto,
    vara: p?.vara,
    segredoJustica: p?.segredoJustica ?? false,
    // As PARTES entram no resumo da lista.
    //
    // Sem elas, achar "os processos do cliente X" obriga a abrir um por um —
    // e numa carteira de centenas isso é o trabalho que o sistema existe para
    // fazer. Só nome e polo: advogados de cada parte ficam para a tela do
    // processo, senão a listagem cresce sem que a lista mostre isso.
    partes: (p?.partes ?? []).map((parte) => ({
      nome: parte.nome,
      polo: parte.polo,
    })),
    totalMovimentacoes: p?.movimentacoes.length ?? 0,
    ultimaMovimentacao: a.ultimaMovimentacao
      ? {
          data: a.ultimaMovimentacao.data.toISOString(),
          titulo: a.ultimaMovimentacao.titulo,
        }
      : null,
    novidadesNaoVistas: a.novidadesNaoVistas,
    criadoEm: a.criadoEm.toISOString(),
    sincronizadoEm: a.sincronizadoEm?.toISOString() ?? null,
    erro: a.erro ?? null,
    cliente: a.cliente ?? null,
    // O estado é DERIVADO na resposta, nunca guardado em coluna.
    //
    // Mesma razão do status de assinatura: estado em coluna precisa de alguém
    // que o atualize, e esse alguém é sempre uma tarefa agendada que pode não
    // ter rodado. Uma pasta cujo prazo venceu às 3h e só é remarcada às 6h são
    // três horas em que a tela mente.
    estado: (() => {
      const e = estadoDaPasta(
        {
          ...(a.erro !== undefined ? { erro: a.erro } : {}),
          ...(a.sincronizadoEm !== undefined ? { sincronizadoEm: a.sincronizadoEm } : {}),
          novidadesNaoVistas: a.novidadesNaoVistas,
          ...(p ? { movimentacoes: p.movimentacoes } : {}),
          ...(a.cumprido ? { cumprido: a.cumprido } : {}),
        },
        agora,
        pendenciaJanelaDias,
      );
      return {
        rotulo: e.rotulo,
        naoVerificado: e.naoVerificado,
        motivo: e.motivo ?? null,
      };
    })(),
  };
}

function detalheJson(a: Acompanhamento): Record<string, unknown> {
  return {
    numero: a.processo ? a.processo.numero.formatado : a.numero,
    apelido: a.apelido ?? null,
    cliente: a.cliente ?? null,
    criadoEm: a.criadoEm.toISOString(),
    sincronizadoEm: a.sincronizadoEm?.toISOString() ?? null,
    erro: a.erro ?? null,
    processo: a.processo ? a.processo.toJSON() : null,
  };
}

function novidadeJson(n: Novidade): Record<string, unknown> {
  return {
    id: n.id,
    numero: n.numero,
    data: n.data.toISOString(),
    titulo: n.titulo,
    codigoTpu: n.codigoTpu ?? null,
    conteudo: n.conteudo ?? null,
    detectadaEm: n.detectadaEm.toISOString(),
    // Só MARCA. Nunca é critério de filtro nem de agrupamento (triagem ordena,
    // nunca esconde): a atualização anterior que pede providência continua
    // visível como tal depois de expandida.
    exigeAcao: triar({
      data: n.data,
      titulo: n.titulo,
      ...(n.codigoTpu !== undefined ? { codigoTpu: n.codigoTpu } : {}),
      ...(n.conteudo !== undefined ? { conteudo: n.conteudo } : {}),
    }).exigeAcao,
    vista: n.vistaEm !== undefined,
  };
}

/** Teto de nomes por polo na lista; o total real vai junto, para a tela dizer quantos faltam. */
const MAX_NOMES_POR_POLO = 20;

/**
 * O que a tabela de Atualizações mostra do PROCESSO (v0.37.0), lido do retrato já
 * guardado no acompanhamento — nenhuma consulta nova ao tribunal.
 *
 * `partes` só carrega o que a fonte entregou (o DJEN, quando há publicação): vazio
 * é "a fonte não sabe", nunca dedução do texto de peça. `pedeProvidencia` é
 * `estadoDaPasta` — a MESMA regra, e a mesma janela, do selo da carteira e do card
 * que esta tabela substituiu.
 */
function infoDoProcesso(
  a: Acompanhamento & { readonly novidadesNaoVistas?: number },
  pendenciaJanelaDias: number,
  agora: Date,
): Record<string, unknown> {
  const p = a.processo;
  const nomes = (polo: 'ATIVO' | 'PASSIVO'): Record<string, unknown> => {
    const todos = (p?.partes ?? []).filter((x) => x.polo === polo).map((x) => x.nome);
    return { nomes: todos.slice(0, MAX_NOMES_POR_POLO), total: todos.length };
  };
  const estado = estadoDaPasta(
    {
      ...(a.erro !== undefined ? { erro: a.erro } : {}),
      ...(a.sincronizadoEm !== undefined ? { sincronizadoEm: a.sincronizadoEm } : {}),
      novidadesNaoVistas: a.novidadesNaoVistas ?? 0,
      ...(p ? { movimentacoes: p.movimentacoes } : {}),
      ...(a.cumprido ? { cumprido: a.cumprido } : {}),
    },
    agora,
    pendenciaJanelaDias,
  );
  return {
    tribunal: p?.tribunal ?? null,
    classe: p?.classe ?? null,
    partes: { ativo: nomes('ATIVO'), passivo: nomes('PASSIVO') },
    pedeProvidencia: estado.rotulo === 'PROVIDENCIA',
    motivoProvidencia: estado.rotulo === 'PROVIDENCIA' ? (estado.motivo ?? null) : null,
    // (v0.37.5) Campo NOVO e aditivo: o ATO que gera a providência (que pode não
    // ser o da linha), o que a marca de "cumprido" cobriu e o que passou da janela.
    providencia: providenciaJson(estado.providencia, a.cumprido),
  };
}

function atoJson(ato: AtoDaProvidencia): Record<string, unknown> {
  return {
    rotulo: ato.rotulo,
    data: ato.data.toISOString(),
    // Opaca para a tela: ela a devolve em "marcar como cumprido", nunca a interpreta.
    chave: ato.chave,
    tipo: ato.tipo,
    // (v0.37.6) `sim` | `nao` | `desconhecido`. Só o indicador: nenhuma inscrição de advogado sai daqui.
    paraOUsuario: ato.paraOUsuario,
  };
}

/**
 * `pede`: há ato pedindo providência agora. `cumprida`: pediria, mas o advogado
 * marcou (`cumpridoEm` diz quando). `venceu`: intimação/citação que passou da
 * janela sem marca. `null`: nada a dizer. Só rótulo e data do ato — nunca o texto,
 * nem de processo em segredo de justiça.
 */
function providenciaJson(
  leitura: LeituraDaProvidencia,
  cumprido: Acompanhamento['cumprido'],
): Record<string, unknown> | null {
  // (v0.37.6) Intimação/citação do Diário dirigida a OUTRO destinatário: campo à
  // parte, porque convive com `cumprida` e `venceu` e a tela conta cada um.
  const outro = leitura.outroDestinatario
    ? { outroDestinatario: atoJson(leitura.outroDestinatario) }
    : {};
  if (leitura.pendente) {
    return { situacao: 'pede', motivo: atoJson(leitura.pendente), cumpridoEm: null, ...outro };
  }
  if (leitura.coberto) {
    return {
      situacao: 'cumprida',
      motivo: atoJson(leitura.coberto),
      cumpridoEm: cumprido?.em.toISOString() ?? null,
      ...outro,
    };
  }
  if (leitura.venceuPorTempo) {
    return {
      situacao: 'venceu',
      motivo: atoJson(leitura.venceuPorTempo),
      cumpridoEm: null,
      ...outro,
    };
  }
  if (leitura.outroDestinatario) {
    return {
      situacao: 'outro',
      motivo: atoJson(leitura.outroDestinatario),
      cumpridoEm: null,
      ...outro,
    };
  }
  return null;
}

function grupoJson(
  g: GrupoDeNovidades,
  processo: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    numero: g.numero,
    processo: processo ?? null,
    maisRecente: novidadeJson(g.maisRecente),
    // Só QUANTAS: a tela mostra a mais recente e manda para o processo ver as
    // anteriores. Um processo com 300 atualizações não trafega 300 itens (v0.37.1).
    quantidade: 1 + g.anteriores.length,
    naoVistas: g.naoVistas,
  };
}

/** Trecho do texto do ato que viaja na linha de processo sem novidade; a tela encurta mais. */
const MAX_CONTEUDO_SEM_NOVIDADE = 600;

/**
 * Linha de um processo acompanhado que NÃO tem novidade registrada (v0.37.3).
 *
 * Lê só o retrato que o acompanhamento já guarda (`ultimaMovimentacao`) — nada de
 * consulta ao tribunal, nada gravado. Não é novidade e não se apresenta como tal:
 * por isso vive num campo à parte (`semNovidade`) e nunca entra em `novidades`.
 *
 * Segredo de justiça: vai o rótulo e a data, que é o que a carteira ("Meus
 * processos") já mostra; o TEXTO do ato não sai, porque a tela só o exibia para
 * novidade e o retrato do sigiloso pode trazer conteúdo que a carteira nunca mostra.
 */
function linhaSemNovidade(
  a: AcompanhamentoResumido,
  info: Record<string, unknown>,
): Record<string, unknown> {
  const segredo = a.processo?.segredoJustica ?? false;
  const ultima = a.ultimaMovimentacao;
  return {
    numero: a.numero,
    processo: info,
    segredoJustica: segredo,
    ultimaMovimentacao: ultima
      ? {
          data: ultima.data.toISOString(),
          titulo: ultima.titulo,
          conteudo:
            !segredo && ultima.conteudo
              ? ultima.conteudo.slice(0, MAX_CONTEUDO_SEM_NOVIDADE)
              : null,
        }
      : null,
  };
}

/** Teto de leitura: o agrupamento precisa ver tudo para contar o que a janela deixou de fora. */
const LIMITE_DE_LEITURA_DAS_NOVIDADES = 5000;

interface QueryLista {
  texto?: string;
  tribunal?: string;
  /** Nome de uma parte. Filtro próprio, não é o mesmo que `texto` — ver a porta. */
  parte?: string;
  classe?: string;
  cliente?: string;
  comNovidade?: string;
  ultimosDias?: string;
  ordem?: 'MOVIMENTACAO_RECENTE' | 'ADICIONADO_RECENTE' | 'NUMERO';
}

interface QueryNovidades {
  numero?: string;
  tribunal?: string;
  naoVistas?: string;
  limite?: string;
  /** `todas` desliga a janela; ausente, vale `NOVIDADES_JANELA_DIAS`. */
  janela?: string;
}

export interface JanelasDasTelas {
  readonly novidadesJanelaDias: number;
  readonly pendenciaJanelaDias: number;
}

const corpoDoCumprido = z.object({ chaveDoAto: z.string().min(1).max(1000) });

const verdadeiro = (v: string | undefined): boolean => v === 'true' || v === '1';

export function rotasDeAcompanhamento(
  servico: ServicoAcompanhamento,
  janelas: JanelasDasTelas,
  // Injetável: as janelas de dias se testam com relógio fixo, nunca com sleep.
  agora: () => Date = () => new Date(),
): FastifyPluginAsync {
  return async (servidor) => {
    servidor.get<{ Querystring: QueryLista }>('/v1/acompanhamentos', async (req) => {
      const q = req.query;
      const lista = await servico.listar(workspaceDe(req), {
        ...(q.texto ? { texto: q.texto } : {}),
        ...(q.tribunal ? { tribunal: q.tribunal } : {}),
        ...(q.parte ? { parte: q.parte } : {}),
        ...(q.cliente ? { cliente: q.cliente } : {}),
        ...(q.classe ? { classe: q.classe } : {}),
        ...(verdadeiro(q.comNovidade) ? { somenteComNovidade: true } : {}),
        ...(diasValidos(q.ultimosDias) !== undefined
          ? { movimentadoNosUltimosDias: diasValidos(q.ultimosDias) as number }
          : {}),
        ...(q.ordem ? { ordem: q.ordem } : {}),
      });
      return {
        total: lista.length,
        // O total SEM filtro vai junto, sempre. É o que permite a tela dizer
        // "mostrando 1 de 3" em vez de mostrar 1 e calar sobre os outros 2 —
        // que foi como um filtro esquecido convenceu o dono do produto de que
        // o sistema tinha perdido processos.
        totalSemFiltro: await servico.contarAcompanhamentos(workspaceDe(req)),
        acompanhamentos: lista.map((a) =>
          resumoJson(a, janelas.pendenciaJanelaDias, agora()),
        ),
      };
    });

    servidor.post<{ Body: { numero?: string; apelido?: string } }>(
      '/v1/acompanhamentos',
      async (req, resposta) => {
        const numero = req.body?.numero?.trim();
        if (!numero) {
          void resposta.code(400);
          return {
            erro: 'NUMERO_OBRIGATORIO',
            mensagem: 'Informe o número do processo.',
          };
        }
        const criado = await servico.acompanhar(
          workspaceDe(req),
          numero,
          req.body?.apelido?.trim() || undefined,
        );
        void resposta.code(201);
        return detalheJson(criado);
      },
    );

    servidor.get<{ Params: { numero: string } }>(
      '/v1/acompanhamentos/:numero',
      async (req, resposta) => {
        const a = await servico.detalhar(workspaceDe(req), req.params.numero);
        if (!a) {
          void resposta.code(404);
          return {
            erro: 'NAO_ACOMPANHADO',
            mensagem: 'Este processo não está sendo acompanhado.',
          };
        }
        return detalheJson(a);
      },
    );

    servidor.delete<{ Params: { numero: string } }>(
      '/v1/acompanhamentos/:numero',
      async (req, resposta) => {
        const removido = await servico.deixarDeAcompanhar(
          workspaceDe(req),
          req.params.numero,
        );
        if (!removido) {
          void resposta.code(404);
          return { erro: 'NAO_ACOMPANHADO', mensagem: 'Não estava sendo acompanhado.' };
        }
        return { removido: true };
      },
    );

    /*
     * O rótulo de cliente. PUT e não PATCH porque o corpo substitui o valor
     * inteiro, inclusive por vazio: apagar um nome digitado errado tem de ser
     * possível, e é justamente o que um merge parcial impediria.
     */
    servidor.put<{ Params: { numero: string }; Body: { cliente?: string } }>(
      '/v1/acompanhamentos/:numero/cliente',
      async (req, resposta) => {
        const cliente = (req.body?.cliente ?? '').trim();
        if (cliente.length > 120) {
          void resposta.code(400);
          return {
            erro: 'CLIENTE_MUITO_LONGO',
            mensagem: 'O nome do cliente deve ter no máximo 120 caracteres.',
          };
        }
        const ok = await servico.rotular(workspaceDe(req), req.params.numero, cliente);
        if (!ok) {
          void resposta.code(404);
          return {
            erro: 'ACOMPANHAMENTO_NAO_ENCONTRADO',
            mensagem: 'Este processo não está sendo acompanhado.',
          };
        }
        return { cliente: cliente || null };
      },
    );

    servidor.get('/v1/clientes', async (req) => {
      const lista = await servico.clientes(workspaceDe(req));
      return { total: lista.length, clientes: lista };
    });

    /*
     * "Marcar como cumprido" (v0.37.5). A tela manda a chave do ato que ELA
     * mostrou; a resposta traz o processo já recalculado (mesmo formato de
     * `processo` em /v1/novidades), então ela não precisa recarregar a lista.
     * Sem try/catch: o errorHandler traduz (404 não acompanhado, 409 ato inválido).
     */
    servidor.post<{ Params: { numero: string } }>(
      '/v1/acompanhamentos/:numero/cumprido',
      async (req) => {
        const { chaveDoAto } = corpoDoCumprido.parse(req.body);
        const a = await servico.marcarComoCumprido(
          workspaceDe(req),
          req.params.numero,
          chaveDoAto,
          req.identidadeDaChave ?? '',
        );
        return { processo: infoDoProcesso(a, janelas.pendenciaJanelaDias, agora()) };
      },
    );

    servidor.delete<{ Params: { numero: string } }>(
      '/v1/acompanhamentos/:numero/cumprido',
      async (req) => {
        const a = await servico.desfazerCumprido(workspaceDe(req), req.params.numero);
        return { processo: infoDoProcesso(a, janelas.pendenciaJanelaDias, agora()) };
      },
    );

    servidor.get<{ Querystring: QueryNovidades }>('/v1/novidades', async (req) => {
      const q = req.query;
      const ws = workspaceDe(req);
      const todas = q.janela === 'todas';
      // Lê tudo e deixa a janela para o domínio: só assim dá para dizer quantas
      // atualizações ficaram de fora (e nada é descartado em silêncio).
      const lista = await servico.novidades(ws, {
        ...(q.numero ? { numero: q.numero.replace(/\D/g, '') } : {}),
        ...(q.tribunal ? { tribunal: q.tribunal } : {}),
        ...(verdadeiro(q.naoVistas) ? { somenteNaoVistas: true } : {}),
        limite: q.limite ? Number(q.limite) : LIMITE_DE_LEITURA_DAS_NOVIDADES,
      });
      const janelaDias = todas ? undefined : janelas.novidadesJanelaDias;
      const instante = agora();
      const agrupadas = agruparNovidades(lista, instante, janelaDias);
      // Sempre do workspace de quem pediu: a carteira de outro nunca entra aqui.
      const infoPorNumero = new Map<string, Record<string, unknown>>();
      const carteira = await servico.listar(ws);
      for (const a of carteira) {
        infoPorNumero.set(
          a.numero,
          infoDoProcesso(a, janelas.pendenciaJanelaDias, instante),
        );
      }
      // Processos acompanhados SEM novidade nenhuma registrada (em qualquer data):
      // a primeira sincronização guarda o retrato e não gera novidade, por regra.
      // `lista` já vem sem janela. Com `naoVistas` a pergunta é outra e o campo
      // fica vazio — "sem novidade" só se afirma sobre a lista completa.
      const numeroPedido = q.numero ? q.numero.replace(/\D/g, '') : undefined;
      const daBusca = carteira.filter(
        (a) =>
          (!q.tribunal || a.processo?.tribunal === q.tribunal) &&
          (!numeroPedido || a.numero === numeroPedido),
      );
      const comNovidade = new Set(lista.map((n) => n.numero));
      const semNovidade = verdadeiro(q.naoVistas)
        ? []
        : daBusca.filter((a) => !comNovidade.has(a.numero));
      const noGrupo = new Set(agrupadas.grupos.map((g) => g.numero));
      return {
        total: agrupadas.dentroDaJanela,
        // Contam ATUALIZAÇÕES não vistas, não linhas: o menu e o painel
        // continuam com o mesmo número de antes do agrupamento.
        naoVistas: await servico.contarNaoVistas(ws),
        // Quantos processos o assinante acompanha.
        //
        // Vai JUNTO das novidades porque a tela inicial mostra movimentação
        // NOVA, e um processo recém-adicionado não gera nenhuma — a primeira
        // sincronização é o retrato inicial, não novidade. Sem este número, a
        // tela que a pessoa vê primeiro parece dizer que ela não tem nada,
        // logo depois de ela ter cadastrado três processos. Foi exatamente o
        // que aconteceu num teste real: o dado estava salvo, e a interface
        // convenceu o dono de que tinha sumido.
        acompanhados: await servico.contarAcompanhamentos(ws),
        // `null` = "Todas". A tela usa para rotular a alternância e dizer
        // quantas atualizações mais antigas não estão na lista.
        janelaDias: janelaDias ?? null,
        janelaPadraoDias: janelas.novidadesJanelaDias,
        // O filtro "Pedem providência" diz de quantos dias é: um valor só, do servidor.
        pendenciaJanelaDias: janelas.pendenciaJanelaDias,
        // (v0.37.5) A janela das intimações/citações do Diário, também do servidor.
        pendenciaIntimacaoJanelaDias: PENDENCIA_INTIMACAO_JANELA_DIAS,
        foraDaJanela: agrupadas.foraDaJanela,
        // (v0.37.3) Campos NOVOS; os de cima não mudaram. Processos acompanhados
        // sem novidade registrada, com a última movimentação do retrato.
        semNovidade: semNovidade.map((a) =>
          linhaSemNovidade(a, infoPorNumero.get(a.numero) ?? {}),
        ),
        // Quantos PROCESSOS a janela deixou fora da lista (sem atualização no
        // período, inclusive os sem novidade nenhuma). 0 quando a janela está
        // desligada ("Todas") — nesse caso nenhum processo fica de fora.
        processosForaDaJanela:
          janelaDias === undefined || verdadeiro(q.naoVistas)
            ? 0
            : daBusca.filter((a) => !noGrupo.has(a.numero)).length,
        grupos: agrupadas.grupos.map((g) => grupoJson(g, infoPorNumero.get(g.numero))),
        // Só a mais recente de cada processo, como em `grupos`. `total` continua
        // contando as atualizações do período.
        novidades: agrupadas.grupos.map((g) => novidadeJson(g.maisRecente)),
      };
    });

    servidor.post<{ Body: { numero?: string } }>(
      '/v1/novidades/marcar-vistas',
      async (req) => {
        const marcadas = await servico.marcarComoVistas(
          workspaceDe(req),
          req.body?.numero,
        );
        return { marcadas };
      },
    );

    servidor.get('/v1/facetas', async (req) => {
      const ws = workspaceDe(req);
      // Os rótulos de cliente entram nas facetas, e não numa chamada própria:
      // a tela precisa dos três seletores ao mesmo tempo, e três requisições
      // para montar uma barra de filtros é latência sem contrapartida.
      const [facetas, clientes] = await Promise.all([
        servico.facetas(ws),
        servico.clientes(ws),
      ]);
      return { ...facetas, clientes, pendenciaJanelaDias: janelas.pendenciaJanelaDias };
    });

    /**
     * Dispara a varredura na hora. Responde 202 e NÃO espera terminar: a
     * varredura pode levar meia hora, e segurar a conexão aberta por isso
     * levaria o proxy a cortar antes do fim.
     */
    servidor.post('/v1/sincronizar', async (req, resposta) => {
      // ESCOPADA ao chamador. A versão global existe e é a agendada — deixar
      // a rota HTTP disparar aquela permitia a qualquer conta mandar o
      // servidor consultar o tribunal sobre a carteira de TODOS os
      // assinantes, gravando nos dados deles e gastando a cota do CNJ em
      // nome deles.
      //
      // Desde a v0.37.3 a varredura de OUTRA conta não barra o pedido (era 409
      // para quem não tinha nada a ver com ela): o pedido espera a vez, e uma
      // verificação desta conta já em curso nunca vira uma segunda.
      const resultado = servico.solicitar(workspaceDe(req));
      void resposta.code(202);
      return {
        iniciada: resultado !== 'ja_em_andamento',
        jaEmAndamento: resultado === 'ja_em_andamento',
        naFila: resultado === 'na_fila',
        mensagem:
          resultado === 'ja_em_andamento'
            ? 'Já há uma verificação dos seus processos em andamento.'
            : 'Verificação iniciada em segundo plano. Cada processo leva alguns segundos; ' +
              'as novidades aparecem no feed conforme forem detectadas.',
      };
    });

    // Só os processos DESTA conta: nenhum número da fila global sai daqui.
    servidor.get('/v1/sincronizacao', async (req) =>
      estadoDaVerificacaoJson(servico.estadoDa(workspaceDe(req))),
    );
  };
}
