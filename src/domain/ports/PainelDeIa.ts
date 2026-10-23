import type { ConfigDoPainel, FuncaoDeIa } from '../entities/ControleDaIa.js';

/**
 * Portas do painel de IA do /admin (v0.58.0). Tudo aqui é SÓ número, rótulo de lista fechada e
 * identificador curto: nenhum texto de ato ou de peça, nome de parte, número de processo, e-mail ou
 * chave jamais passa por estas portas.
 *
 * A leitura da configuração é SÍNCRONA de propósito: ela está no caminho de toda análise (com cache
 * curto no serviço) e o `node:sqlite` já é síncrono. Quem chama trata a exceção — falha vira o
 * padrão do código, nunca uma IA fora do ar.
 */
export type TipoDeAlteracao =
  'ligada' | 'teto_dia_conta' | 'teto_dia_global' | 'alerta_custo';

export interface AlteracaoDeConfigDeIa {
  readonly id?: number;
  readonly em: Date;
  /** Identificador CURTO do operador (hash do usuário do /admin), nunca o nome nem o e-mail. */
  readonly autor: string;
  readonly funcao: FuncaoDeIa | 'global';
  readonly tipo: TipoDeAlteracao;
  /** Valores simples ("ligada", "desligada", "200", "sem teto", "3.00"). */
  readonly anterior: string;
  readonly novo: string;
}

export interface RepositorioDeConfigDeIa {
  /** A configuração gravada; linha ausente = o padrão. Pode lançar (o serviço trata). */
  ler(): ConfigDoPainel;
  /** Grava a configuração E o registro da mudança, na MESMA transação. */
  gravar(config: ConfigDoPainel, alteracao: AlteracaoDeConfigDeIa, agora: Date): void;
  /** As mais recentes primeiro. */
  alteracoes(limite: number): AlteracaoDeConfigDeIa[];
}

/** Motivos fechados de falha de verificação e de repetição automática (só contagem, por função e dia). */
export const MOTIVOS_DE_OCORRENCIA_DA_IA = [
  'chamada_falhou',
  'formato_fora_do_esquema',
  'repeticao_automatica',
  'tempo_esgotado',
  'citacao_invalida',
  'numero_invalido',
  'expressao_proibida',
  'acao_copiada_do_trecho',
  'sem_item_verificado',
  'ato_recente_fora',
  'pendencia_negada',
  'atualidade',
  'forma',
  'pagina_invalida',
] as const;
export type MotivoDeOcorrenciaDaIa = (typeof MOTIVOS_DE_OCORRENCIA_DA_IA)[number];

export interface RegistroDeOcorrenciasDeIa {
  /** Nunca lança: contar uma ocorrência não pode derrubar a análise que a originou. */
  registrar(
    funcao: FuncaoDeIa,
    motivo: MotivoDeOcorrenciaDaIa,
    quantidade?: number,
  ): void;
}

export const SEM_REGISTRO_DE_OCORRENCIAS: RegistroDeOcorrenciasDeIa = Object.freeze({
  registrar: () => undefined,
});

export interface OcorrenciaAgregada {
  readonly funcao: FuncaoDeIa;
  readonly motivo: MotivoDeOcorrenciaDaIa;
  readonly contagem: number;
}

export interface LinhaDeUsoDeIa {
  /** Só para o ranking de contas; sai da portas já como id CURTO. */
  readonly workspace: string;
  readonly modelo: string;
  readonly versaoPrompt: string;
  readonly avaliacao: string | null;
  readonly motivoAvaliacao: string | null;
  readonly naoVerificada: boolean;
  readonly latenciaMs: number;
  readonly custoUsd: number | null;
  readonly tokensEntrada: number | null;
  readonly tokensSaida: number | null;
}

export interface LeitorDeUsoDeIa {
  /** Linhas de uso da função, criadas a partir de `desde` (ISO inclusive). */
  linhas(funcao: FuncaoDeIa, desde: Date): LinhaDeUsoDeIa[];
  /** Soma do custo informado das três tabelas, de `desde` em diante. */
  custoDesde(desde: Date): number;
  ocorrencias(desdeDia: string): OcorrenciaAgregada[];
}

export interface AlertaDeCustoGravado {
  readonly dia: string;
  readonly valorUsd: number;
  readonly limiteUsd: number;
  readonly tentativas: number;
  readonly enviadoEm: Date | undefined;
}

export interface RepositorioDoAlertaDeCusto {
  buscar(dia: string): AlertaDeCustoGravado | undefined;
  /** Soma uma tentativa (cria a linha do dia se preciso) e devolve o total de tentativas. */
  registrarTentativa(dia: string, valorUsd: number, limiteUsd: number): number;
  marcarEnviado(dia: string, em: Date): void;
}
