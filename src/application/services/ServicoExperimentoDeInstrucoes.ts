import { chaveDaMovimentacao } from '../../domain/entities/Acompanhamento.js';
import { ehFuncaoDeIa, type FuncaoDeIa } from '../../domain/entities/ControleDaIa.js';
import {
  normalizarInstrucao,
  problemaDoTexto,
  type InstrucaoDoExperimento,
} from '../../domain/entities/InstrucoesDeIa.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import { NumeroCNJInvalidoError } from '../../domain/errors/index.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import { temTextoSuficiente } from '../politicas/entradaDoModelo.js';
import type { BracoDoExperimentoDoAto } from './ServicoAnaliseDoAto.js';
import type { BracoDoExperimentoDaPeca } from './ServicoAnaliseDePeca.js';
import type { BracoDoExperimentoDoResumo } from './ServicoResumoDoProcesso.js';
import { recusarInstrucao, type ServicoInstrucoesDeIa } from './ServicoInstrucoesDeIa.js';
import type { VisaoDaPeca } from './ServicoPasta.js';

/** Quantos experimentos por hora (cada um chama o modelo duas vezes; peça pesa mais, mas é o dono quem paga). */
export const MAXIMO_DE_EXPERIMENTOS_POR_HORA = 30;
/** Quantos processos e atos a lista de casos mostra. */
export const MAXIMO_DE_PROCESSOS_NA_LISTA = 100;
export const MAXIMO_DE_ATOS_NA_LISTA = 60;

export type CasoDoExperimento =
  | { readonly funcao: 'ato'; readonly numero: string; readonly chaveDoAto: string }
  | { readonly funcao: 'resumo'; readonly numero: string }
  | { readonly funcao: 'peca'; readonly numero: string; readonly pecaId: string };

export type BracoDoExperimento =
  BracoDoExperimentoDoAto | BracoDoExperimentoDoResumo | BracoDoExperimentoDaPeca;

export interface ResultadoDoExperimento {
  readonly funcao: FuncaoDeIa;
  readonly bracos: readonly BracoDoExperimento[];
}

export interface ProcessoDaLista {
  readonly numero: string;
  readonly numeroFormatado: string;
  readonly tribunal: string;
  readonly classe: string | null;
  readonly apelido: string | null;
  readonly sigiloso: boolean;
  readonly ultimaMovimentacaoEm: Date | null;
  readonly atos: number;
}

export interface AtoDaLista {
  readonly chaveDoAto: string;
  readonly data: Date;
  readonly titulo: string;
  readonly tipoComunicacao: string | null;
  /** O ato tem texto suficiente para a IA ler? */
  readonly legivel: boolean;
}

export interface PecaDaLista {
  readonly pecaId: string;
  readonly rotulo: string;
  readonly data: Date | null;
  readonly paginas: number | null;
}

export interface FontesDoExperimento {
  readonly ato?: {
    experimentar(p: {
      workspace: string;
      numero: string;
      chaveDoAto: string;
      instrucoes: readonly InstrucaoDoExperimento[];
      sinal?: AbortSignal;
    }): Promise<readonly BracoDoExperimentoDoAto[]>;
  };
  readonly resumo?: {
    experimentar(p: {
      workspace: string;
      numero: string;
      instrucoes: readonly InstrucaoDoExperimento[];
      sinal?: AbortSignal;
    }): Promise<readonly BracoDoExperimentoDoResumo[]>;
  };
  readonly peca?: {
    experimentar(p: {
      workspace: string;
      numero: string;
      pecaId: string;
      instrucoes: readonly InstrucaoDoExperimento[];
      sinal?: AbortSignal;
    }): Promise<readonly BracoDoExperimentoDaPeca[]>;
  };
}

export interface OpcoesDoServicoExperimentoDeInstrucoes {
  readonly instrucoes: ServicoInstrucoesDeIa;
  readonly fontes: FontesDoExperimento;
  readonly repositorio: Pick<RepositorioAcompanhamentos, 'listar' | 'buscar'>;
  /** A lista de peças da Pasta digital da conta (só leitura; nunca consulta o tribunal). */
  readonly pasta?: {
    visao(
      workspace: string,
      numero: string,
    ): Promise<{ readonly pecas: readonly VisaoDaPeca[] }>;
  };
  /**
   * O workspace da conta do PRÓPRIO operador (a que tem o e-mail do operador). Sem conta, o experimento
   * não existe: o painel nunca lê o processo de outro assinante.
   */
  readonly contaDoDono: () => Promise<string | undefined>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly maximoPorHora?: number;
}

