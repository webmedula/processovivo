import { describe, expect, it } from 'vitest';
import { motivoSemVerificacao } from '../../src/domain/entities/motivoSemVerificacao.js';

describe('motivoSemVerificacao', () => {
  it('processo recém-acompanhado, sem sucesso nem falha, aguarda a primeira verificação', () => {
    expect(motivoSemVerificacao(undefined, undefined)).toBe('aguardando_primeira');
  });

  it('todas as fontes responderam "não tenho" vira não encontrado', () => {
    expect(
      motivoSemVerificacao('PROCESSO_NAO_ENCONTRADO: processo não encontrado', undefined),
    ).toBe('nao_encontrado');
  });

  it('rede, tempo esgotado, resposta inválida e bloqueio são fontes indisponíveis', () => {
    for (const codigo of [
      'TODAS_AS_FONTES_FALHARAM',
      'PROVIDER_INDISPONIVEL',
      'RESPOSTA_INVALIDA',
      'MNI_BLOQUEADO',
    ]) {
      expect(motivoSemVerificacao(`${codigo}: qualquer coisa`, new Date())).toBe(
        'fontes_indisponiveis',
      );
    }
  });

  it('decide pelo CÓDIGO do começo, nunca por palavra solta da mensagem', () => {
    // A mensagem cita "não encontrado", mas o código é outro: sem evidência, é "outro".
    expect(motivoSemVerificacao('Erro qualquer: recurso não encontrado', undefined)).toBe(
      'outro',
    );
    expect(motivoSemVerificacao('fetch failed PROVIDER_INDISPONIVEL', undefined)).toBe(
      'outro',
    );
    expect(motivoSemVerificacao('SESSAO_INVALIDA: x', new Date())).toBe('outro');
  });
});
