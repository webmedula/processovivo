import {
  ROTULO_DO_TIPO,
  dataBrasileira,
  dataLocalEm,
} from '../../domain/entities/EventoDeCalendario.js';
import type { TipoDeEvento } from '../../domain/entities/EventoDeCalendario.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type { ItemDoResumo } from '../../domain/ports/RepositorioDoResumoDoCalendario.js';

/** Quantos itens o e-mail lista; o resto vira "e mais N". */
export const MAXIMO_DE_ITENS_NO_EMAIL = 10;

export interface MensagemDoResumo {
  readonly assunto: string;
  readonly texto: string;
}

/**
 * O texto do resumo dos eventos a confirmar (v0.51.0). Função PURA.
 *
 * O que NUNCA entra: nome de parte, trecho de andamento, observação, título livre do evento. Processo em
 * segredo de justiça vai como "processo sigiloso", sem número. Nada afirma prazo: cada item diz de onde
 * a data foi LIDA e manda conferir no processo.
 */
export function montarResumoDoCalendario(
  itens: readonly ItemDoResumo[],
  opcoes: { readonly urlBase: string },
): MensagemDoResumo {
  const total = itens.length;
  const listados = itens.slice(0, MAXIMO_DE_ITENS_NO_EMAIL);
  const linhas: string[] = [
    total === 1
      ? 'Há 1 evento esperando a sua confirmação no calendário:'
      : `Há ${total} eventos esperando a sua confirmação no calendário:`,
    '',
  ];

  listados.forEach((i, n) => {
    linhas.push(`${n + 1}. ${descreverItem(i)}`);
    linhas.push(`   ${observacaoDoItem(i)}`);
  });
  if (total > listados.length) {
    linhas.push('', `e mais ${total - listados.length}.`);
  }

  linhas.push(
    '',
    'Confirme ou descarte cada um no calendário.',
    opcoes.urlBase
      ? `Revisar no calendário: ${opcoes.urlBase}/?calendario=resumo`
      : 'Revisar no calendário: abra o Processo Vivo e entre em Calendário.',
    '',
    'As datas são lidas automaticamente do texto dos andamentos. Confira sempre no processo.',
    'Para deixar de receber este resumo: Calendário > Resumo por e-mail.',
  );

  return {
    assunto: `Processo Vivo: ${total} evento(s) para você confirmar`,
    texto: linhas.join('\n'),
  };
}

function descreverItem(i: ItemDoResumo): string {
  const tipo = ROTULO_DO_TIPO[i.tipo as TipoDeEvento] ?? 'Compromisso';
  const quando = i.horaLocal
    ? `${dataBrasileira(i.dataLocal)} às ${i.horaLocal}`
    : `${dataBrasileira(i.dataLocal)} (dia inteiro)`;
  return `${tipo} — ${quando} — ${i.segredoJustica ? 'processo sigiloso' : formatado(i.numeroProcesso)}`;
}

function observacaoDoItem(i: ItemDoResumo): string {
  if (i.motivo === 'revisar') {
    return 'O andamento mais recente sugere mudança, confira.';
  }
  if (!i.dataDoAndamento) return 'Data lida do andamento, confira no processo.';
  const [, mes, dia] = dataLocalEm(i.dataDoAndamento).split('-');
  return `Data lida do andamento de ${dia}/${mes}, confira no processo.`;
}

function formatado(digitos: string): string {
  try {
    return NumeroCNJ.criar(digitos).formatado;
  } catch {
    return digitos;
  }
}
