import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import type { Parte } from '../../domain/entities/Parte.js';
import { Processo } from '../../domain/entities/Processo.js';

/**
 * Forma serializável do `Processo` — JSON não sabe reidratar `Date` nem
 * `NumeroCNJ`.
 *
 * Módulo compartilhado entre o cache e o banco de propósito: eram dois
 * serializadores idênticos, e dois serializadores idênticos são um que vai
 * divergir do outro na primeira vez que o modelo ganhar um campo.
 */
export interface ProcessoSerializado {
  numero: string;
  tribunal: string;
  vara?: string;
  classe?: string;
  assunto?: string;
  assuntos: string[];
  dataDistribuicao?: string;
  grau?: string;
  valorCausa?: number;
  segredoJustica: boolean;
  partes: Parte[];
  movimentacoes: Array<Omit<Movimentacao, 'data'> & { data: string }>;
  procedencia: { provider: string; consultadoEm: string };
}

export interface OpcoesDeSerializacao {
  /**
   * Mantém `destinatariosOab` (as inscrições de advogados da comunicação do
   * DJEN). SÓ o cache em memória pede: o dado precisa chegar à gravação do
   * acompanhamento, que o troca por `paraOUsuario`. Banco e API nunca.
   */
  readonly preservarDestinatarios?: boolean;
}

/** Tira o campo transitório `destinatariosOab` (inscrição de terceiro não se guarda). */
export function semDestinatarios(m: Movimentacao): Movimentacao {
  if (m.destinatariosOab === undefined) return m;
  const { destinatariosOab: _descartado, ...resto } = m;
  return resto;
}

export function serializarProcesso(
  processo: Processo,
  opcoes: OpcoesDeSerializacao = {},
): ProcessoSerializado {
  return {
    numero: processo.numero.digitos,
    tribunal: processo.tribunal,
    ...(processo.vara !== undefined ? { vara: processo.vara } : {}),
    ...(processo.classe !== undefined ? { classe: processo.classe } : {}),
    ...(processo.assunto !== undefined ? { assunto: processo.assunto } : {}),
    assuntos: [...processo.assuntos],
    ...(processo.dataDistribuicao !== undefined
      ? { dataDistribuicao: processo.dataDistribuicao.toISOString() }
      : {}),
    ...(processo.grau !== undefined ? { grau: processo.grau } : {}),
    ...(processo.valorCausa !== undefined ? { valorCausa: processo.valorCausa } : {}),
    segredoJustica: processo.segredoJustica,
    partes: [...processo.partes],
    movimentacoes: processo.movimentacoes.map((m) => ({
      ...(opcoes.preservarDestinatarios ? m : semDestinatarios(m)),
      data: m.data.toISOString(),
    })),
    procedencia: {
      provider: processo.procedencia.provider,
      consultadoEm: processo.procedencia.consultadoEm.toISOString(),
    },
  };
}

export function reidratarProcesso(
  bruto: ProcessoSerializado,
  deCache: boolean,
): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(bruto.numero),
    tribunal: bruto.tribunal,
    ...(bruto.vara !== undefined ? { vara: bruto.vara } : {}),
    ...(bruto.classe !== undefined ? { classe: bruto.classe } : {}),
    ...(bruto.assunto !== undefined ? { assunto: bruto.assunto } : {}),
    assuntos: bruto.assuntos,
    ...(bruto.dataDistribuicao !== undefined
      ? { dataDistribuicao: new Date(bruto.dataDistribuicao) }
      : {}),
    ...(bruto.grau !== undefined ? { grau: bruto.grau } : {}),
    ...(bruto.valorCausa !== undefined ? { valorCausa: bruto.valorCausa } : {}),
    segredoJustica: bruto.segredoJustica,
    partes: bruto.partes,
    movimentacoes: bruto.movimentacoes.map((m) => ({ ...m, data: new Date(m.data) })),
    procedencia: {
      provider: bruto.procedencia.provider,
      consultadoEm: new Date(bruto.procedencia.consultadoEm),
      deCache,
    },
  });
}
