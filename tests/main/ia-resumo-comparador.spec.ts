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
  CasosDeResumoInvalidosError,
  CATEGORIAS_DE_RESUMO,
  lerCasosDeResumo,
  type CasoDeResumo,
} from '../../src/main/sonda/casosDeResumo.js';
import { executarComandoComparador } from '../../src/main/sonda/comandoComparadorIa.js';
import type { AmbienteDaSonda } from '../../src/main/sonda/comandoSondaIa.js';
import {
  compararResumos,
  estimarCustoDeResumo,
  metricasDeResumoEmCsv,
  prepararCasoDeResumo,
  relatorioDeResumoEmMarkdown,
  revisaoDeResumoEmCsv,
  VERSOES_DO_RESUMO,
  VERSOES_PADRAO_DO_COMPARADOR,
} from '../../src/main/sonda/comparadorDeResumo.js';

/*
 * Reescrito na v0.56.0: `VERSOES_DO_RESUMO` ganhou a `resumo-1.2.0`, e estes testes (1.0.0 × 1.1.0) passaram
 * a nomear as duas versões que sempre exerceram; o padrão do comando agora é 1.1.0 × 1.2.0 (bloco final).
 */
const DUAS_VERSOES = ['resumo-1.0.0', 'resumo-1.1.0'] as const;

/* Casos e respostas SINTÉTICOS. Nenhuma rede: o transporte é um dublê. */
const JSON_DOS_CASOS = readFileSync(
  resolve(import.meta.dirname, '../fixtures/ia-resumo/casos.json'),
  'utf8',
);
const casos = lerCasosDeResumo(JSON_DOS_CASOS);
const caso = (id: string): CasoDeResumo => {
  const c = casos.find((x) => x.id === id);
  if (!c) throw new Error(`caso ${id} inexistente`);
  return c;
};

describe('casos sintéticos do resumo', () => {
  it('cobrem as quatro categorias e não têm dado real (CNJ de 2099, nomes de mentira)', () => {
    expect(new Set(casos.map((c) => c.categoria))).toEqual(new Set(CATEGORIAS_DE_RESUMO));
    expect(casos.length).toBeGreaterThanOrEqual(8);
    expect(JSON_DOS_CASOS).toMatch(/2099/);
    expect(JSON_DOS_CASOS).not.toMatch(/\b\d{7}-\d{2}\.20(?!99)\d{2}\./);
  });

  it('recusa caso fora do formato e id repetido', () => {
    expect(() => lerCasosDeResumo('{')).toThrow(CasosDeResumoInvalidosError);
    expect(() => lerCasosDeResumo('[{"id":"x"}]')).toThrow(CasosDeResumoInvalidosError);
    const um = JSON.stringify([casos[0], casos[0]]);
    expect(() => lerCasosDeResumo(um)).toThrow(/id repetido/);
  });

  it('cada categoria reproduz o defeito que ela existe para provar', () => {
    for (const id of ['cabecalho-despacho', 'cabecalho-intimacao']) {
      const velha = prepararCasoDeResumo(caso(id), 'resumo-1.0.0');
      const nova = prepararCasoDeResumo(caso(id), 'resumo-1.1.0');
      expect(velha.entrada.atos.get('A1')?.textoEnviado).toContain('PODER JUDICIÁRIO');
      expect(nova.entrada.atos.get('A1')?.textoEnviado).not.toContain('PODER JUDICIÁRIO');
    }
    for (const id of ['muitos-titulos-a', 'muitos-titulos-b']) {
      const nova = prepararCasoDeResumo(caso(id), 'resumo-1.1.0');
      expect(nova.selecao.soTitulo).toBeGreaterThanOrEqual(18);
      expect(nova.selecao.comTexto).toBeLessThanOrEqual(3);
    }
    for (const id of ['mesmo-dia-a', 'mesmo-dia-b']) {
      const velha = prepararCasoDeResumo(caso(id), 'resumo-1.0.0');
      const nova = prepararCasoDeResumo(caso(id), 'resumo-1.1.0');
      expect(velha.selecao.mesclados).toBe(0);
      expect(nova.selecao.mesclados).toBe(1);
    }
    expect(
      prepararCasoDeResumo(caso('mesmo-dia-a'), 'resumo-1.0.0').selecao.maisRecente?.lido,
    ).toBe(false);
    expect(
      prepararCasoDeResumo(caso('mesmo-dia-a'), 'resumo-1.1.0').selecao.maisRecente?.lido,
    ).toBe(true);
    for (const id of ['recente-sem-texto-a', 'recente-sem-texto-b']) {
      const nova = prepararCasoDeResumo(caso(id), 'resumo-1.1.0');
      expect(nova.selecao.maisRecente?.lido).toBe(false);
      expect(nova.selecao.providenciasNaoLidas.length).toBeGreaterThanOrEqual(1);
      expect(nova.entrada.usuario).toContain('Texto lido: não.');
    }
  });
});

