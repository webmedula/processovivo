import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServicoContas, SessaoAberta } from '../../../application/services/ServicoContas.js';
import type { ServicoPecas } from '../../../application/services/ServicoPecas.js';
import type { Usuario } from '../../../domain/entities/Usuario.js';
import {
  OperacaoNaoSuportadaError,
  SessaoInvalidaError,
} from '../../../domain/errors/index.js';
import { cookieDeSaida, cookieDeSessao } from '../../../infrastructure/seguranca/sessao.js';
import { TAMANHO_MINIMO_SENHA } from '../../../infrastructure/seguranca/senha.js';

export const ROTA_CONTAS = '/v1/contas';
export const ROTA_SESSOES = '/v1/sessoes';
export const ROTA_RECUPERAR = '/v1/senha/recuperar';
export const ROTA_REDEFINIR = '/v1/senha/redefinir';

const corpoCadastro = z.object({
  nome: z.string().trim().min(2).max(120),
  email: z.string().trim().min(5).max(200),
  senha: z.string().min(TAMANHO_MINIMO_SENHA).max(200),
});

const corpoEntrada = z.object({
  email: z.string().trim().min(1).max(200),
  senha: z.string().min(1).max(200),
});

const corpoPerfil = z.object({
  nome: z.string().trim().min(2).max(120).optional(),
  oab: z.string().trim().min(1).max(20).optional(),
  ufOab: z.string().trim().length(2).optional(),
});

const corpoPedidoRecuperacao = z.object({
  email: z.string().trim().min(1).max(200),
});

const corpoRedefinicao = z.object({
  token: z.string().min(10).max(200),
  senhaNova: z.string().min(TAMANHO_MINIMO_SENHA).max(200),
});

const corpoTrocaDeSenha = z.object({
  senhaAtual: z.string().min(1).max(200),
  senhaNova: z.string().min(TAMANHO_MINIMO_SENHA).max(200),
});

/**
 * O que a conta já destravou.
 *
 * Existe porque o cadastro é PROGRESSIVO: a pessoa entra com e-mail e senha e
 * já consulta processo; informa a OAB e ganha a vigilância; cadastra o acesso
 * no tribunal e ganha as peças. Pedir tudo na primeira tela afastaria metade
 * das pessoas antes de o produto mostrar qualquer valor.
 *
 * A trilha é calculada no servidor, e não montada na tela, para que interface,
 * e-mail de boas-vindas e qualquer cliente futuro concordem sobre o que falta.
 */
interface Trilha {
  readonly conta: boolean;
  readonly oab: boolean;
  readonly tribunal: boolean;
}

