import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LocalizadorDeWorkspace } from '../../../application/services/LocalizadorDeWorkspace.js';
import type { ServicoAssinaturas } from '../../../application/services/ServicoAssinaturas.js';
import type { ServicoChavesApi } from '../../../application/services/ServicoChavesApi.js';
import type { ServicoPagamentos } from '../../../application/services/ServicoPagamentos.js';
import type {
  MudancasNoPlano,
  ServicoPlanos,
} from '../../../application/services/ServicoPlanos.js';
import type { ServicoControleDaIa } from '../../../application/services/ServicoControleDaIa.js';
import type { ServicoModelosDeIa } from '../../../application/services/ServicoModelosDeIa.js';
import type { ServicoTesteDeModelo } from '../../../application/services/ServicoTesteDeModelo.js';
import { modelosParaJson, testeParaJson } from './modelosDeIaJson.js';
import { ROTAS_ADMIN_INSTRUCOES, rotasDeInstrucoesDeIa } from './adminInstrucoesDeIa.js';
import type { ServicoErrosDeInstrucoes } from '../../../application/services/ServicoErrosDeInstrucoes.js';
import type { ServicoExperimentoDeInstrucoes } from '../../../application/services/ServicoExperimentoDeInstrucoes.js';
import type { ServicoInstrucoesDeIa } from '../../../application/services/ServicoInstrucoesDeIa.js';
import type { ServicoVerificacaoDeInstrucoes } from '../../../application/services/ServicoVerificacaoDeInstrucoes.js';
import {
  PERIODOS_DO_PAINEL,
  type PainelDeIa,
  type ServicoPainelDeIa,
} from '../../../application/services/ServicoPainelDeIa.js';
import { rotuloDoAutor } from '../operadorDoAdmin.js';
import type { CredencialDoAdmin } from '../adminAuth.js';
import type { ServicoAdministradores } from '../../../application/services/ServicoAdministradores.js';
import {
  ABAS_DO_ADMIN,
  ABA_ADMINISTRADORES,
  ROTULO_DA_ABA,
  type AbaDoAdmin,
} from '../../../domain/entities/AbasDoAdmin.js';
import type { Logger } from '../../../domain/ports/Logger.js';
import { RECURSOS } from '../../../domain/entities/Plano.js';
import type { CicloDoPlano, RecursoDoPlano } from '../../../domain/entities/Plano.js';
import type { RepositorioAssinaturas } from '../../../domain/ports/RepositorioAssinaturas.js';
import type { RepositorioUsuarios } from '../../../domain/ports/RepositorioUsuarios.js';
import { VERSAO } from '../../../infrastructure/config/versao.js';
import { paginaAdmin } from '../ui/paginaAdmin.js';
import { autenticacaoAdmin } from '../plugins/autenticacaoAdmin.js';

export const ROTA_ADMIN = '/admin';
export const ROTA_ADMIN_ASSINATURAS = '/admin/api/assinaturas';
export const ROTA_ADMIN_ASSINATURA_POR_EMAIL = '/admin/api/assinaturas/:email';
export const ROTA_ADMIN_ASSINATURA_LIBERAR = '/admin/api/assinaturas/:email/liberar';
export const ROTA_ADMIN_ASSINATURA_CANCELAR = '/admin/api/assinaturas/:email/cancelar';
/** Por workspace (conta de chave de API não tem e-mail): ver `LocalizadorDeWorkspace`. */
export const ROTA_ADMIN_ASSINATURA_POR_WORKSPACE =
  '/admin/api/workspaces/:workspace/assinatura';
export const ROTA_ADMIN_ASSINATURA_LIBERAR_POR_WORKSPACE =
  '/admin/api/workspaces/:workspace/assinatura/liberar';
export const ROTA_ADMIN_ASSINATURAS_AVISAR = '/admin/api/assinaturas/avisar';
export const ROTA_ADMIN_CHAVES = '/admin/api/chaves';
export const ROTA_ADMIN_CHAVE_REVOGAR = '/admin/api/chaves/:identificador/revogar';
export const ROTA_ADMIN_PLANOS = '/admin/api/planos';
export const ROTA_ADMIN_PLANO = '/admin/api/planos/:codigo';
export const ROTA_ADMIN_REGRAS = '/admin/api/regras';
/** Cobrança recorrente (v0.44.0): o ambiente do gateway e a reconciliação. */
export const ROTA_ADMIN_PAGAMENTO = '/admin/api/pagamento';
export const ROTA_ADMIN_PAGAMENTO_RECONCILIAR = '/admin/api/pagamento/reconciliar';
/** Painel de IA (v0.58.0): observar e controlar a IA. Só o operador do /admin chega aqui. */
export const ROTA_ADMIN_IA = '/admin/api/ia';
export const ROTA_ADMIN_IA_ALERTA = '/admin/api/ia/alerta';
export const ROTA_ADMIN_IA_FUNCAO = '/admin/api/ia/funcoes/:funcao';
export const ROTA_ADMIN_IA_FUNCAO_TETO = '/admin/api/ia/funcoes/:funcao/teto';
export const ROTA_ADMIN_IA_TETO_GLOBAL = '/admin/api/ia/teto-global';
/** Modelo por função e teste obrigatório (Fase B, v0.60.0). */
export const ROTA_ADMIN_IA_MODELOS = '/admin/api/ia/modelos';
export const ROTA_ADMIN_IA_MODELOS_ESTIMATIVA =
  '/admin/api/ia/modelos/:funcao/estimativa';
export const ROTA_ADMIN_IA_MODELOS_TESTES = '/admin/api/ia/modelos/:funcao/testes';
export const ROTA_ADMIN_IA_MODELOS_PUBLICAR = '/admin/api/ia/modelos/:funcao/publicar';
export const ROTA_ADMIN_IA_MODELOS_REVERTER = '/admin/api/ia/modelos/:funcao/reverter';
export const ROTA_ADMIN_IA_MODELOS_TESTE = '/admin/api/ia/modelos/testes/:id';
export const ROTA_ADMIN_IA_MODELOS_CANCELAR = '/admin/api/ia/modelos/testes/:id/cancelar';

/**
 * Catálogo de planos que a aba Assinaturas usa para escolher o plano a liberar (v0.62.0). Antes essa aba lia
 * `GET /admin/api/planos`, que é da aba Planos e traz as contagens de assinantes por plano; com as abas separadas por
 * usuário, cada aba tem de bastar-se com as suas rotas.
 */
