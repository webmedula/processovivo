import { codigoAtualDaCategoria } from '../../domain/entities/CatalogoDeCustos.js';
import { calcularTotais } from '../../domain/entities/Custo.js';
import type { Custo, TotaisDeCusto } from '../../domain/entities/Custo.js';
import {
  NOME_SEM_CLIENTE,
  SEM_CLIENTE,
  chaveDoCliente,
  somarTotais,
} from '../../domain/entities/CustosPorCliente.js';
import type { ResumoDeTotais } from '../../domain/entities/CustosPorCliente.js';
import {
  dataBrasileira,
  dataLocalEm,
  ehDataLocalValida,
} from '../../domain/entities/EventoDeCalendario.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type { Recebimento } from '../../domain/entities/Recebimento.js';
import { campoDeCentavos } from '../../domain/entities/valorEmReais.js';
import {
  CustoInvalidoError,
  CustoNaoEncontradoError,
} from '../../domain/errors/index.js';
import type {
  DocumentoConsolidadoDePrestacao,
  GeradorDePrestacaoDeContas,
} from '../../domain/ports/GeradorDePrestacaoDeContas.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import type { RepositorioDeCustos } from '../../domain/ports/RepositorioDeCustos.js';
import {
  celulaDeTexto,
  celulaNumerica,
  linhaDeCsv,
  montarCsv,
} from '../politicas/csvDeCustos.js';
import {
  itensParaTotais,
  linhasDeTotais,
  montarSecao,
  nomeCompletoDaCategoria,
} from './prestacaoDeCustos.js';
import type { CategoriaParaTela, QuemGera, ServicoCustos } from './ServicoCustos.js';

export interface OpcoesServicoCustosPorCliente {
  readonly repositorio: RepositorioDeCustos;
  /** Só para LER o rótulo de cliente de cada processo (nunca para escrever). */
  readonly acompanhamentos: RepositorioAcompanhamentos;
  readonly custos: ServicoCustos;
  readonly gerador: GeradorDePrestacaoDeContas;
  readonly logger: Logger;
  readonly versao: string;
  readonly agora?: () => Date;
}

export interface FiltroPorCliente {
  readonly de?: string;
  readonly ate?: string;
  /** A chave do cliente (`chaveDoCliente`), ou `SEM_CLIENTE`. */
  readonly cliente?: string;
  readonly somenteComSaldo?: boolean;
}

export interface ClienteResumido extends ResumoDeTotais {
  readonly chave: string;
  readonly nome: string;
  readonly semCliente: boolean;
}

export interface ListaDeClientes {
  readonly clientes: readonly ClienteResumido[];
  /** SEM filtro nenhum (nem período): "mostrando X de Y". */
  readonly totalDeClientes: number;
  readonly totalDeProcessos: number;
  /** Quantos processos (no filtro de período) não têm rótulo de cliente. */
  readonly processosSemCliente: number;
}

export interface ProcessoDoCliente {
  readonly numeroProcesso: string;
  readonly formatado: string;
  readonly tribunal: string;
  readonly lancamentos: number;
  readonly recebimentos: number;
  readonly totais: Omit<ResumoDeTotais, 'processos'>;
}

export interface DetalheDoCliente {
  readonly chave: string;
  readonly nome: string;
  readonly semCliente: boolean;
  readonly totais: ResumoDeTotais;
  readonly processos: readonly ProcessoDoCliente[];
  /** Processos do cliente SEM filtro de período nem de saldo. */
  readonly totalDeProcessos: number;
}

export interface OpcoesDoCsv {
  readonly numero?: string;
  readonly cliente?: string;
  readonly de?: string;
  readonly ate?: string;
  readonly incluirCancelados?: boolean;
}

interface DadosDoProcesso {
  readonly numero: string;
  readonly custos: Custo[];
  readonly recebimentos: Recebimento[];
}

