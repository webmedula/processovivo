import type { RespostaDoModeloDaSintese } from '../../src/domain/entities/AnaliseDoProcesso.js';
import type { RespostaDoModeloDePeca } from '../../src/domain/entities/AnaliseDePeca.js';
import type {
  PedidoDeSintese,
  RespostaDoSintetizador,
  SintetizadorDoProcesso,
} from '../../src/domain/ports/SintetizadorDoProcesso.js';

/* Contestação e síntese SINTÉTICAS (nomes, valores e números inventados). */

export const PAGINA_DA_CONTESTACAO =
  'CONTESTACAO. Comercial Pedra Azul Ltda, ja qualificada, apresenta contestacao. ' +
  'A re sustenta que o refrigerador foi entregue em perfeito estado de funcionamento, conforme termo de entrega (Doc. 2). ' +
  'Sustenta ainda que o defeito decorreu de mau uso pela autora. Requer a total improcedencia dos pedidos. Nestes termos, pede deferimento.';

export function respostaDaContestacao(
  sobrescrever: Partial<RespostaDoModeloDePeca> = {},
): RespostaDoModeloDePeca {
  return {
    tipo_da_peca: 'contestacao',
    em_uma_frase: 'Contestação em que a ré alega que o produto foi entregue sem defeito.',
    pedidos: [],
    alegacoes_principais: [
      {
        texto: 'Alega que o refrigerador foi entregue em perfeito estado de funcionamento',
        trecho: 'o refrigerador foi entregue em perfeito estado de funcionamento',
        pagina: 1,
      },
      {
        texto: 'Alega que o defeito decorreu de mau uso',
        trecho: 'o defeito decorreu de mau uso pela autora',
        pagina: 1,
      },
    ],
    preliminares_ou_defesas_formais: [],
    documentos_citados: [{ nome_como_escrito: 'Doc. 2', pagina: 1 }],
    valores_citados: [],
    pontos_de_atencao: [],
    ...sobrescrever,
  };
}

/** O que um modelo correto devolveria cruzando petição (P1), contestação (P2) e despacho (P3). */
export function respostaDaSintese(
  sobrescrever: Partial<RespostaDoModeloDaSintese> = {},
): RespostaDoModeloDaSintese {
  return {
    objeto: {
      texto: 'Ação em que [PARTE A] pede a restituição do valor pago por um refrigerador.',
      refs: ['P1.pedido1', 'P1.alegacao1'],
    },
    pedidos: [
      {
        texto: 'Restituição de R$ 4.200,00 pela ré',
        refs: ['P1.pedido1'],
        defesa: {
          texto: 'A ré alega que o produto foi entregue em perfeito estado',
          refs: ['P2.alegacao1'],
        },
        decisao: null,
      },
    ],
    linha_do_tempo: [
      { texto: 'O juízo determina que o Estado individualize a conta', refs: ['P3.determinacao1'] },
      { texto: '[PARTE A] pede a restituição do valor pago', refs: ['P1.pedido1'] },
      { texto: 'A ré contesta e alega mau uso', refs: ['P2.alegacao2'] },
    ],
    pontos_controvertidos: [
      {
        texto: 'Se o refrigerador tinha defeito ao ser entregue',
        refs: ['P1.alegacao1', 'P2.alegacao1'],
      },
    ],
    ...sobrescrever,
  };
}

/** Dublê do sintetizador: registra cada pedido e devolve (ou lança) o que o teste mandar. */
export class SintetizadorFalso implements SintetizadorDoProcesso {
  readonly nome = 'falso';
  readonly pedidos: PedidoDeSintese[] = [];
  resposta: () => Promise<RespostaDoSintetizador> = async () => ({
    resposta: respostaDaSintese(),
    modelo: 'modelo/teste',
    provedor: 'provedor-teste',
    tokensEntrada: 3000,
    tokensSaida: 600,
    custoUsd: 0.003,
  });

  async sintetizar(pedido: PedidoDeSintese): Promise<RespostaDoSintetizador> {
    this.pedidos.push(pedido);
    return this.resposta();
  }

  responderCom(resposta: RespostaDoModeloDaSintese): void {
    this.resposta = async () => ({
      resposta,
      modelo: 'modelo/teste',
      provedor: 'provedor-teste',
    });
  }

  get chamadas(): number {
    return this.pedidos.length;
  }
}
