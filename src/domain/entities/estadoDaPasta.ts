import { chaveDaMovimentacao } from './Acompanhamento.js';
import type { ParaOUsuario } from './destinatarioDaComunicacao.js';
import type { Movimentacao } from './Movimentacao.js';
import { tipoDaComunicacao } from './tipoDaComunicacao.js';
import type { TipoDaComunicacao } from './tipoDaComunicacao.js';
import { triar } from './triagem.js';

/**
 * Em que pé está uma pasta, em uma palavra.
 *
 * Existe para a carteira em tabela: com 142 linhas, "última movimentação" é
 * texto corrido que o olho não varre. Uma coluna de estado responde de longe.
 *
 * O QUE NÃO ESTÁ AQUI, e a ausência é decisão: *Audiência* e *Trânsito em
 * julgado*. As duas apareciam na referência que originou esta tela e as duas
 * exigiriam ler código da TPU que nunca vi numa resposta real deste projeto.
 * Um selo "Audiência" que erra na tela de um advogado é pior do que coluna
 * nenhuma — ele não vai conferir o que o sistema afirmou com tanta convicção.
 * Entram quando houver captura real que sustente a classificação.
 */
export type RotuloDaPasta = 'PROVIDENCIA' | 'NOVIDADE' | 'ARQUIVADO' | 'EM_CURSO';

export interface EstadoDaPasta {
  readonly rotulo: RotuloDaPasta;
  /**
   * A última tentativa de verificar este processo falhou, ou nunca houve uma.
   *
   * É um marcador SEPARADO do rótulo, e não um quinto valor dele, porque as
   * duas informações coexistem: uma pasta pode ter prazo aberto E estar sem
   * verificação há três dias. Colapsar as duas num só selo esconderia sempre
   * uma delas, e não há escolha boa sobre qual esconder — a providência é o
   * que fazer hoje, a falha é o motivo para não confiar no silêncio.
   *
   * Ver a regra do `ServicoNotificacao`: a partir do primeiro aviso enviado, o
   * advogado para de conferir à mão e lê silêncio como "não houve nada".
   */
  readonly naoVerificado: boolean;
  /** Por que o rótulo é este. Vai para o title do selo: heurística sem explicação não se audita. */
  readonly motivo?: string;
  /**
   * A leitura de providência por trás do rótulo (v0.37.5): qual ato a gera, qual
   * ficou coberto por uma marca de "cumprido" e qual passou da janela sem marca.
   * Existe para a tela mostrar o ATO (que pode não ser o último da linha do
   * tempo) e para ela dizer o que a marca e o tempo tiraram do filtro.
   */
  readonly providencia: LeituraDaProvidencia;
}

/** Um ato que pede (ou pediu) providência, com o que a tela precisa para nomeá-lo. */
export interface AtoDaProvidencia {
  /** Título do ato como a fonte o entregou. */
  readonly rotulo: string;
  readonly data: Date;
  /** `chaveDaMovimentacao`: é o que a marca de "cumprido" guarda. */
  readonly chave: string;
  /** Só o DJEN informa; `outro` para todo o resto. */
  readonly tipo: TipoDaComunicacao;
  /**
   * A comunicação do Diário é dirigida ao workspace? (v0.37.6.) `desconhecido`
   * para ato que não é do DJEN, retrato anterior à v0.37.6 ou OAB não cadastrada.
   */
  readonly paraOUsuario: ParaOUsuario;
}

/** A marca do advogado: "cumpri tudo até este ato". Ver `ServicoAcompanhamento.marcarComoCumprido`. */
export interface MarcaDeCumprido {
  readonly chave: string;
  /** Data do ato marcado: cobre os atos até ela, inclusive. */
  readonly ate: Date;
  readonly em: Date;
}

export interface LeituraDaProvidencia {
  /** O ato MAIS RECENTE que pede providência agora (dentro da janela e sem marca). */
  readonly pendente?: AtoDaProvidencia;
  /** Teria pedido, mas a marca de cumprido o cobre. Só preenchido quando nada mais pede. */
  readonly coberto?: AtoDaProvidencia;
  /**
   * Intimação/citação do Diário que passou da janela SEM marca. Só preenchido
   * quando nada mais pede providência: é o que a tela conta em "sem marca há
   * mais de N dias".
   */
  readonly venceuPorTempo?: AtoDaProvidencia;
  /**
   * Intimação/citação do Diário dirigida a OUTRO destinatário, dentro da janela da
   * intimação e sem marca de cumprido (v0.37.6). Não pede providência por ser
   * intimação — volta à regra comum do ato —, mas a tela a mostra e conta: um
   * "nao" calculado por inscrição pode errar (sócio com outra OAB), então o
   * processo nunca sai do alcance do advogado sem uma frase que o diga.
   */
  readonly outroDestinatario?: AtoDaProvidencia;
}

