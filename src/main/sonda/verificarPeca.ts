import { normalizarParaComparar } from '../../application/politicas/normalizacaoDeTexto.js';
import {
  EXPRESSOES_PROIBIDAS,
  numerosForaDoTexto,
} from '../../application/politicas/verificarAnalise.js';
import type {
  DocumentoCitado,
  ItemComTrecho,
  PontoDeAtencaoDePeca,
  RespostaDePeca,
  TipoDePeca,
  ValorCitado,
} from './esquemaDePeca.js';
import { paginasDoTextoEnviado } from './promptDePeca.js';

/**
 * Verificação DETERMINÍSTICA da leitura de uma peça (especificação ia-analise-de-pecas v1.0.0,
 * seção 5). Só do comparador (Fase 0). Regras:
 *
 * 1. Cada trecho (e cada nome de documento ou valor literal) tem de existir no texto da PÁGINA
 *    indicada, comparado sem caixa, sem acento e com espaços colapsados. Senão, o item sai.
 * 2. Todo número, valor ou data escritos pelo modelo têm de estar no texto enviado. Senão, o item sai.
 * 3. Alegação e preliminar começam com "Alega que" (o verbo é parte do contrato). Senão, o item sai.
 * 4. Expressão proibida num texto ESCRITO PELO MODELO derruba o resultado inteiro. O trecho não
 *    entra: é cópia da peça, e uma contestação pode mesmo escrever "improcedente".
 * 5. Petição ou contestação sem nenhum pedido e nenhuma alegação verificados = "não verificado".
 */

export const EXPRESSOES_PROIBIDAS_DE_PECA: readonly string[] = Object.freeze([
  ...EXPRESSOES_PROIBIDAS,
  'merece provimento',
  'merece ser acolhido',
  'improcedente',
  'chance',
  'chances',
  'tese forte',
  'tese fraca',
  'deve recorrer',
  'vai ganhar',
  'tem razao',
  'sem razao',
  'razao assiste',
]);

export interface DescartesDaPeca {
  readonly citacao: number;
  readonly numero: number;
  readonly forma: number;
  readonly pagina: number;
}

export interface ContagemDeCitacoesDePeca {
  readonly emitidas: number;
  readonly validas: number;
}

export interface PecaVerificada {
  readonly estado: 'verificada';
  readonly tipo: TipoDePeca;
  readonly pedidos: readonly ItemComTrecho[];
  readonly alegacoes: readonly ItemComTrecho[];
  readonly preliminares: readonly ItemComTrecho[];
  readonly documentos: readonly DocumentoCitado[];
  readonly valores: readonly ValorCitado[];
  readonly pontosDeAtencao: readonly PontoDeAtencaoDePeca[];
  readonly citacoes: ContagemDeCitacoesDePeca;
  readonly descartes: DescartesDaPeca;
}

export interface PecaNaoVerificada {
  readonly estado: 'nao_verificada';
  readonly motivo: 'expressao_proibida' | 'sem_item_verificado';
  readonly citacoes: ContagemDeCitacoesDePeca;
  readonly descartes: DescartesDaPeca;
}

export type ResultadoDaVerificacaoDePeca = PecaVerificada | PecaNaoVerificada;

const escaparRegex = (e: string): string => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function expressaoProibidaDePecaEm(texto: string): string | undefined {
  const n = normalizarParaComparar(texto);
  return EXPRESSOES_PROIBIDAS_DE_PECA.find((e) =>
    new RegExp(`(?<![a-z0-9])${escaparRegex(e)}(?![a-z0-9])`).test(n),
  );
}

const semEspaco = (n: string): string => n.replace(/\s+/g, '');

/** O trecho existe na página (1-based)? Trecho de menos de 8 caracteres não sustenta nada. */
export function trechoNaPagina(
  trecho: string,
  pagina: number,
  paginasNormalizadas: readonly string[],
  minimo = 8,
): boolean {
  const alvo = normalizarParaComparar(trecho);
  if (alvo.length < minimo) return false;
  const texto = paginasNormalizadas[pagina - 1];
  return texto !== undefined && texto.includes(alvo);
}

