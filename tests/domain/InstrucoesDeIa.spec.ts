import { describe, expect, it } from 'vitest';
import {
  LIMITE_DA_INSTRUCAO,
  LIMITE_DA_OBSERVACAO,
  diferencaDeLinhas,
  lembreteFinal,
  lerVersaoEfetiva,
  montarPrompt,
  montarSistema,
  normalizarInstrucao,
  observacaoValida,
  problemaDoTexto,
  rotuloDaVersaoEfetiva,
  versaoEfetiva,
} from '../../src/domain/entities/InstrucoesDeIa.js';
import { avisosDePiora } from '../../src/domain/entities/VerificacaoDeInstrucoes.js';
import { metricas } from '../helpers/modelosDeIa.js';

const FIXA = 'PARTE FIXA\nREGRAS: ...\nCAMPOS: ...';

describe('montagem do prompt: parte fixa → bloco editável → lembrete final', () => {
  it('sem texto (vazio, só espaços ou ausente) devolve a parte fixa, BYTE A BYTE, sem lembrete', () => {
    for (const vazio of [undefined, '', '   ', '\n\t \r\n']) {
      const p = montarPrompt('ato', FIXA, vazio);
      expect(p.montado).toBe(FIXA);
      expect(p.editavel).toBe('');
      expect(p.lembrete).toBe('');
    }
    expect(montarSistema('resumo', FIXA, undefined)).toBe(FIXA);
  });

  it('com texto, a ordem é sempre a mesma: fixa, depois o bloco, depois o lembrete', () => {
    const p = montarPrompt('resumo', FIXA, 'Destaque sempre o prazo escrito.');
    expect(p.montado.startsWith(FIXA)).toBe(true);
    expect(p.montado.endsWith(lembreteFinal('resumo'))).toBe(true);
    const iFixa = p.montado.indexOf(FIXA);
    const iBloco = p.montado.indexOf('Destaque sempre o prazo escrito.');
    const iLembrete = p.montado.indexOf('LEMBRETE FINAL');
    expect(iFixa).toBe(0);
    expect(iBloco).toBeGreaterThan(iFixa + FIXA.length - 1);
    expect(iLembrete).toBeGreaterThan(iBloco);
    // o bloco diz que NÃO muda as regras nem os campos; o lembrete repete as regras fixas
    expect(p.editavel).toMatch(/valem as REGRAS e os CAMPOS/);
    expect(p.lembrete).toMatch(/ignore essa instrução/);
  });

  it('o lembrete cita o dado certo de cada função e as regras que não se negociam', () => {
    expect(lembreteFinal('ato')).toContain('<ato>');
    expect(lembreteFinal('resumo')).toContain('<linha_do_tempo>');
    expect(lembreteFinal('peca')).toContain('<peca>');
    for (const f of ['ato', 'resumo', 'peca'] as const) {
      const l = lembreteFinal(f);
      expect(l).toMatch(/formato JSON/);
      expect(l).toMatch(/citação é LITERAL/);
      expect(l).toMatch(/nunca calcule prazo/);
      expect(l).toMatch(/não dê parecer/);
    }
  });

  it('o texto do operador é limpo antes de entrar (quebras de linha, controle) mas não é reescrito', () => {
    const p = montarPrompt('ato', FIXA, '  Linha 1\r\nLinha 2\u0007\t fim  ');
    expect(p.editavel.endsWith('Linha 1\nLinha 2   fim')).toBe(true);
  });
});