const CABECALHO_DO_CSV = [
  'Tipo',
  'Situação',
  'Processo',
  'Cliente',
  'Data',
  'Descrição',
  'Subcategoria',
  'Pago por',
  'Cobrar do cliente',
  'Valor',
  'Comprovantes',
] as const;

/**
 * Custos por cliente (v0.49.0): a visão que junta os processos pelo rótulo de cliente, o PDF
 * consolidado e o CSV. É LEITURA: nada aqui grava, e o que sai (PDF, CSV) nasce na resposta, sem ir a
 * disco. Tudo parte do modelo da 0.48.0 — `calcularTotais` por processo e só a soma dos inteiros por
 * cima — e nunca traz parte, texto de ato nem dado de segredo de justiça.
 *
 * O cliente é o rótulo da pasta do processo, e só processo ACOMPANHADO tem pasta: o que não tem cai em
 * "Sem cliente". Nada de valor, descrição, nome de cliente ou de arquivo vai a log (só contagens).
 */
export class ServicoCustosPorCliente {
  private readonly agora: () => Date;

  constructor(private readonly o: OpcoesServicoCustosPorCliente) {
    this.agora = o.agora ?? (() => new Date());
  }

  async listar(workspace: string, filtro: FiltroPorCliente): Promise<ListaDeClientes> {
    validarPeriodo(filtro.de, filtro.ate);
    const base = await this.carregar(workspace, false);
    const todos = this.agrupar(base);
    const noPeriodo = this.agrupar(base, filtro);
    let clientes = [...noPeriodo.values()].map((g) => g.resumo);
    if (filtro.cliente) clientes = clientes.filter((c) => c.chave === filtro.cliente);
    if (filtro.somenteComSaldo)
      clientes = clientes.filter((c) => c.saldoACobrarCentavos > 0);
    clientes.sort(
      (a, b) =>
        Number(a.semCliente) - Number(b.semCliente) ||
        a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }),
    );
    return {
      clientes,
      totalDeClientes: todos.size,
      totalDeProcessos: [...todos.values()].reduce((n, g) => n + g.processos.length, 0),
      processosSemCliente: noPeriodo.get(SEM_CLIENTE)?.processos.length ?? 0,
    };
  }

  async detalhar(
    workspace: string,
    chave: string,
    filtro: FiltroPorCliente,
  ): Promise<DetalheDoCliente> {
    validarPeriodo(filtro.de, filtro.ate);
    const base = await this.carregar(workspace, false);
    const grupo = this.agrupar(base, { ...filtro, somenteComSaldo: false }).get(chave);
    const todosOsDele = this.agrupar(base).get(chave);
    if (!todosOsDele) throw new CustoNaoEncontradoError();
    const processos = (grupo?.processos ?? []).filter(
      (p) => !filtro.somenteComSaldo || p.totais.saldoACobrarCentavos > 0,
    );
    return {
      chave,
      nome: todosOsDele.resumo.nome,
      semCliente: chave === SEM_CLIENTE,
      totais: grupo?.resumo ?? somarTotais([]),
      processos: processos.map((p) => p.paraTela),
      totalDeProcessos: todosOsDele.processos.length,
    };
  }

  /** O PDF consolidado do cliente: uma seção por processo e os totais gerais. */
  async gerarPrestacaoDoCliente(
    workspace: string,
    chave: string,
    filtro: FiltroPorCliente,
    quem: QuemGera | undefined,
  ): Promise<{ readonly pdf: Uint8Array; readonly nomeDoArquivo: string }> {
    validarPeriodo(filtro.de, filtro.ate);
    const base = await this.carregar(workspace, false);
    const existe = this.agrupar(base).get(chave);
    if (!existe) throw new CustoNaoEncontradoError();
    const grupo = this.agrupar(base, filtro).get(chave);
    const processos = (grupo?.processos ?? []).filter(
      (p) => !filtro.somenteComSaldo || p.totais.saldoACobrarCentavos > 0,
    );
    const categorias = base.categorias;
    const secoes = processos.map((p) => {
      const cnj = NumeroCNJ.criar(p.numero);
      const s = montarSecao(p.custos, p.recebimentos, categorias, base.anexos);
      return {
        numeroProcesso: cnj.formatado,
        tribunal: cnj.siglaTribunal ?? 'Tribunal não identificado',
        linhas: s.linhas,
        depositos: s.depositos,
        recebimentos: s.recebimentos,
        subtotais: s.subtotais,
        totais: s.totais,
        resultado: s.resultado,
      };
    });
    const geral = somarTotais(secoes.map((s) => s.resultado));
    const agora = this.agora();
    const hoje = dataLocalEm(agora);
    const filtros: string[] = [];
    if (filtro.de !== undefined || filtro.ate !== undefined) {
      filtros.push(
        `Período: ${filtro.de !== undefined ? `de ${dataBrasileira(filtro.de)}` : 'desde o início'}` +
          `${filtro.ate !== undefined ? ` até ${dataBrasileira(filtro.ate)}` : ''}`,
      );
    }
    if (filtro.somenteComSaldo) filtros.push('Somente processos com saldo a cobrar');
    const documento: DocumentoConsolidadoDePrestacao = {
      cliente: existe.resumo.nome,
      ...(quem
        ? { advogado: { nome: quem.nome, ...(quem.oab ? { oab: quem.oab } : {}) } }
        : {}),
      geradoEm: `${dataBrasileira(hoje)} ${horaLocalDe(agora)}`,
      filtros,
      versao: this.o.versao,
      secoes: secoes.map(({ resultado: _r, ...resto }) => resto),
      totaisGerais: linhasDeTotais(geral),
    };
    const pdf = await this.o.gerador.gerarConsolidado(documento);
    this.o.logger.info('prestação de contas do cliente gerada', {
      processos: secoes.length,
    });
    return { pdf, nomeDoArquivo: `prestacao-de-contas-por-cliente-${hoje}.pdf` };
  }

  /**
   * O CSV, uma linha por lançamento e outra por recebimento (coluna "Tipo"). Cancelados só entram
   * com `incluirCancelados`, e então marcados na coluna "Situação". Texto neutralizado contra
   * injeção de fórmula; UTF-8 com BOM, `;` e vírgula decimal.
   */
  async gerarCsv(
    workspace: string,
    opcoes: OpcoesDoCsv,
  ): Promise<{ readonly csv: string; readonly nomeDoArquivo: string }> {
    validarPeriodo(opcoes.de, opcoes.ate);
    const numero = opcoes.numero ? NumeroCNJ.criar(opcoes.numero).digitos : undefined;
    const base = await this.carregar(workspace, opcoes.incluirCancelados === true);
    let processos = [...base.porProcesso.values()];
    if (numero) processos = processos.filter((p) => p.numero === numero);
    if (opcoes.cliente) {
      processos = processos.filter(
        (p) => chaveDoCliente(base.rotulos.get(p.numero)) === opcoes.cliente,
      );
    }
    const noPeriodo = (data: string): boolean =>
      (opcoes.de === undefined || data >= opcoes.de) &&
      (opcoes.ate === undefined || data <= opcoes.ate);
    const ehDeposito = (cat: string): boolean =>
      base.categorias.find((c) => c.codigo === codigoAtualDaCategoria(cat))?.deposito ===
      true;

    const linhas: string[] = [];
    for (const p of [...processos].sort((a, b) => a.numero.localeCompare(b.numero))) {
      const cnj = NumeroCNJ.criar(p.numero);
      const cliente =
        base.nomes.get(chaveDoCliente(base.rotulos.get(p.numero))) ?? NOME_SEM_CLIENTE;
      const registros = [
        ...p.custos
          .filter((c) => noPeriodo(c.data))
          .map((c) => ({ ordem: 0, data: c.data, id: c.id, c, r: undefined })),
        ...p.recebimentos
          .filter((r) => noPeriodo(r.data))
          .map((r) => ({ ordem: 1, data: r.data, id: r.id, c: undefined, r })),
      ].sort(
        (a, b) =>
          a.data.localeCompare(b.data) || a.ordem - b.ordem || a.id.localeCompare(b.id),
      );
      for (const x of registros) {
        if (x.c) {
          const c = x.c;
          linhas.push(
            linhaDeCsv([
              celulaDeTexto(ehDeposito(c.categoria) ? 'Depósito' : 'Despesa'),
              celulaDeTexto(c.canceladoEm ? 'Cancelado' : 'Ativo'),
              celulaDeTexto(cnj.formatado),
              celulaDeTexto(cliente),
              celulaDeTexto(dataBrasileira(c.data)),
              celulaDeTexto(c.descricao),
              celulaDeTexto(nomeCompletoDaCategoria(base.categorias, c.categoria)),
              celulaDeTexto(c.pagoPor === 'cliente' ? 'Cliente' : 'Escritório'),
              celulaDeTexto(c.pagoPor === 'escritorio' && c.reembolsavel ? 'Sim' : 'Não'),
              celulaNumerica(campoDeCentavos(c.valorCentavos)),
              celulaNumerica(String(base.anexos.get(c.id) ?? 0)),
            ]),
          );
        } else if (x.r) {
          const r = x.r;
          linhas.push(
            linhaDeCsv([
              celulaDeTexto('Recebimento'),
              celulaDeTexto(r.canceladoEm ? 'Cancelado' : 'Ativo'),
              celulaDeTexto(cnj.formatado),
              celulaDeTexto(cliente),
              celulaDeTexto(dataBrasileira(r.data)),
              celulaDeTexto(r.observacao ?? ''),
              celulaDeTexto(''),
              celulaDeTexto(''),
              celulaDeTexto(''),
              celulaNumerica(campoDeCentavos(r.valorCentavos)),
              celulaNumerica(''),
            ]),
          );
        }
      }
    }
    const hoje = dataLocalEm(this.agora());
    this.o.logger.info('csv de custos gerado', { linhas: linhas.length });
    return {
      csv: montarCsv(CABECALHO_DO_CSV, linhas),
      nomeDoArquivo: numero
        ? `custos-${NumeroCNJ.criar(numero).formatado}-${hoje}.csv`
        : `custos-por-cliente-${hoje}.csv`,
    };
  }

  // ---------------------------------------------------------------------------

  private async carregar(workspace: string, incluirCancelados: boolean): Promise<Carga> {
    const [custos, recebimentos, rotulos, categorias, comprovantes] = await Promise.all([
      this.o.repositorio.listarDoWorkspace(workspace, {}, incluirCancelados),
      this.o.repositorio.listarRecebimentosDoWorkspace(workspace, {}, incluirCancelados),
      this.o.acompanhamentos.rotulosDeCliente(workspace),
      this.o.custos.listarCategorias(workspace),
      this.o.repositorio.listarComprovantes(workspace),
    ]);
    const porProcesso = new Map<string, DadosDoProcesso>();
    const de = (n: string): DadosDoProcesso => {
      let d = porProcesso.get(n);
      if (!d) {
        d = { numero: n, custos: [], recebimentos: [] };
        porProcesso.set(n, d);
      }
      return d;
    };
    for (const c of custos) de(c.numeroProcesso).custos.push(c);
    for (const r of recebimentos) de(r.numeroProcesso).recebimentos.push(r);
    const anexos = new Map<string, number>();
    for (const c of comprovantes) anexos.set(c.custoId, (anexos.get(c.custoId) ?? 0) + 1);
    // "Grupo Lume" e "grupo  LUME" são o mesmo cliente: um nome só, estável (o do menor número).
    const nomes = new Map<string, string>();
    for (const n of [...rotulos.keys()].sort()) {
      const rotulo = rotulos.get(n)?.trim();
      if (rotulo && !nomes.has(chaveDoCliente(rotulo)))
        nomes.set(chaveDoCliente(rotulo), rotulo);
    }
    return { porProcesso, rotulos, nomes, categorias, anexos };
  }

  /** Agrupa por cliente, já com o filtro de período e os totais de cada processo (só os ATIVOS). */
  private agrupar(base: Carga, filtro: FiltroPorCliente = {}): Map<string, Grupo> {
    const grupos = new Map<string, Grupo>();
    const noPeriodo = (data: string): boolean =>
      (filtro.de === undefined || data >= filtro.de) &&
      (filtro.ate === undefined || data <= filtro.ate);
    for (const p of base.porProcesso.values()) {
      const custos = p.custos.filter((c) => !c.canceladoEm && noPeriodo(c.data));
      const recs = p.recebimentos.filter((r) => !r.canceladoEm && noPeriodo(r.data));
      if (custos.length === 0 && recs.length === 0) continue;
      const rotulo = base.rotulos.get(p.numero);
      const chave = chaveDoCliente(rotulo);
      const totais: TotaisDeCusto = calcularTotais(
        itensParaTotais(custos, base.categorias),
        recs,
      );
      const cnj = NumeroCNJ.criar(p.numero);
      const processo: ProcessoAgrupado = {
        numero: p.numero,
        custos,
        recebimentos: recs,
        totais: totais,
        paraTela: {
          numeroProcesso: p.numero,
          formatado: cnj.formatado,
          tribunal: cnj.siglaTribunal ?? 'Tribunal não identificado',
          lancamentos: custos.length,
          recebimentos: recs.length,
          totais: resumoSemProcessos(totais),
        },
      };
      let g = grupos.get(chave);
      if (!g) {
        g = {
          nome: rotulo?.trim() || NOME_SEM_CLIENTE,
          processos: [],
          resumo: undefined as never,
        };
        grupos.set(chave, g);
      }
      g.processos.push(processo);
    }
    for (const [chave, g] of grupos) {
      g.processos.sort((a, b) => a.numero.localeCompare(b.numero));
      g.resumo = {
        chave,
        nome: g.nome,
        semCliente: chave === SEM_CLIENTE,
        ...somarTotais(g.processos.map((p) => p.totais)),
      };
    }
    return grupos;
  }
}

