import { describe, expect, it } from 'vitest';
import {
  impactoPorDiaUsd,
  julgarTeste,
  linhasDaComparacao,
  observacaoValida,
  podeSerCandidato,
  resolverModelo,
  type MetricasDoModelo,
} from '../../src/domain/entities/ModelosDeIa.js';
import {
  ATUAL,
  DESCONTINUADO,
  NOVO,
  PENDENTE,
  SO_RESUMO,
  catalogoDeTeste,
  item,
  metricas,
} from '../helpers/modelosDeIa.js';

/*
 * As regras do dono para trocar o modelo (Fase B): matriz de cada bloqueio duro e de cada queda tolerável,
 * nos limites EXATOS (2,0 e 3,0 pontos; +30%; 95%).
 */
const ref = metricas();
const julgar = (c: Partial<MetricasDoModelo>, r: Partial<MetricasDoModelo> = {}) =>
  julgarTeste(metricas({ modelo: NOVO, ...c }), metricas(r));

describe('veredito: tudo igual ou melhor', () => {
  it('é aprovado quando o candidato empata com o atual', () => {
    expect(julgar({}).veredito).toBe('aprovado');
  });
  it('é aprovado quando o candidato é melhor em tudo', () => {
    const v = julgar({
      citacaoVerificada: 0.99,
      pontosCobertos: 95,
      latenciaP95Ms: 8_000,
      custoMedioUsd: 0.0005,
    });
    expect(v).toEqual({ veredito: 'aprovado', bloqueios: [], ressalvas: [] });
  });
});

describe('bloqueios duros (sem aprovação manual)', () => {
  it('violação a mais que o atual bloqueia', () => {
    const v = julgar({ violacoes: 1 }, { violacoes: 0 });
    expect(v.veredito).toBe('bloqueado');
    expect(v.bloqueios).toContain('violacao_acima_da_referencia');
  });
  it('a mesma quantidade de violações do atual não bloqueia', () => {
    expect(julgar({ violacoes: 2 }, { violacoes: 2 }).veredito).toBe('aprovado');
  });
  it('citação verificada em 94,9% bloqueia', () => {
    const v = julgar({ citacaoVerificada: 0.949 });
    expect(v.bloqueios).toContain('citacao_abaixo_do_minimo');
  });
  it('citação verificada em 95% passa, mas com ressalva se for menor que a do atual', () => {
    const v = julgar({ citacaoVerificada: 0.95 });
    expect(v.bloqueios).toEqual([]);
    expect(v.ressalvas).toContain('citacao_menor');
    expect(v.veredito).toBe('aprovado_com_ressalva');
  });
  it('citação verificada em 95% passa limpa quando o atual também está em 95%', () => {
    expect(
      julgar({ citacaoVerificada: 0.95 }, { citacaoVerificada: 0.95 }).veredito,
    ).toBe('aprovado');
  });
  it('sem citação para medir bloqueia (não se publica o que não se mediu)', () => {
    expect(julgar({ citacaoVerificada: null }).bloqueios).toContain('citacao_sem_dado');
  });
  it('falhas de formato a mais de 2,0 pontos bloqueiam; exatamente 2,0 não', () => {
    // 50 chamadas: 1 falha = 2,0 pontos percentuais; 2 falhas = 4,0.
    expect(julgar({ falhasDeFormato: 1 }).bloqueios).not.toContain(
      'falhas_de_formato_acima',
    );
    expect(julgar({ falhasDeFormato: 1 }).ressalvas).toContain(
      'falhas_de_formato_maiores',
    );
    expect(julgar({ falhasDeFormato: 2 }).bloqueios).toContain('falhas_de_formato_acima');
  });
  it('mede o formato sobre o atual, não sobre zero', () => {
    // atual com 2 falhas (4%), candidato com 3 (6%): +2,0 pontos, tolerável.
    const v = julgar({ falhasDeFormato: 3 }, { falhasDeFormato: 2 });
    expect(v.bloqueios).toEqual([]);
  });
  it('teste interrompido, ou sem nenhuma chamada, é incompleto e bloqueia', () => {
    expect(julgar({ interrompido: true }).bloqueios).toContain('teste_incompleto');
    expect(julgar({}, { interrompido: true }).bloqueios).toContain('teste_incompleto');
    expect(julgar({ chamadas: 0 }).bloqueios).toContain('teste_incompleto');
  });
  it('erro do provedor em qualquer dos dois lados bloqueia', () => {
    expect(julgar({ chamadasComErro: 1 }).bloqueios).toContain('erro_do_provedor');
    expect(julgar({}, { chamadasComErro: 1 }).bloqueios).toContain('erro_do_provedor');
  });
  it('sem pontos para medir ou sem latência bloqueia', () => {
    expect(julgar({ pontosTotais: 0, pontosCobertos: 0 }).bloqueios).toContain(
      'pontos_sem_dado',
    );
    expect(julgar({ latenciaP95Ms: null }).bloqueios).toContain('latencia_sem_dado');
  });
});

