import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
} from '../../domain/errors/index.js';
import type { FuncaoDeIa } from '../../domain/entities/ControleDaIa.js';
import type {
  MotivoDeOcorrenciaDaIa,
  RegistroDeOcorrenciasDeIa,
} from '../../domain/ports/PainelDeIa.js';
import type { DescartesDaPeca } from './verificarAnaliseDePeca.js';
import type { DescartesDoResumo } from './verificarResumo.js';

/**
 * Do que a verificação e a chamada devolvem para as CONTAGENS do painel de IA (v0.58.0). Só motivos
 * de lista fechada e quantidades: nada daqui carrega texto de ato ou de peça.
 */
export type Contagem = readonly [MotivoDeOcorrenciaDaIa, number];

/** Por que a chamada ao modelo não deu resposta. Casa pela CLASSE do erro e pela nossa frase, nunca por texto externo. */
export function motivoDaFalhaDaChamada(erro: unknown): MotivoDeOcorrenciaDaIa {
  if (erro instanceof RespostaInvalidaError) return 'formato_fora_do_esquema';
  if (
    erro instanceof ProviderIndisponivelError &&
    erro.message.endsWith('tempo esgotado')
  ) {
    return 'tempo_esgotado';
  }
  return 'chamada_falhou';
}

export function contagensDoAto(motivo: string | undefined): Contagem[] {
  if (motivo === 'sem_citacao_valida') return [['citacao_invalida', 1]];
  if (motivo === 'expressao_proibida') return [['expressao_proibida', 1]];
  if (motivo === 'acao_copiada_do_trecho') return [['acao_copiada_do_trecho', 1]];
  return [];
}

export function contagensDoResumo(
  d: DescartesDoResumo,
  motivo: string | undefined,
): Contagem[] {
  const motivoDoResultado: Contagem[] =
    motivo === 'sem_item_verificado'
      ? [['sem_item_verificado', 1]]
      : motivo === 'sem_ato_mais_recente'
        ? [['ato_recente_fora', 1]]
        : [];
  return [
    ...motivoDoResultado,
    ['citacao_invalida', d.citacao + d.referencia],
    ['numero_invalido', d.numeroInventado],
    ['acao_copiada_do_trecho', d.copiaDoTrecho],
    ['forma', d.forma],
    ['expressao_proibida', d.expressaoProibida],
    ['atualidade', d.atualidade],
    ['pendencia_negada', d.pendenciaNegada],
  ];
}

export function contagensDaPeca(
  d: DescartesDaPeca,
  motivo: string | undefined,
): Contagem[] {
  const motivoDoResultado: Contagem[] =
    motivo === 'sem_item_verificado'
      ? [['sem_item_verificado', 1]]
      : motivo === 'expressao_proibida'
        ? [['expressao_proibida', 1]]
        : [];
  return [
    ...motivoDoResultado,
    ['citacao_invalida', d.citacao],
    ['numero_invalido', d.numero],
    ['forma', d.forma],
    ['pagina_invalida', d.pagina],
  ];
}

export function registrarContagens(
  registro: RegistroDeOcorrenciasDeIa,
  funcao: FuncaoDeIa,
  contagens: readonly Contagem[],
): void {
  for (const [motivo, quantidade] of contagens) {
    if (quantidade > 0) registro.registrar(funcao, motivo, quantidade);
  }
}
