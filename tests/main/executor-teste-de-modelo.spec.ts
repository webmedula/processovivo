import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTRUCAO_DA_PECA } from '../../src/application/politicas/entradaDaPeca.js';
import { julgarTeste } from '../../src/domain/entities/ModelosDeIa.js';
import type { EndpointZdr } from '../../src/infrastructure/adapters/modelo/endpointsZdr.js';
import type {
  PedidoAoModelo,
  RespostaDoTransporte,
  TransporteDeModelo,
} from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { ExecutorDoTesteDeModeloComSonda } from '../../src/main/sonda/executorDoTesteDeModelo.js';

/*
 * O executor do teste de modelo sobre os comparadores que já existiam. Transporte dublê, nenhuma rede.
 * Prova: ZDR primeiro (sem ele nada é enviado), as chamadas só vão aos dois modelos e a provedores da lista,
 * o teto de gasto, o cancelamento, a normalização das três funções e que nenhum texto de caso sobra no resultado.
 */

const PASTA = resolve(import.meta.dirname, '../fixtures');
const ATUAL = 'fab-a/atual';
const NOVO = 'fab-b/novo';
const LISTA: EndpointZdr[] = [ATUAL, NOVO].map((modelo) => ({
  modelo,
  provedor: 'Provedor Dublado',
  tag: 'dublado/fp8',
  precoEntrada: 0.000001,
  precoSaida: 0.000002,
}));
const PRECOS = new Map([
  [ATUAL, { entrada: 0.000001, saida: 0.000002 }],
  [NOVO, { entrada: 0.000001, saida: 0.000002 }],
]);

/** Cita o começo do corpo do ato, como o dublê do comparador. */
function transporteDoAto(
  chamadas: PedidoAoModelo[],
  sobre: { provedor?: string; custoUsd?: number } = {},
): TransporteDeModelo {
  return {
    nome: 'dublado',
    gerar: async (pedido): Promise<RespostaDoTransporte> => {
      chamadas.push(pedido);
      const trecho =
        /Texto:\n(.{20,60}?)[ .,]/s.exec(pedido.usuario)?.[1] ?? 'texto do ato';
      return {
        objeto: {
          parece_pedir: 'apenas_ciencia',
          resumo: 'O ato comunica algo à parte.',
          trecho_chave: trecho,
          acoes_possiveis: [],
          pontos_de_atencao: [],
        },
        tokensEntrada: 1000,
        tokensSaida: 100,
        custoUsd: sobre.custoUsd ?? 0.0001,
        provedor: sobre.provedor ?? 'Provedor Dublado',
        modeloResolvido: pedido.modelo,
        diagnostico: {
          corpoEnviado: { model: pedido.modelo },
          modeloResolvido: pedido.modelo,
          provedorDaResposta: sobre.provedor ?? 'Provedor Dublado',
        },
      };
    },
  };
}

/** Resposta sem nada do esquema: a função só mede "falha de formato". */
function transporteQueErra(chamadas: PedidoAoModelo[]): TransporteDeModelo {
  return {
    nome: 'dublado',
    gerar: async (pedido): Promise<RespostaDoTransporte> => {
      chamadas.push(pedido);
      return {
        objeto: { lixo: true },
        tokensEntrada: 10,
        tokensSaida: 5,
        provedor: 'Provedor Dublado',
        modeloResolvido: pedido.modelo,
        diagnostico: {
          corpoEnviado: { model: pedido.modelo },
          modeloResolvido: pedido.modelo,
          provedorDaResposta: 'Provedor Dublado',
        },
      };
    },
  };
}

function montar(
  transporte: TransporteDeModelo,
  lista: () => Promise<readonly EndpointZdr[]> = async () => LISTA,
): ExecutorDoTesteDeModeloComSonda {
  let t = 0;
  return new ExecutorDoTesteDeModeloComSonda({
    pastaDosConjuntos: PASTA,
    buscarListaZdr: lista,
    criarTransporte: () => transporte,
    agora: () => (t += 1_000),
  });
}

