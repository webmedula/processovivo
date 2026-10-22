import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { removerCabecalhoInstitucional } from '../../src/application/politicas/cabecalhoInstitucional.js';
import {
  INSTRUCAO_DO_RESUMO,
  INSTRUCAO_DO_RESUMO_1_0_0,
  prepararEntradaDoResumo,
  VERSAO_PROMPT_DO_RESUMO,
} from '../../src/application/politicas/entradaDoResumo.js';
import { LimiteDeAnalises } from '../../src/application/politicas/limiteDeAnalises.js';
import {
  classeDoAto,
  diaLocal,
  mesclarMesmoAto,
} from '../../src/application/politicas/mesmoAtoParaOResumo.js';
import {
  atoTemTextoUtilizavel,
  ORCAMENTO_DO_RESUMO,
  REGRAS_DA_SELECAO_1_0_0,
  selecionarAtosParaResumo,
} from '../../src/application/politicas/selecionarAtosParaResumo.js';
import {
  VERSAO_DAS_REGRAS_DO_RESUMO,
  verificarResumo,
} from '../../src/application/politicas/verificarResumo.js';
import { ServicoResumoDoProcesso } from '../../src/application/services/ServicoResumoDoProcesso.js';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import type { ListagemDaPasta } from '../../src/domain/entities/PastaDigital.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioResumosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioResumosSqlite.js';
import { LoggerColetor, NOME_DA_PARTE } from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';
import { ClockFalso } from '../helpers/leitor.js';
import {
  AGORA_DO_RESUMO,
  respostaDoResumo,
  ResumidorFalso,
  SENTENCA,
  TEXTO_DA_SENTENCA,
} from '../helpers/resumoIa.js';

/* Dados SINTÉTICOS: nomes, números e textos inventados. */

const TEXTO_DO_DESPACHO_NOVO =
  'Defiro o pedido de produção de prova pericial e determino a intimação das partes para indicarem assistentes técnicos em quinze dias.';
const BODY =
  'Determino a intimação da parte autora para que se manifeste sobre os documentos juntados aos autos pela parte ré.';
const CABECALHO = [
  'PODER JUDICIÁRIO',
  'TRIBUNAL DE JUSTIÇA DO ESTADO DE GOIÁS',
  'Comarca de Cidade Exemplo',
  '2ª Vara Cível',
  'Rua das Flores, 100, Centro - CEP: 74000-000',
  'Autos nº 0000000-00.2099.8.09.0001',
  'Natureza: Procedimento Comum',
];

describe('cabeçalho institucional (regra mínima)', () => {
  it('tira o bloco repetido do começo e deixa o corpo', () => {
    expect(removerCabecalhoInstitucional([...CABECALHO, '', BODY].join('\n'))).toBe(BODY);
  });

  it('com uma linha só de cabeçalho, na dúvida, não tira nada', () => {
    const t = ['Comarca de Cidade Exemplo', BODY].join('\n');
    expect(removerCabecalhoInstitucional(t)).toBe(t);
  });

  it('não tira se o que sobraria não é texto utilizável', () => {
    const t = [...CABECALHO, 'Ciência.'].join('\n');
    expect(removerCabecalhoInstitucional(t)).toBe(t);
  });

  it('só mexe no COMEÇO: a mesma linha no meio do texto fica', () => {
    const t = [BODY, 'PODER JUDICIÁRIO', 'Comarca de Cidade Exemplo'].join('\n');
    expect(removerCabecalhoInstitucional(t)).toBe(t);
  });

  it('para na primeira linha que não é cabeçalho', () => {
    const t = [
      ...CABECALHO.slice(0, 3),
      'ATO ORDINATÓRIO',
      'Comarca de Outra Cidade',
      BODY,
    ].join('\n');
    expect(removerCabecalhoInstitucional(t)).toBe(
      ['ATO ORDINATÓRIO', 'Comarca de Outra Cidade', BODY].join('\n'),
    );
  });

  it('linha longa que lembra tribunal é texto, não cabeçalho', () => {
    const longa = `Tribunal de Justiça ${'decidiu o mérito '.repeat(12)}`;
    const t = ['PODER JUDICIÁRIO', longa, BODY].join('\n');
    expect(removerCabecalhoInstitucional(t)).toBe(t);
  });
});

