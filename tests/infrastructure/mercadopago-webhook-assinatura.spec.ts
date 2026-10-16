import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssinaturaDeWebhookInvalidaError } from '../../src/domain/errors/index.js';
import {
  assinarAvisoParaTeste,
  validarAssinaturaDoWebhook,
} from '../../src/infrastructure/adapters/pagamento/validacaoDeWebhook.js';

/*
 * A conferência do aviso do Mercado Pago, pela fórmula do SDK oficial (`sdk-nodejs`, utils/webhook):
 * `x-signature` = `ts=<s>,v1=<hex>`; texto = `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`;
 * HMAC-SHA256 hex com a chave secreta. Tudo sintético: o segredo abaixo não é de ninguém.
 */
const SEGREDO = 'segredo-sintetico-de-teste';
const AGORA = new Date('2026-10-20T12:00:00.000Z');
const TS = Math.floor(AGORA.getTime() / 1000);

const ASSINATURA_BOA: string = assinarAvisoParaTeste({
  segredo: SEGREDO,
  ts: TS,
  idDoRecurso: '123456',
  idDaRequisicao: 'req-1',
});

function entrada(extra: Partial<Parameters<typeof validarAssinaturaDoWebhook>[0]> = {}) {
  return {
    assinatura: ASSINATURA_BOA as string | undefined,
    idDaRequisicao: 'req-1',
    idDoRecurso: '123456',
    segredo: SEGREDO,
    agora: AGORA,
    ...extra,
  };
}

function motivoDe(
  e: Parameters<typeof validarAssinaturaDoWebhook>[0],
): string | undefined {
  try {
    validarAssinaturaDoWebhook(e);
    return undefined;
  } catch (erro) {
    expect(erro).toBeInstanceOf(AssinaturaDeWebhookInvalidaError);
    return (erro as AssinaturaDeWebhookInvalidaError).motivo;
  }
}

describe('assinatura do webhook do Mercado Pago', () => {
  it('aceita a assinatura válida', () => {
    expect(motivoDe(entrada())).toBeUndefined();
  });

  it('usa EXATAMENTE o manifesto `id:…;request-id:…;ts:…;` (conferido com o HMAC calculado à mão)', () => {
    const manifesto = `id:123456;request-id:req-1;ts:${TS};`;
    const v1 = createHmac('sha256', SEGREDO).update(manifesto).digest('hex');
    expect(motivoDe(entrada({ assinatura: `ts=${TS},v1=${v1}` }))).toBeUndefined();
  });

  it('as partes ausentes saem do manifesto e o `;` final fica', () => {
    const semRequestId = createHmac('sha256', SEGREDO)
      .update(`id:123456;ts:${TS};`)
      .digest('hex');
    expect(
      motivoDe(
        entrada({ assinatura: `ts=${TS},v1=${semRequestId}`, idDaRequisicao: undefined }),
      ),
    ).toBeUndefined();
    const semId = createHmac('sha256', SEGREDO)
      .update(`request-id:req-1;ts:${TS};`)
      .digest('hex');
    expect(
      motivoDe(entrada({ assinatura: `ts=${TS},v1=${semId}`, idDoRecurso: undefined })),
    ).toBeUndefined();
  });

  it('recusa assinatura ausente ou vazia', () => {
    expect(motivoDe(entrada({ assinatura: undefined }))).toBe('ausente');
    expect(motivoDe(entrada({ assinatura: '   ' }))).toBe('ausente');
  });

  it('recusa cabeçalho malformado, sem ts ou sem hash', () => {
    expect(motivoDe(entrada({ assinatura: 'lixo' }))).toBe('sem_timestamp');
    expect(motivoDe(entrada({ assinatura: `v1=abc` }))).toBe('sem_timestamp');
    expect(motivoDe(entrada({ assinatura: `ts=${TS}` }))).toBe('sem_hash');
    expect(motivoDe(entrada({ assinatura: `ts=${TS},v1=` }))).toBe('sem_hash');
  });

  it('recusa hash adulterado, com tamanho certo ou errado', () => {
    const boa = ASSINATURA_BOA;
    const adulterada = boa.slice(0, -1) + (boa.endsWith('0') ? '1' : '0');
    expect(motivoDe(entrada({ assinatura: adulterada }))).toBe('diferente');
    expect(motivoDe(entrada({ assinatura: `ts=${TS},v1=abc123` }))).toBe('diferente');
  });

  it('o hash em MAIÚSCULAS não vale (o SDK compara o hex minúsculo, sem normalizar)', () => {
    const [ts, v1] = ASSINATURA_BOA.split(',');
    expect(
      motivoDe(
        entrada({ assinatura: `${ts},${v1!.toUpperCase().replace('V1=', 'v1=')}` }),
      ),
    ).toBe('diferente');
  });

  it('recusa quando o data.id é outro (aviso de um recurso, id de outro)', () => {
    expect(motivoDe(entrada({ idDoRecurso: '999999' }))).toBe('diferente');
  });

  it('o data.id NÃO é convertido para minúsculas', () => {
    const ass = assinarAvisoParaTeste({
      segredo: SEGREDO,
      ts: TS,
      idDoRecurso: 'AbC',
      idDaRequisicao: 'req-1',
    });
    expect(motivoDe(entrada({ assinatura: ass, idDoRecurso: 'AbC' }))).toBeUndefined();
    expect(motivoDe(entrada({ assinatura: ass, idDoRecurso: 'abc' }))).toBe('diferente');
  });

  it('recusa quando o x-request-id é outro', () => {
    expect(motivoDe(entrada({ idDaRequisicao: 'req-2' }))).toBe('diferente');
  });

  it('recusa assinatura feita com outro segredo', () => {
    const ass = assinarAvisoParaTeste({
      segredo: 'outro-segredo',
      ts: TS,
      idDoRecurso: '123456',
      idDaRequisicao: 'req-1',
    });
    expect(motivoDe(entrada({ assinatura: ass }))).toBe('diferente');
  });

  it('recusa timestamp velho ou futuro demais (300 s), mesmo com o hash certo', () => {
    const velho = TS - 301;
    const ass = assinarAvisoParaTeste({
      segredo: SEGREDO,
      ts: velho,
      idDoRecurso: '123456',
      idDaRequisicao: 'req-1',
    });
    expect(motivoDe(entrada({ assinatura: ass }))).toBe('fora_do_prazo');
    const futuro = assinarAvisoParaTeste({
      segredo: SEGREDO,
      ts: TS + 301,
      idDoRecurso: '123456',
      idDaRequisicao: 'req-1',
    });
    expect(motivoDe(entrada({ assinatura: futuro }))).toBe('fora_do_prazo');
  });

  it('300 s exatos ainda passam (a tolerância é inclusiva, como no SDK)', () => {
    const ass = assinarAvisoParaTeste({
      segredo: SEGREDO,
      ts: TS - 300,
      idDoRecurso: '123456',
      idDaRequisicao: 'req-1',
    });
    expect(motivoDe(entrada({ assinatura: ass }))).toBeUndefined();
  });

  it('sem segredo configurado, nada é aceito (fail-closed)', () => {
    expect(motivoDe(entrada({ segredo: '' }))).toBe('sem_segredo');
  });

  it('a mensagem do erro nunca diz o motivo nem repete o segredo ou a assinatura', () => {
    try {
      validarAssinaturaDoWebhook(entrada({ idDoRecurso: '999999' }));
    } catch (erro) {
      const msg = (erro as Error).message;
      expect(msg).toBe('Assinatura do webhook inválida.');
      expect(msg).not.toContain(SEGREDO);
    }
  });
});
