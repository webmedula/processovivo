import { describe, expect, it } from 'vitest';
import {
  Assinatura,
  DIAS_DE_CARENCIA_PADRAO,
  assinaturaDeTeste,
} from '../../src/domain/entities/Assinatura.js';
import {
  PLANOS_INICIAIS,
  RECURSOS,
  RECURSOS_PADRAO_DE_PLANO_NOVO,
  menorPlanoCom,
  planoInclui,
  planosAVenda,
  validarPlano,
} from '../../src/domain/entities/Plano.js';
import type { Plano } from '../../src/domain/entities/Plano.js';
import {
  REGRAS_PADRAO,
  validarRegras,
} from '../../src/domain/entities/RegrasDeAssinatura.js';
import {
  PlanoInvalidoError,
  RegrasDeAssinaturaInvalidasError,
} from '../../src/domain/errors/index.js';
import { planoInicial } from '../helpers/planos.js';

const ACOMPANHAMENTO = planoInicial('acompanhamento');
const PECAS = planoInicial('pecas');
const IA = planoInicial('ia');

function plano(mudancas: Partial<Plano> = {}): Plano {
  return {
    codigo: 'pecas-anual',
    nome: 'Peças anual',
    resumo: 'O plano Peças, pago por ano.',
    recursos: ['consulta', 'acompanhamento', 'vigilancia', 'pecas'],
    disponivelParaContratacao: true,
    precoMensalCentavos: 8990,
    ordem: 25,
    ...mudancas,
  };
}

const T0 = new Date('2026-09-22T12:00:00.000Z');
const dias = (n: number): Date => new Date(T0.getTime() + n * 86_400_000);

function paga(venceEmDias: number, carencia = DIAS_DE_CARENCIA_PADRAO): Assinatura {
  return new Assinatura({
    workspace: 'ws1',
    plano: 'pecas',
    inicioEm: T0,
    venceEm: dias(venceEmDias),
    ehTeste: false,
    diasDeCarencia: carencia,
  });
}

describe('Plano — a semente', () => {
  it('cada plano inclui os recursos do anterior', () => {
    // A escada precisa ser cumulativa: um assinante que sobe de plano não pode
    // PERDER nada no caminho. É o tipo de erro que só aparece no dia da troca.
    for (const recurso of ACOMPANHAMENTO.recursos) expect(PECAS.recursos).toContain(recurso);
    for (const recurso of PECAS.recursos) expect(IA.recursos).toContain(recurso);
  });

  it('só o plano de peças para cima inclui peças', () => {
    expect(planoInclui(ACOMPANHAMENTO, 'pecas')).toBe(false);
    expect(planoInclui(PECAS, 'pecas')).toBe(true);
    expect(planoInclui(IA, 'pecas')).toBe(true);
  });

  it('o plano de IA nasce fora de venda, e a semente inteira é válida', () => {
    expect(IA.disponivelParaContratacao).toBe(false);
    expect(planosAVenda(PLANOS_INICIAIS).map((p) => p.codigo)).toEqual(['acompanhamento', 'pecas']);
    for (const p of PLANOS_INICIAIS) expect(() => validarPlano(p)).not.toThrow();
  });

  it('o teste padrão entrega o plano que mostra o diferencial', () => {
    expect(REGRAS_PADRAO.planoDoTeste).toBe('pecas');
    expect(REGRAS_PADRAO.diasDeTeste).toBe(14);
    expect(() => validarRegras(REGRAS_PADRAO, PLANOS_INICIAIS)).not.toThrow();
  });
});

