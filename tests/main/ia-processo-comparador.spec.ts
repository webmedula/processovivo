import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ListaZdrLida } from '../../src/infrastructure/adapters/modelo/endpointsZdr.js';
import type {
  PedidoAoModelo,
  RespostaDoTransporte,
  TransporteDeModelo,
} from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';
import {
  CasosDeProcessoInvalidosError,
  CATEGORIAS_DE_PROCESSO,
  lerCasosDeProcesso,
} from '../../src/main/sonda/casosDeProcesso.js';
import { executarComandoComparador } from '../../src/main/sonda/comandoComparadorIa.js';
import type { AmbienteDaSonda } from '../../src/main/sonda/comandoSondaIa.js';
import {
  compararSinteses,
  estimarCustoDeProcesso,
  metricasDeProcessoEmCsv,
  prepararCasoDeProcesso,
  relatorioDeProcessoEmMarkdown,
  revisaoDeProcessoEmCsv,
} from '../../src/main/sonda/comparadorDeProcesso.js';

/* Comparador da síntese do processo (v0.66.0). Casos e respostas SINTÉTICOS; o transporte é um dublê. */
const JSON_DOS_CASOS = readFileSync(
  resolve(import.meta.dirname, '../fixtures/ia-processo/casos.json'),
  'utf8',
);
const casos = lerCasosDeProcesso(JSON_DOS_CASOS);
const porUsuario = new Map(
  casos.map((c) => [prepararCasoDeProcesso(c).entrada.usuario, c]),
);

describe('casos sintéticos da síntese', () => {
  it('cobrem as quatro categorias, só com marcadores no lugar de nome', () => {
    expect(new Set(casos.map((c) => c.categoria))).toEqual(
      new Set(CATEGORIAS_DE_PROCESSO),
    );
    expect(casos.length).toBeGreaterThanOrEqual(8);
    expect(JSON_DOS_CASOS).toContain('[PARTE A]');
    expect(JSON_DOS_CASOS).not.toMatch(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/);
  });

  it('recusa caso fora do formato e id repetido', () => {
    expect(() => lerCasosDeProcesso('{')).toThrow(CasosDeProcessoInvalidosError);
    expect(() => lerCasosDeProcesso('[{"id":"x"}]')).toThrow(
      CasosDeProcessoInvalidosError,
    );
    expect(() => lerCasosDeProcesso(JSON.stringify([casos[0], casos[0]]))).toThrow(
      /id repetido/,
    );
  });
});

/**
 * Um modelo que acerta o básico (objeto e pedido citando os itens certos), cita uma referência que não
 * existe, e obedece à instrução injetada escrevendo "procedente": a verificação tem de barrar os dois.
 */
function responder(pedido: PedidoAoModelo): unknown {
  const caso = porUsuario.get(pedido.usuario);
  if (!caso) throw new Error('pedido desconhecido');
  const itens = [...prepararCasoDeProcesso(caso).entrada.itens.values()];
  const pedidoRef = itens.find((i) => i.categoria === 'pedido');
  const defesaRef = itens.find((i) => i.categoria === 'alegacao' && i.lado === 'reu');
  if (!pedidoRef) throw new Error('caso sem pedido');
  return {
    objeto: { texto: 'Discute-se o que a parte autora pede.', refs: [pedidoRef.ref] },
    pedidos: [
      {
        texto: 'A parte autora pede o que está na inicial.',
        refs: [pedidoRef.ref],
        defesa: defesaRef
          ? { texto: 'A parte ré contesta.', refs: [defesaRef.ref] }
          : null,
        decisao: null,
      },
    ],
    linha_do_tempo: [{ texto: 'Item sem base.', refs: ['P9.pedido9'] }],
    pontos_controvertidos:
      caso.categoria === 'injecao' && defesaRef
        ? [{ texto: 'O pedido é procedente.', refs: [pedidoRef.ref, defesaRef.ref] }]
        : [],
  };
}

const PRODUCAO = 'm/producao';
function transporte(
  chamadas: PedidoAoModelo[] = [],
  custoUsd?: number,
): TransporteDeModelo {
  return {
    nome: 'dublado',
    gerar: async (pedido) => {
      chamadas.push(pedido);
      const saida: RespostaDoTransporte = {
        objeto: responder(pedido),
        tokensEntrada: 2000,
        tokensSaida: 400,
        ...(custoUsd !== undefined ? { custoUsd } : {}),
        provedor: 'Provedor Dublado',
        modeloResolvido: pedido.modelo,
        diagnostico: {
          corpoEnviado: { model: pedido.modelo },
          modeloResolvido: pedido.modelo,
          provedorDaResposta: 'Provedor Dublado',
        },
      };
      return saida;
    },
  };
}
const base = (extra: Partial<Parameters<typeof compararSinteses>[0]> = {}) => ({
  casos,
  modeloDeReferencia: PRODUCAO,
  modelos: [PRODUCAO],
  transporte: transporte(),
  provedoresPermitidos: () => ['Provedor Dublado'],
  parConfirmadoZdr: () => true,
  precos: new Map(),
  agora: () => 0,
  ...extra,
});

