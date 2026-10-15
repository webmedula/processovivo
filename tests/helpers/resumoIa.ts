import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import type { RespostaDoModeloResumo } from '../../src/domain/entities/vocabularioDoResumo.js';
import type {
  PedidoDeResumo,
  RespostaDoResumidor,
  ResumidorDeProcesso,
} from '../../src/domain/ports/ResumidorDeProcesso.js';
import { NOME_DA_PARTE } from './analiseIa.js';

/* Atos e respostas SINTÉTICOS do resumo de processo (nomes e números inventados). */

export const AGORA_DO_RESUMO = new Date('2026-10-06T15:00:00.000Z');

export const TEXTO_DA_INTIMACAO = `Intime-se a parte autora, ${NOME_DA_PARTE}, para que se manifeste sobre o laudo pericial juntado aos autos, no prazo de 15 (quinze) dias úteis, sob pena de preclusão.`;
export const TRECHO_DA_INTIMACAO = 'se manifeste sobre o laudo pericial';
export const TEXTO_DO_DESPACHO =
  'Defiro a juntada dos documentos apresentados pela parte ré e determino a expedição de ofício ao banco informado, que deverá responder em quinze dias.';
export const TRECHO_DO_DESPACHO = 'determino a expedição de ofício ao banco informado';
export const TEXTO_DA_SENTENCA =
  'Julgo parcialmente procedentes os pedidos formulados na inicial, condenando a parte ré ao pagamento das custas processuais.';

/** Do mais recente ao mais antigo: A1 intimação (pendente), A2 despacho, A3 título só, A4 sentença… */
export const INTIMACAO: Movimentacao = {
  data: new Date('2026-10-05T12:00:00.000Z'),
  titulo: 'Intimação',
  idExterno: 'djen:1',
  tipoComunicacao: 'Intimação',
  conteudo: TEXTO_DA_INTIMACAO,
};
export const DESPACHO: Movimentacao = {
  data: new Date('2026-09-20T12:00:00.000Z'),
  titulo: 'Despacho',
  idExterno: 'djen:2',
  conteudo: TEXTO_DO_DESPACHO,
};
export const DECISAO_SEM_TEOR: Movimentacao = {
  data: new Date('2026-09-10T12:00:00.000Z'),
  titulo: 'Decisão',
  idExterno: 'djen:3',
  teorIndisponivel: true,
  conteudo: 'ARQUIVOS DIGITAIS INDISPONÍVEIS (NÃO SÃO DO TIPO PÚBLICO)',
};
export const SENTENCA: Movimentacao = {
  data: new Date('2026-09-01T12:00:00.000Z'),
  titulo: 'Sentença',
  idExterno: 'djen:4',
  conteudo: TEXTO_DA_SENTENCA,
};
export const JUNTADA: Movimentacao = {
  data: new Date('2026-08-10T12:00:00.000Z'),
  titulo: 'Juntada de petição',
};
export const CONCLUSOS: Movimentacao = {
  data: new Date('2026-07-01T12:00:00.000Z'),
  titulo: 'Conclusos para despacho',
};
export const ATOS_DO_RESUMO: Movimentacao[] = [
  INTIMACAO,
  DESPACHO,
  DECISAO_SEM_TEOR,
  SENTENCA,
  JUNTADA,
  CONCLUSOS,
];

/** Uma resposta válida: aponta A1 (a intimação) e A2 (o despacho). */
export function respostaDoResumo(
  sobrescrever: Partial<RespostaDoModeloResumo> = {},
): RespostaDoModeloResumo {
  return {
    situacao: [
      {
        texto: '[PARTE A] foi intimada a se pronunciar sobre o laudo pericial juntado.',
        ato: 'A1',
        trecho: TRECHO_DA_INTIMACAO,
      },
      {
        texto: 'O juízo mandou oficiar o banco informado nos autos.',
        ato: 'A2',
        trecho: TRECHO_DO_DESPACHO,
      },
    ],
    pendencias: [
      {
        texto: '[PARTE A]: apresentar manifestação sobre o laudo pericial',
        ato: 'A1',
        trecho: TRECHO_DA_INTIMACAO,
      },
    ],
    pontos_de_atencao: [],
    ...sobrescrever,
  };
}

/** Dublê do resumidor: registra cada pedido e devolve (ou lança) o que o teste mandar. */
export class ResumidorFalso implements ResumidorDeProcesso {
  readonly nome = 'falso';
  readonly pedidos: PedidoDeResumo[] = [];
  resposta: () => Promise<RespostaDoResumidor> = async () => ({
    resposta: respostaDoResumo(),
    modelo: 'modelo/teste',
    provedor: 'provedor-teste',
    tokensEntrada: 2500,
    tokensSaida: 300,
    custoUsd: 0.001,
  });

  async resumir(pedido: PedidoDeResumo): Promise<RespostaDoResumidor> {
    this.pedidos.push(pedido);
    return this.resposta();
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  get chamadas(): number {
    return this.pedidos.length;
  }
}
