import { beforeEach, describe, expect, it } from 'vitest';
import { ServicoControleDaIa } from '../../src/application/services/ServicoControleDaIa.js';
import type { AmbienteDaIa } from '../../src/domain/entities/ControleDaIa.js';
import { ConfiguracaoDeIaRecusadaError } from '../../src/domain/errors/index.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import type { RepositorioDeConfigDeIa } from '../../src/domain/ports/PainelDeIa.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDeConfigDeIaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';
import { LoggerColetor } from '../helpers/analiseIa.js';

/*
 * O controle da IA pelo painel (v0.58.0): o ambiente é a trava mestra, o painel só desliga ou reduz,
 * toda mudança é registrada e a falha do painel NUNCA derruba a IA. Banco em memória, relógio falso.
 */

const AMBIENTE: AmbienteDaIa = {
  permite: { ato: true, resumo: true, peca: false },
  tetoPorContaDoAmbiente: 200,
};

class RelogioFalso implements Clock {
  ms = new Date('2026-10-05T15:00:00.000Z').getTime();
  agora(): Date {
    return new Date(this.ms);
  }
  monotonico(): number {
    return this.ms;
  }
}

let relogio: RelogioFalso;
let logger: LoggerColetor;
let repo: RepositorioDeConfigDeIaSqlite;
let db: ReturnType<typeof abrirBanco>;

function montar(
  repositorio: RepositorioDeConfigDeIa = repo,
  ambiente: AmbienteDaIa = AMBIENTE,
  validadeDoCacheMs = 0,
): ServicoControleDaIa {
  return new ServicoControleDaIa({
    repositorio,
    ambiente,
    clock: relogio,
    logger,
    validadeDoCacheMs,
  });
}

beforeEach(() => {
  relogio = new RelogioFalso();
  logger = new LoggerColetor();
  db = abrirBanco(':memory:');
  repo = new RepositorioDeConfigDeIaSqlite(db);
});

describe('precedência: o ambiente é a trava mestra', () => {
  it('sem nada gravado, vale o ambiente: liga o que ele permite e só isso', () => {
    const c = montar();
    expect(c.ligada('ato')).toBe(true);
    expect(c.ligada('resumo')).toBe(true);
    expect(c.ligada('peca')).toBe(false);
  });

  it('o painel desliga o que o ambiente permite', () => {
    const c = montar();
    c.ligarOuDesligar('op', 'ato', false, true);
    expect(c.ligada('ato')).toBe(false);
    expect(c.ligada('resumo')).toBe(true);
  });

  it('o painel NUNCA liga o que o ambiente desligou — o pedido é recusado e nada é gravado', () => {
    const c = montar();
    expect(() => c.ligarOuDesligar('op', 'peca', true, false)).toThrowError(
      ConfiguracaoDeIaRecusadaError,
    );
    try {
      c.ligarOuDesligar('op', 'peca', true, false);
    } catch (e) {
      expect((e as ConfiguracaoDeIaRecusadaError).motivo).toBe('ambiente_bloqueia');
    }
    expect(c.ligada('peca')).toBe(false);
    expect(c.alteracoes()).toEqual([]);
  });

  it('linha gravada como "ligada" para função que o ambiente desligou continua desligada', () => {
    db.prepare(
      "INSERT INTO ia_config (chave, ligada, atualizado_em) VALUES ('peca', 1, '2026-10-05T00:00:00.000Z')",
    ).run();
    expect(montar().ligada('peca')).toBe(false);
  });

  it('o estado de cada função diz de quem é a trava (ambiente × painel)', () => {
    const c = montar();
    c.ligarOuDesligar('op', 'resumo', false, true);
    const e = Object.fromEntries(c.estados().map((x) => [x.funcao, x]));
    expect(e['ato']).toMatchObject({
      ambientePermite: true,
      painelLigado: true,
      efetivamenteLigada: true,
    });
    expect(e['resumo']).toMatchObject({
      ambientePermite: true,
      painelLigado: false,
      efetivamenteLigada: false,
    });
    expect(e['peca']).toMatchObject({
      ambientePermite: false,
      efetivamenteLigada: false,
    });
  });
});

