import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  LimiteDeAnalises,
  TetoDiario,
} from '../../src/application/politicas/limiteDeAnalises.js';
import { ServicoResumoDoProcesso } from '../../src/application/services/ServicoResumoDoProcesso.js';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import {
  AcompanhamentoNaoEncontradoError,
  AnaliseNaoEncontradaError,
  EntradaNaoAnalisavelError,
  ProviderIndisponivelError,
} from '../../src/domain/errors/index.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioResumosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioResumosSqlite.js';
import { LoggerColetor, NOME_DA_PARTE } from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';
import { ClockFalso } from '../helpers/leitor.js';
import {
  AGORA_DO_RESUMO,
  ATOS_DO_RESUMO,
  INTIMACAO,
  respostaDoResumo,
  ResumidorFalso,
  TRECHO_DO_DESPACHO,
} from '../helpers/resumoIa.js';

const WS_A = 'ws-a';
const WS_B = 'ws-b';
const NUMERO = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;

function processo(movs: Movimentacao[], segredo = false): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(NUMERO_TJSP_A),
    tribunal: 'TJGO',
    classe: 'Procedimento Comum Cível',
    segredoJustica: segredo,
    partes: [{ nome: NOME_DA_PARTE, polo: 'ATIVO', tipoPessoa: 'FISICA', advogados: [] }],
    movimentacoes: movs,
    procedencia: { provider: 'djen', consultadoEm: AGORA_DO_RESUMO, deCache: false },
  });
}

