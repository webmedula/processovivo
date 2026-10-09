import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import { comIndicadorDeDestinatario } from '../../src/application/services/indicadorDeDestinatario.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import type { RepositorioAcompanhamentos } from '../../src/domain/ports/RepositorioAcompanhamentos.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { OabsDoWorkspaceSqlite } from '../../src/infrastructure/persistencia/sqlite/OabsDoWorkspaceSqlite.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { mapearErro } from '../../src/main/http/erros.js';
import { rotasDeAcompanhamento } from '../../src/main/http/rotas/acompanhamentos.js';
import { NUMERO_TJSP_A, ProviderFalso } from '../helpers/fabricas.js';

/*
 * v0.37.6 — o indicador "para o usuário" é calculado NA GRAVAÇÃO do retrato, contra as
 * OABs do workspace, e as inscrições de terceiros não chegam ao banco nem à API.
 * Inscrições e nomes sintéticos; relógio fixo.
 */
const AGORA = new Date('2026-10-09T12:00:00Z');
const dia = (n: number): Date => new Date(AGORA.getTime() - n * 86_400_000);
const WS = 'ws-1';
const DIG = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
const TERCEIRO = '98765/GO';

const intimacao = (
  id: number,
  dias: number,
  destinatariosOab?: string[],
  extra: Partial<Movimentacao> = {},
): Movimentacao => ({
  data: dia(dias),
  titulo: 'Ato ordinatório',
  idExterno: `djen:${id}`,
  tipoComunicacao: 'Intimação',
  ...(destinatariosOab ? { destinatariosOab } : {}),
  ...extra,
});

const processo = (movs: Movimentacao[]): Processo =>
  new Processo({
    numero: NumeroCNJ.criar(NUMERO_TJSP_A),
    tribunal: 'TJSP',
    classe: 'Procedimento Comum Cível',
    movimentacoes: movs,
    procedencia: { provider: 'djen', consultadoEm: AGORA, deCache: false },
  });

describe('indicador de destinatário na gravação do acompanhamento', () => {
  let db: DatabaseSync;
  let cru: RepositorioAcompanhamentosSqlite;
  let repo: RepositorioAcompanhamentos;

  function cadastrarOab(oab: string | null, uf: string | null): void {
    db.prepare(
      `INSERT INTO usuarios (id, email, nome, senha, workspace, oab, uf_oab, criado_em)
       VALUES ('u1', 'a@exemplo.com.br', 'Pessoa', 'x', ?, ?, ?, ?)`,
    ).run(WS, oab, uf, AGORA.toISOString());
  }

  async function gravar(movs: Movimentacao[]): Promise<void> {
    await repo.registrarSincronizacao(WS, DIG, processo(movs), []);
  }
  async function gravado(): Promise<Movimentacao[]> {
    return [...((await cru.buscar(WS, DIG))?.processo?.movimentacoes ?? [])];
  }
  const brutoNoBanco = (): string =>
    String((db.prepare('SELECT processo FROM acompanhamentos').get() as { processo: string }).processo);

  beforeEach(async () => {
    db = abrirBanco(':memory:');
    cru = new RepositorioAcompanhamentosSqlite(db);
    repo = comIndicadorDeDestinatario(cru, new OabsDoWorkspaceSqlite(db), loggerSilencioso);
    await cru.acompanhar(WS, DIG);
  });
  afterEach(() => db.close());

  it('dirigida a uma OAB do cadastro: sim', async () => {
    cadastrarOab('100', 'GO');
    await gravar([intimacao(1, 5, ['100/GO'])]);
    expect((await gravado())[0]?.paraOUsuario).toBe('sim');
  });

  it('dirigida a outro advogado: nao — e o exigeAcao antigo não sobrevive', async () => {
    cadastrarOab('100', 'GO');
    await gravar([intimacao(1, 5, [TERCEIRO], { exigeAcao: true })]);
    const m = (await gravado())[0];
    expect(m?.paraOUsuario).toBe('nao');
    expect(m?.exigeAcao).toBeUndefined();
  });

  it('a OAB de uma vigilância também é do workspace', async () => {
    cadastrarOab(null, null);
    db.prepare(
      `INSERT INTO vigilancias_oab (workspace, oab, uf, criada_em, ativa) VALUES (?, '98765', 'GO', ?, 0)`,
    ).run(WS, AGORA.toISOString());
    await gravar([intimacao(1, 5, [TERCEIRO])]);
    expect((await gravado())[0]?.paraOUsuario).toBe('sim');
  });

  it('sem OAB cadastrada o destinatário é desconhecido, nunca "outro"', async () => {
    await gravar([intimacao(1, 5, [TERCEIRO])]);
    expect((await gravado())[0]?.paraOUsuario).toBe('desconhecido');
  });

  it('comunicação sem advogado na resposta fica sem indicador (= desconhecido); ato que não é do DJEN fica intocado', async () => {
    cadastrarOab('100', 'GO');
    await gravar([intimacao(1, 5), { data: dia(2), titulo: 'Juntada de petição' }]);
    const movs = await gravado();
    expect(movs.find((m) => m.idExterno === 'djen:1')?.paraOUsuario ?? 'desconhecido').toBe('desconhecido');
    expect(movs.find((m) => m.titulo === 'Juntada de petição')?.paraOUsuario).toBeUndefined();
  });

  it('NENHUMA inscrição de terceiro (nem a do próprio usuário) chega ao banco', async () => {
    cadastrarOab('100', 'GO');
    await gravar([intimacao(1, 5, [TERCEIRO, '100/GO'])]);
    const bruto = brutoNoBanco();
    expect(bruto).not.toContain('98765');
    expect(bruto).not.toContain('destinatariosOab');
    expect(bruto).toContain('"paraOUsuario":"sim"');
  });

  it('resposta sem inscrições (cache velho) NÃO apaga o que a sincronização anterior já sabia', async () => {
    cadastrarOab('100', 'GO');
    await gravar([intimacao(1, 5, [TERCEIRO])]);
    expect((await gravado())[0]?.paraOUsuario).toBe('nao');
    await gravar([intimacao(1, 5)]);
    expect((await gravado())[0]?.paraOUsuario).toBe('nao');
  });

  it('cadastrar a OAB depois recalcula na sincronização seguinte (desconhecido → sim)', async () => {
    await gravar([intimacao(1, 5, ['100/GO'])]);
    expect((await gravado())[0]?.paraOUsuario).toBe('desconhecido');
    cadastrarOab('100', 'GO');
    await gravar([intimacao(1, 5, ['100/GO'])]);
    expect((await gravado())[0]?.paraOUsuario).toBe('sim');
  });

  it('falha ao ler as OABs nunca derruba a sincronização: grava sem indicador e sem inscrições', async () => {
    const quebrado = comIndicadorDeDestinatario(
      cru,
      {
        chaves: () => {
          throw new Error('banco indisponível');
        },
      },
      loggerSilencioso,
    );
    await quebrado.registrarSincronizacao(WS, DIG, processo([intimacao(1, 5, [TERCEIRO])]), []);
    const movs = await gravado();
    expect(movs).toHaveLength(1);
    expect(movs[0]?.paraOUsuario).toBeUndefined();
    expect(brutoNoBanco()).not.toContain('98765');
  });
});

