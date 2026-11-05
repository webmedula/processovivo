import { describe, expect, it } from 'vitest';
import {
  montarEntradaDaSintese,
  type PecaParaSintese,
} from '../../src/application/politicas/entradaDaSintese.js';
import {
  afirmaProcedencia,
  normalizarRef,
  verificarSintese,
} from '../../src/application/politicas/verificarSintese.js';
import type { RespostaDoModeloDaSintese } from '../../src/domain/entities/AnaliseDoProcesso.js';

/* Verificação da síntese do processo (v0.66.0): tudo sintético, com marcadores no lugar de nome. */

const vazio = {
  alegacoes: [],
  preliminares: [],
  documentos: [],
  valores: [],
  pontosDeAtencao: [],
  pedidos: [],
} as const;
const PECAS: PecaParaSintese[] = [
  {
    tipo: 'peticao_inicial',
    data: new Date('2099-01-10T12:00:00Z'),
    resultado: {
      estado: 'verificada',
      tipo: 'peticao_inicial',
      ...vazio,
      emUmaFrase: '[PARTE A] pede a devolução de R$ 5.000,00.',
      pedidos: [
        {
          texto: 'Pede a devolução de R$ 5.000,00',
          trecho: 'devolução de R$ 5.000,00',
          pagina: 2,
        },
      ],
      alegacoes: [
        { texto: 'Alega que não contratou', trecho: 'não contratou', pagina: 1 },
      ],
    },
  },
  {
    tipo: 'contestacao',
    data: new Date('2099-02-10T12:00:00Z'),
    resultado: {
      estado: 'verificada',
      tipo: 'contestacao',
      ...vazio,
      emUmaFrase: '[PARTE B] contesta.',
      alegacoes: [
        { texto: 'Alega que houve contratação', trecho: 'houve contratação', pagina: 1 },
      ],
    },
  },
  {
    tipo: 'decisao',
    data: new Date('2099-03-10T12:00:00Z'),
    resultado: {
      estado: 'verificada',
      tipo: 'decisao',
      ...vazio,
      emUmaFrase: 'O juízo determina a juntada do contrato.',
      determinacoes: [
        {
          quem: '[PARTE B]',
          texto: 'determina a juntada do contrato',
          prazo_escrito: '10 (dez) dias',
          trecho: 'junte o contrato',
          pagina: 1,
        },
      ],
    },
  },
];
const { itens, usuario } = montarEntradaDaSintese(PECAS);
const resposta = (r: Partial<RespostaDoModeloDaSintese>): RespostaDoModeloDaSintese => ({
  objeto: { texto: 'Discute-se a devolução de valores.', refs: ['P1.pedido1'] },
  pedidos: [],
  linha_do_tempo: [],
  pontos_controvertidos: [],
  ...r,
});

describe('entrada da síntese', () => {
  it('dá um identificador a cada item e não manda o rótulo do tribunal', () => {
    expect([...itens.keys()]).toEqual([
      'P1.resumo1',
      'P1.pedido1',
      'P1.alegacao1',
      'P2.resumo1',
      'P2.alegacao1',
      'P3.resumo1',
      'P3.determinacao1',
    ]);
    expect(usuario).toContain('[P2] Contestação · 10/02/2099 · lado: parte ré');
    expect(usuario).toContain('(prazo escrito: 10 (dez) dias)');
  });
});

describe('verificarSintese', () => {
  it('normaliza a referência e ignora a que não existe', () => {
    expect(normalizarRef('[p2.Alegacao1]')).toBe('P2.alegacao1');
    expect(normalizarRef('qualquer')).toBe('');
  });

  it('aceita pedido com defesa da parte ré e decisão do juízo', () => {
    const v = verificarSintese(
      resposta({
        pedidos: [
          {
            texto: 'A parte autora pede a devolução de R$ 5.000,00.',
            refs: ['P1.pedido1'],
            defesa: {
              texto: 'A parte ré alega que houve contratação.',
              refs: ['P2.alegacao1'],
            },
            decisao: {
              texto: 'O juízo determina a juntada do contrato.',
              refs: ['P3.determinacao1'],
            },
          },
        ],
      }),
      itens,
    );
    expect(v.estado).toBe('verificada');
    if (v.estado !== 'verificada') return;
    expect(v.pedidos[0]?.defesa?.refs).toEqual(['P2.alegacao1']);
    expect(v.pedidos[0]?.decisao?.refs).toEqual(['P3.determinacao1']);
  });

  it('barra item a item: lado errado, referência inventada, número fora dos itens, mérito', () => {
    const v = verificarSintese(
      resposta({
        pedidos: [
          {
            texto: 'A parte autora pede a devolução.',
            refs: ['P1.pedido1'],
            // A "defesa" vem de alegação da própria autora: forma.
            defesa: { texto: 'Alega que não contratou.', refs: ['P1.alegacao1'] },
            decisao: null,
          },
          // Pedido apontando alegação: forma.
          { texto: 'Pede algo.', refs: ['P2.alegacao1'], defesa: null, decisao: null },
        ],
        linha_do_tempo: [
          { texto: 'Sem base.', refs: ['P7.pedido1'] },
          { texto: 'A parte autora pede R$ 9.999,00.', refs: ['P1.pedido1'] },
          { texto: 'O pedido é procedente.', refs: ['P1.pedido1'] },
        ],
        pontos_controvertidos: [
          // Uma peça só não é controvérsia: forma.
          { texto: 'Divergem.', refs: ['P1.alegacao1'] },
          {
            texto: 'As partes divergem sobre a contratação.',
            refs: ['P1.alegacao1', 'P2.alegacao1'],
          },
        ],
      }),
      itens,
    );
    expect(v.descartes).toEqual({ referencia: 1, forma: 3, numero: 1, proibida: 1 });
    expect(v.estado).toBe('verificada');
    if (v.estado !== 'verificada') return;
    expect(v.pedidos).toHaveLength(1);
    expect(v.pedidos[0]?.defesa).toBeNull();
    expect(v.linhaDoTempo).toHaveLength(0);
    expect(v.controvertidos).toHaveLength(1);
  });

  it('sem objeto verificado o resultado é "não verificado"', () => {
    const v = verificarSintese(
      resposta({ objeto: { texto: 'x', refs: ['P9.pedido1'] } }),
      itens,
    );
    expect(v).toMatchObject({
      estado: 'nao_verificada',
      motivo: 'sem_objeto_verificado',
    });
  });

  it('juízo de procedência na voz do modelo cai; descrever o pedido não', () => {
    expect(afirmaProcedencia('O pedido é procedente.')).toBe(true);
    expect(afirmaProcedencia('A ação deve ser julgada improcedente.')).toBe(true);
    expect(afirmaProcedencia('Os pedidos são parcialmente procedentes.')).toBe(true);
    expect(
      afirmaProcedencia('A parte autora pede que a ação seja julgada procedente.'),
    ).toBe(false);
    expect(afirmaProcedencia('A parte ré pede a improcedência dos pedidos.')).toBe(false);
  });
});
