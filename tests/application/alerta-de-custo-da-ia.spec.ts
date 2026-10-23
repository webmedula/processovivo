import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAXIMO_DE_TENTATIVAS_POR_DIA,
  ServicoAlertaDeCustoDaIa,
} from '../../src/application/services/ServicoAlertaDeCustoDaIa.js';
import { ServicoControleDaIa } from '../../src/application/services/ServicoControleDaIa.js';
import { ServicoPainelDeIa } from '../../src/application/services/ServicoPainelDeIa.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import type { Mensagem, Notificador } from '../../src/domain/ports/Notificador.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import {
  LeitorDeUsoDeIaSqlite,
  RegistroDeOcorrenciasDeIaSqlite,
  RepositorioDeConfigDeIaSqlite,
  RepositorioDoAlertaDeCustoSqlite,
} from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';
import { LoggerColetor } from '../helpers/analiseIa.js';

/* O alerta de custo diário da IA (v0.58.0): uma vez por dia de São Paulo, sem rede, com relógio e e-mail falsos. */

const EMAIL_DO_OPERADOR = 'operador.sintetico@exemplo.test';

class Relogio implements Clock {
  ms = new Date('2026-10-05T15:00:00.000Z').getTime();
  agora(): Date {
    return new Date(this.ms);
  }
  monotonico(): number {
    return this.ms;
  }
}

class EmailFalso implements Notificador {
  readonly nome = 'falso';
  habilitado = true;
  readonly enviadas: Mensagem[] = [];
  /** Resultados em ordem; depois deles, `true`. */
  respostas: Array<boolean | 'lanca'> = [];
  async enviar(m: Mensagem): Promise<boolean> {
    this.enviadas.push(m);
    const r = this.respostas.shift() ?? true;
    if (r === 'lanca') throw new Error(`falha com ${m.para}`);
    return r;
  }
}

let db: ReturnType<typeof abrirBanco>;
let relogio: Relogio;
let email: EmailFalso;
let logger: LoggerColetor;
let alerta: ServicoAlertaDeCustoDaIa;
let controle: ServicoControleDaIa;

function gastar(usd: number, em: string, tabela = 'analises_ia'): void {
  if (tabela === 'analises_ia') {
    db.prepare(
      `INSERT INTO analises_ia (id, workspace, numero, chave_do_ato, resultado, modelo, versao_prompt, provedor,
         custo_usd, latencia_ms, criada_em) VALUES (?, 'ws', '1', 'c', '{}', 'm', 'p', 'x', ?, 1000, ?)`,
    ).run(`id-${Math.random()}`, usd, em);
  } else {
    db.prepare(
      `INSERT INTO resumos_ia (id, workspace, numero, resultado, atos_enviados, contagens, modelo, versao_prompt,
         provedor, custo_usd, latencia_ms, criada_em) VALUES (?, 'ws', '1', '{}', '[]', '{}', 'm', 'p', 'x', ?, 1000, ?)`,
    ).run(`id-${Math.random()}`, usd, em);
  }
}

function montar(opcoes: { destinatario?: string; urlBase?: string } = {}): void {
  const ocorrencias = new RegistroDeOcorrenciasDeIaSqlite(db, relogio, logger);
  controle = new ServicoControleDaIa({
    repositorio: new RepositorioDeConfigDeIaSqlite(db),
    ambiente: {
      permite: { ato: true, resumo: true, peca: true },
      tetoPorContaDoAmbiente: 200,
    },
    clock: relogio,
    logger,
    validadeDoCacheMs: 0,
  });
  alerta = new ServicoAlertaDeCustoDaIa({
    painel: new ServicoPainelDeIa({
      controle,
      leitor: new LeitorDeUsoDeIaSqlite(db, ocorrencias),
      clock: relogio,
    }),
    repositorio: new RepositorioDoAlertaDeCustoSqlite(db),
    notificador: email,
    destinatario: opcoes.destinatario ?? EMAIL_DO_OPERADOR,
    urlBase: opcoes.urlBase ?? 'https://app.exemplo.test',
    clock: relogio,
    logger,
  });
}

beforeEach(() => {
  db = abrirBanco(':memory:');
  relogio = new Relogio();
  email = new EmailFalso();
  logger = new LoggerColetor();
  montar();
});

