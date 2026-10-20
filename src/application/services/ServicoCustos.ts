import {
  CATEGORIAS_BASE,
  LIMITE_CATEGORIAS_PROPRIAS,
  LIMITE_LANCAMENTOS_POR_PROCESSO,
  PREFIXO_DA_CATEGORIA_PROPRIA,
  alterarCusto,
  calcularTotais,
  chaveDoNomeDeCategoria,
  codigoDaCategoriaPropria,
  criarCusto,
  ehCategoriaBase,
  estaACobrar,
  validarDataDoRessarcimento,
  validarNomeDeCategoria,
} from '../../domain/entities/Custo.js';
import type {
  CategoriaDeCusto,
  Custo,
  DadosDoCusto,
  TotaisDeCusto,
} from '../../domain/entities/Custo.js';
import {
  dataBrasileira,
  dataLocalEm,
  ehDataLocalValida,
} from '../../domain/entities/EventoDeCalendario.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import { reaisDeCentavos } from '../../domain/entities/valorEmReais.js';
import {
  CustoInvalidoError,
  CustoNaoEncontradoError,
  LimiteDeCustosError,
} from '../../domain/errors/index.js';
import type {
  DocumentoDePrestacao,
  GeradorDePrestacaoDeContas,
} from '../../domain/ports/GeradorDePrestacaoDeContas.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import type { RepositorioDeCustos } from '../../domain/ports/RepositorioDeCustos.js';

export interface OpcoesServicoCustos {
  readonly repositorio: RepositorioDeCustos;
  /** Só para LER o rótulo de cliente que o advogado deu à pasta (nunca para escrever). */
  readonly acompanhamentos: RepositorioAcompanhamentos;
  readonly gerador: GeradorDePrestacaoDeContas;
  readonly logger: Logger;
  readonly gerarId: () => string;
  /** A versão do sistema, que vai no rodapé do PDF. */
  readonly versao: string;
  readonly agora?: () => Date;
}

/** Uma categoria como a tela a vê: da lista base ou própria da conta. */
export interface CategoriaParaTela {
  readonly codigo: string;
  readonly nome: string;
  readonly base: boolean;
  readonly arquivada: boolean;
}

export interface CustosDoProcesso {
  readonly numeroProcesso: string;
  readonly lancamentos: readonly Custo[];
  readonly totais: TotaisDeCusto;
  readonly categorias: readonly CategoriaParaTela[];
}

export interface OpcoesDaPrestacao {
  readonly de?: string;
  readonly ate?: string;
  readonly somenteACobrar?: boolean;
}

export interface QuemGera {
  readonly nome: string;
  readonly oab?: string;
}

/**
 * Centro de custos do processo (v0.47.0): lançamentos, categorias, totais e a prestação de contas.
 *
 * Todo método recebe o `workspace` e o repassa à persistência, que o confere em cada consulta.
 * O processo é só o número (20 dígitos): os custos NÃO dependem de o processo estar acompanhado.
 *
 * O que NUNCA vai para o log: valor, descrição, nome de categoria, rótulo de cliente. Os logs
 * daqui levam só contagens.
 */
export class ServicoCustos {
  private readonly agora: () => Date;

  constructor(private readonly o: OpcoesServicoCustos) {
    this.agora = o.agora ?? (() => new Date());
  }

  private hoje(): string {
    return dataLocalEm(this.agora());
  }

  async listar(workspace: string, numeroInformado: string): Promise<CustosDoProcesso> {
    const numero = NumeroCNJ.criar(numeroInformado).digitos;
    const lancamentos = await this.o.repositorio.listar(workspace, numero);
    return {
      numeroProcesso: numero,
      lancamentos,
      totais: calcularTotais(lancamentos),
      categorias: await this.categoriasParaTela(workspace),
    };
  }

  async totais(workspace: string, numeroInformado: string): Promise<TotaisDeCusto> {
    const numero = NumeroCNJ.criar(numeroInformado).digitos;
    return calcularTotais(await this.o.repositorio.listar(workspace, numero));
  }

