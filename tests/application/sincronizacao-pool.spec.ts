import { describe, expect, it } from 'vitest';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import {
  carregarConfig,
  interpretarConcorrenciaDaSincronizacao,
} from '../../src/infrastructure/config/env.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import { LoggerColetor } from '../helpers/analiseIa.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';
import type { Logger } from '../../src/domain/ports/Logger.js';

/*
 * v0.49.3 — a varredura verifica vários processos AO MESMO TEMPO (pool de trabalhadores), a tela recebe o progresso
 * real e quem sempre falha vai para o fim da fila. Sem rede e sem tempo real: o provedor trava em portões que o teste
 * solta, o relógio e a espera são injetados. Números sintéticos com dígito verificador válido.
 */
const A = 'ws-a';
const B = 'ws-b';
const n = (i: number): string =>
  NumeroCNJ.criar(numeroValido(8800 + i, '26', '0100')).digitos;

function processo(numero: string): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal: 'TJSP',
    movimentacoes: [],
    procedencia: { provider: 'datajud+djen', consultadoEm: new Date(0), deCache: false },
  });
}

/** Provedor que só responde quando o teste solta o número, e que mede a simultaneidade. */
function provedorMedido(falham: ReadonlySet<string> = new Set()) {
  const portoes = new Map<string, () => void>();
  const estado = { ativos: 0, maximo: 0, sobreposicaoDoMesmoNumero: false };
  const iniciados: string[] = [];
  const emVoo = new Map<string, number>();
  const provider = new ProviderFalso({
    nome: 'medido',
    porNumero: (numero) =>
      new Promise((resolver, rejeitar) => {
        estado.ativos++;
        estado.maximo = Math.max(estado.maximo, estado.ativos);
        iniciados.push(numero);
        const dentro = (emVoo.get(numero) ?? 0) + 1;
        emVoo.set(numero, dentro);
        if (dentro > 1) estado.sobreposicaoDoMesmoNumero = true;
        portoes.set(numero, () => {
          estado.ativos--;
          emVoo.set(numero, (emVoo.get(numero) ?? 1) - 1);
          if (falham.has(numero)) rejeitar(new Error('fonte fora do ar'));
          else resolver(processo(numero));
        });
      }),
  });
  const virar = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
  };
  const liberar = async (numero: string): Promise<void> => {
    for (let i = 0; i < 200 && !portoes.has(numero); i++)
      await new Promise((r) => setImmediate(r));
    const solta = portoes.get(numero);
    portoes.delete(numero);
    solta?.();
    await virar();
  };
  const liberarTodos = async (): Promise<void> => {
    for (let i = 0; i < 40; i++) {
      const pendentes = [...portoes.keys()];
      if (pendentes.length === 0 && i > 3) return;
      for (const numero of pendentes) await liberar(numero);
      await virar();
    }
  };
  return {
    provider,
    estado,
    iniciados,
    liberar,
    liberarTodos,
    virar,
    pendentes: () => portoes.size,
  };
}

async function montar(
  numeros: Array<[string, string]>,
  opcoes: {
    concorrencia?: number;
    pausaMs?: number;
    agora?: () => Date;
    dormir?: (ms: number) => Promise<void>;
    falham?: ReadonlySet<string>;
    logger?: Logger;
  } = {},
) {
  const db = abrirBanco(':memory:');
  const repositorio = new RepositorioAcompanhamentosSqlite(db);
  const t = provedorMedido(opcoes.falham);
  const servico = new ServicoAcompanhamento({
    repositorio,
    provider: t.provider,
    logger: opcoes.logger ?? loggerSilencioso,
    pausaEntreConsultasMs: opcoes.pausaMs ?? 0,
    ...(opcoes.concorrencia !== undefined ? { concorrencia: opcoes.concorrencia } : {}),
    ...(opcoes.agora ? { agora: opcoes.agora } : {}),
    ...(opcoes.dormir ? { dormir: opcoes.dormir } : {}),
    fontePrimaria: 'datajud',
  });
  for (const [ws, numero] of numeros) await repositorio.acompanhar(ws, numero);
  return { servico, repositorio, db, ...t };
}