const CHAVE = 'sk-or-chave-de-teste-minuscula-789';
const PRODUCAO = 'm/producao';
const LISTA: ListaZdrLida = {
  itensRecebidos: 2,
  camposDoPrimeiroItem: ['model_id', 'provider_name'],
  endpoints: ['m/producao', 'm/candidato'].map((modelo) => ({
    modelo,
    provedor: 'Provedor Dublado',
    tag: 'dublado/fp8',
    precoEntrada: 0.000001,
    precoSaida: 0.000002,
  })),
};

/** Qual caso e qual versão é este pedido? O texto do usuário e o do sistema são únicos por par. */
const chaveDoPedido = (sistema: string, usuario: string): string =>
  `${sistema}\u0000${usuario}`;
const porPedido = new Map(
  casos.flatMap((c) =>
    VERSOES_DO_RESUMO.map((v) => {
      const p = prepararCasoDeResumo(c, v);
      return [chaveDoPedido(p.entrada.sistema, p.entrada.usuario), p] as const;
    }),
  ),
);

/**
 * Um modelo que cita o primeiro ato com texto e erra do jeito que o relato mostrou, nas duas
 * versões: chama de atual o que leu e diz que não há pendências. A diferença está na verificação.
 */
function responder(pedido: PedidoAoModelo): unknown {
  const p = porPedido.get(chaveDoPedido(pedido.sistema, pedido.usuario));
  if (!p) throw new Error('pedido desconhecido');
  const ato = [...p.entrada.atos.values()].find((a) => a.comTexto);
  if (!ato) throw new Error('caso sem ato com texto');
  const corpo = ato.textoEnviado.split('Texto:\n')[1] ?? '';
  const trecho = corpo.slice(0, 40).trim();
  const item = (texto: string) => ({ texto, ato: ato.id, trecho });
  return {
    situacao: [
      item('Atualmente o processo aguarda o cumprimento desse ato.'),
      item('O juízo determinou a providência descrita nesse ato.'),
    ],
    pendencias: [item('Não há pendências a cumprir.')],
    pontos_de_atencao: [],
  };
}

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
        tokensSaida: 300,
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

const base = (extra: Partial<Parameters<typeof compararResumos>[0]> = {}) => ({
  casos,
  versoes: DUAS_VERSOES,
  modeloDeReferencia: PRODUCAO,
  modelos: [PRODUCAO],
  transporte: transporte(),
  provedoresPermitidos: () => ['Provedor Dublado'],
  parConfirmadoZdr: () => true,
  precos: new Map(),
  agora: () => 0,
  ...extra,
});

describe('comparação resumo-1.0.0 × resumo-1.1.0', () => {
  it('a 1.1.0 não apresenta como atual o que a 1.0.0 apresentava, nem nega pendência', async () => {
    const r = await compararResumos(base());
    const velha = r.linhas.find((l) => l.versao === 'resumo-1.0.0');
    const nova = r.linhas.find((l) => l.versao === 'resumo-1.1.0');
    expect(velha?.chamadas).toBe(casos.length);
    expect(nova?.chamadas).toBe(casos.length);
    // 4 casos têm o ato mais recente sem leitura na 1.0.0: os 2 "ato recente sem texto" e os 2 "mesmo dia"
    // (que a 1.1.0 junta ao despacho com texto do outro diário). Na 1.1.0 só sobram os 2 primeiros,
    // e a verificação barra o que o modelo diria de "atual" neles.
    expect(velha?.atualIndevida).toBe(4);
    expect(nova?.atualIndevida).toBe(0);
    expect(velha?.negouPendencia).toBe(4);
    expect(nova?.negouPendencia).toBe(0);
    // O que a 1.1.0 barrou aparece como item descartado, não some em silêncio.
    expect(nova?.descartes).toBeGreaterThan(0);
  });

  it('as duas versões entram no relatório, nas métricas e na planilha de revisão (texto sintético, fórmula neutralizada)', async () => {
    const r = await compararResumos(base());
    const md = relatorioDeResumoEmMarkdown(r, {
      data: '2026-10-22',
      casos: casos.length,
      tetoUsd: 1,
    });
    expect(md).toContain('resumo-1.0.0');
    expect(md).toContain('resumo-1.1.0');
    expect(md).toContain('filtro, não um juiz');
    expect(md).toContain('Preços não confirmados');
    const csv = metricasDeResumoEmCsv(r);
    expect(csv.split('\n')[0]).toContain('atual_indevida');
    const revisao = revisaoDeResumoEmCsv(r);
    expect(revisao.split('\n')[0]).toContain('avaliacao');
    expect(revisao.split('\n').length).toBeGreaterThan(casos.length);
    expect(revisao).not.toContain('PODER JUDICIÁRIO');
  });

  it('modelo sem ZDR confirmada para o par não tem resposta usada', async () => {
    const r = await compararResumos(base({ parConfirmadoZdr: () => false }));
    expect(r.modelosParados.length).toBeGreaterThan(0);
    expect(r.linhas.every((l) => l.verificadas === 0)).toBe(true);
  });

  it('estimativa: uma chamada por (caso × versão) com texto, por modelo', () => {
    const e = estimarCustoDeResumo(
      casos,
      DUAS_VERSOES,
      [PRODUCAO],
      new Map([[PRODUCAO, { entrada: 0.000001, saida: 0.000002 }]]),
    );
    expect(e[0]?.chamadas).toBe(casos.length * 2);
    expect(e[0]?.custoEstimadoUsd).toBeGreaterThan(0);
  });
});

