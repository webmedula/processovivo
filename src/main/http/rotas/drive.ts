import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  EnvioParaODrive,
  ServicoDrive,
  VisaoDoDrive,
} from '../../../application/services/ServicoDrive.js';
import {
  OperacaoNaoSuportadaError,
  WorkspaceNaoResolvidoError,
} from '../../../domain/errors/index.js';

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

/** Um processo real medido tem 279 peças; o teto existe para um corpo malicioso. */
const MAX_PECAS = 5000;

/**
 * NENHUMA rota aceita texto, nome de arquivo ou conteúdo vindo do cliente: só CHAVES de peças que
 * já estão na pasta digital DAQUELE workspace (ou "todas as guardáveis"). `.strict()` recusa
 * qualquer campo a mais — um `nome` ou um `conteudo` no corpo é 400, nunca ignorado em silêncio.
 */
const corpoDoEnvio = z
  .object({
    pecas: z.array(z.string().min(1).max(100)).min(1).max(MAX_PECAS).optional(),
    todas: z.literal(true).optional(),
    reenviarRemovidas: z.boolean().optional(),
  })
  .strict()
  .refine((c) => (c.pecas !== undefined) !== (c.todas === true), {
    message: 'informe `pecas` (as chaves das peças) ou `todas: true`, e não os dois',
  });

/** O que o Google devolve na volta. Só o formato é conferido aqui; o sentido é do serviço. */
const consultaDoRetorno = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(2048).optional(),
  error: z.string().max(200).optional(),
});

function visaoJson(v: VisaoDoDrive): Record<string, unknown> {
  return {
    habilitado: true,
    plano: v.plano,
    estado: v.estado,
    linkDaPastaRaiz: v.linkDaPastaRaiz ?? null,
    motivoDoUltimoErro: v.motivoDoUltimoErro ?? null,
    conectadaEm: v.conectadaEm?.toISOString() ?? null,
    verificadaEm: v.verificadaEm?.toISOString() ?? null,
    envioAtivo: v.envioAtivo ?? null,
  };
}

function envioJson(e: EnvioParaODrive): Record<string, unknown> {
  return {
    id: e.id,
    numeroProcesso: e.numeroProcesso,
    estado: e.estado,
    total: e.total,
    processadas: e.processadas,
    progresso: e.progresso,
    sigilosasForaDoEnvio: e.sigilosasForaDoEnvio,
    removidasNoDrive: e.removidasNoDrive,
    falhasDasPecas: e.falhasDasPecas,
    motivoDaParada: e.motivoDaParada ?? null,
    retomarEm: e.retomarEm?.toISOString() ?? null,
    avisos: e.avisos,
    linkDaPasta: e.linkDaPasta ?? null,
    iniciadoEm: e.iniciadoEm.toISOString(),
    terminadoEm: e.terminadoEm?.toISOString() ?? null,
  };
}

/**
 * Rotas do Google Drive (v0.42.0). Sem `try/catch`: plano, conexão, peça de outro workspace,
 * listagem ausente, segredo de justiça — tudo é erro de domínio, e o `errorHandler` traduz.
 *
 * Com o recurso DESLIGADO (`PROCESSOVIVO_DRIVE_HABILITADO=false`, o padrão) `servico` é
 * indefinido: `GET /v1/drive` responde `{ habilitado: false }` — é como a tela sabe que não deve
 * mostrar nada — e todas as outras respondem 501.
 *
 * O retorno do Google (`GET /v1/drive/retorno`) é uma NAVEGAÇÃO do navegador, com o cookie da
 * sessão (SameSite=Lax vai em navegação de topo). Nunca mostra token, nunca põe token em URL e
 * nunca registra o código: o log de acesso guarda só o caminho, sem a query string. A resposta é
 * sempre um redirecionamento para a tela, com uma mensagem CURTA (`?drive=ok` ou
 * `?drive=erro&motivo=…`).
 */
export function rotasDoDrive(servico: ServicoDrive | undefined): FastifyPluginAsync {
  return async (servidor) => {
    function exigir(): ServicoDrive {
      if (!servico) {
        throw new OperacaoNaoSuportadaError(
          'drive',
          'salvarNoDrive',
          'o envio ao Google Drive não está habilitado neste servidor',
        );
      }
      return servico;
    }

    servidor.get('/v1/drive', async (req) => {
      if (!servico) return { habilitado: false };
      return visaoJson(await servico.visao(workspaceDe(req)));
    });

    servidor.post('/v1/drive/conexao', async (req) => {
      const { url } = await exigir().iniciarConexao(workspaceDe(req));
      return { url };
    });

    servidor.get('/v1/drive/retorno', async (req, reply) => {
      const s = exigir();
      const q = consultaDoRetorno.parse(req.query);
      // Nunca guardar a página de retorno (tem o código na URL) nem repassá-la como referência.
      void reply
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer');
      const ws = workspaceDe(req);

      if (q.error !== undefined || q.code === undefined || q.state === undefined) {
        // O advogado recusou na tela do Google (ou a volta veio incompleta). Gasta o `state`,
        // se veio, para ele não ficar valendo — e volta para a tela sem drama.
        if (q.state !== undefined) s.descartarConexao(ws, q.state);
        return reply.redirect(`/?drive=erro&motivo=negado`);
      }
      const r = await s.concluirConexao({
        workspace: ws,
        codigo: q.code,
        estado: q.state,
      });
      return reply.redirect(r.ok ? '/?drive=ok' : `/?drive=erro&motivo=${r.motivo}`);
    });

    servidor.delete('/v1/drive', async (req) => {
      await exigir().desconectar(workspaceDe(req));
      return { desconectado: true };
    });

    servidor.post<{ Params: { numero: string }; Body: unknown }>(
      '/v1/processos/:numero/pasta/drive',
      async (req, reply) => {
        const corpo = corpoDoEnvio.parse(req.body ?? {});
        const envio = await exigir().iniciarEnvio({
          workspace: workspaceDe(req),
          numeroProcesso: req.params.numero,
          pecas: corpo.todas === true ? 'todas' : (corpo.pecas ?? []),
          ...(corpo.reenviarRemovidas !== undefined
            ? { reenviarRemovidas: corpo.reenviarRemovidas }
            : {}),
        });
        // 202: o envio foi aceito e segue em segundo plano; o progresso vem de GET .../jobs/:id.
        return reply.code(202).send(envioJson(envio));
      },
    );

    servidor.get<{ Params: { id: string } }>('/v1/drive/jobs/:id', async (req) =>
      envioJson(await exigir().envio(workspaceDe(req), req.params.id)),
    );

    servidor.delete<{ Params: { id: string } }>('/v1/drive/jobs/:id', async (req) =>
      envioJson(await exigir().cancelar(workspaceDe(req), req.params.id)),
    );
  };
}