export const ROTA_ADMIN_ASSINATURAS_PLANOS = '/admin/api/assinaturas/planos';
/** A tela "Administradores" (v0.62.0): só o dono. */
export const ROTA_ADMIN_ADMINISTRADORES = '/admin/api/administradores';
export const ROTA_ADMIN_ADMINISTRADOR_ABAS = '/admin/api/administradores/:usuario/abas';
/**
 * Pega-tudo de tudo o que é do `/admin` e não é rota conhecida. Para o dono vira o 404 de sempre; para o restrito é o
 * MESMO 403 de uma aba não liberada — aba que não existe e aba que existe e está fechada são indistinguíveis.
 */
export const ROTA_ADMIN_CURINGA = '/admin/*';

/**
 * A quem cada rota do /admin pertence (v0.62.0) — a ÚNICA fonte da regra "quem pode chamar o quê":
 *
 * - uma aba (`AbaDoAdmin`): o dono sempre pode; o restrito só se o dono liberou ESSA aba;
 * - `'administradores'`: só o dono (a aba de permissões nunca é liberável);
 * - `'qualquer'`: a casca da página, aberta a qualquer usuário autenticado — ela mesma só desenha o que o usuário pode;
 * - `'inexistente'`: o pega-tudo; só o dono chega, e recebe 404.
 *
 * Toda rota nova do /admin PRECISA entrar aqui: a montagem recusa (e o servidor não sobe) rota sem aba declarada.
 * Uma rota, exatamente uma aba. Esconder do menu não protege nada; quem protege é o hook de `rotasDeAdmin`.
 */
export type DestinoDaRotaDoAdmin =
  AbaDoAdmin | typeof ABA_ADMINISTRADORES | 'qualquer' | 'inexistente';

export const ROTAS_DO_ADMIN: ReadonlyArray<{
  readonly rota: string;
  readonly destino: DestinoDaRotaDoAdmin;
}> = [
  { rota: ROTA_ADMIN, destino: 'qualquer' },
  { rota: ROTA_ADMIN_ASSINATURAS, destino: 'assinaturas' },
  { rota: ROTA_ADMIN_ASSINATURAS_PLANOS, destino: 'assinaturas' },
  { rota: ROTA_ADMIN_ASSINATURA_POR_EMAIL, destino: 'assinaturas' },
  { rota: ROTA_ADMIN_ASSINATURA_LIBERAR, destino: 'assinaturas' },
  { rota: ROTA_ADMIN_ASSINATURA_CANCELAR, destino: 'assinaturas' },
  { rota: ROTA_ADMIN_ASSINATURA_POR_WORKSPACE, destino: 'assinaturas' },
  { rota: ROTA_ADMIN_ASSINATURA_LIBERAR_POR_WORKSPACE, destino: 'assinaturas' },
  { rota: ROTA_ADMIN_ASSINATURAS_AVISAR, destino: 'assinaturas' },
  // A cobrança (ambiente, faixa de TESTE, reconciliação) é mostrada dentro da aba Assinaturas.
  { rota: ROTA_ADMIN_PAGAMENTO, destino: 'assinaturas' },
  { rota: ROTA_ADMIN_PAGAMENTO_RECONCILIAR, destino: 'assinaturas' },
  { rota: ROTA_ADMIN_PLANOS, destino: 'planos' },
  { rota: ROTA_ADMIN_PLANO, destino: 'planos' },
  { rota: ROTA_ADMIN_REGRAS, destino: 'planos' },
  { rota: ROTA_ADMIN_CHAVES, destino: 'chaves' },
  { rota: ROTA_ADMIN_CHAVE_REVOGAR, destino: 'chaves' },
  { rota: ROTA_ADMIN_IA, destino: 'ia' },
  { rota: ROTA_ADMIN_IA_ALERTA, destino: 'ia' },
  { rota: ROTA_ADMIN_IA_FUNCAO, destino: 'ia' },
  { rota: ROTA_ADMIN_IA_FUNCAO_TETO, destino: 'ia' },
  { rota: ROTA_ADMIN_IA_TETO_GLOBAL, destino: 'ia' },
  { rota: ROTA_ADMIN_IA_MODELOS, destino: 'ia' },
  { rota: ROTA_ADMIN_IA_MODELOS_ESTIMATIVA, destino: 'ia' },
  { rota: ROTA_ADMIN_IA_MODELOS_TESTES, destino: 'ia' },
  { rota: ROTA_ADMIN_IA_MODELOS_PUBLICAR, destino: 'ia' },
  { rota: ROTA_ADMIN_IA_MODELOS_REVERTER, destino: 'ia' },
  { rota: ROTA_ADMIN_IA_MODELOS_TESTE, destino: 'ia' },
  { rota: ROTA_ADMIN_IA_MODELOS_CANCELAR, destino: 'ia' },
  ...ROTAS_ADMIN_INSTRUCOES.map((rota) => ({ rota, destino: 'ia' as const })),
  { rota: ROTA_ADMIN_ADMINISTRADORES, destino: ABA_ADMINISTRADORES },
  { rota: ROTA_ADMIN_ADMINISTRADOR_ABAS, destino: ABA_ADMINISTRADORES },
  { rota: ROTA_ADMIN_CURINGA, destino: 'inexistente' },
];

const DESTINO_POR_ROTA: ReadonlyMap<string, DestinoDaRotaDoAdmin> = new Map(
  ROTAS_DO_ADMIN.map((r) => [r.rota, r.destino]),
);

/** Toda rota administrativa — para `rotasPublicas` do plugin de autenticação do assinante. */
export const ROTAS_ADMIN: readonly string[] = ROTAS_DO_ADMIN.map((r) => r.rota);

const corpoLiberar = z.object({
  // Só a forma aqui. Se o plano EXISTE é pergunta ao catálogo, que agora é
  // dado — `ServicoAssinaturas.liberar` responde com `PlanoDesconhecidoError`.
  plano: z.string().trim().min(1).max(30),
  meses: z.coerce.number().int().min(1).max(60),
  observacao: z.string().trim().min(1).max(200).optional(),
});

const corpoCancelar = z.object({
  observacao: z.string().trim().min(1).max(200).optional(),
});

const corpoEmitirChave = z.object({
  rotulo: z.string().trim().min(1).max(60),
});

/*
 * Os corpos de plano validam só o FORMATO (tipos, inteiros). O conteúdo —
 * código no padrão, recurso conhecido, preço no intervalo, "não vende recurso
 * que não existe" — é de `validarPlano`, no domínio, para valer igual venha o
 * pedido daqui, do CLI ou de um teste. Duas cópias da regra divergiriam.
 */
const precoEmCentavos = z.number().int().nullable();