/** `conteudo: undefined` tira o texto do ato (com `exactOptionalPropertyTypes` não se atribui undefined). */
type ExtraDoAto = Partial<Omit<Movimentacao, 'conteudo'>> & {
  conteudo?: string | undefined;
};
const djen = (id: number, dia: string, extra: ExtraDoAto = {}): Movimentacao => {
  const { conteudo = TEXTO_DO_DESPACHO_NOVO, ...resto } = extra;
  const tem = 'conteudo' in extra ? extra.conteudo !== undefined : true;
  return {
    data: new Date(`${dia}T12:00:00.000Z`),
    titulo: 'Despacho',
    idExterno: `djen:${id}`,
    fonte: 'djen',
    ...(tem ? { conteudo } : {}),
    ...resto,
  };
};
const datajud = (
  id: number,
  dia: string,
  extra: Partial<Movimentacao> = {},
): Movimentacao => ({
  data: new Date(`${dia}T17:30:00.000Z`),
  titulo: 'Despacho',
  idExterno: `datajud:${id}`,
  fonte: 'datajud',
  ...extra,
});

describe('mesmo ato em duas fontes (só para a seleção)', () => {
  it('reconhece a classe pelo começo do título e o dia pelo fuso de São Paulo', () => {
    expect(classeDoAto('Despacho de mero expediente')).toBe('despacho');
    expect(classeDoAto('Conclusos para despacho')).toBeUndefined();
    expect(classeDoAto('Juntada de Decisão')).toBeUndefined();
    expect(diaLocal(new Date('2026-10-06T01:00:00Z'))).toBe('2026-10-05');
  });

  it('junta o só-título do DataJud ao despacho com texto do DJEN do mesmo dia', () => {
    const com = djen(1, '2026-10-05');
    const sem = datajud(9, '2026-10-05');
    const m = mesclarMesmoAto([sem, com], atoTemTextoUtilizavel);
    expect(m.get(chaveDaMovimentacao(sem))).toBe(chaveDaMovimentacao(com));
  });

  it.each([
    [
      'duas do mesmo diário no mesmo dia',
      [djen(1, '2026-10-05'), djen(2, '2026-10-05', { conteudo: undefined })],
    ],
    [
      'classes diferentes',
      [djen(1, '2026-10-05'), datajud(9, '2026-10-05', { titulo: 'Decisão' })],
    ],
    ['dias diferentes', [djen(1, '2026-10-05'), datajud(9, '2026-10-06')]],
    [
      'dois só-título no dia (dúvida)',
      [djen(1, '2026-10-05'), datajud(9, '2026-10-05'), datajud(8, '2026-10-05')],
    ],
    [
      'dois com texto no dia (dúvida)',
      [
        djen(1, '2026-10-05'),
        djen(3, '2026-10-05', { fonte: 'mni', idExterno: 'mni:3' }),
        datajud(9, '2026-10-05'),
      ],
    ],
    [
      'teor indisponível não é o mesmo ato',
      [djen(1, '2026-10-05'), datajud(9, '2026-10-05', { teorIndisponivel: true })],
    ],
  ])('não junta: %s', (_nome, atos) => {
    expect(mesclarMesmoAto(atos, atoTemTextoUtilizavel).size).toBe(0);
  });
});