  async criar(
    workspace: string,
    numeroInformado: string,
    dados: DadosDoCusto,
  ): Promise<Custo> {
    const numero = NumeroCNJ.criar(numeroInformado).digitos;
    const agora = this.agora();
    // Valida a forma ANTES de olhar o teto: o pedido torto é erro do pedido, não da conta.
    const custo = criarCusto(
      { id: this.o.gerarId(), workspace, numeroProcesso: numero, criadoEm: agora },
      dados,
      this.hoje(),
    );
    await this.exigirCategoriaUsavel(workspace, custo.categoria, undefined);
    if (
      (await this.o.repositorio.contar(workspace, numero)) >=
      LIMITE_LANCAMENTOS_POR_PROCESSO
    ) {
      throw new LimiteDeCustosError('lancamentos', LIMITE_LANCAMENTOS_POR_PROCESSO);
    }
    await this.o.repositorio.inserir(custo);
    this.o.logger.debug('custo lançado');
    return custo;
  }

  async alterar(
    workspace: string,
    id: string,
    mudancas: Partial<Omit<DadosDoCusto, 'ressarcidoEm'>> & {
      readonly ressarcidoEm?: string | null | undefined;
    },
  ): Promise<Custo> {
    const atual = await this.exigir(workspace, id);
    const novo = alterarCusto(atual, mudancas, this.agora(), this.hoje());
    if (novo.categoria !== atual.categoria) {
      await this.exigirCategoriaUsavel(workspace, novo.categoria, atual.categoria);
    }
    await this.o.repositorio.atualizar(novo);
    return novo;
  }

  async excluir(workspace: string, id: string): Promise<void> {
    if (!(await this.o.repositorio.excluir(workspace, id)))
      throw new CustoNaoEncontradoError();
    this.o.logger.debug('custo excluído');
  }

  /** Marca como ressarcido. Sem data, vale o dia de hoje (São Paulo). */
  async ressarcir(workspace: string, id: string, em?: string): Promise<Custo> {
    const atual = await this.exigir(workspace, id);
    if (!atual.reembolsavel) {
      throw new CustoInvalidoError(
        'Só um lançamento marcado como "Cobrar do cliente" pode ser ressarcido.',
      );
    }
    const data = validarDataDoRessarcimento(em ?? this.hoje(), this.hoje());
    return this.alterar(workspace, id, { ressarcidoEm: data });
  }

  async desfazerRessarcimento(workspace: string, id: string): Promise<Custo> {
    await this.exigir(workspace, id);
    return this.alterar(workspace, id, { ressarcidoEm: null });
  }

  async listarCategorias(workspace: string): Promise<readonly CategoriaParaTela[]> {
    return this.categoriasParaTela(workspace);
  }

  /**
   * Cria categoria própria. Nome igual a uma ARQUIVADA da mesma conta a reativa (o nome é único
   * por conta, então criar de novo é o que a pessoa quer dizer), respeitando o teto.
   */
  async criarCategoria(workspace: string, nome: string): Promise<CategoriaDeCusto> {
    const limpo = validarNomeDeCategoria(nome);
    const chave = chaveDoNomeDeCategoria(limpo);
    const existentes = await this.o.repositorio.categorias(workspace);
    const igual = existentes.find((c) => chaveDoNomeDeCategoria(c.nome) === chave);
    const ativas = existentes.filter((c) => !c.arquivada).length;
    if (igual && !igual.arquivada) {
      throw new CustoInvalidoError('Você já tem uma categoria com esse nome.');
    }
    if (ativas >= LIMITE_CATEGORIAS_PROPRIAS) {
      throw new LimiteDeCustosError('categorias', LIMITE_CATEGORIAS_PROPRIAS);
    }
    if (igual) {
      const reativada = Object.freeze({ ...igual, arquivada: false });
      await this.o.repositorio.atualizarCategoria(reativada);
      return reativada;
    }
    const nova: CategoriaDeCusto = Object.freeze({
      id: this.o.gerarId(),
      workspace,
      nome: limpo,
      arquivada: false,
      criadaEm: this.agora(),
    });
    await this.o.repositorio.inserirCategoria(nova);
    return nova;
  }

