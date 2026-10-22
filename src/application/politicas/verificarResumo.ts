import {
  PONTOS_DE_ATENCAO,
  type PontoDeAtencao,
} from '../../domain/entities/vocabularioDaAnalise.js';
import {
  LIMITES_DO_RESUMO,
  type ItemBrutoDoResumo,
  type ItemDoResumo,
  type PontoDoResumo,
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
 * Regras 1.1.0 (v0.54.0), só quando o SISTEMA diz o que o resumo não leu (`ContextoDaVerificacao`):
 *   - o ato mais recente NÃO foi lido → item de `situacao` que o apresenta como situação atual
 *     ("atualmente", "no momento", "último ato"…) é descartado: seria dar a um ato antigo o lugar
 *     do que a IA não viu;
 *   - há providência do sistema que a IA não leu → item que afirma "não há pendências" ou
 *     "a IA não indicou pendências" é descartado: o silêncio da IA não é ausência de providência.
 *
 * Mude `VERSAO_DAS_REGRAS_DO_RESUMO` junto com qualquer alteração aqui.
 */
export const VERSAO_DAS_REGRAS_DO_RESUMO = '1.1.0';

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
  /** Item que apresentava como atual um ato antigo, com o ato mais recente sem leitura (1.1.0). */
  readonly atualidade: number;
  /** Item que negava pendência havendo providência do sistema sem leitura (1.1.0). */
  readonly pendenciaNegada: number;
}

/** O que o SISTEMA sabe e o modelo não: o que o resumo deixou de ler. */
export interface ContextoDaVerificacaoDoResumo {
  readonly maisRecenteNaoLido?: boolean;
  readonly providenciaNaoLida?: boolean;
}

/** Palavras que dão a um ato o lugar de "como o processo está agora". */
const ATUALIDADE =
  /\b(atual|atuais|atualmente|no momento|neste momento|nesse momento|hoje|ultimo ato|ultima movimentacao|ultimo movimento|mais recente|mais recentemente)\b/;
/** "Não há pendências", "a IA não indicou pendências", "sem providência". */
const PENDENCIA_NEGADA =
  /\b(nao (ha|existe|existem|foram? indicadas?|foi indicada?|indicou|apontou|aponta|constam?)|sem|nenhuma?|nada)\b[^.;]{0,48}\b(pendencias?|providencias?)\b/;

/** O texto apresenta o ato como a situação ATUAL do processo? (a regra da atualidade) */
export function textoApresentaComoAtual(texto: string): boolean {
  return ATUALIDADE.test(normalizarParaComparar(texto));
}

/** O texto afirma "não há pendências"? (a regra da pendência negada) */
export function textoNegaPendencia(texto: string): boolean {
  return PENDENCIA_NEGADA.test(normalizarParaComparar(texto));
}

export type ResultadoDaVerificacaoDoResumo =
  | {
      readonly estado: 'verificado';
      readonly situacao: readonly ItemDoResumo[];
      readonly pendencias: readonly ItemDoResumo[];
      readonly pontosDeAtencao: readonly PontoDeAtencao[];
      /** Os mesmos pontos, com o ato que o modelo apontou (1.1.0), quando válido. */
      readonly pontosDoAto: readonly PontoDoResumo[];
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
  contexto: ContextoDaVerificacaoDoResumo = {},
): ResultadoDaVerificacaoDoResumo {
  const contagem = {
    referencia: 0,
    citacao: 0,
    numeroInventado: 0,
    copiaDoTrecho: 0,
    forma: 0,
    expressaoProibida: 0,
    atualidade: 0,
    pendenciaNegada: 0,
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
    ehSituacao: boolean,
  ): ItemDoResumo[] => {
    const saida: ItemDoResumo[] = [];
    for (const i of bruto) {
      const texto = i.texto.trim();
      if (texto === '' || texto.length > LIMITES_DO_RESUMO.texto) {
        contagem.forma++;
        continue;
      }
      if (ehSituacao && contexto.maisRecenteNaoLido && textoApresentaComoAtual(texto)) {
        contagem.atualidade++;
        continue;
      }
      if (contexto.providenciaNaoLida && textoNegaPendencia(texto)) {
        contagem.pendenciaNegada++;
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

  const situacao = verificar(resposta.situacao, LIMITES_DO_RESUMO.situacao, true);
  const pendencias = verificar(resposta.pendencias, LIMITES_DO_RESUMO.pendencias, false);

  if (situacao.length === 0) {
    return {
      estado: 'nao_verificado',
      motivo: 'sem_item_verificado',
      descartes: descartes(),
      itensRecebidos,
    };
  }

  const pontos: PontoDeAtencao[] = [];
  const pontosDoAto: PontoDoResumo[] = [];
  for (const p of resposta.pontos_de_atencao) {
    const codigo = typeof p === 'string' ? p : p.codigo;
    const conhecido = (PONTOS_DE_ATENCAO as readonly string[]).includes(codigo);
    if (!conhecido || pontos.length >= LIMITES_DO_RESUMO.pontosDeAtencao) {
      contagem.forma++;
    } else if (!pontos.includes(codigo)) {
      pontos.push(codigo);
      // O ato do ponto é do SISTEMA (data e rótulo saem do retrato); id que não existe = ponto genérico.
      const id = typeof p === 'string' ? undefined : normalizarIdDoAto(p.ato);
      const ato = id === undefined ? undefined : atos.get(id);
      pontosDoAto.push({ codigo, ...(ato ? { chaveDoAto: ato.chave } : {}) });
    }
  }

  return {
    estado: 'verificado',
    situacao,
    pendencias,
    pontosDeAtencao: pontos,
    pontosDoAto,
    descartes: descartes(),
    itensRecebidos,
  };
}