interface Carga {
  readonly porProcesso: Map<string, DadosDoProcesso>;
  readonly rotulos: ReadonlyMap<string, string>;
  /** Como o cliente é CHAMADO: o rótulo do primeiro processo (por número) que usa aquela chave. */
  readonly nomes: ReadonlyMap<string, string>;
  readonly categorias: readonly CategoriaParaTela[];
  readonly anexos: Map<string, number>;
}
interface ProcessoAgrupado extends DadosDoProcesso {
  readonly totais: TotaisDeCusto;
  readonly paraTela: ProcessoDoCliente;
}
interface Grupo {
  nome: string;
  processos: ProcessoAgrupado[];
  resumo: ClienteResumido;
}

function resumoSemProcessos(t: TotaisDeCusto): Omit<ResumoDeTotais, 'processos'> {
  const { processos: _p, ...resto } = somarTotais([t]);
  return resto;
}

function validarPeriodo(de: string | undefined, ate: string | undefined): void {
  for (const d of [de, ate]) {
    if (d !== undefined && !ehDataLocalValida(d)) {
      throw new CustoInvalidoError('Informe o período com datas válidas (dd/mm/aaaa).');
    }
  }
  if (de !== undefined && ate !== undefined && de > ate) {
    throw new CustoInvalidoError('A data inicial não pode ser depois da data final.');
  }
}

/** HH:MM em São Paulo (UTC−3, sem horário de verão). */
function horaLocalDe(instante: Date): string {
  const local = new Date(instante.getTime() - 3 * 3_600_000);
  return local.toISOString().slice(11, 16);
}

export type { CategoriaParaTela };
