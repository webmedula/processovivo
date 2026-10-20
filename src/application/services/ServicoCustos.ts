import {
  SUBCATEGORIAS_BASE,
  codigoAtualDaCategoria,
  ehGrupoDeDeposito,
  grupoDeCusto,
  PREFIXO_DA_CATEGORIA_PROPRIA,
} from '../../domain/entities/CatalogoDeCustos.js';
import {
  LIMITE_CATEGORIAS_PROPRIAS,
  LIMITE_LANCAMENTOS_POR_PROCESSO,
  alterarCusto,
  calcularTotais,
  cancelarCusto,
  chaveDeUnicidadeDaCategoria,
  codigoDaCategoriaPropria,
  criarCusto,
  estaACobrar,
  nomeRepetidoNaBase,
  reativarCusto,
  validarGrupo,
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
import {
  diferencasDoCusto,
  diferencasDoRecebimento,
} from '../../domain/entities/HistoricoDeCustos.js';
import type {
  CampoAlterado,
  EntidadeDoHistorico,
  EventoDoHistorico,
  OperacaoDoHistorico,
} from '../../domain/entities/HistoricoDeCustos.js';
import {
  LIMITE_COMPROVANTES_POR_LANCAMENTO,
  validarComprovante,
} from '../../domain/entities/Comprovante.js';
import type { Comprovante } from '../../domain/entities/Comprovante.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import {
  LIMITE_RECEBIMENTOS_POR_PROCESSO,
  alterarRecebimento,
  cancelarRecebimento,
  criarRecebimento,
  reativarRecebimento,
} from '../../domain/entities/Recebimento.js';
import type {
  DadosDoRecebimento,
  Recebimento,
} from '../../domain/entities/Recebimento.js';
import { reaisDeCentavos } from '../../domain/entities/valorEmReais.js';
import {
  CustoInvalidoError,
  CustoNaoEncontradoError,
  DriveRecusadoError,
  LimiteDeCustosError,
} from '../../domain/errors/index.js';
import type {
  DocumentoDePrestacao,
  GeradorDePrestacaoDeContas,
} from '../../domain/ports/GeradorDePrestacaoDeContas.js';
import { itensParaTotais, montarSecao } from './prestacaoDeCustos.js';
import type { DestinoDeComprovantes } from '../../domain/ports/DestinoDeComprovantes.js';
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
  /**
   * Onde os comprovantes são guardados: o Drive do advogado. `undefined` com o Drive desligado no
   * servidor — anexar então responde que o recurso não está disponível, sem erro técnico.
   */
  readonly comprovantes?: DestinoDeComprovantes | undefined;
  /** A versão do sistema, que vai no rodapé do PDF. */
  readonly versao: string;
  readonly agora?: () => Date;
}

/** Uma subcategoria como a tela a vê: da lista base ou própria da conta. */
export interface CategoriaParaTela {
  readonly codigo: string;
  readonly nome: string;
  readonly grupo: string;
  readonly nomeDoGrupo: string;
  /** "Grupo › Subcategoria": é como aparece em toda tela, PDF e histórico. */
  readonly nomeCompleto: string;
  readonly base: boolean;
  readonly arquivada: boolean;
  /** Derivado do GRUPO (08): não há campo solto que possa discordar dele. */
  readonly deposito: boolean;
}