const corpoCriarPlano = z.object({
  codigo: z.string(),
  nome: z.string(),
  resumo: z.string(),
  recursos: z.array(z.string()),
  disponivelParaContratacao: z.boolean(),
  precoMensalCentavos: precoEmCentavos,
  ordem: z.number().int().optional(),
  ciclo: z.string().optional(),
});

const corpoAlterarPlano = z.object({
  nome: z.string().optional(),
  resumo: z.string().optional(),
  recursos: z.array(z.string()).optional(),
  disponivelParaContratacao: z.boolean().optional(),
  precoMensalCentavos: precoEmCentavos.optional(),
  ordem: z.number().int().optional(),
  ciclo: z.string().optional(),
});

const consultaDoPainelDeIa = z.object({
  periodo: z.enum(PERIODOS_DO_PAINEL).default('hoje'),
});
const corpoFuncaoDeIa = z
  .object({ ligada: z.boolean(), confirmado: z.boolean().optional() })
  .strict();
const corpoTetoDeIa = z.object({ teto: z.number().int().nullable() }).strict();
const corpoAlertaDeIa = z.object({ valorUsd: z.number() }).strict();

const corpoDoCandidato = z
  .object({ candidato: z.string().trim().min(1).max(120) })
  .strict();
const corpoDoTeste = z
  .object({
    candidato: z.string().trim().min(1).max(120),
    confirmado: z.boolean().optional(),
  })
  .strict();
const corpoDaPublicacao = z
  .object({
    testeId: z.string().trim().min(1).max(64),
    confirmado: z.boolean().optional(),
    palavra: z.string().max(40).optional(),
    motivo: z.string().max(40).optional(),
    observacao: z.string().max(200).optional(),
  })
  .strict();
const corpoDaReversao = z.object({ confirmado: z.boolean().optional() }).strict();

const corpoDasAbas = z
  .object({
    abas: z.array(z.string().max(40)).max(20),
    confirmado: z.boolean().optional(),
  })
  .strict();

const corpoReconciliar = z.object({
  workspace: z.string().trim().min(1).max(40).optional(),
});

const corpoRegras = z.object({
  diasDeTeste: z.number().int(),
  planoDoTeste: z.string(),
  diasDeCarencia: z.number().int(),
});

/** Recurso desconhecido passa daqui e é recusado, com nome, em `validarPlano`. */
function comoRecursos(lista: readonly string[]): RecursoDoPlano[] {
  return lista as RecursoDoPlano[];
}

export interface OpcoesRotasAdmin {
  /** `undefined` quando `PROCESSOVIVO_ADMIN_USUARIO`/`_SENHA` não estão configuradas. */
  readonly credenciais?: { readonly usuario: string; readonly senha: string };
  /** Administradores restritos (v0.62.0), de `PROCESSOVIVO_ADMIN_RESTRITOS`. Sem o dono configurado não valem. */
  readonly restritos?: readonly CredencialDoAdmin[];
  /** Permissões por aba dos restritos (v0.62.0). */
  readonly administradores: ServicoAdministradores;
  readonly logger: Logger;
  readonly assinaturas: ServicoAssinaturas;
  readonly planos: ServicoPlanos;
  readonly repositorioAssinaturas: RepositorioAssinaturas;
  readonly usuarios: RepositorioUsuarios;
  readonly chavesApi: ServicoChavesApi;
  /** Confere o workspace informado por ID (conta de chave de API). */
  readonly localizador: LocalizadorDeWorkspace;
  /** Cobrança recorrente (v0.44.0); `undefined` = desligada. */
  readonly pagamentos?: ServicoPagamentos | undefined;
  /** O servidor está em produção (NODE_ENV)? Só para avisar de token de TESTE em produção. */
  readonly emProducao?: boolean;
  /** Painel de IA (v0.58.0). Ausente = as rotas `/admin/api/ia/*` respondem 404. */
  readonly ia?: {
    readonly controle: ServicoControleDaIa;
    readonly painel: ServicoPainelDeIa;
    /** Fase B (v0.60.0): modelo por função, publicar, reverter e o teste obrigatório. */
    readonly modelos: ServicoModelosDeIa;
    readonly testes: ServicoTesteDeModelo;
    /** Fase C (v0.61.0): instruções editáveis, experimento, conjunto de verificação e "onde a IA erra". */
    readonly instrucoes?: {
      readonly servico: ServicoInstrucoesDeIa;
      readonly experimento: ServicoExperimentoDeInstrucoes;
      readonly verificacao: ServicoVerificacaoDeInstrucoes;
      readonly erros: ServicoErrosDeInstrucoes;
    };
  };
}

/**
 * A área administrativa — só o operador, nunca um assinante.
 *
 * **Autenticação separada de propósito.** Estas rotas entram em
 * `rotasPublicas` no `autenticacao.ts` do assinante (a exemplo do console: são
 * "públicas" do PONTO DE VISTA daquele plugin, porque respondem a outra
 * credencial). Quem de fato as protege é `autenticacaoAdmin`, chamada aqui
 * embaixo sobre esta MESMA instância (`servidor`, a que `servidor.register()`
 * cria para este plugin em `servidor.ts`): o hook que ela adiciona vale só
 * para as rotas declaradas aqui, nunca para o resto do servidor — é o
 * encapsulamento do Fastify, e é o que mantém esta autenticação inteiramente
 * à parte da do assinante, como o `CLAUDE.md` pede.
 *
 * **Sem configurar, responde 501 em vez de 404** — mesma convenção de
 * `rotasDePecas`: dizer "não configurado" é mais honesto do que fingir que a
 * rota não existe, e ninguém sem a credencial chega a ver a diferença mesmo
 * assim, porque a rota também não teria passado pela autenticação.
 *
 * A resposta de "desligada" é montada aqui, e não com
 * `OperacaoNaoSuportadaError`: aquele erro fala a língua das fontes de dados
 * ("o provider X não suporta a operação Y"), e na v0.27.0 isso chegava à
 * tela do operador como uma frase sem sentido na frente da instrução.
 */
