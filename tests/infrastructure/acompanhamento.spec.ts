import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { detectarNovidades } from '../../src/domain/entities/Acompanhamento.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import { ProviderFalso, NUMERO_TJSP_A, NUMERO_TJSP_B } from '../helpers/fabricas.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';

const WS = 'workspace-a';
const OUTRO_WS = 'workspace-b';
const NUM = '12345674720238260100';

function mov(iso: string, titulo: string, codigo?: number): Movimentacao {
  return { data: new Date(iso), titulo, ...(codigo ? { codigoTpu: codigo } : {}) };
}

function processo(movs: Movimentacao[], numero = NUMERO_TJSP_A): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal: 'TJSP',
    classe: 'Procedimento Comum Cível',
    movimentacoes: movs,
    procedencia: { provider: 'teste', consultadoEm: new Date(), deCache: false },
  });
}

describe('detectarNovidades', () => {
  it('primeira sincronização não gera novidade', () => {
    // Despejar 361 avisos na cara de quem acabou de adicionar o processo não
    // ajuda ninguém — o histórico inteiro seria "novo".
    const atual = processo([mov('2024-01-01T00:00:00Z', 'Distribuição')]);
    expect(detectarNovidades(undefined, atual)).toEqual([]);
  });

  it('detecta só o que apareceu depois', () => {
    const antes = processo([mov('2024-01-01T00:00:00Z', 'Distribuição')]);
    const depois = processo([
      mov('2024-03-01T00:00:00Z', 'Sentença'),
      mov('2024-01-01T00:00:00Z', 'Distribuição'),
    ]);

    const novas = detectarNovidades(antes, depois);
    expect(novas).toHaveLength(1);
    expect(novas[0]?.titulo).toBe('Sentença');
  });

  it('não repete o que já era conhecido', () => {
    const p = processo([mov('2024-01-01T00:00:00Z', 'Distribuição')]);
    expect(detectarNovidades(p, p)).toEqual([]);
  });

  it('devolve em ordem cronológica, da mais antiga para a mais nova', () => {
    const antes = processo([mov('2024-01-01T00:00:00Z', 'Distribuição')]);
    const depois = processo([
      mov('2024-05-01T00:00:00Z', 'Conclusão'),
      mov('2024-03-01T00:00:00Z', 'Petição'),
      mov('2024-01-01T00:00:00Z', 'Distribuição'),
    ]);

    expect(detectarNovidades(antes, depois).map((m) => m.titulo)).toEqual([
      'Petição',
      'Conclusão',
    ]);
  });

  it('movimentação que some da fonte NÃO vira novidade', () => {
    // Se o tribunal remove ou reescreve um andamento, isso não pode gerar
    // alarme — a fonte oscila, e alarme falso corrói a confiança no aviso.
    const antes = processo([
      mov('2024-01-01T00:00:00Z', 'Distribuição'),
      mov('2024-02-01T00:00:00Z', 'Ato que sumiu'),
    ]);
    const depois = processo([mov('2024-01-01T00:00:00Z', 'Distribuição')]);

    expect(detectarNovidades(antes, depois)).toEqual([]);
  });
});

