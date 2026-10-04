import { NumeroCNJ } from '../../../domain/entities/NumeroCNJ.js';
import type { Movimentacao } from '../../../domain/entities/Movimentacao.js';
import type { Parte } from '../../../domain/entities/Parte.js';
import { Processo } from '../../../domain/entities/Processo.js';
import {
  OperacaoNaoSuportadaError,
  ProcessoNaoEncontradoError,
  ProviderIndisponivelError,
} from '../../../domain/errors/index.js';
import type { Clock } from '../../../domain/ports/Clock.js';
import { clockDoSistema } from '../../../domain/ports/Clock.js';
import type {
  CapacidadesProvider,
  DiagnosticoProvider,
  ProcessoProvider,
} from '../../../domain/ports/ProcessoProvider.js';
import type { ProcessoFixture } from './fixtures/tjsp.fixtures.js';
import { PROCESSOS_POR_OAB, PROCESSOS_TJSP } from './fixtures/tjsp.fixtures.js';

export const NOME_MOCK_CRAWLER = 'mock-crawler-tjsp';

export interface OpcoesMockCrawler {
  /** Latência simulada em ms. Padrão: 120. */
  readonly latenciaMs?: number;
  /** Probabilidade de falha por chamada, de 0 a 1. Padrão: 0. */
  readonly taxaDeFalha?: number;
  /** `healthCheck` responde isto. Padrão: true. */
  readonly saudavel?: boolean;
  /** Substitui a massa padrão — útil para cenários específicos de teste. */
  readonly processos?: readonly ProcessoFixture[];
  readonly processosPorOab?: ReadonlyMap<string, readonly string[]>;
  /** Fonte de aleatoriedade injetável, para tornar a falha determinística no teste. */
  readonly aleatorio?: () => number;
  readonly clock?: Clock;
}

/**
 * Crawler simulado do e-SAJ (TJSP).
 *
 * Existe por dois motivos, e o segundo é o que justifica o arquivo:
 *
 * 1. Desacoplar o desenvolvimento do tribunal estar no ar. Crawler real depende
 *    de HTML instável, captcha e janela de manutenção — nada disso pode ser
 *    pré-requisito para rodar `npm test`.
 * 2. Ser o gêmeo de contrato do crawler de verdade. Ele responde os MESMOS tipos
 *    de erro, tem as MESMAS capacidades (traz partes e o inteiro teor dos
 *    despachos — o que o DataJud não tem) e sabe FALHAR sob demanda, via
 *    `taxaDeFalha`. Sem falha configurável, o caminho de fallback do
 *    orquestrador nunca seria exercitado até quebrar em produção.
 *
 * Quando o crawler real nascer, ele implementa a mesma porta e entra na cadeia
 * trocando uma linha do composition root.
 */
export class MockCrawlerAdapter implements ProcessoProvider {
  readonly nome = NOME_MOCK_CRAWLER;

  readonly capacidades: CapacidadesProvider = {
    buscarPorNumero: true,
    buscarPorOab: true,
    retornaPartes: true,
    retornaConteudoMovimentacoes: true,
    retornaLinhaDoTempoCompleta: true,
    tribunais: ['TJSP'],
  };

  private readonly latenciaMs: number;
  private readonly taxaDeFalha: number;
  private readonly saudavel: boolean;
  private readonly porNumero: Map<string, ProcessoFixture>;
  private readonly porOab: ReadonlyMap<string, readonly string[]>;
  private readonly aleatorio: () => number;
  private readonly clock: Clock;

  constructor(opcoes: OpcoesMockCrawler = {}) {
    this.latenciaMs = opcoes.latenciaMs ?? 120;
    this.taxaDeFalha = Math.min(1, Math.max(0, opcoes.taxaDeFalha ?? 0));
    this.saudavel = opcoes.saudavel ?? true;
    this.aleatorio = opcoes.aleatorio ?? Math.random;
    this.clock = opcoes.clock ?? clockDoSistema;

    const fixtures = opcoes.processos ?? PROCESSOS_TJSP;
    this.porNumero = new Map(
      fixtures.map((f) => [somenteDigitos(f.numero), f] as const),
    );
    this.porOab = opcoes.processosPorOab ?? PROCESSOS_POR_OAB;
  }