  /** Arquiva (ou desarquiva). Nunca exclui: lançamentos antigos continuam com o nome dela. */
  async arquivarCategoria(
    workspace: string,
    id: string,
    arquivada: boolean,
  ): Promise<CategoriaDeCusto> {
    const atual = await this.o.repositorio.buscarCategoria(workspace, id);
    if (!atual) throw new CustoNaoEncontradoError();
    if (!arquivada && atual.arquivada) {
      const ativas = (await this.o.repositorio.categorias(workspace)).filter(
        (c) => !c.arquivada,
      ).length;
      if (ativas >= LIMITE_CATEGORIAS_PROPRIAS) {
        throw new LimiteDeCustosError('categorias', LIMITE_CATEGORIAS_PROPRIAS);
      }
    }
    const nova = Object.freeze({ ...atual, arquivada });
    await this.o.repositorio.atualizarCategoria(nova);
    return nova;
  }

  /**
   * Apaga todos os custos e categorias do workspace — o caminho da exclusão de conta, o mesmo
   * `apagarDoWorkspace` dos demais dados por workspace (a exclusão de conta ainda não existe no
   * produto; quando existir, é aqui que ela chama).
   */
  async apagarDoWorkspace(workspace: string): Promise<number> {
    return this.o.repositorio.apagarDoWorkspace(workspace);
  }

  /**
   * A prestação de contas em PDF, nos bytes. Não grava nada em disco, não loga valor.
   *
   * O documento só tem o que `DocumentoDePrestacao` comporta: número, tribunal, rótulo de cliente
   * (lido da pasta, se o processo é acompanhado e foi rotulado), o advogado de quem está logado e
   * os lançamentos. Nenhuma parte, nenhum texto de ato, nenhum dado de segredo de justiça.
   */
  async gerarPrestacao(
    workspace: string,
    numeroInformado: string,
    opcoes: OpcoesDaPrestacao,
    quem: QuemGera | undefined,
  ): Promise<{ readonly pdf: Uint8Array; readonly nomeDoArquivo: string }> {
    const cnj = NumeroCNJ.criar(numeroInformado);
    const { de, ate } = opcoes;
    for (const d of [de, ate]) {
      if (d !== undefined && !ehDataLocalValida(d)) {
        throw new CustoInvalidoError('Informe o período com datas válidas (dd/mm/aaaa).');
      }
    }
    if (de !== undefined && ate !== undefined && de > ate) {
      throw new CustoInvalidoError('A data inicial não pode ser depois da data final.');
    }

    const todos = await this.o.repositorio.listar(workspace, cnj.digitos);
    const incluidos = todos
      .filter(
        (c) => (de === undefined || c.data >= de) && (ate === undefined || c.data <= ate),
      )
      .filter((c) => !opcoes.somenteACobrar || estaACobrar(c));
    // Do mais antigo para o mais novo: é a ordem em que uma prestação de contas se lê.
    incluidos.reverse();

    const totais = calcularTotais(incluidos);
    const nomes = new Map(
      (await this.categoriasParaTela(workspace)).map((c) => [c.codigo, c.nome]),
    );
    const nomeDe = (codigo: string): string => nomes.get(codigo) ?? 'Outros';

    const cliente = (await this.o.acompanhamentos.buscar(workspace, cnj.digitos))
      ?.cliente;
    const agora = this.agora();
    const hojeLocal = dataLocalEm(agora);
    const filtros: string[] = [];
    if (de !== undefined || ate !== undefined) {
      filtros.push(
        `Período: ${de !== undefined ? `de ${dataBrasileira(de)}` : 'desde o início'}` +
          `${ate !== undefined ? ` até ${dataBrasileira(ate)}` : ''}`,
      );
    }
    if (opcoes.somenteACobrar) filtros.push('Somente o que está a cobrar do cliente');

    const documento: DocumentoDePrestacao = {
      numeroProcesso: cnj.formatado,
      tribunal: cnj.siglaTribunal ?? 'Tribunal não identificado',
      ...(cliente ? { cliente } : {}),
      ...(quem
        ? { advogado: { nome: quem.nome, ...(quem.oab ? { oab: quem.oab } : {}) } }
        : {}),
      geradoEm: `${dataBrasileira(hojeLocal)} ${horaLocalDe(agora)}`,
      filtros,
      versao: this.o.versao,
      linhas: incluidos.map((c) => ({
        data: dataBrasileira(c.data),
        descricao: c.descricao,
        categoria: nomeDe(c.categoria),
        valor: reaisDeCentavos(c.valorCentavos),
        situacao: !c.reembolsavel
          ? 'Não cobrado'
          : c.ressarcidoEm !== undefined
            ? `Ressarcido em ${dataBrasileira(c.ressarcidoEm)}`
            : 'A cobrar',
      })),
      subtotais: totais.porCategoria.map((s) => ({
        categoria: nomeDe(s.categoria),
        quantidade: s.quantidade,
        valor: reaisDeCentavos(s.totalCentavos),
      })),
      totais: {
        gasto: reaisDeCentavos(totais.totalGastoCentavos),
        reembolsavel: reaisDeCentavos(totais.totalReembolsavelCentavos),
        ressarcido: reaisDeCentavos(totais.totalRessarcidoCentavos),
        saldoACobrar: reaisDeCentavos(totais.saldoACobrarCentavos),
      },
    };
    const pdf = await this.o.gerador.gerar(documento);
    this.o.logger.info('prestação de contas gerada', { lancamentos: incluidos.length });
    return {
      pdf,
      nomeDoArquivo: `prestacao-de-contas-${cnj.formatado}-${hojeLocal}.pdf`,
    };
  }

