import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServicoAssinaturas } from '../../../application/services/ServicoAssinaturas.js';
import type { ServicoCalendario } from '../../../application/services/ServicoCalendario.js';
import type { ServicoResumoDoCalendario } from '../../../application/services/ServicoResumoDoCalendario.js';
import {
  ESTADOS_DO_EVENTO,
  LIMITE_OBSERVACAO,
  LIMITE_TITULO,
  TIPOS_DE_EVENTO,
} from '../../../domain/entities/EventoDeCalendario.js';
import type {
  EstadoDoEvento,
  EventoDeCalendario,
  TipoDeEvento,
} from '../../../domain/entities/EventoDeCalendario.js';
import { NumeroCNJ } from '../../../domain/entities/NumeroCNJ.js';
import {
  FeedDoCalendarioNaoEncontradoError,
  OperacaoNaoSuportadaError,
  WorkspaceNaoResolvidoError,
} from '../../../domain/errors/index.js';
import type { FeedDoCalendario } from '../../../domain/ports/RepositorioDeEventos.js';
import { gerarIcs } from '../../../infrastructure/calendario/ics.js';

/**
 * A URL pública do feed, FORA do `/v1`.
 *
 * Decisão do dono: quem assina no Google Agenda ou no Outlook guarda esta URL
 * por anos, e um prefixo versionado a quebraria no dia de um `/v2`. As rotas
 * de dados do calendário continuam sob `/v1/calendario/...`.
 */
export const ROTA_FEED_PUBLICO = '/calendario/feed/:arquivo';

/**
 * Requisições por minuto, por IP, no feed público. Folgado de propósito: o
 * Google e a Microsoft buscam os feeds de muitos assinantes a partir dos mesmos
 * servidores, e um limite apertado cortaria o feed de quem não fez nada.
 */
export const LIMITE_FEED_POR_MINUTO = 120;

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

const dataLocal = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD');
const horaLocal = z.string().regex(/^\d{2}:\d{2}$/, 'use HH:MM');
const tipo = z.enum(TIPOS_DE_EVENTO as [TipoDeEvento, ...TipoDeEvento[]]);
const estado = z.enum(ESTADOS_DO_EVENTO as [EstadoDoEvento, ...EstadoDoEvento[]]);

const consultaListar = z.object({
  de: dataLocal,
  ate: dataLocal,
  // Um estado ou vários separados por vírgula: `estado=sugerido,confirmado`.
  estado: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined))
    .pipe(z.array(estado).optional()),
});

const corpoCriar = z.object({
  numeroProcesso: z.string().min(1).max(40),
  tipo,
  titulo: z.string().min(1).max(LIMITE_TITULO),
  dataLocal,
  horaLocal: horaLocal.optional(),
  duracaoMin: z.number().int().optional(),
  observacao: z.string().max(LIMITE_OBSERVACAO).optional(),
});

const corpoAlterar = z
  .object({
    tipo: tipo.optional(),
    titulo: z.string().min(1).max(LIMITE_TITULO).optional(),
    dataLocal: dataLocal.optional(),
    horaLocal: horaLocal.nullable().optional(),
    duracaoMin: z.number().int().nullable().optional(),
    observacao: z.string().max(LIMITE_OBSERVACAO).nullable().optional(),
    // Confirmar é mudar o estado para `confirmado`. Descartar tem rota própria.
    estado: z.literal('confirmado').optional(),
  })
  .strict();

const lembretes = z
  .object({ umDiaAntes: z.boolean(), umaHoraAntes: z.boolean() })
  .strict();
// PATCH: ao menos uma das duas opções (corpo vazio não muda nada e é erro de quem chamou).
const corpoAlterarFeed = z
  .object({ incluiSugeridos: z.boolean().optional(), lembretes: lembretes.optional() })
  .strict()
  .refine((c) => c.incluiSugeridos !== undefined || c.lembretes !== undefined, {
    message: 'Informe incluiSugeridos ou lembretes.',
  });
const corpoResumo = z.object({ ativo: z.boolean() }).strict();
const corpoFeed = z
  .object({ incluiSugeridos: z.boolean().optional(), lembretes: lembretes.optional() })
  .strict();

/** `<token>.ics`. O token é base64url de 32 bytes (43 caracteres). */
const ARQUIVO_DO_FEED = /^([A-Za-z0-9_-]{20,128})\.ics$/;

/**
 * Calendário: a agenda do workspace e o feed ICS.
 *
 * As rotas de dados exigem o recurso `calendario` do plano, pela mesma regra
 * das peças: 402 com a assinatura vencida além da carência, 403 com o plano
 * sem o recurso, e passagem livre para workspace sem assinatura (chave de API).
 * Sessão e chave de API chegam aqui como o mesmo `workspace`.
 *
 * Sem `try/catch`: evento de outro workspace, data inválida, transição
 * proibida — tudo é erro de domínio, e o `errorHandler` traduz.
 */
