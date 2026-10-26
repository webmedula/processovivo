import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { INSTRUCAO_DO_SISTEMA } from '../../src/application/politicas/entradaDoModelo.js';
import { INSTRUCAO_DA_PECA } from '../../src/application/politicas/entradaDaPeca.js';
import { INSTRUCAO_DO_RESUMO } from '../../src/application/politicas/entradaDoResumo.js';
import {
  LimiteDeAnalises,
  TetoDiario,
} from '../../src/application/politicas/limiteDeAnalises.js';
import { ServicoAnaliseDePeca } from '../../src/application/services/ServicoAnaliseDePeca.js';
import { ServicoAnaliseDoAto } from '../../src/application/services/ServicoAnaliseDoAto.js';
import {
  ServicoExperimentoDeInstrucoes,
  MAXIMO_DE_EXPERIMENTOS_POR_HORA,
} from '../../src/application/services/ServicoExperimentoDeInstrucoes.js';
import { ServicoInstrucoesDeIa } from '../../src/application/services/ServicoInstrucoesDeIa.js';
import { ServicoResumoDoProcesso } from '../../src/application/services/ServicoResumoDoProcesso.js';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import { montarSistema } from '../../src/domain/entities/InstrucoesDeIa.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import {
  AnaliseDePecaRecusadaError,
  EntradaNaoAnalisavelError,
  InstrucaoDeIaRecusadaError,
  ProviderIndisponivelError,
} from '../../src/domain/errors/index.js';
import { RegistroDeOcorrenciasDeIaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';
import { PdftotextExtrator } from '../../src/infrastructure/pdf/PdftotextExtrator.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioAnalisesDePecaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAnalisesDePecaSqlite.js';
import { RepositorioAnalisesSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAnalisesSqlite.js';
import { RepositorioDeInstrucoesDeIaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeInstrucoesDeIaSqlite.js';
import { RepositorioResumosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioResumosSqlite.js';
import { AnalisadorDePecaFalso, PAGINAS_DA_PECA } from '../helpers/analiseDePeca.js';
import {
  AnalisadorFalso,
  LoggerColetor,
  NOME_DA_PARTE,
  TEXTO_DO_ATO,
} from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';
import { ClockFalso } from '../helpers/leitor.js';
import { pdfComPaginas } from '../helpers/pdfDePecas.js';
import { ATOS_DO_RESUMO, ResumidorFalso } from '../helpers/resumoIa.js';

/*
 * O experimento do operador (Fase C): a instrução publicada e o rascunho rodam sobre o MESMO caso real, pelo
 * MESMO caminho de produção (redação, verificação, segredo de justiça), e nada é gravado. Só a conta do dono.
 * Modelos são dublês; nenhuma rede.
 */

const DONO = 'ws-do-dono';
const OUTRA = 'ws-de-um-assinante';
const NUMERO = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
const DATA = new Date('2026-10-05T12:00:00Z');
const OP = 'ab12cd34';
const ATO: Movimentacao = {
  data: DATA,
  titulo: 'Despacho',
  idExterno: 'djen:900',
  conteudo: TEXTO_DO_ATO,
};
const PUBLICADA = 'Destaque o prazo escrito no ato.';
const RASCUNHO = 'Seja bem mais curto e cite o prazo.';

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

let db: DatabaseSync;
let repo: RepositorioAcompanhamentosSqlite;
let relogio: ClockFalso;
let log: LoggerColetor;
let instrucoes: ServicoInstrucoesDeIa;
let analisadorDoAto: AnalisadorFalso;
let resumidor: ResumidorFalso;
let analisadorDaPeca: AnalisadorDePecaFalso;
let dono: string | undefined;
let n = 0;
let teto: TetoDiario;
let ocorrencias: RegistroDeOcorrenciasDeIaSqlite;
let pdfDaPeca: Uint8Array;

function montar(opcoes: { maximoPorHora?: number } = {}): ServicoExperimentoDeInstrucoes {
  const limite = (funcao: 'ato' | 'resumo' | 'peca'): LimiteDeAnalises =>
    new LimiteDeAnalises({
      porHora: 100,
      simultaneasNoTotal: 10,
      teto,
      funcao,
      clock: relogio,
    });
  const ato = new ServicoAnaliseDoAto({
    repositorio: repo,
    analises: new RepositorioAnalisesSqlite(db),
    // O dono NÃO precisa de plano no experimento: se o serviço consultasse o plano, este dublê derrubaria o teste.
    assinaturas: {
      temRecursoSemExcecao: async () => {
        throw new Error('o experimento não consulta plano');
      },
    },
    analisador: analisadorDoAto,
    limite: limite('ato'),
    clock: relogio,
    logger: log,
    novoId: () => `a-${++n}`,
    instrucoes,
    ocorrencias,
  });
  const resumo = new ServicoResumoDoProcesso({
    repositorio: repo,
    resumos: new RepositorioResumosSqlite(db),
    resumidor,
    exigirPlanoIa: async () => {
      throw new Error('o experimento não consulta plano');
    },
    limite: limite('resumo'),
    clock: relogio,
    logger: log,
    novoId: () => `r-${++n}`,
    janelaDePendenciaDias: 10,
    instrucoes,
    ocorrencias,
  });
  const peca = new ServicoAnaliseDePeca({
    repositorio: repo,
    analises: new RepositorioAnalisesDePecaSqlite(db),
    assinaturas: {
      temRecursoSemExcecao: async () => {
        throw new Error('o experimento não consulta plano');
      },
    },
    fonte: {
      pecaParaAnalise: async () => ({
        tribunal: 'TJGO',
        arquivo: {
          tamanho: pdfDaPeca.byteLength,
          async *ler(inicio: number, fim: number) {
            yield pdfDaPeca.slice(inicio, fim + 1);
          },
        },
      }),
    },
    extrator: new PdftotextExtrator(),
    analisador: analisadorDaPeca,
    limite: limite('peca'),
    liberacao: { habilitada: false, workspaces: [] },
    tribunais: ['TJGO'],
    modelo: 'modelo/pedido',
    resultadoDias: 30,
    clock: relogio,
    logger: log,
    novoId: () => `p-${++n}`,
    instrucoes,
    ocorrencias,
  });
  return new ServicoExperimentoDeInstrucoes({
    instrucoes,
    fontes: { ato, resumo, peca },
    repositorio: repo,
    pasta: {
      visao: async () => ({
        pecas: [
          {
            pecaId: 'p1',
            rotulo: 'Petição inicial',
            data: DATA,
            paginasDaPeca: 2,
            estado: 'disponivel',
          },
          {
            pecaId: 'p2',
            rotulo: 'Contestação',
            data: DATA,
            paginasDaPeca: 3,
            estado: 'nao_baixada',
          },
        ] as never,
      }),
    },
    contaDoDono: async () => dono,
    clock: relogio,
    logger: log,
    ...(opcoes.maximoPorHora !== undefined
      ? { maximoPorHora: opcoes.maximoPorHora }
      : {}),
  });
}

beforeEach(async () => {
  db = abrirBanco(':memory:');
  repo = new RepositorioAcompanhamentosSqlite(db);
  relogio = new ClockFalso();
  relogio.ms = new Date('2026-10-06T15:00:00.000Z').getTime();
  log = new LoggerColetor();
  instrucoes = new ServicoInstrucoesDeIa({
    repositorio: new RepositorioDeInstrucoesDeIaSqlite(db),
    textosFixos: {
      ato: { fixa: INSTRUCAO_DO_SISTEMA, formato: '' },
      resumo: { fixa: INSTRUCAO_DO_RESUMO, formato: '' },
      peca: { fixa: INSTRUCAO_DA_PECA, formato: '' },
    },
    clock: relogio,
    logger: log,
    validadeDoCacheMs: 0,
  });
  analisadorDoAto = new AnalisadorFalso();
  resumidor = new ResumidorFalso();
  analisadorDaPeca = new AnalisadorDePecaFalso();
  dono = DONO;
  teto = new TetoDiario(1000, relogio);
  ocorrencias = new RegistroDeOcorrenciasDeIaSqlite(db, relogio, log);
  await repo.acompanhar(DONO, NUMERO);
  await repo.registrarSincronizacao(
    DONO,
    NUMERO,
    processo([ATO, ...ATOS_DO_RESUMO.slice(1)]),
    [],
  );
  // A conta de um assinante com o MESMO processo: o experimento nunca a lê.
  await repo.acompanhar(OUTRA, NUMERO);
  await repo.registrarSincronizacao(OUTRA, NUMERO, processo([ATO]), []);
  // Instrução publicada (e1) e um rascunho (e2) diferentes.
  const r1 = instrucoes.salvarRascunho(OP, 'ato', PUBLICADA, '');
  instrucoes.publicar(OP, 'ato', { versao: r1.versao, confirmado: true });
  instrucoes.salvarRascunho(OP, 'ato', RASCUNHO, '');
  const r2 = instrucoes.salvarRascunho(OP, 'resumo', PUBLICADA, '');
  instrucoes.publicar(OP, 'resumo', { versao: r2.versao, confirmado: true });
  instrucoes.salvarRascunho(OP, 'resumo', RASCUNHO, '');
  const r3 = instrucoes.salvarRascunho(OP, 'peca', PUBLICADA, '');
  instrucoes.publicar(OP, 'peca', { versao: r3.versao, confirmado: true });
  instrucoes.salvarRascunho(OP, 'peca', RASCUNHO, '');
  pdfDaPeca = await pdfComPaginas(PAGINAS_DA_PECA);
});

const motivo = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) =>
      e instanceof InstrucaoDeIaRecusadaError
        ? e.motivo
        : e instanceof EntradaNaoAnalisavelError ||
            e instanceof AnaliseDePecaRecusadaError
          ? e.motivo
          : `outro:${String(e)}`,
  );

describe('análise de ato: publicada × rascunho no MESMO caso', () => {
  it('roda as duas, cada uma com a SUA instrução, e devolve as duas respostas completas', async () => {
    const e = montar();
    const r = await e.experimentar(
      { funcao: 'ato', numero: NUMERO_TJSP_A, chaveDoAto: chaveDaMovimentacao(ATO) },
      undefined,
    );
    expect(analisadorDoAto.chamadas).toBe(2);
    const sistemas = analisadorDoAto.pedidos.map((p) => p.sistema);
    expect(sistemas).toContain(montarSistema('ato', INSTRUCAO_DO_SISTEMA, PUBLICADA));
    expect(sistemas).toContain(montarSistema('ato', INSTRUCAO_DO_SISTEMA, RASCUNHO));
    // o mesmo caso: a mensagem do usuário é igual nas duas chamadas
    expect(analisadorDoAto.pedidos[0]?.usuario).toBe(analisadorDoAto.pedidos[1]?.usuario);
    expect(r.bracos.map((b) => [b.rotulo, b.versao, b.estado])).toEqual([
      ['publicada', 1, 'ok'],
      // a edição do rascunho é a seguinte à publicada (e1 em produção, e2 em edição)
      ['rascunho', 2, 'ok'],
    ]);
    const publicada = r.bracos[0];
    if (publicada?.estado !== 'ok' || !('analise' in publicada))
      throw new Error('esperava ok');
    const analise = publicada.analise as {
      estado: string;
      resumo?: string;
      versaoPrompt: string;
    };
    // as citações foram verificadas COMO na produção, e os nomes voltam (a conta é a do dono)
    expect(analise.estado).toBe('verificada');
    expect(analise.resumo).toContain('Mariana');
    expect(publicada.citacoes.validas).toBeGreaterThan(0);
    expect(publicada.latenciaMs).toBeGreaterThanOrEqual(0);
    expect(publicada.custoUsd).toBe(0.0002);
    expect(analise.versaoPrompt).toMatch(/\+e1$/);
  });

  it('o rascunho pode vir da tela (texto ainda não salvo) e vale mais que o salvo', async () => {
    const e = montar();
    await e.experimentar(
      { funcao: 'ato', numero: NUMERO_TJSP_A, chaveDoAto: chaveDaMovimentacao(ATO) },
      'Texto digitado e ainda não salvo.',
    );
    expect(analisadorDoAto.pedidos.map((p) => p.sistema)).toContain(
      montarSistema('ato', INSTRUCAO_DO_SISTEMA, 'Texto digitado e ainda não salvo.'),
    );
  });

  it('NÃO grava nada: nem a análise, nem o texto do caso, nem as respostas; o teto dos assinantes e as ocorrências ficam como estavam', async () => {
    const e = montar();
    await e.experimentar(
      { funcao: 'ato', numero: NUMERO_TJSP_A, chaveDoAto: chaveDaMovimentacao(ATO) },
      undefined,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM analises_ia').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ia_ocorrencias_dia').get()).toEqual({
      n: 0,
    });
    // o teto técnico do dia (dos assinantes E do dono) não foi consumido
    expect(teto.cabe(DONO, 1000)).toBe(true);
    // procura o texto do caso, o nome da parte e o telefone em TODAS as tabelas que podem guardar análise
    for (const t of [
      'analises_ia',
      'resumos_ia',
      'analises_pecas_ia',
      'ia_instrucoes',
      'ia_alteracoes',
      'ia_config',
      'ia_testes_modelo',
    ]) {
      const tudo = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());
      expect(tudo, t).not.toContain('laudo pericial');
      expect(tudo, t).not.toContain('98765-4321');
    }
    const logs = log.linhas.join('\n');
    expect(logs).not.toContain('laudo pericial');
    expect(logs).not.toContain('Mariana');
    expect(logs).toContain('experimento de instruções concluído');
  });

  it('processo em segredo de justiça: nenhuma chamada ao modelo', async () => {
    await repo.registrarSincronizacao(DONO, NUMERO, processo([ATO], true), []);
    const e = montar();
    const m = await motivo(
      e.experimentar(
        { funcao: 'ato', numero: NUMERO_TJSP_A, chaveDoAto: chaveDaMovimentacao(ATO) },
        undefined,
      ),
    );
    expect(m).toBe('segredo_de_justica');
    expect(analisadorDoAto.chamadas).toBe(0);
  });

  it('um dos lados falha: o outro volta, sem derrubar o experimento', async () => {
    let i = 0;
    const normal = analisadorDoAto.resposta;
    analisadorDoAto.resposta = async () => {
      i += 1;
      if (i === 1) throw new ProviderIndisponivelError('openrouter', 'fora do ar');
      return normal();
    };
    const e = montar();
    const r = await e.experimentar(
      { funcao: 'ato', numero: NUMERO_TJSP_A, chaveDoAto: chaveDaMovimentacao(ATO) },
      undefined,
    );
    expect(r.bracos.map((b) => b.estado).sort()).toEqual(['erro', 'ok']);
  });

  it('ato que não está no retrato, ou sem texto, recusa antes do modelo', async () => {
    const e = montar();
    expect(
      await motivo(
        e.experimentar(
          { funcao: 'ato', numero: NUMERO_TJSP_A, chaveDoAto: 'chave-que-nao-existe' },
          undefined,
        ),
      ),
    ).toBe('ato_nao_encontrado');
    expect(analisadorDoAto.chamadas).toBe(0);
  });
});