const pedido = (
  funcao: 'ato' | 'resumo' | 'peca',
  extra: Partial<{ tetoUsd: number; sinal: AbortSignal; candidato: string }> = {},
) => {
  let feitas = 0;
  return {
    pedido: {
      funcao,
      candidato: extra.candidato ?? NOVO,
      referencia: ATUAL,
      tetoUsd: extra.tetoUsd ?? 1,
      precos: PRECOS,
      sinal: extra.sinal ?? new AbortController().signal,
      aoChamar: () => {
        feitas += 1;
      },
    },
    feitas: () => feitas,
  };
};

describe('ato: o conjunto sintético inteiro, nos dois modelos, na mesma rodada', () => {
  it('normaliza as métricas, conta as chamadas e só fala com os dois modelos da lista ZDR', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const p = pedido('ato');
    const r = await montar(transporteDoAto(chamadas)).executar(p.pedido);
    if (r.tipo !== 'ok') throw new Error('esperava ok');
    expect(r.candidato.modelo).toBe(NOVO);
    expect(r.referencia.modelo).toBe(ATUAL);
    expect(r.candidato.chamadas).toBeGreaterThan(20);
    expect(r.candidato.chamadas).toBe(r.referencia.chamadas);
    expect(r.candidato.chamadasComErro).toBe(0);
    expect(r.candidato.interrompido).toBe(false);
    expect(r.candidato.citacaoVerificada).toBeGreaterThan(0.95);
    expect(r.candidato.latenciaP95Ms).not.toBeNull();
    expect(r.candidato.custoMedioUsd).toBeCloseTo(0.0001, 8);
    expect(r.candidato.fonteDoCusto).toBe('openrouter');
    expect(r.gastoUsd).toBeCloseTo(chamadas.length * 0.0001, 8);
    expect(r.tetoAtingido).toBe(false);
    // cada chamada saiu restrita aos provedores da lista ZDR
    expect(chamadas.length).toBe(r.candidato.chamadas + r.referencia.chamadas);
    for (const c of chamadas) {
      expect([ATUAL, NOVO]).toContain(c.modelo);
      expect(c.provedoresPermitidos).toEqual(['dublado']);
    }
    expect(p.feitas()).toBe(chamadas.length);
    // o veredito sai das métricas normalizadas
    expect(julgarTeste(r.candidato, r.referencia).veredito).toBeDefined();
  });

  it('nenhum texto de caso fica no resultado', async () => {
    const casos = JSON.parse(
      readFileSync(resolve(PASTA, 'ia-avaliacao/casos.json'), 'utf8'),
    ) as {
      casos?: Array<{ texto: string }>;
    };
    const lista = Array.isArray(casos)
      ? (casos as Array<{ texto: string }>)
      : (casos.casos ?? []);
    const r = await montar(transporteDoAto([])).executar(pedido('ato').pedido);
    const saida = JSON.stringify(r);
    for (const c of lista.slice(0, 10)) {
      expect(saida).not.toContain(c.texto.slice(80, 130));
    }
  });
});