describe('seleção do resumo (regras 1.1.0)', () => {
  it('o ato mais recente com texto leva o limite de providência, e na 1.0.0 não levava', () => {
    const longo = djen(1, '2026-10-05', {
      conteudo: 'Determino a juntada de documentos. '.repeat(120),
    });
    const a = selecionarAtosParaResumo([longo], new Set());
    const b = selecionarAtosParaResumo([longo], new Set(), REGRAS_DA_SELECAO_1_0_0);
    expect(a.atos[0]?.limiteDeCaracteres).toBe(ORCAMENTO_DO_RESUMO.caracteresPorPendente);
    expect(b.atos[0]?.limiteDeCaracteres).toBe(ORCAMENTO_DO_RESUMO.caracteresPorRecente);
  });

  it('lê até 8 providências (a 1.0.0 lia 5); o que passa dos limites vira "não lido" com o motivo', () => {
    const atos = Array.from({ length: 20 }, (_, i) =>
      djen(i + 1, `2026-09-${String(i + 1).padStart(2, '0')}`, {
        conteudo: `${TEXTO_DO_DESPACHO_NOVO} ${i}`,
      }),
    );
    const todas = new Set(atos.map(chaveDaMovimentacao));
    const nova = selecionarAtosParaResumo(atos, todas);
    expect(nova.atos.filter((a) => a.motivo === 'providencia')).toHaveLength(8);
    // Providência além do limite ainda pode entrar como ato recente; as 2 mais antigas ficam sem leitura.
    expect(nova.comTexto).toBe(18);
    expect(nova.providenciasNaoLidas).toHaveLength(2);
    expect(nova.providenciasNaoLidas.every((p) => p.motivo === 'fora_do_limite')).toBe(
      true,
    );
    const antiga = selecionarAtosParaResumo(atos, todas, REGRAS_DA_SELECAO_1_0_0);
    expect(antiga.atos.filter((a) => a.motivo === 'providencia')).toHaveLength(5);
    expect(antiga.providenciasNaoLidas).toHaveLength(5);
  });

  it('título não gasta o limite de textos', () => {
    const textos = Array.from({ length: 4 }, (_, i) => djen(i + 1, `2026-09-1${i}`));
    const titulos = Array.from({ length: 30 }, (_, i) =>
      datajud(100 + i, `2026-08-${String(i + 1).padStart(2, '0')}`, {
        titulo: `Movimento ${i}`,
      }),
    );
    const s = selecionarAtosParaResumo([...textos, ...titulos], new Set());
    expect(s.comTexto).toBe(4);
    expect(s.soTitulo).toBe(30);
  });

  it('o ato mais recente sem texto fica na lista, marcado como NÃO lido, e a providência dele é nomeada', () => {
    const novo = djen(9, '2026-10-05', { teorIndisponivel: true, conteudo: undefined });
    const velho = djen(1, '2025-02-21', { titulo: 'Decisão' });
    const s = selecionarAtosParaResumo(
      [velho, novo],
      new Set([chaveDaMovimentacao(novo)]),
    );
    expect(s.maisRecente?.lido).toBe(false);
    expect(s.atos[0]?.ato).toBe(novo);
    expect(s.providenciasNaoLidas.map((p) => p.motivo)).toEqual(['teor_indisponivel']);
    expect(s.comTexto).toBe(1);
  });

  it('conta os não lidos por motivo, sem texto', () => {
    const atos = [
      djen(1, '2026-10-05', { teorIndisponivel: true }),
      datajud(2, '2026-10-04', { titulo: 'Juntada de petição' }),
      djen(3, '2026-10-03', { conteudo: 'Ciência.', titulo: 'Ato ordinatório' }),
      djen(4, '2026-10-02'),
    ];
    const s = selecionarAtosParaResumo(atos, new Set());
    expect(s.motivosDosNaoLidos).toEqual({
      teorIndisponivel: 1,
      semTexto: 1,
      abaixoDoMinimo: 1,
      foraDoLimite: 0,
    });
  });

  it('a providência do só-título passa ao ato com texto: nada de "não lida" falsa', () => {
    const com = djen(1, '2026-10-05');
    const sem = datajud(9, '2026-10-05');
    const s = selecionarAtosParaResumo([sem, com], new Set([chaveDaMovimentacao(sem)]));
    expect(s.mesclados).toBe(1);
    expect(s.maisRecente?.ato).toBe(com);
    expect(s.maisRecente?.lido).toBe(true);
    expect(s.providenciasNaoLidas).toEqual([]);
    expect(s.chavesPendentes.has(chaveDaMovimentacao(com))).toBe(true);
    expect(s.foraDoResumo).toBe(0);
  });
});