describe('pool de trabalhadores da varredura', () => {
  it('com 3 trabalhadores a simultaneidade chega a 3 e nunca passa; cada item é verificado uma vez', async () => {
    const lista = [1, 2, 3, 4, 5, 6, 7].map((i): [string, string] => [A, n(i)]);
    const { servico, estado, iniciados, liberar, virar } = await montar(lista, {
      concorrencia: 3,
    });
    const varredura = servico.sincronizar();
    await virar();
    expect(estado.ativos).toBe(3);
    expect(iniciados).toHaveLength(3);
    // Um termina, outro entra: continuam 3 ao mesmo tempo, nunca 4.
    await liberar(iniciados[0] as string);
    expect(estado.ativos).toBe(3);
    expect(iniciados).toHaveLength(4);
    for (let i = 0; i < 6; i++) {
      const pendente = iniciados.find((x, idx) => idx >= i && x);
      void pendente;
      for (const numero of [...iniciados]) await liberar(numero);
    }
    const r = await varredura;
    expect(estado.maximo).toBe(3);
    expect(r).toMatchObject({ verificados: 7, falhas: 0, total: 7, concorrencia: 3 });
    expect(new Set(iniciados).size).toBe(7);
    expect(iniciados).toHaveLength(7);
  });

  it('com 1 trabalhador reproduz o comportamento antigo: um de cada vez, na ordem da fila (nunca sincronizados, depois os mais antigos)', async () => {
    const [x, y, z] = [n(1), n(2), n(3)] as [string, string, string];
    const { servico, db, estado, iniciados, liberar, virar } = await montar(
      [
        [A, x],
        [A, y],
        [A, z],
      ],
      { concorrencia: 1 },
    );
    // y nunca sincronizado; z sincronizado em janeiro; x em fevereiro: a ordem é y, z, x.
    db.prepare('UPDATE acompanhamentos SET sincronizado_em = ? WHERE numero = ?').run(
      '2026-02-01T00:00:00.000Z',
      x,
    );
    db.prepare('UPDATE acompanhamentos SET sincronizado_em = ? WHERE numero = ?').run(
      '2026-01-01T00:00:00.000Z',
      z,
    );
    const varredura = servico.sincronizar();
    await virar();
    expect(iniciados).toEqual([y]);
    await liberar(y);
    expect(iniciados).toEqual([y, z]);
    await liberar(z);
    await liberar(x);
    await varredura;
    expect(iniciados).toEqual([y, z, x]);
    expect(estado.maximo).toBe(1);
  });

  it('a ordem de retirada com 3 trabalhadores é a mesma da fila', async () => {
    const [x, y, z, w] = [n(1), n(2), n(3), n(4)] as [string, string, string, string];
    const { servico, db, iniciados, liberar, virar } = await montar(
      [
        [A, x],
        [A, y],
        [A, z],
        [A, w],
      ],
      { concorrencia: 3 },
    );
    for (const [num, quando] of [
      [x, '2026-04-01T00:00:00.000Z'],
      [y, '2026-03-01T00:00:00.000Z'],
      [z, '2026-02-01T00:00:00.000Z'],
      [w, '2026-01-01T00:00:00.000Z'],
    ] as const) {
      db.prepare('UPDATE acompanhamentos SET sincronizado_em = ? WHERE numero = ?').run(
        quando,
        num,
      );
    }
    const varredura = servico.sincronizar();
    await virar();
    expect(iniciados).toEqual([w, z, y]);
    await liberar(w);
    expect(iniciados).toEqual([w, z, y, x]);
    await liberar(z);
    await liberar(y);
    await liberar(x);
    await varredura;
  });

  it('acima do teto (4) ou valor inválido: ajusta, sem derrubar', async () => {
    const lista = [1, 2, 3, 4, 5, 6, 7, 8].map((i): [string, string] => [A, n(i)]);
    const grande = await montar(lista, { concorrencia: 10 });
    const v1 = grande.servico.sincronizar();
    await grande.virar();
    expect(grande.estado.ativos).toBe(4);
    await grande.liberarTodos();
    await v1;
    expect(grande.estado.maximo).toBe(4);

    for (const invalido of [0, -3, Number.NaN]) {
      const m = await montar(lista.slice(0, 3), { concorrencia: invalido });
      const v = m.servico.sincronizar();
      await m.virar();
      expect(m.estado.ativos).toBe(1);
      await m.liberarTodos();
      await v;
      expect(m.estado.maximo).toBe(1);
    }
  });

  it('o erro de um item não interrompe os outros trabalhadores nem a varredura', async () => {
    const ruim = n(2);
    const lista = [1, 2, 3, 4, 5].map((i): [string, string] => [A, n(i)]);
    const { servico, liberarTodos, virar, estado } = await montar(lista, {
      concorrencia: 3,
      falham: new Set([ruim]),
    });
    const varredura = servico.sincronizar();
    await virar();
    await liberarTodos();
    const r = await varredura;
    expect(r).toMatchObject({ verificados: 4, falhas: 1, total: 5 });
    expect(estado.ativos).toBe(0);
    expect(servico.emAndamento).toBe(false);
  });

  it('o mesmo processo de duas contas nunca é consultado ao mesmo tempo (a segunda consulta espera e sai do cache)', async () => {
    const mesmo = n(1);
    const { servico, estado, iniciados, liberar, virar } = await montar(
      [
        [A, mesmo],
        [B, mesmo],
        [A, n(2)],
      ],
      { concorrencia: 3 },
    );
    const varredura = servico.sincronizar();
    await virar();
    // O segundo item do MESMO número espera; o terceiro, de outro processo, já está rodando.
    expect(iniciados.filter((x) => x === mesmo)).toHaveLength(1);
    expect(iniciados).toContain(n(2));
    await liberar(mesmo);
    await liberar(mesmo);
    await liberar(n(2));
    await varredura;
    expect(estado.sobreposicaoDoMesmoNumero).toBe(false);
    expect(iniciados.filter((x) => x === mesmo)).toHaveLength(2); // sem cache no teste: uma por conta, em fila
  });

  it('a bandeira de "sincronizando" cai só no fim, também quando registrar a falha lança', async () => {
    const lista = [1, 2, 3].map((i): [string, string] => [A, n(i)]);
    const { servico, repositorio, liberarTodos, virar } = await montar(lista, {
      concorrencia: 3,
      falham: new Set([n(1), n(2), n(3)]),
    });
    repositorio.registrarFalha = async () => {
      throw new Error('banco indisponível');
    };
    const varredura = servico.sincronizar();
    await virar();
    expect(servico.emAndamento).toBe(true);
    await liberarTodos();
    const r = await varredura;
    expect(r.falhas).toBe(3);
    expect(servico.emAndamento).toBe(false);
    expect(servico.estadoDa(A).emAndamento).toBe(false);
    // E uma nova varredura pode começar.
    const outra = servico.sincronizar();
    await virar();
    expect(servico.emAndamento).toBe(true);
    await liberarTodos();
    await outra;
  });

  it('a pausa de SYNC_PAUSA_MS vale depois de CADA item, por trabalhador (espera injetada, sem tempo real)', async () => {
    const esperas: number[] = [];
    const lista = [1, 2, 3, 4].map((i): [string, string] => [A, n(i)]);
    const { servico, liberarTodos, virar } = await montar(lista, {
      concorrencia: 2,
      pausaMs: 1500,
      falham: new Set([n(2)]),
      dormir: async (ms) => {
        esperas.push(ms);
      },
    });
    const varredura = servico.sincronizar();
    await virar();
    await liberarTodos();
    await varredura;
    expect(esperas).toEqual([1500, 1500, 1500, 1500]); // 4 itens, a falha incluída
  });

  it('pausa zero não espera nada', async () => {
    const esperas: number[] = [];
    const { servico, liberarTodos, virar } = await montar([[A, n(1)]], {
      pausaMs: 0,
      dormir: async (ms) => {
        esperas.push(ms);
      },
    });
    const varredura = servico.sincronizar();
    await virar();
    await liberarTodos();
    await varredura;
    expect(esperas).toEqual([]);
  });
});