describe('teto efetivo = o menor entre a variável de ambiente e o painel', () => {
  it('sem teto no painel, vale o do ambiente', () => {
    expect(montar().estados()[0]?.tetoEfetivoPorConta).toBe(200);
  });

  it('painel mais baixo reduz', () => {
    const c = montar();
    c.definirTetoDaFuncao('op', 'ato', 50);
    expect(c.estados()[0]).toMatchObject({ tetoDoPainel: 50, tetoEfetivoPorConta: 50 });
  });

  it('painel mais alto que o ambiente NÃO sobe o teto', () => {
    const c = montar();
    c.definirTetoDaFuncao('op', 'ato', 5000);
    expect(c.estados()[0]).toMatchObject({
      tetoDoPainel: 5000,
      tetoEfetivoPorConta: 200,
    });
  });

  it('remover o teto do painel volta ao do ambiente', () => {
    const c = montar();
    c.definirTetoDaFuncao('op', 'ato', 50);
    c.definirTetoDaFuncao('op', 'ato', null);
    expect(c.estados()[0]).toMatchObject({
      tetoDoPainel: null,
      tetoEfetivoPorConta: 200,
    });
  });

  it('os tetos do painel chegam ao TetoDiario por função e o global por fora', () => {
    const c = montar();
    c.definirTetoDaFuncao('op', 'resumo', 30);
    c.definirTetoGlobal('op', 1000);
    expect(c.limites()).toEqual({
      porFuncao: { ato: undefined, resumo: 30, peca: undefined },
      global: 1000,
    });
  });
});

describe('segurança do pedido', () => {
  it('desligar sem confirmação é recusado e nada é gravado', () => {
    const c = montar();
    try {
      c.ligarOuDesligar('op', 'ato', false, false);
      expect.unreachable();
    } catch (e) {
      expect((e as ConfiguracaoDeIaRecusadaError).motivo).toBe('confirmacao_necessaria');
    }
    expect(c.ligada('ato')).toBe(true);
    expect(c.alteracoes()).toEqual([]);
  });

  it('ligar não pede confirmação', () => {
    const c = montar();
    c.ligarOuDesligar('op', 'ato', false, true);
    c.ligarOuDesligar('op', 'ato', true, false);
    expect(c.ligada('ato')).toBe(true);
  });

  it.each([0, -1, 1.5, 100_001, Number.NaN, Number.POSITIVE_INFINITY])(
    'teto %s é valor inválido',
    (teto) => {
      const c = montar();
      expect(() => c.definirTetoDaFuncao('op', 'ato', teto)).toThrowError(
        ConfiguracaoDeIaRecusadaError,
      );
      expect(() => c.definirTetoGlobal('op', teto)).toThrowError(
        ConfiguracaoDeIaRecusadaError,
      );
      expect(c.alteracoes()).toEqual([]);
    },
  );

  it.each([0, -3, 0.001, 10_001, Number.NaN])('alerta %s é valor inválido', (v) => {
    expect(() => montar().definirAlertaDeCusto('op', v)).toThrowError(
      ConfiguracaoDeIaRecusadaError,
    );
  });

  it('função desconhecida é recusada com motivo próprio', () => {
    try {
      montar().ligarOuDesligar('op', 'drive', false, true);
      expect.unreachable();
    } catch (e) {
      expect((e as ConfiguracaoDeIaRecusadaError).motivo).toBe('funcao_desconhecida');
    }
  });

  it('a mensagem de recusa nunca repete o valor recebido', () => {
    try {
      montar().definirTetoDaFuncao('op', 'ato', 987_654_321);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('987654321');
    }
  });

  it('o alerta padrão é US$ 3,00 e é ajustável', () => {
    const c = montar();
    expect(c.alertaDeCustoUsd()).toBe(3);
    c.definirAlertaDeCusto('op', 5.5);
    expect(c.alertaDeCustoUsd()).toBe(5.5);
  });
});

