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
export const ROTA_ADMIN_ASSINATURA_POR_WORKSPACE = '/admin/api/workspaces/:workspace/assinatura';
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

/** Toda rota administrativa, na ordem em que faz sentido ler — para `rotasPublicas`. */
export const ROTAS_ADMIN: readonly string[] = [
  ROTA_ADMIN,
  ROTA_ADMIN_ASSINATURAS,
  ROTA_ADMIN_ASSINATURA_POR_EMAIL,
  ROTA_ADMIN_ASSINATURA_LIBERAR,
  ROTA_ADMIN_ASSINATURA_CANCELAR,
  ROTA_ADMIN_ASSINATURA_POR_WORKSPACE,
  ROTA_ADMIN_ASSINATURA_LIBERAR_POR_WORKSPACE,
  ROTA_ADMIN_ASSINATURAS_AVISAR,
  ROTA_ADMIN_CHAVES,
  ROTA_ADMIN_CHAVE_REVOGAR,
  ROTA_ADMIN_PLANOS,
  ROTA_ADMIN_PLANO,
  ROTA_ADMIN_REGRAS,
  ROTA_ADMIN_PAGAMENTO,
  ROTA_ADMIN_PAGAMENTO_RECONCILIAR,
];

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

const corpoReconciliar = z.object({ workspace: z.string().trim().min(1).max(40).optional() });

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
      return;
    }

    autenticacaoAdmin(servidor, opcoes.credenciais);

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

    servidor.get(ROTA_ADMIN, async (_req, resposta) => {
      resposta.header('content-type', 'text/html; charset=utf-8');
      resposta.header('cache-control', 'no-store');
      resposta.header('x-robots-tag', 'noindex');
      return paginaAdmin(VERSAO);
    });

    servidor.get(ROTA_ADMIN_ASSINATURAS, async () => {
      const [todas, catalogo] = await Promise.all([
        opcoes.repositorioAssinaturas.todas(),
        opcoes.planos.listar(),
      ]);
      const nomes = new Map(catalogo.map((p) => [p.codigo, p.nome]));
      const agora = new Date();
      // Cobrança recorrente: a mais recente de cada workspace (as listadas em ordem de criação).
      const cobrancas = new Map<string, Awaited<ReturnType<ServicoPagamentos['cobrancaDe']>>>();
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
        return { email: req.params.email, workspace: ws, status: cancelada.statusEm(new Date()) };
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
     * O ambiente da cobrança recorrente, para o painel mostrar "TESTE" em destaque. Com token de teste
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
        aviso: teste
          ? opcoes.emProducao
            ? 'ATENÇÃO: o servidor está em PRODUÇÃO com credenciais de TESTE. Nenhum pagamento é real.'
            : 'Modo de TESTE: nenhum pagamento é real.'
          : null,
      };
    });

    /** Consulta o gateway e corrige divergências (aviso perdido). Sem corpo = todas as contas. */
    servidor.post<{ Body: unknown }>(ROTA_ADMIN_PAGAMENTO_RECONCILIAR, async (req, resposta) => {
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
        d.workspace !== undefined ? await opcoes.localizador.confirmar(d.workspace) : undefined;
      return p.reconciliar(workspace !== undefined ? { workspace } : {});
    });
  };
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