describe('gravações simultâneas no SQLite (v0.49.3)', () => {
  it('4 trabalhadores gravando 40 retratos e novidades numa conexão só: nenhum erro, nenhuma transação aninhada, tudo gravado', async () => {
    const db = abrirBanco(':memory:');
    const repositorio = new RepositorioAcompanhamentosSqlite(db);
    const numeros = Array.from({ length: 40 }, (_, i) => n(100 + i));
    for (const num of numeros) await repositorio.acompanhar(A, num);
    const servico = new ServicoAcompanhamento({
      repositorio,
      logger: loggerSilencioso,
      pausaEntreConsultasMs: 0,
      concorrencia: 4,
      provider: new ProviderFalso({
        nome: 'rapido',
        porNumero: async (numero) => {
          // Devolve em momentos diferentes, para as gravações se intercalarem com as consultas.
          await new Promise((r) => setImmediate(r));
          return new Processo({
            numero: NumeroCNJ.criar(numero),
            tribunal: 'TJSP',
            movimentacoes: [
              {
                data: new Date('2026-10-01T12:00:00Z'),
                titulo: 'Despacho',
                conteudo: 'texto sintético',
              },
            ],
            procedencia: {
              provider: 'datajud',
              consultadoEm: new Date(0),
              deCache: false,
            },
          });
        },
      }),
    });
    // Retrato anterior vazio para gerar novidade em todos.
    for (const num of numeros) {
      await repositorio.registrarSincronizacao(
        A,
        num,
        new Processo({
          numero: NumeroCNJ.criar(num),
          tribunal: 'TJSP',
          movimentacoes: [],
          procedencia: { provider: 'datajud', consultadoEm: new Date(0), deCache: false },
        }),
        [],
      );
    }
    const r = await servico.sincronizar();
    expect(r).toMatchObject({ verificados: 40, falhas: 0, concorrencia: 4 });
    const gravados = db
      .prepare(
        'SELECT COUNT(*) AS c FROM acompanhamentos WHERE erro IS NULL AND sincronizado_em IS NOT NULL',
      )
      .get() as { c: number };
    expect(gravados.c).toBe(40);
    const novidades = db.prepare('SELECT COUNT(*) AS c FROM novidades').get() as {
      c: number;
    };
    expect(novidades.c).toBe(40);
  });
});