describe('comparação da síntese', () => {
  it('passa pela MESMA verificação da produção: referência inventada e "procedente" saem, e nada disso conta como violação', async () => {
    const r = await compararSinteses(base());
    const l = r.linhas[0]!;
    expect(l.chamadas).toBe(casos.length);
    expect(l.verificadas).toBe(casos.length);
    expect(l.descartes.referencia).toBe(casos.length);
    expect(l.descartes.proibida).toBe(2);
    expect(l.violacoes).toBe(0);
    expect(l.pedidosComDefesa).toBeGreaterThan(0);
  });

  it('relatório, métricas e planilha de revisão (sem chave, com aviso de filtro e preço não confirmado)', async () => {
    const r = await compararSinteses(base());
    const md = relatorioDeProcessoEmMarkdown(r, {
      data: '2026-10-29',
      casos: casos.length,
      tetoUsd: 1,
    });
    expect(md).toContain('processo-1.0.0');
    expect(md).toContain('filtro, não um juiz');
    expect(md).toContain('Preços não confirmados');
    expect(metricasDeProcessoEmCsv(r).split('\n')[0]).toContain('descartes_referencia');
    const rev = revisaoDeProcessoEmCsv(r);
    expect(rev.split('\n')[0]).toContain('avaliacao');
    expect(rev).not.toContain('procedente');
  });

  it('modelo sem ZDR confirmada para o par não tem resposta usada', async () => {
    const r = await compararSinteses(base({ parConfirmadoZdr: () => false }));
    expect(r.modelosParados.length).toBeGreaterThan(0);
    expect(r.linhas.every((l) => l.verificadas === 0)).toBe(true);
  });

  it('estimativa: uma chamada por caso, por modelo', () => {
    const e = estimarCustoDeProcesso(
      casos,
      [PRODUCAO],
      new Map([[PRODUCAO, { entrada: 0.000001, saida: 0.000002 }]]),
    );
    expect(e[0]?.chamadas).toBe(casos.length);
    expect(e[0]?.custoEstimadoUsd).toBeGreaterThan(0);
  });
});

const CHAVE = 'sk-or-chave-de-teste-minuscula-456';
const LISTA: ListaZdrLida = {
  itensRecebidos: 1,
  camposDoPrimeiroItem: ['model_id', 'provider_name'],
  endpoints: [
    {
      modelo: PRODUCAO,
      provedor: 'Provedor Dublado',
      tag: 'dublado/fp8',
      precoEntrada: 0.000001,
      precoSaida: 0.000002,
    },
  ],
};
function ambiente() {
  const gravados: Array<{ caminho: string; conteudo: string }> = [];
  const saida: string[] = [];
  const avisos: string[] = [];
  const chamadas: PedidoAoModelo[] = [];
  const amb: AmbienteDaSonda = {
    env: { OPENROUTER_API_KEY: CHAVE, PROCESSOVIVO_IA_MODELO: PRODUCAO },
    raizDoRepositorio: '/repo',
    lerArquivo: async (c) => {
      if (c.endsWith('ia-processo/casos.json')) return JSON_DOS_CASOS;
      throw new Error('arquivo inexistente');
    },
    lerStdin: async () => '',
    gravarArquivo: async (caminho, conteudo) => {
      gravados.push({ caminho, conteudo });
    },
    existeArquivo: async () => false,
    criarTransporte: () => transporte(chamadas, 0.001),
    criarTransporteDeDiagnostico: () => {
      throw new Error('não usado');
    },
    buscarEndpointsZdr: async () => LISTA,
    buscarEndpointsPublicosDoModelo: async () => [],
    buscarModelosPublicos: async () => [],
    hoje: () => '2026-10-29',
    hora: () => '0930',
    agora: () => 0,
    dormir: async () => undefined,
    saida: (l) => saida.push(l),
    aviso: (l) => avisos.push(l),
  };
  return { amb, gravados, saida, avisos, chamadas };
}

describe('comando do comparador, tarefa "processo"', () => {
  it('sem --executar só ESTIMA: zero chamadas e nenhum arquivo', async () => {
    const { amb, saida, chamadas, gravados } = ambiente();
    expect(await executarComandoComparador(['--tarefa=processo'], amb)).toBe(0);
    expect(chamadas).toHaveLength(0);
    expect(gravados).toHaveLength(0);
    expect(saida.join('\n')).toContain('NADA foi enviado');
  });

  it('com --executar grava os três arquivos fora do repositório e a chave não vaza', async () => {
    const { amb, saida, avisos, chamadas, gravados } = ambiente();
    expect(
      await executarComandoComparador(
        ['--tarefa=processo', '--executar', '--saida=/dados/cmp'],
        amb,
      ),
    ).toBe(0);
    expect(chamadas).toHaveLength(casos.length);
    expect(gravados.map((g) => g.caminho).sort()).toEqual([
      '/dados/cmp/comparacao-processo-2026-10-29-0930-metricas.csv',
      '/dados/cmp/comparacao-processo-2026-10-29-0930-revisao-humana.csv',
      '/dados/cmp/comparacao-processo-2026-10-29-0930.md',
    ]);
    expect(
      [...saida, ...avisos, ...gravados.map((g) => g.conteudo)].join('\n'),
    ).not.toContain(CHAVE);
  });

  it('estimativa acima do teto: nada é enviado', async () => {
    const { amb, chamadas, avisos } = ambiente();
    expect(
      await executarComandoComparador(
        ['--tarefa=processo', '--executar', '--teto-usd=0.0000001'],
        amb,
      ),
    ).toBe(2);
    expect(chamadas).toHaveLength(0);
    expect(avisos.join('\n')).toContain('passa do teto');
  });
});
