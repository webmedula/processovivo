import { describe, expect, it } from 'vitest';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import {
  ORCAMENTO_DO_RESUMO,
  selecionarAtosParaResumo,
} from '../../src/application/politicas/selecionarAtosParaResumo.js';
import {
  ATOS_DO_RESUMO,
  CONCLUSOS,
  DECISAO_SEM_TEOR,
  DESPACHO,
  INTIMACAO,
  JUNTADA,
  SENTENCA,
} from '../helpers/resumoIa.js';

const TEXTO_LONGO =
  'Determino que a secretaria certifique o decurso do prazo e intime as partes. '.repeat(
    60,
  );

/** `n` atos com texto utilizável, um por dia, o mais recente primeiro na ordem de data. */
function atosComTexto(n: number, tamanho = TEXTO_LONGO): Movimentacao[] {
  return Array.from({ length: n }, (_, i) => ({
    data: new Date(Date.UTC(2026, 8, 30 - i, 12)),
    titulo: `Despacho ${i + 1}`,
    idExterno: `djen:${100 + i}`,
    conteudo: `${tamanho} ${i}`,
  }));
}

describe('selecionarAtosParaResumo', () => {
  it('identifica por A1, A2… do mais recente ao mais antigo, e classifica cada ato', () => {
    const s = selecionarAtosParaResumo(
      ATOS_DO_RESUMO,
      new Set([chaveDaMovimentacao(INTIMACAO)]),
    );
    expect(s.atos.map((a) => a.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
    expect(s.atos.map((a) => [a.ato.titulo, a.motivo])).toEqual([
      ['Intimação', 'providencia'],
      ['Despacho', 'recente'],
      ['Decisão', 'titulo'], // teor indisponível: só o título
      ['Sentença', 'recente'],
      ['Juntada de petição', 'titulo'], // sem texto
      ['Conclusos para despacho', 'titulo'],
    ]);
    expect(s.comTexto).toBe(3);
    expect(s.soTitulo).toBe(3);
    expect(s.totalDeAtos).toBe(6);
    expect(s.foraDoResumo).toBe(0);
  });

  it('ato com teor indisponível nunca vai com texto', () => {
    const s = selecionarAtosParaResumo([DECISAO_SEM_TEOR, DESPACHO], new Set());
    const decisao = s.atos.find((a) => a.ato.titulo === 'Decisão');
    expect(decisao?.limiteDeCaracteres).toBe(0);
  });

  it('providência em aberto tem mais caracteres que ato recente e vai mesmo sendo antiga', () => {
    const antigaMasPendente: Movimentacao = {
      data: new Date('2026-05-01T12:00:00.000Z'),
      titulo: 'Intimação antiga',
      idExterno: 'djen:50',
      conteudo: TEXTO_LONGO,
    };
    const s = selecionarAtosParaResumo(
      [...atosComTexto(15), antigaMasPendente],
      new Set([chaveDaMovimentacao(antigaMasPendente)]),
    );
    const escolhida = s.atos.find((a) => a.ato.titulo === 'Intimação antiga');
    expect(escolhida?.motivo).toBe('providencia');
    expect(escolhida?.limiteDeCaracteres).toBe(ORCAMENTO_DO_RESUMO.caracteresPorPendente);
  });

  it('só os N mais recentes com texto vão com texto; o resto vira título e conta como fora', () => {
    const s = selecionarAtosParaResumo(atosComTexto(60), new Set());
    expect(s.comTexto).toBe(ORCAMENTO_DO_RESUMO.recentesMax);
    expect(s.soTitulo).toBe(ORCAMENTO_DO_RESUMO.titulosMax);
    expect(s.atos.length).toBe(
      ORCAMENTO_DO_RESUMO.recentesMax + ORCAMENTO_DO_RESUMO.titulosMax,
    );
    expect(s.foraDoResumo).toBe(60 - s.atos.length);
    expect(s.foraDoResumo).toBeGreaterThan(0);
    // O mais recente é o A1, e é com texto.
    expect(s.atos[0]).toMatchObject({ id: 'A1', motivo: 'recente' });
  });

  it('no máximo 5 providências com texto; as demais entram só pelo título', () => {
    const pendentes = atosComTexto(8);
    const s = selecionarAtosParaResumo(
      pendentes,
      new Set(pendentes.map(chaveDaMovimentacao)),
    );
    expect(s.atos.filter((a) => a.motivo === 'providencia')).toHaveLength(
      ORCAMENTO_DO_RESUMO.pendentesMax,
    );
  });

  it('respeita o teto de caracteres: corta os recentes mais antigos, nunca a providência', () => {
    const enormes = atosComTexto(30, 'x'.repeat(5000));
    const pendente = enormes[0] as Movimentacao;
    const s = selecionarAtosParaResumo(enormes, new Set([chaveDaMovimentacao(pendente)]));
    const soma = s.atos.reduce(
      (t, a) => t + Math.min(a.limiteDeCaracteres, (a.ato.conteudo ?? '').length),
      0,
    );
    expect(soma).toBeLessThanOrEqual(ORCAMENTO_DO_RESUMO.totalDeCaracteres);
    expect(s.atos.find((a) => a.chave === chaveDaMovimentacao(pendente))?.motivo).toBe(
      'providencia',
    );
  });

  it('providência SEM texto utilizável entra na linha do tempo antes dos demais títulos', () => {
    const pendenteSemTexto: Movimentacao = {
      data: new Date('2026-01-01T12:00:00.000Z'),
      titulo: 'Intimação sem teor',
      idExterno: 'djen:60',
      teorIndisponivel: true,
    };
    const s = selecionarAtosParaResumo(
      [...atosComTexto(80), pendenteSemTexto],
      new Set([chaveDaMovimentacao(pendenteSemTexto)]),
    );
    expect(s.atos.some((a) => a.ato.titulo === 'Intimação sem teor')).toBe(true);
  });

  it('processo sem nenhum ato com texto utilizável: comTexto 0', () => {
    const s = selecionarAtosParaResumo([JUNTADA, CONCLUSOS, DECISAO_SEM_TEOR], new Set());
    expect(s.comTexto).toBe(0);
    expect(s.soTitulo).toBe(3);
  });

  it('dois atos de mesma chave entram uma vez só', () => {
    const s = selecionarAtosParaResumo([SENTENCA, { ...SENTENCA }], new Set());
    expect(s.atos).toHaveLength(1);
  });

  it('é determinística: mesma entrada, mesma seleção', () => {
    const a = selecionarAtosParaResumo(ATOS_DO_RESUMO, new Set());
    const b = selecionarAtosParaResumo(ATOS_DO_RESUMO, new Set());
    expect(a.atos.map((x) => [x.id, x.chave])).toEqual(
      b.atos.map((x) => [x.id, x.chave]),
    );
  });
});
