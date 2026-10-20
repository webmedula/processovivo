import type {
  DiagnosticoDoGateway,
  MotivoDoGateway,
} from '../../../domain/errors/index.js';
import {
  FRASES_DE_CREDENCIAL,
  FRASES_DE_EMAIL_DO_PAGADOR,
  CAMPOS_DO_PEDIDO,
} from './mercadoPago.constantes.js';

/**
 * Lê a RECUSA (4xx) do Mercado Pago e a transforma em duas coisas seguras: um motivo de lista fechada e
 * um diagnóstico saneado para o log. Função pura, sem rede.
 *
 * O formato que o Mercado Pago devolve é `{ message, error, status, cause: [{ code, description }] }`.
 * O texto vem do gateway e PODE ecoar o e-mail do pagador ou um pedaço do pedido, então nada dele sai
 * cru: e-mail é mascarado, token é apagado, cada texto é cortado, e o corpo bruto nunca é guardado.
 *
 * A classificação casa por NOME DE CAMPO do contrato (`payer_email`, `back_url`…) e por frases inteiras
 * conhecidas — nunca por palavra solta ("email" ou "invalid" aparecem em qualquer erro). Sem evidência,
 * `desconhecido`: o texto saneado está no log, e um palpite errado manda o dono consertar a coisa errada.
 */

const MAX_TEXTO = 300;
const MAX_CAUSAS = 10;

const REGEX_DE_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const REGEX_DE_TOKEN = /\b(?:APP_USR|TEST)-[\w-]{6,}|Bearer\s+[\w.-]+/gi;

function mascararEmail(email: string): string {
  const [usuario = '', dominio = ''] = email.split('@');
  const partes = dominio.split('.');
  const resto = partes.slice(1).join('.');
  return `${usuario.slice(0, 1)}***@${(partes[0] ?? '').slice(0, 1)}***${resto ? `.${resto}` : ''}`;
}

/** Corta, mascara e-mail e apaga qualquer coisa com cara de token. */
export function sanearTexto(valor: unknown): string | undefined {
  if (typeof valor !== 'string' && typeof valor !== 'number') return undefined;
  const limpo = String(valor)
    .replace(REGEX_DE_TOKEN, '[token]')
    .replace(REGEX_DE_EMAIL, mascararEmail)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXTO);
  return limpo === '' ? undefined : limpo;
}

/** Os NOMES dos campos de um corpo JSON (um nível de objeto: `auto_recurring.frequency`), nunca os valores. */
export function nomesDosCampos(corpo: string | undefined): readonly string[] {
  if (!corpo) return [];
  try {
    const lido: unknown = JSON.parse(corpo);
    if (typeof lido !== 'object' || lido === null || Array.isArray(lido)) return [];
    const nomes: string[] = [];
    for (const [chave, valor] of Object.entries(lido)) {
      if (typeof valor === 'object' && valor !== null && !Array.isArray(valor)) {
        for (const filho of Object.keys(valor)) nomes.push(`${chave}.${filho}`);
      } else {
        nomes.push(chave);
      }
    }
    return nomes;
  } catch {
    return [];
  }
}

function objeto(valor: unknown): Record<string, unknown> | undefined {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : undefined;
}

export interface RecusaLida {
  readonly motivo: MotivoDoGateway;
  readonly diagnostico: DiagnosticoDoGateway;
}

export function lerRecusa(entrada: {
  readonly operacao: string;
  readonly status: number;
  readonly corpo: string;
  readonly camposEnviados: readonly string[];
}): RecusaLida {
  let lido: Record<string, unknown> | undefined;
  try {
    lido = objeto(JSON.parse(entrada.corpo));
  } catch {
    lido = undefined;
  }
  const erro = sanearTexto(lido?.['error']);
  const mensagem = sanearTexto(lido?.['message']);
  const bruto = Array.isArray(lido?.['cause']) ? (lido?.['cause'] as unknown[]) : [];
  const causas = bruto.slice(0, MAX_CAUSAS).flatMap((c) => {
    const o = objeto(c);
    if (!o) return [];
    const codigo = sanearTexto(o['code']);
    const descricao = sanearTexto(o['description']);
    return codigo === undefined && descricao === undefined
      ? []
      : [
          {
            ...(codigo !== undefined ? { codigo } : {}),
            ...(descricao !== undefined ? { descricao } : {}),
          },
        ];
  });

  const diagnostico: DiagnosticoDoGateway = {
    operacao: entrada.operacao,
    status: entrada.status,
    ...(erro !== undefined ? { erro } : {}),
    ...(mensagem !== undefined ? { mensagem } : {}),
    causas,
    camposEnviados: entrada.camposEnviados,
  };

  const texto = [mensagem, ...causas.map((c) => c.descricao)]
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
  let motivo: MotivoDoGateway = 'desconhecido';
  if (
    entrada.status === 401 ||
    entrada.status === 403 ||
    FRASES_DE_CREDENCIAL.some((f) => texto.includes(f))
  ) {
    motivo = 'credencial';
  } else if (
    CAMPOS_DO_PEDIDO.email.some((c) => texto.includes(c)) ||
    FRASES_DE_EMAIL_DO_PAGADOR.some((f) => texto.includes(f))
  ) {
    motivo = 'email_pagador';
  } else if (CAMPOS_DO_PEDIDO.outros.some((c) => texto.includes(c))) {
    motivo = 'parametro_invalido';
  }
  return { motivo, diagnostico };
}
