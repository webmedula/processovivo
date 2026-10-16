/**
 * O DESTINO EXTERNO das peças (v0.42.0): hoje, o Google Drive do advogado.
 *
 * O resto do sistema não conhece o Google. Estas entidades dizem só o que o
 * produto precisa saber: a conta está ligada? onde ficou a pasta? esta peça já
 * foi enviada, com que conteúdo? Todas imutáveis — quem muda produz cópia.
 *
 * Sentido ÚNICO, por decisão do dono: o sistema grava no destino e não lê de
 * volta o que o advogado guardou lá. A única leitura permitida é a de
 * "o que EU criei ainda existe?" (uma consulta pelo id que o sistema mesmo
 * guardou), para não reenviar sozinho o que o advogado apagou.
 */

export type EstadoDaConexao = 'conectado' | 'precisa_reconectar' | 'desconectado';

/**
 * Por que a conexão não está de pé. Código curto — nunca texto do Google, que
 * pode ecoar e-mail ou id interno.
 */
export type MotivoDoErroDaConexao =
  'autorizacao_revogada' | 'escopo_negado' | 'pasta_raiz_recriada';

export interface PastaNoDestino {
  readonly id: string;
  /** Endereço para o botão "Abrir no Drive". Vem do Google; só se abre, nunca se lê. */
  readonly link: string;
}

/** O que se guarda da conexão de um workspace — sem e-mail, sem dado do Google além do necessário. */
export interface ConexaoComDestino {
  readonly workspace: string;
  readonly estado: EstadoDaConexao;
  readonly pastaRaiz: PastaNoDestino | undefined;
  readonly conectadaEm: Date;
  readonly verificadaEm: Date | undefined;
  readonly motivoDoUltimoErro: MotivoDoErroDaConexao | undefined;
}

/**
 * A autorização que o destino deu. Vive só no cofre (cifrada) e na memória de
 * quem vai chamar o destino; nunca vai a log, resposta ou erro.
 */
export interface AutorizacaoDoDestino {
  readonly tokenDeAcesso: string;
  readonly tokenDeRenovacao: string;
  readonly expiraEm: Date;
}

export type EstadoDaPecaNoDestino = 'no_destino' | 'removida_no_destino' | 'desconectada';

/** O controle de idempotência: por (workspace, processo, peça). */
export interface PecaNoDestino {
  readonly workspace: string;
  readonly numeroProcesso: string;
  readonly pecaId: string;
  readonly arquivoId: string;
  /** SHA-256 do PDF enviado: igual = não reenvia; diferente = atualiza o MESMO arquivo. */
  readonly hash: string;
  readonly nome: string;
  readonly estado: EstadoDaPecaNoDestino;
  readonly enviadaEm: Date;
  readonly atualizadaEm: Date | undefined;
}

export interface PastaDoProcessoNoDestino {
  readonly workspace: string;
  readonly numeroProcesso: string;
  readonly pasta: PastaNoDestino;
}

/** O conteúdo de um arquivo, lido em pedaços — um PDF pode ter centenas de MB. */
export interface ConteudoParaEnvio {
  readonly tamanho: number;
  ler(inicio: number, fim: number): AsyncIterable<Uint8Array>;
}

export interface ArquivoNoDestino {
  readonly id: string;
  readonly link: string | undefined;
}

export interface ResultadoDaPasta {
  readonly pasta: PastaNoDestino;
  /** A pasta conhecida não existia mais (apagada ou na lixeira) e foi criada de novo. */
  readonly recriada: boolean;
}
