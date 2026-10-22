import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ListaZdrLida } from '../../src/infrastructure/adapters/modelo/endpointsZdr.js';
import type {
  PedidoAoModelo,
  RespostaDoTransporte,
  TransporteDeModelo,
} from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { avaliarResposta } from '../../src/main/sonda/avaliacaoAutomatica.js';
import { lerCasosDeAvaliacao } from '../../src/main/sonda/casosDeAvaliacao.js';
import { executarComandoComparador } from '../../src/main/sonda/comandoComparadorIa.js';
import type { AmbienteDaSonda } from '../../src/main/sonda/comandoSondaIa.js';
import {
  TetoDeGastoAtingidoError,
  TransporteComTeto,
  compararModelos,
  estimarCusto,
  revisaoHumanaEmCsv,
} from '../../src/main/sonda/comparadorDeModelos.js';

const JSON_DOS_CASOS = readFileSync(
  resolve(import.meta.dirname, '../fixtures/ia-avaliacao/casos.json'),
  'utf8',
);
const casos = lerCasosDeAvaliacao(JSON_DOS_CASOS);
const caso = (id: string) => {
  const c = casos.find((x) => x.id === id);
  if (!c) throw new Error(`caso ${id} inexistente`);
  return c;
};

const CHAVE = 'sk-or-chave-de-teste-minuscula-456';
const PRODUCAO = 'm/producao';
const LISTA: ListaZdrLida = {
  itensRecebidos: 3,
  camposDoPrimeiroItem: ['model_id', 'provider_name'],
  endpoints: ['m/producao', 'm/candidato'].map((modelo) => ({
    modelo,
    provedor: 'Provedor Dublado',
    tag: 'dublado/fp8',
    precoEntrada: 0.000001,
    precoSaida: 0.000002,
  })),
};

interface Resposta {
  resumo?: string;
  acoes?: string[];
  prazo?: { dias: number; tipo: string | null } | null;
  custoUsd?: number;
}