describe('registro de mudanças', () => {
  it('guarda quem, quando, o quê, o valor anterior e o novo — só valores simples', () => {
    const c = montar();
    c.ligarOuDesligar('1a2b3c4d', 'ato', false, true);
    relogio.ms += 60_000;
    c.definirTetoDaFuncao('1a2b3c4d', 'resumo', 40);
    c.definirTetoGlobal('1a2b3c4d', 900);
    c.definirAlertaDeCusto('1a2b3c4d', 7);
    const r = c.alteracoes().map((a) => ({
      funcao: a.funcao,
      tipo: a.tipo,
      anterior: a.anterior,
      novo: a.novo,
      autor: a.autor,
    }));
    // Mais recente primeiro.
    expect(r).toEqual([
      {
        funcao: 'global',
        tipo: 'alerta_custo',
        anterior: '3.00',
        novo: '7.00',
        autor: '1a2b3c4d',
      },
      {
        funcao: 'global',
        tipo: 'teto_dia_global',
        anterior: 'sem teto',
        novo: '900',
        autor: '1a2b3c4d',
      },
      {
        funcao: 'resumo',
        tipo: 'teto_dia_conta',
        anterior: 'sem teto',
        novo: '40',
        autor: '1a2b3c4d',
      },
      {
        funcao: 'ato',
        tipo: 'ligada',
        anterior: 'ligada',
        novo: 'desligada',
        autor: '1a2b3c4d',
      },
    ]);
    expect(c.alteracoes()[3]?.em.toISOString()).toBe('2026-10-05T15:00:00.000Z');
  });

  it('é reversível: ligar de novo restaura e fica registrado', () => {
    const c = montar();
    c.ligarOuDesligar('op', 'ato', false, true);
    c.ligarOuDesligar('op', 'ato', true, false);
    expect(c.ligada('ato')).toBe(true);
    expect(c.alteracoes().map((a) => a.novo)).toEqual(['ligada', 'desligada']);
  });

  it('pedido que não muda nada não gera registro', () => {
    const c = montar();
    c.ligarOuDesligar('op', 'ato', true, false);
    c.definirTetoDaFuncao('op', 'ato', null);
    expect(c.alteracoes()).toEqual([]);
  });

  it('devolve no máximo as últimas 50', () => {
    const c = montar();
    for (let i = 1; i <= 60; i++) c.definirTetoGlobal('op', i);
    const todas = c.alteracoes(50);
    expect(todas).toHaveLength(50);
    expect(todas[0]?.novo).toBe('60');
  });

  it('o log diz o fato (quem, função, tipo, novo valor) e nada mais', () => {
    const c = montar();
    c.ligarOuDesligar('1a2b3c4d', 'ato', false, true);
    const linha =
      logger.linhas.find((l) => l.includes('configuração de IA alterada')) ?? '';
    expect(linha).toContain('1a2b3c4d');
    expect(linha).toContain('desligada');
    expect(linha).not.toMatch(/@|senha|chave|processo/i);
  });
});

describe('falha segura: o painel nunca derruba a IA', () => {
  const quebrado: RepositorioDeConfigDeIa = {
    ler: () => {
      throw new Error('disco cheio em /dados/secreto.db');
    },
    gravar: () => undefined,
    alteracoes: () => {
      throw new Error('disco cheio em /dados/secreto.db');
    },
  };

  it('banco que falha na leitura: vale o ambiente, sem lançar', () => {
    const c = montar(quebrado);
    expect(c.ligada('ato')).toBe(true);
    expect(c.ligada('peca')).toBe(false);
    expect(c.limites()).toEqual({
      porFuncao: { ato: undefined, resumo: undefined, peca: undefined },
      global: undefined,
    });
    expect(c.alertaDeCustoUsd()).toBe(3);
    expect(c.alteracoes()).toEqual([]);
  });

  it('o aviso vai ao log uma vez por minuto, sem a mensagem do erro (pode trazer caminho)', () => {
    const c = montar(quebrado, AMBIENTE, 1);
    for (let i = 0; i < 20; i++) {
      c.ligada('ato');
      relogio.ms += 10;
    }
    const avisos = logger.linhas.filter((l) => l.startsWith('warn'));
    expect(avisos.length).toBe(1);
    expect(avisos.join('')).not.toContain('secreto');
  });

  it('linha corrompida no banco (teto absurdo, alerta absurdo) é ignorada e vale o padrão', () => {
    db.prepare(
      "INSERT INTO ia_config (chave, ligada, teto_dia_conta, atualizado_em) VALUES ('ato', 1, -7, 'x')",
    ).run();
    db.prepare(
      "INSERT INTO ia_config (chave, teto_dia_global, alerta_custo_dia_usd, atualizado_em) VALUES ('global', 0, 999999, 'x')",
    ).run();
    const c = montar();
    expect(c.limites().porFuncao.ato).toBeUndefined();
    expect(c.limites().global).toBeUndefined();
    expect(c.alertaDeCustoUsd()).toBe(3);
  });

  it('o cache é curto: a mudança feita por fora só aparece depois da validade', () => {
    const c = montar(repo, AMBIENTE, 5_000);
    expect(c.ligada('ato')).toBe(true);
    db.prepare(
      "INSERT INTO ia_config (chave, ligada, atualizado_em) VALUES ('ato', 0, 'x')",
    ).run();
    expect(c.ligada('ato')).toBe(true);
    relogio.ms += 5_001;
    expect(c.ligada('ato')).toBe(false);
  });

  it('mudança feita pelo próprio serviço vale na hora, apesar do cache', () => {
    const c = montar(repo, AMBIENTE, 60_000);
    expect(c.ligada('ato')).toBe(true);
    c.ligarOuDesligar('op', 'ato', false, true);
    expect(c.ligada('ato')).toBe(false);
  });
});