export function rotasDoCalendario(
  servico: ServicoCalendario | undefined,
  assinaturas: ServicoAssinaturas | undefined,
  opcoes: {
    readonly urlBase: string;
    readonly resumo?: ServicoResumoDoCalendario | undefined;
  },
): FastifyPluginAsync {
  return async (servidor) => {
    async function preparar(
      req: FastifyRequest,
    ): Promise<{ ws: string; cal: ServicoCalendario }> {
      const ws = workspaceDe(req);
      await assinaturas?.exigir(ws, 'calendario');
      if (!servico) {
        throw new OperacaoNaoSuportadaError(
          'calendario',
          'agenda',
          'o calendário não está montado',
        );
      }
      return { ws, cal: servico };
    }

    const base = (req: FastifyRequest): string =>
      opcoes.urlBase || `${req.protocol}://${req.host}`;

    servidor.get('/v1/calendario/eventos', async (req) => {
      const { ws, cal } = await preparar(req);
      const q = consultaListar.parse(req.query ?? {});
      const { eventos, totalNoIntervalo } = await cal.listar(ws, {
        de: q.de,
        ate: q.ate,
        ...(q.estado ? { estados: q.estado } : {}),
      });
      return {
        de: q.de,
        ate: q.ate,
        total: eventos.length,
        totalNoIntervalo,
        eventos: eventos.map(paraJson),
      };
    });

    servidor.post('/v1/calendario/eventos', async (req, resposta) => {
      const { ws, cal } = await preparar(req);
      const c = corpoCriar.parse(req.body ?? {});
      const evento = await cal.criarManual(ws, {
        numeroProcesso: c.numeroProcesso,
        tipo: c.tipo,
        titulo: c.titulo,
        dataLocal: c.dataLocal,
        ...(c.horaLocal !== undefined ? { horaLocal: c.horaLocal } : {}),
        ...(c.duracaoMin !== undefined ? { duracaoMin: c.duracaoMin } : {}),
        ...(c.observacao !== undefined ? { observacao: c.observacao } : {}),
      });
      return resposta.code(201).send(paraJson(evento));
    });

    servidor.patch<{ Params: { id: string } }>(
      '/v1/calendario/eventos/:id',
      async (req) => {
        const { ws, cal } = await preparar(req);
        const c = corpoAlterar.parse(req.body ?? {});
        const evento = await cal.alterar(
          ws,
          req.params.id,
          {
            ...(c.tipo !== undefined ? { tipo: c.tipo } : {}),
            ...(c.titulo !== undefined ? { titulo: c.titulo } : {}),
            ...(c.dataLocal !== undefined ? { dataLocal: c.dataLocal } : {}),
            ...(c.horaLocal !== undefined ? { horaLocal: c.horaLocal } : {}),
            ...(c.duracaoMin !== undefined ? { duracaoMin: c.duracaoMin } : {}),
            ...(c.observacao !== undefined ? { observacao: c.observacao } : {}),
          },
          { confirmar: c.estado === 'confirmado' },
        );
        return paraJson(evento);
      },
    );

    servidor.post<{ Params: { id: string } }>(
      '/v1/calendario/eventos/:id/descartar',
      async (req) => {
        const { ws, cal } = await preparar(req);
        return paraJson(await cal.descartar(ws, req.params.id));
      },
    );

    // Cria ou REGENERA. A URL completa sai nesta resposta e em nenhuma outra:
    // o banco só tem o hash, e o GET abaixo nunca a devolve.
    servidor.post('/v1/calendario/feed', async (req, resposta) => {
      const { ws, cal } = await preparar(req);
      const c = corpoFeed.parse(req.body ?? {});
      const { token, feed } = await cal.criarFeed(
        ws,
        c.incluiSugeridos ?? false,
        c.lembretes,
      );
      void resposta.header('Cache-Control', 'no-store');
      return resposta.code(201).send({
        ...feedParaJson(feed),
        url: `${base(req)}/calendario/feed/${token}.ics`,
        aviso:
          'Esta URL aparece só agora. Quem tiver esta URL vê estes eventos; ' +
          'regenere se ela vazar.',
      });
    });

    servidor.get('/v1/calendario/feed', async (req) => {
      const { ws, cal } = await preparar(req);
      const feed = await cal.feed(ws);
      return feed ? { existe: true, ...feedParaJson(feed) } : { existe: false };
    });

    // Só as opções (sugeridos e lembretes); o token (e a URL já assinada) não muda.
    servidor.patch('/v1/calendario/feed', async (req) => {
      const { ws, cal } = await preparar(req);
      const c = corpoAlterarFeed.parse(req.body ?? {});
      return {
        existe: true,
        ...feedParaJson(
          await cal.alterarFeed(ws, {
            ...(c.incluiSugeridos !== undefined
              ? { incluiSugeridos: c.incluiSugeridos }
              : {}),
            ...(c.lembretes ? { lembretes: c.lembretes } : {}),
          }),
        ),
      };
    });

    /*
     * Resumo por e-mail dos eventos a confirmar (v0.51.0). `disponivel` é a chave global: desligada (ou sem
     * SMTP de verdade), a tela nem mostra a opção. A escolha é por workspace; sem linha = LIGADO.
     */
    servidor.get('/v1/calendario/resumo', async (req) => {
      const { ws } = await preparar(req);
      const r = opcoes.resumo;
      if (!r?.habilitado) return { disponivel: false, ativo: false };
      return { disponivel: true, ativo: await r.preferencia(ws) };
    });

    servidor.put('/v1/calendario/resumo', async (req) => {
      const { ws } = await preparar(req);
      const c = corpoResumo.parse(req.body ?? {});
      const r = opcoes.resumo;
      if (!r?.habilitado) return { disponivel: false, ativo: false };
      await r.definirPreferencia(ws, c.ativo);
      return { disponivel: true, ativo: c.ativo };
    });

    servidor.delete('/v1/calendario/feed', async (req) => {
      const { ws, cal } = await preparar(req);
      return { revogado: await cal.revogarFeed(ws) };
    });

    /*
     * O feed público. Só o token autentica; o plugin de autenticação o deixa
     * passar (`rotasPublicas`). Não grava cookie, não diz de quem é, e todo
     * caso de "não posso servir" é o MESMO 404 — ver
     * `FeedDoCalendarioNaoEncontradoError`.
     */
    servidor.get<{ Params: { arquivo: string } }>(
      ROTA_FEED_PUBLICO,
      {
        config: {
          rateLimit: {
            max: LIMITE_FEED_POR_MINUTO,
            timeWindow: 60_000,
            // Por IP sempre, mesmo que o navegador mande um cookie de sessão
            // junto: o feed não é de quem está logado, é de quem tem o token.
            keyGenerator: (req: FastifyRequest) => `feed:${req.ip}`,
          },
        },
      },
      async (req, resposta) => {
        const casou = ARQUIVO_DO_FEED.exec(req.params.arquivo);
        if (!casou?.[1] || !servico) throw new FeedDoCalendarioNaoEncontradoError();
        const { eventos, agora, feed } = await servico.eventosDoFeed(casou[1]);
        return resposta
          .header('Content-Type', 'text/calendar; charset=utf-8')
          .header('Cache-Control', 'private, max-age=300')
          .header('Content-Disposition', 'inline; filename="processovivo.ics"')
          .send(
            gerarIcs(eventos, {
              agora,
              urlBase: base(req),
              lembretes: feed.lembretes,
              revisaoLembretes: feed.revisaoLembretes,
              ...(feed.lembretesAlteradosEm
                ? { lembretesAlteradosEm: feed.lembretesAlteradosEm }
                : {}),
            }),
          );
      },
    );
  };
}