/** Modelo dublado: cita o começo do corpo do ato e diz `resumo` (ou o que `resposta` mandar). */
function transporte(
  resposta: (p: PedidoAoModelo) => Resposta = () => ({}),
  chamadas: PedidoAoModelo[] = [],
): TransporteDeModelo {
  return {
    nome: 'dublado',
    gerar: async (pedido) => {
      chamadas.push(pedido);
      const r = resposta(pedido);
      const trecho =
        /Texto:\n(.{20,60}?)[ .,]/s.exec(pedido.usuario)?.[1] ?? 'texto do ato';
      const saida: RespostaDoTransporte = {
        objeto: {
          parece_pedir: 'apenas_ciencia',
          resumo: r.resumo ?? 'O ato comunica algo à parte.',
          trecho_chave: trecho,
          acoes_possiveis: (r.acoes ?? []).map((acao) => ({ acao })),
          pontos_de_atencao: [],
          ...(r.prazo !== undefined ? { prazo: r.prazo } : {}),
        },
        tokensEntrada: 1000,
        tokensSaida: 100,
        ...(r.custoUsd !== undefined ? { custoUsd: r.custoUsd } : {}),
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

describe('avaliação automática contra o caso', () => {
  it('resposta que diz o que o ato diz cobre os pontos e não viola nada', () => {
    const a = avaliarResposta(caso('d01-tutela-deferida'), {
      parece_pedir: 'cumprir_determinacao',
      resumo:
        'A tutela de urgência foi deferida; a requerida tem 5 dias, sob multa diária de R$ 300,00.',
      trecho_chave: 'DEFIRO a tutela para determinar que a requerida restabeleça',
      acoes_possiveis: [],
      pontos_de_atencao: [],
      prazo: { dias: 5, tipo: null },
    });
    expect(a?.pontosFaltando).toEqual([]);
    expect(a?.pontosCobertos).toEqual(['decisao', 'prazo', 'valor']);
    expect(a?.violacoes).toEqual([]);
  });

  it('detecta conselho, cálculo de prazo, data, valor e prazo estruturado inventados', () => {
    const a = avaliarResposta(caso('d01-tutela-deferida'), {
      parece_pedir: 'cumprir_determinacao',
      resumo:
        'Recomendo recorrer. O prazo vence em 20/11/2026 e a multa sobe para R$ 9.999,00.',
      trecho_chave: 'DEFIRO a tutela para determinar que a requerida restabeleça',
      acoes_possiveis: [],
      pontos_de_atencao: [],
      prazo: { dias: 30, tipo: 'uteis' },
    });
    expect(new Set(a?.violacoes)).toEqual(
      new Set([
        'dar_conselho',
        'calcular_prazo',
        'inventar_data',
        'inventar_valor',
        'prazo_inventado',
      ]),
    );
  });

  it('resposta fora do esquema não é avaliada (o comparador a conta como falha de formato)', () => {
    expect(
      avaliarResposta(caso('d01-tutela-deferida'), { qualquer: 'coisa' }),
    ).toBeUndefined();
  });
});

describe('teto de gasto', () => {
  it('para ANTES da chamada que passaria do teto e diz que foi atingido', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const t = new TransporteComTeto(
      transporte(() => ({ custoUsd: 0.02 }), chamadas),
      0.05,
    );
    const pedido: PedidoAoModelo = {
      modelo: PRODUCAO,
      sistema: 's',
      usuario: 'Texto:\nTexto de teste do ato. fim',
      provedoresPermitidos: ['Provedor Dublado'],
    };
    await t.gerar(pedido);
    await t.gerar(pedido);
    await t.gerar(pedido);
    expect(t.gasto).toBeCloseTo(0.06);
    expect(t.tetoAtingido).toBe(true);
    await expect(t.gerar(pedido)).rejects.toBeInstanceOf(TetoDeGastoAtingidoError);
    expect(chamadas).toHaveLength(3);
  });

  it('chamada que falha conta o custo conservador, nunca zero', async () => {
    const t = new TransporteComTeto(
      {
        nome: 'x',
        gerar: async () => {
          throw new Error('falhou');
        },
      },
      1,
    );
    await expect(
      t.gerar({ modelo: 'm', sistema: '', usuario: '', provedoresPermitidos: ['p'] }),
    ).rejects.toThrow('falhou');
    expect(t.gasto).toBeGreaterThan(0);
  });

  it('a rodada para sozinha no teto: casos restantes não chamam o modelo', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const t = new TransporteComTeto(
      transporte(() => ({ custoUsd: 0.02 }), chamadas),
      0.05,
    );
    const r = await compararModelos({
      casos,
      modeloDeReferencia: PRODUCAO,
      modelos: [PRODUCAO],
      transporte: t,
      teto: t,
      provedoresPermitidos: () => ['Provedor Dublado'],
      parConfirmadoZdr: () => true,
      precos: new Map(),
      agora: () => 0,
    });
    expect(r.tetoAtingido).toBe(true);
    expect(chamadas).toHaveLength(3);
  });
});

describe('métricas da comparação', () => {
  it('conta violações, pontos, latência p50/p95 e custo médio/p95/máx/total por modelo', async () => {
    let relogio = 0;
    let n = 0;
    const r = await compararModelos({
      casos: [caso('d01-tutela-deferida'), caso('d02-tutela-indeferida')].filter(Boolean),
      modeloDeReferencia: PRODUCAO,
      modelos: [PRODUCAO],
      transporte: transporte(() => {
        n += 1;
        relogio += 0; // a latência vem do `agora` abaixo
        return {
          custoUsd: 0.001 * n,
          resumo: n === 1 ? 'Recomendo recorrer.' : 'Ato comunicado.',
        };
      }),
      provedoresPermitidos: () => ['Provedor Dublado'],
      parConfirmadoZdr: () => true,
      precos: new Map(),
      agora: () => (relogio += 1000),
    });
    const l = r.linhas[0];
    expect(l?.referencia).toBe(true);
    expect(l?.chamadas).toBe(2);
    expect(l?.totalViolacoes).toBe(1);
    expect(l?.violacoes['dar_conselho']).toBe(1);
    expect(l?.custoMaximoUsd).toBeCloseTo(0.002);
    expect(l?.custoTotalUsd).toBeCloseTo(0.003);
    expect(l?.custoP95Usd).toBeCloseTo(0.002);
    expect(l?.fonteDoCusto).toBe('openrouter');
    expect(l?.latenciaP50Ms).toBeGreaterThan(0);
    expect(l?.citacaoVerificada).toBe(1);
  });

  it('resposta fora do esquema vira falha de formato e os pontos do caso contam como não cobertos', async () => {
    const r = await compararModelos({
      casos: [caso('d01-tutela-deferida')],
      modeloDeReferencia: PRODUCAO,
      modelos: [PRODUCAO],
      transporte: {
        nome: 'x',
        gerar: async (p) => ({
          objeto: { lixo: true },
          provedor: 'Provedor Dublado',
          modeloResolvido: p.modelo,
          diagnostico: {
            corpoEnviado: {},
            modeloResolvido: p.modelo,
            provedorDaResposta: 'Provedor Dublado',
          },
        }),
      },
      provedoresPermitidos: () => ['Provedor Dublado'],
      parConfirmadoZdr: () => true,
      precos: new Map(),
      agora: () => 0,
    });
    expect(r.linhas[0]?.falhasDeFormato).toBe(1);
    expect(r.linhas[0]?.pontosTotais).toBe(3);
    expect(r.linhas[0]?.pontosCobertos).toBe(0);
  });

  it('caso de texto curto não chama o modelo e é contado como "sem chamada esperada"', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await compararModelos({
      casos: [caso('k01-curtissimo-conclusos')],
      modeloDeReferencia: PRODUCAO,
      modelos: [PRODUCAO],
      transporte: transporte(() => ({}), chamadas),
      provedoresPermitidos: () => ['Provedor Dublado'],
      parConfirmadoZdr: () => true,
      precos: new Map(),
      agora: () => 0,
    });
    expect(chamadas).toHaveLength(0);
    expect(r.linhas[0]?.semChamadaComoEsperado).toBe(1);
  });

  it('modelo sem a lista ZDR não é chamado nem uma vez', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await compararModelos({
      casos,
      modeloDeReferencia: PRODUCAO,
      modelos: [PRODUCAO],
      transporte: transporte(() => ({}), chamadas),
      provedoresPermitidos: () => [],
      parConfirmadoZdr: () => true,
      precos: new Map(),
      agora: () => 0,
    });
    expect(chamadas).toHaveLength(0);
    expect(r.linhas[0]?.interrompido).toBe(true);
    expect(r.modelosParados[0]?.motivo).toBe('sem ZDR');
  });

  it('o CSV de revisão humana neutraliza célula que começa como fórmula', async () => {
    const r = await compararModelos({
      casos: [caso('d01-tutela-deferida')],
      modeloDeReferencia: PRODUCAO,
      modelos: [PRODUCAO],
      transporte: transporte(() => ({ resumo: '=HYPERLINK("x")' })),
      provedoresPermitidos: () => ['Provedor Dublado'],
      parConfirmadoZdr: () => true,
      precos: new Map(),
      agora: () => 0,
    });
    const csv = revisaoHumanaEmCsv(r);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv.split('\n')[0]).toContain('avaliacao');
  });

  it('estimativa: custo por modelo só existe com preço, e nunca chama nada', () => {
    const e = estimarCusto(
      casos,
      ['m/producao', 'm/sem-preco'],
      new Map([['m/producao', { entrada: 0.000001, saida: 0.000002 }]]),
    );
    expect(e[0]?.custoEstimadoUsd).toBeGreaterThan(0);
    expect(e[1]?.custoEstimadoUsd).toBeUndefined();
    expect(e[0]?.chamadas).toBe(46);
  });
});