  private async exigir(workspace: string, id: string): Promise<Custo> {
    const c = await this.o.repositorio.buscar(workspace, id);
    if (!c) throw new CustoNaoEncontradoError();
    return c;
  }

  private async categoriasParaTela(workspace: string): Promise<CategoriaParaTela[]> {
    const proprias = await this.o.repositorio.categorias(workspace);
    return [
      ...CATEGORIAS_BASE.map((c) => ({
        codigo: c.codigo,
        nome: c.nome,
        base: true,
        arquivada: false,
      })),
      ...proprias.map((c) => ({
        codigo: codigoDaCategoriaPropria(c.id),
        nome: c.nome,
        base: false,
        arquivada: c.arquivada,
      })),
    ];
  }

  /**
   * A categoria do lançamento existe PARA ESTA conta e não está arquivada. Se o lançamento já
   * usava esta mesma (arquivada depois), `anterior` a deixa passar: editar a descrição de um custo
   * antigo não pode ser barrado porque a categoria foi arquivada.
   */
  private async exigirCategoriaUsavel(
    workspace: string,
    codigo: string,
    anterior: string | undefined,
  ): Promise<void> {
    if (ehCategoriaBase(codigo)) return;
    if (!codigo.startsWith(PREFIXO_DA_CATEGORIA_PROPRIA)) {
      throw new CustoInvalidoError('Escolha uma categoria da lista.');
    }
    const categoria = await this.o.repositorio.buscarCategoria(
      workspace,
      codigo.slice(PREFIXO_DA_CATEGORIA_PROPRIA.length),
    );
    if (!categoria) throw new CustoInvalidoError('Escolha uma categoria da lista.');
    if (categoria.arquivada && codigo !== anterior) {
      throw new CustoInvalidoError('Essa categoria está arquivada. Escolha outra.');
    }
  }
}

/** HH:MM em São Paulo (UTC−3, sem horário de verão). */
function horaLocalDe(instante: Date): string {
  const local = new Date(instante.getTime() - 3 * 3_600_000);
  return local.toISOString().slice(11, 16);
}
