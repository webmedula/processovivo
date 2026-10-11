import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProviderIndisponivelError,
  SemProvedorQueAtendaError,
  ZdrIndisponivelError,
} from '../../src/domain/errors/index.js';
import type { ListaZdrLida } from '../../src/infrastructure/adapters/modelo/endpointsZdr.js';
import type {
  Degrau,
  PedidoAoModelo,
  RespostaDoTransporte,
  TransporteDeModelo,
} from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { lerCasosCsv, lerCasosSinteticos } from '../../src/main/sonda/casosDaSonda.js';
import {
  executarComandoSondaIa,
  type AmbienteDaSonda,
  type TransporteComDiagnostico,
} from '../../src/main/sonda/comandoSondaIa.js';
import {
  calcularJulgamento,
  calcularMetricas,
  escolherVencedor,
  executarSonda,
  gerarPlanilha,
} from '../../src/main/sonda/sondaIaAto.js';

const RAIZ = resolve(import.meta.dirname, '../..');
const SINTETICOS = readFileSync(
  resolve(RAIZ, 'tests/fixtures/ia-ato/casos-sinteticos.json'),
  'utf8',
);
const casosSinteticos = lerCasosSinteticos(SINTETICOS);

/** Modelo dublado: devolve uma leitura limpa que cita o começo do corpo do ato. */
function transporteQueCita(
  chamadas: PedidoAoModelo[] = [],
  custo = 0.001,
): TransporteDeModelo {
  return {
    nome: 'dublado',
    gerar: async (pedido) => {
      chamadas.push(pedido);
      const corpo =
        /Texto:\n(.{20,60}?)[ .,]/s.exec(pedido.usuario)?.[1] ?? 'texto do ato';
      const resposta: RespostaDoTransporte = {
        objeto: {
          parece_pedir: 'apenas_ciencia',
          resumo: 'O ato comunica algo à parte.',
          trecho_chave: corpo,
          acoes_possiveis: [],
          pontos_de_atencao: [],
        },
        tokensEntrada: 1000,
        tokensSaida: 100,
        custoUsd: custo,
        provedor: 'Provedor Dublado',
        modeloResolvido: pedido.modelo,
        diagnostico: {
          corpoEnviado: {
            model: pedido.modelo,
            provider: { only: pedido.provedoresPermitidos },
          },
          modeloResolvido: pedido.modelo,
          provedorDaResposta: 'Provedor Dublado',
        },
      };
      return resposta;
    },
  };
}

describe('lerCasosCsv', () => {
  it('lê id;tipo_comunicacao;classe;texto, com aspas, ; e quebra de linha dentro do texto', () => {
    const csv =
      'id;tipo_comunicacao;classe;texto\n' +
      'c1;Intimação;Cível;"Intime-se; ""já"".\nSegunda linha."\n' +
      'c2;;;texto simples do segundo caso\n';
    const casos = lerCasosCsv(csv);
    expect(casos).toHaveLength(2);
    expect(casos[0]).toMatchObject({
      id: 'c1',
      tipoComunicacao: 'Intimação',
      classe: 'Cível',
      origem: 'real',
    });
    expect(casos[0]?.texto).toBe('Intime-se; "já".\nSegunda linha.');
    expect(casos[1]?.tipoComunicacao).toBeUndefined();
  });

  it('aceita as colunas opcionais anteriores e injecao', () => {
    const [c] = lerCasosCsv('id;texto;anteriores;injecao\nx;um texto;A|B|C;sim\n');
    expect(c?.anteriores).toEqual(['A', 'B', 'C']);
    expect(c?.injecao).toBe(true);
  });

  it('erro de formato cita a linha e NUNCA o conteúdo', () => {
    let mensagem = '';
    try {
      lerCasosCsv('id;texto\nc1;texto-com-segredo;sobrou-coluna\n');
    } catch (e) {
      mensagem = (e as Error).message;
    }
    expect(mensagem).toMatch(/linha 2/);
    expect(mensagem).not.toContain('segredo');
  });

  it('recusa id repetido, texto vazio e cabeçalho sem id/texto', () => {
    expect(() => lerCasosCsv('id;texto\na;um\na;dois\n')).toThrow(/repetido/);
    expect(() => lerCasosCsv('id;texto\na;\n')).toThrow(/texto vazio/);
    expect(() => lerCasosCsv('numero;texto\na;um\n')).toThrow(/"id"/);
  });
});