describe('Plano — validação', () => {
  it('a análise com IA está marcada como AINDA NÃO EXISTENTE', () => {
    /*
     * O teste que protege a promessa. Antes (até a v0.27.0) a trava era um
     * `false` fixo no plano de IA; agora é do RECURSO, e vale para qualquer
     * plano que o inclua — inclusive um criado pelo painel. Quando a análise
     * ficar pronta, este teste falha e é a hora de mudá-lo conscientemente.
     */
    expect(RECURSOS.find((r) => r.recurso === 'analiseIa')?.implementado).toBe(false);
  });

  it('recusa colocar à venda um plano com recurso que não existe', () => {
    expect(() => validarPlano({ ...IA, disponivelParaContratacao: true })).toThrow(
      PlanoInvalidoError,
    );
    expect(() =>
      validarPlano(plano({ recursos: ['consulta', 'analiseIa'], disponivelParaContratacao: true })),
    ).toThrow(/ainda não existe/);
  });

  it('o mesmo plano, pausado, é válido — pode ser modelado antes de existir', () => {
    expect(() => validarPlano({ ...IA, disponivelParaContratacao: false })).not.toThrow();
  });

  it('aceita um plano novo bem formado', () => {
    expect(() => validarPlano(plano())).not.toThrow();
    expect(() => validarPlano(plano({ precoMensalCentavos: null }))).not.toThrow();
  });

  it.each([
    ['código com maiúscula', { codigo: 'Pecas' }],
    ['código com espaço', { codigo: 'pecas anual' }],
    ['código de uma letra', { codigo: 'p' }],
    ['nome vazio', { nome: '   ' }],
    ['descrição vazia', { resumo: '' }],
    ['nenhum recurso', { recursos: [] }],
    ['recurso repetido', { recursos: ['consulta', 'consulta'] as Plano['recursos'] }],
    ['recurso desconhecido', { recursos: ['teletransporte'] as unknown as Plano['recursos'] }],
    ['preço negativo', { precoMensalCentavos: -1 }],
    ['preço com fração de centavo', { precoMensalCentavos: 49.5 }],
    ['preço absurdo', { precoMensalCentavos: 10_000_001 }],
    ['ordem negativa', { ordem: -1 }],
  ])('recusa %s', (_nome, mudancas) => {
    expect(() => validarPlano(plano(mudancas as Partial<Plano>))).toThrow(PlanoInvalidoError);
  });
});

describe('Plano — qual sugerir', () => {
  it('sugere o menor plano À VENDA que inclui o recurso', () => {
    expect(menorPlanoCom(PLANOS_INICIAIS, 'pecas')?.codigo).toBe('pecas');
    expect(menorPlanoCom(PLANOS_INICIAIS, 'vigilancia')?.codigo).toBe('acompanhamento');
  });

  it('se nenhum à venda inclui, cai para o primeiro que inclui', () => {
    expect(menorPlanoCom(PLANOS_INICIAIS, 'analiseIa')?.codigo).toBe('ia');
  });

  it('nenhum plano inclui: não inventa sugestão', () => {
    expect(menorPlanoCom([ACOMPANHAMENTO], 'pecas')).toBeUndefined();
  });
});

describe('Regras de assinatura — validação', () => {
  it.each([
    ['teste de zero dias', { diasDeTeste: 0 }],
    ['teste de 91 dias', { diasDeTeste: 91 }],
    ['carência negativa', { diasDeCarencia: -1 }],
    ['carência de 61 dias', { diasDeCarencia: 61 }],
    ['plano do teste inexistente', { planoDoTeste: 'platina' }],
    ['plano do teste com recurso que não existe', { planoDoTeste: 'ia' }],
  ])('recusa %s', (_nome, mudancas) => {
    expect(() => validarRegras({ ...REGRAS_PADRAO, ...mudancas }, PLANOS_INICIAIS)).toThrow(
      RegrasDeAssinaturaInvalidasError,
    );
  });

  it('aceita carência zero e teste no plano mais simples', () => {
    expect(() =>
      validarRegras(
        { diasDeTeste: 7, planoDoTeste: 'acompanhamento', diasDeCarencia: 0 },
        PLANOS_INICIAIS,
      ),
    ).not.toThrow();
  });
});

