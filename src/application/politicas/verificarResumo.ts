import {
  PONTOS_DE_ATENCAO,
  type PontoDeAtencao,
} from '../../domain/entities/vocabularioDaAnalise.js';
import {
  LIMITES_DO_RESUMO,
  type ItemBrutoDoResumo,
  type ItemDoResumo,
  type RespostaDoModeloResumo,
} from '../../domain/entities/vocabularioDoResumo.js';
import { normalizarParaComparar } from './normalizacaoDeTexto.js';
import {
  acaoRepeteOTrecho,
  citacaoExisteNoTexto,
  expressaoProibidaEm,
  numerosForaDoTexto,
} from './verificarAnalise.js';

/**
 * Verificação determinística do resumo de processo (v0.40.0). Não confia no modelo em nada:
 * cada item precisa apontar para um ato que NÓS enviamos, citar um trecho que existe no texto
 * DESSE ato (e não em qualquer outro), e não trazer número ou data que esse ato não tenha.
 *
 * O que se descarta e em que nível:
 *   - item com identificador que não existe, trecho que não está no ato citado, número ou data
 *     fora do ato citado, texto vazio ou grande demais, ou texto que só repete o trecho
 *     → SÓ o item (contado, nunca mostrado);
 *   - expressão proibida em qualquer item → o resultado inteiro;
 *   - nenhum item de `situacao` sobrevivente → o resultado inteiro ("não verificado").
 *
 * Mude `VERSAO_DAS_REGRAS_DO_RESUMO` junto com qualquer alteração aqui.
 */
export const VERSAO_DAS_REGRAS_DO_RESUMO = '1.0.0';

/** O que a verificação precisa de cada ato enviado. */
export interface AtoVerificavel {
  readonly chave: string;
  /** EXATAMENTE o texto que foi ao modelo para este ato. */
  readonly textoEnviado: string;
}

export interface DescartesDoResumo {
  /** Identificador de ato que não foi enviado. */
  readonly referencia: number;
  /** Trecho que não existe no texto do ato citado. */
  readonly citacao: number;
  /** Número ou data que o ato citado não contém. */
  readonly numeroInventado: number;
  /** Texto que só repete o trecho (mais de 60% das palavras em comum). */
  readonly copiaDoTrecho: number;
  /** Texto vazio ou grande demais, item a mais, ponto fora do vocabulário. */
  readonly forma: number;
  /** Resultado descartado por expressão proibida (0 ou 1). */
  readonly expressaoProibida: number;
}

export type ResultadoDaVerificacaoDoResumo =
  | {
      readonly estado: 'verificado';
      readonly situacao: readonly ItemDoResumo[];
      readonly pendencias: readonly ItemDoResumo[];
      readonly pontosDeAtencao: readonly PontoDeAtencao[];
      readonly descartes: DescartesDoResumo;
      /** Quantos itens o modelo devolveu (para a conta "descartados" ser conferível). */
      readonly itensRecebidos: number;
    }
  | {
      readonly estado: 'nao_verificado';
      readonly motivo: 'sem_item_verificado' | 'expressao_proibida';
      readonly descartes: DescartesDoResumo;
      readonly itensRecebidos: number;
    };

/** Aceita `A3`, `[A3]`, `a3` e ` [ A3 ] `; qualquer outra coisa não é identificador. */
export function normalizarIdDoAto(bruto: string): string | undefined {
  const m = /^\[?\s*(a\d{1,3})\s*\]?$/i.exec(bruto.trim());
  return m?.[1]?.toUpperCase();
}

export function verificarResumo(
  resposta: RespostaDoModeloResumo,
  atos: ReadonlyMap<string, AtoVerificavel>,
): ResultadoDaVerificacaoDoResumo {
  const contagem = {
    referencia: 0,
    citacao: 0,
    numeroInventado: 0,
    copiaDoTrecho: 0,
    forma: 0,
    expressaoProibida: 0,
  };
  const itensRecebidos = resposta.situacao.length + resposta.pendencias.length;
  const descartes = (): DescartesDoResumo => ({ ...contagem });

  // Expressão proibida em QUALQUER item derruba o resultado inteiro, antes de tudo.
  const proibido = [...resposta.situacao, ...resposta.pendencias].some(
    (i) => expressaoProibidaEm(i.texto) !== undefined,
  );
  if (proibido) {
    contagem.expressaoProibida = 1;
    return {
      estado: 'nao_verificado',
      motivo: 'expressao_proibida',
      descartes: descartes(),
      itensRecebidos,
    };
  }

  const textosNormalizados = new Map<string, string>();
  const textoDoAto = (id: string, ato: AtoVerificavel): string => {
    const guardado = textosNormalizados.get(id);
    if (guardado !== undefined) return guardado;
    const n = normalizarParaComparar(ato.textoEnviado);
    textosNormalizados.set(id, n);
    return n;
  };

  const vistos = new Set<string>();
  const verificar = (
    bruto: readonly ItemBrutoDoResumo[],
    limite: number,
  ): ItemDoResumo[] => {
    const saida: ItemDoResumo[] = [];
    for (const i of bruto) {
      const texto = i.texto.trim();
      if (texto === '' || texto.length > LIMITES_DO_RESUMO.texto) {
        contagem.forma++;
        continue;
      }
      const id = normalizarIdDoAto(i.ato);
      const ato = id === undefined ? undefined : atos.get(id);
      if (id === undefined || ato === undefined) {
        contagem.referencia++;
        continue;
      }
      const corpo = textoDoAto(id, ato);
      if (!citacaoExisteNoTexto(i.trecho, corpo)) {
        contagem.citacao++;
        continue;
      }
      if (numerosForaDoTexto(texto, corpo).length > 0) {
        contagem.numeroInventado++;
        continue;
      }
      if (acaoRepeteOTrecho(texto, i.trecho)) {
        contagem.copiaDoTrecho++;
        continue;
      }
      const chaveDeRepeticao = `${id}|${normalizarParaComparar(texto)}`;
      if (vistos.has(chaveDeRepeticao)) continue;
      vistos.add(chaveDeRepeticao);
      if (saida.length >= limite) {
        contagem.forma++;
        continue;
      }
      saida.push({ texto, chaveDoAto: ato.chave, trecho: i.trecho.trim() });
    }
    return saida;
  };

  const situacao = verificar(resposta.situacao, LIMITES_DO_RESUMO.situacao);
  const pendencias = verificar(resposta.pendencias, LIMITES_DO_RESUMO.pendencias);

  if (situacao.length === 0) {
    return {
      estado: 'nao_verificado',
      motivo: 'sem_item_verificado',
      descartes: descartes(),
      itensRecebidos,
    };
  }

  const pontos: PontoDeAtencao[] = [];
  for (const p of resposta.pontos_de_atencao) {
    const conhecido = (PONTOS_DE_ATENCAO as readonly string[]).includes(p);
    if (!conhecido || pontos.length >= LIMITES_DO_RESUMO.pontosDeAtencao) {
      contagem.forma++;
    } else if (!pontos.includes(p)) {
      pontos.push(p);
    }
  }

  return {
    estado: 'verificado',
    situacao,
    pendencias,
    pontosDeAtencao: pontos,
    descartes: descartes(),
    itensRecebidos,
  };
}