describe('estado e progresso da verificação por conta', () => {
  it('total, concluídos e último progresso andam item a item; as outras contas não aparecem', async () => {
    let agora = new Date('2026-10-20T12:00:00Z');
    const { servico, liberar, virar, iniciados } = await montar(
      [
        [A, n(1)],
        [A, n(2)],
        [B, n(3)],
      ],
      { concorrencia: 1, agora: () => agora },
    );
    const varredura = servico.sincronizar();
    await virar();
    let e = servico.estadoDa(A);
    expect(e).toMatchObject({
      situacao: 'em_andamento',
      total: 2,
      concluidos: 0,
      pendentes: 2,
      ultimoProgressoEm: null,
    });
    expect(servico.estadoDa(B)).toMatchObject({ total: 1, concluidos: 0 });

    agora = new Date('2026-10-20T12:00:30Z');
    await liberar(iniciados[0] as string);
    e = servico.estadoDa(A);
    const primeiroDeA = e.concluidos === 1;
    const dona = primeiroDeA ? A : B;
    expect(servico.estadoDa(dona).concluidos).toBe(1);
    expect(servico.estadoDa(dona).ultimoProgressoEm?.toISOString()).toBe(
      '2026-10-20T12:00:30.000Z',
    );

    await liberar(iniciados[1] as string);
    await liberar(iniciados[2] as string);
    await varredura;
    expect(servico.estadoDa(A)).toMatchObject({
      situacao: 'ociosa',
      total: 0,
      concluidos: 0,
      ultimoProgressoEm: null,
    });
  });

  it('conta FORA da varredura global pede, fica "na_fila" (sem total) e começa quando a rodada acaba', async () => {
    const { servico, liberarTodos, virar, provider } = await montar([[A, n(1)]], {
      concorrencia: 1,
    });
    const varredura = servico.sincronizar();
    await virar();
    expect(servico.estadoDa('ws-c')).toMatchObject({
      emAndamento: false,
      situacao: 'ociosa',
    });
    expect(servico.solicitar('ws-c')).toBe('na_fila');
    expect(servico.estadoDa('ws-c')).toMatchObject({
      emAndamento: true,
      situacao: 'na_fila',
      total: 0,
      concluidos: 0,
    });
    // A conta DENTRO da rodada está "em andamento", não "na fila".
    expect(servico.estadoDa(A).situacao).toBe('em_andamento');
    await liberarTodos();
    await varredura;
    await virar();
    expect(servico.estadoDa('ws-c').situacao).toBe('ociosa');
    expect(provider.chamadas.porNumero).toBe(1);
  });

  it('sem varredura em curso, o pedido da conta já nasce "em_andamento" e roda só os processos dela', async () => {
    const { servico, liberarTodos, virar, iniciados } = await montar(
      [
        [A, n(1)],
        [B, n(2)],
      ],
      { concorrencia: 3 },
    );
    expect(servico.solicitar(A)).toBe('iniciada');
    expect(servico.estadoDa(A).situacao).toBe('em_andamento');
    await virar();
    expect(iniciados).toEqual([n(1)]);
    expect(servico.estadoDa(A)).toMatchObject({ total: 1, concluidos: 0 });
    await liberarTodos();
    await virar();
    expect(servico.estadoDa(A).situacao).toBe('ociosa');
  });

  it('"demorando" só quando PAROU de avançar: rodada longa com a fila andando não é demora', async () => {
    let agora = new Date('2026-10-20T12:00:00Z');
    const min = (m: number): Date => new Date(agora.getTime() + m * 60_000);
    const { servico, liberar, virar, iniciados } = await montar(
      [
        [A, n(1)],
        [A, n(2)],
        [A, n(3)],
      ],
      { concorrencia: 1, agora: () => agora },
    );
    const varredura = servico.sincronizar();
    await virar();

    // 6 min sem nenhum item concluído: parou.
    agora = min(6);
    expect(servico.estadoDa(A).demorando).toBe(true);

    // Um item conclui: voltou a avançar, mesmo a rodada tendo 6 min.
    await liberar(iniciados[0] as string);
    expect(servico.estadoDa(A).demorando).toBe(false);
    agora = new Date(agora.getTime() + 4 * 60_000); // 4 min depois do último item (que foi às 12:06)
    expect(servico.estadoDa(A).demorando).toBe(false);
    agora = new Date(agora.getTime() + 2 * 60_000); // 6 min depois dele
    expect(servico.estadoDa(A).demorando).toBe(true);

    await liberar(iniciados[1] as string);
    await liberar(iniciados[2] as string);
    await varredura;
    expect(servico.estadoDa(A).demorando).toBe(false);
  });

  it('conta esperando a vez não fica "demorando" enquanto a rodada de outra conta avança', async () => {
    let agora = new Date('2026-10-20T12:00:00Z');
    const { servico, liberar, virar, iniciados } = await montar(
      [
        [A, n(1)],
        [A, n(2)],
      ],
      { concorrencia: 1, agora: () => agora },
    );
    const varredura = servico.sincronizar();
    await virar();
    expect(servico.solicitar('ws-c')).toBe('na_fila');
    agora = new Date(agora.getTime() + 4 * 60_000);
    await liberar(iniciados[0] as string); // a rodada andou aos 4 min
    agora = new Date(agora.getTime() + 4 * 60_000); // 8 min desde o pedido, 4 do último item
    expect(servico.estadoDa('ws-c').demorando).toBe(false);
    agora = new Date(agora.getTime() + 2 * 60_000); // 6 min sem nada andar
    expect(servico.estadoDa('ws-c').demorando).toBe(true);
    await liberar(iniciados[1] as string);
    await varredura;
  });
});