export interface CustosDoProcesso {
  readonly numeroProcesso: string;
  /** Ativos e, se pedido, cancelados (marcados por `canceladoEm`). */
  readonly lancamentos: readonly Custo[];
  readonly recebimentos: readonly Recebimento[];
  /** Os comprovantes de cada lançamento (id do lançamento → anexos). */
  readonly comprovantes: ReadonlyMap<string, readonly Comprovante[]>;
  /** Calculados SÓ sobre os ativos. */
  readonly totais: TotaisDeCusto;
  readonly categorias: readonly CategoriaParaTela[];
  /** Quantos cancelados existem (para a tela dizer quantos estão escondidos). */
  readonly canceladosEscondidos: number;
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

export interface EventoParaTela {
  readonly id: string;
  readonly quando: Date;
  readonly operacao: OperacaoDoHistorico;
  readonly motivo?: string;
  readonly campos: readonly {
    readonly campo: string;
    readonly rotulo: string;
    readonly de?: string;
    readonly para?: string;
  }[];
}

const ROTULO_DO_CAMPO: Readonly<Record<string, string>> = {
  valor: 'Valor',
  data: 'Data',
  categoria: 'Subcategoria',
  pago_por: 'Pago por',
  reembolsavel: 'Cobrar do cliente',
  descricao: 'Descrição',
  observacao: 'Observação',
};

/**
 * Centro de custos do processo (v0.47.0, ampliado na v0.48.0): lançamentos, recebimentos, catálogo,
 * histórico e a prestação de contas.
 *
 * Todo método recebe o `workspace` e o repassa à persistência, que o confere em cada consulta.
 * O processo é só o número (20 dígitos): os custos NÃO dependem de o processo estar acompanhado.
 * **Nada é apagado:** cancelar grava `canceladoEm`, e toda mudança deixa um evento no histórico.
 *
 * O que NUNCA vai para o log: valor, descrição, observação, nome de subcategoria, rótulo de
 * cliente. Os logs daqui levam só contagens.
 */
export class ServicoCustos {
  private readonly agora: () => Date;

  constructor(private readonly o: OpcoesServicoCustos) {
    this.agora = o.agora ?? (() => new Date());
  }

  private hoje(): string {
    return dataLocalEm(this.agora());
  }

  // ---------------------------------------------------------------------------
  // Leitura

  async listar(
    workspace: string,
    numeroInformado: string,
    incluirCancelados = false,
  ): Promise<CustosDoProcesso> {
    const numero = NumeroCNJ.criar(numeroInformado).digitos;
    const todos = await this.o.repositorio.listar(workspace, numero, true);
    const recebimentos = await this.o.repositorio.listarRecebimentos(
      workspace,
      numero,
      true,
    );
    const categorias = await this.categoriasParaTela(workspace);
    const anexos = new Map<string, Comprovante[]>();
    for (const c of await this.o.repositorio.listarComprovantes(workspace, numero)) {
      anexos.set(c.custoId, [...(anexos.get(c.custoId) ?? []), c]);
    }
    const ativos = todos.filter((c) => !c.canceladoEm);
    const recebimentosAtivos = recebimentos.filter((r) => !r.canceladoEm);
    const cancelados =
      todos.length - ativos.length + (recebimentos.length - recebimentosAtivos.length);
    return {
      numeroProcesso: numero,
      lancamentos: incluirCancelados ? todos : ativos,
      recebimentos: incluirCancelados ? recebimentos : recebimentosAtivos,
      comprovantes: anexos,
      totais: calcularTotais(itensParaTotais(ativos, categorias), recebimentosAtivos),
      categorias,
      canceladosEscondidos: incluirCancelados ? 0 : cancelados,
    };
  }

  async totais(workspace: string, numeroInformado: string): Promise<TotaisDeCusto> {
    return (await this.listar(workspace, numeroInformado)).totais;
  }

  async historico(
    workspace: string,
    entidade: EntidadeDoHistorico,
    id: string,
  ): Promise<readonly EventoParaTela[]> {
    const existe =
      entidade === 'lancamento'
        ? await this.o.repositorio.buscar(workspace, id)
        : await this.o.repositorio.buscarRecebimento(workspace, id);
    if (!existe) throw new CustoNaoEncontradoError();
    const nomes = new Map(
      (await this.categoriasParaTela(workspace)).map((c) => [c.codigo, c.nomeCompleto]),
    );
    const eventos = await this.o.repositorio.historico(workspace, entidade, id);
    return eventos.map((e) => ({
      id: e.id,
      quando: e.quando,
      operacao: e.operacao,
      ...(e.motivo ? { motivo: e.motivo } : {}),
      campos: e.campos.map((c) => ({
        campo: c.campo,
        rotulo: ROTULO_DO_CAMPO[c.campo] ?? c.campo,
        ...(c.de !== undefined ? { de: this.textoDoCampo(c.campo, c.de, nomes) } : {}),
        ...(c.para !== undefined
          ? { para: this.textoDoCampo(c.campo, c.para, nomes) }
          : {}),
      })),
    }));
  }

