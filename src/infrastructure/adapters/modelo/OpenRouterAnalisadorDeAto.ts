import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
} from '../../../domain/errors/index.js';
import type {
  AnalisadorDeAto,
  PedidoDeAnalise,
  RespostaDoAnalisador,
} from '../../../domain/ports/AnalisadorDeAto.js';
import type { Clock } from '../../../domain/ports/Clock.js';
import type { Logger } from '../../../domain/ports/Logger.js';
import { lerRespostaDoModelo } from './esquemaDaAnalise.js';
import {
  ehApelidoOuVariante,
  NOME_DO_OPENROUTER,
  normalizarNome,
  parConfirmadoZdr,
  provedoresPermitidos,
  slugDoProvedor,
  type EndpointZdr,
} from './endpointsZdr.js';
import type { TransporteDeModelo } from './TransporteOpenRouter.js';

/** A lista ZDR muda devagar; 24 h em memória poupa uma ida ao OpenRouter por análise. */
export const TTL_DA_LISTA_ZDR_MS = 24 * 3_600_000;

export interface OpcoesDoAnalisadorOpenRouter {
  readonly transporte: TransporteDeModelo;
  /** Id de um modelo REAL (sem `~` nem `:`), vindo da configuração. */
  readonly modelo: string;
  /** Busca a lista ZDR no OpenRouter. Lança se não alcançar. */
  readonly buscarListaZdr: () => Promise<readonly EndpointZdr[]>;
  /**
   * Slugs que o operador autoriza (`PROCESSOVIVO_IA_PROVEDORES_PERMITIDOS`). Vazio = todos
   * os provedores ZDR do modelo. Com valor, vale a INTERSEÇÃO com a lista ZDR: o operador
   * só consegue restringir mais, nunca abrir além da retenção zero.
   */
  readonly provedoresDoOperador?: readonly string[];
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ttlMs?: number;
}

/**
 * Adaptador de análise de ato sobre o OpenRouter. A ZDR falha FECHADA e não tem chave
 * de desligar: sem lista, sem provedor permitido ou com resposta de provedor fora do
 * conjunto, o texto não é enviado — ou a resposta é descartada.
 */
export class OpenRouterAnalisadorDeAto implements AnalisadorDeAto {
  readonly nome = NOME_DO_OPENROUTER;
  private readonly ttlMs: number;
  private readonly log: Logger;
  private lista:
    { readonly itens: readonly EndpointZdr[]; readonly em: number } | undefined;

  constructor(private readonly o: OpcoesDoAnalisadorOpenRouter) {
    this.ttlMs = o.ttlMs ?? TTL_DA_LISTA_ZDR_MS;
    this.log = o.logger.child({ adaptador: 'analisador-openrouter' });
  }

  async analisar(pedido: PedidoDeAnalise): Promise<RespostaDoAnalisador> {
    const { modelo } = this.o;
    if (ehApelidoOuVariante(modelo)) {
      throw new ProviderIndisponivelError(
        NOME_DO_OPENROUTER,
        'o modelo configurado é um apelido ou variante, não um modelo real',
      );
    }
    const lista = await this.listaZdr();
    const permitidos = this.permitidosPara(lista);
    if (permitidos.length === 0) {
      throw new ProviderIndisponivelError(
        NOME_DO_OPENROUTER,
        `nenhum provedor com retenção zero permitido para o modelo "${modelo}"; nada foi enviado`,
      );
    }

    const resposta = await this.o.transporte.gerar({
      modelo,
      sistema: pedido.sistema,
      usuario: pedido.usuario,
      provedoresPermitidos: permitidos,
      ...(pedido.sinal ? { sinal: pedido.sinal } : {}),
    });

    // Conferência DEPOIS da resposta: o par (modelo servido, provedor) tem de estar na
    // lista ZDR E dentro do conjunto permitido. Se não estiver, o texto da resposta é
    // descartado e só nomes (nunca texto) vão ao log.
    const servidoPor = resposta.provedor?.trim() ?? '';
    const modeloServido = resposta.modeloResolvido?.trim() ?? '';
    const confirmado =
      servidoPor !== '' &&
      modeloServido !== '' &&
      parConfirmadoZdr(lista, modeloServido, servidoPor) &&
      this.dentroDoConjunto(lista, modeloServido, servidoPor, permitidos);
    if (!confirmado) {
      this.log.error('resposta descartada: provedor fora do conjunto permitido', {
        modeloServido: modeloServido || null,
        provedor: servidoPor || null,
      });
      throw new ProviderIndisponivelError(
        NOME_DO_OPENROUTER,
        'a resposta veio de um provedor fora do conjunto permitido e foi descartada',
      );
    }

    const lida = lerRespostaDoModelo(resposta.objeto);
    if (!lida) {
      throw new RespostaInvalidaError(
        NOME_DO_OPENROUTER,
        'a resposta do modelo não cumpriu o esquema fechado',
      );
    }
    return {
      resposta: lida,
      modelo: modeloServido,
      provedor: servidoPor,
      ...(resposta.tokensEntrada !== undefined
        ? { tokensEntrada: resposta.tokensEntrada }
        : {}),
      ...(resposta.tokensSaida !== undefined
        ? { tokensSaida: resposta.tokensSaida }
        : {}),
      ...(resposta.custoUsd !== undefined ? { custoUsd: resposta.custoUsd } : {}),
    };
  }

  /** Nunca lança. Verdadeiro = a lista ZDR é alcançável e o modelo tem provedor permitido. */
  async healthCheck(): Promise<boolean> {
    try {
      const lista = await this.listaZdr();
      return this.permitidosPara(lista).length > 0;
    } catch {
      return false;
    }
  }

  /** Os slugs permitidos: provedores ZDR do modelo, e, se o operador restringiu, a interseção. */
  private permitidosPara(lista: readonly EndpointZdr[]): string[] {
    const doModelo = provedoresPermitidos(lista, this.o.modelo);
    const doOperador = (this.o.provedoresDoOperador ?? [])
      .map((s) => slugDoProvedor(s))
      .filter((s) => s !== '');
    if (doOperador.length === 0) return doModelo;
    return doModelo.filter((s) => doOperador.includes(s));
  }

  private dentroDoConjunto(
    lista: readonly EndpointZdr[],
    modeloServido: string,
    provedor: string,
    permitidos: readonly string[],
  ): boolean {
    const servido = normalizarNome(provedor);
    return lista
      .filter((e) => e.modelo === modeloServido)
      .filter((e) => permitidos.includes(slugDoProvedor(e.tag)))
      .some((e) =>
        [e.provedor, e.tag, slugDoProvedor(e.tag)].some(
          (n) => n !== '' && normalizarNome(n) === servido,
        ),
      );
  }

  private async listaZdr(): Promise<readonly EndpointZdr[]> {
    const agora = this.o.clock.agora().getTime();
    if (this.lista && agora - this.lista.em < this.ttlMs) return this.lista.itens;
    try {
      const itens = await this.o.buscarListaZdr();
      if (itens.length === 0) throw new Error('lista vazia');
      this.lista = { itens, em: agora };
      return itens;
    } catch {
      // Lista vencida NÃO é reaproveitada: falha fechada. Sem lista confiável, sem chamada.
      this.lista = undefined;
      throw new ProviderIndisponivelError(
        NOME_DO_OPENROUTER,
        'a lista de provedores com retenção zero (ZDR) não pôde ser obtida; nada foi enviado',
      );
    }
  }
}
