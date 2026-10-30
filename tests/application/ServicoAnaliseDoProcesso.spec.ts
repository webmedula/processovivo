import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LimiteDeAnalises,
  TetoDiario,
} from '../../src/application/politicas/limiteDeAnalises.js';
import { ServicoAnaliseDePeca } from '../../src/application/services/ServicoAnaliseDePeca.js';
import {
  ServicoAnaliseDoProcesso,
  type FonteDaAnaliseDoProcesso,
  type VisaoDaAnaliseDoProcesso,
} from '../../src/application/services/ServicoAnaliseDoProcesso.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import {
  AcompanhamentoNaoEncontradoError,
  AnaliseDoProcessoRecusadaError,
  AnaliseNaoEncontradaError,
  CredencialTribunalInvalidaError,
} from '../../src/domain/errors/index.js';
import { PdftotextExtrator } from '../../src/infrastructure/pdf/PdftotextExtrator.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioAnalisesDePecaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAnalisesDePecaSqlite.js';
import { RepositorioSintesesDoProcessoSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioSintesesDoProcessoSqlite.js';
import {
  AnalisadorDePecaFalso,
  PAGINA_DO_DESPACHO,
  PAGINAS_DA_PECA,
  respostaDaPeca,
  respostaDoDespacho,
} from '../helpers/analiseDePeca.js';
import {
  PAGINA_DA_CONTESTACAO,
  respostaDaContestacao,
  respostaDaSintese,
  SintetizadorFalso,
} from '../helpers/analiseDoProcesso.js';
import { LoggerColetor, NOME_DA_PARTE } from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';
import { ClockFalso } from '../helpers/leitor.js';
import { pdfComPaginas, pdfSoComImagem } from '../helpers/pdfDePecas.js';

/* Peças, nomes, números e valores SINTÉTICOS. Nenhuma rede: os dois modelos são dublês. */

const WS = 'aaaaaaaaaaaaaaaa';
const OUTRA = 'bbbbbbbbbbbbbbbb';
const NUMERO = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
const AGORA = new Date('2026-10-29T15:00:00.000Z');

function processo(segredo = false): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(NUMERO_TJSP_A),
    tribunal: 'TJGO',
    classe: 'Procedimento Comum Cível',
    segredoJustica: segredo,
    partes: [
      { nome: NOME_DA_PARTE, polo: 'ATIVO', tipoPessoa: 'FISICA', advogados: [] },
      {
        nome: 'Comercial Pedra Azul Ltda',
        polo: 'PASSIVO',
        tipoPessoa: 'JURIDICA',
        advogados: [],
      },
    ],
    movimentacoes: [{ data: new Date('2026-10-01T12:00:00Z'), titulo: 'Despacho' }],
    procedencia: { provider: 'djen', consultadoEm: AGORA, deCache: false },
  });
}

const arquivoDe = (bytes: Uint8Array) => ({
  tamanho: bytes.byteLength,
  async *ler(inicio: number, fim: number) {
    yield bytes.slice(inicio, fim + 1);
  },
});

interface PecaFalsa {
  rotulo: string;
  data: Date;
  pdf: Uint8Array;
  sigilosa?: boolean;
}

