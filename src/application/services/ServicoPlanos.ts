import type { StatusAssinatura } from '../../domain/entities/Assinatura.js';
import {
  RECURSOS_PADRAO_DE_PLANO_NOVO,
  ordenarPlanos,
  planosAVenda,
  validarPlano,
} from '../../domain/entities/Plano.js';
import type { CodigoPlano, Plano, RecursoDoPlano } from '../../domain/entities/Plano.js';
import { validarRegras } from '../../domain/entities/RegrasDeAssinatura.js';
import type { RegrasDeAssinatura } from '../../domain/entities/RegrasDeAssinatura.js';
import { PlanoDesconhecidoError, PlanoJaExisteError } from '../../domain/errors/index.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioAssinaturas } from '../../domain/ports/RepositorioAssinaturas.js';
import type {
  RepositorioPlanos,
  RepositorioRegrasDeAssinatura,
} from '../../domain/ports/RepositorioPlanos.js';

export interface DadosDePlano {
  readonly nome: string;
  readonly resumo: string;
  readonly recursos: readonly RecursoDoPlano[];
  readonly disponivelParaContratacao: boolean;
  readonly precoMensalCentavos: number | null;
  /** Ausente na criação: o plano novo entra no fim da lista. */
  readonly ordem?: number;
}

export interface NovoPlano extends DadosDePlano {
  readonly codigo: CodigoPlano;
}

/** Tudo do plano, e nunca o código — que não muda depois de criado. */
export type MudancasNoPlano = Partial<DadosDePlano>;

export type ContagemPorStatus = Readonly<Record<StatusAssinatura, number>>;

export interface PlanoNaVisaoGeral extends Plano {
  readonly assinantes: ContagemPorStatus;
  readonly ehPlanoDoTeste: boolean;
}

export interface OpcoesServicoPlanos {
  readonly planos: RepositorioPlanos;
  readonly regras: RepositorioRegrasDeAssinatura;
  /** Só para contar assinantes por plano na visão geral. */
  readonly assinaturas: RepositorioAssinaturas;
  readonly logger: Logger;
  readonly agora?: () => Date;
}

function contagemZerada(): Record<StatusAssinatura, number> {
  return { teste: 0, ativa: 0, carencia: 0, vencida: 0, cancelada: 0 };
}

/**
 * O catálogo de planos e as regras de teste e carência — o que o operador
 * edita pela área administrativa.
 *
 * Toda escrita passa por `validarPlano`/`validarRegras` do domínio ANTES de
 * gravar. É ali que mora a trava que importa: plano com recurso que ainda não
 * existe não vai à venda nem vira plano de teste, venha o pedido do painel,
 * do CLI ou de um teste.
 */
export class ServicoPlanos {
  private readonly planos: RepositorioPlanos;
  private readonly repositorioRegras: RepositorioRegrasDeAssinatura;
  private readonly assinaturas: RepositorioAssinaturas;
  private readonly logger: Logger;
  private readonly agora: () => Date;

  constructor(opcoes: OpcoesServicoPlanos) {
    this.planos = opcoes.planos;
    this.repositorioRegras = opcoes.regras;
    this.assinaturas = opcoes.assinaturas;
    this.logger = opcoes.logger;
    this.agora = opcoes.agora ?? ((): Date => new Date());
  }

  async listar(): Promise<Plano[]> {
    return ordenarPlanos(await this.planos.listar());
  }

  async aVenda(): Promise<Plano[]> {
    return planosAVenda(await this.planos.listar());
  }

  /** @throws {PlanoDesconhecidoError} */
  async porCodigo(codigo: CodigoPlano): Promise<Plano> {
    const plano = await this.planos.porCodigo(codigo);
    if (!plano) {
      const todos = await this.listar();
      throw new PlanoDesconhecidoError(
        codigo,
        todos.map((p) => p.codigo),
      );
    }
    return plano;
  }

  /**
   * Cada plano com quantos assinantes tem em cada situação.
   *
   * Conta pelo status DERIVADO no instante da consulta, pela mesma regra de
   * `Assinatura.statusEm` — nunca por coluna gravada, que é o que o resto do
   * sistema também se recusa a fazer.
   */
  async visaoGeral(): Promise<PlanoNaVisaoGeral[]> {
    const [planos, todas, regras] = await Promise.all([
      this.listar(),
      this.assinaturas.todas(),
      this.repositorioRegras.ler(),
    ]);
    const agora = this.agora();

    const porPlano = new Map<string, Record<StatusAssinatura, number>>();
    for (const a of todas) {
      const contagem = porPlano.get(a.plano) ?? contagemZerada();
      contagem[a.statusEm(agora)]++;
      porPlano.set(a.plano, contagem);
    }

    return planos.map((p) => ({
      ...p,
      assinantes: porPlano.get(p.codigo) ?? contagemZerada(),
      ehPlanoDoTeste: p.codigo === regras.planoDoTeste,
    }));
  }

