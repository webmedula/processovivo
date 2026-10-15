import { describe, expect, it } from 'vitest';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import { prepararEntradaDoResumo } from '../../src/application/politicas/entradaDoResumo.js';
import { selecionarAtosParaResumo } from '../../src/application/politicas/selecionarAtosParaResumo.js';
import {
  normalizarIdDoAto,
  verificarResumo,
} from '../../src/application/politicas/verificarResumo.js';
import {
  ATOS_DO_RESUMO,
  INTIMACAO,
  respostaDoResumo,
  TRECHO_DA_INTIMACAO,
  TRECHO_DO_DESPACHO,
} from '../helpers/resumoIa.js';

const atos = prepararEntradaDoResumo(
  selecionarAtosParaResumo(ATOS_DO_RESUMO, new Set([chaveDaMovimentacao(INTIMACAO)])),
).atos;

describe('verificarResumo', () => {
  it('aceita a resposta boa e liga cada item à chave do ato', () => {
    const r = verificarResumo(respostaDoResumo(), atos);
    expect(r.estado).toBe('verificado');
    if (r.estado !== 'verificado') return;
    expect(r.situacao).toHaveLength(2);
    expect(r.situacao[0]?.chaveDoAto).toBe(chaveDaMovimentacao(INTIMACAO));
    expect(r.pendencias).toHaveLength(1);
    expect(r.descartes).toMatchObject({ referencia: 0, citacao: 0, numeroInventado: 0 });
  });

  it('descarta só o item cujo identificador não foi enviado', () => {
    const r = verificarResumo(
      respostaDoResumo({
        situacao: [
          { texto: 'Algo no ato nove.', ato: 'A9', trecho: TRECHO_DO_DESPACHO },
          {
            texto: 'O juízo mandou oficiar o banco.',
            ato: 'A2',
            trecho: TRECHO_DO_DESPACHO,
          },
        ],
      }),
      atos,
    );
    expect(r.estado).toBe('verificado');
    expect(r.descartes.referencia).toBe(1);
  });

  it('descarta o item cujo trecho existe, mas em OUTRO ato', () => {
    const r = verificarResumo(
      respostaDoResumo({
        situacao: [
          {
            texto: 'O juízo mandou oficiar o banco.',
            ato: 'A1',
            trecho: TRECHO_DO_DESPACHO,
          },
          {
            texto: 'A parte foi intimada ao laudo.',
            ato: 'A1',
            trecho: TRECHO_DA_INTIMACAO,
          },
        ],
      }),
      atos,
    );
    expect(r.descartes.citacao).toBe(1);
    if (r.estado === 'verificado') expect(r.situacao).toHaveLength(1);
  });

  it('descarta número ou data que o ato citado não contém', () => {
    const r = verificarResumo(
      respostaDoResumo({
        situacao: [
          {
            texto: 'A parte tem 30 dias para se manifestar sobre o laudo.',
            ato: 'A1',
            trecho: TRECHO_DA_INTIMACAO,
          },
          {
            texto: 'A parte foi intimada sobre o laudo em 12/01/2027.',
            ato: 'A1',
            trecho: TRECHO_DA_INTIMACAO,
          },
          {
            texto: 'O juízo mandou oficiar o banco.',
            ato: 'A2',
            trecho: TRECHO_DO_DESPACHO,
          },
        ],
      }),
      atos,
    );
    expect(r.descartes.numeroInventado).toBe(2);
  });

  it('aceita número que o ato escreve (quinze dias úteis)', () => {
    const r = verificarResumo(
      respostaDoResumo({
        situacao: [
          {
            texto: 'A parte tem 15 dias úteis para falar do laudo.',
            ato: 'A1',
            trecho: TRECHO_DA_INTIMACAO,
          },
        ],
      }),
      atos,
    );
    expect(r.descartes.numeroInventado).toBe(0);
    expect(r.estado).toBe('verificado');
  });

  it('descarta texto que só repete o trecho', () => {
    const r = verificarResumo(
      respostaDoResumo({
        pendencias: [
          { texto: TRECHO_DA_INTIMACAO, ato: 'A1', trecho: TRECHO_DA_INTIMACAO },
        ],
      }),
      atos,
    );
    expect(r.descartes.copiaDoTrecho).toBe(1);
    if (r.estado === 'verificado') expect(r.pendencias).toHaveLength(0);
  });

  it('expressão proibida derruba o resultado inteiro', () => {
    const r = verificarResumo(
      respostaDoResumo({
        situacao: [
          {
            texto: 'O juízo sugeriu recorrer da decisão.',
            ato: 'A1',
            trecho: TRECHO_DA_INTIMACAO,
          },
          {
            texto: 'O juízo mandou oficiar o banco.',
            ato: 'A2',
            trecho: TRECHO_DO_DESPACHO,
          },
        ],
      }),
      atos,
    );
    expect(r.estado).toBe('nao_verificado');
    if (r.estado === 'nao_verificado') expect(r.motivo).toBe('expressao_proibida');
  });

  it('sem nenhum item de situação sobrevivente: não verificado', () => {
    const r = verificarResumo(
      respostaDoResumo({
        situacao: [{ texto: 'Algo.', ato: 'A9', trecho: 'qualquer' }],
      }),
      atos,
    );
    expect(r.estado).toBe('nao_verificado');
    if (r.estado === 'nao_verificado') expect(r.motivo).toBe('sem_item_verificado');
  });

  it('aceita o identificador com colchetes e em minúsculas', () => {
    expect(normalizarIdDoAto('[A3]')).toBe('A3');
    expect(normalizarIdDoAto(' a12 ')).toBe('A12');
    expect(normalizarIdDoAto('ato 3')).toBeUndefined();
    const r = verificarResumo(
      respostaDoResumo({
        situacao: [
          {
            texto: 'O juízo mandou oficiar o banco.',
            ato: '[a2]',
            trecho: TRECHO_DO_DESPACHO,
          },
        ],
      }),
      atos,
    );
    expect(r.estado).toBe('verificado');
  });

  it('respeita os limites e não repete o mesmo item', () => {
    const item = {
      texto: 'O juízo mandou oficiar o banco informado.',
      ato: 'A2',
      trecho: TRECHO_DO_DESPACHO,
    };
    const r = verificarResumo(
      respostaDoResumo({ situacao: [item, item, item], pendencias: [] }),
      atos,
    );
    if (r.estado === 'verificado') expect(r.situacao).toHaveLength(1);
    const grande = verificarResumo(
      respostaDoResumo({ situacao: [{ ...item, texto: 'x'.repeat(400) }, item] }),
      atos,
    );
    expect(grande.descartes.forma).toBe(1);
  });

  it('ponto de atenção fora do vocabulário é descartado', () => {
    const r = verificarResumo(
      respostaDoResumo({ pontos_de_atencao: ['inventado' as never] }),
      atos,
    );
    expect(r.descartes.forma).toBe(1);
    if (r.estado === 'verificado') expect(r.pontosDeAtencao).toEqual([]);
  });
});
