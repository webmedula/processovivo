import type { NumeroCNJ } from './NumeroCNJ.js';
import type { Movimentacao } from './Movimentacao.js';
import { ordenarPorDataDesc } from './Movimentacao.js';
import type { Parte } from './Parte.js';
import { triarTodas } from './triagem.js';

/** De onde vieram os dados desta instância. Sobrevive até a resposta da API. */
export interface Procedencia {
  /** Identificador do provider — ex.: "datajud", "crawler-tjsp". */
  readonly provider: string;
  /** Momento em que a fonte foi consultada. */
  readonly consultadoEm: Date;
  /** true quando a resposta veio de cache e não da fonte. */
  readonly deCache: boolean;
}

export interface ProcessoProps {
  readonly numero: NumeroCNJ;
  /** Sigla do tribunal — ex.: "TJSP". */
  readonly tribunal: string;
  /** Órgão julgador / vara — ex.: "2ª Vara Cível de Santo Amaro". */
  readonly vara?: string;
  /** Classe processual — ex.: "Procedimento Comum Cível". */
  readonly classe?: string;
  /** Assunto principal — ex.: "Rescisão do Contrato e Devolução do Dinheiro". */
  readonly assunto?: string;
  /** Todos os assuntos, quando a fonte devolve mais de um. */
  readonly assuntos?: readonly string[];
  /** Data de distribuição / ajuizamento. */
  readonly dataDistribuicao?: Date;
  /** Grau de jurisdição — ex.: "G1", "G2", "JE". */
  readonly grau?: string;
  /** Valor da causa em reais, quando a fonte expõe. */
  readonly valorCausa?: number;
  readonly segredoJustica?: boolean;
  readonly partes?: readonly Parte[];
  readonly movimentacoes?: readonly Movimentacao[];
  readonly procedencia: Procedencia;
}

/**
 * Modelo unificado de processo — o contrato que TODO adapter precisa produzir.
 *
 * Regra central do projeto: nenhuma camada acima da infraestrutura conhece o
 * formato do DataJud, do e-SAJ, do PJe ou de qualquer outra fonte. Elas
 * conhecem `Processo`. Quando um tribunal novo entra, só nasce um mapper.
 *
 * Quase tudo é opcional de propósito: fontes diferentes preenchem campos
 * diferentes (o DataJud não tem partes; o crawler do e-SAJ tem, mas pode não
 * ter o valor da causa). Fingir completude com string vazia esconde a diferença
 * entre "não existe" e "a fonte não sabe" — e é essa diferença que decide se
 * vale consultar a segunda fonte.
 */
export class Processo {
  readonly numero: NumeroCNJ;
  readonly tribunal: string;
  readonly vara: string | undefined;
  readonly classe: string | undefined;
  readonly assunto: string | undefined;
  readonly assuntos: readonly string[];
  readonly dataDistribuicao: Date | undefined;
  readonly grau: string | undefined;
  readonly valorCausa: number | undefined;
  readonly segredoJustica: boolean;
  readonly partes: readonly Parte[];
  readonly movimentacoes: readonly Movimentacao[];
  readonly procedencia: Procedencia;

  constructor(props: ProcessoProps) {
    this.numero = props.numero;
    this.tribunal = props.tribunal;
    this.vara = props.vara;
    this.classe = props.classe;
    this.assunto = props.assunto ?? props.assuntos?.[0];
    this.assuntos = props.assuntos ?? (props.assunto ? [props.assunto] : []);
    this.dataDistribuicao = props.dataDistribuicao;
    this.grau = props.grau;
    this.valorCausa = props.valorCausa;
    this.segredoJustica = props.segredoJustica ?? false;
    this.partes = props.partes ?? [];
    // A triagem é aplicada UMA vez, na construção, e não em cada tela que
    // exibe a lista. Assim a resposta da API, o corpo do e-mail e o console
    // concordam sobre o que exige ação — três lugares que, classificando por
    // conta própria, divergiriam no dia em que alguém ajustasse só um deles.
    this.movimentacoes = triarTodas(ordenarPorDataDesc(props.movimentacoes ?? []));
    this.procedencia = props.procedencia;

    Object.freeze(this);
  }

  get ultimaMovimentacao(): Movimentacao | undefined {
    return this.movimentacoes[0];
  }

  get poloAtivo(): readonly Parte[] {
    return this.partes.filter((p) => p.polo === 'ATIVO');
  }

  get poloPassivo(): readonly Parte[] {
    return this.partes.filter((p) => p.polo === 'PASSIVO');
  }

  /**
   * Heurística de completude usada pelo orquestrador: um resultado "magro"
   * (metadado sem partes nem andamentos) não justifica parar a cadeia se
   * houver uma fonte mais rica adiante.
   */
  get temDetalhamento(): boolean {
    return this.partes.length > 0 && this.movimentacoes.length > 0;
  }

  /** Retorna uma cópia com campos sobrescritos — a entidade é imutável. */
  comAlteracoes(alteracoes: Partial<ProcessoProps>): Processo {
    return new Processo({
      numero: this.numero,
      tribunal: this.tribunal,
      assuntos: this.assuntos,
      partes: this.partes,
      movimentacoes: this.movimentacoes,
      segredoJustica: this.segredoJustica,
      procedencia: this.procedencia,
      ...(this.vara !== undefined ? { vara: this.vara } : {}),
      ...(this.classe !== undefined ? { classe: this.classe } : {}),
      ...(this.assunto !== undefined ? { assunto: this.assunto } : {}),
      ...(this.dataDistribuicao !== undefined
        ? { dataDistribuicao: this.dataDistribuicao }
        : {}),
      ...(this.grau !== undefined ? { grau: this.grau } : {}),
      ...(this.valorCausa !== undefined ? { valorCausa: this.valorCausa } : {}),
      ...alteracoes,
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      numero: this.numero.formatado,
      tribunal: this.tribunal,
      vara: this.vara,
      classe: this.classe,
      assunto: this.assunto,
      assuntos: this.assuntos,
      dataDistribuicao: this.dataDistribuicao?.toISOString(),
      grau: this.grau,
      valorCausa: this.valorCausa,
      segredoJustica: this.segredoJustica,
      partes: this.partes,
      movimentacoes: this.movimentacoes.map((m) => {
        // Inscrição de advogado de terceiro é transitória (v0.37.6): não sai na API.
        const { destinatariosOab: _transitorio, ...visivel } = m;
        return { ...visivel, data: m.data.toISOString() };
      }),
      procedencia: {
        ...this.procedencia,
        consultadoEm: this.procedencia.consultadoEm.toISOString(),
      },
    };
  }
}