describe('resumo do processo', () => {
  it('roda publicada e rascunho sobre o mesmo processo e devolve os dois resumos, sem gravar', async () => {
    const e = montar();
    const r = await e.experimentar(
      { funcao: 'resumo', numero: NUMERO_TJSP_A },
      undefined,
    );
    expect(resumidor.chamadas).toBe(2);
    const sistemas = resumidor.pedidos.map((p) => p.sistema);
    expect(sistemas).toContain(montarSistema('resumo', INSTRUCAO_DO_RESUMO, PUBLICADA));
    expect(sistemas).toContain(montarSistema('resumo', INSTRUCAO_DO_RESUMO, RASCUNHO));
    expect(r.bracos.every((b) => b.estado === 'ok')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM resumos_ia').get()).toEqual({ n: 0 });
  });

  it('processo em segredo de justiça: nenhuma chamada', async () => {
    await repo.registrarSincronizacao(DONO, NUMERO, processo(ATOS_DO_RESUMO, true), []);
    const m = await motivo(
      montar().experimentar({ funcao: 'resumo', numero: NUMERO_TJSP_A }, undefined),
    );
    expect(m).toBe('segredo_de_justica');
    expect(resumidor.chamadas).toBe(0);
  });
});

describe('análise de peça', () => {
  it('roda publicada e rascunho sobre a mesma peça (texto extraído do PDF), sem gravar e sem reaproveitar', async () => {
    const e = montar();
    const r = await e.experimentar(
      { funcao: 'peca', numero: NUMERO_TJSP_A, pecaId: 'p1' },
      undefined,
    );
    expect(analisadorDaPeca.chamadas).toBe(2);
    const sistemas = analisadorDaPeca.pedidos.map((p) => p.sistema);
    expect(sistemas).toContain(montarSistema('peca', INSTRUCAO_DA_PECA, PUBLICADA));
    expect(sistemas).toContain(montarSistema('peca', INSTRUCAO_DA_PECA, RASCUNHO));
    expect(r.bracos.every((b) => b.estado === 'ok')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM analises_pecas_ia').get()).toEqual({
      n: 0,
    });
    // de novo: nada foi guardado para reaproveitar, então chama o modelo outra vez
    await e.experimentar(
      { funcao: 'peca', numero: NUMERO_TJSP_A, pecaId: 'p1' },
      undefined,
    );
    expect(analisadorDaPeca.chamadas).toBe(4);
  });

  it('processo em segredo de justiça: nenhuma chamada', async () => {
    await repo.registrarSincronizacao(DONO, NUMERO, processo([ATO], true), []);
    const m = await motivo(
      montar().experimentar(
        { funcao: 'peca', numero: NUMERO_TJSP_A, pecaId: 'p1' },
        undefined,
      ),
    );
    expect(m).toBe('processo_sigiloso');
    expect(analisadorDaPeca.chamadas).toBe(0);
  });
});

