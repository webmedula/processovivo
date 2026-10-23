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

/**
 * Despacho SINTÉTICO de UMA página (~960 caracteres), equivalente ao caso real que motivou a 0.56.1: o juízo
 * manda o Estado individualizar a conta gráfica do FGTS em 10 dias, sob multa diária, e depois ouvir a parte
 * autora em 5 dias. Texto 100% inventado: sem nome real, sem número de processo real.
 */
export const PAGINA_DO_DESPACHO =
  'PODER JUDICIARIO - COMARCA FICTICIA - VARA DA FAZENDA PUBLICA. DESPACHO. Vistos. ' +
  'Trata-se de acao de conhecimento em que a parte autora pretende a recomposicao de saldo de conta vinculada do FGTS. ' +
  'Compulsando os autos, verifico que a controversia depende da identificacao dos depositos efetuados no periodo. ' +
  'Assim, DETERMINO que o Estado requerido individualize, no prazo de 10 (dez) dias, a conta grafica do FGTS referente ao periodo discutido, ' +
  'sob pena de multa diaria de R$ 500,00 (quinhentos reais). ' +
  'Apresentada a conta grafica, INTIME-SE a parte autora para manifestar-se no prazo de 5 (cinco) dias. ' +
  'Em seguida, voltem os autos conclusos para deliberacao. Publique-se e cumpra-se. ' +
  'Cidade Ficticia, data da assinatura eletronica. Juiz de Direito substituto, assinado digitalmente.';

/** O que um modelo correto devolve para o despacho acima — com o vício antigo (códigos de fato do sistema) de brinde. */
export function respostaDoDespacho(
  sobrescrever: Partial<RespostaDoModeloDePeca> = {},
): RespostaDoModeloDePeca {
  return {
    tipo_da_peca: 'despacho',
    em_uma_frase:
      'Despacho que determina que o Estado individualize a conta gráfica do FGTS e depois ouve a parte autora.',
    pedidos: [],
    alegacoes_principais: [],
    preliminares_ou_defesas_formais: [],
    documentos_citados: [],
    valores_citados: [
      {
        valor_literal: 'R$ 500,00',
        contexto_curto: 'multa diária',
        trecho: 'multa diaria de R$ 500,00',
        pagina: 1,
      },
    ],
    determinacoes: [
      {
        quem: 'Estado requerido',
        texto: 'Determina que individualize a conta gráfica do FGTS do período discutido',
        prazo_escrito: '10 (dez) dias',
        trecho: 'individualize, no prazo de 10 (dez) dias, a conta grafica do FGTS',
        pagina: 1,
      },
      {
        quem: 'Parte autora',
        texto: 'Intima a parte autora a se manifestar sobre a conta apresentada',
        prazo_escrito: '5 (cinco) dias',
        trecho: 'INTIME-SE a parte autora para manifestar-se no prazo de 5 (cinco) dias',
        pagina: 1,
      },
    ],
    pontos_de_atencao: [],
    ...sobrescrever,
  };
}

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