describe('mensagem do resumo (prompt resumo-1.1.0)', () => {
  const comCabecalho = djen(1, '2026-10-05', {
    conteudo: [...CABECALHO, '', BODY].join('\n'),
  });

  it('a versão é a 1.1.0 e a instrução manda começar pelo ato mais recente', () => {
    expect(VERSAO_PROMPT_DO_RESUMO).toBe('resumo-1.1.0');
    expect(INSTRUCAO_DO_RESUMO).toContain('<ato_mais_recente>');
    expect(INSTRUCAO_DO_RESUMO).toContain(
      'não é a situação atual'.slice(0, 0) + 'situação atual',
    );
    expect(INSTRUCAO_DO_RESUMO_1_0_0).not.toContain('<ato_mais_recente>');
  });

  it('o texto enviado é o texto verificado: sem o cabeçalho, sem o nome da parte', () => {
    const e = prepararEntradaDoResumo(
      selecionarAtosParaResumo([comCabecalho], new Set()),
      {},
    );
    const enviado = e.atos.get('A1')?.textoEnviado ?? '';
    expect(enviado).toContain('Determino a intimação da parte autora');
    expect(enviado).not.toContain('PODER JUDICIÁRIO');
    expect(enviado).not.toContain('Natureza:');
  });

  it('diz ao modelo, em bloco do SISTEMA, qual é o ato mais recente e se foi lido', () => {
    const novo = datajud(9, '2026-10-05', { titulo: 'Despacho' });
    const e = prepararEntradaDoResumo(
      selecionarAtosParaResumo(
        [novo, djen(1, '2025-02-21', { titulo: 'Decisão' })],
        new Set([chaveDaMovimentacao(novo)]),
      ),
    );
    expect(e.usuario).toContain(
      '<ato_mais_recente>\n[A1] 05/10/2026 — Despacho. Texto lido: não.',
    );
    expect(e.usuario).toContain('<providencias_do_sistema>');
    expect(e.maisRecente).toEqual({ id: 'A1', lido: false });
    expect(e.providenciasNaoLidas).toEqual(['A1']);
    // O bloco do sistema não é "texto de ato": nada dele serve de citação.
    expect(e.atos.get('A1')?.textoEnviado).not.toContain('Texto lido');
  });

  it('a 1.0.0 do comparador não leva o bloco nem limpa cabeçalho', () => {
    const s = selecionarAtosParaResumo(
      [comCabecalho],
      new Set(),
      REGRAS_DA_SELECAO_1_0_0,
    );
    const e = prepararEntradaDoResumo(s, {}, {}, { versao: 'resumo-1.0.0' });
    expect(e.usuario).not.toContain('<ato_mais_recente>');
    expect(e.atos.get('A1')?.textoEnviado).toContain('PODER JUDICIÁRIO');
    expect(e.sistema).toBe(INSTRUCAO_DO_RESUMO_1_0_0);
  });
});

describe('verificação do resumo (regras 1.1.0)', () => {
  const atos = new Map([
    ['A1', { chave: 'k1', textoEnviado: 'Título: Despacho\nData do ato: 05/10/2026' }],
    [
      'A2',
      {
        chave: 'k2',
        textoEnviado: `Título: Sentença\nData do ato: 21/02/2025\nTexto:\n${TEXTO_DA_SENTENCA}`,
      },
    ],
  ]);
  const item = (
    texto: string,
    ato = 'A2',
    trecho = 'Julgo parcialmente procedentes os pedidos',
  ) => ({
    texto,
    ato,
    trecho,
  });

  it('versão 1.1.0', () => {
    expect(VERSAO_DAS_REGRAS_DO_RESUMO).toBe('1.1.0');
  });

  it('com o ato mais recente sem leitura, não deixa ato antigo passar por situação atual', () => {
    const resposta = respostaDoResumo({
      situacao: [
        item('Atualmente o processo está sentenciado e aguarda o trânsito.'),
        item('O juízo julgou parcialmente procedentes os pedidos da inicial.'),
      ],
      pendencias: [],
    });
    const sem = verificarResumo(resposta, atos);
    expect(sem.estado === 'verificado' && sem.situacao).toHaveLength(2);
    const com = verificarResumo(resposta, atos, { maisRecenteNaoLido: true });
    if (com.estado !== 'verificado') throw new Error('esperava verificado');
    expect(com.situacao.map((i) => i.texto)).toEqual([
      'O juízo julgou parcialmente procedentes os pedidos da inicial.',
    ]);
    expect(com.descartes.atualidade).toBe(1);
  });

  it('só atos "atuais" e nenhum item sobrando: não verificado', () => {
    const r = verificarResumo(
      respostaDoResumo({
        situacao: [item('No momento, o feito está sentenciado.')],
        pendencias: [],
      }),
      atos,
      { maisRecenteNaoLido: true },
    );
    expect(r.estado).toBe('nao_verificado');
  });

  it('com providência do sistema sem leitura, "não há pendências" não passa', () => {
    const resposta = respostaDoResumo({
      situacao: [item('O juízo julgou parcialmente procedentes os pedidos da inicial.')],
      pendencias: [
        item('A IA não indicou pendências nos atos lidos.'),
        item('Não há pendências a cumprir.'),
        item('[PARTE A]: recolher as custas processuais'),
      ],
    });
    const r = verificarResumo(resposta, atos, { providenciaNaoLida: true });
    if (r.estado !== 'verificado') throw new Error('esperava verificado');
    expect(r.descartes.pendenciaNegada).toBe(2);
  });

  it('ponto de atenção guarda o ato apontado quando ele existe', () => {
    const r = verificarResumo(
      respostaDoResumo({
        situacao: [
          item('O juízo julgou parcialmente procedentes os pedidos da inicial.'),
        ],
        pontos_de_atencao: [
          { codigo: 'ato_depende_de_outro_documento', ato: '[A2]' },
          { codigo: 'texto_incompleto', ato: 'A99' },
        ],
      }),
      atos,
    );
    if (r.estado !== 'verificado') throw new Error('esperava verificado');
    expect(r.pontosDeAtencao).toEqual([
      'ato_depende_de_outro_documento',
      'texto_incompleto',
    ]);
    expect(r.pontosDoAto).toEqual([
      { codigo: 'ato_depende_de_outro_documento', chaveDoAto: 'k2' },
      { codigo: 'texto_incompleto' },
    ]);
  });
});

