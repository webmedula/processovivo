import { describe, expect, it } from 'vitest';
import {
  CATALOGO_DE_MODELOS,
  MODELOS_PERMITIDOS,
  validarCatalogo,
} from '../../src/infrastructure/ia/modelos-permitidos.js';
import { podeSerCandidato } from '../../src/domain/entities/ModelosDeIa.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { item } from '../helpers/modelosDeIa.js';

/*
 * A lista permitida mora no código e é validada no arranque (Zod). Regra do dono: item sem ZDR
 * confirmado ou sem preço nunca é candidato — e a lista nunca é editável pela tela.
 */
const bruto = (sobre: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...item('a/b'),
  ...sobre,
});

describe('a lista permitida de verdade', () => {
  it('traz o modelo de produção, que é o padrão do código', () => {
    const padrao = carregarConfig({} as NodeJS.ProcessEnv).ia.modelo;
    expect(CATALOGO_DE_MODELOS.buscar(padrao)).toBeDefined();
  });

  it('todo item CONFIRMADO tem ZDR com data e fonte, preço de entrada e saída e janela de contexto', () => {
    for (const i of MODELOS_PERMITIDOS.filter((m) => m.confirmacao === 'confirmada')) {
      expect(i.zdrConfirmadoEm, i.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(i.zdrFonte, i.id).toBeTruthy();
      expect(i.precoEntradaPorMTokens, i.id).toBeGreaterThan(0);
      expect(i.precoSaidaPorMTokens, i.id).toBeGreaterThan(0);
      expect(i.janelaContexto, i.id).toBeGreaterThan(0);
    }
  });

  it('nenhum item sem ZDR ou sem preço pode ser candidato a troca', () => {
    for (const i of MODELOS_PERMITIDOS) {
      const temTudo =
        i.zdrConfirmadoEm !== null &&
        i.zdrFonte !== null &&
        i.precoEntradaPorMTokens !== null &&
        i.precoSaidaPorMTokens !== null;
      for (const f of i.funcoesPermitidas) {
        expect(podeSerCandidato(i, f) && !temTudo, `${i.id} em ${f}`).toBe(false);
      }
    }
  });

  it('nenhum id é apelido (~) nem variante (:), e nenhum se repete', () => {
    const ids = MODELOS_PERMITIDOS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toMatch(/[~:]/);
  });
});

describe('validação no arranque', () => {
  it('aceita um item completo', () => {
    expect(validarCatalogo([bruto()])).toHaveLength(1);
  });

  it.each([
    ['sem data de ZDR', { zdrConfirmadoEm: null }],
    ['sem fonte do ZDR', { zdrFonte: null }],
    ['sem preço de entrada', { precoEntradaPorMTokens: null }],
    ['sem preço de saída', { precoSaidaPorMTokens: null }],
    ['com preço zero', { precoEntradaPorMTokens: 0 }],
    ['sem janela de contexto', { janelaContexto: null }],
    ['com data malformada', { zdrConfirmadoEm: '20/10/2026' }],
  ])('recusa item CONFIRMADO %s', (_n, sobre) => {
    expect(() => validarCatalogo([bruto(sobre)])).toThrow();
  });

  it.each([
    ['apelido do roteador', '~fabrica/modelo-latest'],
    ['variante', 'fabrica/modelo:free'],
    ['sem fabricante', 'modelo'],
  ])('recusa id que é %s', (_n, id) => {
    expect(() => validarCatalogo([bruto({ id })])).toThrow();
  });

  it('recusa campo desconhecido, lista vazia, id repetido e função inexistente', () => {
    expect(() => validarCatalogo([bruto({ extra: 1 })])).toThrow();
    expect(() => validarCatalogo([])).toThrow();
    expect(() => validarCatalogo([bruto(), bruto()])).toThrow();
    expect(() =>
      validarCatalogo([bruto({ funcoesPermitidas: ['inventada'] })]),
    ).toThrow();
  });

  it('item PENDENTE precisa vir sem preço e sem ZDR (não se finge confirmação)', () => {
    const pendente = bruto({
      confirmacao: 'pendente',
      zdrConfirmadoEm: null,
      zdrFonte: null,
      precoEntradaPorMTokens: null,
      precoSaidaPorMTokens: null,
    });
    expect(validarCatalogo([pendente])).toHaveLength(1);
    expect(() => validarCatalogo([{ ...pendente, precoEntradaPorMTokens: 1 }])).toThrow();
  });
});