/**
 * Janela, em dias, em que uma determinação ainda conta como pendente.
 *
 * É a configuração ÚNICA (`PENDENCIA_JANELA_DIAS`, 10 por padrão desde a
 * v0.32.1; era 30): o selo da carteira, o card do painel e o bloco "Pede
 * providência" da tela do processo leem o MESMO valor, que o servidor entrega
 * à tela. Duas janelas dariam uma carteira que diz "providência" e uma tela do
 * processo que não mostra o ato.
 *
 * Sem janela, um "intime-se" de 2019 deixaria a pasta marcada como pendente
 * para sempre, e o selo perderia o sentido — toda pasta antiga ficaria
 * vermelha. Com 30 dias a carteira inteira de um escritório ativo vivia
 * marcada; 10 foi o que os advogados pediram.
 *
 * Não é cálculo de prazo, e não se apresenta como tal: é o recorte do que vale
 * a pena olhar primeiro. O ato fora da janela continua marcado na linha do
 * tempo — só deixa de ocupar o topo.
 */
export const PENDENCIA_JANELA_DIAS_PADRAO = 10;

/**
 * Quanto dura o "pede providência" de uma INTIMAÇÃO ou CITAÇÃO publicada no
 * Diário Eletrônico (v0.37.5): até o advogado marcar como cumprido ou até 30 dias
 * da disponibilização, o que vier antes. É um valor só, entregue à tela pelo
 * servidor.
 *
 * NÃO é prazo e não se apresenta como tal. É a janela de LEITURA AUTOMÁTICA: o
 * sistema não sabe quanto tempo o ato deu ao advogado (a "data limite" do
 * Projudi não chega por nenhuma fonte que usamos), então escolhe um tempo em que
 * ainda vale a pena olhar primeiro. Quando vence sem marca o processo sai do
 * filtro, continua em "Todas", e a tela diz quantos saíram por tempo — sumir em
 * silêncio seria perder o ato. Os demais atos seguem em `PENDENCIA_JANELA_DIAS`.
 */
export const PENDENCIA_INTIMACAO_JANELA_DIAS = 30;

/** Instante a partir do qual um ato ainda está na janela de pendência. */
export function inicioDaJanelaDePendencia(
  agora: Date,
  janelaDias: number = PENDENCIA_JANELA_DIAS_PADRAO,
): Date {
  return new Date(agora.getTime() - janelaDias * 86_400_000);
}

/** Título de ato que encerra a pasta. `desarquivamento` NÃO entra — ele reabre. */
const ENCERRAMENTO = /\b(arquivamento|arquivado|arquivados|baixa\s+definitiva)\b/i;
const REABERTURA = /\bdesarquiv/i;

export interface EntradaDoEstado {
  /** A marca de "cumprido" da pasta, se houver. Cobre os atos até a data dela. */
  readonly cumprido?: MarcaDeCumprido;
  readonly erro?: string;
  readonly sincronizadoEm?: Date;
  readonly novidadesNaoVistas?: number;
  readonly movimentacoes?: readonly Movimentacao[];
}

/**
 * Lê os atos que pedem providência, aplicando as duas janelas e a marca.
 *
 * Pura e sem estado: o servidor chama uma vez por processo e entrega o resultado
 * à tela, que nunca refaz a conta. A marca cobre os atos até a DATA do ato
 * marcado, inclusive — o DJEN só informa o dia, então um ato publicado no mesmo
 * dia do marcado também fica coberto; ato de dia posterior que exija ação volta
 * a pedir providência sozinho.
 */