describe('Assinatura', () => {
  it('a linha do tempo de uma assinatura paga', () => {
    const a = paga(30);

    expect(a.statusEm(T0)).toBe('ativa');
    expect(a.statusEm(dias(29))).toBe('ativa');
    // Vence no dia 30, e a carência de 7 dias segura até o 37.
    expect(a.statusEm(dias(31))).toBe('carencia');
    expect(a.statusEm(dias(36))).toBe('carencia');
    expect(a.statusEm(dias(38))).toBe('vencida');
  });

  it('durante a carência o acesso continua aberto', () => {
    // O ponto inteiro da carência. Se `permite` fechasse aqui, a vigilância
    // pararia no minuto do vencimento — que costuma ser cartão recusado, não
    // decisão de cancelar — e o advogado deixaria de receber aviso de prazo
    // sem saber que deixou.
    const a = paga(10);
    expect(a.permite('vigilancia', dias(12), PECAS)).toBe(true);
    expect(a.permite('pecas', dias(12), PECAS)).toBe(true);
    expect(a.permite('vigilancia', dias(20), PECAS)).toBe(false);
  });

  it('o cancelamento vence qualquer data de vigência', () => {
    const a = paga(90).cancelada(dias(5));
    expect(a.statusEm(dias(4))).toBe('ativa');
    expect(a.statusEm(dias(6))).toBe('cancelada');
    expect(a.permite('consulta', dias(6), PECAS)).toBe(false);
  });

  it('plano vigente não libera recurso que o plano não tem', () => {
    // As duas perguntas são independentes, e `permite` é a conjunção delas.
    // Quem chama não deve refazer essa conta — foi por isso que ela veio parar
    // na entidade.
    const a = new Assinatura({
      workspace: 'ws1',
      plano: 'acompanhamento',
      inicioEm: T0,
      venceEm: dias(30),
      ehTeste: false,
      diasDeCarencia: 7,
    });
    expect(a.permite('acompanhamento', T0, ACOMPANHAMENTO)).toBe(true);
    expect(a.permite('pecas', T0, ACOMPANHAMENTO)).toBe(false);
  });

  it('dias para vencer arredonda para cima', () => {
    // Faltando 30 horas, a tela diz "2 dias". Arredondar para baixo anunciaria
    // um prazo MENOR que o real — num produto sobre prazo, é o erro na direção
    // errada.
    const a = paga(2);
    const trintaHorasAntes = new Date(a.venceEm.getTime() - 30 * 3_600_000);
    expect(a.diasParaVencer(trintaHorasAntes)).toBe(2);
    expect(a.diasParaVencer(dias(5))).toBeLessThan(0);
  });

  it('renovar em dia soma ao vencimento, não à data de hoje', () => {
    // Quem renova antes de vencer não pode PERDER os dias que já pagou. Esse
    // detalhe é invisível até o assinante conferir a data e reclamar — com
    // razão.
    const a = paga(20);
    const r = a.renovada({ meses: 1, agora: dias(10) });

    const esperado = new Date(a.venceEm.getTime());
    esperado.setMonth(esperado.getMonth() + 1);
    expect(r.venceEm.toISOString()).toBe(esperado.toISOString());
  });

  it('renovar depois de vencido conta a partir de hoje', () => {
    // O outro lado da mesma moeda: não se cobra por período em que o serviço
    // esteve fechado.
    const a = paga(5);
    const r = a.renovada({ meses: 1, agora: dias(40) });

    const esperado = dias(40);
    esperado.setMonth(esperado.getMonth() + 1);
    expect(r.venceEm.toISOString()).toBe(esperado.toISOString());
  });

  it('permite recusa o plano de OUTRA assinatura — é erro de programação', () => {
    expect(() => paga(30).permite('pecas', T0, ACOMPANHAMENTO)).toThrow(/não é o desta/);
  });

  it('renovar vindo do teste ganha a carência padrão, não a zero do teste', () => {
    const t = assinaturaDeTeste({ workspace: 'ws1', plano: 'pecas', agora: T0 });
    expect(t.diasDeCarencia).toBe(0);
    expect(t.renovada({ meses: 1, agora: dias(3) }).diasDeCarencia).toBe(DIAS_DE_CARENCIA_PADRAO);
    // Informada, vale a informada — é o que a liberação faz com as regras vigentes.
    expect(t.renovada({ meses: 1, agora: dias(3), diasDeCarencia: 3 }).diasDeCarencia).toBe(3);
  });

  it('renovar assinatura paga mantém a carência dela', () => {
    expect(paga(30, 5).renovada({ meses: 1, agora: T0 }).diasDeCarencia).toBe(5);
  });

  it('renovar encerra o teste', () => {
    const t = assinaturaDeTeste({ workspace: 'ws1', plano: 'pecas', agora: T0 });
    expect(t.statusEm(dias(3))).toBe('teste');

    const r = t.renovada({ meses: 1, agora: dias(3) });
    expect(r.ehTeste).toBe(false);
    expect(r.statusEm(dias(3))).toBe('ativa');
  });

  it('renovar pode trocar de plano', () => {
    const a = paga(10);
    expect(a.renovada({ meses: 3, agora: T0, plano: 'acompanhamento' }).plano).toBe(
      'acompanhamento',
    );
    // Sem informar o plano, mantém o atual.
    expect(a.renovada({ meses: 3, agora: T0 }).plano).toBe('pecas');
  });

  it('o teste dura 14 dias e NÃO tem carência', () => {
    // Quem não pagou nada não fica devendo nada — e esticar o teste em
    // silêncio só adia a decisão de assinar, sem informar ninguém.
    const t = assinaturaDeTeste({ workspace: 'ws1', plano: 'pecas', agora: T0 });

    expect(t.diasParaVencer(T0)).toBe(14);
    expect(t.statusEm(dias(13))).toBe('teste');
    expect(t.statusEm(dias(15))).toBe('vencida');
    expect(t.permite('pecas', dias(15), PECAS)).toBe(false);
  });

  it('a entidade é imutável', () => {
    const a = paga(30);
    expect(Object.isFrozen(a)).toBe(true);
    // Renovar produz outra assinatura; a original não se altera.
    const antes = a.venceEm.toISOString();
    a.renovada({ meses: 6, agora: T0 });
    expect(a.venceEm.toISOString()).toBe(antes);
  });
});

