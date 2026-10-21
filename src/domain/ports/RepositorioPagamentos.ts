import type {
  EstadoDaRecorrencia,
  MeioDeCobranca,
  ResultadoDoPagamento,
} from '../entities/Pagamento.js';
import type { CicloDoPlano, CodigoPlano } from '../entities/Plano.js';

/** Uma recorrência no gateway ligada a um workspace. Só metadado de cobrança, nenhum dado pessoal. */
export interface CobrancaRecorrente {
  /** `external_reference`: opaco, aleatório, de uso único. */
  readonly referencia: string;
  readonly workspace: string;
  readonly plano: CodigoPlano;
  readonly ciclo: CicloDoPlano;
  readonly valorEmCentavos: number;
  readonly gateway: string;
  readonly gatewayId?: string;
  readonly estado: EstadoDaRecorrencia;
  readonly proximaCobranca?: Date;
  readonly meio?: MeioDeCobranca;
  readonly ultimoPagamentoEm?: Date;
  readonly ultimoPagamento?: ResultadoDoPagamento;
  /** Quando a renovação automática terminou (por nós ou pelo gateway). O plano segue até a vigência. */
  readonly renovacaoCanceladaEm?: Date;
  readonly criadaEm: Date;
  readonly atualizadaEm: Date;
}

export interface PagamentoProcessado {
  readonly chave: string;
  readonly referencia: string;
  readonly workspace: string;
  readonly resultado: ResultadoDoPagamento;
  readonly valorEmCentavos: number;
  readonly ocorridoEm?: Date;
  readonly registradoEm: Date;
}

export interface EventoDePagamento {
  readonly workspace?: string;
  readonly referencia?: string;
  readonly tipo: string;
  /** Texto curto SEM dado pessoal nem do meio de pagamento. */
  readonly detalhe?: string;
  readonly criadoEm: Date;
}

/**
 * O aceite dos Termos que antecede um checkout (v0.45.0). Ligado ao WORKSPACE, com a versão dos Termos, o
 * plano e a data: nada de e-mail, IP ou nome — o suficiente para provar QUE e QUANDO se aceitou O QUÊ.
 */
export interface AceiteDeTermos {
  readonly workspace: string;
  readonly versao: string;
  readonly plano: CodigoPlano;
  readonly aceitoEm: Date;
}

export interface RepositorioPagamentos {
  registrarAceiteDeTermos(aceite: AceiteDeTermos): Promise<void>;
  aceitesDe(workspace: string): Promise<readonly AceiteDeTermos[]>;
  criar(cobranca: CobrancaRecorrente): Promise<void>;
  porReferencia(referencia: string): Promise<CobrancaRecorrente | undefined>;
  porGatewayId(gatewayId: string): Promise<CobrancaRecorrente | undefined>;
  /** A recorrência mais recente do workspace (ou `undefined`). */
  maisRecenteDoWorkspace(workspace: string): Promise<CobrancaRecorrente | undefined>;
  /** As recorrências deste workspace ainda `pendente` (checkout criado e não concluído), da mais antiga à mais nova. */
  pendentesDoWorkspace(workspace: string): Promise<readonly CobrancaRecorrente[]>;
  /** Recorrências que ainda cobram (ou podem cobrar): pendentes, autorizadas e pausadas, com id no gateway. */
  abertas(): Promise<readonly CobrancaRecorrente[]>;
  todas(): Promise<readonly CobrancaRecorrente[]>;
  atualizar(cobranca: CobrancaRecorrente): Promise<void>;

  /**
   * Registra o pagamento. Devolve `true` se FOI a primeira vez e `false` se a chave já existia — é a
   * idempotência: só quem recebe `true` renova o plano.
   */
  registrarPagamento(pagamento: PagamentoProcessado): Promise<boolean>;
  /** Desfaz o registro quando a renovação falhou depois dele, para o aviso repetido poder tentar de novo. */
  desfazerRegistro(chave: string): Promise<void>;
  pagamentoPorChave(chave: string): Promise<PagamentoProcessado | undefined>;
  /** Atualiza o resultado de um pagamento já registrado (estorno, contestação). */
  atualizarResultado(chave: string, resultado: ResultadoDoPagamento): Promise<void>;

  registrarEvento(evento: EventoDePagamento): Promise<void>;
  eventosDe(referencia: string): Promise<readonly EventoDePagamento[]>;
  /** O evento mais recente daquele tipo, de qualquer conta (para o /admin mostrar a última falha do gateway). */
  ultimoEventoDoTipo(tipo: string): Promise<EventoDePagamento | undefined>;
}
