import type {
  DocumentoDaPeca,
  ItemDaPeca,
  PontoDeAtencaoDePeca,
  RespostaDoModeloDePeca,
  TipoDePeca,
  ValorDaPeca,
} from '../../domain/entities/AnaliseDePeca.js';
import { paginasDoTextoEnviado } from './entradaDaPeca.js';
import { normalizarParaComparar } from './normalizacaoDeTexto.js';
import { EXPRESSOES_PROIBIDAS, numerosForaDoTexto } from './verificarAnalise.js';

/**
 * Verificação DETERMINÍSTICA da análise de uma peça (especificação ia-analise-de-pecas, seção 5 e
 * v1.2.0). Não confia no modelo em nada. Regras, em ordem:
 *
 * 1. Cada trecho (e cada nome de documento ou valor literal) tem de existir no texto da PÁGINA
 *    indicada, comparado sem caixa, sem acento e com espaços colapsados. Senão, o item sai.
 * 2. Todo número, valor ou data escritos pelo modelo têm de estar no texto enviado. Senão, o item sai
 *    (na frase única, é a frase que sai).
 * 3. Alegação e preliminar começam com "Alega que" (o verbo é parte do contrato). Senão, o item sai.
 * 4. Expressão proibida (conselho, tese, prazo fatal, MÉRITO) num texto ESCRITO PELO MODELO derruba o
 *    resultado inteiro. O trecho não entra: é cópia da peça, e uma contestação pode escrever
 *    "improcedente" mesmo.
 * 5. Petição ou contestação sem nenhum pedido e nenhuma alegação verificados = "não verificado".
 *
 * Mude `VERSAO_DAS_REGRAS_DA_PECA` junto com qualquer alteração aqui. É a ÚNICA implementação: o
 * comparador de peças (Fase 0) delega a esta função.
 */
export const VERSAO_DAS_REGRAS_DA_PECA = '1.0.0';

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
  // Mérito (v0.55.0): a leitura descreve o que a peça diz; nunca se a peça está certa nem o que vai
  // acontecer. De propósito NÃO entram "procedente", "tem direito", "faz jus" nem "comprovado":
  // são o vocabulário do próprio pedido e da própria alegação ("pede que a ação seja julgada
  // procedente", "alega que tem direito"), e derrubar o resultado inteiro por descrever a peça
  // com fidelidade seria punir a fidelidade — o prompt já proíbe, e a revisão humana confere.
  'restou comprovado',
  'bem fundamentado',
  'bem fundamentada',
  'infundado',
  'infundada',
  'sem fundamento',
  'provavel',
  'probabilidade',
  'exito',
  'vitoria',
  'derrota',
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
  /** Vazia quando o modelo não a deu (comparador da Fase 0) ou quando ela saiu da verificação. */
  readonly emUmaFrase: string;
  readonly pedidos: readonly ItemDaPeca[];
  readonly alegacoes: readonly ItemDaPeca[];
  readonly preliminares: readonly ItemDaPeca[];
  readonly documentos: readonly DocumentoDaPeca[];
  readonly valores: readonly ValorDaPeca[];
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

export function verificarAnaliseDePeca(
  resposta: RespostaDoModeloDePeca,
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

  const comTrecho = (itens: readonly ItemDaPeca[], exigeAlega: boolean): ItemDaPeca[] => {
    const ok: ItemDaPeca[] = [];
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

  const documentos: DocumentoDaPeca[] = [];
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

  const valores: ValorDaPeca[] = [];
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
  const umaFrase = resposta.em_uma_frase?.trim() ?? '';
  const textosDoModelo = [
    umaFrase,
    ...resposta.pedidos.map((i) => i.texto),
    ...resposta.alegacoes_principais.map((i) => i.texto),
    ...resposta.preliminares_ou_defesas_formais.map((i) => i.texto),
    ...resposta.valores_citados.map((i) => i.contexto_curto),
  ];
  if (textosDoModelo.some((t) => t !== '' && expressaoProibidaDePecaEm(t) !== undefined)) {
    return { estado: 'nao_verificada', motivo: 'expressao_proibida', citacoes, descartes: d };
  }
  // A frase única não tem trecho: só vale se os números dela estão no texto enviado.
  let emUmaFrase = umaFrase;
  if (emUmaFrase !== '' && !numerosOk(emUmaFrase)) {
    d.numero += 1;
    emUmaFrase = '';
  }
  const tipoExigePedido =
    resposta.tipo_da_peca === 'peticao_inicial' || resposta.tipo_da_peca === 'contestacao';
  if (tipoExigePedido && pedidos.length === 0 && alegacoes.length === 0) {
    return { estado: 'nao_verificada', motivo: 'sem_item_verificado', citacoes, descartes: d };
  }
  return {
    estado: 'verificada',
    tipo: resposta.tipo_da_peca,
    emUmaFrase,
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