describe('só a conta do dono', () => {
  it('sem conta do dono (e-mail do operador sem conta): recusa e não toca em nenhum processo', async () => {
    dono = undefined;
    const e = montar();
    expect(await motivo(e.processos())).toBe('conta_do_dono_ausente');
    expect(
      await motivo(
        e.experimentar(
          { funcao: 'ato', numero: NUMERO_TJSP_A, chaveDoAto: chaveDaMovimentacao(ATO) },
          undefined,
        ),
      ),
    ).toBe('conta_do_dono_ausente');
    expect(analisadorDoAto.chamadas).toBe(0);
  });

  it('a lista só tem os processos da conta do dono, e o processo de um assinante não aparece', async () => {
    await repo.acompanhar(OUTRA, '99999999999999999999');
    const e = montar();
    const l = await e.processos();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ numero: NUMERO, tribunal: 'TJGO', sigiloso: false });
    // a lista de atos mostra título e data, e marca os que têm texto
    const atos = await e.atos(NUMERO_TJSP_A);
    expect(atos.sigiloso).toBe(false);
    expect(atos.atos.length).toBeGreaterThan(0);
    expect(atos.atos.find((a) => a.titulo === 'Despacho')?.legivel).toBe(true);
    expect(atos.atos.find((a) => a.titulo === 'Conclusos para despacho')?.legivel).toBe(
      false,
    );
    // as peças em guarda: só as disponíveis
    const pecas = await e.pecas(NUMERO_TJSP_A);
    expect(pecas.pecas.map((p) => p.pecaId)).toEqual(['p1']);
  });

  it('processo em segredo de justiça: a lista nem mostra os atos nem as peças', async () => {
    await repo.registrarSincronizacao(DONO, NUMERO, processo([ATO], true), []);
    const e = montar();
    expect(await e.atos(NUMERO_TJSP_A)).toEqual({ sigiloso: true, atos: [] });
    expect(await e.pecas(NUMERO_TJSP_A)).toEqual({ sigiloso: true, pecas: [] });
  });

  it('número de processo que a conta do dono não acompanha: não encontrado (mesmo que outro assinante o tenha)', async () => {
    const e = montar();
    expect(await motivo(e.atos('1000000-00.2099.8.09.0001'))).toBe('caso_invalido');
    await repo.deixarDeAcompanhar(DONO, NUMERO);
    expect(await motivo(e.atos(NUMERO_TJSP_A))).toBe('caso_nao_encontrado');
  });
});

