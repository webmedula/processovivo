import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../domain/ports/Logger.js';
import type { Clock } from '../../../domain/ports/Clock.js';
import { clockDoSistema } from '../../../domain/ports/Clock.js';
import type { CredencialDoAdmin } from '../adminAuth.js';
import { LimiteDeTentativasDoAdmin } from '../limiteDeTentativasDoAdmin.js';
import {
  autorDoRestrito,
  identificarOperador,
  rotuloDoAutor,
} from '../operadorDoAdmin.js';

export interface IdentidadeDoAdmin {
  readonly papel: 'dono' | 'restrito';
  /** Só o nome de usuário — a senha nunca sai desta função. */
  readonly usuario: string;
  /** Como a pessoa vai para as tabelas de auditoria (ver `operadorDoAdmin.ts`). */
  readonly autor: string;
  /** Como a pessoa aparece nas telas ("dono" ou o nome do restrito). */
  readonly por: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Quem entrou no /admin nesta requisição (HTTP Basic já conferido). */
    adminIdentidade?: IdentidadeDoAdmin;
  }
}

export interface OpcoesAutenticacaoAdmin {
  readonly dono: CredencialDoAdmin;
  readonly restritos?: readonly CredencialDoAdmin[];
  readonly logger: Logger;
  readonly limite?: LimiteDeTentativasDoAdmin;
  readonly clock?: Clock;
}

interface Entrada {
  readonly identidade: IdentidadeDoAdmin;
  readonly resumoDoUsuario: Buffer;
  readonly resumoDaSenha: Buffer;
}

const sha256 = (texto: string): Buffer => createHash('sha256').update(texto).digest();

/**
 * HTTP Basic Auth para a área administrativa — o dono (`PROCESSOVIVO_ADMIN_USUARIO`/`_SENHA`) e os administradores
 * restritos (`PROCESSOVIVO_ADMIN_RESTRITOS`, v0.62.0). Esta função SÓ AUTENTICA e põe a identidade na requisição; quem
 * decide o que cada identidade pode abrir é o hook de autorização por aba de `rotas/admin.ts`.
 *
 * **Por que Basic Auth, e não sessão de cookie igual ao console do assinante:** o `CLAUDE.md` já registra por que este
 * sistema nunca inventou "administrador" como campo na tabela `usuarios` — faria de um cadastro aberto uma escalada de
 * privilégio. Basic Auth resolve com credenciais fixas de variável de ambiente, um hook, e zero linha tocando
 * `usuarios` ou `sessoes`.
 *
 * **Tempo constante, inclusive para usuário inexistente:** usuário e senha viram SHA-256 e são comparados com TODAS as
 * entradas, sempre, sem parar na primeira que casa. Usuário que não existe custa o mesmo que senha errada de usuário
 * que existe — não dá para descobrir quais usuários existem medindo o tempo da negação.
 *
 * **Por que isto é uma função comum, e não um plugin registrado com `fastify.register()`:** `register()` cria um
 * contexto filho, e um hook adicionado lá dentro não vale para rotas irmãs. `rotasDeAdmin` passa a SUA instância.
 */
export function autenticacaoAdmin(
  app: FastifyInstance,
  opcoes: OpcoesAutenticacaoAdmin,
): void {
  const limite =
    opcoes.limite ??
    new LimiteDeTentativasDoAdmin({ clock: opcoes.clock ?? clockDoSistema });
  const clock = opcoes.clock ?? clockDoSistema;
  const entradas: Entrada[] = [
    {
      identidade: {
        papel: 'dono',
        usuario: opcoes.dono.usuario,
        autor: identificarOperador(opcoes.dono.usuario),
        por: rotuloDoAutor(identificarOperador(opcoes.dono.usuario)),
      },
      resumoDoUsuario: sha256(opcoes.dono.usuario),
      resumoDaSenha: sha256(opcoes.dono.senha),
    },
    ...(opcoes.restritos ?? []).map((r) => ({
      identidade: {
        papel: 'restrito' as const,
        usuario: r.usuario,
        autor: autorDoRestrito(r.usuario),
        por: r.usuario,
      },
      resumoDoUsuario: sha256(r.usuario),
      resumoDaSenha: sha256(r.senha),
    })),
  ];

  app.addHook('onRequest', async (requisicao, resposta) => {
    const desafio = (): void => {
      // Valor do cabeçalho tem de ser ASCII puro — Node recusa com ERR_INVALID_CHAR qualquer caractere fora de
      // Latin-1/ASCII aqui (nada de travessão ou acento).
      void resposta.header(
        'www-authenticate',
        'Basic realm="Processo Vivo - area administrativa", charset="UTF-8"',
      );
    };

    if (limite.bloqueado(requisicao.ip)) {
      void resposta.header('retry-after', '900');
      return resposta.code(429).send({
        erro: 'LIMITE_EXCEDIDO',
        mensagem: 'Muitas tentativas. Tente novamente em alguns minutos.',
      });
    }

    const credencial = lerBasic(requisicao.headers.authorization);
    if (!credencial) {
      // Sem cabeçalho: é o navegador descobrindo que a página pede senha. Nem conta como erro nem vai ao log.
      desafio();
      return resposta.code(401).send({
        erro: 'NAO_AUTENTICADO',
        mensagem: 'Credencial administrativa ausente ou inválida.',
      });
    }

    const resumoDoUsuario = sha256(credencial.usuario);
    const resumoDaSenha = sha256(credencial.senha);
    let achada: Entrada | undefined;
    for (const e of entradas) {
      // Sem curto-circuito: as duas comparações e todas as entradas rodam sempre.
      const usuarioOk = timingSafeEqual(resumoDoUsuario, e.resumoDoUsuario);
      const senhaOk = timingSafeEqual(resumoDaSenha, e.resumoDaSenha);
      if (usuarioOk && senhaOk && achada === undefined) achada = e;
    }

    if (!achada) {
      limite.registrarErro(requisicao.ip);
      // Só o instante e o IP: nem o usuário digitado (pode ser uma senha no campo errado) nem a senha.
      opcoes.logger.warn('acesso administrativo recusado', {
        ip: requisicao.ip,
        em: clock.agora().toISOString(),
      });
      desafio();
      return resposta.code(401).send({
        erro: 'NAO_AUTENTICADO',
        mensagem: 'Credencial administrativa ausente ou inválida.',
      });
    }

    requisicao.adminIdentidade = achada.identidade;
  });
}

function lerBasic(
  cabecalho: string | undefined,
): { usuario: string; senha: string } | undefined {
  if (!cabecalho || !cabecalho.startsWith('Basic ')) return undefined;

  let decodificado: string;
  try {
    decodificado = Buffer.from(cabecalho.slice('Basic '.length), 'base64').toString(
      'utf8',
    );
  } catch {
    return undefined;
  }

  const indice = decodificado.indexOf(':');
  if (indice === -1) return undefined;
  return {
    usuario: decodificado.slice(0, indice),
    senha: decodificado.slice(indice + 1),
  };
}