/**
 * O experimento do operador (Fase C, v0.61.0): rodar a instrução PUBLICADA e o RASCUNHO sobre o mesmo caso
 * real e mostrar as duas respostas lado a lado. **Só a conta do próprio operador** fornece casos (o
 * workspace do e-mail do operador); o resultado volta na resposta da rota e **não é gravado**: nem o texto
 * do caso, nem as respostas — só contagens no log. Um por vez e no máximo 30 por hora. Cada serviço de IA
 * roda o seu MESMO caminho de produção (redação, modelo com ZDR, verificação, segredo de justiça), então
 * nada disto é um atalho: processo em segredo de justiça e peça sigilosa são recusados antes do modelo.
 */
export class ServicoExperimentoDeInstrucoes {
  private emAndamento = false;
  private readonly horas: number[] = [];
  private readonly log: Logger;

  constructor(private readonly o: OpcoesDoServicoExperimentoDeInstrucoes) {
    this.log = o.logger.child({ servico: 'experimento-de-instrucoes' });
  }

  /** A função tem serviço de IA montado neste servidor? */
  disponivelPara(funcao: FuncaoDeIa): boolean {
    return this.o.fontes[funcao] !== undefined;
  }

  // --- a lista de casos (só da conta do operador) --------------------------------------------------------------

  async processos(): Promise<readonly ProcessoDaLista[]> {
    const ws = await this.conta();
    const itens = await this.o.repositorio.listar(ws, { ordem: 'MOVIMENTACAO_RECENTE' });
    return itens.slice(0, MAXIMO_DE_PROCESSOS_NA_LISTA).map((a) => {
      const p = a.processo;
      return {
        numero: a.numero,
        numeroFormatado: NumeroCNJ.criar(a.numero).formatado,
        tribunal: p?.tribunal ?? '',
        classe: p?.classe ?? null,
        apelido: a.apelido ?? null,
        sigiloso: p?.segredoJustica === true,
        ultimaMovimentacaoEm: a.ultimaMovimentacao?.data ?? null,
        atos: p?.movimentacoes.length ?? 0,
      };
    });
  }

  async atos(numeroBruto: string): Promise<{
    readonly sigiloso: boolean;
    readonly atos: readonly AtoDaLista[];
  }> {
    const ws = await this.conta();
    const numero = this.numero(numeroBruto);
    const a = await this.o.repositorio.buscar(ws, numero);
    const processo = a?.processo;
    if (!a || !processo) throw recusarInstrucao('caso_nao_encontrado');
    // Processo em segredo de justiça: a lista nem mostra os atos (o modelo não os veria de qualquer jeito).
    if (processo.segredoJustica) return { sigiloso: true, atos: [] };
    const atos = [...processo.movimentacoes]
      .sort((x, y) => y.data.getTime() - x.data.getTime())
      .slice(0, MAXIMO_DE_ATOS_NA_LISTA)
      .map((m): AtoDaLista => ({
        chaveDoAto: chaveDaMovimentacao(m),
        data: m.data,
        titulo: m.titulo,
        tipoComunicacao: m.tipoComunicacao?.trim() || null,
        legivel:
          m.teorIndisponivel !== true &&
          temTextoSuficiente({
            data: m.data,
            titulo: m.titulo,
            ...(m.conteudo !== undefined ? { conteudo: m.conteudo } : {}),
            ...(m.complementos ? { complementos: m.complementos } : {}),
          }),
      }));
    return { sigiloso: false, atos };
  }

  /** As peças que já estão em guarda (24 h) na Pasta digital: as únicas que a análise de peça lê. */
  async pecas(numeroBruto: string): Promise<{
    readonly sigiloso: boolean;
    readonly pecas: readonly PecaDaLista[];
  }> {
    const ws = await this.conta();
    const numero = this.numero(numeroBruto);
    const a = await this.o.repositorio.buscar(ws, numero);
    if (!a?.processo) throw recusarInstrucao('caso_nao_encontrado');
    if (a.processo.segredoJustica) return { sigiloso: true, pecas: [] };
    if (!this.o.pasta) return { sigiloso: false, pecas: [] };
    const visao = await this.o.pasta.visao(ws, numero);
    return {
      sigiloso: false,
      pecas: visao.pecas
        .filter((p) => p.estado === 'disponivel')
        .map((p) => ({
          pecaId: p.pecaId,
          rotulo: p.rotulo,
          data: p.data ?? null,
          paginas: p.paginasDaPeca ?? null,
        })),
    };
  }