// --- o comando -------------------------------------------------------------------------

function ambiente(sobrepor: Partial<AmbienteDaSonda> = {}) {
  const gravados: Array<{ caminho: string; conteudo: string }> = [];
  const saida: string[] = [];
  const avisos: string[] = [];
  const chamadas: PedidoAoModelo[] = [];
  const amb: AmbienteDaSonda = {
    env: { OPENROUTER_API_KEY: CHAVE, PROCESSOVIVO_IA_MODELO: PRODUCAO },
    raizDoRepositorio: '/repo',
    lerArquivo: async (c) => {
      if (c.endsWith('casos.json')) return JSON_DOS_CASOS;
      throw new Error('arquivo inexistente');
    },
    lerStdin: async () => '',
    gravarArquivo: async (caminho, conteudo) => {
      gravados.push({ caminho, conteudo });
    },
    existeArquivo: async () => false,
    criarTransporte: () => transporte(() => ({ custoUsd: 0.001 }), chamadas),
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

describe('comando do comparador', () => {
  it('sem --executar só ESTIMA: zero chamadas ao modelo e nenhum arquivo gravado', async () => {
    const { amb, saida, chamadas, gravados } = ambiente();
    expect(await executarComandoComparador(['--modelos=m/candidato'], amb)).toBe(0);
    expect(chamadas).toHaveLength(0);
    expect(gravados).toHaveLength(0);
    const texto = saida.join('\n');
    expect(texto).toContain('NADA foi enviado');
    expect(texto).toContain('NÃO confirmado');
    expect(texto).toContain('m/producao (produção)');
    expect(texto).toContain('m/candidato');
  });

  it('com --executar roda produção + candidato, grava três arquivos fora do repositório e a chave não vaza', async () => {
    const { amb, saida, avisos, chamadas, gravados } = ambiente();
    expect(
      await executarComandoComparador(
        ['--modelos=m/candidato', '--executar', '--saida=/dados/cmp'],
        amb,
      ),
    ).toBe(0);
    expect(chamadas.length).toBe(46 * 2);
    expect(chamadas.every((c) => c.provedoresPermitidos.length > 0)).toBe(true);
    expect(chamadas[0]?.modelo).toBe(PRODUCAO);
    expect(
      gravados.map((g) => g.caminho.replace(/^.*comparacao-2026-10-22-0930/, '')),
    ).toEqual(['.md', '-metricas.csv', '-revisao-humana.csv']);
    expect(gravados.every((g) => g.caminho.startsWith('/dados/cmp/'))).toBe(true);
    const md = gravados[0]?.conteudo ?? '';
    expect(md).toContain('Preços não confirmados');
    expect(md).toContain('m/producao (produção)');
    const tudo = [...saida, ...avisos, ...gravados.map((g) => g.conteudo)].join('\n');
    expect(tudo).not.toContain(CHAVE);
  });

  it('recusa sem chave, com valor de exemplo e sem o modelo de produção — antes de qualquer rede', async () => {
    for (const env of [
      { PROCESSOVIVO_IA_MODELO: PRODUCAO },
      { OPENROUTER_API_KEY: 'COLE_AQUI_A_CHAVE', PROCESSOVIVO_IA_MODELO: PRODUCAO },
      { OPENROUTER_API_KEY: CHAVE },
    ]) {
      let pediuLista = false;
      const { amb, chamadas } = ambiente({
        env,
        buscarEndpointsZdr: async () => {
          pediuLista = true;
          return LISTA;
        },
      });
      expect(await executarComandoComparador(['--executar'], amb)).toBe(2);
      expect(chamadas).toHaveLength(0);
      expect(pediuLista).toBe(false);
    }
  });

  it('recusa pasta de saída dentro do repositório', async () => {
    const { amb, chamadas } = ambiente();
    expect(
      await executarComandoComparador(['--executar', '--saida=/repo/relatorios'], amb),
    ).toBe(2);
    expect(chamadas).toHaveLength(0);
  });

  it('recusa modelo sem ZDR e apelido, e roda só os aprovados', async () => {
    const { amb, avisos, chamadas } = ambiente();
    expect(
      await executarComandoComparador(
        [
          '--modelos=m/sem-zdr,~m/apelido,m/candidato:free',
          '--executar',
          '--saida=/dados/cmp',
        ],
        amb,
      ),
    ).toBe(0);
    const texto = avisos.join('\n');
    expect(texto).toContain('"m/sem-zdr" não tem endpoint com ZDR');
    expect(texto).toContain('"~m/apelido" é apelido');
    expect(new Set(chamadas.map((c) => c.modelo))).toEqual(new Set([PRODUCAO]));
  });

  it('modelo de produção fora da lista ZDR: nada é enviado (falha fechada)', async () => {
    const { amb, chamadas } = ambiente({
      buscarEndpointsZdr: async () => ({ ...LISTA, endpoints: [] }),
    });
    expect(await executarComandoComparador(['--executar'], amb)).toBe(2);
    expect(chamadas).toHaveLength(0);
  });

  it('lista ZDR inalcançável: nada é enviado', async () => {
    const { amb, chamadas } = ambiente({
      buscarEndpointsZdr: async () => {
        throw new Error('rede fora');
      },
    });
    expect(await executarComandoComparador(['--executar'], amb)).toBe(2);
    expect(chamadas).toHaveLength(0);
  });

  it('estimativa acima do teto: recusa executar, e o teto é configurável', async () => {
    const um = ambiente();
    expect(
      await executarComandoComparador(['--executar', '--teto-usd=0.01'], um.amb),
    ).toBe(2);
    expect(um.chamadas).toHaveLength(0);
    expect(um.avisos.join('\n')).toContain('passa do teto');
    const dois = ambiente();
    expect(
      await executarComandoComparador(
        ['--executar', '--teto-usd=5', '--saida=/dados/cmp', '--categorias=decisao'],
        dois.amb,
      ),
    ).toBe(0);
    expect(dois.chamadas.length).toBeGreaterThan(0);
    expect(await executarComandoComparador(['--teto-usd=0'], ambiente().amb)).toBe(1);
  });

  it('o comparador nunca é chamado pelo CI nem pelo servidor', () => {
    const raiz = resolve(import.meta.dirname, '../..');
    const ci = readFileSync(resolve(raiz, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).not.toContain('ia-comparar-modelos');
    const pacote = readFileSync(resolve(raiz, 'package.json'), 'utf8');
    expect(pacote).not.toContain('ia-comparar-modelos');
  });
});
