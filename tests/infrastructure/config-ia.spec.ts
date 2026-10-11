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

  describe('workspaces liberados (teste fechado, v0.38.1)', () => {
    const ID = '1ed3b9b0ba131867';

    it('vazia por padrão: comportamento de sempre', () => {
      expect(carregarConfig(BASE).ia.workspacesLiberados).toEqual([]);
      expect(
        carregarConfig({ ...BASE, PROCESSOVIVO_IA_WORKSPACES_LIBERADOS: ' , ' }).ia
          .workspacesLiberados,
      ).toEqual([]);
    });

    it('lê a lista separada por vírgula, normaliza caixa e remove repetição', () => {
      const c = carregarConfig({
        ...BASE,
        PROCESSOVIVO_IA_WORKSPACES_LIBERADOS: ` ${ID.toUpperCase()}, aaaa0000bbbb1111 ,${ID}`,
      });
      expect(c.ia.workspacesLiberados).toEqual([ID, 'aaaa0000bbbb1111']);
    });

    it.each([
      ['curto demais', '1ed3b9b0'],
      ['longo demais', ID + 'ff'],
      ['não hexadecimal', '1ed3b9b0ba13186z'],
      ['um bom e um ruim', ID + ',xyz'],
    ])('id com formato inválido (%s) derruba o arranque', (_nome, valor) => {
      expect(() =>
        carregarConfig({ ...BASE, PROCESSOVIVO_IA_WORKSPACES_LIBERADOS: valor }),
      ).toThrow(/PROCESSOVIVO_IA_WORKSPACES_LIBERADOS/);
    });

    it('a mensagem diz a posição do item e NUNCA repete o valor (pode ser uma chave de API colada)', () => {
      const chaveColada = 'chave-de-api-colada-por-engano-0123456789abcdef';
      const erro = (() => {
        try {
          carregarConfig({
            ...BASE,
            PROCESSOVIVO_IA_WORKSPACES_LIBERADOS: `${ID},${chaveColada}`,
          });
        } catch (e) {
          return e as Error;
        }
        return undefined;
      })();
      expect(erro?.message).toContain('item 2');
      expect(erro?.message).not.toContain(chaveColada);
      expect(erro?.message).not.toContain(ID);
    });

    it('é validada mesmo com a IA desligada, e não liga a IA', () => {
      const c = carregarConfig({ ...BASE, PROCESSOVIVO_IA_WORKSPACES_LIBERADOS: ID });
      expect(c.ia.habilitada).toBe(false);
      expect(c.ia.chave).toBe('');
    });
  });
});
