/**
 * PORTA do envio de comprovantes de custo ao Google Drive do advogado (v0.49.0).
 *
 * Só IDA: o sistema grava o arquivo e guarda o id; não lista, não lê de volta, não apaga. O conteúdo
 * passa pela MEMÓRIA — nenhum implementador grava o arquivo no disco do servidor.
 *
 * Contrato de erros:
 *   - `DriveRecusadoError`            sem plano (`sem_plano`), sem Drive conectado (`nao_conectado`) ou
 *                                     autorização vencida (`precisa_reconectar`): zero chamadas ao Google
 *   - `ComprovanteNaoEnviadoError`    Drive cheio, limite de uso, fora do ar ou recusa definitiva
 */
export interface ArquivoParaOComprovante {
  /** Já saneado. */
  readonly nome: string;
  readonly tipo: string;
  readonly conteudo: Uint8Array;
}

export interface ComprovanteNoDestino {
  readonly arquivoId: string;
  /** Endereço informado pelo destino; pode faltar. */
  readonly link: string | undefined;
}

export interface DestinoDeComprovantes {
  anexar(
    workspace: string,
    numeroProcesso: string,
    arquivo: ArquivoParaOComprovante,
  ): Promise<ComprovanteNoDestino>;
}