  // --- o experimento ---------------------------------------------------------------------------------------------------

  /**
   * Roda a instrução publicada e o rascunho (`texto`; o salvo, se ausente) sobre o caso. Nada é gravado.
   */
  async experimentar(
    caso: CasoDoExperimento,
    texto: string | undefined,
    sinal?: AbortSignal,
  ): Promise<ResultadoDoExperimento> {
    if (!ehFuncaoDeIa(caso.funcao)) throw recusarInstrucao('funcao_desconhecida');
    const ws = await this.conta();
    const numero = this.numero(caso.numero);
    const fonte = this.o.fontes[caso.funcao];
    if (!fonte) throw recusarInstrucao('experimento_indisponivel');
    if (
      texto !== undefined &&
      problemaDoTexto(texto, { exigirTexto: false }) === 'grande'
    ) {
      throw recusarInstrucao('texto_grande');
    }

    const publicada = this.o.instrucoes.efetiva(caso.funcao);
    const estado = this.o.instrucoes.estado(caso.funcao);
    const textoDoRascunho = normalizarInstrucao(texto ?? estado.rascunho?.texto ?? '');
    const instrucoes: readonly InstrucaoDoExperimento[] = [
      { rotulo: 'publicada', versao: publicada.versao, texto: publicada.texto },
      {
        rotulo: 'rascunho',
        versao: estado.rascunho?.versao ?? 0,
        texto: textoDoRascunho,
      },
    ];

    if (caso.funcao === 'ato' && !caso.chaveDoAto)
      throw recusarInstrucao('caso_invalido');
    if (caso.funcao === 'peca' && !caso.pecaId) throw recusarInstrucao('caso_invalido');
    this.reservar();
    try {
      const comSinal = sinal ? { sinal } : {};
      let bracos: readonly BracoDoExperimento[];
      if (caso.funcao === 'ato') {
        bracos = await (
          this.o.fontes.ato as NonNullable<FontesDoExperimento['ato']>
        ).experimentar({
          workspace: ws,
          numero,
          chaveDoAto: caso.chaveDoAto,
          instrucoes,
          ...comSinal,
        });
      } else if (caso.funcao === 'resumo') {
        bracos = await (
          this.o.fontes.resumo as NonNullable<FontesDoExperimento['resumo']>
        ).experimentar({ workspace: ws, numero, instrucoes, ...comSinal });
      } else {
        bracos = await (
          this.o.fontes.peca as NonNullable<FontesDoExperimento['peca']>
        ).experimentar({
          workspace: ws,
          numero,
          pecaId: caso.pecaId,
          instrucoes,
          ...comSinal,
        });
      }
      // Só contagens: nada de texto do caso, das respostas, número de processo ou conta.
      this.log.info('experimento de instruções concluído', {
        funcao: caso.funcao,
        bracosOk: bracos.filter((b) => b.estado === 'ok').length,
        bracosComErro: bracos.filter((b) => b.estado === 'erro').length,
        comRascunho: textoDoRascunho !== '',
      });
      return { funcao: caso.funcao, bracos };
    } finally {
      this.emAndamento = false;
    }
  }

  // --- internos ---------------------------------------------------------------------------------------------------------

  private async conta(): Promise<string> {
    const ws = await this.o.contaDoDono();
    if (!ws) throw recusarInstrucao('conta_do_dono_ausente');
    return ws;
  }

  private numero(bruto: string): string {
    try {
      return NumeroCNJ.criar(bruto).digitos;
    } catch (erro) {
      if (erro instanceof NumeroCNJInvalidoError) throw recusarInstrucao('caso_invalido');
      throw erro;
    }
  }

  /** Um por vez e no máximo N por hora (em memória: reiniciar zera, como os outros freios). */
  private reservar(): void {
    if (this.emAndamento) throw recusarInstrucao('experimento_em_andamento');
    const agora = this.o.clock.agora().getTime();
    while (this.horas.length > 0 && agora - (this.horas[0] ?? 0) >= 3_600_000)
      this.horas.shift();
    if (this.horas.length >= (this.o.maximoPorHora ?? MAXIMO_DE_EXPERIMENTOS_POR_HORA)) {
      throw recusarInstrucao('limite_de_experimentos');
    }
    this.horas.push(agora);
    this.emAndamento = true;
  }
}
