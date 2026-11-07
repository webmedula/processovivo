import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServicoLoginGoogle } from '../../../application/services/ServicoLoginGoogle.js';
import type { Usuario } from '../../../domain/entities/Usuario.js';
import {
  LoginGoogleRecusadoError,
  SessaoInvalidaError,
} from '../../../domain/errors/index.js';
import { cookieDeSessao } from '../../../infrastructure/seguranca/sessao.js';

/** Públicas para o plugin de autenticação: quem entra pelo Google ainda não tem sessão. */
export const ROTA_LOGIN_GOOGLE = '/v1/sessoes/google';
export const ROTA_LOGIN_GOOGLE_RETORNO = '/v1/sessoes/google/retorno';

const consultaDoRetorno = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(2048).optional(),
  error: z.string().max(200).optional(),
});

/**
 * Login com Google (v0.67.0).
 *
 * - `GET /v1/sessoes/google` diz se o login existe NESTE servidor (a tela só desenha o botão com
 *   `disponivel: true`); desligado, responde `false`, nunca 501 — é só o que a tela precisa.
 * - `POST /v1/sessoes/google` devolve a URL do Google (pública: é de quem ainda não entrou).
 * - `GET /v1/sessoes/google/retorno` é a NAVEGAÇÃO de volta, sem JavaScript: autentica-se pelo
 *   `state` assinado. Sessão aberta = cookie na resposta + redirecionamento para a raiz, como o
 *   login por senha; o token nunca vai ao corpo nem à URL. Erro = `/?google=erro&motivo=…`, com
 *   um motivo de lista fechada; a frase é da tela.
 * - `GET|POST|DELETE /v1/eu/google`: a ligação de quem já está dentro.
 *
 * Com o recurso DESLIGADO (`PROCESSOVIVO_LOGIN_GOOGLE_HABILITADO=false`, o padrão) `servico` é
 * indefinido: as rotas de ação respondem 404 (`indisponivel`) e nada mais existe.
 */
export function rotasDoLoginGoogle(
  servico: ServicoLoginGoogle | undefined,
  opcoes: { readonly cookieSeguro: boolean },
): FastifyPluginAsync {
  return async (servidor) => {
    function exigir(): ServicoLoginGoogle {
      if (!servico) {
        throw new LoginGoogleRecusadoError(
          'indisponivel',
          'O login com Google não está habilitado neste servidor.',
        );
      }
      return servico;
    }
    function exigirUsuario(req: FastifyRequest): Usuario {
      if (!req.usuario) throw new SessaoInvalidaError();
      return req.usuario;
    }

    servidor.get(ROTA_LOGIN_GOOGLE, async () => ({ disponivel: servico !== undefined }));

    servidor.post(ROTA_LOGIN_GOOGLE, async () => exigir().iniciarLogin());

    servidor.get(ROTA_LOGIN_GOOGLE_RETORNO, async (req, reply) => {
      const s = exigir();
      const q = consultaDoRetorno.parse(req.query);
      // A página de retorno tem o código na URL: nunca guardar nem repassar como referência.
      void reply
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer');

      if (q.error !== undefined || q.code === undefined || q.state === undefined) {
        if (q.state !== undefined) s.descartar(q.state);
        return reply.redirect('/?google=erro&motivo=negado');
      }
      const r = await s.concluir({
        codigo: q.code,
        estado: q.state,
        ...(req.usuario ? { usuarioDaSessao: req.usuario } : {}),
      });
      if (!r.ok) return reply.redirect(`/?google=erro&motivo=${r.motivo}`);
      if (r.tipo === 'ligada') return reply.redirect('/?google=ligada');
      // Mesmo cookie do login por senha: HttpOnly, SameSite=Lax, `__Host-` em HTTPS.
      void reply.header(
        'set-cookie',
        cookieDeSessao(r.sessao.token, { seguro: opcoes.cookieSeguro }),
      );
      return reply.redirect(r.contaNova ? '/?google=conta-nova' : '/?google=ok');
    });

    servidor.get('/v1/eu/google', async (req) => {
      const usuario = exigirUsuario(req);
      if (!servico)
        return { disponivel: false, ligada: false, ligadaEm: null, temSenha: true };
      const s = await servico.situacao(usuario);
      return {
        disponivel: true,
        ligada: s.ligada,
        ligadaEm: s.ligadaEm?.toISOString() ?? null,
        temSenha: s.temSenha,
      };
    });

    servidor.post('/v1/eu/google', async (req) =>
      exigir().iniciarLigacao(exigirUsuario(req)),
    );

    servidor.delete('/v1/eu/google', async (req) => {
      await exigir().desligar(exigirUsuario(req));
      return { desligada: true };
    });
  };
}