describe('comparação resumo-1.1.0 × resumo-1.2.0 (v0.56.0)', () => {
  const AS_NOVAS = ['resumo-1.1.0', 'resumo-1.2.0'] as const;
  const porPedidoNovo = new Map(
    casos.flatMap((c) =>
      AS_NOVAS.map((v) => {
        const p = prepararCasoDeResumo(c, v);
        return [chaveDoPedido(p.entrada.sistema, p.entrada.usuario), p] as const;
      }),
    ),
  );

  /** Um modelo que cita o ato com texto MAIS ANTIGO e escreve itens de tamanho conhecido. */
  function respostaDoAntigo(pedido: PedidoAoModelo): unknown {
    const p = porPedidoNovo.get(chaveDoPedido(pedido.sistema, pedido.usuario));
    if (!p) throw new Error('pedido desconhecido');
    const comTexto = [...p.entrada.atos.values()].filter((a) => a.comTexto);
    const ato = comTexto[comTexto.length - 1];
    if (!ato) throw new Error('caso sem ato com texto');
    const trecho = (ato.textoEnviado.split('Texto:\n')[1] ?? '').slice(0, 40).trim();
    return {
      situacao: [
        {
          texto: 'O juízo determinou a providência descrita nesse ato.',
          ato: ato.id,
          trecho,
        },
      ],
      pendencias: [
        { texto: 'Parte: cumprir o que o ato determina.', ato: ato.id, trecho },
      ],
      pontos_de_atencao: [],
    };
  }
  const transporteNovo = (): TransporteDeModelo => ({
    nome: 'dublado',
    gerar: async (pedido) => ({
      objeto: respostaDoAntigo(pedido),
      tokensEntrada: 2000,
      tokensSaida: 300,
      provedor: 'Provedor Dublado',
      modeloResolvido: pedido.modelo,
      diagnostico: {
        corpoEnviado: { model: pedido.modelo },
        modeloResolvido: pedido.modelo,
        provedorDaResposta: 'Provedor Dublado',
      },
    }),
  });

  it('a 1.2.0 rejeita a situação que ignora o ato mais recente lido; a 1.1.0 deixava passar', async () => {
    const r = await compararResumos(
      base({ versoes: AS_NOVAS, transporte: transporteNovo() }),
    );
    const antiga = r.linhas.find((l) => l.versao === 'resumo-1.1.0');
    const nova = r.linhas.find((l) => l.versao === 'resumo-1.2.0');
    expect(nova?.verificadas).toBeLessThan(antiga?.verificadas ?? 0);
    expect(nova?.naoVerificadas).toBeGreaterThan(0);
  });

  it('o relatório e as métricas trazem o tamanho médio da situação e das pendências', async () => {
    const r = await compararResumos(
      base({ versoes: AS_NOVAS, transporte: transporteNovo() }),
    );
    const antiga = r.linhas.find((l) => l.versao === 'resumo-1.1.0');
    expect(antiga?.situacaoMediaCaracteres).toBeGreaterThan(0);
    expect(antiga?.pendenciaMediaCaracteres).toBeGreaterThan(0);
    const md = relatorioDeResumoEmMarkdown(r, {
      data: '2026-10-22',
      casos: casos.length,
      tetoUsd: 1,
    });
    expect(md).toContain('resumo-1.1.0 × resumo-1.2.0');
    expect(md).toContain('Situação (média, caracteres)');
    expect(metricasDeResumoEmCsv(r).split('\n')[0]).toContain(
      'situacao_media_caracteres',
    );
  });

  it('o padrão do comparador são só estas duas versões, e a 1.0.0 continua pedindo por --versoes', () => {
    expect(VERSOES_DO_RESUMO).toContain('resumo-1.0.0');
    expect(VERSOES_PADRAO_DO_COMPARADOR).toEqual(['resumo-1.1.0', 'resumo-1.2.0']);
  });
});

