import type {
  ExecutorDeModelo,
  ModeloComZdr,
  PedidoComZdr,
  RespostaConfirmada,
} from './ModeloComZdr.js';

export interface OpcoesDoModeloDaFuncao {
  /** O modelo desta chamada (painel → ambiente → padrão do código), decidido a cada vez. */
  readonly escolher: () => string;
  /** Monta a peça comum (ZDR, `provider.only`, conferência do par) para UM modelo. */
  readonly fabrica: (modelo: string) => ModeloComZdr;
}

/**
 * Escolhe o modelo a CADA chamada (Fase B do painel de IA, v0.60.0) e delega à peça comum desse
 * modelo. Toda chamada passa por `ModeloComZdr`, então ZDR, lista de provedores, `data_collection: deny`
 * e a conferência do par modelo + provedor valem para QUALQUER modelo escolhido — não existe aqui
 * (nem em lugar nenhum) um caminho que fale com o transporte sem elas. Uma peça comum por modelo, em
 * memória; a de um modelo que deixou de ser escolhido só fica parada.
 */
export class ModeloDaFuncao implements ExecutorDeModelo {
  private readonly pecas = new Map<string, ModeloComZdr>();

  constructor(private readonly o: OpcoesDoModeloDaFuncao) {}

  executar(pedido: PedidoComZdr): Promise<RespostaConfirmada> {
    return this.da(this.o.escolher()).executar(pedido);
  }

  healthCheck(): Promise<boolean> {
    return this.da(this.o.escolher()).healthCheck();
  }

  private da(modelo: string): ModeloComZdr {
    let p = this.pecas.get(modelo);
    if (!p) {
      p = this.o.fabrica(modelo);
      this.pecas.set(modelo, p);
    }
    return p;
  }
}
