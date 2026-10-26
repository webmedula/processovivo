import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTRUCAO_DO_SISTEMA } from '../../src/application/politicas/entradaDoModelo.js';
import { INSTRUCAO_DA_PECA } from '../../src/application/politicas/entradaDaPeca.js';
import { INSTRUCAO_DO_RESUMO } from '../../src/application/politicas/entradaDoResumo.js';
import { montarSistema } from '../../src/domain/entities/InstrucoesDeIa.js';
import type { EndpointZdr } from '../../src/infrastructure/adapters/modelo/endpointsZdr.js';
import type {
  PedidoAoModelo,
  RespostaDoTransporte,
  TransporteDeModelo,
} from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { ExecutorDoTesteDeModeloComSonda } from '../../src/main/sonda/executorDoTesteDeModelo.js';

/*
 * O conjunto de verificação das instruções (Fase C) reaproveita os comparadores da Fase B: o MESMO conjunto
 * sintético, no MESMO modelo, duas vezes — uma com a instrução publicada, outra com o rascunho. Transporte
 * dublê, nenhuma rede. Prova que cada lado leva a SUA instrução, que a ZDR vale igual, que o teto é um só e
 * que nada do caso sobra no resultado.
 */

const PASTA = resolve(import.meta.dirname, '../fixtures');
const MODELO = 'fab-a/atual';
const LISTA: EndpointZdr[] = [
  {
    modelo: MODELO,
    provedor: 'Provedor Dublado',
    tag: 'dublado/fp8',
    precoEntrada: 0.000001,
    precoSaida: 0.000002,
  },
];
const PRECOS = new Map([[MODELO, { entrada: 0.000001, saida: 0.000002 }]]);
const PUBLICADA = 'INSTRUÇÃO PUBLICADA: destaque o prazo.';
const RASCUNHO = 'INSTRUÇÃO RASCUNHO: seja bem mais curto.';

function transporte(chamadas: PedidoAoModelo[], custoUsd = 0.0001): TransporteDeModelo {
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
        custoUsd,
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
  t: TransporteDeModelo,
  lista: () => Promise<readonly EndpointZdr[]> = async () => LISTA,
): ExecutorDoTesteDeModeloComSonda {
  let ms = 0;
  return new ExecutorDoTesteDeModeloComSonda({
    pastaDosConjuntos: PASTA,
    buscarListaZdr: lista,
    criarTransporte: () => t,
    agora: () => (ms += 1_000),
  });
}

const pedido = (
  funcao: 'ato' | 'resumo' | 'peca',
  extra: Partial<{ tetoUsd: number; sinal: AbortSignal; modelo: string }> = {},
) => {
  let feitas = 0;
  return {
    pedido: {
      funcao,
      modelo: extra.modelo ?? MODELO,
      publicada: PUBLICADA,
      rascunho: RASCUNHO,
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

describe.each([
  ['ato', INSTRUCAO_DO_SISTEMA],
  ['resumo', INSTRUCAO_DO_RESUMO],
  ['peca', INSTRUCAO_DA_PECA],
] as const)('%s: publicada × rascunho no mesmo modelo', (funcao, fixa) => {
  it('metade das chamadas leva a instrução publicada e a outra metade o rascunho; só o bloco muda', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const p = pedido(funcao);
    const r = await montar(transporte(chamadas)).executarInstrucoes(p.pedido);
    if (r.tipo !== 'ok') throw new Error('esperava ok');
    const dePublicada = chamadas.filter(
      (c) => c.sistema === montarSistema(funcao, fixa, PUBLICADA),
    );
    const doRascunho = chamadas.filter(
      (c) => c.sistema === montarSistema(funcao, fixa, RASCUNHO),
    );
    expect(dePublicada.length).toBeGreaterThan(0);
    expect(doRascunho.length).toBe(dePublicada.length);
    expect(dePublicada.length + doRascunho.length).toBe(chamadas.length);
    // as métricas dos dois lados são do mesmo modelo, e o candidato é o rascunho
    expect(r.candidato.modelo).toBe(MODELO);
    expect(r.referencia.modelo).toBe(MODELO);
    expect(r.candidato.chamadas).toBe(r.referencia.chamadas);
    expect(p.feitas()).toBe(chamadas.length);
    // as mensagens do CASO são as mesmas nos dois lados (só a instrução muda)
    const usuariosA = new Set(dePublicada.map((c) => c.usuario));
    const usuariosB = new Set(doRascunho.map((c) => c.usuario));
    expect(usuariosB).toEqual(usuariosA);
  });

  it('todas as chamadas saem restritas aos provedores ZDR do modelo', async () => {
    const chamadas: PedidoAoModelo[] = [];
    await montar(transporte(chamadas)).executarInstrucoes(pedido(funcao).pedido);
    for (const c of chamadas) {
      expect(c.modelo).toBe(MODELO);
      expect(c.provedoresPermitidos).toEqual(['dublado']);
    }
  });
});

describe('o gasto e o teto são de uma rodada só (as duas execuções somadas)', () => {
  it('gasto = soma das duas rodadas', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await montar(transporte(chamadas)).executarInstrucoes(pedido('ato').pedido);
    if (r.tipo !== 'ok') throw new Error('esperava ok');
    expect(r.gastoUsd).toBeCloseTo(chamadas.length * 0.0001, 8);
    expect(r.tetoAtingido).toBe(false);
  });

  it('passou do teto na primeira metade: a segunda nem começa a gastar além do teto', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await montar(transporte(chamadas, 0.05)).executarInstrucoes(
      pedido('ato', { tetoUsd: 0.12 }).pedido,
    );
    if (r.tipo !== 'ok') throw new Error('esperava ok');
    expect(r.tetoAtingido).toBe(true);
    // 0,05 por chamada, teto 0,12: a 3ª fecha o teto; a 4ª e as outras são recusadas antes de sair
    expect(chamadas.length).toBe(3);
  });
});