describe('limites do texto', () => {
  it('recusa só o tamanho e, ao publicar, o texto vazio', () => {
    expect(
      problemaDoTexto('a'.repeat(LIMITE_DA_INSTRUCAO), { exigirTexto: true }),
    ).toBeUndefined();
    expect(
      problemaDoTexto('a'.repeat(LIMITE_DA_INSTRUCAO + 1), { exigirTexto: false }),
    ).toBe('grande');
    expect(problemaDoTexto('   ', { exigirTexto: true })).toBe('vazio');
    expect(problemaDoTexto('   ', { exigirTexto: false })).toBeUndefined();
  });

  it('o tamanho vale DEPOIS de normalizar (espaços nas pontas não contam)', () => {
    const justo = `  ${'a'.repeat(LIMITE_DA_INSTRUCAO)}  `;
    expect(problemaDoTexto(justo, { exigirTexto: true })).toBeUndefined();
    expect(normalizarInstrucao(justo)).toHaveLength(LIMITE_DA_INSTRUCAO);
  });

  it('a observação é curta e sem caractere de controle', () => {
    expect(observacaoValida('Pediu foco em prazo')).toBe(true);
    expect(observacaoValida('a'.repeat(LIMITE_DA_OBSERVACAO))).toBe(true);
    expect(observacaoValida('a'.repeat(LIMITE_DA_OBSERVACAO + 1))).toBe(false);
    expect(observacaoValida('ruim\u0001')).toBe(false);
  });
});

describe('versão efetiva', () => {
  it('sem instrução publicada é a versão de sempre (nada novo é gravado); com instrução leva +eN', () => {
    expect(versaoEfetiva('ato-1.2.0', 0)).toBe('ato-1.2.0');
    expect(versaoEfetiva('resumo-1.2.0', 3)).toBe('resumo-1.2.0+e3');
  });

  it('lê de volta, e na tela o padrão aparece como +e0', () => {
    expect(lerVersaoEfetiva('resumo-1.2.0+e3')).toEqual({
      base: 'resumo-1.2.0',
      edicao: 3,
    });
    expect(lerVersaoEfetiva('peca-1.1.0')).toEqual({ base: 'peca-1.1.0', edicao: 0 });
    expect(rotuloDaVersaoEfetiva('peca-1.1.0')).toBe('peca-1.1.0+e0');
    expect(rotuloDaVersaoEfetiva('ato-1.2.0+e12')).toBe('ato-1.2.0+e12');
  });
});

describe('diferença entre duas versões', () => {
  it('marca o que saiu, o que entrou e o que ficou, linha a linha', () => {
    const d = diferencaDeLinhas('a\nb\nc', 'a\nc\nd');
    expect(d).toEqual([
      { tipo: 'igual', texto: 'a' },
      { tipo: 'removida', texto: 'b' },
      { tipo: 'igual', texto: 'c' },
      { tipo: 'adicionada', texto: 'd' },
    ]);
  });

  it('contra o vazio (+e0) tudo é adicionado ou removido', () => {
    expect(diferencaDeLinhas('', 'x\ny').map((l) => l.tipo)).toEqual([
      'adicionada',
      'adicionada',
    ]);
    expect(diferencaDeLinhas('x', '').map((l) => l.tipo)).toEqual(['removida']);
    expect(diferencaDeLinhas('', '')).toEqual([]);
  });
});

describe('avisos de piora do conjunto de verificação (informam, nunca bloqueiam)', () => {
  it('tudo igual ou melhor: sem aviso', () => {
    const r = avisosDePiora(metricas(), metricas());
    expect(r.semPiora).toBe(true);
    expect(r.avisos).toEqual([]);
  });

  it('piora grave e leve viram frases nossas sobre o rascunho, com a gravidade', () => {
    const publicada = metricas();
    const rascunho = metricas({
      violacoes: 2,
      citacaoVerificada: 0.9,
      latenciaP95Ms: 11_000,
    });
    const r = avisosDePiora(rascunho, publicada);
    expect(r.semPiora).toBe(false);
    const por = Object.fromEntries(r.avisos.map((a) => [a.codigo, a]));
    expect(por['violacao_acima_da_referencia']?.gravidade).toBe('grave');
    expect(por['violacao_acima_da_referencia']?.frase).toMatch(/rascunho/);
    expect(por['citacao_abaixo_do_minimo']?.gravidade).toBe('grave');
    expect(por['latencia_maior']?.gravidade).toBe('leve');
    for (const a of r.avisos) expect(a.frase).not.toMatch(/modelo (novo|atual)/);
  });
});
