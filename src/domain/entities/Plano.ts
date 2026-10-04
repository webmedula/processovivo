import { PlanoInvalidoError } from '../errors/index.js';

/**
 * Os planos do Processo Vivo e o que cada um inclui.
 *
 * **Desde a v0.28.0 os planos são DADO, não código.** Nome, descrição, preço,
 * combinação de recursos e "à venda ou não" moram na tabela `planos` e são
 * editados pela área administrativa. O que continua em código são os
 * RECURSOS: cada recurso é uma funcionalidade que existe (ou não) no sistema,
 * e isso nenhum formulário muda. Um plano é uma combinação deles.
 *
 * O preço entrou no plano junto com essa mudança. Antes ficava de fora de
 * propósito — preço em código faria cada reajuste virar deploy. Agora que o
 * plano é linha de banco, reajuste é um formulário, e a objeção sumiu.
 */

/**
 * Capacidade que uma rota pode exigir.
 *
 * A granularidade é deliberada: o recurso é o que o ASSINANTE percebe como
 * funcionalidade, não o endpoint. `pecas` cobre listar e baixar, porque vender
 * "listar peças" separado de "baixar peças" seria uma distinção que só faz
 * sentido para quem escreveu o código.
 */
export type RecursoDoPlano =
  'consulta' | 'acompanhamento' | 'vigilancia' | 'calendario' | 'pecas' | 'analiseIa';

export interface DescricaoDoRecurso {
  readonly recurso: RecursoDoPlano;
  /** Rótulo curto, para lista e caixa de seleção. */
  readonly nome: string;
  /** Com artigo, para caber no meio de uma frase: "não inclui {frase}". */
  readonly frase: string;
  /**
   * Se a funcionalidade existe de verdade hoje.
   *
   * É o que substitui o antigo `disponivelParaContratacao: false` fixo no
   * plano de IA: a trava agora é do RECURSO, e vale para qualquer plano que o
   * inclua — inclusive um criado amanhã pelo painel. Vender assinatura de
   * recurso que ainda não funciona, para advogado, não volta como pedido de
   * reembolso — volta como reclamação formal. Virar para `true` é o passo
   * consciente de quando a análise existir.
   */
  readonly implementado: boolean;
}

export const RECURSOS: readonly DescricaoDoRecurso[] = Object.freeze([
  {
    recurso: 'consulta',
    nome: 'Consulta',
    frase: 'a consulta de processos',
    implementado: true,
  },
  {
    recurso: 'acompanhamento',
    nome: 'Acompanhamento',
    frase: 'o acompanhamento de processos',
    implementado: true,
  },
  {
    recurso: 'vigilancia',
    nome: 'Vigilância por OAB',
    frase: 'a vigilância por OAB',
    implementado: true,
  },
  {
    recurso: 'calendario',
    nome: 'Calendário',
    frase: 'o calendário',
    implementado: true,
  },
  {
    recurso: 'pecas',
    nome: 'Peças do processo',
    frase: 'as peças do processo',
    implementado: true,
  },
  {
    recurso: 'analiseIa',
    nome: 'Análise com IA',
    frase: 'a análise com IA',
    implementado: false,
  },
] as const);

export function ehRecurso(valor: string): valor is RecursoDoPlano {
  return RECURSOS.some((r) => r.recurso === valor);
}

export function descricaoDoRecurso(recurso: RecursoDoPlano): DescricaoDoRecurso {
  const achado = RECURSOS.find((r) => r.recurso === recurso);
  // Inalcançável com o tipo fechado; o throw existe para o compilador e para
  // um valor que chegue sem passar por `ehRecurso`.
  if (!achado) throw new Error(`recurso desconhecido: ${String(recurso)}`);
  return achado;
}

export function recursoImplementado(recurso: RecursoDoPlano): boolean {
  return descricaoDoRecurso(recurso).implementado;
}

/** Texto livre desde a v0.28.0 — o conjunto de códigos vem do banco. */
export type CodigoPlano = string;

export interface Plano {
  /** Identidade. Nunca muda depois de criado: as assinaturas apontam para ele. */
  readonly codigo: CodigoPlano;
  readonly nome: string;
  /** Uma linha, para a tela e para o e-mail. */
  readonly resumo: string;
  readonly recursos: readonly RecursoDoPlano[];
  /**
   * Se pode ser CONTRATADO hoje. Plano pausado continua valendo para quem já
   * o tem; só sai da lista de oferta.
   */
  readonly disponivelParaContratacao: boolean;
  /**
   * Preço de referência por mês, em CENTAVOS — inteiro, para não somar erro de
   * ponto flutuante em dinheiro. `null` é "sem preço publicado": o plano
   * existe, mas o valor é combinado caso a caso.
   */
  readonly precoMensalCentavos: number | null;
  /** Posição na lista, do menor para o maior. Também é a ordem de upgrade. */
  readonly ordem: number;
}

/**
 * O que todo plano tem. O calendário entrou aqui na v0.32.0 por decisão do
 * dono ("recurso do Acompanhamento, ou seja, de todos os planos") — e, como a
 * semente só vale para banco vazio, `banco.ts` acrescenta-o UMA vez aos planos
 * já gravados, e `ServicoPlanos.criar` o inclui por padrão nos planos novos.
 */
const BASE: readonly RecursoDoPlano[] = [
  'consulta',
  'acompanhamento',
  'vigilancia',
  'calendario',
];

/** Recursos que todo plano criado pelo painel recebe por padrão. */
export const RECURSOS_PADRAO_DE_PLANO_NOVO: readonly RecursoDoPlano[] = Object.freeze([
  'calendario',
]);