describe('RepositorioAcompanhamentosSqlite', () => {
  let db: DatabaseSync;
  let repo: RepositorioAcompanhamentosSqlite;

  beforeEach(() => {
    db = abrirBanco(':memory:');
    repo = new RepositorioAcompanhamentosSqlite(db);
  });
  afterEach(() => {
    db.close();
  });

  it('acompanha e recupera', async () => {
    await repo.acompanhar(WS, NUM, 'Caso Silva');
    const a = await repo.buscar(WS, NUM);

    expect(a?.numero).toBe(NUM);
    expect(a?.apelido).toBe('Caso Silva');
    expect(a?.sincronizadoEm).toBeUndefined();
  });

  it('acompanhar duas vezes não duplica nem apaga o retrato', async () => {
    await repo.acompanhar(WS, NUM, 'Original');
    await repo.registrarSincronizacao(
      WS,
      NUM,
      processo([mov('2024-01-01T00:00:00Z', 'A')]),
      [],
    );
    await repo.acompanhar(WS, NUM);

    const a = await repo.buscar(WS, NUM);
    expect(a?.apelido).toBe('Original');
    expect(a?.processo).toBeDefined();
    expect(await repo.listar(WS)).toHaveLength(1);
  });

  it('workspaces são isolados', async () => {
    // É o que sustenta "a chave de API é o usuário": vazar aqui misturaria a
    // carteira de dois assinantes.
    await repo.acompanhar(WS, NUM);

    expect(await repo.listar(WS)).toHaveLength(1);
    expect(await repo.listar(OUTRO_WS)).toHaveLength(0);
    expect(await repo.buscar(OUTRO_WS, NUM)).toBeUndefined();
  });

  it('registra novidades e conta as não vistas', async () => {
    await repo.acompanhar(WS, NUM);
    await repo.registrarSincronizacao(
      WS,
      NUM,
      processo([mov('2024-01-01T00:00:00Z', 'A')]),
      [mov('2024-02-01T00:00:00Z', 'Sentença', 219)],
    );

    expect(await repo.contarNaoVistas(WS)).toBe(1);
    const nov = await repo.listarNovidades(WS);
    expect(nov[0]?.titulo).toBe('Sentença');
    expect(nov[0]?.codigoTpu).toBe(219);
    expect(nov[0]?.vistaEm).toBeUndefined();
  });

  it('sincronizar duas vezes não duplica a mesma novidade', async () => {
    // Idempotência garantida pelo índice único, não pelo código.
    await repo.acompanhar(WS, NUM);
    const nova = mov('2024-02-01T00:00:00Z', 'Sentença');
    const p = processo([mov('2024-01-01T00:00:00Z', 'A')]);

    await repo.registrarSincronizacao(WS, NUM, p, [nova]);
    await repo.registrarSincronizacao(WS, NUM, p, [nova]);

    expect(await repo.contarNaoVistas(WS)).toBe(1);
  });

  it('marcar como vistas zera o contador', async () => {
    await repo.acompanhar(WS, NUM);
    await repo.registrarSincronizacao(WS, NUM, processo([]), [
      mov('2024-02-01T00:00:00Z', 'A'),
      mov('2024-03-01T00:00:00Z', 'B'),
    ]);

    expect(await repo.marcarComoVistas(WS)).toBe(2);
    expect(await repo.contarNaoVistas(WS)).toBe(0);
  });

  it('deixar de acompanhar leva as novidades junto', async () => {
    await repo.acompanhar(WS, NUM);
    await repo.registrarSincronizacao(WS, NUM, processo([]), [
      mov('2024-02-01T00:00:00Z', 'A'),
    ]);

    expect(await repo.deixarDeAcompanhar(WS, NUM)).toBe(true);
    expect(await repo.listarNovidades(WS)).toHaveLength(0);
    expect(await repo.contarNaoVistas(WS)).toBe(0);
  });

  it('falha não avança a data do último sucesso', async () => {
    await repo.acompanhar(WS, NUM);
    await repo.registrarSincronizacao(WS, NUM, processo([]), []);
    const depoisDoSucesso = (await repo.buscar(WS, NUM))?.sincronizadoEm;

    await repo.registrarFalha(WS, NUM, 'TIMEOUT');
    const a = await repo.buscar(WS, NUM);

    expect(a?.erro).toBe('TIMEOUT');
    expect(a?.sincronizadoEm?.toISOString()).toBe(depoisDoSucesso?.toISOString());
  });

  it('filtra por tribunal, por novidade e por texto', async () => {
    // Datas relativas a agora: com datas fixas, o filtro "últimos N dias"
    // passaria ou falharia dependendo de quando a suíte roda.
    const diasAtras = (n: number): string =>
      new Date(Date.now() - n * 86_400_000).toISOString();

    await repo.acompanhar(WS, NUM, 'Caso Aurora');
    await repo.registrarSincronizacao(WS, NUM, processo([mov(diasAtras(10), 'X')]), [
      mov(diasAtras(10), 'X'),
    ]);
    const outro = '00076521220228260224';
    await repo.acompanhar(WS, outro, 'Caso Beta');
    await repo.registrarSincronizacao(
      WS,
      outro,
      processo([mov(diasAtras(900), 'Y')], NUMERO_TJSP_B),
      [],
    );

    expect(await repo.listar(WS, { somenteComNovidade: true })).toHaveLength(1);
    expect(await repo.listar(WS, { tribunal: 'TJSP' })).toHaveLength(2);
    expect(await repo.listar(WS, { tribunal: 'TJGO' })).toHaveLength(0);
    expect(await repo.listar(WS, { texto: 'Aurora' })).toHaveLength(1);
    expect(await repo.listar(WS, { movimentadoNosUltimosDias: 30 })).toHaveLength(1);
    expect(await repo.listar(WS, { movimentadoNosUltimosDias: 3650 })).toHaveLength(2);
  });

  it('a fila de sincronização começa pelos nunca sincronizados', async () => {
    await repo.acompanhar(WS, NUM);
    await repo.registrarSincronizacao(WS, NUM, processo([]), []);
    const novo = '00076521220228260224';
    await repo.acompanhar(WS, novo);

    const fila = await repo.listarParaSincronizar(10);
    expect(fila[0]?.numero).toBe(novo);
  });

  it('facetas alimentam os seletores de filtro', async () => {
    await repo.acompanhar(WS, NUM);
    await repo.registrarSincronizacao(WS, NUM, processo([]), []);

    const f = await repo.facetas(WS);
    expect(f.tribunais).toEqual(['TJSP']);
    expect(f.classes).toEqual(['Procedimento Comum Cível']);
  });

  describe('classe por nome normalizado', () => {
    const N1 = NUMERO_TJSP_A;
    const N2 = NUMERO_TJSP_B;
    const N3 = '00076521220228260224';

    function comClasse(numero: string, classe: string): Processo {
      return new Processo({
        numero: NumeroCNJ.criar(numero),
        tribunal: 'TJSP',
        classe,
        movimentacoes: [],
        procedencia: { provider: 'teste', consultadoEm: new Date(), deCache: false },
      });
    }

    beforeEach(async () => {
      for (const [n, c] of [
        [N1, 'Procedimento Comum Cível'],
        [N2, 'PROCEDIMENTO COMUM CíVEL'],
        [N3, 'Execução Fiscal'],
      ] as const) {
        await repo.acompanhar(WS, n);
        await repo.registrarSincronizacao(WS, n, comClasse(n, c), []);
      }
    });

    it('as facetas oferecem UMA opção por classe, com o nome normalizado', async () => {
      const f = await repo.facetas(WS);
      expect(f.classes).toEqual(['Execução Fiscal', 'Procedimento Comum Cível']);
    });

    it('o filtro pelo nome normalizado traz todas as grafias cruas', async () => {
      const lista = await repo.listar(WS, { classe: 'Procedimento Comum Cível' });
      expect(lista.map((a) => a.numero).sort()).toEqual([N1, N2].sort());
    });

    it('o filtro continua aceitando uma grafia crua (a mesma classe)', async () => {
      const lista = await repo.listar(WS, { classe: 'PROCEDIMENTO COMUM CíVEL' });
      expect(lista).toHaveLength(2);
    });

    it('classe que ninguém tem não acha nada, e o banco segue como gravado', async () => {
      expect(await repo.listar(WS, { classe: 'Inventário' })).toHaveLength(0);
      const gravada = (await repo.buscar(WS, N2))?.processo?.classe;
      expect(gravada).toBe('PROCEDIMENTO COMUM CíVEL');
    });

    it('não enxerga classe de outro workspace', async () => {
      await repo.acompanhar(OUTRO_WS, N1);
      await repo.registrarSincronizacao(OUTRO_WS, N1, comClasse(N1, 'Inventário'), []);
      expect((await repo.facetas(WS)).classes).not.toContain('Inventário');
      expect(await repo.listar(WS, { classe: 'Inventário' })).toHaveLength(0);
    });
  });
});