describe('ServicoAnaliseDoProcesso', () => {
  let db: DatabaseSync;
  let repo: RepositorioAcompanhamentosSqlite;
  let analisador: AnalisadorDePecaFalso;
  let sintetizador: SintetizadorFalso;
  let log: LoggerColetor;
  let relogio: ClockFalso;
  let comPlano: Set<string>;
  let pecasFalsas: Map<string, PecaFalsa>;
  /** As peças que estão "na guarda de 24 h". */
  let guarda: Set<string>;
  let pedidosAoTribunal: string[];
  let falhaDoTribunal: Error | undefined;
  let tribunal: string;
  let processoSigiloso: boolean;
  let teto: TetoDiario;
  let contador = 0;

  const fonte: FonteDaAnaliseDoProcesso = {
    async listar() {
      return {
        tribunal,
        processoSigiloso,
        pecas: [...pecasFalsas.entries()].map(([pecaId, p]) => ({
          pecaId,
          rotulo: p.rotulo,
          data: p.data,
          sigilosa: p.sigilosa === true,
          emGuarda: guarda.has(pecaId),
        })),
      };
    },
    async solicitar(_ws, _n, pecaId) {
      pedidosAoTribunal.push(pecaId);
      if (falhaDoTribunal) throw falhaDoTribunal;
      guarda.add(pecaId);
    },
    async estado(_ws, _n, pecaId) {
      return guarda.has(pecaId) ? 'disponivel' : 'nao_baixada';
    },
  };

  function servicos(
    o: { workspaces?: string[]; porDia?: number; porHoraDoProcesso?: number } = {},
  ): { pecas: ServicoAnaliseDePeca; processo: ServicoAnaliseDoProcesso } {
    teto = new TetoDiario(o.porDia ?? 200, relogio);
    const pecas = new ServicoAnaliseDePeca({
      repositorio: repo,
      analises: new RepositorioAnalisesDePecaSqlite(db),
      assinaturas: { temRecursoSemExcecao: async (ws) => comPlano.has(ws) },
      fonte: {
        pecaParaAnalise: async (_ws, _n, pecaId) => {
          const p = pecasFalsas.get(pecaId);
          return {
            tribunal,
            ...(p && guarda.has(pecaId) ? { arquivo: arquivoDe(p.pdf) } : {}),
          };
        },
      },
      extrator: new PdftotextExtrator(),
      analisador,
      // Freio por hora da PEÇA baixo de propósito: dentro da análise do processo ele não vale.
      limite: new LimiteDeAnalises({
        porHora: 1,
        simultaneasNoTotal: 10,
        teto,
        funcao: 'peca',
        clock: relogio,
      }),
      liberacao: { habilitada: false, workspaces: [WS, OUTRA] },
      tribunais: ['TJGO'],
      modelo: 'modelo/pedido',
      resultadoDias: 30,
      clock: relogio,
      logger: log,
      novoId: () => `analise-${++contador}`,
    });
    const proc = new ServicoAnaliseDoProcesso({
      pecas,
      repositorio: repo,
      assinaturas: { temRecursoSemExcecao: async (ws) => comPlano.has(ws) },
      fonte,
      sintetizador,
      sinteses: new RepositorioSintesesDoProcessoSqlite(db),
      limite: new LimiteDeAnalises({
        porHora: o.porHoraDoProcesso ?? 10,
        simultaneasNoTotal: 10,
        clock: relogio,
      }),
      teto,
      workspaces: o.workspaces ?? [WS],
      tribunais: ['TJGO'],
      modelo: () => 'modelo/pedido',
      resultadoDias: 30,
      clock: relogio,
      logger: log,
      novoId: () => `id-${++contador}`,
      esperar: async () => {},
    });
    return { pecas, processo: proc };
  }

  async function rodar(
    s: ServicoAnaliseDoProcesso,
    pecaIds: string[] = ['p1', 'p2', 'p3'],
    ws = WS,
  ): Promise<VisaoDaAnaliseDoProcesso> {
    const v = await s.iniciar(ws, NUMERO_TJSP_A, pecaIds);
    await s.aguardarOcioso();
    return s.consultar(ws, v.id);
  }

  const erroDe = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => undefined,
      (e: unknown) => e,
    );
  const motivoDe = (e: unknown): string | undefined =>
    e instanceof AnaliseDoProcessoRecusadaError ? e.motivo : undefined;

  beforeEach(async () => {
    db = abrirBanco(':memory:');
    repo = new RepositorioAcompanhamentosSqlite(db);
    analisador = new AnalisadorDePecaFalso();
    // O dublê lê o texto ENVIADO para decidir o que a peça é (como um modelo faria).
    analisador.resposta = async () => {
      const u = analisador.pedidos[analisador.pedidos.length - 1]?.usuario ?? '';
      const resposta = u.includes('CONTESTACAO')
        ? respostaDaContestacao()
        : u.includes('DESPACHO')
          ? respostaDoDespacho()
          : respostaDaPeca();
      return { resposta, modelo: 'modelo/teste', provedor: 'provedor-teste' };
    };
    sintetizador = new SintetizadorFalso();
    log = new LoggerColetor();
    relogio = new ClockFalso();
    relogio.ms = AGORA.getTime();
    comPlano = new Set([WS, OUTRA]);
    tribunal = 'TJGO';
    processoSigiloso = false;
    falhaDoTribunal = undefined;
    pedidosAoTribunal = [];
    contador = 0;
    pecasFalsas = new Map([
      [
        'p1',
        {
          rotulo: 'Petição Inicial',
          data: new Date('2026-01-10T12:00:00Z'),
          pdf: await pdfComPaginas(PAGINAS_DA_PECA),
        },
      ],
      [
        'p2',
        {
          rotulo: 'Contestação',
          data: new Date('2026-03-01T12:00:00Z'),
          pdf: await pdfComPaginas([PAGINA_DA_CONTESTACAO]),
        },
      ],
      [
        'p3',
        {
          rotulo: 'Despacho',
          data: new Date('2026-04-01T12:00:00Z'),
          pdf: await pdfComPaginas([PAGINA_DO_DESPACHO]),
        },
      ],
    ]);
    // p2 está fora da guarda: a análise precisa pedi-la ao tribunal.
    guarda = new Set(['p1', 'p3']);
    await repo.acompanhar(WS, NUMERO);
    await repo.registrarSincronizacao(WS, NUMERO, processo(), []);
  });

  describe('o caminho completo', () => {
    it('lê cada peça pela análise de peça, pede ao tribunal só a que falta e cruza os resultados verificados', async () => {
      const { processo: s } = servicos();
      const v = await rodar(s);
      expect(v.fase).toBe('concluida');
      expect(v.pecas.map((p) => p.estado)).toEqual(['lida', 'lida', 'lida']);
      expect(pedidosAoTribunal).toEqual(['p2']);
      expect(analisador.chamadas).toBe(3);
      expect(sintetizador.chamadas).toBe(1);

      const r = v.resultado;
      expect(r?.semSintese).toBeNull();
      const sintese = r?.sintese;
      expect(sintese?.estado).toBe('verificada');
      // O nome do retrato volta só na resposta da própria conta.
      expect(sintese?.objeto?.texto).toContain(NOME_DA_PARTE);
      // A citação é COPIADA da etapa 1: trecho e página da petição.
      expect(sintese?.pedidos[0]?.fontes[0]).toMatchObject({
        pecaId: 'p1',
        rotulo: 'Petição Inicial',
        pagina: 2,
        trecho: 'a condenacao da re a restituir R$ 4.200,00',
      });
      expect(sintese?.pedidos[0]?.defesa?.fontes[0]?.pecaId).toBe('p2');
      expect(sintese?.controvertidos).toHaveLength(1);
      // A linha do tempo vai na ordem das peças (P1 = a mais antiga), não na ordem do modelo.
      expect(sintese?.linhaDoTempo.map((i) => i.fontes[0]?.pecaId)).toEqual([
        'p1',
        'p2',
        'p3',
      ]);
      // Blocos do SISTEMA, sem modelo.
      expect(r?.partes).toEqual({
        autores: [NOME_DA_PARTE],
        reus: ['Comercial Pedra Azul Ltda'],
      });
      expect(r?.classe).toBe('Procedimento Comum Cível');
      expect(r?.determinacoes.map((d) => d.prazo)).toEqual([
        '10 (dez) dias',
        '5 (cinco) dias',
      ]);
      expect(r?.documentos.map((d) => d.nome)).toEqual(['Doc. 1', 'Doc. 2']);
    });

    it('a síntese recebe só os itens com marcadores: nem o nome da parte, nem o texto das peças', async () => {
      const { processo: s } = servicos();
      await rodar(s);
      const enviado = `${sintetizador.pedidos[0]?.sistema}\n${sintetizador.pedidos[0]?.usuario}`;
      expect(enviado).not.toContain(NOME_DA_PARTE);
      expect(enviado).not.toContain('Residente e domiciliada');
      expect(enviado).not.toContain('Petição Inicial'); // o rótulo do tribunal não vai
      expect(enviado).toContain('[P1.pedido1]');
      expect(enviado).toContain('[PARTE A]');
    });

    it('as peças NÃO contam no freio por hora da peça; o teto diário recebe 5 por peça e 5 da síntese', async () => {
      const { processo: s } = servicos();
      await rodar(s);
      // 3 peças × 5 + 5 = 20 de 200: cabem 180, não 181.
      expect(teto.cabe(WS, 180, 'peca')).toBe(true);
      expect(teto.cabe(WS, 181, 'peca')).toBe(false);
    });

    it('a mesma seleção de novo reaproveita peças e síntese: zero modelo, zero peso', async () => {
      const { processo: s } = servicos();
      await rodar(s);
      const v = await rodar(s);
      expect(v.pecas.map((p) => p.estado)).toEqual([
        'reaproveitada',
        'reaproveitada',
        'reaproveitada',
      ]);
      expect(v.resultado?.sintese?.reaproveitada).toBe(true);
      expect(analisador.chamadas).toBe(3);
      expect(sintetizador.chamadas).toBe(1);
      expect(teto.cabe(WS, 180, 'peca')).toBe(true);
    });

    it('a síntese fica gravada com marcadores e só identificadores de item, sem nome nem texto de peça', async () => {
      const { processo: s } = servicos();
      await rodar(s);
      const linhas = db.prepare('SELECT * FROM sinteses_processo_ia').all() as Array<
        Record<string, unknown>
      >;
      expect(linhas).toHaveLength(1);
      const tudo = JSON.stringify(linhas);
      expect(tudo).not.toContain(NOME_DA_PARTE);
      expect(tudo).not.toContain(NUMERO);
      expect(tudo).not.toContain('perfeito estado de funcionamento, conforme');
      expect(tudo).toContain('P1.pedido1');
    });

    it('avaliar por polegar: só a própria conta; outra conta recebe "não encontrada"', async () => {
      const { processo: s } = servicos({ workspaces: [WS, OUTRA] });
      const v = await rodar(s);
      const id = v.resultado?.sintese?.id ?? '';
      await s.avaliar(WS, id, 'errado', 'deixou_de_fora');
      await expect(s.avaliar(OUTRA, id, 'util')).rejects.toBeInstanceOf(
        AnaliseNaoEncontradaError,
      );
      const l = db
        .prepare('SELECT avaliacao, motivo_avaliacao FROM sinteses_processo_ia')
        .get() as Record<string, unknown>;
      expect(l).toEqual({ avaliacao: 'errado', motivo_avaliacao: 'deixou_de_fora' });
    });
  });

  describe('a verificação da síntese', () => {
    it('descarta referência inventada, defesa que não vem da ré, número fora dos itens e mérito', async () => {
      sintetizador.responderCom(
        respostaDaSintese({
          pedidos: [
            {
              texto: 'Restituição de R$ 4.200,00',
              refs: ['P1.pedido1'],
              // A "defesa" aponta para a petição da AUTORA: sai, o pedido fica.
              defesa: { texto: 'Alega a compra', refs: ['P1.alegacao1'] },
              decisao: null,
            },
            { texto: 'Pedido inventado', refs: ['P9.pedido1'] },
            { texto: 'Pagar R$ 99.999,00', refs: ['P1.pedido1'] },
          ] as never,
          pontos_controvertidos: [
            // Lados iguais (só a autora): não é controvérsia.
            { texto: 'Valor pago', refs: ['P1.alegacao1', 'P1.pedido1'] },
            { texto: 'A autora tem razão sobre o defeito', refs: ['P1.alegacao1', 'P2.alegacao1'] },
          ],
        }),
      );
      const { processo: s } = servicos();
      const v = await rodar(s);
      const sintese = v.resultado?.sintese;
      expect(sintese?.estado).toBe('verificada');
      expect(sintese?.pedidos).toHaveLength(1);
      expect(sintese?.pedidos[0]?.defesa).toBeNull();
      expect(sintese?.controvertidos).toHaveLength(0);
      expect(log.linhas.join('\n')).toMatch(/síntese do processo montada.*"descartesReferencia":1/);
    });

    it('sem objeto verificado: "não verificada", e a tela manda ler as peças', async () => {
      sintetizador.responderCom(
        respostaDaSintese({ objeto: { texto: 'Algo', refs: ['P7.resumo1'] } }),
      );
      const { processo: s } = servicos();
      const v = await rodar(s);
      expect(v.resultado?.sintese?.estado).toBe('nao_verificada');
      expect(v.resultado?.sintese?.pedidos).toEqual([]);
    });
  });

  describe('o que recusa ANTES de qualquer consulta ou modelo', () => {
    it('conta fora da lista: indisponível', async () => {
      const { processo: s } = servicos({ workspaces: [OUTRA] });
      expect(motivoDe(await erroDe(s.iniciar(WS, NUMERO_TJSP_A, ['p1', 'p2'])))).toBe(
        'indisponivel',
      );
      expect(s.liberado(WS)).toBe(false);
    });

    it('sem o plano IA: sem plano', async () => {
      comPlano.clear();
      const { processo: s } = servicos();
      expect(motivoDe(await erroDe(s.iniciar(WS, NUMERO_TJSP_A, ['p1', 'p2'])))).toBe(
        'sem_plano',
      );
    });

    it('seleção de 1 peça, repetida, desconhecida ou acima de 20: seleção inválida', async () => {
      const { processo: s } = servicos();
      for (const sel of [['p1'], ['p1', 'p1'], ['p1', 'x'], Array.from({ length: 21 }, (_, i) => `p${i}`)]) {
        expect(motivoDe(await erroDe(s.iniciar(WS, NUMERO_TJSP_A, sel)))).toBe(
          'selecao_invalida',
        );
      }
    });

    it('processo em segredo de justiça (retrato ou listagem): recusa', async () => {
      processoSigiloso = true;
      const { processo: s } = servicos();
      expect(motivoDe(await erroDe(s.iniciar(WS, NUMERO_TJSP_A, ['p1', 'p2'])))).toBe(
        'processo_sigiloso',
      );
    });

    it('outro tribunal: só o TJGO', async () => {
      tribunal = 'TJSP';
      const { processo: s } = servicos();
      expect(motivoDe(await erroDe(s.iniciar(WS, NUMERO_TJSP_A, ['p1', 'p2'])))).toBe(
        'tribunal_nao_suportado',
      );
    });

    it('processo não acompanhado pela conta', async () => {
      const { processo: s } = servicos({ workspaces: [OUTRA] });
      await expect(s.iniciar(OUTRA, NUMERO_TJSP_A, ['p1', 'p2'])).rejects.toBeInstanceOf(
        AcompanhamentoNaoEncontradoError,
      );
    });

    it('uma análise por vez por conta', async () => {
      const { processo: s } = servicos();
      await s.iniciar(WS, NUMERO_TJSP_A, ['p1', 'p3']);
      expect(motivoDe(await erroDe(s.iniciar(WS, NUMERO_TJSP_A, ['p1', 'p3'])))).toBe(
        'limite_de_uso',
      );
      await s.aguardarOcioso();
    });

    it('freio por hora da análise do processo', async () => {
      const { processo: s } = servicos({ porHoraDoProcesso: 1 });
      await rodar(s, ['p1', 'p3']);
      expect(motivoDe(await erroDe(s.iniciar(WS, NUMERO_TJSP_A, ['p1', 'p3'])))).toBe(
        'limite_de_uso',
      );
    });

    it('nada disso chamou modelo nem tribunal', async () => {
      tribunal = 'TJSP';
      const { processo: s } = servicos();
      await erroDe(s.iniciar(WS, NUMERO_TJSP_A, ['p1', 'p2']));
      expect(analisador.chamadas).toBe(0);
      expect(sintetizador.chamadas).toBe(0);
      expect(pedidosAoTribunal).toEqual([]);
    });
  });

  describe('peças que ficam de fora', () => {
    it('peça sigilosa nunca é lida; sem texto fica de fora com o motivo', async () => {
      const p2 = pecasFalsas.get('p2');
      if (p2) p2.sigilosa = true;
      const p3 = pecasFalsas.get('p3');
      if (p3) p3.pdf = await pdfSoComImagem(2);
      const { processo: s } = servicos();
      const v = await rodar(s);
      expect(v.pecas.map((p) => [p.estado, p.motivo])).toEqual([
        ['lida', null],
        ['fora', 'peca_sigilosa'],
        ['fora', 'sem_texto'],
      ]);
      // Uma peça lida só: não há o que cruzar, e o modelo da síntese não é chamado.
      expect(v.resultado?.semSintese).toBe('poucas_pecas');
      expect(sintetizador.chamadas).toBe(0);
      expect(pedidosAoTribunal).toEqual([]);
    });

    it('credencial recusada: a peça fica de fora e as seguintes não insistem no tribunal', async () => {
      guarda = new Set(['p1']);
      falhaDoTribunal = new CredencialTribunalInvalidaError('mni', 'recusada');
      const { processo: s } = servicos();
      const v = await rodar(s);
      expect(v.pecas.map((p) => p.motivo)).toEqual([null, 'credencial', 'credencial']);
      expect(pedidosAoTribunal).toEqual(['p2']);
    });

    it('o teto do dia acaba no meio: as peças seguintes ficam de fora e a síntese não roda', async () => {
      const { processo: s } = servicos({ porDia: 10 });
      const v = await rodar(s);
      expect(v.pecas.map((p) => [p.estado, p.motivo])).toEqual([
        ['lida', null],
        ['lida', null],
        ['fora', 'limite_diario'],
      ]);
      expect(v.resultado?.semSintese).toBe('limite_diario');
      expect(sintetizador.chamadas).toBe(0);
    });

    it('erro do modelo da síntese: os blocos do sistema seguem, sem síntese', async () => {
      sintetizador.resposta = async () => {
        throw new Error('falhou');
      };
      const { processo: s } = servicos();
      const v = await rodar(s);
      expect(v.fase).toBe('concluida');
      expect(v.resultado?.semSintese).toBe('erro');
      expect(v.resultado?.determinacoes).toHaveLength(2);
    });
  });

  describe('o acompanhamento do job', () => {
    it('cancelar: o job para e a síntese não é pedida', async () => {
      const { processo: s } = servicos();
      const v = await s.iniciar(WS, NUMERO_TJSP_A, ['p1', 'p2', 'p3']);
      s.cancelar(WS, v.id);
      await s.aguardarOcioso();
      const fim = s.consultar(WS, v.id);
      expect(fim.fase).toBe('cancelada');
      expect(sintetizador.chamadas).toBe(0);
    });

    it('outra conta não vê nem cancela o job: "não encontrada"', async () => {
      const { processo: s } = servicos();
      const v = await rodar(s, ['p1', 'p3']);
      expect(motivoDe(await erroDe(Promise.resolve().then(() => s.consultar(OUTRA, v.id))))).toBe(
        'nao_encontrada',
      );
      expect(motivoDe(await erroDe(Promise.resolve().then(() => s.cancelar(OUTRA, v.id))))).toBe(
        'nao_encontrada',
      );
    });

    it('o resultado some da memória uma hora depois de terminar', async () => {
      const { processo: s } = servicos();
      const v = await rodar(s, ['p1', 'p3']);
      relogio.avancar(3_600_001);
      expect(motivoDe(await erroDe(Promise.resolve().then(() => s.consultar(WS, v.id))))).toBe(
        'nao_encontrada',
      );
    });

    it('a estimativa conta sigilosas, a buscar no tribunal e as já analisadas', async () => {
      const { processo: s } = servicos();
      const antes = await s.estimar(WS, NUMERO_TJSP_A, ['p1', 'p2', 'p3']);
      expect(antes).toEqual({
        total: 3,
        sigilosas: 0,
        aBuscarNoTribunal: 1,
        jaAnalisadas: 0,
        pesoMaximo: 20,
      });
      await rodar(s);
      const depois = await s.estimar(WS, NUMERO_TJSP_A, ['p1', 'p2', 'p3']);
      expect(depois.jaAnalisadas).toBe(3);
      expect(depois.pesoMaximo).toBe(5);
    });
  });

  it('o log leva só contagens: nada de nome, número de processo ou texto', async () => {
    const { processo: s } = servicos();
    await rodar(s);
    const tudo = log.linhas.join('\n');
    expect(tudo).toContain('análise do processo concluída');
    expect(tudo).not.toContain(NOME_DA_PARTE);
    expect(tudo).not.toContain(NUMERO);
    expect(tudo).not.toContain('refrigerador');
  });
});