describe('GET /v1/novidades com intimação a outro destinatário', () => {
  let db: DatabaseSync;
  let servidor: FastifyInstance;
  let repo: RepositorioAcompanhamentos;

  async function novidades(): Promise<{
    pendenciaIntimacaoJanelaDias: number;
    semNovidade: Array<{
      numero: string;
      processo: {
        pedeProvidencia: boolean;
        providencia: null | {
          situacao: string;
          motivo: { paraOUsuario: string; tipo: string; rotulo: string };
          outroDestinatario?: { paraOUsuario: string };
        };
      };
    }>;
  }> {
    return (await servidor.inject({ method: 'GET', url: '/v1/novidades' })).json();
  }

  beforeEach(async () => {
    db = abrirBanco(':memory:');
    const cru = new RepositorioAcompanhamentosSqlite(db);
    repo = comIndicadorDeDestinatario(cru, new OabsDoWorkspaceSqlite(db), loggerSilencioso);
    db.prepare(
      `INSERT INTO usuarios (id, email, nome, senha, workspace, oab, uf_oab, criado_em)
       VALUES ('u1', 'a@exemplo.com.br', 'Pessoa', 'x', ?, '100', 'GO', ?)`,
    ).run(WS, AGORA.toISOString());
    await cru.acompanhar(WS, DIG);
    const servico = new ServicoAcompanhamento({
      repositorio: repo,
      provider: new ProviderFalso({ nome: 'falso' }),
      logger: loggerSilencioso,
      agora: () => AGORA,
    });
    servidor = Fastify();
    servidor.decorateRequest('workspace', undefined);
    servidor.addHook('onRequest', async (req) => {
      req.workspace = WS;
    });
    servidor.setErrorHandler((erro, _req, resposta) => {
      const m = mapearErro(erro);
      void resposta.code(m.status).send(m.corpo);
    });
    await servidor.register(
      rotasDeAcompanhamento(servico, { novidadesJanelaDias: 15, pendenciaJanelaDias: 10 }, () => AGORA),
    );
  });
  afterEach(async () => {
    await servidor.close();
    db.close();
  });

  it('o processo só com intimação a outro destinatário não pede providência, e a API diz por quê', async () => {
    await repo.registrarSincronizacao(WS, DIG, processo([intimacao(1, 12, [TERCEIRO])]), []);
    const r = await novidades();
    const linha = r.semNovidade.find((x) => x.numero === DIG);
    expect(linha?.processo.pedeProvidencia).toBe(false);
    expect(linha?.processo.providencia).toMatchObject({
      situacao: 'outro',
      motivo: { paraOUsuario: 'nao', rotulo: 'Ato ordinatório' },
      outroDestinatario: { paraOUsuario: 'nao' },
    });
  });

  it('dirigida ao usuário: pede providência, com paraOUsuario "sim" no ato', async () => {
    await repo.registrarSincronizacao(WS, DIG, processo([intimacao(1, 12, ['100/GO'])]), []);
    const linha = (await novidades()).semNovidade.find((x) => x.numero === DIG);
    expect(linha?.processo.pedeProvidencia).toBe(true);
    expect(linha?.processo.providencia).toMatchObject({
      situacao: 'pede',
      motivo: { paraOUsuario: 'sim', tipo: 'intimacao' },
    });
  });

  it('sem OAB identificada o comportamento é o de antes (desconhecido pede providência)', async () => {
    db.prepare('DELETE FROM usuarios').run();
    await repo.registrarSincronizacao(WS, DIG, processo([intimacao(1, 12, [TERCEIRO])]), []);
    const linha = (await novidades()).semNovidade.find((x) => x.numero === DIG);
    expect(linha?.processo.pedeProvidencia).toBe(true);
    expect(linha?.processo.providencia?.motivo.paraOUsuario).toBe('desconhecido');
  });

  it('nenhuma inscrição de advogado sai na resposta', async () => {
    await repo.registrarSincronizacao(WS, DIG, processo([intimacao(1, 12, [TERCEIRO, '100/GO'])]), []);
    const resposta = (await servidor.inject({ method: 'GET', url: '/v1/novidades' })).body;
    expect(resposta).not.toContain('98765');
    expect(resposta).not.toContain('destinatariosOab');
  });
});