function ambiente(sobrepor: Partial<AmbienteDaSonda> = {}) {
  const gravados: Array<{ caminho: string; conteudo: string }> = [];
  const saida: string[] = [];
  const avisos: string[] = [];
  const chamadas: PedidoAoModelo[] = [];
  const amb: AmbienteDaSonda = {
    env: { OPENROUTER_API_KEY: CHAVE, PROCESSOVIVO_IA_MODELO: PRODUCAO },
    raizDoRepositorio: '/repo',
    lerArquivo: async (c) => {
      if (c.endsWith('ia-resumo/casos.json')) return JSON_DOS_CASOS;
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
    hoje: () => '2026-10-22',
    hora: () => '0930',
    agora: () => 0,
    dormir: async () => undefined,
    saida: (l) => saida.push(l),
    aviso: (l) => avisos.push(l),
    ...sobrepor,
  };
  return { amb, gravados, saida, avisos, chamadas };
}

describe('comando do comparador, tarefa "resumo"', () => {
  it('sem --executar só ESTIMA: zero chamadas e nenhum arquivo gravado', async () => {
    const { amb, saida, chamadas, gravados } = ambiente();
    expect(await executarComandoComparador(['--tarefa=resumo'], amb)).toBe(0);
    expect(chamadas).toHaveLength(0);
    expect(gravados).toHaveLength(0);
    const texto = saida.join('\n');
    expect(texto).toContain('NADA foi enviado');
    expect(texto).toContain('NÃO confirmado');
    expect(texto).toContain('resumo-1.1.0, resumo-1.2.0');
    expect(texto).toContain('m/producao (produção)');
  });

  it('com --executar roda as duas versões com o modelo de produção, grava os três arquivos fora do repositório e a chave não vaza', async () => {
    const { amb, saida, avisos, chamadas, gravados } = ambiente();
    expect(
      await executarComandoComparador(
        ['--tarefa=resumo', '--executar', '--saida=/dados/cmp'],
        amb,
      ),
    ).toBe(0);
    expect(chamadas.length).toBe(casos.length * 2);
    expect(gravados.map((g) => g.caminho).sort()).toEqual([
      '/dados/cmp/comparacao-resumo-2026-10-22-0930-metricas.csv',
      '/dados/cmp/comparacao-resumo-2026-10-22-0930-revisao-humana.csv',
      '/dados/cmp/comparacao-resumo-2026-10-22-0930.md',
    ]);
    const tudo = [...saida, ...avisos, ...gravados.map((g) => g.conteudo)].join('\n');
    expect(tudo).not.toContain(CHAVE);
  });

  it('--versoes escolhe só uma das versões; versão desconhecida é recusada antes de qualquer chamada', async () => {
    const um = ambiente();
    expect(
      await executarComandoComparador(
        ['--tarefa=resumo', '--executar', '--versoes=resumo-1.1.0'],
        um.amb,
      ),
    ).toBe(0);
    expect(um.chamadas.length).toBe(casos.length);
    const dois = ambiente();
    expect(
      await executarComandoComparador(
        ['--tarefa=resumo', '--executar', '--versoes=resumo-9.9.9'],
        dois.amb,
      ),
    ).toBe(1);
    expect(dois.chamadas).toHaveLength(0);
  });

  it('estimativa acima do teto: nada é enviado', async () => {
    const { amb, chamadas, avisos } = ambiente();
    expect(
      await executarComandoComparador(
        ['--tarefa=resumo', '--executar', '--teto-usd=0.0000001'],
        amb,
      ),
    ).toBe(2);
    expect(chamadas).toHaveLength(0);
    expect(avisos.join('\n')).toContain('passa do teto');
  });

  it('modelo de produção sem ZDR na lista: nada é enviado', async () => {
    const { amb, chamadas } = ambiente({
      buscarEndpointsZdr: async () => ({ ...LISTA, endpoints: [] }),
    });
    expect(await executarComandoComparador(['--tarefa=resumo', '--executar'], amb)).toBe(
      2,
    );
    expect(chamadas).toHaveLength(0);
  });
});