/**
 * Os três planos com que o sistema nasceu.
 *
 * Servem de SEMENTE: entram no banco na primeira subida da v0.28.0 (e só
 * então — depois disso, o que vale é o que estiver na tabela). Precisam
 * existir com estes códigos porque as assinaturas gravadas antes da mudança
 * apontam para eles.
 */
export const PLANOS_INICIAIS: readonly Plano[] = Object.freeze([
  Object.freeze({
    codigo: 'acompanhamento',
    nome: 'Acompanhamento',
    resumo:
      'Consulta por número, carteira acompanhada, vigilância pela OAB e aviso de movimentação.',
    recursos: Object.freeze([...BASE]),
    disponivelParaContratacao: true,
    precoMensalCentavos: null,
    ordem: 10,
  }),
  Object.freeze({
    codigo: 'pecas',
    nome: 'Peças',
    resumo:
      'Tudo do Acompanhamento, mais as peças do processo — petição, contestação, laudo e documento juntado pela parte.',
    recursos: Object.freeze([...BASE, 'pecas'] as const),
    disponivelParaContratacao: true,
    precoMensalCentavos: null,
    ordem: 20,
  }),
  Object.freeze({
    codigo: 'ia',
    nome: 'IA',
    resumo: 'Tudo do Peças, mais análise do processo com sugestões.',
    recursos: Object.freeze([...BASE, 'pecas', 'analiseIa'] as const),
    // Não pode ficar à venda enquanto `analiseIa` não estiver implementado —
    // `validarPlano` recusa, venha a tentativa do código ou do painel.
    disponivelParaContratacao: false,
    precoMensalCentavos: null,
    ordem: 30,
  }),
]);

/** Minúsculas, dígitos e hífen; começa por letra. Vai para URL e para log. */
const FORMATO_DO_CODIGO = /^[a-z][a-z0-9-]{1,29}$/;

/** R$ 100.000,00 por mês. Acima disso é erro de digitação, não preço. */
const PRECO_MAXIMO_CENTAVOS = 10_000_000;

/**
 * Confere um plano inteiro. Lança `PlanoInvalidoError` com a razão em
 * português — a mensagem vai direto para a tela do painel.
 */
export function validarPlano(plano: Plano): void {
  if (!FORMATO_DO_CODIGO.test(plano.codigo)) {
    throw new PlanoInvalidoError(
      'O código precisa ter de 2 a 30 caracteres, começar por letra e usar só ' +
        'letras minúsculas, números e hífen (ex.: "pecas-anual").',
    );
  }
  const nome = plano.nome.trim();
  if (nome.length === 0 || nome.length > 40) {
    throw new PlanoInvalidoError('O nome precisa ter de 1 a 40 caracteres.');
  }
  const resumo = plano.resumo.trim();
  if (resumo.length === 0 || resumo.length > 300) {
    throw new PlanoInvalidoError('A descrição precisa ter de 1 a 300 caracteres.');
  }
  if (plano.recursos.length === 0) {
    throw new PlanoInvalidoError('O plano precisa incluir pelo menos um recurso.');
  }
  for (const r of plano.recursos) {
    if (!ehRecurso(r))
      throw new PlanoInvalidoError(`Recurso desconhecido: "${String(r)}".`);
  }
  if (new Set(plano.recursos).size !== plano.recursos.length) {
    throw new PlanoInvalidoError('Há recurso repetido no plano.');
  }
  if (
    plano.precoMensalCentavos !== null &&
    (!Number.isInteger(plano.precoMensalCentavos) ||
      plano.precoMensalCentavos < 0 ||
      plano.precoMensalCentavos > PRECO_MAXIMO_CENTAVOS)
  ) {
    throw new PlanoInvalidoError(
      'O preço precisa ser um valor entre R$ 0,00 e R$ 100.000,00.',
    );
  }
  if (!Number.isInteger(plano.ordem) || plano.ordem < 0 || plano.ordem > 9999) {
    throw new PlanoInvalidoError('A ordem precisa ser um número inteiro entre 0 e 9999.');
  }

  if (plano.disponivelParaContratacao) {
    const ausentes = plano.recursos.filter((r) => !recursoImplementado(r));
    if (ausentes.length > 0) {
      throw new PlanoInvalidoError(
        `O plano ${nome} inclui ${ausentes.map((r) => descricaoDoRecurso(r).frase).join(', ')}, ` +
          'que ainda não existe no sistema. Plano com recurso que não funciona não pode ' +
          'ser colocado à venda.',
      );
    }
  }
}

export function planoInclui(plano: Plano, recurso: RecursoDoPlano): boolean {
  return plano.recursos.includes(recurso);
}

/** Pela ordem configurada; o código desempata para a lista nunca "pular". */
export function ordenarPlanos(planos: readonly Plano[]): Plano[] {
  return [...planos].sort(
    (a, b) => a.ordem - b.ordem || a.codigo.localeCompare(b.codigo),
  );
}

/** Planos que podem ser contratados hoje. É o que a tela de preços deve listar. */
export function planosAVenda(planos: readonly Plano[]): Plano[] {
  return ordenarPlanos(planos).filter((p) => p.disponivelParaContratacao);
}

/**
 * O menor plano que inclui o recurso — o que a mensagem de "seu plano não
 * inclui" deve sugerir. Prefere os que estão à venda: sugerir um plano
 * pausado mandaria a pessoa pedir algo que não se vende mais.
 */
export function menorPlanoCom(
  planos: readonly Plano[],
  recurso: RecursoDoPlano,
): Plano | undefined {
  const ordenados = ordenarPlanos(planos).filter((p) => planoInclui(p, recurso));
  return ordenados.find((p) => p.disponivelParaContratacao) ?? ordenados[0];
}