describe('freios', () => {
  it('um experimento por vez', async () => {
    let liberar: () => void = () => undefined;
    const trava = new Promise<void>((r) => {
      liberar = r;
    });
    const normal = analisadorDoAto.resposta;
    analisadorDoAto.resposta = async () => {
      await trava;
      return normal();
    };
    const e = montar();
    const caso = {
      funcao: 'ato',
      numero: NUMERO_TJSP_A,
      chaveDoAto: chaveDaMovimentacao(ATO),
    } as const;
    const primeiro = e.experimentar(caso, undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(await motivo(e.experimentar(caso, undefined))).toBe(
      'experimento_em_andamento',
    );
    liberar();
    await primeiro;
    // terminou: o seguinte passa
    expect(await motivo(e.experimentar(caso, undefined))).toBeUndefined();
  });

  it('há um teto por hora, que volta com o relógio', async () => {
    const e = montar({ maximoPorHora: 2 });
    const caso = {
      funcao: 'ato',
      numero: NUMERO_TJSP_A,
      chaveDoAto: chaveDaMovimentacao(ATO),
    } as const;
    await e.experimentar(caso, undefined);
    await e.experimentar(caso, undefined);
    expect(await motivo(e.experimentar(caso, undefined))).toBe('limite_de_experimentos');
    relogio.ms += 3_600_001;
    expect(await motivo(e.experimentar(caso, undefined))).toBeUndefined();
    expect(MAXIMO_DE_EXPERIMENTOS_POR_HORA).toBeGreaterThanOrEqual(10);
  });

  it('caso mal formado e texto acima do limite são recusados ANTES de gastar uma vaga ou uma chamada', async () => {
    const e = montar({ maximoPorHora: 1 });
    expect(
      await motivo(
        e.experimentar(
          { funcao: 'ato', numero: NUMERO_TJSP_A, chaveDoAto: '' },
          undefined,
        ),
      ),
    ).toBe('caso_invalido');
    expect(
      await motivo(
        e.experimentar({ funcao: 'peca', numero: NUMERO_TJSP_A, pecaId: '' }, undefined),
      ),
    ).toBe('caso_invalido');
    expect(
      await motivo(
        e.experimentar({ funcao: 'resumo', numero: NUMERO_TJSP_A }, 'a'.repeat(4001)),
      ),
    ).toBe('texto_grande');
    expect(resumidor.chamadas).toBe(0);
    // a vaga do 1/hora continua inteira
    expect(
      await motivo(
        e.experimentar({ funcao: 'resumo', numero: NUMERO_TJSP_A }, undefined),
      ),
    ).toBeUndefined();
  });
});
