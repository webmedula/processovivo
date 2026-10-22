import { describe, expect, it } from 'vitest';
import {
  INSTRUCAO_DO_RESUMO,
  INSTRUCAO_DO_RESUMO_1_1_0,
  VERSAO_PROMPT_DO_RESUMO,
} from '../../src/application/politicas/entradaDoResumo.js';
import {
  verificarResumo,
  type AtoVerificavel,
} from '../../src/application/politicas/verificarResumo.js';
import type { RespostaDoModeloResumo } from '../../src/domain/entities/vocabularioDoResumo.js';

/* Regras 1.2.0 do resumo conciso (v0.56.0). Atos e textos sintéticos. */
const ATOS = new Map<string, AtoVerificavel>([
  [
    'A1',
    {
      chave: 'chave-recente',
      textoEnviado:
        'Título: Despacho\nData do ato: 05/10/2026\nTexto:\nIntime-se a parte autora para que se manifeste sobre o laudo pericial, em dez dias.',
    },
  ],
  [
    'A2',
    {
      chave: 'chave-antiga',
      textoEnviado:
        'Título: Decisão\nData do ato: 21/02/2025\nTexto:\nDefiro a produção de prova pericial.',
    },
  ],
  [
    'A3',
    {
      chave: 'chave-mais-antiga',
      textoEnviado: 'Título: Sentença\nData do ato: 01/01/2025\nTexto:\nJulgo o feito.',
    },
  ],
]);
const RECENTE = { chave: 'chave-recente', lido: true };
const R12 = { regras: '1.2.0', maisRecente: RECENTE } as const;

const item = (texto: string, ato: string, trecho: string) => ({ texto, ato, trecho });
const ITEM_RECENTE = item(
  'Em 05/10/2026, o juízo mandou a parte autora se manifestar sobre o laudo.',
  'A1',
  'se manifeste sobre o laudo pericial',
);
const ITEM_ANTIGO = item(
  'Antes, em 21/02/2025, foi deferida a prova pericial.',
  'A2',
  'Defiro a produção de prova pericial',
);
const resposta = (
  sobrescrever: Partial<RespostaDoModeloResumo> = {},
): RespostaDoModeloResumo => ({
  situacao: [ITEM_RECENTE],
  pendencias: [],
  pontos_de_atencao: [],
  ...sobrescrever,
});