describe('ZDR primeiro e sem exceção', () => {
  it('modelo sem ZDR na lista: nada é enviado', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const p = pedido('ato', { modelo: 'fab-z/sem-zdr' });
    expect(await montar(transporte(chamadas)).executarInstrucoes(p.pedido)).toEqual({
      tipo: 'sem_zdr',
    });
    expect(chamadas).toHaveLength(0);
    expect(p.feitas()).toBe(0);
  });

  it('lista ZDR inalcançável: falha fechada, nada é enviado', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await montar(transporte(chamadas), async () => {
      throw new Error('sem rede');
    }).executarInstrucoes(pedido('ato').pedido);
    expect(r).toEqual({ tipo: 'zdr_indisponivel' });
    expect(chamadas).toHaveLength(0);
  });

  it('depois do cancelamento nenhuma chamada nova sai', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const c = new AbortController();
    c.abort();
    await montar(transporte(chamadas)).executarInstrucoes(
      pedido('ato', { sinal: c.signal }).pedido,
    );
    expect(chamadas).toHaveLength(0);
  });
});

describe('sem instrução (rascunho e publicada vazios) é exatamente o prompt de sempre', () => {
  it('um lado vazio usa a parte fixa, byte a byte', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const p = pedido('ato');
    await montar(transporte(chamadas)).executarInstrucoes({ ...p.pedido, publicada: '' });
    expect(chamadas.some((c) => c.sistema === INSTRUCAO_DO_SISTEMA)).toBe(true);
    expect(
      chamadas.some(
        (c) => c.sistema === montarSistema('ato', INSTRUCAO_DO_SISTEMA, RASCUNHO),
      ),
    ).toBe(true);
  });
});

describe('estimativa (sem rede)', () => {
  it.each(['ato', 'resumo', 'peca'] as const)(
    '%s: duas rodadas no mesmo modelo, custo estimado pelo preço',
    (f) => {
      const e = montar(transporte([])).estimarInstrucoes(f, MODELO, PRECOS);
      const uma = montar(transporte([])).estimar(f, [MODELO], PRECOS);
      expect(e.chamadas).toBe(uma.chamadas * 2);
      expect(e.custoEstimadoUsd).toBeCloseTo((uma.custoEstimadoUsd ?? 0) * 2, 10);
    },
  );

  it('sem preço do modelo, o custo é desconhecido (o teto em execução protege)', () => {
    expect(
      montar(transporte([])).estimarInstrucoes('ato', MODELO, new Map()).custoEstimadoUsd,
    ).toBeNull();
  });
});
