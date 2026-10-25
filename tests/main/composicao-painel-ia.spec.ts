import { describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { montarAplicacao } from '../../src/main/factories/makeProcessoSearchService.js';

/*
 * O painel de IA na composição REAL (v0.58.0): o ambiente é a trava mestra, o alerta de custo só nasce
 * com a IA ligada, o /admin configurado e (para o e-mail) SMTP de verdade. Banco em memória, sem rede.
 */

const BASE = {
  PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
  PROCESSOVIVO_API_KEYS: 'chave-de-teste-1234567890',
  PROCESSOVIVO_DB_PATH: ':memory:',
  LOG_LEVEL: 'silent',
  SYNC_INTERVALO_HORAS: '0',
  VIGILANCIA_INTERVALO_HORAS: '0',
  BACKUP_INTERVALO_HORAS: '0',
};
const IA = {
  PROCESSOVIVO_IA_HABILITADA: 'true',
  OPENROUTER_API_KEY: 'sk-or-v1-chave-sintetica-0123456789abcdef',
};
const ADMIN = {
  PROCESSOVIVO_ADMIN_USUARIO: 'joao',
  PROCESSOVIVO_ADMIN_SENHA: 'uma-senha-administrativa-bem-forte',
};

function montar(extra: Record<string, string>) {
  return montarAplicacao(carregarConfig({ ...BASE, ...extra } as NodeJS.ProcessEnv));
}

describe('o modelo por função na composição (Fase B)', () => {
  it('sem IA no ambiente: o modelo vem do ambiente e o teste é indisponível, mas o painel lê', () => {
    const app = montar({});
    try {
      expect(app.modelosDeIa.efetivo('ato')).toMatchObject({ modelo: 'deepseek/deepseek-v4-flash', origem: 'ambiente' });
      expect(app.testeDeModelo.disponivel).toBe(false);
    } finally {
      app.encerrar();
    }
  });

  it('com IA ligada: o teste é disponível, o teto da rodada é US$ 1 e cada função segue o seu ambiente', () => {
    const app = montar({ ...IA, PROCESSOVIVO_IA_MODELO: 'fab/producao', PROCESSOVIVO_IA_PECAS_MODELO: 'fab/pecas' });
    try {
      expect(app.testeDeModelo.disponivel).toBe(true);
      expect(app.testeDeModelo.teto).toBe(1);
      expect(app.modelosDeIa.efetivo('ato').modelo).toBe('fab/producao');
      expect(app.modelosDeIa.efetivo('resumo').modelo).toBe('fab/producao');
      expect(app.modelosDeIa.efetivo('peca').modelo).toBe('fab/pecas');
    } finally {
      app.encerrar();
    }
  });

  it('ninguém sai do modelo do ambiente sem um teste válido: o painel recém-criado não tem modelo gravado', () => {
    const app = montar({ ...IA });
    try {
      expect(app.modelosDeIa.gravados().ato.modelo).toBeNull();
      expect(() => app.modelosDeIa.publicar('op', 'ato', { testeId: 'inventado', confirmado: true })).toThrowError(
        /Teste não encontrado/,
      );
    } finally {
      app.encerrar();
    }
  });
});

describe('o painel de IA na composição', () => {
  it('IA desligada no ambiente: nenhuma função liga, e o painel NÃO a liga', () => {
    const app = montar({});
    try {
      expect(app.analiseIa).toBeUndefined();
      expect(app.controleDaIa.ligada('ato')).toBe(false);
      expect(app.controleDaIa.ligada('resumo')).toBe(false);
      expect(() =>
        app.controleDaIa.ligarOuDesligar('op', 'ato', true, false),
      ).toThrowError(/ambiente do servidor desligou/);
      expect(app.controleDaIa.ligada('ato')).toBe(false);
      expect(app.agendadorAlertaDeCustoDaIa).toBeUndefined();
    } finally {
      app.encerrar();
    }
  });

  it('IA ligada: ato e resumo valem; a peça só com uma das duas chaves e a Pasta digital', () => {
    const app = montar({ ...IA });
    try {
      expect(app.controleDaIa.ligada('ato')).toBe(true);
      expect(app.controleDaIa.ligada('resumo')).toBe(true);
      expect(app.controleDaIa.ligada('peca')).toBe(false);
      expect(app.analiseIa?.disponivel()).toBe(true);
      app.controleDaIa.ligarOuDesligar('op', 'ato', false, true);
      expect(app.analiseIa?.disponivel()).toBe(false);
      expect(app.resumoDoProcesso?.disponivel()).toBe(true);
    } finally {
      app.encerrar();
    }
  });

  it('o teto efetivo mostrado é o menor entre PROCESSOVIVO_IA_MAX_POR_DIA e o painel', () => {
    const app = montar({ ...IA, PROCESSOVIVO_IA_MAX_POR_DIA: '5' });
    try {
      expect(app.controleDaIa.estados()[0]?.tetoEfetivoPorConta).toBe(5);
      app.controleDaIa.definirTetoDaFuncao('op', 'ato', 3);
      expect(app.controleDaIa.estados()[0]?.tetoEfetivoPorConta).toBe(3);
      app.controleDaIa.definirTetoDaFuncao('op', 'ato', 900);
      expect(app.controleDaIa.estados()[0]?.tetoEfetivoPorConta).toBe(5);
    } finally {
      app.encerrar();
    }
  });

  it('o alerta de custo só nasce com a IA ligada E o /admin configurado', () => {
    const semAdmin = montar({ ...IA });
    const semIa = montar({ ...ADMIN });
    const completo = montar({ ...IA, ...ADMIN });
    try {
      expect(semAdmin.agendadorAlertaDeCustoDaIa).toBeUndefined();
      expect(semIa.agendadorAlertaDeCustoDaIa).toBeUndefined();
      expect(completo.agendadorAlertaDeCustoDaIa).toBeDefined();
    } finally {
      semAdmin.encerrar();
      semIa.encerrar();
      completo.encerrar();
    }
  });
});

describe('PROCESSOVIVO_ADMIN_EMAIL', () => {
  const cfg = (extra: Record<string, string>) =>
    carregarConfig({ ...BASE, ...extra } as NodeJS.ProcessEnv).admin.email;

  it('vazio por padrão (só o banner)', () => {
    expect(cfg({})).toBe('');
  });

  it('usa a variável própria, sem espaços', () => {
    expect(cfg({ PROCESSOVIVO_ADMIN_EMAIL: '  operador@exemplo.test ' })).toBe(
      'operador@exemplo.test',
    );
  });

  it('cai no e-mail do operador do pagamento quando a própria está vazia', () => {
    expect(cfg({ PROCESSOVIVO_PAGAMENTO_AVISO_EMAIL: 'pagamentos@exemplo.test' })).toBe(
      'pagamentos@exemplo.test',
    );
    expect(
      cfg({
        PROCESSOVIVO_ADMIN_EMAIL: 'operador@exemplo.test',
        PROCESSOVIVO_PAGAMENTO_AVISO_EMAIL: 'pagamentos@exemplo.test',
      }),
    ).toBe('operador@exemplo.test');
  });
});