describe('queda tolerável com aprovação', () => {
  it('pontos: queda de 3,0 pontos é ressalva; 3,1 bloqueia', () => {
    const tres = julgar({ pontosCobertos: 87 });
    expect(tres.veredito).toBe('aprovado_com_ressalva');
    expect(tres.ressalvas).toContain('pontos_em_queda');
    const maisQueTres = julgar(
      { pontosCobertos: 869, pontosTotais: 1000 },
      { pontosCobertos: 900, pontosTotais: 1000 },
    );
    expect(maisQueTres.bloqueios).toContain('pontos_queda_acima_do_limite');
  });
  it('pontos: queda de 2,0 pontos é ressalva', () => {
    expect(julgar({ pontosCobertos: 88 }).ressalvas).toContain('pontos_em_queda');
  });
  it('latência p95: +30% exato é ressalva; acima disso bloqueia', () => {
    const exato = julgar({ latenciaP95Ms: 13_000 });
    expect(exato.bloqueios).toEqual([]);
    expect(exato.ressalvas).toContain('latencia_maior');
    expect(julgar({ latenciaP95Ms: 13_001 }).bloqueios).toContain(
      'latencia_acima_do_limite',
    );
  });
  it('custo médio maior, de qualquer valor, é ressalva e nunca bloqueia', () => {
    const v = julgar({ custoMedioUsd: 0.5 });
    expect(v.bloqueios).toEqual([]);
    expect(v.ressalvas).toContain('custo_maior');
    expect(v.veredito).toBe('aprovado_com_ressalva');
  });
  it('custo não medido exige aprovação, não bloqueia', () => {
    const v = julgar({ custoMedioUsd: null });
    expect(v.ressalvas).toContain('custo_nao_medido');
    expect(v.veredito).toBe('aprovado_com_ressalva');
  });
  it('um bloqueio vence qualquer ressalva', () => {
    const v = julgar({ violacoes: 1, custoMedioUsd: 0.5, pontosCobertos: 88 });
    expect(v.veredito).toBe('bloqueado');
    expect(v.ressalvas.length).toBeGreaterThan(0);
  });
});

describe('impacto do custo por dia', () => {
  it('é a diferença do custo médio vezes as análises por dia dos últimos 30 dias', () => {
    const c = metricas({ custoMedioUsd: 0.003 });
    // (0,003 − 0,001) × 3.000 análises / 30 dias = US$ 0,20 por dia.
    expect(impactoPorDiaUsd(c, ref, 3_000)).toBeCloseTo(0.2, 10);
  });
  it('não estima sem custo medido', () => {
    expect(impactoPorDiaUsd(metricas({ custoMedioUsd: null }), ref, 3_000)).toBeNull();
  });
});

describe('comparação para a tela', () => {
  it('traz a diferença e quem é melhor em cada medida', () => {
    const linhas = linhasDaComparacao(
      metricas({ latenciaP95Ms: 12_000, pontosCobertos: 92 }),
      ref,
    );
    const por = (k: string) => linhas.find((l) => l.chave === k);
    expect(por('latenciaP95')?.diferenca).toBe(2_000);
    expect(por('latenciaP95')?.melhor).toBe(false);
    expect(por('pontos')?.melhor).toBe(true);
    expect(por('violacoes')?.melhor).toBeNull();
  });
});

describe('modelo efetivo', () => {
  const catalogo = catalogoDeTeste();
  it('sem painel, vale o ambiente', () => {
    expect(resolverModelo('ato', null, ATUAL, catalogo)).toEqual({
      modelo: ATUAL,
      origem: 'ambiente',
      painelInvalido: false,
    });
  });
  it('painel válido vence o ambiente', () => {
    expect(resolverModelo('ato', NOVO, ATUAL, catalogo).origem).toBe('painel');
  });
  it('modelo do painel fora da lista, descontinuado, pendente ou de outra função cai no ambiente, com aviso', () => {
    for (const id of ['fabrica-z/inexistente', DESCONTINUADO, PENDENTE, SO_RESUMO]) {
      const r = resolverModelo('ato', id, ATUAL, catalogo);
      expect(r).toEqual({ modelo: ATUAL, origem: 'ambiente', painelInvalido: true });
    }
  });
  it('só item confirmado, ativo e da função é candidato', () => {
    expect(podeSerCandidato(catalogo.buscar(NOVO), 'peca')).toBe(true);
    expect(podeSerCandidato(catalogo.buscar(SO_RESUMO), 'peca')).toBe(false);
    expect(podeSerCandidato(catalogo.buscar(PENDENTE), 'ato')).toBe(false);
    expect(podeSerCandidato(undefined, 'ato')).toBe(false);
    expect(podeSerCandidato(item('x/y', { status: 'descontinuado' }), 'ato')).toBe(false);
  });
});

describe('observação curta da aprovação', () => {
  it.each(['Aceito o custo maior', 'Teste de 2 dias', ''])('aceita "%s"', (t) => {
    expect(observacaoValida(t)).toBe(true);
  });
  it.each([
    ['e-mail', 'fale com joao@exemplo.test'],
    ['CNJ', '0000000-00.2099.8.09.0001'],
    ['telefone', '62 99999 0000'],
    ['link', 'ver https://x.test/a'],
    ['longa', 'a'.repeat(81)],
    ['marcação', '<b>oi</b>'],
  ])('recusa %s', (_n, t) => {
    expect(observacaoValida(t)).toBe(false);
  });
});
