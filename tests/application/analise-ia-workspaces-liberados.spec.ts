import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { LimiteDeAnalises } from '../../src/application/politicas/limiteDeAnalises.js';
import { ServicoAnaliseDoAto } from '../../src/application/services/ServicoAnaliseDoAto.js';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { EntradaNaoAnalisavelError } from '../../src/domain/errors/index.js';
import { mascararWorkspace } from '../../src/domain/entities/workspaceLiberado.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioAnalisesSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAnalisesSqlite.js';
import { AnalisadorFalso, LoggerColetor, TEXTO_DO_ATO } from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';
import { ClockFalso } from '../helpers/leitor.js';

/*
 * v0.38.1 — exceção de TESTE FECHADO: workspace listado passa na checagem do plano
 * IA sem assinatura. Ids sintéticos; adaptador dublado; relógio fixo.
 */
const LISTADO = '1ed3b9b0ba131867';
const OUTRO = 'aaaa0000bbbb1111';
const NUMERO = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
const DATA = new Date('2026-10-05T12:00:00Z');
const ATO: Movimentacao = {
  data: DATA,
  titulo: 'Despacho',
  idExterno: 'djen:900',
  conteudo: TEXTO_DO_ATO,
};

describe('análise por IA — workspaces liberados (teste fechado)', () => {
  let db: DatabaseSync;
  let repo: RepositorioAcompanhamentosSqlite;
  let analisador: AnalisadorFalso;
  let log: LoggerColetor;
  let perguntouAoPlano: string[];
  let comPlano: Set<string>;

  function servico(liberados?: ReadonlySet<string>): ServicoAnaliseDoAto {
    const relogio = new ClockFalso();
    return new ServicoAnaliseDoAto({
      repositorio: repo,
      analises: new RepositorioAnalisesSqlite(db),
      assinaturas: {
        temRecursoSemExcecao: async (ws) => {
          perguntouAoPlano.push(ws);
          return comPlano.has(ws);
        },
      },
      analisador,
      limite: new LimiteDeAnalises({
        porHora: 100,
        simultaneasNoTotal: 10,
        clock: relogio,
      }),
      clock: relogio,
      logger: log,
      novoId: () => 'analise-1',
      ...(liberados ? { workspacesLiberados: liberados } : {}),
    });
  }

  async function semear(ws: string): Promise<void> {
    await repo.acompanhar(ws, NUMERO);
    await repo.registrarSincronizacao(
      ws,
      NUMERO,
      new Processo({
        numero: NumeroCNJ.criar(NUMERO_TJSP_A),
        tribunal: 'TJGO',
        movimentacoes: [ATO],
        procedencia: { provider: 'djen', consultadoEm: DATA, deCache: false },
      }),
      [],
    );
  }
  const pedido = (ws: string) => ({
    workspace: ws,
    numero: NUMERO_TJSP_A,
    chaveDoAto: chaveDaMovimentacao(ATO),
  });
  const linhasDeAssinatura = (): number =>
    Number(
      (db.prepare('SELECT COUNT(*) AS n FROM assinaturas').get() as { n: number }).n,
    );

  beforeEach(async () => {
    db = abrirBanco(':memory:');
    repo = new RepositorioAcompanhamentosSqlite(db);
    analisador = new AnalisadorFalso();
    log = new LoggerColetor();
    perguntouAoPlano = [];
    comPlano = new Set();
    await semear(LISTADO);
    await semear(OUTRO);
  });
  afterEach(() => db.close());

  it('listado e SEM assinatura: chama o adaptador dublado', async () => {
    const r = await servico(new Set([LISTADO])).analisar(pedido(LISTADO));

    expect(r.estado).not.toBe('erro');
    expect(analisador.chamadas).toBe(1);
  });

  it('não cria nenhuma linha em assinaturas e nem consulta o plano', async () => {
    await servico(new Set([LISTADO])).analisar(pedido(LISTADO));

    expect(linhasDeAssinatura()).toBe(0);
    expect(perguntouAoPlano).toEqual([]);
  });

  it('NÃO listado e sem assinatura: frase fixa e zero chamadas', async () => {
    const erro = await servico(new Set([LISTADO]))
      .analisar(pedido(OUTRO))
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(EntradaNaoAnalisavelError);
    expect((erro as EntradaNaoAnalisavelError).motivo).toBe('sem_plano');
    expect((erro as Error).message).toBe(
      'A análise por IA faz parte do plano IA. Faça upgrade do plano para usar.',
    );
    expect(analisador.chamadas).toBe(0);
  });

  it('NÃO listado mas COM o plano IA: continua passando pelo plano', async () => {
    comPlano.add(OUTRO);
    await servico(new Set([LISTADO])).analisar(pedido(OUTRO));
    expect(analisador.chamadas).toBe(1);
    expect(perguntouAoPlano).toEqual([OUTRO]);
  });

  it('lista vazia ou ausente mantém o comportamento atual (listado sem plano não passa)', async () => {
    for (const liberados of [undefined, new Set<string>()]) {
      const erro = await servico(liberados)
        .analisar(pedido(LISTADO))
        .catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('sem_plano');
    }
    expect(analisador.chamadas).toBe(0);
  });

  it('as outras travas continuam valendo para o listado (segredo de justiça: zero chamadas)', async () => {
    db.prepare('DELETE FROM acompanhamentos').run();
    await repo.acompanhar(LISTADO, NUMERO);
    await repo.registrarSincronizacao(
      LISTADO,
      NUMERO,
      new Processo({
        numero: NumeroCNJ.criar(NUMERO_TJSP_A),
        tribunal: 'TJGO',
        segredoJustica: true,
        movimentacoes: [ATO],
        procedencia: { provider: 'djen', consultadoEm: DATA, deCache: false },
      }),
      [],
    );
    const erro = await servico(new Set([LISTADO]))
      .analisar(pedido(LISTADO))
      .catch((e: unknown) => e);
    expect((erro as EntradaNaoAnalisavelError).motivo).toBe('segredo_de_justica');
    expect(analisador.chamadas).toBe(0);
  });

  it('o log só traz o id MASCARADO, nunca o completo', async () => {
    await servico(new Set([LISTADO])).analisar(pedido(LISTADO));

    const tudo = log.linhas.join('\n');
    expect(tudo).toContain('1ed3…1867');
    expect(tudo).not.toContain(LISTADO);
  });

  it('mascararWorkspace não ecoa o que não é um id', () => {
    expect(mascararWorkspace(LISTADO)).toBe('1ed3…1867');
    expect(mascararWorkspace('uma-chave-de-api-colada-por-engano')).toBe('(id inválido)');
  });
});
