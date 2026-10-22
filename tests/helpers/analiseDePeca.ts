import type {
  AnalisadorDePeca,
  PedidoDeAnaliseDePeca,
  RespostaDoAnalisadorDePeca,
} from '../../src/domain/ports/AnalisadorDePeca.js';
import type { RespostaDoModeloDePeca } from '../../src/domain/entities/AnaliseDePeca.js';
import { NOME_DA_PARTE } from './analiseIa.js';

/* Peça e respostas SINTÉTICAS da análise de peça (nomes, valores e números inventados). */

export const PAGINA_1 =
  `PETICAO INICIAL. ${NOME_DA_PARTE}, ja qualificada, ajuiza ACAO DE INDENIZACAO em face da re Comercial Pedra Azul Ltda. ` +
  'A autora adquiriu um refrigerador pelo valor de R$ 4.200,00, conforme nota fiscal anexa (Doc. 1). ' +
  `Residente e domiciliada na Rua das Flores, nº 100, Setor Central, Goiania - GO, CEP 74000-123.`;
export const PAGINA_2 =
  'DOS PEDIDOS. Requer: a) a condenacao da re a restituir R$ 4.200,00; b) a condenacao da re ao pagamento de custas e honorarios. ' +
  'Da-se a causa o valor de R$ 9.200,00. Nestes termos, pede deferimento.';
export const PAGINAS_DA_PECA = [PAGINA_1, PAGINA_2] as const;

/** Uma resposta que um modelo perfeito daria: tudo citado literalmente, na página certa. */
export function respostaDaPeca(
  sobrescrever: Partial<RespostaDoModeloDePeca> = {},
): RespostaDoModeloDePeca {
  return {
    tipo_da_peca: 'peticao_inicial',
    em_uma_frase:
      'Petição inicial que pede a restituição de valores pagos por um produto.',
    pedidos: [
      {
        texto: 'Condenar a ré a restituir R$ 4.200,00',
        trecho: 'a condenacao da re a restituir R$ 4.200,00',
        pagina: 2,
      },
    ],
    alegacoes_principais: [
      {
        texto: `Alega que [PARTE A] adquiriu um refrigerador pelo valor de R$ 4.200,00`,
        trecho: 'adquiriu um refrigerador pelo valor de R$ 4.200,00',
        pagina: 1,
      },
    ],
    preliminares_ou_defesas_formais: [],
    documentos_citados: [{ nome_como_escrito: 'Doc. 1', pagina: 1 }],
    valores_citados: [
      {
        valor_literal: 'R$ 9.200,00',
        contexto_curto: 'valor da causa',
        trecho: 'o valor de R$ 9.200,00',
        pagina: 2,
      },
    ],
    pontos_de_atencao: [],
    ...sobrescrever,
  };
}

/** Dublê do analisador: registra cada pedido e devolve (ou lança) o que o teste mandar. */
export class AnalisadorDePecaFalso implements AnalisadorDePeca {
  readonly nome = 'falso';
  readonly pedidos: PedidoDeAnaliseDePeca[] = [];
  resposta: () => Promise<RespostaDoAnalisadorDePeca> = async () => ({
    resposta: respostaDaPeca(),
    modelo: 'modelo/teste',
    provedor: 'provedor-teste',
    tokensEntrada: 4000,
    tokensSaida: 400,
    custoUsd: 0.002,
  });

  async analisar(pedido: PedidoDeAnaliseDePeca): Promise<RespostaDoAnalisadorDePeca> {
    this.pedidos.push(pedido);
    return this.resposta();
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** Faz o próximo (e os seguintes) responderem com esta resposta do modelo. */
  responderCom(resposta: RespostaDoModeloDePeca): void {
    this.resposta = async () => ({
      resposta,
      modelo: 'modelo/teste',
      provedor: 'provedor-teste',
      tokensEntrada: 4000,
      tokensSaida: 400,
      custoUsd: 0.002,
    });
  }

  get chamadas(): number {
    return this.pedidos.length;
  }
}
