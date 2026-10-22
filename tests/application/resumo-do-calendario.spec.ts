import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HORA_DO_RESUMO,
  MAXIMO_DE_TENTATIVAS_POR_ITEM,
  ServicoResumoDoCalendario,
} from '../../src/application/services/ServicoResumoDoCalendario.js';
import { MAXIMO_DE_ITENS_NO_EMAIL } from '../../src/application/politicas/mensagemDoResumoDoCalendario.js';
import { EventoDeCalendario } from '../../src/domain/entities/EventoDeCalendario.js';
import type { Notificador } from '../../src/domain/ports/Notificador.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDeEventosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeEventosSqlite.js';
import { RepositorioDoResumoDoCalendarioSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDoResumoDoCalendarioSqlite.js';
import { RepositorioUsuariosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioUsuariosSqlite.js';

/*
 * Resumo por e-mail dos eventos a confirmar (v0.51.0): banco SQLite em memória de verdade, relógio
 * injetado, e um notificador FALSO — nenhum e-mail real sai daqui. Contas, números e textos: SINTÉTICOS.
 */

const NUMERO = '12345674720238260100';
const FORMATADO = '1234567-47.2023.8.26.0100';
const ANDAMENTO = new Date('2026-10-20T15:00:00.000Z');
/** 08:00 em São Paulo (UTC-3) de 22/10/2026. */
const AS_OITO = new Date('2026-10-22T11:00:00.000Z');

class NotificadorFalso implements Notificador {
  readonly nome = 'falso';
  readonly habilitado = true;
  readonly enviadas: Array<{ para: string; assunto: string; texto: string }> = [];
  falhar = false;
  tentativas = 0;
  async enviar(m: { para: string; assunto: string; texto: string }): Promise<boolean> {
    this.tentativas++;
    if (this.falhar) return false;
    this.enviadas.push(m);
    return true;
  }
}

let db: ReturnType<typeof abrirBanco>;
let eventos: RepositorioDeEventosSqlite;
let usuarios: RepositorioUsuariosSqlite;
let notificador: NotificadorFalso;
let agora: Date;
let contador = 0;

function servico(
  opcoes: { habilitado?: boolean; urlBase?: string } = {},
): ServicoResumoDoCalendario {
  return new ServicoResumoDoCalendario({
    repositorio: new RepositorioDoResumoDoCalendarioSqlite(db),
    usuarios,
    notificador,
    logger: loggerSilencioso,
    urlBase: opcoes.urlBase ?? 'https://app.exemplo.test',
    habilitado: opcoes.habilitado ?? true,
    agora: () => agora,
  });
}

async function conta(email: string): Promise<string> {
  return (await usuarios.criar({ email, nome: 'Pessoa Sintética', senhaGuardada: 'x' }))
    .workspace;
}

/** Sugestão detectada, com a procedência pedida. */
async function sugestao(
  workspace: string,
  extra: {
    dataLocal?: string;
    horaLocal?: string;
    sigilo?: boolean;
    numero?: string;
    chave?: string;
  } = {},
): Promise<EventoDeCalendario> {
  contador++;
  const e = EventoDeCalendario.sugerido({
    id: `ev-${contador}`,
    workspace,
    numeroProcesso: extra.numero ?? NUMERO,
    tribunal: 'TJSP',
    segredoJustica: extra.sigilo ?? false,
    sugestao: {
      tipo: 'audiencia',
      titulo: 'Audiência com FULANA SINTÉTICA',
      dataLocal: extra.dataLocal ?? '2026-11-12',
      ...(extra.horaLocal !== undefined
        ? { horaLocal: extra.horaLocal }
        : { horaLocal: '14:30' }),
      procedencia: {
        movimentacaoId: extra.chave ?? `m-${contador}`,
        dataDoAndamento: ANDAMENTO,
        trecho: 'TRECHO-SECRETO com BELTRANO EXEMPLAR',
      },
    },
    agora: ANDAMENTO,
  });
  expect(await eventos.inserirSeNovo(e)).toBe(true);
  return e;
}

beforeEach(() => {
  db = abrirBanco(':memory:');
  eventos = new RepositorioDeEventosSqlite(db);
  usuarios = new RepositorioUsuariosSqlite(db);
  notificador = new NotificadorFalso();
  agora = AS_OITO;
  contador = 0;
});
afterEach(() => db.close());

describe('resumo por e-mail dos eventos a confirmar', () => {
  it('às 08:00 de São Paulo manda UM e-mail com assunto, item e link, e registra o envio', async () => {
    const ws = await conta('ana@exemplo.test');
    await sugestao(ws);
    const r = await servico().executar();
    expect(r).toMatchObject({ contas: 1, itens: 1, enviados: 1, falhas: 0 });
    const [m] = notificador.enviadas;
    expect(m?.para).toBe('ana@exemplo.test');
    expect(m?.assunto).toBe('Processo Vivo: 1 evento(s) para você confirmar');
    expect(m?.texto).toContain(`1. Audiência — 12/11/2026 às 14:30 — ${FORMATADO}`);
    expect(m?.texto).toContain('Data lida do andamento de 20/10, confira no processo.');
    expect(m?.texto).toContain(
      'Revisar no calendário: https://app.exemplo.test/?calendario=resumo',
    );
    expect(m?.texto).toContain(
      'Para deixar de receber este resumo: Calendário > Resumo por e-mail.',
    );
    expect(
      db.prepare('SELECT quantidade, dia_local FROM calendario_resumo_envios').all(),
    ).toEqual([{ quantidade: 1, dia_local: '2026-10-22' }]);
  });

  it('o corpo não leva nome de parte, trecho de andamento, título livre, observação nem as palavras proibidas', async () => {
    const ws = await conta('ana@exemplo.test');
    await sugestao(ws);
    await servico().executar();
    const { texto, assunto } = notificador.enviadas[0] as {
      texto: string;
      assunto: string;
    };
    const tudo = `${assunto}\n${texto}`;
    expect(tudo).not.toMatch(/FULANA|BELTRANO|TRECHO-SECRETO|SINTÉTICA/);
    expect(tudo).not.toMatch(/fatal|urgente|vence|vencimento/i);
  });

  it('só envia dentro da janela das 08:00 às 12:00 (São Paulo), inclusive na virada do dia', async () => {
    const ws = await conta('ana@exemplo.test');
    await sugestao(ws);
    const horarios: Array<[string, boolean]> = [
      ['2026-10-22T10:59:00.000Z', false], // 07:59 SP
      ['2026-10-22T02:30:00.000Z', false], // 23:30 SP do dia 21 (já é dia 22 em UTC)
      ['2026-10-23T02:59:00.000Z', false], // 23:59 SP do dia 22
      ['2026-10-23T03:00:00.000Z', false], // 00:00 SP do dia 23
      ['2026-10-22T15:00:00.000Z', false], // 12:00 SP
      ['2026-10-22T11:00:00.000Z', true], // 08:00 SP
    ];
    expect(HORA_DO_RESUMO).toBe(8);
    for (const [quando, envia] of horarios) {
      agora = new Date(quando);
      const antes = notificador.enviadas.length;
      await servico().executar();
      expect(notificador.enviadas.length - antes, quando).toBe(envia ? 1 : 0);
    }
  });

  it('no máximo UM por dia: repetir o tick no mesmo dia não manda de novo, mesmo com item novo', async () => {
    const ws = await conta('ana@exemplo.test');
    await sugestao(ws);
    const s = servico();
    await s.executar();
    agora = new Date(AS_OITO.getTime() + 15 * 60_000); // o tick seguinte
    await s.executar();
    await sugestao(ws, { dataLocal: '2026-11-13' });
    agora = new Date(AS_OITO.getTime() + 30 * 60_000);
    await s.executar();
    expect(notificador.enviadas).toHaveLength(1);
    // No dia seguinte, o item novo sai — e só ele.
    agora = new Date('2026-10-23T11:00:00.000Z');
    await s.executar();
    expect(notificador.enviadas).toHaveLength(2);
    expect(notificador.enviadas[1]?.assunto).toBe(
      'Processo Vivo: 1 evento(s) para você confirmar',
    );
    expect(notificador.enviadas[1]?.texto).toContain('13/11/2026');
    expect(notificador.enviadas[1]?.texto).not.toContain('12/11/2026');
  });

  it('só novidade: sem item novo desde o último resumo, nada é enviado', async () => {
    const ws = await conta('ana@exemplo.test');
    await sugestao(ws);
    const s = servico();
    await s.executar();
    agora = new Date('2026-10-23T11:00:00.000Z');
    expect(await s.executar()).toMatchObject({ contas: 0, enviados: 0 });
    agora = new Date('2026-10-24T11:00:00.000Z');
    await s.executar();
    expect(notificador.enviadas).toHaveLength(1);
  });

  it('sem nenhum evento a confirmar, nenhuma conta é avisada', async () => {
    await conta('ana@exemplo.test');
    expect(await servico().executar()).toMatchObject({ contas: 0, enviados: 0 });
    expect(notificador.tentativas).toBe(0);
  });

  it('evento já confirmado, descartado ou de data passada não entra', async () => {
    const ws = await conta('ana@exemplo.test');
    const confirmado = (await sugestao(ws)).confirmar(AS_OITO);
    await eventos.salvar(confirmado);
    const descartado = (await sugestao(ws, { dataLocal: '2026-11-14' })).descartar(
      AS_OITO,
    );
    await eventos.salvar(descartado);
    await sugestao(ws, { dataLocal: '2026-10-21' }); // ontem
    expect(await servico().executar()).toMatchObject({ contas: 0 });
  });

  it('limite de 10 itens na lista, com "e mais N"; o assunto conta todos; os excedentes não voltam', async () => {
    const ws = await conta('ana@exemplo.test');
    for (let n = 0; n < 13; n++) {
      await sugestao(ws, { dataLocal: `2026-11-${String(10 + n).padStart(2, '0')}` });
    }
    await servico().executar();
    const m = notificador.enviadas[0];
    expect(MAXIMO_DE_ITENS_NO_EMAIL).toBe(10);
    expect(m?.assunto).toBe('Processo Vivo: 13 evento(s) para você confirmar');
    expect(m?.texto).toContain('10. Audiência');
    expect(m?.texto).not.toContain('11. Audiência');
    expect(m?.texto).toContain('e mais 3.');
    agora = new Date('2026-10-23T11:00:00.000Z');
    expect(await servico().executar()).toMatchObject({ contas: 0 });
  });

  it('item com revisar diz que o andamento mais recente sugere mudança; uma revisão NOVA é avisada, a mesma não', async () => {
    const ws = await conta('ana@exemplo.test');
    const e = await sugestao(ws);
    const confirmado = e.confirmar(AS_OITO);
    await eventos.salvar(confirmado);
    const marcado = confirmado.marcarParaRevisao(
      new Date('2026-10-21T12:00:00.000Z'),
      AS_OITO,
    );
    await eventos.salvar(marcado);
    const s = servico();
    await s.executar();
    expect(notificador.enviadas[0]?.texto).toContain(
      'O andamento mais recente sugere mudança, confira.',
    );
    // Mesma revisão no dia seguinte: nada.
    agora = new Date('2026-10-23T11:00:00.000Z');
    await s.executar();
    expect(notificador.enviadas).toHaveLength(1);
    // Andamento de mudança mais novo: avisa de novo.
    await eventos.salvar(
      marcado.marcarParaRevisao(new Date('2026-10-22T09:00:00.000Z'), agora),
    );
    agora = new Date('2026-10-24T11:00:00.000Z');
    await s.executar();
    expect(notificador.enviadas).toHaveLength(2);
  });

  it('processo em segredo de justiça: "processo sigiloso", sem número', async () => {
    const ws = await conta('ana@exemplo.test');
    await sugestao(ws, { sigilo: true });
    await servico().executar();
    const { texto } = notificador.enviadas[0] as { texto: string };
    expect(texto).toContain('Audiência — 12/11/2026 às 14:30 — processo sigiloso');
    expect(texto).not.toContain(FORMATADO);
    expect(texto).not.toContain(NUMERO);
  });

  it('evento de dia inteiro aparece como "(dia inteiro)"', async () => {
    const ws = await conta('ana@exemplo.test');
    const e = EventoDeCalendario.sugerido({
      id: 'dia',
      workspace: ws,
      numeroProcesso: NUMERO,
      tribunal: 'TJSP',
      segredoJustica: false,
      sugestao: {
        tipo: 'prazo',
        titulo: 'Prazo',
        dataLocal: '2026-11-20',
        procedencia: { movimentacaoId: 'd', dataDoAndamento: ANDAMENTO, trecho: 'x' },
      },
      agora: ANDAMENTO,
    });
    await eventos.inserirSeNovo(e);
    await servico().executar();
    expect(notificador.enviadas[0]?.texto).toContain(
      'Prazo — 20/11/2026 (dia inteiro) —',
    );
  });

  it('isolamento A × B: cada conta recebe só os seus itens, no seu e-mail', async () => {
    const a = await conta('ana@exemplo.test');
    const b = await conta('beto@exemplo.test');
    await sugestao(a, { numero: NUMERO });
    await sugestao(b, { numero: '00000000020238260100', dataLocal: '2026-12-01' });
    await servico().executar();
    expect(notificador.enviadas).toHaveLength(2);
    const paraA = notificador.enviadas.find((m) => m.para === 'ana@exemplo.test');
    const paraB = notificador.enviadas.find((m) => m.para === 'beto@exemplo.test');
    expect(paraA?.texto).toContain('12/11/2026');
    expect(paraA?.texto).not.toContain('01/12/2026');
    expect(paraB?.texto).toContain('01/12/2026');
    expect(paraB?.texto).not.toContain('12/11/2026');
  });

  it('opt-out: conta que desligou o resumo não recebe; religar volta a valer', async () => {
    const ws = await conta('ana@exemplo.test');
    await sugestao(ws);
    const s = servico();
    expect(await s.preferencia(ws)).toBe(true); // padrão: ligado
    await s.definirPreferencia(ws, false);
    expect(await s.preferencia(ws)).toBe(false);
    await s.executar();
    expect(notificador.enviadas).toHaveLength(0);
    await s.definirPreferencia(ws, true);
    await s.executar();
    expect(notificador.enviadas).toHaveLength(1);
  });

  it('opt-out de uma conta não afeta a outra', async () => {
    const a = await conta('ana@exemplo.test');
    const b = await conta('beto@exemplo.test');
    await sugestao(a);
    await sugestao(b);
    const s = servico();
    await s.definirPreferencia(a, false);
    await s.executar();
    expect(notificador.enviadas.map((m) => m.para)).toEqual(['beto@exemplo.test']);
  });

  it('chave global desligada: nenhum envio, nenhuma tentativa, nenhum registro', async () => {
    const ws = await conta('ana@exemplo.test');
    await sugestao(ws);
    const s = servico({ habilitado: false });
    expect(await s.executar()).toEqual({ contas: 0, itens: 0, enviados: 0, falhas: 0 });
    expect(notificador.tentativas).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM calendario_resumo_envios').get(),
    ).toEqual({ n: 0 });
  });

  it('conta de chave de API (sem usuário, sem e-mail) é ignorada', async () => {
    await sugestao('0123456789abcdef0123456789abcdef');
    expect(await servico().executar()).toMatchObject({ contas: 0 });
    expect(notificador.tentativas).toBe(0);
  });

  it('falha de envio: não lança, não marca como avisado e tenta de novo no tick seguinte', async () => {
    const ws = await conta('ana@exemplo.test');
    await sugestao(ws);
    const s = servico();
    notificador.falhar = true;
    expect(await s.executar()).toMatchObject({ enviados: 0, falhas: 1 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM calendario_resumo_envios').get(),
    ).toEqual({ n: 0 });
    notificador.falhar = false;
    agora = new Date(AS_OITO.getTime() + 15 * 60_000);
    expect(await s.executar()).toMatchObject({ enviados: 1, falhas: 0 });
    expect(notificador.enviadas).toHaveLength(1);
  });

  it('falhas repetidas: no máximo 3 tentativas por item, depois ele para de ser tentado', async () => {
    const ws = await conta('ana@exemplo.test');
    await sugestao(ws);
    const s = servico();
    notificador.falhar = true;
    for (let n = 0; n < 6; n++) {
      agora = new Date(AS_OITO.getTime() + n * 15 * 60_000);
      await s.executar();
    }
    expect(MAXIMO_DE_TENTATIVAS_POR_ITEM).toBe(3);
    expect(notificador.tentativas).toBe(3);
    // Mesmo com o SMTP de volta, o item esgotado não é reenviado; um item NOVO é.
    notificador.falhar = false;
    agora = new Date('2026-10-23T11:00:00.000Z');
    expect(await s.executar()).toMatchObject({ contas: 0 });
    await sugestao(ws, { dataLocal: '2026-11-30' });
    await s.executar();
    expect(notificador.enviadas).toHaveLength(1);
    expect(notificador.enviadas[0]?.texto).toContain('30/11/2026');
    expect(notificador.enviadas[0]?.texto).not.toContain('12/11/2026');
  });

  it('um notificador que LANÇA não derruba a rodada nem as outras contas', async () => {
    const a = await conta('ana@exemplo.test');
    const b = await conta('beto@exemplo.test');
    await sugestao(a);
    await sugestao(b);
    const original = notificador.enviar.bind(notificador);
    notificador.enviar = async (m) => {
      if (m.para === 'ana@exemplo.test')
        throw new Error('SMTP caiu para ana@exemplo.test');
      return original(m);
    };
    const r = await servico().executar();
    expect(r).toMatchObject({ enviados: 1, falhas: 1 });
    expect(notificador.enviadas.map((m) => m.para)).toEqual(['beto@exemplo.test']);
  });

  it('prévia: conta contas e itens sem enviar nem gravar nada, também fora da janela', async () => {
    const a = await conta('ana@exemplo.test');
    const b = await conta('beto@exemplo.test');
    await sugestao(a);
    await sugestao(a, { dataLocal: '2026-11-13' });
    await sugestao(b);
    agora = new Date('2026-10-22T20:00:00.000Z'); // 17:00 SP, fora da janela
    const p = await servico().previa();
    expect(p).toMatchObject({ contas: 2, itens: 3 });
    expect(notificador.tentativas).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM calendario_resumo_envios').get(),
    ).toEqual({ n: 0 });
  });

  it('o registro de envio e de itens não guarda e-mail, número, nome nem texto', async () => {
    const ws = await conta('ana@exemplo.test');
    await sugestao(ws);
    await servico().executar();
    const tudo = JSON.stringify([
      db.prepare('SELECT * FROM calendario_resumo_envios').all(),
      db.prepare('SELECT * FROM calendario_resumo_itens').all(),
      db.prepare('SELECT * FROM calendario_resumo_preferencias').all(),
    ]);
    expect(tudo).not.toMatch(/ana@exemplo|FULANA|TRECHO-SECRETO|12345674720238260100/);
  });
});