export function verificarPeca(
  resposta: RespostaDePeca,
  textoEnviado: string,
): ResultadoDaVerificacaoDePeca {
  const paginas = paginasDoTextoEnviado(textoEnviado);
  const normalizadas = paginas.map(normalizarParaComparar);
  const tudo = normalizadas.join(' ');
  let emitidas = 0;
  let validas = 0;
  const d = { citacao: 0, numero: 0, forma: 0, pagina: 0 };

  const paginaValida = (p: number): boolean => p >= 1 && p <= paginas.length;
  const numerosOk = (...textos: string[]): boolean =>
    textos.every((t) => numerosForaDoTexto(t, tudo).length === 0);

  const comTrecho = (
    itens: readonly ItemComTrecho[],
    exigeAlega: boolean,
  ): ItemComTrecho[] => {
    const ok: ItemComTrecho[] = [];
    for (const it of itens) {
      emitidas += 1;
      if (!paginaValida(it.pagina)) {
        d.pagina += 1;
        continue;
      }
      if (!trechoNaPagina(it.trecho, it.pagina, normalizadas)) {
        d.citacao += 1;
        continue;
      }
      validas += 1;
      if (exigeAlega && !/^alega\b/.test(normalizarParaComparar(it.texto))) {
        d.forma += 1;
        continue;
      }
      if (!numerosOk(it.texto)) {
        d.numero += 1;
        continue;
      }
      ok.push(it);
    }
    return ok;
  };

  const documentos: DocumentoCitado[] = [];
  for (const doc of resposta.documentos_citados) {
    emitidas += 1;
    if (!paginaValida(doc.pagina)) {
      d.pagina += 1;
      continue;
    }
    // Nome LITERAL: curto é normal ("Doc. 1"), então o mínimo é menor que o de trecho.
    if (!trechoNaPagina(doc.nome_como_escrito, doc.pagina, normalizadas, 3)) {
      d.citacao += 1;
      continue;
    }
    validas += 1;
    documentos.push(doc);
  }

  const valores: ValorCitado[] = [];
  for (const v of resposta.valores_citados) {
    emitidas += 1;
    if (!paginaValida(v.pagina)) {
      d.pagina += 1;
      continue;
    }
    const pag = normalizadas[v.pagina - 1] ?? '';
    const literalNaPagina = semEspaco(pag).includes(
      semEspaco(normalizarParaComparar(v.valor_literal)),
    );
    if (!literalNaPagina || !trechoNaPagina(v.trecho, v.pagina, normalizadas)) {
      d.citacao += 1;
      continue;
    }
    validas += 1;
    if (!numerosOk(v.contexto_curto)) {
      d.numero += 1;
      continue;
    }
    valores.push(v);
  }

  const pedidos = comTrecho(resposta.pedidos, false);
  const alegacoes = comTrecho(resposta.alegacoes_principais, true);
  const preliminares = comTrecho(resposta.preliminares_ou_defesas_formais, true);

  const citacoes = { emitidas, validas };
  const textosDoModelo = [
    ...resposta.pedidos.map((i) => i.texto),
    ...resposta.alegacoes_principais.map((i) => i.texto),
    ...resposta.preliminares_ou_defesas_formais.map((i) => i.texto),
    ...resposta.valores_citados.map((i) => i.contexto_curto),
  ];
  if (textosDoModelo.some((t) => expressaoProibidaDePecaEm(t) !== undefined)) {
    return {
      estado: 'nao_verificada',
      motivo: 'expressao_proibida',
      citacoes,
      descartes: d,
    };
  }
  const tipoExigePedido =
    resposta.tipo_da_peca === 'peticao_inicial' ||
    resposta.tipo_da_peca === 'contestacao';
  if (tipoExigePedido && pedidos.length === 0 && alegacoes.length === 0) {
    return {
      estado: 'nao_verificada',
      motivo: 'sem_item_verificado',
      citacoes,
      descartes: d,
    };
  }
  return {
    estado: 'verificada',
    tipo: resposta.tipo_da_peca,
    pedidos,
    alegacoes,
    preliminares,
    documentos,
    valores,
    pontosDeAtencao: resposta.pontos_de_atencao,
    citacoes,
    descartes: d,
  };
}