export function lerProvidencia(
  movs: readonly Movimentacao[],
  agora: Date,
  janelaDias: number = PENDENCIA_JANELA_DIAS_PADRAO,
  janelaIntimacaoDias: number = PENDENCIA_INTIMACAO_JANELA_DIAS,
  cumprido?: MarcaDeCumprido,
): LeituraDaProvidencia {
  let pendente: AtoDaProvidencia | undefined;
  let coberto: AtoDaProvidencia | undefined;
  let venceu: AtoDaProvidencia | undefined;
  let outroDestinatario: AtoDaProvidencia | undefined;
  const maisRecente = (a: AtoDaProvidencia | undefined, b: AtoDaProvidencia): AtoDaProvidencia =>
    !a || b.data.getTime() > a.data.getTime() ? b : a;

  for (const m of movs) {
    const tipoDoDiario = tipoDaComunicacao(m.tipoComunicacao);
    const paraOUsuario = m.paraOUsuario ?? 'desconhecido';
    // Intimação a outro destinatário: volta à regra comum do ato. O `exigeAcao`
    // gravado pode ter nascido da cláusula da intimação, então é recalculado.
    const aOutro = tipoDoDiario !== 'outro' && paraOUsuario === 'nao';
    const exige = aOutro ? triar(m).exigeAcao : (m.exigeAcao ?? triar(m).exigeAcao);
    const tipo = aOutro ? 'outro' : tipoDoDiario;
    const ato: AtoDaProvidencia = {
      rotulo: m.titulo,
      data: m.data,
      chave: chaveDaMovimentacao(m),
      tipo,
      paraOUsuario,
    };
    const marcado = cumprido !== undefined && m.data.getTime() <= cumprido.ate.getTime();

    if (aOutro && !marcado) {
      const dentroDaJanelaDoDiario =
        m.data.getTime() >= inicioDaJanelaDePendencia(agora, janelaIntimacaoDias).getTime();
      if (dentroDaJanelaDoDiario) outroDestinatario = maisRecente(outroDestinatario, ato);
    }

    if (!exige) continue;
    const janela = tipo === 'outro' ? janelaDias : janelaIntimacaoDias;
    const dentro = m.data.getTime() >= inicioDaJanelaDePendencia(agora, janela).getTime();

    if (dentro && !marcado) pendente = maisRecente(pendente, ato);
    else if (dentro && marcado) coberto = maisRecente(coberto, ato);
    else if (!dentro && !marcado && tipo !== 'outro') venceu = maisRecente(venceu, ato);
  }

  // Cobertura e vencimento só informam quando nada mais pede providência: com um
  // ato pendente, a linha é sobre ele. `outroDestinatario` é a exceção: é um
  // aviso sobre o processo, não sobre o ato da linha, e segue junto.
  return {
    ...(pendente ? { pendente } : {}),
    ...(!pendente && coberto ? { coberto } : {}),
    ...(!pendente && venceu ? { venceuPorTempo: venceu } : {}),
    ...(outroDestinatario ? { outroDestinatario } : {}),
  };
}

export function estadoDaPasta(
  entrada: EntradaDoEstado,
  agora: Date = new Date(),
  janelaDias: number = PENDENCIA_JANELA_DIAS_PADRAO,
  janelaIntimacaoDias: number = PENDENCIA_INTIMACAO_JANELA_DIAS,
): EstadoDaPasta {
  const naoVerificado =
    entrada.erro !== undefined || entrada.sincronizadoEm === undefined;
  const movs = entrada.movimentacoes ?? [];

  const providencia = lerProvidencia(
    movs,
    agora,
    janelaDias,
    janelaIntimacaoDias,
    entrada.cumprido,
  );
  if (providencia.pendente) {
    const dias = providencia.pendente.tipo === 'outro' ? janelaDias : janelaIntimacaoDias;
    return {
      rotulo: 'PROVIDENCIA',
      naoVerificado,
      motivo: `"${providencia.pendente.rotulo}" nos últimos ${dias} dias`,
      providencia,
    };
  }

  if ((entrada.novidadesNaoVistas ?? 0) > 0) {
    return {
      rotulo: 'NOVIDADE',
      naoVerificado,
      motivo: 'há movimentação não lida',
      providencia,
    };
  }

  /*
   * O encerramento se decide pelo ato MAIS RECENTE, nunca por "existe um
   * arquivamento no histórico". Processo arquivado e depois desarquivado tem os
   * dois atos; olhar o histórico inteiro marcaria como encerrada uma pasta que
   * voltou a correr — e o advogado deixaria de olhar justamente a que voltou.
   */
  const ultima = maisRecente(movs);
  if (ultima && ENCERRAMENTO.test(ultima.titulo) && !REABERTURA.test(ultima.titulo)) {
    return { rotulo: 'ARQUIVADO', naoVerificado, motivo: ultima.titulo, providencia };
  }

  return { rotulo: 'EM_CURSO', naoVerificado, providencia };
}

function maisRecente(movs: readonly Movimentacao[]): Movimentacao | undefined {
  let melhor: Movimentacao | undefined;
  for (const m of movs) {
    if (!melhor || m.data.getTime() > melhor.data.getTime()) melhor = m;
  }
  return melhor;
}