describe('ServicoResumoDoProcesso — situação atual (v0.54.0)', () => {
  const WS = 'ws-a';
  const NUMERO = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
  let db: DatabaseSync;
  let repo: RepositorioAcompanhamentosSqlite;
  let resumidor: ResumidorFalso;
  let log: LoggerColetor;
  let relogio: ClockFalso;
  let listagem: ListagemDaPasta | undefined;
  let contador = 0;

  function servico(): ServicoResumoDoProcesso {
    return new ServicoResumoDoProcesso({
      repositorio: repo,
      resumos: new RepositorioResumosSqlite(db),
      resumidor,
      exigirPlanoIa: async () => undefined,
      limite: new LimiteDeAnalises({
        porHora: 100,
        simultaneasNoTotal: 10,
        clock: relogio,
      }),
      clock: relogio,
      logger: log,
      novoId: () => `resumo-${++contador}`,
      janelaDePendenciaDias: 10,
      pasta: { obterListagem: async () => listagem },
    });
  }
  async function semear(movs: Movimentacao[]): Promise<void> {
    await repo.acompanhar(WS, NUMERO);
    await repo.registrarSincronizacao(
      WS,
      NUMERO,
      new Processo({
        numero: NumeroCNJ.criar(NUMERO_TJSP_A),
        tribunal: 'TJGO',
        partes: [
          { nome: NOME_DA_PARTE, polo: 'ATIVO', tipoPessoa: 'FISICA', advogados: [] },
        ],
        movimentacoes: movs,
        procedencia: {
          provider: 'datajud+djen',
          consultadoEm: AGORA_DO_RESUMO,
          deCache: false,
        },
      }),
      [],
    );
  }
  const pedido = { workspace: WS, numero: NUMERO_TJSP_A };
  const citaODespacho = (texto: string) => ({
    texto,
    ato: 'A1',
    trecho: 'Defiro o pedido de produção de prova pericial',
  });
  const citaASentenca = (texto: string) => ({
    texto,
    ato: 'A2',
    trecho: 'Julgo parcialmente procedentes os pedidos',
  });

  beforeEach(() => {
    db = abrirBanco(':memory:');
    repo = new RepositorioAcompanhamentosSqlite(db);
    resumidor = new ResumidorFalso();
    log = new LoggerColetor();
    relogio = new ClockFalso();
    relogio.ms = AGORA_DO_RESUMO.getTime();
    listagem = undefined;
  });

  // O caso do relato: o despacho novo (marcado "pede providência") sem texto; só as decisões antigas lidas.
  const despachoNovoSemTexto = djen(9, '2026-10-05', {
    teorIndisponivel: true,
    conteudo: undefined,
  });

  it('ato mais recente sem leitura: o sistema avisa, nomeia a providência e barra "situação atual"', async () => {
    await semear([despachoNovoSemTexto, SENTENCA]);
    resumidor.resposta = async () => ({
      resposta: respostaDoResumo({
        situacao: [
          citaASentenca('Atualmente os pedidos estão julgados.'),
          citaASentenca('O juízo julgou parcialmente procedentes os pedidos da inicial.'),
        ],
        pendencias: [citaASentenca('A IA não indicou pendências.')],
      }),
      modelo: 'modelo/teste',
      provedor: 'provedor-teste',
    });
    const r = await servico().resumir(pedido);
    if (r.estado !== 'verificado') throw new Error('esperava verificado');

    expect(r.atualidade.maisRecente).toMatchObject({ rotulo: 'Despacho', lido: false });
    expect(r.atualidade.providenciasNaoLidas).toMatchObject([
      { rotulo: 'Despacho', motivo: 'teor_indisponivel' },
    ]);
    expect(r.atualidade.providenciasNaoLidasTotal).toBe(1);
    expect(r.situacao.map((i) => i.texto)).toEqual([
      'O juízo julgou parcialmente procedentes os pedidos da inicial.',
    ]);
    expect(r.pendencias).toEqual([]);
    expect(r.contagens).toMatchObject({
      maisRecenteLido: false,
      providenciasNaoLidas: 1,
      atosComTexto: 1,
      atosSoTitulo: 1,
    });
    expect(r.versaoPrompt).toBe('resumo-1.1.0');
  });

  it('o log diz quantos atos ficaram sem leitura e por quê — só contagens', async () => {
    await semear([despachoNovoSemTexto, SENTENCA]);
    await servico().resumir(pedido);
    const linha = log.linhas.find((l) => l.includes('resumo do processo montado')) ?? '';
    expect(linha).toContain('"naoLidosTeorIndisponivel":1');
    expect(linha).toContain('"maisRecenteLido":false');
    expect(linha).toContain('"providenciasNaoLidas":1');
    const tudo = log.linhas.join('\n');
    expect(tudo).not.toContain(NOME_DA_PARTE);
    expect(tudo).not.toContain(NUMERO);
    expect(tudo).not.toContain(WS);
    expect(tudo).not.toContain('Julgo parcialmente');
  });

  it('despacho do DataJud (só título) e do DJEN (com texto) no mesmo dia são UM ato lido', async () => {
    await semear([datajud(9, '2026-10-05'), djen(1, '2026-10-05'), SENTENCA]);
    resumidor.resposta = async () => ({
      resposta: respostaDoResumo({
        situacao: [
          citaODespacho('Foi deferida a prova pericial e as partes serão intimadas.'),
        ],
        pendencias: [],
      }),
      modelo: 'modelo/teste',
      provedor: 'provedor-teste',
    });
    const r = await servico().resumir(pedido);
    if (r.estado !== 'verificado') throw new Error('esperava verificado');
    expect(r.atualidade.maisRecente?.lido).toBe(true);
    expect(r.atualidade.providenciasNaoLidasTotal).toBe(0);
    expect(r.contagens.atosMesclados).toBe(1);
  });

  it('a Pasta digital já gravada com ato mais novo vira aviso (sem consultar o tribunal)', async () => {
    await semear([djen(1, '2026-10-05'), SENTENCA]);
    resumidor.resposta = async () => ({
      resposta: respostaDoResumo({
        situacao: [
          citaODespacho('Foi deferida a prova pericial e as partes serão intimadas.'),
        ],
        pendencias: [],
      }),
      modelo: 'modelo/teste',
      provedor: 'provedor-teste',
    });
    listagem = {
      numeroProcesso: NUMERO,
      tribunal: 'TJGO',
      listadaEm: new Date('2026-10-06T10:00:00Z'),
      processoSigiloso: false,
      pecas: [],
      atos: [
        { posicao: 1, data: new Date('2026-10-05T12:00:00Z'), descricao: 'Despacho' },
        {
          posicao: 2,
          data: new Date('2026-10-06T09:00:00Z'),
          descricao: 'Conclusos para decisão',
        },
      ],
    };
    const r = await servico().resumir(pedido);
    if (r.estado !== 'verificado') throw new Error('esperava verificado');
    expect(r.atualidade.tribunalMaisNovo).toMatchObject({
      rotulo: 'Conclusos para decisão',
    });

    listagem = { ...listagem, atos: [listagem.atos![0]!] };
    const igual = await servico().resumir(pedido);
    if (igual.estado !== 'verificado') throw new Error('esperava verificado');
    expect(igual.atualidade.tribunalMaisNovo).toBeNull();
  });
});