describe('ZDR primeiro e sem exceção', () => {
  it('candidato sem endpoint na lista ZDR: nada é enviado', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const p = pedido('ato', { candidato: 'fab-z/sem-zdr' });
    const r = await montar(transporteDoAto(chamadas)).executar(p.pedido);
    expect(r).toEqual({ tipo: 'sem_zdr' });
    expect(chamadas).toHaveLength(0);
    expect(p.feitas()).toBe(0);
  });

  it('modelo ATUAL sem ZDR na lista: também nada é enviado', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await montar(transporteDoAto(chamadas), async () =>
      LISTA.filter((e) => e.modelo === NOVO),
    ).executar(pedido('ato').pedido);
    expect(r).toEqual({ tipo: 'sem_zdr' });
    expect(chamadas).toHaveLength(0);
  });

  it('lista ZDR inalcançável (ou vazia): falha fechada, nada é enviado', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await montar(transporteDoAto(chamadas), async () => {
      throw new Error('sem rede');
    }).executar(pedido('ato').pedido);
    expect(r).toEqual({ tipo: 'zdr_indisponivel' });
    expect(chamadas).toHaveLength(0);
  });

  it('resposta de provedor fora da lista é descartada, o modelo para e o teste fica incompleto', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await montar(transporteDoAto(chamadas, { provedor: 'Intruso' })).executar(
      pedido('ato').pedido,
    );
    if (r.tipo !== 'ok') throw new Error('esperava ok');
    expect(r.candidato.interrompido).toBe(true);
    expect(r.candidato.chamadasComErro).toBeGreaterThan(0);
    expect(julgarTeste(r.candidato, r.referencia).bloqueios).toEqual(
      expect.arrayContaining(['teste_incompleto', 'erro_do_provedor']),
    );
  });
});

describe('teto de gasto e cancelamento', () => {
  it('passou do teto: para de chamar e avisa; a rodada fica incompleta', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await montar(transporteDoAto(chamadas, { custoUsd: 0.05 })).executar(
      pedido('ato', { tetoUsd: 0.12 }).pedido,
    );
    if (r.tipo !== 'ok') throw new Error('esperava ok');
    expect(r.tetoAtingido).toBe(true);
    // 0,05 por chamada, teto 0,12: a 3ª chamada fecha o teto, a 4ª é recusada antes de sair
    expect(chamadas.length).toBe(3);
  });

  it('depois do cancelamento nenhuma chamada nova sai', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const c = new AbortController();
    c.abort();
    const p = pedido('ato', { sinal: c.signal });
    const r = await montar(transporteDoAto(chamadas)).executar(p.pedido);
    expect(chamadas).toHaveLength(0);
    expect(p.feitas()).toBe(0);
    if (r.tipo === 'ok') expect(r.candidato.chamadasComErro).toBeGreaterThan(0);
  });
});

describe('peça e resumo', () => {
  it('peça: usa o prompt de PRODUÇÃO e mede falha de formato', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await montar(transporteQueErra(chamadas)).executar(pedido('peca').pedido);
    if (r.tipo !== 'ok') throw new Error('esperava ok');
    expect(chamadas.length).toBeGreaterThan(0);
    for (const c of chamadas) expect(c.sistema).toBe(INSTRUCAO_DA_PECA);
    expect(r.candidato.falhasDeFormato).toBeGreaterThan(0);
    expect(r.candidato.pontosTotais).toBeGreaterThan(0);
    expect(r.candidato.pontosCobertos).toBe(0);
  });

  it('resumo: roda a versão de produção do prompt e mede falha de formato', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await montar(transporteQueErra(chamadas)).executar(pedido('resumo').pedido);
    if (r.tipo !== 'ok') throw new Error('esperava ok');
    expect(chamadas.length).toBeGreaterThan(0);
    expect(r.candidato.falhasDeFormato).toBeGreaterThan(0);
    expect(r.candidato.pontosTotais).toBeGreaterThan(0);
  });
});

describe('estimativa (sem rede)', () => {
  it.each(['ato', 'resumo', 'peca'] as const)(
    '%s: conta chamadas e estima o custo pelo preço da lista',
    (f) => {
      const e = montar(transporteDoAto([])).estimar(f, [ATUAL, NOVO], PRECOS);
      expect(e.chamadas).toBeGreaterThan(0);
      expect(e.custoEstimadoUsd).toBeGreaterThan(0);
    },
  );

  it('sem preço de um dos modelos, o custo é desconhecido (null), nunca zero', () => {
    const e = montar(transporteDoAto([])).estimar(
      'ato',
      [ATUAL, NOVO],
      new Map([[ATUAL, PRECOS.get(ATUAL)!]]),
    );
    expect(e.custoEstimadoUsd).toBeNull();
  });
});