  async buscarPorNumero(numeroProcesso: string): Promise<Processo> {
    const numero = NumeroCNJ.criar(numeroProcesso);

    if (numero.siglaTribunal !== 'TJSP') {
      throw new OperacaoNaoSuportadaError(
        this.nome,
        'buscarPorNumero',
        `este crawler cobre apenas o TJSP; recebido ${numero.siglaTribunal ?? 'tribunal desconhecido'}`,
      );
    }

    await this.simularIda();

    const fixture = this.porNumero.get(numero.digitos);
    if (!fixture) {
      throw new ProcessoNaoEncontradoError(`número ${numero.formatado}`, this.nome);
    }
    return this.mapear(fixture);
  }

  async buscarPorOab(oab: string, uf: string): Promise<Processo[]> {
    await this.simularIda();

    const chave = `${oab.replace(/^0+(?=\d)/, '')}/${uf.toUpperCase()}`;
    const numeros = this.porOab.get(chave) ?? [];

    // Lista vazia é resposta legítima ("esse advogado não tem processos aqui"),
    // e não uma falha — quem chama distingue as duas coisas pelo tipo do retorno.
    return numeros
      .map((n) => this.porNumero.get(somenteDigitos(n)))
      .filter((f): f is ProcessoFixture => f !== undefined)
      .map((f) => this.mapear(f));
  }

  async healthCheck(): Promise<boolean> {
    await this.dormir(Math.min(this.latenciaMs, 30));
    return this.saudavel;
  }

  async diagnosticar(): Promise<DiagnosticoProvider> {
    const saudavel = await this.healthCheck();
    return saudavel
      ? { saudavel: true }
      : { saudavel: false, motivo: 'crawler marcado como indisponível na configuração' };
  }

  private async simularIda(): Promise<void> {
    await this.dormir(this.latenciaMs);
    if (this.taxaDeFalha > 0 && this.aleatorio() < this.taxaDeFalha) {
      throw new ProviderIndisponivelError(
        this.nome,
        'falha simulada do crawler (e-SAJ indisponível ou captcha)',
      );
    }
  }

  private dormir(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private mapear(fixture: ProcessoFixture): Processo {
    const partes: Parte[] = fixture.partes.map((p) => ({
      nome: p.nome,
      polo: p.polo,
      tipoPessoa: p.tipoPessoa,
      ...(p.documento ? { documento: p.documento } : {}),
      advogados: p.advogados.map((a) => ({
        nome: a.nome,
        ...(a.oab ? { oab: a.oab } : {}),
        ...(a.ufOab ? { ufOab: a.ufOab } : {}),
      })),
    }));

    const movimentacoes: Movimentacao[] = fixture.movimentacoes.map((m) => ({
      data: new Date(m.data),
      titulo: m.titulo,
      ...(m.conteudo ? { conteudo: m.conteudo } : {}),
    }));

    return new Processo({
      numero: NumeroCNJ.criar(fixture.numero),
      tribunal: fixture.tribunal,
      vara: fixture.vara,
      classe: fixture.classe,
      assuntos: fixture.assuntos,
      dataDistribuicao: new Date(fixture.dataDistribuicao),
      grau: fixture.grau,
      ...(fixture.valorCausa !== undefined ? { valorCausa: fixture.valorCausa } : {}),
      segredoJustica: fixture.segredoJustica ?? false,
      partes,
      movimentacoes,
      procedencia: {
        provider: this.nome,
        consultadoEm: this.clock.agora(),
        deCache: false,
      },
    });
  }
}

function somenteDigitos(valor: string): string {
  return valor.replace(/\D/g, '');
}