export function rotasDeContas(
  contas: ServicoContas | undefined,
  pecas: ServicoPecas | undefined,
  opcoes: { readonly cookieSeguro: boolean },
): FastifyPluginAsync {
  return async (servidor) => {
    function exigirServico(): ServicoContas {
      if (!contas) {
        // 501, e NÃO 401: dizer "sua sessão expirou" mandaria a pessoa fazer
        // login num laço infinito, quando o que há é servidor sem banco.
        throw new OperacaoNaoSuportadaError(
          'contas',
          'cadastrar',
          'o cadastro de contas não está disponível neste servidor',
        );
      }
      return contas;
    }

    function exigirUsuario(req: FastifyRequest): Usuario {
      if (!req.usuario) throw new SessaoInvalidaError();
      return req.usuario;
    }

    async function trilhaDe(usuario: Usuario): Promise<Trilha> {
      // A credencial de tribunal mora noutro serviço, e é assim que deve ser:
      // ela é por workspace, não por pessoa — um escritório com vários sócios
      // compartilha o ambiente e o acesso ao Projudi.
      const credenciais = pecas
        ? await pecas.listarCredenciais(usuario.workspace).catch(() => [])
        : [];
      return {
        conta: true,
        oab: usuario.temOab,
        tribunal: credenciais.length > 0,
      };
    }

    /**
     * Devolve a sessão como COOKIE, nunca no corpo.
     *
     * Se o token voltasse no JSON, o console poderia guardá-lo no
     * `localStorage` — e aí qualquer XSS passaria a valer roubo de sessão,
     * desfazendo o `HttpOnly` inteiro.
     */
    function responderSessao(resposta: FastifyReply, sessao: SessaoAberta): unknown {
      void resposta.header(
        'set-cookie',
        cookieDeSessao(sessao.token, { seguro: opcoes.cookieSeguro }),
      );
      return { usuario: sessao.usuario.toJSON() };
    }

    servidor.post(ROTA_CONTAS, async (req, resposta) => {
      const dados = corpoCadastro.parse(req.body);
      const sessao = await exigirServico().cadastrar(dados);
      void resposta.code(201);
      return responderSessao(resposta, sessao);
    });

    servidor.post(ROTA_SESSOES, async (req, resposta) => {
      const { email, senha } = corpoEntrada.parse(req.body);
      const sessao = await exigirServico().entrar(email, senha);
      return responderSessao(resposta, sessao);
    });

    servidor.delete(ROTA_SESSOES, async (req, resposta) => {
      if (req.tokenDeSessao) await exigirServico().sair(req.tokenDeSessao);
      // O cookie é apagado mesmo se a sessão já não existia: sair tem que
      // funcionar sempre, inclusive depois de a sessão expirar sozinha.
      void resposta.header('set-cookie', cookieDeSaida({ seguro: opcoes.cookieSeguro }));
      return { ok: true };
    });

    servidor.get('/v1/eu', async (req) => {
      const usuario = exigirUsuario(req);
      return { usuario: usuario.toJSON(), trilha: await trilhaDe(usuario) };
    });

    servidor.patch('/v1/eu', async (req) => {
      const usuario = exigirUsuario(req);
      const perfil = corpoPerfil.parse(req.body);
      const atualizado = await exigirServico().atualizarPerfil(usuario, perfil);
      return { usuario: atualizado.toJSON(), trilha: await trilhaDe(atualizado) };
    });

    /**
     * Pede o link de recuperação.
     *
     * Responde **sempre 202 e sempre a mesma coisa** — conta existente,
     * inexistente, e-mail malformado, limite estourado ou SMTP fora do ar. Esta
     * rota é pública e não exige nada: qualquer diferença observável a
     * transformaria no verificador de assinantes mais cômodo que existe, melhor
     * até que o login, porque nem senha precisa.
     */
    /**
     * A recuperação existe NESTE servidor?
     *
     * A tela de entrada pergunta antes de mostrar o "esqueci minha senha".
     * Mostrar o link sempre e falhar depois seria pior do que não ter: quem
     * perdeu a senha ficaria esperando um e-mail que nunca sai.
     *
     * Responde sobre o SERVIDOR, não sobre uma conta — nenhum e-mail entra
     * aqui, então não há o que enumerar. E devolve `false` (não 501) com o
     * servidor sem banco: o console só precisa saber se desenha o link.
     */
    servidor.get(ROTA_RECUPERAR, async () => {
      return { disponivel: contas?.podeRecuperarSenha === true };
    });

    servidor.post(ROTA_RECUPERAR, async (req, resposta) => {
      const { email } = corpoPedidoRecuperacao.parse(req.body);
      await exigirServico().pedirRecuperacao(email);
      void resposta.code(202);
      return {
        mensagem:
          'Se houver uma conta com este e-mail, enviamos um link para redefinir ' +
          'a senha. Confira também a caixa de spam.',
      };
    });

    servidor.post(ROTA_REDEFINIR, async (req, resposta) => {
      const { token, senhaNova } = corpoRedefinicao.parse(req.body);
      const sessao = await exigirServico().redefinirSenha(token, senhaNova);
      // Já entra: a pessoa acabou de provar que tem a caixa de e-mail dela e
      // escolheu uma senha. Mandá-la para a tela de login seria atrito puro.
      return responderSessao(resposta, sessao);
    });

    servidor.post('/v1/eu/senha', async (req, resposta) => {
      const usuario = exigirUsuario(req);
      const { senhaAtual, senhaNova } = corpoTrocaDeSenha.parse(req.body);
      const sessao = await exigirServico().trocarSenha(usuario, senhaAtual, senhaNova);
      // A troca derrubou TODAS as sessões, inclusive esta. O cookie novo
      // reconecta quem está na tela — as outras ficam para trás, que é o
      // objetivo de quem troca a senha por desconfiança.
      return responderSessao(resposta, sessao);
    });
  };
}