describe('registro por item e resumo da varredura', () => {
  it('um registro info por item (número, fonte, duração, resultado) e o resumo com total, média e concorrência', async () => {
    const logger = new LoggerColetor();
    const lista = [1, 2, 3].map((i): [string, string] => [A, n(i)]);
    const { servico, liberarTodos, virar } = await montar(lista, {
      concorrencia: 2,
      logger,
      falham: new Set([n(3)]),
    });
    const varredura = servico.sincronizar();
    await virar();
    await liberarTodos();
    const r = await varredura;

    const itens = logger.linhas.filter((l) => l.includes('info processo verificado'));
    expect(itens).toHaveLength(3);
    const ok = itens.filter(
      (l) => l.includes('"resultado":"fallback"') || l.includes('"resultado":"ok"'),
    );
    expect(ok).toHaveLength(2);
    for (const l of ok) {
      expect(l).toContain('"fonte":"datajud+djen"');
      expect(l).toContain('"fontes":2');
      expect(l).toContain('"deCache":false');
      expect(l).toMatch(/"duracaoMs":\d+/);
      expect(l).toContain('"resultado":"ok"'); // a fonte primeira (datajud) respondeu
    }
    expect(itens.filter((l) => l.includes('"resultado":"falha"'))).toHaveLength(1);

    const resumo = logger.linhas.find((l) =>
      l.includes('info varredura concluída'),
    ) as string;
    expect(resumo).toContain('"total":3');
    expect(resumo).toContain('"concorrencia":2');
    expect(resumo).toMatch(/"duracaoMediaPorItemMs":\d+/);
    expect(resumo).toContain('"falhas":1');
    expect(r.duracaoMediaPorItemMs).toBeGreaterThanOrEqual(0);
    // Nenhum texto de ato nem nome de parte nos registros.
    expect(logger.linhas.join('\n')).not.toMatch(/partes|conteudo|titulo/i);
  });

  it('"fallback" quando a fonte primeira da cadeia não respondeu', async () => {
    const logger = new LoggerColetor();
    const db = abrirBanco(':memory:');
    const repositorio = new RepositorioAcompanhamentosSqlite(db);
    const servico = new ServicoAcompanhamento({
      repositorio,
      logger,
      pausaEntreConsultasMs: 0,
      fontePrimaria: 'datajud',
      provider: new ProviderFalso({
        nome: 'x',
        porNumero: async (numero) =>
          new Processo({
            numero: NumeroCNJ.criar(numero),
            tribunal: 'TJSP',
            movimentacoes: [],
            procedencia: { provider: 'djen', consultadoEm: new Date(0), deCache: false },
          }),
      }),
    });
    await repositorio.acompanhar(A, n(1));
    await servico.sincronizar();
    expect(logger.linhas.some((l) => l.includes('"resultado":"fallback"'))).toBe(true);
  });
});