describe('ServicoResumoDoProcesso', () => {
  let db: DatabaseSync;
  let repo: RepositorioAcompanhamentosSqlite;
  let resumidor: ResumidorFalso;
  let log: LoggerColetor;
  let planoIa: Set<string>;
  let relogio: ClockFalso;

  function servico(porHora = 100, teto?: TetoDiario): ServicoResumoDoProcesso {
    return new ServicoResumoDoProcesso({
      repositorio: repo,
      resumos: new RepositorioResumosSqlite(db),
      resumidor,
      exigirPlanoIa: async (ws) => {
        if (!planoIa.has(ws)) {
          throw new EntradaNaoAnalisavelError('sem_plano', 'Faça upgrade do plano.');
        }
      },
      limite: new LimiteDeAnalises({
        porHora,
        simultaneasNoTotal: 10,
        ...(teto ? { teto } : {}),
        clock: relogio,
      }),
      clock: relogio,
      logger: log,
      novoId: (() => {
        let n = 0;
        return () => `resumo-${++n}`;
      })(),
      janelaDePendenciaDias: 10,
    });
  }

  async function semear(ws: string, movs: Movimentacao[], segredo = false) {
    await repo.acompanhar(ws, NUMERO);
    await repo.registrarSincronizacao(ws, NUMERO, processo(movs, segredo), []);
  }

  const pedido = (ws = WS_A) => ({ workspace: ws, numero: NUMERO_TJSP_A });

  beforeEach(() => {
    db = abrirBanco(':memory:');
    repo = new RepositorioAcompanhamentosSqlite(db);
    resumidor = new ResumidorFalso();
    log = new LoggerColetor();
    planoIa = new Set([WS_A, WS_B]);
    relogio = new ClockFalso();
    relogio.ms = AGORA_DO_RESUMO.getTime();
  });

  describe('o que NÃO chama o modelo', () => {
    it('conta sem o plano IA: zero chamadas', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      planoIa.clear();
      const erro = await servico()
        .resumir(pedido())
        .catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('sem_plano');
      expect(resumidor.chamadas).toBe(0);
    });

    it('segredo de justiça: zero chamadas', async () => {
      await semear(WS_A, ATOS_DO_RESUMO, true);
      const erro = await servico()
        .resumir(pedido())
        .catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('segredo_de_justica');
      expect(resumidor.chamadas).toBe(0);
    });

    it('nenhum ato com texto utilizável: texto insuficiente, zero chamadas', async () => {
      await semear(WS_A, [
        { data: new Date('2026-09-01T12:00:00Z'), titulo: 'Conclusos' },
        {
          data: new Date('2026-09-02T12:00:00Z'),
          titulo: 'Juntada',
          teorIndisponivel: true,
        },
      ]);
      const erro = await servico()
        .resumir(pedido())
        .catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('texto_insuficiente');
      expect(resumidor.chamadas).toBe(0);
    });

    it('processo de outra conta é "não acompanhado"', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      await expect(servico().resumir(pedido(WS_B))).rejects.toBeInstanceOf(
        AcompanhamentoNaoEncontradoError,
      );
      expect(resumidor.chamadas).toBe(0);
    });

    it('teto técnico diário COMPARTILHADO com a análise de ato (v0.52.0): esgotado, é a frase neutra de sempre e zero chamadas', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      const teto = new TetoDiario(2, relogio);
      // Duas análises de ato já gastaram o dia desta conta (outro limite, o MESMO contador).
      const daAnalise = new LimiteDeAnalises({
        porHora: 100,
        simultaneasNoTotal: 10,
        teto,
        clock: relogio,
      });
      for (let n = 0; n < 2; n++) {
        const v = daAnalise.reservar(WS_A);
        if ('liberar' in v) v.liberar();
      }
      const erro = await servico(100, teto)
        .resumir(pedido())
        .catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('limite_de_uso');
      expect((erro as Error).message).toBe(
        'Há muitos resumos em andamento ou o limite por hora foi atingido. Tente novamente em instantes.',
      );
      expect(resumidor.chamadas).toBe(0);
    });

    it('acima do limite por hora: limite_de_uso, sem chamar o modelo de novo', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      const s = servico(1);
      await s.resumir(pedido());
      const erro = await s.resumir(pedido()).catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('limite_de_uso');
      expect(resumidor.chamadas).toBe(1);
    });
  });

  describe('resumo feito', () => {
    it('envia um pedido só, sem o nome da parte, e devolve com os valores da conta', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      const r = await servico().resumir(pedido());
      expect(resumidor.chamadas).toBe(1);
      const enviado = resumidor.pedidos[0]!;
      expect(`${enviado.sistema}\n${enviado.usuario}`).not.toContain(NOME_DA_PARTE);
      expect(enviado.usuario).toContain('[PARTE A]');

      if (r.estado !== 'verificado') throw new Error('esperava verificado');
      expect(r.situacao[0]?.texto).toBe(
        `${NOME_DA_PARTE} foi intimada a se pronunciar sobre o laudo pericial juntado.`,
      );
      expect(r.situacao[0]?.ato).toMatchObject({
        chaveDoAto: chaveDaMovimentacao(INTIMACAO),
        rotulo: 'Intimação',
        tipoDaComunicacao: 'Intimação',
      });
      expect(r.versaoPrompt).toBe('resumo-1.1.0');
      expect(r.avaliacao).toBeNull();
    });

    it('grava só com marcadores, sem o texto dos atos', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      await servico().resumir(pedido());
      const linha = db.prepare('SELECT * FROM resumos_ia').get() as Record<
        string,
        unknown
      >;
      const gravado = JSON.stringify(linha);
      expect(gravado).toContain('[PARTE A]');
      expect(gravado).not.toContain(NOME_DA_PARTE);
      expect(gravado).not.toContain('Defiro a juntada');
      expect(linha['workspace']).toBe(WS_A);
    });

    it('conta as providências do sistema que a IA não citou, separado do resumo', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      resumidor.resposta = async () => ({
        resposta: respostaDoResumo({
          situacao: [
            {
              texto: 'O juízo mandou oficiar o banco informado.',
              ato: 'A2',
              trecho: TRECHO_DO_DESPACHO,
            },
          ],
          pendencias: [],
        }),
        modelo: 'modelo/teste',
        provedor: 'provedor-teste',
      });
      const r = await servico().resumir(pedido());
      if (r.estado !== 'verificado') throw new Error('esperava verificado');
      expect(r.contagens.providenciasDoSistema).toBe(1);
      expect(r.contagens.providenciasNaoCitadas).toBe(1);
    });

    it('com a intimação citada, nenhuma providência fica sem citação', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      const r = await servico().resumir(pedido());
      if (r.estado !== 'verificado') throw new Error('esperava verificado');
      expect(r.contagens).toMatchObject({
        providenciasDoSistema: 1,
        providenciasNaoCitadas: 0,
        atosNoProcesso: 6,
        atosComTexto: 3,
        atosSoTitulo: 3,
        itensDescartados: 0,
      });
    });

    it('resposta com citação inventada vira "não verificado", sem texto na tela nem no log', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      resumidor.resposta = async () => ({
        resposta: respostaDoResumo({
          situacao: [
            { texto: 'Algo foi decidido.', ato: 'A1', trecho: 'trecho que não existe' },
          ],
        }),
        modelo: 'modelo/teste',
        provedor: 'provedor-teste',
      });
      const r = await servico().resumir(pedido());
      expect(r.estado).toBe('nao_verificado');
      if (r.estado === 'erro') return;
      expect(r.situacao).toEqual([]);
      expect(db.prepare('SELECT count(*) AS n FROM resumos_ia').get()).toMatchObject({
        n: 1,
      });
      expect(log.linhas.join('\n')).not.toContain('Algo foi decidido');
    });

    it('falha do modelo vira estado "erro": nada gravado e nenhum texto no log', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      resumidor.resposta = async () => {
        throw new ProviderIndisponivelError('openrouter', `eco: ${NOME_DA_PARTE}`);
      };
      const r = await servico().resumir(pedido());
      expect(r).toEqual({ estado: 'erro' });
      expect(db.prepare('SELECT count(*) AS n FROM resumos_ia').get()).toMatchObject({
        n: 0,
      });
      expect(log.linhas.join('\n')).not.toContain(NOME_DA_PARTE);
    });

    it('a vaga do limite é liberada após uma falha', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      const s = servico(100);
      resumidor.resposta = async () => {
        throw new ProviderIndisponivelError('openrouter', 'fora');
      };
      await s.resumir(pedido());
      await s.resumir(pedido());
      expect(resumidor.chamadas).toBe(2);
    });
  });

  describe('avaliação', () => {
    it('o dono avalia e pode corrigir; outra conta recebe o mesmo 404 de "não existe"', async () => {
      await semear(WS_A, ATOS_DO_RESUMO);
      const s = servico();
      const r = await s.resumir(pedido());
      if (r.estado === 'erro') throw new Error('erro');
      await s.avaliar(WS_A, r.id, 'util');
      await s.avaliar(WS_A, r.id, 'errado');
      expect(
        (db.prepare('SELECT avaliacao FROM resumos_ia').get() as { avaliacao: string })
          .avaliacao,
      ).toBe('errado');
      await expect(s.avaliar(WS_B, r.id, 'perigoso')).rejects.toBeInstanceOf(
        AnaliseNaoEncontradaError,
      );
      await expect(s.avaliar(WS_A, 'nao-existe', 'util')).rejects.toBeInstanceOf(
        AnaliseNaoEncontradaError,
      );
    });
  });
});