function feedParaJson(feed: FeedDoCalendario): Record<string, unknown> {
  return {
    criadoEm: feed.criadoEm.toISOString(),
    incluiSugeridos: feed.incluiSugeridos,
    lembretes: feed.lembretes,
  };
}

function paraJson(e: EventoDeCalendario): Record<string, unknown> {
  let formatado = e.numeroProcesso;
  try {
    formatado = NumeroCNJ.criar(e.numeroProcesso).formatado;
  } catch {
    // Mostra cru em vez de esconder o evento.
  }
  return {
    id: e.id,
    numeroProcesso: e.numeroProcesso,
    numeroFormatado: formatado,
    tribunal: e.tribunal,
    tipo: e.tipo,
    titulo: e.titulo,
    observacao: e.observacao ?? null,
    dataLocal: e.dataLocal,
    horaLocal: e.horaLocal ?? null,
    duracaoMin: e.duracaoMin ?? null,
    origem: e.origem,
    estado: e.estado,
    revisar: e.revisar,
    procedencia: e.procedencia
      ? {
          movimentacaoId: e.procedencia.movimentacaoId,
          dataDoAndamento: e.procedencia.dataDoAndamento.toISOString(),
          trecho: e.procedencia.trecho,
        }
      : null,
    segredoJustica: e.segredoJustica,
    calculado: e.calculado,
    sequencia: e.sequencia,
    criadoEm: e.criadoEm.toISOString(),
    atualizadoEm: e.atualizadoEm.toISOString(),
    confirmadoEm: e.confirmadoEm?.toISOString() ?? null,
    descartadoEm: e.descartadoEm?.toISOString() ?? null,
  };
}
