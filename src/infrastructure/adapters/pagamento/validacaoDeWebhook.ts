import { createHmac, timingSafeEqual } from 'node:crypto';
import { AssinaturaDeWebhookInvalidaError } from '../../../domain/errors/index.js';
import { TOLERANCIA_DO_AVISO_SEGUNDOS } from './mercadoPago.constantes.js';

export interface EntradaDaValidacao {
  /** `x-signature`, cru: `ts=<segundos>,v1=<hex>`. */
  readonly assinatura: string | undefined;
  /** `x-request-id`, cru. */
  readonly idDaRequisicao: string | undefined;
  /** `data.id` da query string, cru (sem converter para minúsculas). */
  readonly idDoRecurso: string | undefined;
  /** A chave secreta do webhook (gerada no painel do Mercado Pago). */
  readonly segredo: string;
  readonly agora: Date;
  readonly toleranciaSegundos?: number;
}

/** Os pares `chave=valor` do cabeçalho: separa em `,`, depois no PRIMEIRO `=`; chave em minúsculas. */
function lerCabecalho(cabecalho: string): { ts?: string; v1?: string } {
  const achado: { ts?: string; v1?: string } = {};
  for (const parte of cabecalho.split(',')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    const chave = parte.slice(0, i).trim().toLowerCase();
    const valor = parte.slice(i + 1).trim();
    if (chave === '' || valor === '') continue;
    if (chave === 'ts') achado.ts = valor;
    else if (chave === 'v1') achado.v1 = valor;
  }
  return achado;
}

/** Comparação em tempo constante: tamanhos diferentes são recusados antes, e só então o `timingSafeEqual`. */
function iguaisEmTempoConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Confere a assinatura do aviso, como o SDK oficial do Mercado Pago
 * (`mercadopago/sdk-nodejs`, `src/utils/webhook`; fonte lida em 10/2026):
 *
 * - `x-signature` = `ts=<segundos>,v1=<hex>`;
 * - texto assinado = `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` — a parte de `id` e a de
 *   `request-id` SAEM quando o valor não veio, e o `;` final fica sempre;
 * - HMAC-SHA256 em hexadecimal (minúsculo) com a chave secreta, comparado em tempo constante;
 * - o `data.id` NÃO é convertido para minúsculas (o SDK não o faz; os ids dos nossos tópicos são
 *   numéricos). CONFIRMAR no teste real;
 * - só depois de o hash bater se confere o `ts` contra o relógio (±300 s), contra repetição antiga.
 *
 * @throws {AssinaturaDeWebhookInvalidaError} sempre que o aviso não se prova do gateway.
 */
export function validarAssinaturaDoWebhook(entrada: EntradaDaValidacao): void {
  if (entrada.segredo === '') throw new AssinaturaDeWebhookInvalidaError('sem_segredo');
  if (entrada.assinatura === undefined || entrada.assinatura.trim() === '') {
    throw new AssinaturaDeWebhookInvalidaError('ausente');
  }
  const { ts, v1 } = lerCabecalho(entrada.assinatura);
  if (ts === undefined) throw new AssinaturaDeWebhookInvalidaError('sem_timestamp');
  if (v1 === undefined) throw new AssinaturaDeWebhookInvalidaError('sem_hash');

  const partes: string[] = [];
  if (entrada.idDoRecurso !== undefined && entrada.idDoRecurso !== '') {
    partes.push(`id:${entrada.idDoRecurso}`);
  }
  if (entrada.idDaRequisicao !== undefined && entrada.idDaRequisicao !== '') {
    partes.push(`request-id:${entrada.idDaRequisicao}`);
  }
  partes.push(`ts:${ts}`);
  const manifesto = `${partes.join(';')};`;

  const esperado = createHmac('sha256', entrada.segredo).update(manifesto).digest('hex');
  if (!iguaisEmTempoConstante(esperado, v1)) {
    throw new AssinaturaDeWebhookInvalidaError('diferente');
  }

  const segundos = Number(ts);
  if (!Number.isFinite(segundos)) throw new AssinaturaDeWebhookInvalidaError('sem_timestamp');
  const tolerancia = entrada.toleranciaSegundos ?? TOLERANCIA_DO_AVISO_SEGUNDOS;
  if (Math.abs(entrada.agora.getTime() - segundos * 1000) / 1000 > tolerancia) {
    throw new AssinaturaDeWebhookInvalidaError('fora_do_prazo');
  }
}

/** Para o teste e para o roteiro do dono: assina um aviso com o MESMO manifesto. Nunca usado em produção. */
export function assinarAvisoParaTeste(opcoes: {
  readonly segredo: string;
  readonly ts: number;
  readonly idDoRecurso?: string;
  readonly idDaRequisicao?: string;
}): string {
  const partes: string[] = [];
  if (opcoes.idDoRecurso) partes.push(`id:${opcoes.idDoRecurso}`);
  if (opcoes.idDaRequisicao) partes.push(`request-id:${opcoes.idDaRequisicao}`);
  partes.push(`ts:${opcoes.ts}`);
  const hash = createHmac('sha256', opcoes.segredo)
    .update(`${partes.join(';')};`)
    .digest('hex');
  return `ts=${opcoes.ts},v1=${hash}`;
}