  // ---------------------------------------------------------------------------
  // Lançamentos

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
      { ...dados, categoria: codigoAtualDaCategoria(dados.categoria) },
      this.hoje(),
    );
    await this.exigirCategoriaUsavel(workspace, custo.categoria, undefined);
    if (
      (await this.o.repositorio.contar(workspace, numero)) >=
      LIMITE_LANCAMENTOS_POR_PROCESSO
    ) {
      throw new LimiteDeCustosError('lancamentos', LIMITE_LANCAMENTOS_POR_PROCESSO);
    }
    await this.o.repositorio.inserir(
      custo,
      this.evento(custo, 'lancamento', custo.id, 'criou', [], agora),
    );
    this.o.logger.debug('custo lançado');
    return custo;
  }

  async alterar(
    workspace: string,
    id: string,
    mudancas: Partial<DadosDoCusto>,
  ): Promise<Custo> {
    const atual = await this.exigir(workspace, id);
    if (atual.canceladoEm) {
      throw new CustoInvalidoError('Reative o lançamento antes de editar.');
    }
    const agora = this.agora();
    const novo = alterarCusto(
      atual,
      mudancas.categoria
        ? { ...mudancas, categoria: codigoAtualDaCategoria(mudancas.categoria) }
        : mudancas,
      agora,
      this.hoje(),
    );
    const campos = diferencasDoCusto(atual, novo);
    if (campos.length === 0) return atual;
    if (novo.categoria !== atual.categoria) {
      await this.exigirCategoriaUsavel(workspace, novo.categoria, atual.categoria);
    }
    await this.o.repositorio.atualizar(
      novo,
      this.evento(novo, 'lancamento', novo.id, 'editou', campos, agora),
    );
    return novo;
  }

  /** Cancelar NÃO apaga: o lançamento fica guardado, fora dos totais, e pode ser reativado. */
  async cancelar(workspace: string, id: string, motivo?: unknown): Promise<Custo> {
    const atual = await this.exigir(workspace, id);
    if (atual.canceladoEm) return atual;
    const agora = this.agora();
    const novo = cancelarCusto(atual, motivo, agora);
    await this.o.repositorio.atualizar(
      novo,
      this.evento(
        novo,
        'lancamento',
        id,
        'cancelou',
        [],
        agora,
        novo.motivoDoCancelamento,
      ),
    );
    this.o.logger.debug('custo cancelado');
    return novo;
  }

  async reativar(workspace: string, id: string): Promise<Custo> {
    const atual = await this.exigir(workspace, id);
    if (!atual.canceladoEm) return atual;
    // Reativar volta a ocupar uma vaga: o teto vale para quem cancela e reativa em laço.
    if (
      (await this.o.repositorio.contar(workspace, atual.numeroProcesso)) >=
      LIMITE_LANCAMENTOS_POR_PROCESSO
    ) {
      throw new LimiteDeCustosError('lancamentos', LIMITE_LANCAMENTOS_POR_PROCESSO);
    }
    const agora = this.agora();
    const novo = reativarCusto(atual, agora);
    await this.o.repositorio.atualizar(
      novo,
      this.evento(novo, 'lancamento', id, 'reativou', [], agora),
    );
    return novo;
  }

  // ---------------------------------------------------------------------------
  // Recebimentos do cliente

  async registrarRecebimento(
    workspace: string,
    numeroInformado: string,
    dados: DadosDoRecebimento,
  ): Promise<Recebimento> {
    const numero = NumeroCNJ.criar(numeroInformado).digitos;
    const agora = this.agora();
    const r = criarRecebimento(
      { id: this.o.gerarId(), workspace, numeroProcesso: numero, criadoEm: agora },
      dados,
      this.hoje(),
    );
    if (
      (await this.o.repositorio.contarRecebimentos(workspace, numero)) >=
      LIMITE_RECEBIMENTOS_POR_PROCESSO
    ) {
      throw new LimiteDeCustosError('recebimentos', LIMITE_RECEBIMENTOS_POR_PROCESSO);
    }
    await this.o.repositorio.inserirRecebimento(
      r,
      this.evento(r, 'recebimento', r.id, 'criou', [], agora),
    );
    this.o.logger.debug('recebimento registrado');
    return r;
  }

  async alterarRecebimento(
    workspace: string,
    id: string,
    mudancas: { data?: string; valorCentavos?: number; observacao?: string | null },
  ): Promise<Recebimento> {
    const atual = await this.exigirRecebimento(workspace, id);
    if (atual.canceladoEm) {
      throw new CustoInvalidoError('Reative o recebimento antes de editar.');
    }
    const agora = this.agora();
    const novo = alterarRecebimento(atual, mudancas, agora, this.hoje());
    const campos = diferencasDoRecebimento(atual, novo);
    if (campos.length === 0) return atual;
    await this.o.repositorio.atualizarRecebimento(
      novo,
      this.evento(novo, 'recebimento', id, 'editou', campos, agora),
    );
    return novo;
  }

  async cancelarRecebimento(
    workspace: string,
    id: string,
    motivo?: unknown,
  ): Promise<Recebimento> {
    const atual = await this.exigirRecebimento(workspace, id);
    if (atual.canceladoEm) return atual;
    const agora = this.agora();
    const novo = cancelarRecebimento(atual, motivo, agora);
    await this.o.repositorio.atualizarRecebimento(
      novo,
      this.evento(
        novo,
        'recebimento',
        id,
        'cancelou',
        [],
        agora,
        novo.motivoDoCancelamento,
      ),
    );
    return novo;
  }

  async reativarRecebimento(workspace: string, id: string): Promise<Recebimento> {
    const atual = await this.exigirRecebimento(workspace, id);
    if (!atual.canceladoEm) return atual;
    if (
      (await this.o.repositorio.contarRecebimentos(workspace, atual.numeroProcesso)) >=
      LIMITE_RECEBIMENTOS_POR_PROCESSO
    ) {
      throw new LimiteDeCustosError('recebimentos', LIMITE_RECEBIMENTOS_POR_PROCESSO);
    }
    const agora = this.agora();
    const novo = reativarRecebimento(atual, agora);
    await this.o.repositorio.atualizarRecebimento(
      novo,
      this.evento(novo, 'recebimento', id, 'reativou', [], agora),
    );
    return novo;
  }

  // ---------------------------------------------------------------------------
  // Comprovantes (v0.49.0): o arquivo vai direto da memória ao Drive do advogado

  /**
   * Anexa um comprovante ao lançamento. O arquivo é validado pelos primeiros bytes (PDF, JPEG ou PNG,
   * até 5 MB) ANTES de qualquer chamada ao Google; nada é gravado em disco; só o id, o link, o nome,
   * o tamanho e a data ficam aqui. Nunca vai a log: nem o nome, nem o tamanho.
   */
  async anexarComprovante(
    workspace: string,
    custoId: string,
    arquivo: {
      readonly conteudo: unknown;
      readonly nome: unknown;
      readonly tipoDeclarado: unknown;
    },
  ): Promise<Comprovante> {
    const custo = await this.exigir(workspace, custoId);
    if (custo.canceladoEm) {
      throw new CustoInvalidoError('Reative o lançamento antes de anexar comprovantes.');
    }
    const valido = validarComprovante(
      arquivo.conteudo,
      arquivo.nome,
      arquivo.tipoDeclarado,
    );
    if (
      (await this.o.repositorio.contarComprovantes(workspace, custoId)) >=
      LIMITE_COMPROVANTES_POR_LANCAMENTO
    ) {
      throw new LimiteDeCustosError('comprovantes', LIMITE_COMPROVANTES_POR_LANCAMENTO);
    }
    if (!this.o.comprovantes) {
      throw new DriveRecusadoError(
        'sem_plano',
        'O envio de comprovantes ao Google Drive não está disponível neste servidor.',
      );
    }
    const enviado = await this.o.comprovantes.anexar(workspace, custo.numeroProcesso, {
      nome: valido.nome,
      tipo: valido.tipo,
      conteudo: arquivo.conteudo as Uint8Array,
    });
    const agora = this.agora();
    const comprovante: Comprovante = Object.freeze({
      id: this.o.gerarId(),
      workspace,
      custoId,
      numeroProcesso: custo.numeroProcesso,
      arquivoId: enviado.arquivoId,
      link: linkDoDrive(enviado.arquivoId, enviado.link),
      nome: valido.nome,
      tipo: valido.tipo,
      tamanho: valido.tamanho,
      anexadoEm: agora,
    });
    const gravou = await this.o.repositorio.inserirComprovante(
      comprovante,
      LIMITE_COMPROVANTES_POR_LANCAMENTO,
      this.evento(custo, 'lancamento', custoId, 'anexou', [], agora),
    );
    if (!gravou)
      throw new LimiteDeCustosError('comprovantes', LIMITE_COMPROVANTES_POR_LANCAMENTO);
    this.o.logger.debug('comprovante anexado');
    return comprovante;
  }

  /** Remove SÓ o vínculo. O arquivo continua no Google Drive do advogado: o sistema nunca apaga lá. */
  async removerComprovante(
    workspace: string,
    custoId: string,
    id: string,
  ): Promise<void> {
    const custo = await this.exigir(workspace, custoId);
    const atual = await this.o.repositorio.buscarComprovante(workspace, id);
    if (!atual || atual.custoId !== custoId) throw new CustoNaoEncontradoError();
    const ok = await this.o.repositorio.removerComprovante(
      workspace,
      id,
      this.evento(custo, 'lancamento', custoId, 'removeu', [], this.agora()),
    );
    if (!ok) throw new CustoNaoEncontradoError();
    this.o.logger.debug('comprovante desvinculado');
  }

  // ---------------------------------------------------------------------------
  // Catálogo

  async listarCategorias(workspace: string): Promise<readonly CategoriaParaTela[]> {
    return this.categoriasParaTela(workspace);
  }

  /**
   * Cria subcategoria própria dentro de um grupo (padrão: 12). Nome igual a uma ARQUIVADA do mesmo
   * grupo a reativa (o nome é único no grupo, então criar de novo é o que a pessoa quer dizer),
   * respeitando o teto. Não pode repetir o nome de uma pré-cadastrada do mesmo grupo.
   */
  async criarCategoria(
    workspace: string,
    nome: string,
    grupoInformado?: unknown,
  ): Promise<CategoriaDeCusto> {
    const limpo = validarNomeDeCategoria(nome);
    const grupo = validarGrupo(grupoInformado);
    if (nomeRepetidoNaBase(grupo, limpo)) {
      throw new CustoInvalidoError('Essa subcategoria já existe neste grupo.');
    }
    const chave = chaveDeUnicidadeDaCategoria(grupo, limpo);
    const existentes = await this.o.repositorio.categorias(workspace);
    const igual = existentes.find(
      (c) => chaveDeUnicidadeDaCategoria(c.grupo, c.nome) === chave,
    );
    const ativas = existentes.filter((c) => !c.arquivada).length;
    if (igual && !igual.arquivada) {
      throw new CustoInvalidoError(
        'Você já tem uma subcategoria com esse nome neste grupo.',
      );
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
      grupo,
      arquivada: false,
      criadaEm: this.agora(),
    });
    await this.o.repositorio.inserirCategoria(nova);
    return nova;
  }

  /**
   * Arquiva/reativa e/ou muda de grupo. Nunca exclui: lançamentos antigos continuam com o nome dela.
   * Mudar entre "Depósitos e garantias" e as demais despesas com lançamentos já feitos é recusado:
   * a natureza sai do grupo, e a mudança reclassificaria, calada, totais já prestados ao cliente.
   */
  async alterarCategoria(
    workspace: string,
    id: string,
    mudancas: { readonly arquivada?: boolean; readonly grupo?: unknown },
  ): Promise<CategoriaDeCusto> {
    const atual = await this.o.repositorio.buscarCategoria(workspace, id);
    if (!atual) throw new CustoNaoEncontradoError();
    const todas = await this.o.repositorio.categorias(workspace);
    let novo: CategoriaDeCusto = atual;
    if (mudancas.grupo !== undefined) {
      const grupo = validarGrupo(mudancas.grupo);
      if (grupo !== atual.grupo) {
        if (ehGrupoDeDeposito(grupo) !== ehGrupoDeDeposito(atual.grupo)) {
          const usos = await this.o.repositorio.usosDaCategoria(
            workspace,
            codigoDaCategoriaPropria(atual.id),
          );
          if (usos > 0) {
            throw new CustoInvalidoError(
              'Esta subcategoria já tem lançamentos e não pode passar de ou para "Depósitos e garantias".',
            );
          }
        }
        const chave = chaveDeUnicidadeDaCategoria(grupo, atual.nome);
        if (
          nomeRepetidoNaBase(grupo, atual.nome) ||
          todas.some(
            (c) =>
              c.id !== atual.id && chaveDeUnicidadeDaCategoria(c.grupo, c.nome) === chave,
          )
        ) {
          throw new CustoInvalidoError(
            'Já existe uma subcategoria com esse nome no grupo de destino.',
          );
        }
        novo = Object.freeze({ ...novo, grupo });
      }
    }
    if (mudancas.arquivada !== undefined) {
      if (!mudancas.arquivada && atual.arquivada) {
        const ativas = todas.filter((c) => !c.arquivada).length;
        if (ativas >= LIMITE_CATEGORIAS_PROPRIAS) {
          throw new LimiteDeCustosError('categorias', LIMITE_CATEGORIAS_PROPRIAS);
        }
      }
      novo = Object.freeze({ ...novo, arquivada: mudancas.arquivada });
    }
    await this.o.repositorio.atualizarCategoria(novo);
    return novo;
  }

  /**
   * Apaga todos os custos, recebimentos, categorias e o histórico do workspace — o caminho da
   * exclusão de conta, o mesmo `apagarDoWorkspace` dos demais dados por workspace (a exclusão de
   * conta ainda não existe no produto; quando existir, é aqui que ela chama). É o ÚNICO jeito de
   * apagar o que foi lançado.
   */
  async apagarDoWorkspace(workspace: string): Promise<number> {
    return this.o.repositorio.apagarDoWorkspace(workspace);
  }

  // ---------------------------------------------------------------------------
  // Prestação de contas

  /**
   * A prestação de contas em PDF, nos bytes. Não grava nada em disco, não loga valor.
   *
   * O documento só tem o que `DocumentoDePrestacao` comporta: número, tribunal, rótulo de cliente
   * (lido da pasta, se o processo é acompanhado e foi rotulado), o advogado de quem está logado,
   * os lançamentos e os recebimentos ATIVOS. Nenhuma parte, nenhum texto de ato, nenhum dado de
   * segredo de justiça, nada cancelado.
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
    const noPeriodo = (data: string): boolean =>
      (de === undefined || data >= de) && (ate === undefined || data <= ate);

    const categorias = await this.categoriasParaTela(workspace);
    const incluidos = (await this.o.repositorio.listar(workspace, cnj.digitos, false))
      .filter((c) => noPeriodo(c.data))
      .filter((c) => !opcoes.somenteACobrar || estaACobrar(c));
    // Do mais antigo para o mais novo: é a ordem em que uma prestação de contas se lê.
    incluidos.reverse();
    const recebimentos = (
      await this.o.repositorio.listarRecebimentos(workspace, cnj.digitos, false)
    )
      .filter((r) => noPeriodo(r.data))
      .reverse();

    const anexos = new Map<string, number>();
    for (const c of await this.o.repositorio.listarComprovantes(workspace, cnj.digitos)) {
      anexos.set(c.custoId, (anexos.get(c.custoId) ?? 0) + 1);
    }
    const secao = montarSecao(incluidos, recebimentos, categorias, anexos);

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
      linhas: secao.linhas,
      depositos: secao.depositos,
      recebimentos: secao.recebimentos,
      subtotais: secao.subtotais,
      totais: secao.totais,
    };
    const pdf = await this.o.gerador.gerar(documento);
    this.o.logger.info('prestação de contas gerada', {
      lancamentos: incluidos.length,
      recebimentos: recebimentos.length,
    });
    return {
      pdf,
      nomeDoArquivo: `prestacao-de-contas-${cnj.formatado}-${hojeLocal}.pdf`,
    };
  }

  // ---------------------------------------------------------------------------
  // Internos

  private evento(
    base: { readonly workspace: string; readonly numeroProcesso: string },
    entidade: EntidadeDoHistorico,
    entidadeId: string,
    operacao: OperacaoDoHistorico,
    campos: readonly CampoAlterado[],
    quando: Date,
    motivo?: string,
  ): EventoDoHistorico {
    return {
      id: this.o.gerarId(),
      workspace: base.workspace,
      numeroProcesso: base.numeroProcesso,
      entidade,
      entidadeId,
      operacao,
      quando,
      campos,
      ...(motivo ? { motivo } : {}),
    };
  }

  private textoDoCampo(
    campo: string,
    valor: string,
    nomes: ReadonlyMap<string, string>,
  ): string {
    switch (campo) {
      case 'valor':
        return reaisDeCentavos(Number(valor));
      case 'data':
        return dataBrasileira(valor);
      case 'categoria':
        return nomes.get(codigoAtualDaCategoria(valor)) ?? 'Categoria não identificada';
      case 'pago_por':
        return valor === 'cliente' ? 'Cliente' : 'Escritório';
      case 'reembolsavel':
        return valor === 'sim' ? 'Sim' : 'Não';
      default:
        return valor;
    }
  }

  private async exigir(workspace: string, id: string): Promise<Custo> {
    const c = await this.o.repositorio.buscar(workspace, id);
    if (!c) throw new CustoNaoEncontradoError();
    return c;
  }

  private async exigirRecebimento(workspace: string, id: string): Promise<Recebimento> {
    const r = await this.o.repositorio.buscarRecebimento(workspace, id);
    if (!r) throw new CustoNaoEncontradoError();
    return r;
  }

  private async categoriasParaTela(workspace: string): Promise<CategoriaParaTela[]> {
    const proprias = await this.o.repositorio.categorias(workspace);
    const nomeDoGrupo = (g: string): string => grupoDeCusto(g)?.nome ?? g;
    const montar = (
      codigo: string,
      nome: string,
      grupo: string,
      base: boolean,
      arquivada: boolean,
    ): CategoriaParaTela => ({
      codigo,
      nome,
      grupo,
      nomeDoGrupo: nomeDoGrupo(grupo),
      nomeCompleto: `${nomeDoGrupo(grupo)} › ${nome}`,
      base,
      arquivada,
      deposito: ehGrupoDeDeposito(grupo),
    });
    return [
      ...SUBCATEGORIAS_BASE.map((c) => montar(c.codigo, c.nome, c.grupo, true, false)),
      ...proprias.map((c) =>
        montar(codigoDaCategoriaPropria(c.id), c.nome, c.grupo, false, c.arquivada),
      ),
    ];
  }

  /**
   * A subcategoria do lançamento existe PARA ESTA conta e não está arquivada. Se o lançamento já
   * usava esta mesma (arquivada depois), `anterior` a deixa passar: editar a descrição de um custo
   * antigo não pode ser barrado porque a subcategoria foi arquivada.
   */
  private async exigirCategoriaUsavel(
    workspace: string,
    codigo: string,
    anterior: string | undefined,
  ): Promise<void> {
    if (SUBCATEGORIAS_BASE.some((c) => c.codigo === codigo)) return;
    if (!codigo.startsWith(PREFIXO_DA_CATEGORIA_PROPRIA)) {
      throw new CustoInvalidoError('Escolha uma subcategoria da lista.');
    }
    const categoria = await this.o.repositorio.buscarCategoria(
      workspace,
      codigo.slice(PREFIXO_DA_CATEGORIA_PROPRIA.length),
    );
    if (!categoria) throw new CustoInvalidoError('Escolha uma subcategoria da lista.');
    if (categoria.arquivada && codigo !== anterior) {
      throw new CustoInvalidoError('Essa subcategoria está arquivada. Escolha outra.');
    }
  }
}

/** HH:MM em São Paulo (UTC−3, sem horário de verão). */
function horaLocalDe(instante: Date): string {
  const local = new Date(instante.getTime() - 3 * 3_600_000);
  return local.toISOString().slice(11, 16);
}

/** Link do arquivo no Drive: o informado pelo Google, se for do domínio do Google; senão, montado do id. */
function linkDoDrive(arquivoId: string, informado: string | undefined): string {
  if (informado && /^https:\/\/(drive|docs)\.google\.com\//.test(informado))
    return informado;
  return `https://drive.google.com/file/d/${encodeURIComponent(arquivoId)}/view`;
}