export function rotasDeAdmin(opcoes: OpcoesRotasAdmin): FastifyPluginAsync {
  return async (servidor) => {
    if (!opcoes.credenciais) {
      const desligada = async (
        _req: FastifyRequest,
        resposta: FastifyReply,
      ): Promise<FastifyReply> =>
        resposta.code(501).send({
          erro: 'ADMIN_DESLIGADA',
          mensagem:
            'A área administrativa não está configurada. Defina ' +
            'PROCESSOVIVO_ADMIN_USUARIO e PROCESSOVIVO_ADMIN_SENHA nas variáveis ' +
            'de ambiente e reinicie o serviço.',
        });
      servidor.get(ROTA_ADMIN, desligada);
      servidor.get(ROTA_ADMIN_ASSINATURAS, desligada);
      servidor.get(ROTA_ADMIN_ASSINATURA_POR_EMAIL, desligada);
      servidor.post(ROTA_ADMIN_ASSINATURA_LIBERAR, desligada);
      servidor.get(ROTA_ADMIN_ASSINATURA_POR_WORKSPACE, desligada);
      servidor.post(ROTA_ADMIN_ASSINATURA_LIBERAR_POR_WORKSPACE, desligada);
      servidor.post(ROTA_ADMIN_ASSINATURA_CANCELAR, desligada);
      servidor.post(ROTA_ADMIN_ASSINATURAS_AVISAR, desligada);
      servidor.get(ROTA_ADMIN_CHAVES, desligada);
      servidor.post(ROTA_ADMIN_CHAVES, desligada);
      servidor.post(ROTA_ADMIN_CHAVE_REVOGAR, desligada);
      servidor.get(ROTA_ADMIN_PLANOS, desligada);
      servidor.post(ROTA_ADMIN_PLANOS, desligada);
      servidor.put(ROTA_ADMIN_PLANO, desligada);
      servidor.put(ROTA_ADMIN_REGRAS, desligada);
      servidor.get(ROTA_ADMIN_PAGAMENTO, desligada);
      servidor.post(ROTA_ADMIN_PAGAMENTO_RECONCILIAR, desligada);
      servidor.get(ROTA_ADMIN_IA, desligada);
      servidor.get(ROTA_ADMIN_IA_ALERTA, desligada);
      servidor.put(ROTA_ADMIN_IA_ALERTA, desligada);
      servidor.put(ROTA_ADMIN_IA_FUNCAO, desligada);
      servidor.put(ROTA_ADMIN_IA_FUNCAO_TETO, desligada);
      servidor.put(ROTA_ADMIN_IA_TETO_GLOBAL, desligada);
      servidor.get(ROTA_ADMIN_ASSINATURAS_PLANOS, desligada);
      servidor.get(ROTA_ADMIN_ADMINISTRADORES, desligada);
      servidor.put(ROTA_ADMIN_ADMINISTRADOR_ABAS, desligada);
      return;
    }

    // Toda rota registrada daqui para baixo TEM de constar em `ROTAS_DO_ADMIN` (com a aba a que pertence): rota nova
    // sem aba declarada derruba a montagem em vez de ficar acessível sem dono.
    servidor.addHook('onRoute', (rota) => {
      if (!DESTINO_POR_ROTA.has(rota.url)) {
        throw new Error(
          `A rota ${rota.url} do /admin não declara a que aba pertence (ROTAS_DO_ADMIN).`,
        );
      }
    });

    autenticacaoAdmin(servidor, {
      dono: opcoes.credenciais,
      ...(opcoes.restritos ? { restritos: opcoes.restritos } : {}),
      logger: opcoes.logger,
    });

    // Autorização por aba, no SERVIDOR e em toda requisição (sem cache): o efeito de liberar ou tirar uma aba vale na
    // requisição seguinte. Falha ao ler as permissões = o restrito não acessa nada; o dono não depende do banco.
    servidor.addHook('onRequest', async (requisicao, resposta) => {
      const identidade = requisicao.adminIdentidade;
      if (!identidade) return; // a autenticação já respondeu 401
      if (identidade.papel === 'dono') return;

      const rota = requisicao.routeOptions.url ?? '';
      const destino = DESTINO_POR_ROTA.get(rota) ?? 'inexistente';
      if (destino === 'qualquer') return;

      if (destino !== 'inexistente' && destino !== ABA_ADMINISTRADORES) {
        const liberadas = opcoes.administradores.abasDo(identidade.usuario);
        if (liberadas.ok && liberadas.abas.includes(destino)) return;
      }

      opcoes.logger.warn('acesso administrativo negado por aba', {
        usuario: identidade.usuario,
        aba: destino === 'inexistente' ? 'desconhecida' : destino,
        em: new Date().toISOString(),
      });
      return resposta.code(403).send({
        erro: 'ACESSO_NEGADO',
        mensagem: 'Este acesso não está liberado para o seu usuário.',
      });
    });

    /** Quem está agindo nesta requisição, para as tabelas de auditoria. */
    const autorDe = (req: FastifyRequest): string => req.adminIdentidade?.autor ?? '';

    /** E-mail cadastrado -> workspace. O operador conhece o e-mail, não o workspace. */
    async function workspaceDe(email: string): Promise<string | undefined> {
      const achado = await opcoes.usuarios.porEmail(email.trim().toLowerCase());
      return achado?.usuario.workspace;
    }

    function contaNaoEncontrada(): { erro: string; mensagem: string } {
      return {
        erro: 'CONTA_NAO_ENCONTRADA',
        mensagem: 'Nenhuma conta cadastrada com este e-mail.',
      };
    }

    servidor.get(ROTA_ADMIN, async (req, resposta) => {
      resposta.header('content-type', 'text/html; charset=utf-8');
      resposta.header('cache-control', 'no-store');
      resposta.header('x-robots-tag', 'noindex');
      const identidade = req.adminIdentidade;
      if (!identidade) return '';
      // Login certo: usuário e instante (a senha nunca). Só na abertura da página, não a cada chamada da API.
      opcoes.logger.info('acesso administrativo', {
        usuario: identidade.usuario,
        em: new Date().toISOString(),
      });
      if (identidade.papel === 'dono') {
        return paginaAdmin(VERSAO, {
          usuario: identidade.usuario,
          papel: 'dono',
          abas: [...ABAS_DO_ADMIN],
          administradores: true,
        });
      }
      opcoes.administradores.registrarAcesso(identidade.usuario);
      const liberadas = opcoes.administradores.abasDo(identidade.usuario);
      return paginaAdmin(VERSAO, {
        usuario: identidade.usuario,
        papel: 'restrito',
        abas: liberadas.ok ? [...liberadas.abas] : [],
        administradores: false,
        ...(liberadas.ok ? {} : { semPermissoes: true }),
      });
    });

    servidor.get(ROTA_ADMIN_ADMINISTRADORES, async (req, resposta) => {
      resposta.header('cache-control', 'no-store');
      return administradoresParaJson(
        opcoes.administradores,
        req.adminIdentidade?.usuario ?? '',
      );
    });

    servidor.put<{ Params: { usuario: string }; Body: unknown }>(
      ROTA_ADMIN_ADMINISTRADOR_ABAS,
      async (req, resposta) => {
        const c = corpoDasAbas.parse(req.body);
        opcoes.administradores.definir(
          autorDe(req),
          req.params.usuario,
          c.abas,
          c.confirmado === true,
        );
        resposta.header('cache-control', 'no-store');
        return administradoresParaJson(
          opcoes.administradores,
          req.adminIdentidade?.usuario ?? '',
        );
      },
    );

    // Só o dono chega aqui (o hook devolve 403 ao restrito, igual a uma aba fechada).
    servidor.all(ROTA_ADMIN_CURINGA, async (_req, resposta) => {
      void resposta.code(404);
      return {
        erro: 'ROTA_NAO_ENCONTRADA',
        mensagem: 'Nenhuma rota para este endereço.',
      };
    });

    // Catálogo mínimo para a aba Assinaturas (ver ROTA_ADMIN_ASSINATURAS_PLANOS): sem contagens, sem recursos.
    servidor.get(ROTA_ADMIN_ASSINATURAS_PLANOS, async () => {
      const [planos, regras] = await Promise.all([
        opcoes.planos.listar(),
        opcoes.planos.regras(),
      ]);
      return {
        planos: planos.map((p) => ({
          codigo: p.codigo,
          nome: p.nome,
          disponivelParaContratacao: p.disponivelParaContratacao,
          precoMensalCentavos: p.precoMensalCentavos,
        })),
        regras: { planoDoTeste: regras.planoDoTeste },
      };
    });

    servidor.get(ROTA_ADMIN_ASSINATURAS, async () => {
      const [todas, catalogo] = await Promise.all([
        opcoes.repositorioAssinaturas.todas(),
        opcoes.planos.listar(),
      ]);
      const nomes = new Map(catalogo.map((p) => [p.codigo, p.nome]));
      const agora = new Date();
      // Cobrança recorrente: a mais recente de cada workspace (as listadas em ordem de criação).
      const cobrancas = new Map<
        string,
        Awaited<ReturnType<ServicoPagamentos['cobrancaDe']>>
      >();
      for (const c of (await opcoes.pagamentos?.todasAsCobrancas()) ?? []) {
        cobrancas.set(c.workspace, c);
      }

      const assinaturas = await Promise.all(
        todas.map(async (a) => {
          const conta = await opcoes.usuarios.porWorkspace(a.workspace);
          return {
            workspace: a.workspace,
            email: conta?.email ?? null,
            plano: a.plano,
            // Código órfão (banco editado à mão) aparece como o próprio código,
            // em vez de derrubar a lista inteira do operador.
            nomeDoPlano: nomes.get(a.plano) ?? a.plano,
            status: a.statusEm(agora),
            venceEm: a.venceEm.toISOString(),
            ehTeste: a.ehTeste,
            observacao: a.observacao ?? null,
            // Origem da liberação: `mercadopago` quando há recorrência no gateway, senão `manual`.
            // Só metadado de cobrança: nunca dado de cartão, CPF, nome ou e-mail do pagador.
            origem: cobrancas.has(a.workspace) ? 'gateway' : 'manual',
            pagamento: cobrancas.has(a.workspace)
              ? pagamentoParaAdmin(cobrancas.get(a.workspace)!)
              : null,
          };
        }),
      );

      return { total: assinaturas.length, assinaturas };
    });

    servidor.get<{ Params: { email: string } }>(
      ROTA_ADMIN_ASSINATURA_POR_EMAIL,
      async (req, resposta) => {
        const ws = await workspaceDe(req.params.email);
        if (!ws) {
          void resposta.code(404);
          return contaNaoEncontrada();
        }
        const resumo = await opcoes.assinaturas.resumo(ws);
        return { email: req.params.email, workspace: ws, assinatura: resumo ?? null };
      },
    );

    servidor.post<{ Params: { email: string }; Body: unknown }>(
      ROTA_ADMIN_ASSINATURA_LIBERAR,
      async (req, resposta) => {
        const dados = corpoLiberar.parse(req.body);
        const ws = await workspaceDe(req.params.email);
        if (!ws) {
          void resposta.code(404);
          return contaNaoEncontrada();
        }

        const a = await opcoes.assinaturas.liberar({
          workspace: ws,
          plano: dados.plano,
          meses: dados.meses,
          ...(dados.observacao !== undefined ? { observacao: dados.observacao } : {}),
        });

        const plano = await opcoes.planos.porCodigo(a.plano);
        void resposta.code(201);
        return {
          email: req.params.email,
          workspace: ws,
          plano: a.plano,
          nomeDoPlano: plano.nome,
          venceEm: a.venceEm.toISOString(),
        };
      },
    );

    /**
     * Assinatura de um workspace pelo ID — o caminho da conta de chave de API, que não tem
     * e-mail. É o mesmo `liberar`/`resumo` do serviço: só muda o identificador. Id malformado
     * é 400 e id que não é de conta nem de chave ativa é 404, sem gravar nada.
     */
    servidor.get<{ Params: { workspace: string } }>(
      ROTA_ADMIN_ASSINATURA_POR_WORKSPACE,
      async (req) => {
        const ws = await opcoes.localizador.confirmar(req.params.workspace);
        const resumo = await opcoes.assinaturas.resumo(ws);
        return { workspace: ws, assinatura: resumo ?? null };
      },
    );

    servidor.post<{ Params: { workspace: string }; Body: unknown }>(
      ROTA_ADMIN_ASSINATURA_LIBERAR_POR_WORKSPACE,
      async (req, resposta) => {
        const dados = corpoLiberar.parse(req.body);
        const ws = await opcoes.localizador.confirmar(req.params.workspace);
        const a = await opcoes.assinaturas.liberar({
          workspace: ws,
          plano: dados.plano,
          meses: dados.meses,
          ...(dados.observacao !== undefined ? { observacao: dados.observacao } : {}),
        });
        const plano = await opcoes.planos.porCodigo(a.plano);
        void resposta.code(201);
        return {
          workspace: ws,
          plano: a.plano,
          nomeDoPlano: plano.nome,
          venceEm: a.venceEm.toISOString(),
        };
      },
    );

    servidor.post<{ Params: { email: string }; Body: unknown }>(
      ROTA_ADMIN_ASSINATURA_CANCELAR,
      async (req, resposta) => {
        const dados = corpoCancelar.parse(req.body ?? {});
        const ws = await workspaceDe(req.params.email);
        if (!ws) {
          void resposta.code(404);
          return contaNaoEncontrada();
        }

        const cancelada = await opcoes.assinaturas.cancelar(ws, dados.observacao);
        if (!cancelada) {
          void resposta.code(404);
          return {
            erro: 'ASSINATURA_NAO_ENCONTRADA',
            mensagem: 'Esta conta não tinha assinatura para cancelar.',
          };
        }
        return {
          email: req.params.email,
          workspace: ws,
          status: cancelada.statusEm(new Date()),
        };
      },
    );

    /**
     * O mesmo que o agendador roda sozinho — aqui para o operador poder
     * disparar na hora, sem esperar o próximo ciclo. Espelha `assinatura
     * avisar` do CLI.
     */
    servidor.post(ROTA_ADMIN_ASSINATURAS_AVISAR, async () => {
      return opcoes.assinaturas.avisarVencimentos();
    });

    servidor.get(ROTA_ADMIN_CHAVES, async () => {
      const chaves = await opcoes.chavesApi.listar();
      return {
        total: chaves.length,
        chaves: chaves.map((c) => ({
          identificador: c.identificador,
          workspace: c.workspace,
          rotulo: c.rotulo,
          criadaEm: c.criadaEm.toISOString(),
          revogadaEm: c.revogadaEm?.toISOString() ?? null,
        })),
      };
    });

    servidor.post<{ Body: unknown }>(ROTA_ADMIN_CHAVES, async (req, resposta) => {
      const { rotulo } = corpoEmitirChave.parse(req.body);
      const emitida = await opcoes.chavesApi.emitir(rotulo);

      void resposta.code(201);
      // A ÚNICA resposta desta rota que carrega `chave` em texto puro. Nunca
      // volta a aparecer — nem no log de acesso, que registra rota e status,
      // não corpo de resposta.
      return {
        chave: emitida.chave,
        identificador: emitida.identificador,
        workspace: emitida.workspace,
        rotulo: emitida.rotulo,
        criadaEm: emitida.criadaEm.toISOString(),
      };
    });

    servidor.post<{ Params: { identificador: string } }>(
      ROTA_ADMIN_CHAVE_REVOGAR,
      async (req) => {
        await opcoes.chavesApi.revogar(req.params.identificador);
        return { revogada: true };
      },
    );

    /**
     * O catálogo inteiro, com quantos assinantes cada plano tem, a lista de
     * recursos que existem (para os formulários) e as regras de teste e
     * carência. Uma chamada só: é tudo o que a aba Planos desenha.
     */
    servidor.get(ROTA_ADMIN_PLANOS, async () => {
      const [planos, regras] = await Promise.all([
        opcoes.planos.visaoGeral(),
        opcoes.planos.regras(),
      ]);
      return { planos, recursos: RECURSOS, regras };
    });

    servidor.post<{ Body: unknown }>(ROTA_ADMIN_PLANOS, async (req, resposta) => {
      const d = corpoCriarPlano.parse(req.body);
      const plano = await opcoes.planos.criar({
        codigo: d.codigo,
        nome: d.nome,
        resumo: d.resumo,
        recursos: comoRecursos(d.recursos),
        disponivelParaContratacao: d.disponivelParaContratacao,
        precoMensalCentavos: d.precoMensalCentavos,
        ...(d.ordem !== undefined ? { ordem: d.ordem } : {}),
        // Valor desconhecido passa daqui e é recusado, com nome, em `validarPlano`.
        ...(d.ciclo !== undefined ? { ciclo: d.ciclo as CicloDoPlano } : {}),
      });
      void resposta.code(201);
      return plano;
    });

    /**
     * Altera o que vier no corpo e mantém o resto. É também o "pausar" e o
     * "colocar à venda": `{ "disponivelParaContratacao": false }`.
     */
    servidor.put<{ Params: { codigo: string }; Body: unknown }>(
      ROTA_ADMIN_PLANO,
      async (req) => {
        const d = corpoAlterarPlano.parse(req.body ?? {});
        // Montado campo a campo: com `exactOptionalPropertyTypes`, uma chave
        // presente com `undefined` não é o mesmo que chave ausente — e o
        // serviço trata "ausente" como "manter".
        const mudancas: MudancasNoPlano = {
          ...(d.nome !== undefined ? { nome: d.nome } : {}),
          ...(d.resumo !== undefined ? { resumo: d.resumo } : {}),
          ...(d.recursos !== undefined ? { recursos: comoRecursos(d.recursos) } : {}),
          ...(d.disponivelParaContratacao !== undefined
            ? { disponivelParaContratacao: d.disponivelParaContratacao }
            : {}),
          ...(d.precoMensalCentavos !== undefined
            ? { precoMensalCentavos: d.precoMensalCentavos }
            : {}),
          ...(d.ordem !== undefined ? { ordem: d.ordem } : {}),
          ...(d.ciclo !== undefined ? { ciclo: d.ciclo as CicloDoPlano } : {}),
        };
        return opcoes.planos.atualizar(req.params.codigo, mudancas);
      },
    );

    servidor.put<{ Body: unknown }>(ROTA_ADMIN_REGRAS, async (req) => {
      const d = corpoRegras.parse(req.body);
      return opcoes.planos.definirRegras(d);
    });

    /**
     * O ambiente da cobrança recorrente, para o painel mostrar "TESTE" em destaque. Com ambiente `teste`
     * em servidor de produção o aviso vem junto (o arranque só o aceita com
     * `PROCESSOVIVO_PAGAMENTO_PERMITIR_TESTE=true`, e o operador precisa ver que é isso que está valendo).
     */
    servidor.get(ROTA_ADMIN_PAGAMENTO, async () => {
      const p = opcoes.pagamentos;
      if (!p) return { habilitado: false };
      const teste = p.ambiente === 'teste' || p.ambiente === 'falso';
      return {
        habilitado: true,
        gateway: p.nomeDoGateway,
        ambiente: p.ambiente,
        modoDeTeste: teste,
        // v0.45.1: a última falha do gateway (quando, onde, código e motivo). Nada do pagador.
        ultimaFalha: await ultimaFalhaParaAdmin(p),
        aviso: teste
          ? opcoes.emProducao
            ? 'ATENÇÃO: o servidor está em PRODUÇÃO com a cobrança em ambiente de TESTE. Nenhum pagamento é real.'
            : 'Modo de TESTE: nenhum pagamento é real.'
          : null,
      };
    });

    // --- Painel de IA (v0.58.0) -------------------------------------------------------------------
    // Só o operador do /admin chega aqui (o hook de Basic Auth vale para todas as rotas deste plugin).
    // Nenhuma resposta leva texto de ato ou de peça, nome, número de processo, e-mail ou chave: só números,
    // rótulos de lista fechada e ids CURTOS de conta. O autor das mudanças é um hash curto do usuário.
    const semPainel = (resposta: FastifyReply): { erro: string; mensagem: string } => {
      void resposta.code(404);
      return {
        erro: 'IA_DESLIGADA',
        mensagem: 'O painel de IA não está disponível neste servidor.',
      };
    };

    servidor.get<{ Querystring: unknown }>(ROTA_ADMIN_IA, async (req, resposta) => {
      const ia = opcoes.ia;
      if (!ia) return semPainel(resposta);
      resposta.header('cache-control', 'no-store');
      const { periodo } = consultaDoPainelDeIa.parse(req.query ?? {});
      return painelParaJson(ia.painel.painel(periodo));
    });

    // Só o necessário para o aviso no topo do /admin, de qualquer aba.
    servidor.get(ROTA_ADMIN_IA_ALERTA, async (_req, resposta) => {
      const ia = opcoes.ia;
      if (!ia) return semPainel(resposta);
      resposta.header('cache-control', 'no-store');
      return ia.painel.custoDoDia();
    });

    servidor.put<{ Body: unknown }>(ROTA_ADMIN_IA_ALERTA, async (req, resposta) => {
      const ia = opcoes.ia;
      if (!ia) return semPainel(resposta);
      const c = corpoAlertaDeIa.parse(req.body);
      ia.controle.definirAlertaDeCusto(autorDe(req), c.valorUsd);
      return ia.painel.custoDoDia();
    });

    servidor.put<{ Params: { funcao: string }; Body: unknown }>(
      ROTA_ADMIN_IA_FUNCAO,
      async (req, resposta) => {
        const ia = opcoes.ia;
        if (!ia) return semPainel(resposta);
        const c = corpoFuncaoDeIa.parse(req.body);
        // Desligar exige `confirmado: true` NO PEDIDO: a confirmação da tela não é só enfeite.
        ia.controle.ligarOuDesligar(
          autorDe(req),
          req.params.funcao,
          c.ligada,
          c.confirmado === true,
        );
        return { estados: ia.controle.estados() };
      },
    );

    servidor.put<{ Params: { funcao: string }; Body: unknown }>(
      ROTA_ADMIN_IA_FUNCAO_TETO,
      async (req, resposta) => {
        const ia = opcoes.ia;
        if (!ia) return semPainel(resposta);
        const c = corpoTetoDeIa.parse(req.body);
        ia.controle.definirTetoDaFuncao(autorDe(req), req.params.funcao, c.teto);
        return { estados: ia.controle.estados() };
      },
    );

    servidor.put<{ Body: unknown }>(ROTA_ADMIN_IA_TETO_GLOBAL, async (req, resposta) => {
      const ia = opcoes.ia;
      if (!ia) return semPainel(resposta);
      const c = corpoTetoDeIa.parse(req.body);
      ia.controle.definirTetoGlobal(autorDe(req), c.teto);
      return { tetoGlobal: ia.controle.config().tetoGlobal };
    });

    // --- Modelo por função (Fase B, v0.60.0) -------------------------------------------------------
    // Só o operador do /admin (o hook de Basic Auth vale para todo o plugin); nenhuma rota pública chama
    // o teste. O id do modelo recebido só é aceito se estiver na lista permitida, e a recusa nunca o repete.
    servidor.get(ROTA_ADMIN_IA_MODELOS, async (_req, resposta) => {
      const ia = opcoes.ia;
      if (!ia) return semPainel(resposta);
      resposta.header('cache-control', 'no-store');
      return modelosParaJson(ia.modelos, ia.testes);
    });

    servidor.post<{ Params: { funcao: string }; Body: unknown }>(
      ROTA_ADMIN_IA_MODELOS_ESTIMATIVA,
      async (req, resposta) => {
        const ia = opcoes.ia;
        if (!ia) return semPainel(resposta);
        const c = corpoDoCandidato.parse(req.body);
        return ia.testes.estimar(req.params.funcao, c.candidato);
      },
    );

    servidor.post<{ Params: { funcao: string }; Body: unknown }>(
      ROTA_ADMIN_IA_MODELOS_TESTES,
      async (req, resposta) => {
        const ia = opcoes.ia;
        if (!ia) return semPainel(resposta);
        const c = corpoDoTeste.parse(req.body);
        const t = ia.testes.iniciar(
          autorDe(req),
          req.params.funcao,
          c.candidato,
          c.confirmado === true,
        );
        void resposta.code(202);
        return testeParaJson(t, ia.modelos.catalogo, ia.modelos.volumeRecente(t.funcao));
      },
    );

    servidor.get<{ Params: { id: string } }>(
      ROTA_ADMIN_IA_MODELOS_TESTE,
      async (req, resposta) => {
        const ia = opcoes.ia;
        if (!ia) return semPainel(resposta);
        resposta.header('cache-control', 'no-store');
        const t = ia.testes.consultar(req.params.id);
        return testeParaJson(t, ia.modelos.catalogo, ia.modelos.volumeRecente(t.funcao));
      },
    );

    servidor.post<{ Params: { id: string } }>(
      ROTA_ADMIN_IA_MODELOS_CANCELAR,
      async (req, resposta) => {
        const ia = opcoes.ia;
        if (!ia) return semPainel(resposta);
        const t = ia.testes.cancelar(req.params.id);
        return testeParaJson(t, ia.modelos.catalogo, ia.modelos.volumeRecente(t.funcao));
      },
    );

    servidor.post<{ Params: { funcao: string }; Body: unknown }>(
      ROTA_ADMIN_IA_MODELOS_PUBLICAR,
      async (req, resposta) => {
        const ia = opcoes.ia;
        if (!ia) return semPainel(resposta);
        const c = corpoDaPublicacao.parse(req.body);
        ia.modelos.publicar(autorDe(req), req.params.funcao, {
          testeId: c.testeId,
          confirmado: c.confirmado === true,
          ...(c.palavra !== undefined ? { palavra: c.palavra } : {}),
          ...(c.motivo !== undefined ? { motivo: c.motivo } : {}),
          ...(c.observacao !== undefined ? { observacao: c.observacao } : {}),
        });
        return modelosParaJson(ia.modelos, ia.testes);
      },
    );

    servidor.post<{ Params: { funcao: string }; Body: unknown }>(
      ROTA_ADMIN_IA_MODELOS_REVERTER,
      async (req, resposta) => {
        const ia = opcoes.ia;
        if (!ia) return semPainel(resposta);
        const c = corpoDaReversao.parse(req.body);
        ia.modelos.reverter(autorDe(req), req.params.funcao, c.confirmado === true);
        return modelosParaJson(ia.modelos, ia.testes);
      },
    );

    // --- Instruções de interpretação (Fase C, v0.61.0) -------------------------------------------------------
    const instrucoesDaFase = opcoes.ia?.instrucoes;
    rotasDeInstrucoesDeIa(
      servidor,
      instrucoesDaFase
        ? {
            autorDe,
            instrucoes: instrucoesDaFase.servico,
            experimento: instrucoesDaFase.experimento,
            verificacao: instrucoesDaFase.verificacao,
            erros: instrucoesDaFase.erros,
          }
        : undefined,
      semPainel,
    );

    /** Consulta o gateway e corrige divergências (aviso perdido). Sem corpo = todas as contas. */
    servidor.post<{ Body: unknown }>(
      ROTA_ADMIN_PAGAMENTO_RECONCILIAR,
      async (req, resposta) => {
        const p = opcoes.pagamentos;
        if (!p) {
          void resposta.code(404);
          return {
            erro: 'PAGAMENTO_DESLIGADO',
            mensagem: 'A cobrança recorrente não está habilitada neste servidor.',
          };
        }
        const d = corpoReconciliar.parse(req.body ?? {});
        const workspace =
          d.workspace !== undefined
            ? await opcoes.localizador.confirmar(d.workspace)
            : undefined;
        return p.reconciliar(workspace !== undefined ? { workspace } : {});
      },
    );
  };
}

