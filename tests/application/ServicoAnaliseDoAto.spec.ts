import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { LimiteDeAnalises } from '../../src/application/politicas/limiteDeAnalises.js';
import {
  paraATela,
  ServicoAnaliseDoAto,
} from '../../src/application/services/ServicoAnaliseDoAto.js';
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
import { RepositorioAnalisesSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAnalisesSqlite.js';
import { ClockFalso } from '../helpers/leitor.js';
import {
  AnalisadorFalso,
  LoggerColetor,
  NOME_DA_PARTE,
  respostaValida,
  TEXTO_DO_ATO,
} from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';

const WS_A = 'ws-a';
const WS_B = 'ws-b';
const NUMERO = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
const DATA = new Date('2026-10-05T12:00:00Z');

const ATO: Movimentacao = {
  data: DATA,
  titulo: 'Despacho',
  idExterno: 'djen:900',
  conteudo: TEXTO_DO_ATO,
};

function processo(movs: Movimentacao[], segredo = false): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(NUMERO_TJSP_A),
    tribunal: 'TJGO',
    classe: 'Procedimento Comum Cível',
    segredoJustica: segredo,
    partes: [{ nome: NOME_DA_PARTE, polo: 'ATIVO', tipoPessoa: 'FISICA', advogados: [] }],
    movimentacoes: movs,
    procedencia: { provider: 'djen', consultadoEm: DATA, deCache: false },
  });
}