describe('alerta de custo diário', () => {
  it('abaixo do limite (padrão US$ 3,00) não manda nada', async () => {
    gastar(2.99, '2026-10-05T14:00:00.000Z');
    expect(await alerta.executar()).toBe('sem_excesso');
    expect(email.enviadas).toEqual([]);
  });

  it('passou do limite: manda UM e-mail só com data, valor do dia, limite e o link da tela "IA"', async () => {
    gastar(2, '2026-10-05T14:00:00.000Z');
    gastar(1.5, '2026-10-05T14:30:00.000Z', 'resumos_ia');
    expect(await alerta.executar()).toBe('enviado');
    expect(email.enviadas).toHaveLength(1);
    const m = email.enviadas[0] as Mensagem;
    expect(m.para).toBe(EMAIL_DO_OPERADOR);
    expect(m.texto).toBe(
      'Data: 05/10/2026\nCusto da IA no dia: US$ 3,50\nLimite do alerta: US$ 3,00\n' +
        '\nPainel de IA: https://app.exemplo.test/admin#ia\n',
    );
    expect(m.assunto).not.toMatch(/\d/);
  });

  it('não repete no mesmo dia, mesmo rodando de novo e com o custo subindo', async () => {
    gastar(4, '2026-10-05T14:00:00.000Z');
    await alerta.executar();
    gastar(10, '2026-10-05T16:00:00.000Z');
    relogio.ms += 3_600_000;
    expect(await alerta.executar()).toBe('ja_enviado');
    expect(await alerta.executar()).toBe('ja_enviado');
    expect(email.enviadas).toHaveLength(1);
  });

  it('o dia vira em São Paulo (03:00 UTC): 02:59Z ainda é o mesmo dia, 03:00Z é o seguinte', async () => {
    relogio.ms = new Date('2026-10-06T02:30:00.000Z').getTime();
    gastar(5, '2026-10-06T01:00:00.000Z');
    expect(await alerta.executar()).toBe('enviado');
    relogio.ms = new Date('2026-10-06T02:59:00.000Z').getTime();
    expect(await alerta.executar()).toBe('ja_enviado');
    // 03:00Z: dia novo, custo zerado (o gasto de antes é de ontem).
    relogio.ms = new Date('2026-10-06T03:00:00.000Z').getTime();
    expect(await alerta.executar()).toBe('sem_excesso');
    gastar(5, '2026-10-06T03:10:00.000Z');
    expect(await alerta.executar()).toBe('enviado');
    expect(email.enviadas).toHaveLength(2);
    expect((email.enviadas[1] as Mensagem).texto).toContain('Data: 06/10/2026');
  });

  it('o limite ajustado no painel vale', async () => {
    gastar(4, '2026-10-05T14:00:00.000Z');
    controle.definirAlertaDeCusto('op', 10);
    expect(await alerta.executar()).toBe('sem_excesso');
    controle.definirAlertaDeCusto('op', 1);
    expect(await alerta.executar()).toBe('enviado');
  });

  it('falha de envio: soma tentativa, vai ao log sem dado pessoal, tenta de novo só no próximo ciclo e para em 3', async () => {
    gastar(4, '2026-10-05T14:00:00.000Z');
    email.respostas = [false, 'lanca', false, true];
    expect(await alerta.executar()).toBe('falhou');
    expect(await alerta.executar()).toBe('falhou');
    expect(await alerta.executar()).toBe('falhou');
    expect(MAXIMO_DE_TENTATIVAS_POR_DIA).toBe(3);
    expect(await alerta.executar()).toBe('limite_de_tentativas');
    expect(email.enviadas).toHaveLength(3);
    const log = logger.linhas.join('\n');
    expect(log).toContain('alerta de custo da IA não enviado');
    expect(log).not.toContain(EMAIL_DO_OPERADOR);
    expect(log).not.toContain('falha com');
  });

  it('a segunda tentativa que dá certo encerra o dia', async () => {
    gastar(4, '2026-10-05T14:00:00.000Z');
    email.respostas = [false, true];
    expect(await alerta.executar()).toBe('falhou');
    expect(await alerta.executar()).toBe('enviado');
    expect(await alerta.executar()).toBe('ja_enviado');
  });

  it('no dia seguinte as tentativas recomeçam', async () => {
    gastar(4, '2026-10-05T14:00:00.000Z');
    email.respostas = [false, false, false];
    for (let i = 0; i < 3; i++) await alerta.executar();
    expect(await alerta.executar()).toBe('limite_de_tentativas');
    relogio.ms = new Date('2026-10-06T15:00:00.000Z').getTime();
    gastar(4, '2026-10-06T14:00:00.000Z');
    expect(await alerta.executar()).toBe('enviado');
  });

  it('sem e-mail do operador, ou sem entrega de verdade: não envia e não gasta tentativa (o banner continua)', async () => {
    gastar(4, '2026-10-05T14:00:00.000Z');
    montar({ destinatario: '' });
    expect(await alerta.executar()).toBe('sem_destino');
    email.habilitado = false;
    montar();
    expect(await alerta.executar()).toBe('sem_destino');
    expect(email.enviadas).toEqual([]);
    email.habilitado = true;
    expect(await alerta.executar()).toBe('enviado');
  });

  it('sem URL base o e-mail sai sem o link (nunca com um endereço inventado)', async () => {
    gastar(4, '2026-10-05T14:00:00.000Z');
    montar({ urlBase: '' });
    await alerta.executar();
    expect((email.enviadas[0] as Mensagem).texto).not.toContain('http');
  });

  it('o banner independe do e-mail: o custo do dia acima do limite aparece no painel', () => {
    gastar(4, '2026-10-05T14:00:00.000Z');
    const painel = new ServicoPainelDeIa({
      controle,
      leitor: new LeitorDeUsoDeIaSqlite(
        db,
        new RegistroDeOcorrenciasDeIaSqlite(db, relogio, logger),
      ),
      clock: relogio,
    });
    expect(painel.custoDoDia()).toEqual({ usd: 4, alertaUsd: 3, acima: true });
  });
});