describe('verificação do resumo, regras 1.2.0', () => {
  it('a situação que abre pelo ato mais recente lido passa', () => {
    const r = verificarResumo(resposta(), ATOS, R12);
    expect(r.estado).toBe('verificado');
  });

  it('situação que NÃO cita o ato mais recente lido: o resultado inteiro é "não verificado"', () => {
    const r = verificarResumo(resposta({ situacao: [ITEM_ANTIGO] }), ATOS, R12);
    expect(r).toMatchObject({ estado: 'nao_verificado', motivo: 'sem_ato_mais_recente' });
  });

  it('o ato mais recente citado em segundo lugar vai para o começo', () => {
    const r = verificarResumo(
      resposta({ situacao: [ITEM_ANTIGO, ITEM_RECENTE] }),
      ATOS,
      R12,
    );
    if (r.estado !== 'verificado') throw new Error('esperava verificado');
    expect(r.situacao.map((i) => i.chaveDoAto)).toEqual([
      'chave-recente',
      'chave-antiga',
    ]);
  });

  it('ato antigo apresentado como atual é descartado, e a situação continua pelo recente', () => {
    const atual = item(
      'Atualmente a prova pericial está deferida.',
      'A2',
      ITEM_ANTIGO.trecho,
    );
    const r = verificarResumo(resposta({ situacao: [ITEM_RECENTE, atual] }), ATOS, R12);
    if (r.estado !== 'verificado') throw new Error('esperava verificado');
    expect(r.situacao).toHaveLength(1);
    expect(r.descartes.atualidade).toBe(1);
  });

  it('só UM ato antigo entra na situação; o segundo é descartado', () => {
    const outro = item(
      'Antes, em 01/01/2025, o feito foi julgado.',
      'A3',
      'Julgo o feito',
    );
    const r = verificarResumo(
      resposta({ situacao: [ITEM_RECENTE, ITEM_ANTIGO, outro] }),
      ATOS,
      R12,
    );
    if (r.estado !== 'verificado') throw new Error('esperava verificado');
    expect(r.situacao.map((i) => i.chaveDoAto)).toEqual([
      'chave-recente',
      'chave-antiga',
    ]);
    expect(r.descartes.forma).toBe(1);
  });

  it('"sem pendências" com providência do sistema que a IA não leu é descartado', () => {
    const r = verificarResumo(
      resposta({
        pendencias: [
          item(
            'Não há pendências a cumprir.',
            'A1',
            'se manifeste sobre o laudo pericial',
          ),
        ],
      }),
      ATOS,
      { ...R12, providenciaNaoLida: true },
    );
    if (r.estado !== 'verificado') throw new Error('esperava verificado');
    expect(r.pendencias).toEqual([]);
    expect(r.descartes.pendenciaNegada).toBe(1);
  });

  it('com o ato mais recente NÃO lido, ele não é exigido e "situação atual" continua barrada', () => {
    const r = verificarResumo(resposta({ situacao: [ITEM_ANTIGO] }), ATOS, {
      regras: '1.2.0',
      maisRecente: { chave: 'chave-recente', lido: false },
      maisRecenteNaoLido: true,
    });
    expect(r.estado).toBe('verificado');
    const atual = verificarResumo(
      resposta({
        situacao: [item('Atualmente está deferida.', 'A2', ITEM_ANTIGO.trecho)],
      }),
      ATOS,
      {
        regras: '1.2.0',
        maisRecente: { chave: 'chave-recente', lido: false },
        maisRecenteNaoLido: true,
      },
    );
    expect(atual).toMatchObject({ estado: 'nao_verificado' });
  });

  it('tamanho: situação com mais de 3 itens, situação acima de 360 e pendência acima de 200 são descartadas', () => {
    const longa = `Em 05/10/2026, ${'o juízo mandou a parte se manifestar sobre o laudo '.repeat(8)}`;
    const pendLonga = `Parte autora: ${'manifestar-se sobre o laudo pericial '.repeat(8)}`;
    expect(longa.length).toBeGreaterThan(360);
    expect(pendLonga.length).toBeGreaterThan(200);
    const r = verificarResumo(
      resposta({
        situacao: [ITEM_RECENTE, item(longa, 'A1', ITEM_RECENTE.trecho), ITEM_ANTIGO],
        pendencias: [item(pendLonga, 'A1', ITEM_RECENTE.trecho)],
      }),
      ATOS,
      R12,
    );
    if (r.estado !== 'verificado') throw new Error('esperava verificado');
    expect(r.situacao).toHaveLength(2);
    expect(r.pendencias).toEqual([]);
    expect(r.descartes.forma).toBe(2);
  });

  it('o prazo escrito no ato passa; prazo que o ato não tem é descartado (nada é calculado)', () => {
    const certo = item(
      'Parte autora: manifestar-se sobre o laudo, em dez dias.',
      'A1',
      'se manifeste sobre o laudo pericial',
    );
    const inventado = item(
      'Parte autora: manifestar-se sobre o laudo, em quinze dias.',
      'A1',
      'se manifeste sobre o laudo pericial',
    );
    const r = verificarResumo(resposta({ pendencias: [certo, inventado] }), ATOS, R12);
    if (r.estado !== 'verificado') throw new Error('esperava verificado');
    expect(r.pendencias).toHaveLength(1);
    expect(r.descartes.numeroInventado).toBe(1);
  });

  it('sem `regras`, valem as da 1.1.0: o ato mais recente não é exigido na situação', () => {
    const r = verificarResumo(resposta({ situacao: [ITEM_ANTIGO] }), ATOS, {
      maisRecente: RECENTE,
    });
    expect(r.estado).toBe('verificado');
  });
});

describe('prompt resumo-1.2.0', () => {
  it('é a versão de produção, curta, e pede a situação pelo ato mais recente com a data', () => {
    expect(VERSAO_PROMPT_DO_RESUMO).toBe('resumo-1.2.0');
    expect(INSTRUCAO_DO_RESUMO).toContain('320 caracteres');
    expect(INSTRUCAO_DO_RESUMO).toContain('160 caracteres');
    expect(INSTRUCAO_DO_RESUMO).toContain('até 5 itens');
    expect(INSTRUCAO_DO_RESUMO).toContain('Antes, em dd/mm/aaaa');
    expect(INSTRUCAO_DO_RESUMO).toContain('Em 05/10/2026');
    expect(INSTRUCAO_DO_RESUMO).toContain('Nunca calcule prazo');
  });

  it('a 1.1.0 continua disponível, sem a meta de tamanho', () => {
    expect(INSTRUCAO_DO_RESUMO_1_1_0).not.toContain('320 caracteres');
    expect(INSTRUCAO_DO_RESUMO_1_1_0).toContain('<ato_mais_recente>');
  });
});