async function ultimaFalhaParaAdmin(p: ServicoPagamentos): Promise<{
  readonly em: string;
  readonly operacao: string;
  readonly status: number | null;
  readonly codigo: string | null;
  readonly motivo: string;
} | null> {
  const f = await p.ultimaFalhaDoGateway();
  return f ? { ...f, em: f.em.toISOString() } : null;
}

function pagamentoParaAdmin(
  c: NonNullable<Awaited<ReturnType<ServicoPagamentos['cobrancaDe']>>>,
): Record<string, unknown> {
  return {
    gateway: c.gateway,
    gatewayId: c.gatewayId ?? null,
    estadoNoGateway: c.estado,
    plano: c.plano,
    ciclo: c.ciclo,
    valorEmCentavos: c.valorEmCentavos,
    proximaCobranca: c.proximaCobranca?.toISOString() ?? null,
    meio: c.meio ?? null,
    ultimoPagamento: c.ultimoPagamento ?? null,
    ultimoPagamentoEm: c.ultimoPagamentoEm?.toISOString() ?? null,
    renovacaoCanceladaEm: c.renovacaoCanceladaEm?.toISOString() ?? null,
  };
}

const numeroOuNulo = (v: number | undefined): number | null =>
  v === undefined ? null : v;

/** O painel como JSON: datas em ISO, `undefined` vira `null` (forma estável para a tela). */
function painelParaJson(p: PainelDeIa): Record<string, unknown> {
  return {
    periodo: p.periodo,
    desde: p.desde,
    funcoes: p.funcoes.map((f) => ({
      funcao: f.funcao,
      rotulo: f.rotulo,
      ambientePermite: f.ambientePermite,
      painelLigado: f.painelLigado,
      efetivamenteLigada: f.efetivamenteLigada,
      tetoDoPainel: f.tetoDoPainel,
      tetoEfetivoPorConta: f.tetoEfetivoPorConta,
      analises: f.metricas.analises,
      util: f.metricas.util,
      errado: f.metricas.errado,
      perigoso: f.metricas.perigoso,
      semAvaliacao: f.metricas.semAvaliacao,
      motivosDaAvaliacao: f.metricas.motivos,
      semMotivo: f.metricas.semMotivo,
      naoVerificadas: f.metricas.naoVerificadas,
      naoFoiPossivel: f.naoFoiPossivel,
      taxaNaoFoiPossivel: numeroOuNulo(f.taxaNaoFoiPossivel),
      taxaNaoVerificado: numeroOuNulo(f.taxaNaoVerificado),
      chamadasQueFalharam: f.chamadasQueFalharam,
      repeticoesAutomaticas: f.repeticoesAutomaticas,
      porModelo: f.porModelo.map((m) => ({
        modelo: m.modelo,
        analises: m.metricas.analises,
        util: m.metricas.util,
        errado: m.metricas.errado,
        perigoso: m.metricas.perigoso,
        naoVerificadas: m.metricas.naoVerificadas,
        latenciaP95Ms: numeroOuNulo(m.metricas.latenciaP95Ms),
        custoMedio: numeroOuNulo(m.metricas.custo.medio),
        custoTotal: m.metricas.custo.total,
      })),
      falhasDeVerificacao: f.falhasDeVerificacao,
      latenciaP50Ms: numeroOuNulo(f.metricas.latenciaP50Ms),
      latenciaP95Ms: numeroOuNulo(f.metricas.latenciaP95Ms),
      custo: {
        total: f.metricas.custo.total,
        medio: numeroOuNulo(f.metricas.custo.medio),
        p50: numeroOuNulo(f.metricas.custo.p50),
        p95: numeroOuNulo(f.metricas.custo.p95),
        maximo: numeroOuNulo(f.metricas.custo.maximo),
        comCusto: f.metricas.custo.comCusto,
      },
    })),
    contas: p.contas,
    tetoGlobal: p.tetoGlobal,
    custoDoDia: p.custoDoDia,
    alteracoes: p.alteracoes.map((a) => ({
      id: a.id ?? null,
      em: a.em.toISOString(),
      autor: a.autor,
      por: rotuloDoAutor(a.autor),
      funcao: a.funcao,
      tipo: a.tipo,
      anterior: a.anterior,
      novo: a.novo,
      testeId: a.testeId ?? null,
      aprovacao: a.aprovacao ?? null,
    })),
  };
}

/**
 * A tela "Administradores" como JSON (só o dono a pede). Datas em ISO; "por" já como nome (nunca o hash curto do dono).
 * Nenhuma senha: as credenciais só existem em variável de ambiente e nunca passam por aqui.
 */
function administradoresParaJson(
  servico: ServicoAdministradores,
  donoUsuario: string,
): Record<string, unknown> {
  const v = servico.visao();
  return {
    dono: { usuario: donoUsuario },
    abasDisponiveis: v.abasDisponiveis,
    restritos: v.restritos.map((r) => ({
      usuario: r.usuario,
      abas: r.abas,
      ultimoAcesso: r.ultimoAcesso?.toISOString() ?? null,
    })),
    semCredencial: v.semCredencial,
    historico: v.historico.map((m) => ({
      em: m.em.toISOString(),
      por: rotuloDoAutor(m.por),
      usuario: m.usuario,
      aba: m.aba,
      rotuloDaAba: ROTULO_DA_ABA[m.aba as AbaDoAdmin] ?? m.aba,
      acao: m.acao,
    })),
  };
}
