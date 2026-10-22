import { describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';

const BASE = { LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv;
const CHAVE_FALSA = 'sk-or-v1-chave-sintetica-0123456789abcdef';

describe('configuração da análise por IA', () => {
  it('nasce desligada, com os padrões da Etapa 2', () => {
    const c = carregarConfig(BASE).ia;
    expect(c.habilitada).toBe(false);
    expect(c.modelo).toBe('deepseek/deepseek-v4-flash');
    expect(c.raciocinio).toBe('desligado');
    expect(c.timeoutMs).toBe(90_000);
    expect(c.provedoresPermitidos).toEqual([]);
    expect(c.chave).toBe('');
  });

  it('desligada, não exige chave nem olha o modelo', () => {
    expect(() =>
      carregarConfig({ ...BASE, PROCESSOVIVO_IA_MODELO: '~x/y:online' }),
    ).not.toThrow();
  });

  it('habilitada sem chave: o arranque falha, dizendo qual variável', () => {
    expect(() => carregarConfig({ ...BASE, PROCESSOVIVO_IA_HABILITADA: 'true' })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it('habilitada com valor de exemplo no lugar da chave: falha, sem repetir o valor', () => {
    const exemplo = 'COLE_AQUI_A_CHAVE_DO_OPENROUTER';
    const erro = (() => {
      try {
        carregarConfig({
          ...BASE,
          PROCESSOVIVO_IA_HABILITADA: 'true',
          OPENROUTER_API_KEY: exemplo,
        });
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(erro?.message).toMatch(/OPENROUTER_API_KEY/);
    expect(erro?.message).not.toContain(exemplo);
  });

  it('habilitada com modelo apelido ou variante: falha', () => {
    for (const modelo of ['~fab/modelo-latest', 'fab/modelo:online']) {
      expect(() =>
        carregarConfig({
          ...BASE,
          PROCESSOVIVO_IA_HABILITADA: 'true',
          OPENROUTER_API_KEY: CHAVE_FALSA,
          PROCESSOVIVO_IA_MODELO: modelo,
        }),
      ).toThrow(/PROCESSOVIVO_IA_MODELO/);
    }
  });

  it('habilitada com chave real: lê modelo, raciocínio e a lista de provedores (minúsculas)', () => {
    const c = carregarConfig({
      ...BASE,
      PROCESSOVIVO_IA_HABILITADA: 'true',
      OPENROUTER_API_KEY: CHAVE_FALSA,
      PROCESSOVIVO_IA_MODELO: 'fab/modelo-falso',
      PROCESSOVIVO_IA_RACIOCINIO: 'minimo',
      PROCESSOVIVO_IA_PROVEDORES_PERMITIDOS: ' Alfa, BETA ,',
    }).ia;
    expect(c).toMatchObject({
      habilitada: true,
      modelo: 'fab/modelo-falso',
      raciocinio: 'minimo',
      chave: CHAVE_FALSA,
      provedoresPermitidos: ['alfa', 'beta'],
    });
  });

  it('raciocínio fora da lista é recusado', () => {
    expect(() => carregarConfig({ ...BASE, PROCESSOVIVO_IA_RACIOCINIO: 'alto' })).toThrow(
      /PROCESSOVIVO_IA_RACIOCINIO/,
    );
  });

  it('não existe variável para desligar a ZDR (nada na configuração fala em ZDR)', () => {
    const chaves = Object.keys(carregarConfig(BASE).ia).join(',');
    expect(chaves.toLowerCase()).not.toContain('zdr');
  });
});

describe('tabela analises_ia', () => {
  it('é criada de forma aditiva e idempotente: abrir de novo um banco com a tabela não estoura', () => {
    const db = abrirBanco(':memory:');
    const colunas = db
      .prepare("SELECT name FROM pragma_table_info('analises_ia')")
      .all()
      .map((c) => (c as { name: string }).name);
    expect(colunas).toEqual(
      expect.arrayContaining([
        'id',
        'workspace',
        'numero',
        'chave_do_ato',
        'resultado',
        'modelo',
        'versao_prompt',
        'provedor',
        'latencia_ms',
        'criada_em',
        'avaliacao',
      ]),
    );
    // Nenhuma coluna guarda o texto do ato.
    expect(colunas.some((c) => /texto|conteudo/.test(c))).toBe(false);
  });

  /*
   * REESCRITO na v0.50.0: a exceção de teste fechado (`PROCESSOVIVO_IA_WORKSPACES_LIBERADOS`) saiu, como o
   * CLAUDE.md mandava fazer ao abrir a IA ao público. Os testes que validavam o formato da lista não têm mais
   * o que validar; o que fica é: a variável não libera nada, não derruba o arranque e só é DETECTADA, para o
   * composition root avisar no log (sem ecoar o valor).
   */
  describe('variável da antiga exceção de teste fechado (removida na v0.50.0)', () => {
    it('ausente ou vazia: nada a avisar', () => {
      expect(carregarConfig(BASE).ia.variavelDeTesteFechadoPresente).toBe(false);
      expect(
        carregarConfig({ ...BASE, PROCESSOVIVO_IA_WORKSPACES_LIBERADOS: '  ' }).ia
          .variavelDeTesteFechadoPresente,
      ).toBe(false);
    });

    it('presente, mesmo com valor torto: não derruba o arranque, não liga a IA, só é detectada', () => {
      const c = carregarConfig({ ...BASE, PROCESSOVIVO_IA_WORKSPACES_LIBERADOS: 'xyz,123' });
      expect(c.ia.variavelDeTesteFechadoPresente).toBe(true);
      expect(c.ia.habilitada).toBe(false);
      expect(JSON.stringify(c)).not.toContain('xyz,123');
    });
  });

  it('teto técnico por dia (v0.50.0): padrão de 200 por conta, configurável', () => {
    expect(carregarConfig(BASE).ia.maxPorDia).toBe(200);
    expect(carregarConfig({ ...BASE, PROCESSOVIVO_IA_MAX_POR_DIA: '50' }).ia.maxPorDia).toBe(50);
    expect(() => carregarConfig({ ...BASE, PROCESSOVIVO_IA_MAX_POR_DIA: '0' })).toThrow();
  });

  it('resumo de processo: padrões de 6 por hora, 1500 tokens e 120 s, todos configuráveis', () => {
    const c = carregarConfig(BASE).ia;
    expect(c.resumoMaxPorHora).toBe(6);
    expect(c.resumoMaxTokens).toBe(1500);
    expect(c.resumoTimeoutMs).toBe(120_000);
    const outro = carregarConfig({
      ...BASE,
      PROCESSOVIVO_IA_RESUMO_MAX_POR_HORA: '3',
      PROCESSOVIVO_IA_RESUMO_MAX_TOKENS: '900',
      PROCESSOVIVO_IA_RESUMO_TIMEOUT_MS: '60000',
    }).ia;
    expect([outro.resumoMaxPorHora, outro.resumoMaxTokens, outro.resumoTimeoutMs]).toEqual([
      3, 900, 60_000,
    ]);
    expect(() =>
      carregarConfig({ ...BASE, PROCESSOVIVO_IA_RESUMO_MAX_POR_HORA: '0' }),
    ).toThrow();
  });
});