describe('ServicoAnaliseDoAto', () => {
  let db: DatabaseSync;
  let repo: RepositorioAcompanhamentosSqlite;
  let analisador: AnalisadorFalso;
  let log: LoggerColetor;
  let planoIa: Set<string>;
  let relogio: ClockFalso;

  function servico(
    opcoes: { porHora?: number; global?: number; porDia?: number } = {},
  ): ServicoAnaliseDoAto {
    return new ServicoAnaliseDoAto({
      repositorio: repo,
      analises: new RepositorioAnalisesSqlite(db),
      assinaturas: { temRecursoSemExcecao: async (ws) => planoIa.has(ws) },
      analisador,
      limite: new LimiteDeAnalises({
        porHora: opcoes.porHora ?? 100,
        simultaneasNoTotal: opcoes.global ?? 10,
        ...(opcoes.porDia !== undefined ? { porDia: opcoes.porDia } : {}),
        clock: relogio,
      }),
      clock: relogio,
      logger: log,
      novoId: (() => {
        let n = 0;
        return () => `analise-${++n}`;
      })(),
    });
  }

  async function semear(
    ws: string,
    movs: Movimentacao[],
    segredo = false,
  ): Promise<void> {
    await repo.acompanhar(ws, NUMERO);
    await repo.registrarSincronizacao(ws, NUMERO, processo(movs, segredo), []);
  }

  const pedido = (ws = WS_A, chave = chaveDaMovimentacao(ATO)) => ({
    workspace: ws,
    numero: NUMERO_TJSP_A,
    chaveDoAto: chave,
  });

  beforeEach(() => {
    db = abrirBanco(':memory:');
    repo = new RepositorioAcompanhamentosSqlite(db);
    analisador = new AnalisadorFalso();
    log = new LoggerColetor();
    planoIa = new Set([WS_A, WS_B]);
    relogio = new ClockFalso();
  });

  describe('o que NÃO chama o modelo', () => {
    it('conta sem o plano IA: frase fixa e zero chamadas ao adaptador', async () => {
      await semear(WS_A, [ATO]);
      planoIa.clear();
      const erro = await servico()
        .analisar(pedido())
        .catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(EntradaNaoAnalisavelError);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('sem_plano');
      expect((erro as Error).message).toBe(
        'A análise por IA faz parte do plano IA. Faça upgrade do plano para usar.',
      );
      expect(analisador.chamadas).toBe(0);
    });

    it('processo em segredo de justiça: zero chamadas, qualquer que seja o texto', async () => {
      await semear(WS_A, [ATO], true);
      const erro = await servico()
        .analisar(pedido())
        .catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('segredo_de_justica');
      expect(analisador.chamadas).toBe(0);
    });

    it('ato só com rótulo: texto insuficiente, zero chamadas', async () => {
      const curto: Movimentacao = {
        data: DATA,
        titulo: 'Conclusos',
        conteudo: 'Ciência.',
      };
      await semear(WS_A, [curto]);
      const erro = await servico()
        .analisar(pedido(WS_A, chaveDaMovimentacao(curto)))
        .catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('texto_insuficiente');
      expect(analisador.chamadas).toBe(0);
    });

    it('aviso de teor não público do tribunal: texto INDISPONÍVEL (mensagem diferente de insuficiente), zero chamadas', async () => {
      const indisponivel: Movimentacao = {
        data: DATA,
        titulo: 'Intimação',
        idExterno: 'djen:901',
        teorIndisponivel: true,
      };
      await semear(WS_A, [indisponivel]);
      const erro = await servico()
        .analisar(pedido(WS_A, chaveDaMovimentacao(indisponivel)))
        .catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('texto_indisponivel');
      expect(analisador.chamadas).toBe(0);
      const insuficiente = await servico()
        .analisar(pedido(WS_A, 'inexistente'))
        .catch((e: unknown) => e);
      expect((insuficiente as Error).message).not.toBe((erro as Error).message);
    });

    it('chave que não está no retrato da conta: ato não encontrado, zero chamadas', async () => {
      await semear(WS_A, [ATO]);
      const erro = await servico()
        .analisar(pedido(WS_A, 'ato-que-nao-existe'))
        .catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('ato_nao_encontrado');
      expect(analisador.chamadas).toBe(0);
    });

    it('processo de OUTRA conta é "não acompanhado": o texto de outro workspace nunca é lido', async () => {
      await semear(WS_A, [ATO]);
      await expect(servico().analisar(pedido(WS_B))).rejects.toBeInstanceOf(
        AcompanhamentoNaoEncontradoError,
      );
      expect(analisador.chamadas).toBe(0);
    });
  });

  describe('análise feita', () => {
    it('envia só texto redigido, devolve com os marcadores trocados e grava SÓ com marcadores', async () => {
      await semear(WS_A, [ATO]);
      const r = await servico().analisar(pedido());
      expect(r.estado).toBe('verificada');

      const enviado = analisador.pedidos[0]!;
      const tudo = `${enviado.sistema}\n${enviado.usuario}`;
      expect(tudo).not.toContain(NOME_DA_PARTE);
      expect(tudo).not.toContain('98765-4321');
      expect(tudo).toContain('[PARTE A]');

      if (r.estado !== 'verificada') throw new Error('esperava verificada');
      // Para a tela, o marcador volta a ser o valor da própria conta.
      expect(r.resumo).toBe(
        `${NOME_DA_PARTE} deve se manifestar sobre o laudo pericial.`,
      );
      expect(r.modelo).toBe('modelo/teste');
      expect(r.provedor).toBe('provedor-teste');
      expect(r.versaoPrompt).toBe('ato-1.2.0');

      const linha = db.prepare('SELECT * FROM analises_ia').get() as Record<
        string,
        unknown
      >;
      const gravado = JSON.stringify(linha);
      expect(gravado).toContain('[PARTE A]');
      expect(gravado).not.toContain(NOME_DA_PARTE);
      expect(gravado).not.toContain(TEXTO_DO_ATO);
      expect(linha['workspace']).toBe(WS_A);
      expect(linha['latencia_ms']).toBeTypeOf('number');
    });

    it('citação que não existe no texto enviado vira "não verificada" (e é gravada, sem entrar na tela)', async () => {
      await semear(WS_A, [ATO]);
      analisador.resposta = async () => ({
        resposta: respostaValida({
          trecho_chave: 'trecho inventado que não consta do ato',
          acoes_possiveis: [],
        }),
        modelo: 'modelo/teste',
        provedor: 'provedor-teste',
      });
      const r = await servico().analisar(pedido());
      expect(r.estado).toBe('nao_verificada');
      expect(db.prepare('SELECT count(*) AS n FROM analises_ia').get()).toMatchObject({
        n: 1,
      });
    });

    it('ação que copia o trecho-chave vira "não verificada", sem texto na tela nem no log', async () => {
      await semear(WS_A, [ATO]);
      analisador.resposta = async () => ({
        resposta: respostaValida({
          acoes_possiveis: [{ acao: 'que se manifeste sobre o laudo pericial' }],
        }),
        modelo: 'modelo/teste',
        provedor: 'provedor-teste',
      });
      const r = await servico().analisar(pedido());
      expect(r.estado).toBe('nao_verificada');
      expect(JSON.stringify(r)).not.toContain('laudo');
      const log_ = log.linhas.join('\n');
      expect(log_).not.toContain('laudo pericial');
      expect(log_).not.toContain(NOME_DA_PARTE);
    });

    it('ação válida chega à tela só com a providência (sem trecho), e a análise gravada antiga com trecho não o expõe', async () => {
      await semear(WS_A, [ATO]);
      const r = await servico().analisar(pedido());
      expect(r.estado).toBe('verificada');
      if (r.estado !== 'verificada') return;
      expect(r.acoesPossiveis).toEqual([
        { acao: 'Parte autora: apresentar manifestação sobre o laudo' },
      ]);
      // Linha gravada antes da 0.38.5: a ação trazia `trecho`, e ele não sai da API.
      const velha = paraATela(
        {
          id: 'x',
          workspace: WS_A,
          numero: NUMERO,
          chaveDoAto: 'k',
          resultado: {
            estado: 'verificada',
            parecePedir: 'manifestar',
            acoesPossiveis: [
              { acao: 'Manifestar-se', trecho: 'se manifeste sobre o laudo' },
            ] as never,
            pontosDeAtencao: [],
          },
          procedencia: {
            modelo: 'm',
            versaoPrompt: 'ato-1.0.0',
            provedor: 'p',
            criadaEm: DATA,
          },
          medidas: { latenciaMs: 1 },
        },
        (t) => t,
      );
      expect(velha.acoesPossiveis).toEqual([{ acao: 'Manifestar-se' }]);
    });

    it('falha do modelo vira estado "erro": nada é gravado e nenhum texto de ato chega ao log', async () => {
      await semear(WS_A, [ATO]);
      analisador.resposta = async () => {
        throw new ProviderIndisponivelError(
          'openrouter',
          `eco do pedido: ${TEXTO_DO_ATO}`,
        );
      };
      const r = await servico().analisar(pedido());
      expect(r).toEqual({ estado: 'erro' });
      expect(db.prepare('SELECT count(*) AS n FROM analises_ia').get()).toMatchObject({
        n: 0,
      });
      const log_ = log.linhas.join('\n');
      expect(log_).not.toContain('laudo pericial');
      expect(log_).not.toContain(NOME_DA_PARTE);
    });

    it('o log da falha traz status HTTP, passo e funil (truncado), e nenhum texto, chave ou dado do processo', async () => {
      await semear(WS_A, [ATO]);
      analisador.resposta = async () => {
        throw new ProviderIndisponivelError(
          'openrouter',
          `eco do pedido: ${TEXTO_DO_ATO}`,
          {
            roteamento: {
              status: 404,
              passo: 'require_parameters',
              funil: { inicial: 5, restantes: 0, nota: 'a'.repeat(900) },
            },
          },
        );
      };
      const r = await servico().analisar(pedido());
      expect(r).toEqual({ estado: 'erro' });

      const linha =
        log.linhas.find((l) => l.includes('análise do ato não concluída')) ?? '';
      const contexto = JSON.parse(linha.slice(linha.indexOf('{'))) as Record<
        string,
        unknown
      >;
      expect(contexto['statusHttp']).toBe(404);
      expect(contexto['passoDoRoteamento']).toBe('require_parameters');
      const funil = String(contexto['funilDoRoteamento']);
      expect(funil.startsWith('{"inicial":5,"restantes":0')).toBe(true);
      expect(funil.length).toBeLessThanOrEqual(601);
      expect(funil.endsWith('…')).toBe(true);
      const tudo = log.linhas.join('\n');
      expect(tudo).not.toContain('laudo pericial');
      expect(tudo).not.toContain(NOME_DA_PARTE);
      expect(tudo).not.toContain(NUMERO);
    });

    it('erro sem roteamento: a linha mantém só causa e tipo (sem campos vazios)', async () => {
      await semear(WS_A, [ATO]);
      analisador.resposta = async () => {
        throw new ProviderIndisponivelError('openrouter', 'fora');
      };
      await servico().analisar(pedido());
      const linha =
        log.linhas.find((l) => l.includes('análise do ato não concluída')) ?? '';
      expect(linha).not.toContain('statusHttp');
      expect(linha).not.toContain('passoDoRoteamento');
      expect(linha).not.toContain('funilDoRoteamento');
    });

    it('o clique repetido analisa de novo (sem cache): duas chamadas, duas linhas', async () => {
      await semear(WS_A, [ATO]);
      const s = servico();
      await s.analisar(pedido());
      await s.analisar(pedido());
      expect(analisador.chamadas).toBe(2);
      expect(db.prepare('SELECT count(*) AS n FROM analises_ia').get()).toMatchObject({
        n: 2,
      });
    });

    it('repassa o sinal de cancelamento ao adaptador', async () => {
      await semear(WS_A, [ATO]);
      const controle = new AbortController();
      await servico().analisar({ ...pedido(), sinal: controle.signal });
      expect(analisador.pedidos[0]?.sinal).toBe(controle.signal);
    });
  });

  describe('limite de uso', () => {
    it('acima do limite por hora da conta: recusa antes de chamar; outra conta não é afetada; passada a hora, libera', async () => {
      await semear(WS_A, [ATO]);
      await semear(WS_B, [ATO]);
      const s = servico({ porHora: 1 });
      await s.analisar(pedido(WS_A));
      const erro = await s.analisar(pedido(WS_A)).catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('limite_de_uso');
      expect((erro as Error).message).toBe(
        'Há muitas análises em andamento. Tente novamente em instantes.',
      );
      expect(analisador.chamadas).toBe(1);
      await s.analisar(pedido(WS_B));
      expect(analisador.chamadas).toBe(2);
      relogio.avancar(3_600_001);
      await s.analisar(pedido(WS_A));
      expect(analisador.chamadas).toBe(3);
    });

    it('teto técnico do dia (v0.50.0): recusa sem chamar o modelo, com a frase neutra; outra conta não é afetada; zera no dia seguinte de São Paulo', async () => {
      // O relógio falso começa em 01/10/2026 12:00 UTC = 09:00 em São Paulo.
      await semear(WS_A, [ATO]);
      await semear(WS_B, [ATO]);
      const s = servico({ porDia: 2 });
      await s.analisar(pedido(WS_A));
      await s.analisar(pedido(WS_A));
      const erro = await s.analisar(pedido(WS_A)).catch((e: unknown) => e);
      expect((erro as EntradaNaoAnalisavelError).motivo).toBe('limite_diario');
      expect((erro as Error).message).toBe(
        'Muitas análises hoje. Tente de novo amanhã ou fale com a gente.',
      );
      expect(analisador.chamadas).toBe(2);
      // Isolamento: a outra conta tem o próprio teto.
      await s.analisar(pedido(WS_B));
      expect(analisador.chamadas).toBe(3);
      // 23:59 em São Paulo (02:59 UTC do dia seguinte): ainda é o mesmo dia.
      relogio.ms = new Date('2026-10-02T02:59:00.000Z').getTime();
      expect(
        (
          (await s
            .analisar(pedido(WS_A))
            .catch((e: unknown) => e)) as EntradaNaoAnalisavelError
        ).motivo,
      ).toBe('limite_diario');
      expect(analisador.chamadas).toBe(3);
      // 00:00 em São Paulo: dia novo, zera.
      relogio.ms = new Date('2026-10-02T03:00:00.000Z').getTime();
      await s.analisar(pedido(WS_A));
      expect(analisador.chamadas).toBe(4);
      // A recusa não grava linha nenhuma.
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM analises_ia').get() as { n: number }).n,
      ).toBe(4);
    });

    it('sem teto do dia configurado (o resumo usa assim), nada muda', async () => {
      await semear(WS_A, [ATO]);
      const s = servico();
      for (let i = 0; i < 5; i++) await s.analisar(pedido(WS_A));
      expect(analisador.chamadas).toBe(5);
    });

    it('um registro por análise com modelo, provedor, duração, tokens e custo — sem texto do ato nem dado pessoal', async () => {
      await semear(WS_A, [ATO]);
      relogio.avancar(0);
      await servico().analisar(pedido());
      const linha = db.prepare('SELECT * FROM analises_ia').get() as Record<
        string,
        unknown
      >;
      expect(linha).toMatchObject({
        workspace: WS_A,
        modelo: 'modelo/teste',
        provedor: 'provedor-teste',
        tokens_entrada: 400,
        tokens_saida: 90,
        custo_usd: 0.0002,
      });
      expect(linha['latencia_ms']).toBeTypeOf('number');
      const gravado = JSON.stringify(linha);
      expect(gravado).not.toContain(TEXTO_DO_ATO);
      expect(gravado).not.toContain(NOME_DA_PARTE);
      expect(gravado).not.toContain('98765-4321');
    });

    it('uma análise em andamento por conta e teto global baixo', async () => {
      await semear(WS_A, [ATO]);
      await semear(WS_B, [ATO]);
      let liberar: () => void = () => {};
      const travado = new Promise<void>((r) => (liberar = r));
      analisador.resposta = async () => {
        await travado;
        return { resposta: respostaValida(), modelo: 'm', provedor: 'p' };
      };
      const s = servico({ global: 1 });
      const primeira = s.analisar(pedido(WS_A));
      // mesma conta
      const mesmaConta = await s.analisar(pedido(WS_A)).catch((e: unknown) => e);
      expect((mesmaConta as EntradaNaoAnalisavelError).motivo).toBe('limite_de_uso');
      // outra conta, mas o teto global (1) está cheio
      const outraConta = await s.analisar(pedido(WS_B)).catch((e: unknown) => e);
      expect((outraConta as EntradaNaoAnalisavelError).motivo).toBe('limite_de_uso');
      expect(analisador.chamadas).toBe(1);
      liberar();
      await primeira;
      // vaga liberada no fim
      analisador.resposta = async () => ({
        resposta: respostaValida(),
        modelo: 'm',
        provedor: 'p',
      });
      await s.analisar(pedido(WS_B));
      expect(analisador.chamadas).toBe(2);
    });

    it('a vaga é liberada mesmo quando o modelo falha', async () => {
      await semear(WS_A, [ATO]);
      analisador.resposta = async () => {
        throw new ProviderIndisponivelError('openrouter', 'fora');
      };
      const s = servico({ global: 1 });
      expect(await s.analisar(pedido())).toEqual({ estado: 'erro' });
      expect(await s.analisar(pedido())).toEqual({ estado: 'erro' });
      expect(analisador.chamadas).toBe(2);
    });
  });

  describe('avaliação', () => {
    it('só o dono avalia, pode corrigir, e a de outra conta é 404 idêntico a "não existe"', async () => {
      await semear(WS_A, [ATO]);
      const s = servico();
      const r = await s.analisar(pedido());
      if (r.estado === 'erro') throw new Error('esperava análise');
      await s.avaliar(WS_A, r.id, 'util');
      await s.avaliar(WS_A, r.id, 'perigoso');
      expect(db.prepare('SELECT avaliacao FROM analises_ia').get()).toMatchObject({
        avaliacao: 'perigoso',
      });
      const deOutro = await s.avaliar(WS_B, r.id, 'util').catch((e: unknown) => e);
      const inexistente = await s
        .avaliar(WS_A, 'nao-existe', 'util')
        .catch((e: unknown) => e);
      expect(deOutro).toBeInstanceOf(AnaliseNaoEncontradaError);
      expect((deOutro as Error).message).toBe((inexistente as Error).message);
      expect(db.prepare('SELECT avaliacao FROM analises_ia').get()).toMatchObject({
        avaliacao: 'perigoso',
      });
    });
  });
});