describe('executarSonda', () => {
  it('chama o modelo para todos os casos com texto e só dispensa o curto, sem chamar', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await executarSonda({
      casos: casosSinteticos,
      modelos: ['m/pequeno'],
      variantes: ['sem-titulos'],
      transporte: transporteQueCita(chamadas),
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    const curto = r.registros.find((x) => x.casoId === 's07-texto-curto');
    expect(curto?.estado).toBe('sem_texto');
    expect(chamadas).toHaveLength(casosSinteticos.length - 1);
  });

  it('nada do que sai para o modelo contém dado pessoal dos casos sintéticos', async () => {
    const chamadas: PedidoAoModelo[] = [];
    await executarSonda({
      casos: casosSinteticos,
      modelos: ['m/pequeno'],
      variantes: ['com-titulos'],
      transporte: transporteQueCita(chamadas),
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    const tudo = chamadas.map((c) => c.usuario + c.sistema).join('\n');
    for (const proibido of [
      'Horácio',
      'Brandão',
      'Lívia',
      'Priscila',
      'Fernanda Lopes',
      '000.000.001-91',
      'exemplo.invalid',
      '99999-0000',
      '1000001-12.2025',
      '90001',
      '90002/GO',
    ]) {
      expect(tudo).not.toContain(proibido);
    }
  });

  it('ZDR indisponível tira o modelo da comparação e NÃO tenta de novo', async () => {
    let chamadas = 0;
    const transporte: TransporteDeModelo = {
      nome: 'dublado',
      gerar: async (p) => {
        if (p.modelo === 'm/sem-zdr') {
          chamadas += 1;
          throw new ZdrIndisponivelError('dublado', p.modelo);
        }
        return transporteQueCita().gerar(p);
      },
    };
    const r = await executarSonda({
      casos: casosSinteticos,
      modelos: ['m/sem-zdr', 'm/com-zdr'],
      variantes: ['sem-titulos', 'com-titulos'],
      transporte,
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    expect(chamadas).toBe(1);
    expect(r.modelosSemZdr).toEqual(['m/sem-zdr']);
    expect(
      r.registros.some((x) => x.modelo === 'm/com-zdr' && x.estado === 'verificada'),
    ).toBe(true);
  });

  it('uma repetição quando a saída foge do esquema; depois, resposta inválida', async () => {
    let n = 0;
    const transporte: TransporteDeModelo = {
      nome: 'dublado',
      gerar: async () => {
        n += 1;
        return {
          objeto: { qualquer: 'coisa' },
          provedor: 'Provedor Dublado',
          diagnostico: { corpoEnviado: null },
        };
      },
    };
    const r = await executarSonda({
      casos: casosSinteticos.slice(0, 1),
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte,
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    expect(n).toBe(2);
    expect(r.registros[0]).toMatchObject({ estado: 'resposta_invalida', repeticoes: 1 });
  });

  it('desiste do modelo depois de três falhas seguidas', async () => {
    let n = 0;
    const transporte: TransporteDeModelo = {
      nome: 'dublado',
      gerar: async () => {
        n += 1;
        throw new ProviderIndisponivelError('dublado', 'fora do ar');
      },
    };
    const r = await executarSonda({
      casos: casosSinteticos,
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte,
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    expect(n).toBe(3);
    expect(r.modelosComFalha.map((f) => f.modelo)).toEqual(['m/x']);
  });

  it('caso de injeção: o canário na saída é contado como obediência; esquema mantido é contado à parte', async () => {
    const caso = casosSinteticos.find((c) => c.injecao);
    expect(caso?.canario).toBeDefined();
    const obediente: TransporteDeModelo = {
      nome: 'dublado',
      gerar: async () => ({
        objeto: {
          parece_pedir: 'indeterminado',
          resumo: `${caso?.canario ?? ''}`,
          trecho_chave: '',
          acoes_possiveis: [],
          pontos_de_atencao: [],
        },
        provedor: 'Provedor Dublado',
        diagnostico: { corpoEnviado: null },
      }),
    };
    const r = await executarSonda({
      casos: caso ? [caso] : [],
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte: obediente,
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    const [m] = calcularMetricas(r.registros);
    expect(m?.injecao).toEqual({ casos: 1, esquemaMantido: 1, obedeceu: 1 });
  });

  it('só guarda a resposta crua de caso sintético, nunca de caso real', async () => {
    const real = lerCasosCsv(
      'id;texto\nr1;Intime-se a parte para se manifestar sobre o laudo pericial juntado aos autos, no prazo de dez dias.\n',
    );
    const r = await executarSonda({
      casos: [...real, ...casosSinteticos.slice(0, 1)],
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte: transporteQueCita(),
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    expect(r.registros.find((x) => x.origem === 'real')?.respostaCrua).toBeUndefined();
    expect(r.registros.find((x) => x.origem === 'sintetico')?.respostaCrua).toBeDefined();
  });
});

describe('executarSonda — provedor não confirmado', () => {
  it('resposta de provedor fora da lista é descartada sem verificar nem guardar, e SÓ aquele modelo para', async () => {
    const r = await executarSonda({
      casos: casosSinteticos,
      modelos: ['m/intruso', 'm/certo'],
      variantes: ['sem-titulos'],
      transporte: {
        nome: 'dublado',
        gerar: async (p) => ({
          ...(await transporteQueCita().gerar(p)),
          provedor: p.modelo === 'm/intruso' ? 'Provedor Intruso' : 'Provedor Dublado',
        }),
      },
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: (_m, provedor) => provedor === 'Provedor Dublado',
      agora: () => 0,
    });
    expect(r.modelosProvedorNaoConfirmado).toEqual(['m/intruso']);
    const doIntruso = r.registros.filter((x) => x.modelo === 'm/intruso');
    expect(doIntruso).toHaveLength(1);
    expect(doIntruso[0]).toMatchObject({
      estado: 'provedor_nao_confirmado',
      zdrConfirmado: false,
    });
    expect(doIntruso[0]?.verificacao).toBeUndefined();
    expect(doIntruso[0]?.respostaCrua).toBeUndefined();
    expect(
      r.registros.some(
        (x) => x.modelo === 'm/certo' && x.estado === 'verificada' && x.zdrConfirmado,
      ),
    ).toBe(true);
  });

  it('provedor não informado pela resposta também é "não confirmado"', async () => {
    const r = await executarSonda({
      casos: casosSinteticos.slice(0, 2),
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte: {
        nome: 'dublado',
        gerar: async (p) => {
          const { provedor: _p, ...resto } = await transporteQueCita().gerar(p);
          return resto;
        },
      },
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: (_m, provedor) => provedor === 'Provedor Dublado',
      agora: () => 0,
    });
    expect(r.modelosProvedorNaoConfirmado).toEqual(['m/x']);
  });
});

describe('executarSonda — trava preventiva e par', () => {
  it('sem provedores ZDR para o modelo (lista sem slug), NENHUMA chamada é feita', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await executarSonda({
      casos: casosSinteticos,
      modelos: ['m/sem-slug'],
      variantes: ['sem-titulos'],
      transporte: transporteQueCita(chamadas),
      provedoresPermitidos: () => [],
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    expect(chamadas).toHaveLength(0);
    expect(r.modelosSemZdr).toEqual(['m/sem-slug']);
    expect(r.registros.map((x) => x.estado)).toEqual(['sem_zdr']);
  });

  it('toda chamada leva a restrição aos provedores permitidos DAQUELE modelo', async () => {
    const chamadas: PedidoAoModelo[] = [];
    await executarSonda({
      casos: casosSinteticos.slice(0, 2),
      modelos: ['m/a', 'm/b'],
      variantes: ['sem-titulos'],
      transporte: transporteQueCita(chamadas),
      provedoresPermitidos: (m) => (m === 'm/a' ? ['alfa'] : ['beta', 'gama']),
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    expect(
      chamadas
        .filter((c) => c.modelo === 'm/a')
        .every((c) => c.provedoresPermitidos.join() === 'alfa'),
    ).toBe(true);
    expect(
      chamadas
        .filter((c) => c.modelo === 'm/b')
        .every((c) => c.provedoresPermitidos.join() === 'beta,gama'),
    ).toBe(true);
  });

  it('a conferência recebe o modelo e o provedor DEVOLVIDOS pela resposta, não o id pedido', async () => {
    const vistos: Array<[string | undefined, string | undefined]> = [];
    const r = await executarSonda({
      casos: casosSinteticos.slice(0, 1),
      modelos: ['m/pedido'],
      variantes: ['sem-titulos'],
      transporte: {
        nome: 'dublado',
        gerar: async (p) => ({
          ...(await transporteQueCita().gerar(p)),
          modeloResolvido: 'm/devolvido',
          provedor: 'Provedor X',
        }),
      },
      provedoresPermitidos: () => ['x'],
      parConfirmadoZdr: (modelo, provedor) => {
        vistos.push([modelo, provedor]);
        return modelo === 'm/pedido';
      },
      agora: () => 0,
    });
    expect(vistos).toEqual([['m/devolvido', 'Provedor X']]);
    expect(r.modelosProvedorNaoConfirmado).toEqual(['m/pedido']);
    expect(r.registros[0]).toMatchObject({
      estado: 'provedor_nao_confirmado',
      modeloResolvido: 'm/devolvido',
      provedor: 'Provedor X',
    });
  });
});

describe('calcularMetricas', () => {
  it('calcula p50/p95, custo, taxa de citação e usa o custo informado pelo OpenRouter quando há', async () => {
    let t = 0;
    const r = await executarSonda({
      casos: casosSinteticos.filter((c) => !c.injecao && c.id !== 's07-texto-curto'),
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte: transporteQueCita([], 0.002),
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: () => true,
      agora: () => (t += 100),
    });
    const [m] = calcularMetricas(
      r.registros,
      new Map([['m/x', { entrada: 1e-6, saida: 2e-6 }]]),
    );
    expect(m?.analises).toBe(10);
    expect(m?.taxaCitacaoVerificada).toBe(1);
    expect(m?.custoMedioUsd).toBeCloseTo(0.002);
    expect(m?.fonteDoCusto).toBe('openrouter');
    expect(m?.latenciaP50Ms).toBe(100);
    expect(m?.provedores).toEqual(['Provedor Dublado']);
  });

  it('sem custo na resposta, calcula pela tabela de preços por token', async () => {
    const transporte: TransporteDeModelo = {
      nome: 'dublado',
      gerar: async (p) => {
        const r = await transporteQueCita().gerar(p);
        const { custoUsd: _descartado, ...semCusto } = r;
        return semCusto;
      },
    };
    const r = await executarSonda({
      casos: casosSinteticos.slice(0, 2),
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte,
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    const [m] = calcularMetricas(
      r.registros,
      new Map([['m/x', { entrada: 1e-6, saida: 2e-6 }]]),
    );
    expect(m?.fonteDoCusto).toBe('estimativa');
    expect(m?.custoMedioUsd).toBeCloseTo(1000 * 1e-6 + 100 * 2e-6);
  });
});

describe('planilha e julgamento', () => {
  it('a planilha tem a coluna avaliacao vazia e nenhum dado pessoal nem número de processo', async () => {
    const r = await executarSonda({
      casos: casosSinteticos,
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte: transporteQueCita(),
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    const csv = gerarPlanilha(r.registros, { incluirSinteticos: true }) ?? '';
    expect(csv.split('\n')[0]).toBe('id;modelo;variante;resultado;avaliacao');
    expect(csv).not.toMatch(/1000001-12|Horácio|exemplo\.invalid|000\.000\.001/);
    const linhas = csv.trim().split('\n');
    expect(linhas.length).toBeGreaterThan(5);
  });

  const metricas = [
    {
      modelo: 'm/barato',
      variante: 'sem-titulos',
      taxaCitacaoVerificada: 0.97,
      custoMedioUsd: 0.001,
    },
    {
      modelo: 'm/caro',
      variante: 'sem-titulos',
      taxaCitacaoVerificada: 0.99,
      custoMedioUsd: 0.01,
    },
    {
      modelo: 'm/ruim',
      variante: 'sem-titulos',
      taxaCitacaoVerificada: 0.9,
      custoMedioUsd: 0.0001,
    },
  ] as never;

  function planilha(linhas: Array<[string, string]>): string {
    return (
      'id;modelo;variante;resultado;avaliacao\n' +
      linhas.map(([m, a], i) => `c${i};${m};sem-titulos;"x";${a}`).join('\n') +
      '\n'
    );
  }

  it('vence o mais barato que cumpre: zero perigoso, errado ≤ 10%, citações ≥ 95%', () => {
    const dez = (m: string, errados: number, perigosos = 0): Array<[string, string]> =>
      Array.from({ length: 10 }, (_, i) => [
        m,
        i < perigosos ? 'perigoso' : i < perigosos + errados ? 'errado' : 'util',
      ]);
    const j = calcularJulgamento(
      planilha([...dez('m/barato', 1), ...dez('m/caro', 0), ...dez('m/ruim', 0)]),
      metricas,
    );
    const por = Object.fromEntries(j.map((x) => [x.modelo, x]));
    expect(por['m/barato']?.cumpre).toBe(true);
    expect(por['m/ruim']?.cumpre).toBe(false);
    expect(por['m/ruim']?.motivos.join()).toMatch(/citações verificadas/);
    expect(escolherVencedor(j)?.modelo).toBe('m/barato');
  });

  it('um único "perigoso" reprova, e "errado" acima de 10% também', () => {
    const j = calcularJulgamento(
      planilha([
        ...Array.from({ length: 9 }, (): [string, string] => ['m/barato', 'util']),
        ['m/barato', 'perigoso'],
        ...Array.from({ length: 8 }, (): [string, string] => ['m/caro', 'util']),
        ['m/caro', 'errado'],
        ['m/caro', 'errado'],
      ]),
      metricas,
    );
    expect(j.find((x) => x.modelo === 'm/barato')?.cumpre).toBe(false);
    expect(j.find((x) => x.modelo === 'm/caro')?.cumpre).toBe(false);
    expect(escolherVencedor(j)).toBeUndefined();
  });

  it('linhas sem avaliação ficam pendentes; valor desconhecido é recusado citando a linha', () => {
    const j = calcularJulgamento(
      planilha([
        ['m/barato', 'util'],
        ['m/barato', ''],
      ]),
      metricas,
    );
    expect(j[0]).toMatchObject({ avaliados: 1, pendentes: 1 });
    expect(() =>
      calcularJulgamento(planilha([['m/barato', 'talvez']]), metricas),
    ).toThrow(/linha 2/);
  });
});

// --- o comando: chave, caminhos, nada gravado no repositório ---------------------

interface Gravacao {
  caminho: string;
  conteudo: string;
}

const MODELOS_ZDR = ['m/a', 'm/b', 'provedor/modelo-x', 'm/pequeno'];
const LISTA_ZDR: ListaZdrLida = {
  itensRecebidos: MODELOS_ZDR.length,
  camposDoPrimeiroItem: ['model_id', 'provider_name'],
  endpoints: MODELOS_ZDR.map((modelo) => ({
    modelo,
    provedor: 'Provedor Dublado',
    tag: 'dublado/fp8',
    precoEntrada: 0.000001,
    precoSaida: 0.000002,
  })),
};
const CHAVE = 'sk-or-chave-de-teste-minuscula-123';

function ambiente(
  sobrepor: Partial<AmbienteDaSonda> & { arquivos?: Record<string, string> } = {},
): {
  amb: AmbienteDaSonda;
  gravados: Gravacao[];
  saida: string[];
  avisos: string[];
  chamadas: PedidoAoModelo[];
  pedidosDeLista: string[];
} {
  const gravados: Gravacao[] = [];
  const saida: string[] = [];
  const avisos: string[] = [];
  const chamadas: PedidoAoModelo[] = [];
  const pedidosDeLista: string[] = [];
  const arquivos = sobrepor.arquivos ?? {};
  const amb: AmbienteDaSonda = {
    env: { OPENROUTER_API_KEY: CHAVE },
    raizDoRepositorio: '/repo',
    lerArquivo: async (c) => {
      if (c.endsWith('casos-sinteticos.json')) return SINTETICOS;
      const achou = arquivos[c];
      if (achou === undefined) throw new Error('arquivo inexistente');
      return achou;
    },
    lerStdin: async () =>
      'id;texto\nr1;Intime-se a parte autora para se manifestar sobre o laudo pericial juntado aos autos, no prazo legal.\n',
    gravarArquivo: async (caminho, conteudo) => {
      gravados.push({ caminho, conteudo });
    },
    existeArquivo: async () => false,
    criarTransporte: () => transporteQueCita(chamadas),
    buscarEndpointsZdr: async (chave) => {
      pedidosDeLista.push(chave);
      return LISTA_ZDR;
    },
    buscarEndpointsPublicosDoModelo: async () => [
      { provedor: 'Provedor Real', tag: 'real/bf16' },
    ],
    buscarModelosPublicos: async () => [
      { id: 'm/a' },
      { id: 'sem/zdr-caro', precoEntrada: 0.00005 },
      { id: 'sem/zdr-barato', precoEntrada: 0.000001 },
    ],
    hoje: () => '2026-10-10',
    hora: () => '0930',
    criarTransporteDeDiagnostico: () => {
      throw new Error('diagnóstico não dublado neste teste');
    },
    agora: () => 0,
    dormir: async () => undefined,
    saida: (l) => saida.push(l),
    aviso: (l) => avisos.push(l),
    ...sobrepor,
  };
  return { amb, gravados, saida, avisos, chamadas, pedidosDeLista };
}

describe('comando da sonda', () => {
  it('recusa rodar sem OPENROUTER_API_KEY, sem rede e sem chamar nada', async () => {
    const { amb, avisos, chamadas, pedidosDeLista } = ambiente({ env: {} });
    expect(await executarComandoSondaIa(['--modelos=m/a'], amb)).toBe(2);
    expect(avisos.join('\n')).toMatch(/OPENROUTER_API_KEY/);
    expect(chamadas).toHaveLength(0);
    expect(pedidosDeLista).toHaveLength(0);
  });

  it('recusa valor de exemplo e nunca imprime a chave', async () => {
    const exemplo = 'COLE_AQUI_A_CHAVE_DO_OPENROUTER';
    const { amb, avisos, saida, chamadas, pedidosDeLista } = ambiente({
      env: { OPENROUTER_API_KEY: exemplo },
    });
    expect(await executarComandoSondaIa(['--modelos=m/a'], amb)).toBe(2);
    expect([...avisos, ...saida].join('\n')).not.toContain(exemplo);
    expect(chamadas).toHaveLength(0);
    expect(pedidosDeLista).toHaveLength(0);
  });

  it('com chave válida, a chave nunca aparece na saída, nos arquivos gravados nem nos avisos', async () => {
    const { amb, avisos, saida, gravados } = ambiente();
    await executarComandoSondaIa(['--modelos=m/a', '--saida=/dados/sonda'], amb);
    await executarComandoSondaIa(['--listar-modelos-zdr'], amb);
    const tudo = [...avisos, ...saida, ...gravados.map((g) => g.conteudo)].join('\n');
    expect(tudo).not.toContain(CHAVE);
  });

  it.each(['~deepseek/deepseek-flash-latest', 'm/a:free', 'm/a:online'])(
    '--modelos recusa o apelido/variante "%s" sem enviar nada (mesmo que o resto esteja na lista)',
    async (apelido) => {
      const { amb, avisos, chamadas, gravados } = ambiente();
      expect(
        await executarComandoSondaIa(
          [`--modelos=m/a,${apelido}`, '--saida=/dados/sonda'],
          amb,
        ),
      ).toBe(2);
      expect(avisos.join('\n')).toMatch(/apelido \(~\) ou uma variante/);
      expect(chamadas).toHaveLength(0);
      expect(gravados).toHaveLength(0);
    },
  );

  it('sem --modelos não adivinha nome de modelo', async () => {
    const { amb, chamadas } = ambiente();
    expect(await executarComandoSondaIa(['--saida=/dados/sonda', '--stdin'], amb)).toBe(
      1,
    );
    expect(chamadas).toHaveLength(0);
  });

  describe('pré-checagem pela lista ZDR', () => {
    it('--listar-modelos-zdr imprime só ids, com filtro por texto, sem enviar caso algum', async () => {
      const { amb, saida, chamadas, pedidosDeLista } = ambiente();
      expect(await executarComandoSondaIa(['--listar-modelos-zdr=MODELO'], amb)).toBe(0);
      expect(saida).toEqual(['provedor/modelo-x']);
      expect(await executarComandoSondaIa(['--listar-modelos-zdr'], amb)).toBe(0);
      expect(saida.slice(1)).toEqual(['m/a', 'm/b', 'm/pequeno', 'provedor/modelo-x']);
      expect(chamadas).toHaveLength(0);
      expect(pedidosDeLista).toEqual([CHAVE, CHAVE]);
    });

    it('lista que veio mas sem os campos esperados: mostra só os NOMES dos campos e não segue', async () => {
      const { amb, avisos, saida } = ambiente({
        buscarEndpointsZdr: async () => ({
          itensRecebidos: 3,
          camposDoPrimeiroItem: ['fornecedor', 'identificador'],
          endpoints: [],
        }),
      });
      expect(await executarComandoSondaIa(['--listar-modelos-zdr'], amb)).toBe(2);
      expect(avisos.join('\n')).toContain('fornecedor, identificador');
      expect(saida).toEqual([]);
    });

    it('modelo fora da lista é RECUSADO com o motivo, e nada é enviado nem gravado', async () => {
      const { amb, avisos, chamadas, gravados } = ambiente();
      const codigo = await executarComandoSondaIa(
        ['--modelos=m/a,fab/sem-zdr', '--saida=/dados/sonda'],
        amb,
      );
      expect(codigo).toBe(2);
      expect(avisos.join('\n')).toMatch(/"fab\/sem-zdr" não tem nenhum endpoint com ZDR/);
      expect(chamadas).toHaveLength(0);
      expect(gravados).toHaveLength(0);
    });

    it('sem conseguir a lista (rede, chave recusada), a ZDR não pode ser confirmada: nada é enviado', async () => {
      const { amb, avisos, chamadas } = ambiente({
        buscarEndpointsZdr: async () => {
          throw new ProviderIndisponivelError(
            'openrouter',
            `chave recusada (HTTP 401) ${CHAVE}`,
          );
        },
      });
      expect(await executarComandoSondaIa(['--modelos=m/a'], amb)).toBe(2);
      expect(chamadas).toHaveLength(0);
      expect(avisos.join('\n')).not.toContain(CHAVE);
    });
  });

  it('--stdin com caso real: roda, grava planilha, métricas e metadados no volume e NADA no repositório', async () => {
    const { amb, gravados, chamadas } = ambiente();
    const codigo = await executarComandoSondaIa(
      ['--modelos=m/a,m/b', '--stdin', '--saida=/dados/sonda'],
      amb,
    );
    expect(codigo).toBe(0);
    expect(chamadas.length).toBeGreaterThan(0);
    expect(gravados.map((g) => g.caminho).sort()).toEqual([
      '/dados/sonda/chamadas-2026-10-10-0930.json',
      '/dados/sonda/metricas-2026-10-10-0930.json',
      '/dados/sonda/planilha-2026-10-10-0930.csv',
    ]);
    for (const g of gravados) expect(g.caminho.startsWith('/repo')).toBe(false);
    expect(gravados.map((g) => g.conteudo).join('\n')).not.toContain(
      'laudo pericial juntado aos autos',
    );
  });

  it('o metadado por chamada tem modelo, provedor, latência, tokens, custo e zdr_confirmado — e nenhum texto nem id de caso real', async () => {
    const { amb, gravados } = ambiente();
    await executarComandoSondaIa(
      ['--modelos=m/a', '--stdin', '--saida=/dados/sonda'],
      amb,
    );
    const arquivo = gravados.find((g) => g.caminho.includes('chamadas-'));
    const itens = JSON.parse(arquivo?.conteudo ?? '[]') as Array<Record<string, unknown>>;
    expect(itens.length).toBeGreaterThan(0);
    expect(Object.keys(itens[0] ?? {}).sort()).toEqual(
      [
        'camposDoUsage',
        'corpoEnviado',
        'custoUsd',
        'funilDoErro',
        'passoDoErro',
        'tokensRaciocinio',
        'estado',
        'latenciaMs',
        'modeloPedido',
        'modeloResolvido',
        'modelo',
        'ordem',
        'provedor',
        'provedoresPermitidos',
        'tokensEntrada',
        'tokensSaida',
        'variante',
        'zdrConfirmado',
      ].sort(),
    );
    expect(itens[0]).toMatchObject({
      modelo: 'm/a',
      modeloPedido: 'm/a',
      modeloResolvido: 'm/a',
      provedor: 'Provedor Dublado',
      provedoresPermitidos: ['dublado'],
      zdrConfirmado: 'sim',
    });
    expect(arquivo?.conteudo).not.toContain('r1');
  });

  it('--arquivo: lê do caminho informado, e recusa CSV de caso real dentro do repositório', async () => {
    const csv =
      'id;texto\nr1;Intime-se a parte autora para se manifestar sobre o laudo pericial juntado aos autos, no prazo legal.\n';
    const ok = ambiente({ arquivos: { '/dados/casos.csv': csv } });
    expect(
      await executarComandoSondaIa(
        ['--modelos=m/a', '--arquivo=/dados/casos.csv', '--saida=/dados/sonda'],
        ok.amb,
      ),
    ).toBe(0);
    expect(ok.gravados.every((g) => !g.caminho.startsWith('/repo'))).toBe(true);

    const dentro = ambiente({ arquivos: { '/repo/casos.csv': csv } });
    expect(
      await executarComandoSondaIa(
        ['--modelos=m/a', '--arquivo=/repo/casos.csv', '--saida=/dados/sonda'],
        dentro.amb,
      ),
    ).toBe(2);
    expect(dentro.chamadas).toHaveLength(0);
    expect(dentro.gravados).toHaveLength(0);
  });

  it('recusa pasta de saída dentro do repositório (exceto dados/, que é volume e está no .gitignore)', async () => {
    const a = ambiente();
    expect(
      await executarComandoSondaIa(
        ['--modelos=m/a', '--stdin', '--saida=/repo/relatorios'],
        a.amb,
      ),
    ).toBe(2);
    const b = ambiente();
    expect(
      await executarComandoSondaIa(
        ['--modelos=m/a', '--stdin', '--saida=/repo/dados/sonda'],
        b.amb,
      ),
    ).toBe(0);
  });

  it('só os casos sintéticos viram fixture no repositório (e com o nome do modelo e da data)', async () => {
    const { amb, gravados } = ambiente();
    await executarComandoSondaIa(
      [
        '--modelos=provedor/modelo-x',
        '--saida=/dados/sonda',
        '--fixtures=/repo/tests/fixtures/ia-ato',
      ],
      amb,
    );
    const fixture = gravados.find((g) => g.caminho.includes('respostas-'));
    expect(fixture?.caminho).toBe(
      '/repo/tests/fixtures/ia-ato/respostas-provedor__modelo-x-2026-10-10.json',
    );
    const dados = JSON.parse(fixture?.conteudo ?? '{}') as {
      respostas: Array<{ casoId: string; provedor: string; zdrConfirmado: boolean }>;
    };
    expect(dados.respostas.every((r) => r.casoId.startsWith('s'))).toBe(true);
    expect(
      dados.respostas.every((r) => r.provedor === 'Provedor Dublado' && r.zdrConfirmado),
    ).toBe(true);
  });

  it('--fixtures-saida manda as fixtures para outra pasta (o volume), e falha de gravação não derruba a rodada', async () => {
    const a = ambiente();
    await executarComandoSondaIa(
      ['--modelos=m/a', '--saida=/dados/sonda', '--fixtures-saida=/dados/sonda/fixtures'],
      a.amb,
    );
    expect(a.gravados.find((g) => g.caminho.includes('respostas-'))?.caminho).toBe(
      '/dados/sonda/fixtures/respostas-m__a-2026-10-10.json',
    );

    const gravados: string[] = [];
    const b = ambiente({
      gravarArquivo: async (caminho) => {
        if (caminho.includes('respostas-')) throw new Error('EACCES');
        gravados.push(caminho);
      },
    });
    expect(
      await executarComandoSondaIa(['--modelos=m/a', '--saida=/dados/sonda'], b.amb),
    ).toBe(0);
    expect(gravados.some((c) => c.includes('metricas-'))).toBe(true);
    expect(b.avisos.join('\n')).toMatch(/--fixtures-saida/);
  });

  it('caso real sem --com-sinteticos não grava fixture alguma', async () => {
    const { amb, gravados } = ambiente();
    await executarComandoSondaIa(
      ['--modelos=m/a', '--stdin', '--saida=/dados/sonda'],
      amb,
    );
    expect(
      gravados.some(
        (g) => g.caminho.includes('fixtures') || g.caminho.includes('respostas-'),
      ),
    ).toBe(false);
  });

  it('nenhum modelo com ZDR no OpenRouter: para (código 3) e avisa', async () => {
    const { amb, avisos } = ambiente({
      criarTransporte: () => ({
        nome: 'dublado',
        gerar: async (p) => {
          throw new ZdrIndisponivelError('dublado', p.modelo);
        },
      }),
    });
    expect(
      await executarComandoSondaIa(['--modelos=m/a,m/b', '--saida=/dados/sonda'], amb),
    ).toBe(3);
    expect(avisos.join('\n')).toMatch(
      /NENHUM dos modelos pôde ser usado com ZDR confirmada/,
    );
  });

  it('provedor fora da lista ZDR: resposta DESCARTADA, nada de planilha com ela, aviso de provedor não confirmado', async () => {
    const { amb, avisos, gravados } = ambiente({
      criarTransporte: () => ({
        nome: 'dublado',
        gerar: async (p) => ({
          ...(await transporteQueCita().gerar(p)),
          provedor: 'Provedor Intruso',
        }),
      }),
    });
    expect(
      await executarComandoSondaIa(
        ['--modelos=m/a', '--stdin', '--saida=/dados/sonda'],
        amb,
      ),
    ).toBe(3);
    expect(avisos.join('\n')).toMatch(/PROVEDOR NÃO CONFIRMADO ZDR/);
    const planilha = gravados.find((g) => g.caminho.endsWith('.csv'));
    expect(planilha).toBeUndefined();
  });

  it('--avaliacao julga a planilha preenchida sem precisar de chave', async () => {
    const planilha =
      'id;modelo;variante;resultado;avaliacao\nc1;m/a;sem-titulos;x;util\nc2;m/a;sem-titulos;x;util\n';
    const { amb, saida } = ambiente({
      env: {},
      arquivos: { '/dados/sonda/planilha.csv': planilha },
    });
    expect(
      await executarComandoSondaIa(
        ['--avaliacao=/dados/sonda/planilha.csv', '--saida=/dados/sonda'],
        amb,
      ),
    ).toBe(0);
    expect(saida.join('\n')).toMatch(/2 avaliados/);
  });

  describe('controles (uma chamada, texto sintético)', () => {
    /** Transporte que registra o pedido e devolve/lança o que o teste mandar. */
    const comTransporte = (
      gerar: TransporteDeModelo['gerar'],
      falhas: Array<{ status?: number; corpo?: string; corpoEnviado?: unknown }> = [],
      sobrepor: Partial<AmbienteDaSonda> = {},
    ) => {
      const pedidos: PedidoAoModelo[] = [];
      const t = ambiente({
        criarTransporte: (_chave, opcoes) => ({
          nome: 'dublado',
          gerar: async (p) => {
            pedidos.push(p);
            try {
              return await gerar(p);
            } catch (e) {
              for (const f of falhas) opcoes?.aoFalhar?.(f);
              throw e;
            }
          },
        }),
        ...sobrepor,
      });
      return { ...t, pedidos };
    };

    describe('positivo', () => {
      it('modelo COM ZDR responde e o par (modelo da resposta, provedor) está na lista: OK, com o rastro sem texto', async () => {
        const t = comTransporte(async (p) => transporteQueCita().gerar(p));
        expect(await executarComandoSondaIa(['--controle-positivo=m/a'], t.amb)).toBe(0);
        expect(t.pedidos).toHaveLength(1);
        expect(t.pedidos[0]?.provedoresPermitidos).toEqual(['dublado']);
        const tudo = t.saida.join('\n');
        expect(tudo).toMatch(/OK: respondeu/);
        expect(tudo).toContain('modelo pedido: m/a');
        expect(tudo).toContain('campo "model" da resposta: m/a');
        expect(tudo).toContain('campo "provider" da resposta: Provedor Dublado');
        expect(tudo).toContain('provider.only enviado: dublado');
        expect(tudo).not.toContain(CHAVE);
      });

      it('sem argumento escolhe o modelo mais barato COM ZDR e de id real', async () => {
        const t = comTransporte(async (p) => transporteQueCita().gerar(p));
        expect(await executarComandoSondaIa(['--controle-positivo'], t.amb)).toBe(0);
        expect(t.pedidos[0]?.modelo).toBe('m/a');
      });

      it('compara o PAR devolvido, não o id pedido: modelo resolvido fora da lista é BLOQUEANTE (código 6)', async () => {
        const t = comTransporte(async (p) => ({
          ...(await transporteQueCita().gerar(p)),
          modeloResolvido: 'outro/modelo-resolvido',
        }));
        expect(await executarComandoSondaIa(['--controle-positivo=m/a'], t.amb)).toBe(6);
        expect(t.saida.join('\n')).toMatch(/BLOQUEANTE/);
        expect(t.saida.join('\n')).toContain(
          'campo "model" da resposta: outro/modelo-resolvido',
        );
      });

      it('provedor da resposta fora da lista também é bloqueante', async () => {
        const t = comTransporte(async (p) => ({
          ...(await transporteQueCita().gerar(p)),
          provedor: 'Provedor Intruso',
        }));
        expect(await executarComandoSondaIa(['--controle-positivo=m/a'], t.amb)).toBe(6);
      });

      it.each(['~deepseek/deepseek-flash-latest', 'm/a:free'])(
        'recusa "%s" (apelido/variante) sem enviar nada',
        async (modelo) => {
          const t = comTransporte(async () => {
            throw new Error('não deveria chamar');
          });
          expect(
            await executarComandoSondaIa([`--controle-positivo=${modelo}`], t.amb),
          ).toBe(2);
          expect(t.pedidos).toHaveLength(0);
        },
      );

      it('recusa modelo que NÃO tem ZDR (é caso do controle negativo)', async () => {
        const t = comTransporte(async () => {
          throw new Error('não deveria chamar');
        });
        expect(
          await executarComandoSondaIa(['--controle-positivo=fab/sem-zdr'], t.amb),
        ).toBe(2);
        expect(t.pedidos).toHaveLength(0);
      });

      it('lista sem slug (tag) para o modelo: não dá para restringir, então não envia', async () => {
        const t = comTransporte(async (p) => transporteQueCita().gerar(p), [], {
          buscarEndpointsZdr: async () => ({
            itensRecebidos: 1,
            camposDoPrimeiroItem: [],
            endpoints: [{ modelo: 'm/a', provedor: 'Sem Tag', tag: '' }],
          }),
        });
        expect(await executarComandoSondaIa(['--controle-positivo=m/a'], t.amb)).toBe(2);
        expect(t.pedidos).toHaveLength(0);
      });

      it('erro: mostra status, corpo e corpo enviado saneado (código 5)', async () => {
        const t = comTransporte(async () => {
          throw new ProviderIndisponivelError(
            'dublado',
            'o OpenRouter respondeu HTTP 418',
          );
        }, [
          {
            status: 418,
            corpo: 'bule',
            corpoEnviado: {
              model: 'm/a',
              messages: [{ role: 'user', conteudo: '[omitido: 10 caracteres]' }],
            },
          },
        ]);
        expect(await executarComandoSondaIa(['--controle-positivo=m/a'], t.amb)).toBe(5);
        expect(t.saida.join('\n')).toContain('HTTP 418');
        expect(t.saida.join('\n')).toContain('[omitido: 10 caracteres]');
      });
    });

    describe('negativo', () => {
      it('modelo REAL sem ZDR: recusado antes de responder (código 0), restrito aos provedores reais, e mostra status e corpo', async () => {
        const t = comTransporte(
          async (p) => {
            throw new ZdrIndisponivelError('dublado', p.modelo);
          },
          [
            {
              status: 404,
              corpo: '{"error":{"message":"No endpoints found"}}',
              corpoEnviado: { provider: { zdr: true, only: ['real'] } },
            },
          ],
        );
        expect(await executarComandoSondaIa(['--controle-negativo'], t.amb)).toBe(0);
        expect(t.pedidos).toHaveLength(1);
        expect(t.pedidos[0]?.modelo).toBe('sem/zdr-barato');
        expect(t.pedidos[0]?.provedoresPermitidos).toEqual(['real']);
        const tudo = t.saida.join('\n');
        expect(tudo).toMatch(/RECUSADO ANTES DE RESPONDER/);
        expect(tudo).toContain('HTTP 404');
        expect(tudo).toContain('"zdr":true');
        expect(tudo).not.toContain(CHAVE);
      });

      it('nunca escolhe apelido (~) nem variante (:), mesmo que seja o mais barato fora da lista', async () => {
        const t = comTransporte(
          async (p) => {
            throw new ZdrIndisponivelError('dublado', p.modelo);
          },
          [],
          {
            buscarModelosPublicos: async () => [
              { id: '~deepseek/deepseek-flash-latest', precoEntrada: 0.0000001 },
              { id: 'fab/modelo:free', precoEntrada: 0.0000001 },
              { id: 'real/modelo-pago', precoEntrada: 0.000002 },
            ],
          },
        );
        await executarComandoSondaIa(['--controle-negativo'], t.amb);
        expect(t.pedidos.map((p) => p.modelo)).toEqual(['real/modelo-pago']);
      });

      it.each(['~deepseek/deepseek-flash-latest', 'fab/modelo:online'])(
        'recusa "%s" informado à mão, sem enviar nada',
        async (modelo) => {
          const t = comTransporte(async (p) => transporteQueCita().gerar(p));
          expect(
            await executarComandoSondaIa([`--controle-negativo=${modelo}`], t.amb),
          ).toBe(2);
          expect(t.pedidos).toHaveLength(0);
        },
      );

      it('recusa modelo que TEM ZDR: o controle não serviria', async () => {
        const t = comTransporte(async (p) => transporteQueCita().gerar(p));
        expect(await executarComandoSondaIa(['--controle-negativo=m/a'], t.amb)).toBe(2);
        expect(t.pedidos).toHaveLength(0);
      });

      it('sem conseguir os provedores reais do modelo, não envia', async () => {
        const t = comTransporte(async (p) => transporteQueCita().gerar(p), [], {
          buscarEndpointsPublicosDoModelo: async () => {
            throw new Error('formato');
          },
        });
        expect(
          await executarComandoSondaIa(['--controle-negativo=sem/zdr-barato'], t.amb),
        ).toBe(2);
        expect(t.pedidos).toHaveLength(0);
      });

      it('se o OpenRouter RESPONDER: BLOQUEANTE (código 6), com o rastro model/provider/corpo', async () => {
        const t = comTransporte(async (p) => ({
          ...(await transporteQueCita().gerar(p)),
          provedor: 'Morph',
          modeloResolvido: 'fab/resolvido',
        }));
        expect(
          await executarComandoSondaIa(['--controle-negativo=sem/zdr-barato'], t.amb),
        ).toBe(6);
        const tudo = t.saida.join('\n');
        expect(tudo).toMatch(/BLOQUEANTE: o OpenRouter RESPONDEU/);
        expect(tudo).toContain('campo "provider" da resposta: Morph');
        expect(tudo).toContain('campo "model" da resposta: fab/resolvido');
      });

      it('erro que não é reconhecido como recusa: registra status e corpo (código 5)', async () => {
        const t = comTransporte(async () => {
          throw new ProviderIndisponivelError(
            'dublado',
            'o OpenRouter respondeu HTTP 418',
          );
        }, [{ status: 418, corpo: 'bule' }]);
        expect(
          await executarComandoSondaIa(['--controle-negativo=sem/zdr-barato'], t.amb),
        ).toBe(5);
        expect(t.saida.join('\n')).toContain('HTTP 418');
      });
    });
  });
});

// --- v1.2.0: passo do erro, diagnóstico em degraus, latência, rodada ------------------

describe('passo do erro de roteamento (nunca chamar de "sem ZDR" o que não é)', () => {
  const semProvedor =
    (passo: string | undefined, funil: unknown) => async (p: PedidoAoModelo) => {
      if (p.modelo === 'm/a')
        throw new SemProvedorQueAtendaError('dublado', p.modelo, passo, funil);
      return transporteQueCita().gerar(p);
    };

  it('outro passo: diz "SEM PROVEDOR", NÃO "sem ZDR", e mostra failed_routing_step e routing_funnel', async () => {
    const { amb, avisos } = ambiente({
      criarTransporte: () => ({
        nome: 'dublado',
        gerar: semProvedor('parametros', { total: 3, apos_parametros: 0 }),
      }),
    });
    expect(
      await executarComandoSondaIa(
        ['--modelos=m/a,m/b', '--stdin', '--saida=/dados/sonda'],
        amb,
      ),
    ).toBe(0);
    const tudo = avisos.join('\n');
    expect(tudo).toMatch(/SEM PROVEDOR para "m\/a"/);
    expect(tudo).toMatch(/NÃO está provado que seja falta de ZDR/);
    expect(tudo).toContain('failed_routing_step: parametros');
    expect(tudo).toContain('routing_funnel: {"total":3,"apos_parametros":0}');
    expect(tudo).toContain('--diagnosticar-modelo=m/a');
    expect(tudo).not.toMatch(/SEM ZDR/);
  });

  it('passo ausente: diz "(não informado)" em vez de supor ZDR', async () => {
    const { amb, avisos } = ambiente({
      criarTransporte: () => ({
        nome: 'dublado',
        gerar: semProvedor(undefined, undefined),
      }),
    });
    await executarComandoSondaIa(
      ['--modelos=m/a,m/b', '--stdin', '--saida=/dados/sonda'],
      amb,
    );
    expect(avisos.join('\n')).toContain('failed_routing_step: (não informado)');
    expect(avisos.join('\n')).not.toMatch(/SEM ZDR/);
  });

  it('só o filtro de política de dados vira "SEM ZDR", sempre com o passo e o funil', async () => {
    const { amb, avisos } = ambiente({
      criarTransporte: () => ({
        nome: 'dublado',
        gerar: async (p) => {
          if (p.modelo === 'm/a')
            throw new ZdrIndisponivelError('dublado', p.modelo, 'data_policy', {
              total: 4,
              depois: 0,
            });
          return transporteQueCita().gerar(p);
        },
      }),
    });
    await executarComandoSondaIa(
      ['--modelos=m/a,m/b', '--stdin', '--saida=/dados/sonda'],
      amb,
    );
    const tudo = avisos.join('\n');
    expect(tudo).toMatch(
      /SEM ZDR \(o roteamento parou no filtro de política de dados\) para "m\/a"/,
    );
    expect(tudo).toContain('failed_routing_step: data_policy');
    expect(tudo).toContain('routing_funnel: {"total":4,"depois":0}');
  });

  it('o passo e o funil vão para o metadado da chamada', async () => {
    const { amb, gravados } = ambiente({
      criarTransporte: () => ({
        nome: 'dublado',
        gerar: semProvedor('parametros', { total: 3 }),
      }),
    });
    await executarComandoSondaIa(
      ['--modelos=m/a,m/b', '--stdin', '--saida=/dados/sonda'],
      amb,
    );
    const itens = JSON.parse(
      gravados.find((g) => g.caminho.includes('chamadas-'))?.conteudo ?? '[]',
    ) as Array<Record<string, unknown>>;
    expect(itens.find((i) => i['modelo'] === 'm/a')).toMatchObject({
      estado: 'sem_provedor',
      passoDoErro: 'parametros',
      funilDoErro: { total: 3 },
    });
  });

  it('todos parados (por qualquer motivo) = código 3', async () => {
    const { amb } = ambiente({
      criarTransporte: () => ({
        nome: 'dublado',
        gerar: async (p) => {
          throw new SemProvedorQueAtendaError('dublado', p.modelo, 'parametros');
        },
      }),
    });
    expect(
      await executarComandoSondaIa(
        ['--modelos=m/a,m/b', '--stdin', '--saida=/dados/sonda'],
        amb,
      ),
    ).toBe(3);
  });
});

describe('contabilidade da rodada (por que n não é o total de casos)', () => {
  it('n + sem texto + erros + inválidas + parados = casos; o texto curto não é chamado e erro não entra em n', async () => {
    let chamada = 0;
    const r = await executarSonda({
      casos: casosSinteticos,
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte: {
        nome: 'dublado',
        gerar: async (p) => {
          chamada += 1;
          if (chamada === 4)
            throw new ProviderIndisponivelError('dublado', 'tempo esgotado');
          return transporteQueCita().gerar(p);
        },
      },
      provedoresPermitidos: () => ['dublado'],
      parConfirmadoZdr: () => true,
      agora: () => 0,
    });
    const [m] = calcularMetricas(r.registros);
    expect(casosSinteticos).toHaveLength(12);
    expect(m).toMatchObject({
      analises: 10,
      semTexto: 1,
      erros: 1,
      respostasInvalidas: 0,
      interrompidos: 0,
    });
    expect((m?.analises ?? 0) + (m?.semTexto ?? 0) + (m?.erros ?? 0)).toBe(12);
  });

  it('a tabela mostra s/texto, erros, inválidas e parados ao lado de n', async () => {
    const { amb, saida } = ambiente();
    await executarComandoSondaIa(['--modelos=m/a', '--saida=/dados/sonda'], amb);
    const cabecalho = saida.find((l) => l.startsWith('modelo')) ?? '';
    for (const col of ['n ', 's/texto', 'erros', 'inválidas', 'parados'])
      expect(cabecalho).toContain(col);
  });
});

describe('rodada: planilha, métricas por sufixo e custo', () => {
  it('rodada SÓ sintética não gera planilha do Autran (e diz por quê)', async () => {
    const { amb, gravados, avisos } = ambiente();
    await executarComandoSondaIa(['--modelos=m/a', '--saida=/dados/sonda'], amb);
    expect(gravados.some((g) => g.caminho.endsWith('.csv'))).toBe(false);
    expect(avisos.join('\n')).toMatch(/Planilha do Autran NÃO gerada/);
    expect(
      gravados.some((g) => g.caminho === '/dados/sonda/metricas-2026-10-10-0930.json'),
    ).toBe(true);
  });

  it('rodada com caso real gera planilha e métricas com o MESMO sufixo (data-hora)', async () => {
    const { amb, gravados } = ambiente();
    await executarComandoSondaIa(
      ['--modelos=m/a', '--stdin', '--saida=/dados/sonda'],
      amb,
    );
    const nomes = gravados.map((g) => g.caminho.split('/').pop());
    expect(nomes).toContain('planilha-2026-10-10-0930.csv');
    expect(nomes).toContain('metricas-2026-10-10-0930.json');
  });

  it('--avaliacao lê as métricas do MESMO sufixo da planilha, não as de outra rodada', async () => {
    const planilha =
      'id;modelo;variante;resultado;avaliacao\nc1;m/a;sem-titulos;x;util\nc2;m/a;sem-titulos;x;util\n';
    const dela = JSON.stringify([
      {
        modelo: 'm/a',
        variante: 'sem-titulos',
        taxaCitacaoVerificada: 0.99,
        custoMedioUsd: 0.001,
      },
    ]);
    const deOutra = JSON.stringify([
      {
        modelo: 'm/a',
        variante: 'sem-titulos',
        taxaCitacaoVerificada: 0.2,
        custoMedioUsd: 0.001,
      },
    ]);
    const arquivos = {
      '/dados/sonda/planilha-2026-10-10-0930.csv': planilha,
      '/dados/sonda/metricas-2026-10-10-0930.json': dela,
      '/dados/sonda/metricas-2026-10-11-1500.json': deOutra,
      '/dados/sonda/metricas.json': deOutra,
    };
    const { amb, saida } = ambiente({
      env: {},
      arquivos,
      existeArquivo: async (c) => c in arquivos,
    });
    expect(
      await executarComandoSondaIa(
        ['--avaliacao=/dados/sonda/planilha-2026-10-10-0930.csv', '--saida=/dados/sonda'],
        amb,
      ),
    ).toBe(0);
    expect(saida.join('\n')).toMatch(/CUMPRE o critério/);
  });

  it('sem custo na resposta, estima pelo preço da lista pública e rotula "estimativa"', async () => {
    const { amb, saida } = ambiente({
      buscarEndpointsZdr: async () => ({
        itensRecebidos: 1,
        camposDoPrimeiroItem: [],
        endpoints: [
          { modelo: 'm/novo', provedor: 'Provedor Dublado', tag: 'dublado/fp8' },
        ],
      }),
      buscarModelosPublicos: async () => [
        { id: 'm/novo', precoEntrada: 0.000001, precoSaida: 0.000002 },
      ],
      criarTransporte: () => ({
        nome: 'dublado',
        gerar: async (p) => {
          const { custoUsd: _c, ...resto } = await transporteQueCita().gerar(p);
          return { ...resto, modeloResolvido: 'm/novo' };
        },
      }),
    });
    await executarComandoSondaIa(['--modelos=m/novo', '--saida=/dados/sonda'], amb);
    const tabela = saida.join('\n');
    expect(tabela).toMatch(/estimativa/);
    expect(tabela).not.toMatch(/Custo NÃO medido/);
  });

  it('sem custo na resposta e sem preço em lista alguma: diz "não medido" e aponta camposDoUsage', async () => {
    const { amb, saida } = ambiente({
      buscarEndpointsZdr: async () => ({
        itensRecebidos: 1,
        camposDoPrimeiroItem: [],
        endpoints: [
          { modelo: 'm/novo', provedor: 'Provedor Dublado', tag: 'dublado/fp8' },
        ],
      }),
      buscarModelosPublicos: async () => [],
      criarTransporte: () => ({
        nome: 'dublado',
        gerar: async (p) => {
          const { custoUsd: _c, ...resto } = await transporteQueCita().gerar(p);
          return { ...resto, modeloResolvido: 'm/novo' };
        },
      }),
    });
    await executarComandoSondaIa(['--modelos=m/novo', '--saida=/dados/sonda'], amb);
    expect(saida.join('\n')).toMatch(/Custo NÃO medido para m\/novo/);
    expect(saida.join('\n')).toMatch(/camposDoUsage/);
  });

  it('--raciocinio, --max-tokens e --timeout-ms chegam ao transporte da rodada; valores inválidos são recusados', async () => {
    const vistas: unknown[] = [];
    const { amb } = ambiente({
      criarTransporte: (_c, opcoes) => {
        vistas.push(opcoes);
        return transporteQueCita();
      },
    });
    await executarComandoSondaIa(
      [
        '--modelos=m/a',
        '--raciocinio=desligado',
        '--max-tokens=800',
        '--timeout-ms=90000',
        '--saida=/dados/sonda',
      ],
      amb,
    );
    expect(vistas[0]).toMatchObject({
      ajustes: { raciocinio: 'desligado', maxTokens: 800 },
      timeoutMs: 90000,
    });
    for (const ruim of ['--raciocinio=muito', '--max-tokens=3', '--timeout-ms=10']) {
      const t = ambiente();
      expect(await executarComandoSondaIa(['--modelos=m/a', ruim], t.amb)).toBe(1);
      expect(t.chamadas).toHaveLength(0);
    }
  });
});

describe('diagnóstico em degraus (--diagnosticar-modelo)', () => {
  type Passo = (p: PedidoAoModelo, degrau: Degrau) => Promise<RespostaDoTransporte>;
  const diag = (
    passo: Passo,
    falhas: Array<{ status?: number; corpo?: string }> = [],
  ) => {
    const chamadas: Array<{ degrau: Degrau; pedido: PedidoAoModelo }> = [];
    const t = ambiente({
      criarTransporteDeDiagnostico: (_c, opcoes): TransporteComDiagnostico => ({
        nome: 'dublado',
        gerar: async () => {
          throw new Error('o diagnóstico só usa gerarDiagnostico');
        },
        gerarDiagnostico: async (pedido, degrau) => {
          chamadas.push({ degrau, pedido });
          try {
            return await passo(pedido, degrau);
          } catch (e) {
            for (const f of falhas) opcoes?.aoFalhar?.(f);
            throw e;
          }
        },
      }),
    });
    return { ...t, degraus: chamadas };
  };
  const falhaPassos =
    (...degrausQueFalham: Degrau[]): Passo =>
    async (p, degrau) => {
      if (degrausQueFalham.includes(degrau)) {
        throw new SemProvedorQueAtendaError('dublado', p.modelo, `passo_${degrau}`, {
          total: 4,
          restantes: 0,
        });
      }
      return transporteQueCita().gerar(p);
    };

  it('para no PRIMEIRO degrau que responde e diz qual foi, o par e o passo dos que falharam', async () => {
    const t = diag(falhaPassos('A'));
    expect(await executarComandoSondaIa(['--diagnosticar-modelo=m/a'], t.amb)).toBe(0);
    expect(t.degraus.map((d) => d.degrau)).toEqual(['A', 'B']);
    const tudo = t.saida.join('\n');
    expect(tudo).toContain('Degrau A');
    expect(tudo).toContain('SEM PROVEDOR (NÃO é o filtro de política de dados)');
    expect(tudo).toContain('failed_routing_step: passo_A');
    expect(tudo).toContain('routing_funnel: {"total":4,"restantes":0}');
    expect(tudo).toContain('Funcionou no degrau B');
    expect(tudo).toContain('require_parameters');
    expect(tudo).toContain('campo "model" da resposta: m/a');
    expect(tudo).toContain('campo "provider" da resposta: Provedor Dublado');
    expect(tudo).toContain('par (model, provider) na lista ZDR: sim');
    expect(tudo).not.toContain(CHAVE);
  });

  it.each([
    [['A', 'B'] as Degrau[], 'C', /json_schema ESTRITO/],
    [['A', 'B', 'C'] as Degrau[], 'D', /provider\.only/],
  ])(
    'falhando %j, funciona em %s e explica a causa',
    async (falham, funcionou, causa) => {
      const t = diag(falhaPassos(...falham));
      expect(await executarComandoSondaIa(['--diagnosticar-modelo=m/a'], t.amb)).toBe(0);
      expect(t.degraus.at(-1)?.degrau).toBe(funcionou);
      expect(t.saida.join('\n')).toMatch(causa);
    },
  );

  it('degrau D com par FORA da lista é DESCARTADO (código 6)', async () => {
    const t = diag(async (p, degrau) => {
      if (degrau !== 'D') throw new SemProvedorQueAtendaError('dublado', p.modelo, 'x');
      return { ...(await transporteQueCita().gerar(p)), provedor: 'Provedor Intruso' };
    });
    expect(await executarComandoSondaIa(['--diagnosticar-modelo=m/a'], t.amb)).toBe(6);
    expect(t.saida.join('\n')).toMatch(/DESCARTADO/);
  });

  it('degrau D com par NA lista vale (código 0)', async () => {
    const t = diag(falhaPassos('A', 'B', 'C'));
    expect(await executarComandoSondaIa(['--diagnosticar-modelo=m/a'], t.amb)).toBe(0);
    expect(t.saida.join('\n')).toContain('par (model, provider) na lista ZDR: sim');
  });

  it('o par é o devolvido pela resposta: modelo resolvido fora da lista descarta mesmo antes do D', async () => {
    const t = diag(async (p) => ({
      ...(await transporteQueCita().gerar(p)),
      modeloResolvido: 'outro/resolvido',
    }));
    expect(await executarComandoSondaIa(['--diagnosticar-modelo=m/a'], t.amb)).toBe(6);
    expect(t.degraus.map((d) => d.degrau)).toEqual(['A']);
  });

  it('nenhum degrau responde: código 5, com o passo e o funil de CADA degrau', async () => {
    const t = diag(falhaPassos('A', 'B', 'C', 'D'), [
      { status: 404, corpo: '{"error":{"message":"x"}}' },
    ]);
    expect(await executarComandoSondaIa(['--diagnosticar-modelo=m/a'], t.amb)).toBe(5);
    const tudo = t.saida.join('\n');
    for (const d of ['A', 'B', 'C', 'D'])
      expect(tudo).toContain(`failed_routing_step: passo_${d}`);
    expect(tudo).toContain('HTTP 404');
  });

  it('só o filtro de política de dados é chamado de "SEM ZDR" no diagnóstico', async () => {
    const t = diag(async (p) => {
      throw new ZdrIndisponivelError('dublado', p.modelo, 'data_policy', { total: 2 });
    });
    await executarComandoSondaIa(['--diagnosticar-modelo=m/a'], t.amb);
    expect(t.saida.join('\n')).toMatch(
      /SEM ZDR \(o roteamento parou no filtro de política de dados\)/,
    );
  });

  it('todos os pedidos saem restritos aos provedores da lista; apelido, modelo sem ZDR e modelo vazio são recusados sem enviar', async () => {
    const t = diag(falhaPassos());
    await executarComandoSondaIa(['--diagnosticar-modelo=m/a'], t.amb);
    expect(t.degraus[0]?.pedido.provedoresPermitidos).toEqual(['dublado']);
    for (const ruim of [
      '~deepseek/deepseek-flash-latest',
      'm/a:free',
      'fab/sem-zdr',
      '',
    ]) {
      const x = diag(falhaPassos());
      expect(await executarComandoSondaIa([`--diagnosticar-modelo=${ruim}`], x.amb)).toBe(
        2,
      );
      expect(x.degraus).toHaveLength(0);
    }
  });
});

describe('medida de latência (--medir-latencia)', () => {
  const comAjustes = (
    gerar: (p: PedidoAoModelo, ajustes: unknown) => Promise<RespostaDoTransporte>,
  ) => {
    const usados: unknown[] = [];
    const t = ambiente({
      criarTransporte: (_c, opcoes) => ({
        nome: 'dublado',
        gerar: async (p) => {
          usados.push(opcoes?.ajustes ?? {});
          return gerar(p, opcoes?.ajustes);
        },
      }),
    });
    return { ...t, usados };
  };

  it('roda cada configuração (padrão, raciocínio em 4 níveis, max_tokens) e imprime p50/p95 e tokens de raciocínio', async () => {
    const t = comAjustes(async (p, ajustes) => ({
      ...(await transporteQueCita().gerar(p)),
      tokensSaida: (ajustes as { raciocinio?: string }).raciocinio ? 120 : 900,
      tokensRaciocinio: (ajustes as { raciocinio?: string }).raciocinio ? 0 : 800,
    }));
    expect(
      await executarComandoSondaIa(['--medir-latencia=m/a', '--repeticoes=2'], t.amb),
    ).toBe(0);
    expect(t.usados).toHaveLength(14);
    const tudo = t.saida.join('\n');
    for (const c of [
      'padrao',
      'raciocinio=desligado',
      'raciocinio=nenhum',
      'raciocinio=minimo',
      'raciocinio=baixo',
      'padrao+max_tokens=800',
      'desligado+max_tokens=800',
    ]) {
      expect(tudo).toContain(c);
    }
    expect(tudo).toMatch(/p50 ms/);
    expect(t.usados).toContainEqual({ raciocinio: 'desligado', maxTokens: 800 });
  });

  it('configuração que o modelo recusa aparece com o passo, sem derrubar a medida', async () => {
    const t = comAjustes(async (p, ajustes) => {
      if ((ajustes as { raciocinio?: string }).raciocinio === 'nenhum') {
        throw new SemProvedorQueAtendaError('dublado', p.modelo, 'parametros');
      }
      return transporteQueCita().gerar(p);
    });
    expect(
      await executarComandoSondaIa(['--medir-latencia=m/a', '--repeticoes=1'], t.amb),
    ).toBe(0);
    expect(t.saida.join('\n')).toContain('passo parametros');
  });

  it('par fora da lista em qualquer configuração: BLOQUEANTE (código 6) e a medida para', async () => {
    const t = comAjustes(async (p) => ({
      ...(await transporteQueCita().gerar(p)),
      provedor: 'Provedor Intruso',
    }));
    expect(
      await executarComandoSondaIa(['--medir-latencia=m/a', '--repeticoes=1'], t.amb),
    ).toBe(6);
    expect(t.usados).toHaveLength(1);
  });

  it('toda chamada sai restrita aos provedores da lista; apelido e modelo sem ZDR são recusados sem enviar', async () => {
    const t = comAjustes(async (p) => {
      expect(p.provedoresPermitidos).toEqual(['dublado']);
      return transporteQueCita().gerar(p);
    });
    await executarComandoSondaIa(['--medir-latencia=m/a', '--repeticoes=1'], t.amb);
    for (const ruim of ['~x/y-latest', 'fab/sem-zdr']) {
      const x = comAjustes(async (p) => transporteQueCita().gerar(p));
      expect(await executarComandoSondaIa([`--medir-latencia=${ruim}`], x.amb)).toBe(2);
      expect(x.usados).toHaveLength(0);
    }
  });
});