  /**
   * @throws {PlanoJaExisteError} {PlanoInvalidoError}
   */
  async criar(dados: NovoPlano): Promise<Plano> {
    const codigo = dados.codigo.trim().toLowerCase();
    if (await this.planos.porCodigo(codigo)) throw new PlanoJaExisteError(codigo);

    const existentes = await this.planos.listar();
    const ultimo = existentes.reduce((maior, p) => Math.max(maior, p.ordem), 0);

    const plano: Plano = {
      codigo,
      nome: dados.nome.trim(),
      resumo: dados.resumo.trim(),
      // O calendário é de todos os planos (decisão do dono, v0.32.0): entra
      // mesmo que o formulário não o marque. Tirar depois, pela edição, é
      // possível — é o operador decidindo, não esquecendo.
      recursos: [
        ...dados.recursos,
        ...RECURSOS_PADRAO_DE_PLANO_NOVO.filter((r) => !dados.recursos.includes(r)),
      ],
      disponivelParaContratacao: dados.disponivelParaContratacao,
      precoMensalCentavos: dados.precoMensalCentavos,
      // De dez em dez, para sobrar espaço de encaixar um plano entre dois sem
      // renumerar a lista inteira.
      ordem: dados.ordem ?? Math.min(ultimo + 10, 9999),
    };
    validarPlano(plano);

    await this.planos.salvar(plano);
    this.logger.info('plano criado', {
      codigo,
      disponivel: plano.disponivelParaContratacao,
    });
    return plano;
  }

  /**
   * Altera um plano existente. O que muda vale NA HORA para quem já tem o
   * plano — inclusive os recursos. É o comportamento certo para corrigir um
   * texto ou reajustar preço, e é por isso que o painel pergunta antes de
   * gravar uma mudança de recursos num plano com assinantes.
   *
   * @throws {PlanoDesconhecidoError} {PlanoInvalidoError}
   *         {RegrasDeAssinaturaInvalidasError} se a mudança tornaria o plano
   *         do teste inválido (ex.: incluir um recurso que não existe)
   */
  async atualizar(codigo: CodigoPlano, mudancas: MudancasNoPlano): Promise<Plano> {
    const atual = await this.porCodigo(codigo);

    const novo: Plano = {
      codigo: atual.codigo,
      nome: mudancas.nome !== undefined ? mudancas.nome.trim() : atual.nome,
      resumo: mudancas.resumo !== undefined ? mudancas.resumo.trim() : atual.resumo,
      recursos: mudancas.recursos !== undefined ? [...mudancas.recursos] : atual.recursos,
      disponivelParaContratacao:
        mudancas.disponivelParaContratacao ?? atual.disponivelParaContratacao,
      precoMensalCentavos:
        mudancas.precoMensalCentavos !== undefined
          ? mudancas.precoMensalCentavos
          : atual.precoMensalCentavos,
      ordem: mudancas.ordem ?? atual.ordem,
    };
    validarPlano(novo);

    // As regras dependem do plano do teste. Conferir com o catálogo COMO VAI
    // FICAR, antes de gravar, é o que impede uma edição de plano de quebrar
    // as regras pela porta dos fundos.
    const regras = await this.repositorioRegras.ler();
    if (regras.planoDoTeste === codigo) {
      const catalogo = (await this.planos.listar()).map((p) =>
        p.codigo === codigo ? novo : p,
      );
      validarRegras(regras, catalogo);
    }

    await this.planos.salvar(novo);
    this.logger.info('plano alterado', {
      codigo,
      disponivel: novo.disponivelParaContratacao,
    });
    return novo;
  }

  async regras(): Promise<RegrasDeAssinatura> {
    return this.repositorioRegras.ler();
  }

  /** @throws {RegrasDeAssinaturaInvalidasError} */
  async definirRegras(regras: RegrasDeAssinatura): Promise<RegrasDeAssinatura> {
    const limpas: RegrasDeAssinatura = {
      diasDeTeste: regras.diasDeTeste,
      planoDoTeste: regras.planoDoTeste.trim(),
      diasDeCarencia: regras.diasDeCarencia,
    };
    validarRegras(limpas, await this.planos.listar());
    await this.repositorioRegras.salvar(limpas);
    this.logger.info('regras de assinatura alteradas', { ...limpas });
    return limpas;
  }
}
