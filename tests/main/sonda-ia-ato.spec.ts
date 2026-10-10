import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProviderIndisponivelError,
  ZdrIndisponivelError,
} from '../../src/domain/errors/index.js';
import type {
  PedidoAoModelo,
  RespostaDoTransporte,
  TransporteDeModelo,
} from '../../src/infrastructure/adapters/modelo/TransporteGateway.js';
import { lerCasosCsv, lerCasosSinteticos } from '../../src/main/sonda/casosDaSonda.js';
import {
  executarComandoSondaIa,
  type AmbienteDaSonda,
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
        roteamento: { provedorFinal: 'provedor-dublado' },
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
        return { objeto: { qualquer: 'coisa' }, roteamento: {} };
      },
    };
    const r = await executarSonda({
      casos: casosSinteticos.slice(0, 1),
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte,
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
        roteamento: {},
      }),
    };
    const r = await executarSonda({
      casos: caso ? [caso] : [],
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte: obediente,
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
      agora: () => 0,
    });
    expect(r.registros.find((x) => x.origem === 'real')?.respostaCrua).toBeUndefined();
    expect(r.registros.find((x) => x.origem === 'sintetico')?.respostaCrua).toBeDefined();
  });
});

describe('calcularMetricas', () => {
  it('calcula p50/p95, custo, taxa de citação e usa o custo do gateway quando há', async () => {
    let t = 0;
    const r = await executarSonda({
      casos: casosSinteticos.filter((c) => !c.injecao && c.id !== 's07-texto-curto'),
      modelos: ['m/x'],
      variantes: ['sem-titulos'],
      transporte: transporteQueCita([], 0.002),
      agora: () => (t += 100),
    });
    const [m] = calcularMetricas(
      r.registros,
      new Map([['m/x', { entrada: 1e-6, saida: 2e-6 }]]),
    );
    expect(m?.analises).toBe(10);
    expect(m?.taxaCitacaoVerificada).toBe(1);
    expect(m?.custoMedioUsd).toBeCloseTo(0.002);
    expect(m?.fonteDoCusto).toBe('gateway');
    expect(m?.latenciaP50Ms).toBe(100);
    expect(m?.provedores).toEqual(['provedor-dublado']);
  });

  it('sem custo no gateway, calcula pela tabela de preços por token', async () => {
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
      agora: () => 0,
    });
    const [m] = calcularMetricas(
      r.registros,
      new Map([['m/x', { entrada: 1e-6, saida: 2e-6 }]]),
    );
    expect(m?.fonteDoCusto).toBe('tabela-de-precos');
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
      agora: () => 0,
    });
    const csv = gerarPlanilha(r.registros);
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

function ambiente(
  sobrepor: Partial<AmbienteDaSonda> & { arquivos?: Record<string, string> } = {},
): {
  amb: AmbienteDaSonda;
  gravados: Gravacao[];
  saida: string[];
  avisos: string[];
  chamadas: PedidoAoModelo[];
} {
  const gravados: Gravacao[] = [];
  const saida: string[] = [];
  const avisos: string[] = [];
  const chamadas: PedidoAoModelo[] = [];
  const arquivos = sobrepor.arquivos ?? {};
  const amb: AmbienteDaSonda = {
    env: { AI_GATEWAY_API_KEY: 'chave-de-teste-minuscula-123' },
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
    precosDoCatalogo: async () => new Map(),
    hoje: () => '2026-10-10',
    agora: () => 0,
    dormir: async () => undefined,
    saida: (l) => saida.push(l),
    aviso: (l) => avisos.push(l),
    ...sobrepor,
  };
  return { amb, gravados, saida, avisos, chamadas };
}

describe('comando da sonda', () => {
  it('recusa rodar sem AI_GATEWAY_API_KEY, sem chamar nada', async () => {
    const { amb, avisos, chamadas } = ambiente({ env: {} });
    expect(await executarComandoSondaIa(['--modelos=a'], amb)).toBe(2);
    expect(avisos.join('\n')).toMatch(/AI_GATEWAY_API_KEY/);
    expect(chamadas).toHaveLength(0);
  });

  it('recusa valor de exemplo e nunca imprime a chave', async () => {
    const exemplo = 'COLE_AQUI_A_CHAVE_DO_GATEWAY';
    const { amb, avisos, saida, chamadas } = ambiente({
      env: { AI_GATEWAY_API_KEY: exemplo },
    });
    expect(await executarComandoSondaIa(['--modelos=a'], amb)).toBe(2);
    expect([...avisos, ...saida].join('\n')).not.toContain(exemplo);
    expect(chamadas).toHaveLength(0);
  });

  it('com chave válida nunca a imprime', async () => {
    const { amb, avisos, saida } = ambiente();
    await executarComandoSondaIa(['--modelos=a', '--saida=/dados/sonda'], amb);
    expect([...avisos, ...saida].join('\n')).not.toContain(
      'chave-de-teste-minuscula-123',
    );
  });

  it('sem --modelos não adivinha nome de modelo', async () => {
    const { amb, chamadas } = ambiente();
    expect(await executarComandoSondaIa(['--saida=/dados/sonda', '--stdin'], amb)).toBe(
      1,
    );
    expect(chamadas).toHaveLength(0);
  });

  it('--stdin com caso real: roda, grava planilha e métricas no volume e NADA no repositório', async () => {
    const { amb, gravados, chamadas } = ambiente();
    const codigo = await executarComandoSondaIa(
      ['--modelos=m/a,m/b', '--stdin', '--saida=/dados/sonda'],
      amb,
    );
    expect(codigo).toBe(0);
    expect(chamadas.length).toBeGreaterThan(0);
    expect(gravados.map((g) => g.caminho).sort()).toEqual([
      '/dados/sonda/metricas.json',
      '/dados/sonda/planilha-2026-10-10.csv',
    ]);
    for (const g of gravados) expect(g.caminho.startsWith('/repo')).toBe(false);
    // O texto do caso real não vai para a planilha nem para as métricas.
    expect(gravados.map((g) => g.conteudo).join('\n')).not.toContain(
      'laudo pericial juntado aos autos',
    );
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
      respostas: Array<{ casoId: string }>;
    };
    expect(dados.respostas.every((r) => r.casoId.startsWith('s'))).toBe(true);
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

  it('nenhum modelo com ZDR: para (código 3) e avisa', async () => {
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
    expect(avisos.join('\n')).toMatch(/NENHUM dos modelos tem provedor com ZDR/);
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
});