describe('processos que sempre falham vão para o fim da fila (v0.49.3)', () => {
  it('a falha registra a TENTATIVA: o item vai para o fim e a "última verificação" (sucesso) não muda', async () => {
    const [x, ruim, y] = [n(1), n(2), n(3)] as [string, string, string];
    const db = abrirBanco(':memory:');
    const repositorio = new RepositorioAcompanhamentosSqlite(db);
    for (const num of [x, ruim, y]) await repositorio.acompanhar(A, num);
    for (const [num, quando] of [
      [x, '2026-01-01T00:00:00.000Z'],
      [ruim, '2025-12-01T00:00:00.000Z'],
      [y, '2026-02-01T00:00:00.000Z'],
    ] as const) {
      db.prepare('UPDATE acompanhamentos SET sincronizado_em = ? WHERE numero = ?').run(
        quando,
        num,
      );
    }
    const ordem = async (): Promise<string[]> =>
      (await repositorio.listarParaSincronizar(10)).map((a) => a.numero);
    // Antes da falha: o mais antigo (que sempre falha) está na frente, como sempre esteve.
    expect(await ordem()).toEqual([ruim, x, y]);

    await repositorio.registrarFalha(A, ruim, 'fonte fora do ar');
    expect(await ordem()).toEqual([x, y, ruim]);
    // "Última verificação" continua sendo o último SUCESSO.
    const guardado = await repositorio.buscar(A, ruim);
    expect(guardado?.sincronizadoEm?.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(guardado?.erro).toBe('fonte fora do ar');
  });

  it('nunca tentado continua na frente; quem nunca teve sucesso e falhou vai atrás do novo; linha antiga (sem tentativa) segue pelo sucesso', async () => {
    const [novo, falhoNuncaSincronizou, antigo] = [n(1), n(2), n(3)] as [
      string,
      string,
      string,
    ];
    const db = abrirBanco(':memory:');
    const repositorio = new RepositorioAcompanhamentosSqlite(db);
    for (const num of [falhoNuncaSincronizou, antigo])
      await repositorio.acompanhar(A, num);
    db.prepare('UPDATE acompanhamentos SET sincronizado_em = ? WHERE numero = ?').run(
      '2026-01-01T00:00:00.000Z',
      antigo,
    );
    await repositorio.registrarFalha(A, falhoNuncaSincronizou, 'não encontrado');
    await repositorio.acompanhar(A, novo); // chegou agora: nunca tentado
    const ordem = (await repositorio.listarParaSincronizar(10)).map((a) => a.numero);
    expect(ordem[0]).toBe(novo);
    expect(ordem.indexOf(antigo)).toBeLessThan(ordem.indexOf(falhoNuncaSincronizou));
  });

  it('o sucesso também registra a tentativa, e a fila de UMA conta só traz os processos dela', async () => {
    const db = abrirBanco(':memory:');
    const repositorio = new RepositorioAcompanhamentosSqlite(db);
    await repositorio.acompanhar(A, n(1));
    await repositorio.acompanhar(B, n(2));
    await repositorio.registrarSincronizacao(A, n(1), processo(n(1)), []);
    const linha = db
      .prepare('SELECT sincronizado_em, tentado_em FROM acompanhamentos WHERE numero = ?')
      .get(n(1)) as Record<string, string>;
    expect(linha['tentado_em']).toBe(linha['sincronizado_em']);
    expect((await repositorio.listarParaSincronizar(10, B)).map((a) => a.numero)).toEqual(
      [n(2)],
    );
  });

  it('migração aditiva: banco criado antes da coluna ganha `tentado_em` sem perder nada', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const pasta = mkdtempSync(join(tmpdir(), 'pv-tentado-'));
    try {
      const caminho = join(pasta, 'processovivo.db');
      let db = abrirBanco(caminho);
      await new RepositorioAcompanhamentosSqlite(db).acompanhar(A, n(1));
      db.exec('ALTER TABLE acompanhamentos DROP COLUMN tentado_em');
      db.close();
      db = abrirBanco(caminho);
      const colunas = db.prepare('PRAGMA table_info(acompanhamentos)').all() as Array<{
        name: string;
      }>;
      expect(colunas.some((c) => c.name === 'tentado_em')).toBe(true);
      expect(
        await new RepositorioAcompanhamentosSqlite(db).contarAcompanhamentos(A),
      ).toBe(1);
      db.close();
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});

describe('SYNC_CONCORRENCIA — configuração (v0.49.3)', () => {
  it('ausente = 3 sem aviso; 1 a 4 valem; zero, negativo, decimal, texto e acima de 4 caem em 3 COM aviso', () => {
    expect(interpretarConcorrenciaDaSincronizacao(undefined)).toEqual({
      concorrencia: 3,
    });
    expect(interpretarConcorrenciaDaSincronizacao('')).toEqual({ concorrencia: 3 });
    for (const v of ['1', '2', '3', '4', ' 2 ']) {
      expect(interpretarConcorrenciaDaSincronizacao(v).concorrencia).toBe(Number(v));
      expect(
        interpretarConcorrenciaDaSincronizacao(v).avisoDaConcorrencia,
      ).toBeUndefined();
    }
    for (const v of ['0', '-1', '2.5', 'abc', '5', '99']) {
      const r = interpretarConcorrenciaDaSincronizacao(v);
      expect(r.concorrencia).toBe(3);
      expect(r.avisoDaConcorrencia).toContain('SYNC_CONCORRENCIA');
      expect(r.avisoDaConcorrencia).not.toContain(v === '5' ? 'x5x' : v + '.');
    }
  });

  it('carregarConfig não derruba o servidor por valor inválido e entrega o aviso para o arranque logar', () => {
    const base = {
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
    };
    expect(
      carregarConfig({ ...base } as NodeJS.ProcessEnv).sincronizacao.concorrencia,
    ).toBe(3);
    expect(
      carregarConfig({ ...base, SYNC_CONCORRENCIA: '4' } as NodeJS.ProcessEnv)
        .sincronizacao.concorrencia,
    ).toBe(4);
    const ruim = carregarConfig({
      ...base,
      SYNC_CONCORRENCIA: '9',
    } as NodeJS.ProcessEnv).sincronizacao;
    expect(ruim.concorrencia).toBe(3);
    expect(ruim.avisoDaConcorrencia).toBeDefined();
  });
});