describe('Plano — custosDoProcesso (v0.47.0)', () => {
  it('entra em TODOS os planos da semente e nos planos novos do painel', () => {
    for (const codigo of ['acompanhamento', 'pecas', 'ia']) {
      expect(planoInicial(codigo).recursos).toContain('custosDoProcesso');
    }
    expect(RECURSOS_PADRAO_DE_PLANO_NOVO).toContain('custosDoProcesso');
  });

  it('é um recurso com nome próprio e implementado, para o operador poder restringi-lo depois', () => {
    const r = RECURSOS.find((x) => x.recurso === 'custosDoProcesso');
    expect(r).toMatchObject({ nome: 'Custos do processo', implementado: true });
  });
});

describe('Plano — salvarNoDrive (v0.42.0)', () => {
  it('entra nos planos Peças e IA da semente — e no Acompanhamento NÃO', () => {
    expect(planoInicial('pecas').recursos).toContain('salvarNoDrive');
    expect(planoInicial('ia').recursos).toContain('salvarNoDrive');
    expect(planoInicial('acompanhamento').recursos).not.toContain('salvarNoDrive');
  });

  it('o plano IA continua impossível de pôr à venda: a trava é do analiseIa, e segue de pé', () => {
    expect(() => validarPlano({ ...planoInicial('ia'), disponivelParaContratacao: true })).toThrow(
      PlanoInvalidoError,
    );
    expect(planoInicial('ia').disponivelParaContratacao).toBe(false);
  });

  it('plano novo criado pelo painel NÃO ganha o recurso sozinho: o operador marca', () => {
    expect(RECURSOS_PADRAO_DE_PLANO_NOVO).not.toContain('salvarNoDrive');
  });
});

describe('Plano — recursos (v0.32.0)', () => {
  it('a lista de recursos é esta, nesta ordem', () => {
    /*
     * Fixa a lista. Recurso novo entra aqui na mesma PR — e com a pergunta
     * "os planos já gravados recebem?" respondida em `banco.ts`.
     */
    expect(RECURSOS.map((r) => [r.recurso, r.implementado])).toEqual([
      ['consulta', true],
      ['acompanhamento', true],
      ['vigilancia', true],
      ['calendario', true],
      ['pecas', true],
      ['analiseIa', false],
      // v0.42.0: o envio ao Google Drive existe (`true`); quem o liga é a variável
      // PROCESSOVIVO_DRIVE_HABILITADO (desligada por padrão). A trava da VENDA do plano IA
      // continua sendo `analiseIa` — o recurso novo não a destrava.
      ['salvarNoDrive', true],
      // v0.47.0: o centro de custos existe e entra em todos os planos (decisão do dono).
      ['custosDoProcesso', true],
    ]);
  });

  it('o calendário está em TODOS os planos da semente', () => {
    for (const p of PLANOS_INICIAIS) expect(planoInclui(p, 'calendario')).toBe(true);
  });
});