describe('ServicoAcompanhamento', () => {
  let db: DatabaseSync;

  function servico(provider: ProviderFalso): ServicoAcompanhamento {
    db = abrirBanco(':memory:');
    return new ServicoAcompanhamento({
      repositorio: new RepositorioAcompanhamentosSqlite(db),
      provider,
      logger: loggerSilencioso,
      pausaEntreConsultasMs: 0,
    });
  }

  afterEach(() => {
    db.close();
  });

  it('acompanhar já busca o primeiro retrato', async () => {
    const s = servico(new ProviderFalso({ nome: 'p' }));
    const a = await s.acompanhar(WS, NUMERO_TJSP_A);

    expect(a.processo).toBeDefined();
    expect(a.sincronizadoEm).toBeInstanceOf(Date);
  });

  it('fonte fora do ar não impede acompanhar — fica com o motivo', async () => {
    // Desfazer obrigaria o usuário a readicionar toda vez que o tribunal caísse.
    const s = servico(
      new ProviderFalso({
        nome: 'p',
        porNumero: async () => {
          throw new Error('tribunal fora');
        },
      }),
    );
    const a = await s.acompanhar(WS, NUMERO_TJSP_A);

    expect(a.processo).toBeUndefined();
    expect(a.erro).toContain('tribunal fora');
  });

  it('a varredura detecta novidade entre duas execuções', async () => {
    let segunda = false;
    const provider = new ProviderFalso({
      nome: 'p',
      porNumero: async () =>
        segunda
          ? processo([
              mov('2024-03-01T00:00:00Z', 'Sentença'),
              mov('2024-01-01T00:00:00Z', 'Distribuição'),
            ])
          : processo([mov('2024-01-01T00:00:00Z', 'Distribuição')]),
    });
    const s = servico(provider);

    await s.acompanhar(WS, NUMERO_TJSP_A);
    expect(await s.contarNaoVistas(WS)).toBe(0);

    segunda = true;
    const r = await s.sincronizar();

    expect(r.verificados).toBe(1);
    expect(r.comNovidade).toBe(1);
    expect(r.novidades).toBe(1);
    expect(await s.contarNaoVistas(WS)).toBe(1);
    expect((await s.novidades(WS))[0]?.titulo).toBe('Sentença');
  });

  it('uma fonte que falha não interrompe a varredura das outras', async () => {
    const s = servico(
      new ProviderFalso({
        nome: 'p',
        porNumero: async (n) => {
          if (n === '00076521220228260224') throw new Error('falhou');
          return processo([mov('2024-01-01T00:00:00Z', 'A')]);
        },
      }),
    );

    await s.acompanhar(WS, NUMERO_TJSP_A);
    await s.acompanhar(WS, NUMERO_TJSP_B);
    const r = await s.sincronizar();

    expect(r.verificados).toBe(1);
    expect(r.falhas).toBe(1);
  });

  it('recusa varredura concorrente em vez de duplicar consultas', async () => {
    const s = servico(
      new ProviderFalso({
        nome: 'p',
        porNumero: async () => {
          await new Promise((r) => setTimeout(r, 40));
          return processo([]);
        },
      }),
    );
    await s.acompanhar(WS, NUMERO_TJSP_A);

    const primeira = s.sincronizar();
    await expect(s.sincronizar()).rejects.toThrow(/varredura em andamento/);
    await primeira;

    // Terminada a primeira, uma nova é aceita.
    await expect(s.sincronizar()).resolves.toBeDefined();
  });
});
