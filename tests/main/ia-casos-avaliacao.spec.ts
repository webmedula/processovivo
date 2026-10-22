import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepararEntrada } from '../../src/application/politicas/entradaDoModelo.js';
import {
  CATEGORIAS_DE_CASO,
  CasosDeAvaliacaoInvalidosError,
  lerCasosDeAvaliacao,
  paraCasoDaSonda,
} from '../../src/main/sonda/casosDeAvaliacao.js';

const JSON_DOS_CASOS = readFileSync(
  resolve(import.meta.dirname, '../fixtures/ia-avaliacao/casos.json'),
  'utf8',
);
const casos = lerCasosDeAvaliacao(JSON_DOS_CASOS);

describe('conjunto de avaliação da análise por IA (v0.52.0)', () => {
  it('tem 48 casos, ids únicos, e toda categoria combinada aparece', () => {
    expect(casos).toHaveLength(48);
    expect(new Set(casos.map((c) => c.id)).size).toBe(48);
    for (const cat of CATEGORIAS_DE_CASO) {
      expect(
        casos.some((c) => c.categoria === cat),
        cat,
      ).toBe(true);
    }
  });

  it('"esperado_sem_chamada" bate EXATAMENTE com o que o produto decide (texto insuficiente)', () => {
    for (const c of casos) {
      const caso = paraCasoDaSonda(c);
      const e = prepararEntrada(
        {
          data: caso.data,
          titulo: caso.titulo,
          conteudo: caso.texto,
          ...(caso.tipoComunicacao ? { tipoComunicacao: caso.tipoComunicacao } : {}),
        },
        { classe: c.classe },
        { pessoas: caso.pessoas },
      );
      expect(!e.suficiente, c.id).toBe(c.esperado_sem_chamada === true);
    }
  });

  it('todo caso que chama o modelo traz o que cobrar ou o que proibir, e cita algo verificável', () => {
    for (const c of casos.filter((x) => x.esperado_sem_chamada !== true)) {
      expect(c.pontos_obrigatorios.length > 0 || c.armadilha !== undefined, c.id).toBe(
        true,
      );
    }
  });

  it('é 100% sintético: nenhum padrão de dado real (CPF, CNPJ, e-mail, telefone, OAB, CNJ real)', () => {
    for (const c of casos) {
      const tudo = JSON.stringify(c);
      expect(tudo, c.id).not.toMatch(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/);
      expect(tudo, c.id).not.toMatch(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/);
      expect(tudo, c.id).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(tudo, c.id).not.toMatch(/\(?\b\d{2}\)?\s?9?\d{4}-\d{4}\b/);
      // OAB só na faixa 9xxxx, que não é de ninguém.
      for (const m of tudo.matchAll(/OAB[\s/-]*[A-Z]{0,2}[\s/-]*(\d+)/gi)) {
        expect(m[1], c.id).toMatch(/^9\d{4}$/);
      }
      // Todo número CNJ que aparece é do tribunal inexistente de 2099 (ano e comarca de mentira).
      for (const n of tudo.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g) ?? []) {
        expect(n, c.id).toMatch(/^\d{7}-00\.2099\.8\.09\.0001$/);
      }
    }
  });

  it('recusa conjunto malformado citando o índice do caso, nunca o texto', () => {
    expect(() => lerCasosDeAvaliacao('não é json')).toThrow(
      CasosDeAvaliacaoInvalidosError,
    );
    expect(() => lerCasosDeAvaliacao('{}')).toThrow(/esperado array/);
    const quebrado = JSON.parse(JSON_DOS_CASOS) as Array<Record<string, unknown>>;
    const primeiro = quebrado[0];
    if (!primeiro) throw new Error('sem caso');
    primeiro['texto'] = 'TEXTO-SECRETO';
    delete primeiro['categoria'];
    try {
      lerCasosDeAvaliacao(JSON.stringify(quebrado));
      throw new Error('deveria falhar');
    } catch (e) {
      expect((e as Error).message).toContain('caso 1');
      expect((e as Error).message).not.toContain('TEXTO-SECRETO');
    }
  });
});
