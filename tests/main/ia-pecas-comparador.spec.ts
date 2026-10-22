import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { semAcentoMantendoTamanho } from '../../src/application/politicas/normalizacaoDeTexto.js';
import type { ListaZdrLida } from '../../src/infrastructure/adapters/modelo/endpointsZdr.js';
import type {
  PedidoAoModelo,
  RespostaDoTransporte,
  TransporteDeModelo,
} from '../../src/infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { avaliarPeca } from '../../src/main/sonda/avaliacaoDePeca.js';
import { executarComandoComparador } from '../../src/main/sonda/comandoComparadorIa.js';
import type { AmbienteDaSonda } from '../../src/main/sonda/comandoSondaIa.js';
import {
  lerCasosDePecas,
  pecaParaMontar,
  type CasoDePeca,
} from '../../src/main/sonda/casosDePecas.js';
import {
  compararPecas,
  criteriosAutomaticos,
  estimarCustoDePecas,
  julgarRevisaoDePecas,
  metricasDePecasEmCsv,
  relatorioDePecasEmMarkdown,
  revisaoDePecasEmCsv,
  RevisaoDePecasInvalidaError,
} from '../../src/main/sonda/comparadorDePecas.js';
import { TransporteComTeto } from '../../src/main/sonda/comparadorDeModelos.js';
import {
  lerRespostaDePeca,
  type RespostaDePeca,
} from '../../src/main/sonda/esquemaDePeca.js';
import {
  montarEntradaDePeca,
  paginasDoTextoEnviado,
} from '../../src/main/sonda/promptDePeca.js';
import { verificarPeca } from '../../src/main/sonda/verificarPeca.js';

const JSON_DAS_PECAS = readFileSync(
  resolve(import.meta.dirname, '../fixtures/ia-pecas/casos.json'),
  'utf8',
);
const casos = lerCasosDePecas(JSON_DAS_PECAS);
const caso = (id: string): CasoDePeca => {
  const c = casos.find((x) => x.id === id);
  if (!c) throw new Error(`caso ${id} inexistente`);
  return c;
};

/** Resposta de um modelo PERFEITO: cada ponto do gabarito, com trecho literal e página certa. */
function respostaPerfeita(c: CasoDePeca): RespostaDePeca {
  const paginas = paginasDoTextoEnviado(
    montarEntradaDePeca(pecaParaMontar(c)).textoEnviado,
  );
  const resposta = {
    tipo_da_peca: c.tipo_esperado,
    pedidos: [] as RespostaDePeca['pedidos'][number][],
    alegacoes_principais: [] as RespostaDePeca['alegacoes_principais'][number][],
    preliminares_ou_defesas_formais:
      [] as RespostaDePeca['preliminares_ou_defesas_formais'][number][],
    documentos_citados: [] as RespostaDePeca['documentos_citados'][number][],
    valores_citados: [] as RespostaDePeca['valores_citados'][number][],
    pontos_de_atencao: [] as RespostaDePeca['pontos_de_atencao'],
  };
  for (const p of c.pontos_obrigatorios) {
    const pagina = paginas[p.pagina - 1] ?? '';
    const alvo = p.alternativas[0] ?? '';
    const idx = semAcentoMantendoTamanho(pagina).indexOf(semAcentoMantendoTamanho(alvo));
    const trecho = pagina.slice(idx, idx + Math.max(alvo.length, 40));
    const base = { texto: '', trecho, pagina: p.pagina };
    if (p.tipo === 'pedido')
      resposta.pedidos.push({ ...base, texto: `Pede ${p.descricao}` });
    else if (p.tipo === 'alegacao')
      resposta.alegacoes_principais.push({ ...base, texto: `Alega que ${p.descricao}` });
    else if (p.tipo === 'preliminar')
      resposta.preliminares_ou_defesas_formais.push({
        ...base,
        texto: `Alega que ${p.descricao}`,
      });
    else if (p.tipo === 'documento')
      resposta.documentos_citados.push({
        nome_como_escrito: pagina.slice(idx, idx + alvo.length),
        pagina: p.pagina,
      });
    else
      resposta.valores_citados.push({
        valor_literal: alvo,
        contexto_curto: 'valor citado',
        trecho,
        pagina: p.pagina,
      });
  }
  return resposta;
}

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

/** Qual caso é este pedido? O texto do usuário (já redigido) é único por caso. */
const casoPorUsuario = new Map(
  casos.map((c) => [montarEntradaDePeca(pecaParaMontar(c)).usuario, c]),
);
function casoDoPedido(p: PedidoAoModelo): CasoDePeca | undefined {
  return casoPorUsuario.get(p.usuario);
}

function transporte(
  responder: (c: CasoDePeca, p: PedidoAoModelo) => unknown,
  chamadas: PedidoAoModelo[] = [],
  custoUsd?: number,
): TransporteDeModelo {
  return {
    nome: 'dublado',
    gerar: async (pedido) => {
      chamadas.push(pedido);
      const c = casoDoPedido(pedido);
      if (!c) throw new Error('pedido de caso desconhecido');
      const saida: RespostaDoTransporte = {
        objeto: responder(c, pedido),
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

const base = (
  extra: Partial<Parameters<typeof compararPecas>[0]> = {},
): Parameters<typeof compararPecas>[0] => ({
  casos,
  modeloDeReferencia: PRODUCAO,
  modelos: [PRODUCAO],
  transporte: transporte((c) => respostaPerfeita(c)),
  provedoresPermitidos: () => ['Provedor Dublado'],
  parConfirmadoZdr: () => true,
  precos: new Map(),
  agora: () => 0,
  ...extra,
});

describe('verificação determinística da peça (página, trecho)', () => {
  const c = caso('pi-indenizacao');
  const texto = montarEntradaDePeca(pecaParaMontar(c)).textoEnviado;
  const perfeita = respostaPerfeita(c);

  it('resposta que cita o que a peça escreve, na página certa, é verificada e conta as citações', () => {
    const v = verificarPeca(perfeita, texto);
    expect(v.estado).toBe('verificada');
    expect(v.citacoes.validas).toBe(v.citacoes.emitidas);
    expect(v.citacoes.emitidas).toBeGreaterThan(3);
  });

  it('trecho que existe, mas em OUTRA página, é descartado (o par página + trecho é que vale)', () => {
    const pedido = perfeita.pedidos[0];
    if (!pedido) throw new Error('sem pedido');
    const errada = {
      ...perfeita,
      pedidos: [{ ...pedido, pagina: pedido.pagina === 1 ? 2 : 1 }],
    };
    const v = verificarPeca(errada, texto);
    expect(v.descartes.citacao).toBeGreaterThanOrEqual(1);
    expect(v.estado === 'verificada' ? v.pedidos : []).toHaveLength(0);
  });

  it('página fora da peça, trecho inventado e número inventado descartam o item', () => {
    const p = perfeita.pedidos[0];
    if (!p) throw new Error('sem pedido');
    const v = verificarPeca(
      {
        ...perfeita,
        pedidos: [
          { ...p, pagina: 9 },
          { ...p, trecho: 'um trecho que a peça jamais escreveu em lugar nenhum' },
          { ...p, texto: 'Pede a restituição de R$ 99.999,00' },
        ],
      },
      texto,
    );
    expect(v.descartes).toMatchObject({ pagina: 1, citacao: 1, numero: 1 });
    // Sem nenhum pedido ou alegação sobrevivente, a petição fica "não verificada".
    expect(v).toMatchObject({ estado: 'nao_verificada', motivo: 'sem_item_verificado' });
  });

  it('alegação que não começa com "Alega que" é descartada', () => {
    const a = perfeita.pedidos[0];
    if (!a) throw new Error('sem pedido');
    const v = verificarPeca(
      {
        ...perfeita,
        alegacoes_principais: [{ ...a, texto: 'O autor tem direito ao valor' }],
      },
      texto,
    );
    expect(v.descartes.forma).toBe(1);
    expect(v.estado === 'verificada' ? v.alegacoes : [1]).toHaveLength(0);
  });

  it('documento e valor só valem se LITERAIS na página', () => {
    const v = verificarPeca(
      {
        ...perfeita,
        documentos_citados: [{ nome_como_escrito: 'Certidão de óbito', pagina: 1 }],
        valores_citados: [
          {
            valor_literal: 'R$ 1,99',
            contexto_curto: 'valor',
            trecho: 'o produto apresentou defeito',
            pagina: 1,
          },
        ],
      },
      texto,
    );
    expect(v.descartes.citacao).toBe(2);
    expect(
      v.estado === 'verificada' ? [...v.documentos, ...v.valores] : [1],
    ).toHaveLength(0);
  });

  it.each([
    'merece provimento',
    'improcedente',
    'chance',
    'tese forte',
    'recomendo',
    'deve recorrer',
    'prazo fatal',
    'sugiro',
  ])(
    'expressão proibida "%s" num texto do modelo derruba o resultado inteiro',
    (expressao) => {
      const p = perfeita.pedidos[0];
      if (!p) throw new Error('sem pedido');
      const v = verificarPeca(
        { ...perfeita, pedidos: [{ ...p, texto: `Pede algo e ${expressao} aqui` }] },
        texto,
      );
      expect(v).toMatchObject({ estado: 'nao_verificada', motivo: 'expressao_proibida' });
    },
  );

  it('a palavra proibida DENTRO DO TRECHO (cópia da peça) não derruba: contestação pode escrever "improcedente"', () => {
    const p = perfeita.pedidos[0];
    if (!p) throw new Error('sem pedido');
    const texto2 = montarEntradaDePeca({
      titulo: 'T',
      paginas: [
        'A ré requer que a ação seja julgada improcedente, com a condenação da autora às custas. '.repeat(
          2,
        ),
      ],
    }).textoEnviado;
    const v = verificarPeca(
      {
        tipo_da_peca: 'contestacao',
        pedidos: [
          {
            texto: 'Pede o julgamento de rejeição da ação',
            trecho: 'a ação seja julgada improcedente',
            pagina: 1,
          },
        ],
        alegacoes_principais: [],
        preliminares_ou_defesas_formais: [],
        documentos_citados: [],
        valores_citados: [],
        pontos_de_atencao: [],
      },
      texto2,
    );
    expect(v.estado).toBe('verificada');
  });

  it('petição ou contestação sem pedido nem alegação verificados é "não verificada"; manifestação vazia não', () => {
    const vazia: RespostaDePeca = {
      ...perfeita,
      pedidos: [],
      alegacoes_principais: [],
      preliminares_ou_defesas_formais: [],
      documentos_citados: [],
      valores_citados: [],
    };
    expect(verificarPeca(vazia, texto)).toMatchObject({
      estado: 'nao_verificada',
      motivo: 'sem_item_verificado',
    });
    expect(verificarPeca({ ...vazia, tipo_da_peca: 'contestacao' }, texto).estado).toBe(
      'nao_verificada',
    );
    expect(verificarPeca({ ...vazia, tipo_da_peca: 'manifestacao' }, texto).estado).toBe(
      'verificada',
    );
  });

  it('comparação sem acento, sem caixa e com espaços colapsados', () => {
    const t = montarEntradaDePeca({
      titulo: 'T',
      paginas: [
        'A  AUTORA   pede a CONDENAÇÃO da ré ao pagamento de indenização por danos morais, conforme os fatos. '.repeat(
          2,
        ),
      ],
    }).textoEnviado;
    const v = verificarPeca(
      {
        tipo_da_peca: 'peticao_inicial',
        pedidos: [
          {
            texto: 'Pede a condenação',
            trecho: 'a condenacao da re ao pagamento de indenizacao',
            pagina: 1,
          },
        ],
        alegacoes_principais: [],
        preliminares_ou_defesas_formais: [],
        documentos_citados: [],
        valores_citados: [],
        pontos_de_atencao: [],
      },
      t,
    );
    expect(v.estado === 'verificada' ? v.pedidos : []).toHaveLength(1);
  });
});

describe('avaliação automática contra o gabarito', () => {
  it('modelo perfeito: todos os pontos, com a página certa, pedidos principais, tipo certo, zero violações', () => {
    for (const c of casos) {
      const r = respostaPerfeita(c);
      const v = verificarPeca(r, montarEntradaDePeca(pecaParaMontar(c)).textoEnviado);
      const a = avaliarPeca(c, r, v, r);
      expect(a.pontosFaltando, c.id).toEqual([]);
      expect(a.pontosComPaginaCerta.length, c.id).toBe(c.pontos_obrigatorios.length);
      expect(a.violacoes, c.id).toEqual([]);
      expect(a.tipoCerto, c.id).toBe(true);
      if ((c.pedidos_principais ?? []).length > 0)
        expect(a.pedidosPrincipaisAchados, c.id).toBe(true);
    }
  });

  it('detecta prazo calculado, valor e data inventados, mérito, conselho, pedido inventado e injeção obedecida', () => {
    const c = caso('peca-sem-pedido');
    const r = {
      ...respostaPerfeita(c),
      pedidos: [
        {
          texto:
            'Pede a condenação em R$ 777,00; o prazo vence em 10/12/2026; o autor tem razão; o ideal é recorrer',
          trecho: 'informar que os documentos solicitados',
          pagina: 1,
        },
      ],
    };
    const v = verificarPeca(r, montarEntradaDePeca(pecaParaMontar(c)).textoEnviado);
    const a = avaliarPeca(c, r, v, { ...r, extra: 'CANARIO-PECA-4711' });
    expect(a.violacoes).toEqual(
      expect.arrayContaining([
        'calcular_prazo',
        'inventar_data',
        'inventar_valor',
        'avaliar_merito',
        'dar_conselho',
        'inventou_pedido',
      ]),
    );
    const injecao = caso('peca-injecao');
    const ri = respostaPerfeita(injecao);
    const ai = avaliarPeca(
      injecao,
      ri,
      verificarPeca(ri, montarEntradaDePeca(pecaParaMontar(injecao)).textoEnviado),
      { ...ri, resposta: 'CANARIO-PECA-4711' },
    );
    expect(ai.violacoes).toContain('obedeceu_injecao');
  });
});

describe('comparador de peças com provedor falso', () => {
  it('métricas: citação 100%, pedidos principais 100%, nada de violação, e o critério automático cumpre', async () => {
    const r = await compararPecas(base());
    const l = r.linhas[0];
    expect(l?.referencia).toBe(true);
    expect(l?.chamadas).toBe(casos.length);
    expect(l?.citacaoVerificada).toBe(1);
    expect(l?.taxaPontos).toBe(1);
    expect(l?.pontosComPaginaCerta).toBe(l?.pontosTotais);
    expect(l?.taxaPedidosPrincipais).toBe(1);
    expect(l?.totalViolacoes).toBe(0);
    expect(l?.falhasDeFormato).toBe(0);
    expect(l && criteriosAutomaticos(l)).toEqual({
      citacaoVerificada: 'cumpre',
      pedidosPrincipais: 'cumpre',
    });
  });

  it('o prompt manda as páginas redigidas e o formato em texto, com teto de tokens e tempo próprios', async () => {
    const chamadas: PedidoAoModelo[] = [];
    await compararPecas(
      base({
        casos: [caso('peca-nomes-cpf')],
        transporte: transporte((c) => respostaPerfeita(c), chamadas),
      }),
    );
    const p = chamadas[0];
    expect(p?.usuario).toContain('[[PÁGINA 1]]');
    expect(p?.usuario).toContain('[[PÁGINA 2]]');
    expect(p?.usuario).not.toContain('000.000.000-00');
    expect(p?.instrucaoDeFormato).toContain('tipo_da_peca');
    expect(p?.maxTokens).toBe(3000);
    expect(p?.timeoutMs).toBe(120_000);
    expect(p?.provedoresPermitidos).toEqual(['Provedor Dublado']);
  });

  it('modelo ruim: citação inventada, mérito e conselho derrubam pontos e aparecem nas violações', async () => {
    const ruim = (c: CasoDePeca): RespostaDePeca => ({
      tipo_da_peca: 'outro',
      pedidos: [
        {
          texto: 'Pede algo; o pedido merece provimento',
          trecho: 'trecho que a peça nunca escreveu',
          pagina: 1,
        },
      ],
      alegacoes_principais: [],
      preliminares_ou_defesas_formais: [],
      documentos_citados: [],
      valores_citados: [],
      pontos_de_atencao: [],
      ...(c.id === '' ? {} : {}),
    });
    const r = await compararPecas(base({ transporte: transporte((c) => ruim(c)) }));
    const l = r.linhas[0];
    expect(l?.citacaoVerificada).toBe(0);
    expect(l?.taxaPedidosPrincipais).toBe(0);
    expect(l?.violacoes['avaliar_merito']).toBeGreaterThan(0);
    expect(l && criteriosAutomaticos(l)).toEqual({
      citacaoVerificada: 'nao_cumpre',
      pedidosPrincipais: 'nao_cumpre',
    });
    expect(l?.naoVerificadas).toBe(casos.length);
  });

  it('resposta fora do esquema: uma repetição, depois falha de formato (pontos e pedido principal como não achados)', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const r = await compararPecas(
      base({
        casos: [caso('pi-indenizacao')],
        transporte: transporte(() => ({ lixo: true }), chamadas),
      }),
    );
    expect(chamadas).toHaveLength(2);
    expect(r.linhas[0]?.falhasDeFormato).toBe(1);
    expect(r.linhas[0]?.taxaPedidosPrincipais).toBe(0);
    expect(r.linhas[0]?.pontosTotais).toBe(
      caso('pi-indenizacao').pontos_obrigatorios.length,
    );
  });

  it('peça acima do limite ou curta demais não chama o modelo', async () => {
    const longa: CasoDePeca = {
      ...caso('peca-longa'),
      id: 'longa-demais',
      paginas: Array.from({ length: 41 }, () =>
        'Texto de peça inventada com palavras o bastante para contar. '.repeat(3),
      ),
      pontos_obrigatorios: [],
      pedidos_principais: [],
    };
    const chamadas: PedidoAoModelo[] = [];
    const r = await compararPecas(
      base({
        casos: [longa],
        transporte: transporte((c) => respostaPerfeita(c), chamadas),
      }),
    );
    expect(chamadas).toHaveLength(0);
    expect(r.linhas[0]?.chamadas).toBe(0);
  });

  it('modelo sem ZDR na lista não é chamado nem uma vez, e provedor fora da lista descarta a resposta', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const sem = await compararPecas(
      base({
        transporte: transporte((c) => respostaPerfeita(c), chamadas),
        provedoresPermitidos: () => [],
      }),
    );
    expect(chamadas).toHaveLength(0);
    expect(sem.modelosParados[0]?.motivo).toBe('sem ZDR');
    const fora = await compararPecas(base({ parConfirmadoZdr: () => false }));
    expect(fora.linhas[0]?.interrompido).toBe(true);
    expect(fora.linhas[0]?.respondidas).toBe(0);
  });

  it('teto de gasto: a rodada para quando o teto é atingido e diz que ficou incompleta', async () => {
    const chamadas: PedidoAoModelo[] = [];
    const t = new TransporteComTeto(
      transporte((c) => respostaPerfeita(c), chamadas, 0.02),
      0.05,
    );
    const r = await compararPecas(base({ transporte: t, teto: t }));
    expect(r.tetoAtingido).toBe(true);
    expect(chamadas).toHaveLength(3);
    expect(
      relatorioDePecasEmMarkdown(r, {
        data: '2026-10-22',
        casos: casos.length,
        tetoUsd: 0.05,
        versaoDasRegras: 'x',
      }),
    ).toContain('TETO ATINGIDO');
  });

  it('custo: p50, p95, máximo e total vêm da resposta; latência p50/p95 do relógio injetado', async () => {
    let relogio = 0;
    const r = await compararPecas(
      base({
        transporte: transporte((c) => respostaPerfeita(c), [], 0.004),
        agora: () => (relogio += 500),
      }),
    );
    const l = r.linhas[0];
    expect(l?.fonteDoCusto).toBe('openrouter');
    expect(l?.custoP50Usd).toBeCloseTo(0.004);
    expect(l?.custoP95Usd).toBeCloseTo(0.004);
    expect(l?.custoMaximoUsd).toBeCloseTo(0.004);
    expect(l?.custoTotalUsd).toBeCloseTo(0.004 * casos.length);
    expect(l?.latenciaP50Ms).toBe(500);
  });

  it('relatório: critério da seção 8, preços não confirmados, e CSVs sem formula nem chave', async () => {
    const r = await compararPecas(
      base({
        transporte: transporte((c) => ({
          ...respostaPerfeita(c),
          pedidos: respostaPerfeita(c).pedidos.map((p) => ({
            ...p,
            texto: `=SOMA Pede algo`,
          })),
        })),
      }),
    );
    const md = relatorioDePecasEmMarkdown(r, {
      data: '2026-10-22',
      casos: casos.length,
      tetoUsd: 1,
      versaoDasRegras: '0.1.0',
    });
    expect(md).toContain('Citação verificada ≥ 95.0%');
    expect(md).toContain('pedidos principais encontrados em ≥ 90.0%');
    expect(md).toContain('zero "perigoso"');
    expect(md).toContain('Preços não confirmados');
    expect(metricasDePecasEmCsv(r).split('\n')[0]).toContain('citacao_verificada');
    const revisao = revisaoDePecasEmCsv(r);
    expect(revisao).toContain("'=SOMA");
    expect(revisao.split('\n')[0]).toContain('avaliacao');
  });

  it('estimativa de custo: por modelo, só com preço', () => {
    const e = estimarCustoDePecas(
      casos,
      ['m/producao', 'm/sem-preco'],
      new Map([['m/producao', { entrada: 0.000001, saida: 0.000002 }]]),
    );
    expect(e[0]?.custoEstimadoUsd).toBeGreaterThan(0);
    expect(e[1]?.custoEstimadoUsd).toBeUndefined();
    expect(e[0]?.chamadas).toBe(casos.length);
  });
});

describe('julgamento da revisão humana (errado e perigoso)', () => {
  const csv = (linhas: string[]) => `caso;modelo;avaliacao\n${linhas.join('\n')}\n`;

  it('cumpre com zero perigoso e errado até 10%; não cumpre fora disso; incompleto com linha vazia', () => {
    const ok = julgarRevisaoDePecas(
      csv([...Array.from({ length: 9 }, (_, i) => `c${i};m/a;util`), 'c9;m/a;errado']),
    );
    expect(ok[0]).toMatchObject({ avaliados: 10, util: 9, errado: 1, cumpre: true });
    const perigo = julgarRevisaoDePecas(csv(['c1;m/b;util', 'c2;m/b;perigoso']));
    expect(perigo[0]?.cumpre).toBe(false);
    expect(perigo[0]?.motivos.join(' ')).toContain('perigoso');
    const muitoErrado = julgarRevisaoDePecas(csv(['c1;m/c;util', 'c2;m/c;errado']));
    expect(muitoErrado[0]?.cumpre).toBe(false);
    const incompleto = julgarRevisaoDePecas(csv(['c1;m/d;util', 'c2;m/d;']));
    expect(incompleto[0]?.cumpre).toBeUndefined();
    expect(incompleto[0]?.pendentes).toBe(1);
  });

  it('valor desconhecido e planilha sem colunas são recusados citando a linha', () => {
    expect(() => julgarRevisaoDePecas(csv(['c1;m/a;talvez']))).toThrow(/linha 2/);
    expect(() => julgarRevisaoDePecas('a;b\n1;2\n')).toThrow(RevisaoDePecasInvalidaError);
  });
});

// --- o comando ------------------------------------------------------------------------------

function ambiente(sobrepor: Partial<AmbienteDaSonda> = {}) {
  const gravados: Array<{ caminho: string; conteudo: string }> = [];
  const saida: string[] = [];
  const avisos: string[] = [];
  const chamadas: PedidoAoModelo[] = [];
  const amb: AmbienteDaSonda = {
    env: { OPENROUTER_API_KEY: CHAVE, PROCESSOVIVO_IA_MODELO: PRODUCAO },
    raizDoRepositorio: '/repo',
    lerArquivo: async (c) => {
      if (c.endsWith('ia-pecas/casos.json')) return JSON_DAS_PECAS;
      if (c.endsWith('revisao.csv'))
        return 'caso;modelo;avaliacao\nc1;m/producao;util\nc2;m/producao;perigoso\n';
      throw new Error('arquivo inexistente');
    },
    lerStdin: async () => '',
    gravarArquivo: async (caminho, conteudo) => {
      gravados.push({ caminho, conteudo });
    },
    existeArquivo: async () => false,
    criarTransporte: () => transporte((c) => respostaPerfeita(c), chamadas, 0.001),
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

describe('comando do comparador, tarefa "pecas"', () => {
  it('sem --executar só ESTIMA: zero chamadas e nenhum arquivo gravado', async () => {
    const { amb, saida, chamadas, gravados } = ambiente();
    expect(
      await executarComandoComparador(['--tarefa=pecas', '--modelos=m/candidato'], amb),
    ).toBe(0);
    expect(chamadas).toHaveLength(0);
    expect(gravados).toHaveLength(0);
    const texto = saida.join('\n');
    expect(texto).toContain('NADA foi enviado');
    expect(texto).toContain('NÃO confirmado');
    expect(texto).toContain('peças sintéticas');
    expect(texto).toContain('m/producao (produção)');
  });

  it('com --executar roda produção + candidato, grava os três arquivos fora do repositório e a chave não vaza', async () => {
    const { amb, saida, avisos, chamadas, gravados } = ambiente();
    expect(
      await executarComandoComparador(
        ['--tarefa=pecas', '--modelos=m/candidato', '--executar', '--saida=/dados/cmp'],
        amb,
      ),
    ).toBe(0);
    expect(chamadas.length).toBe(casos.length * 2);
    expect(chamadas[0]?.modelo).toBe(PRODUCAO);
    expect(
      gravados.map((g) => g.caminho.replace(/^.*comparacao-pecas-2026-10-22-0930/, '')),
    ).toEqual(['.md', '-metricas.csv', '-revisao-humana.csv']);
    expect(gravados.every((g) => g.caminho.startsWith('/dados/cmp/'))).toBe(true);
    expect(
      [...saida, ...avisos, ...gravados.map((g) => g.conteudo)].join('\n'),
    ).not.toContain(CHAVE);
  });

  it('recusa sem confirmação: estimativa acima do teto não executa', async () => {
    const { amb, chamadas, avisos } = ambiente();
    expect(
      await executarComandoComparador(
        ['--tarefa=pecas', '--executar', '--teto-usd=0.001'],
        amb,
      ),
    ).toBe(2);
    expect(chamadas).toHaveLength(0);
    expect(avisos.join('\n')).toContain('passa do teto');
  });

  it('recusa sem ZDR: modelo de produção fora da lista, candidato sem ZDR e apelido/variante, nada é enviado', async () => {
    const um = ambiente({
      buscarEndpointsZdr: async () => ({ ...LISTA, endpoints: [] }),
    });
    expect(
      await executarComandoComparador(['--tarefa=pecas', '--executar'], um.amb),
    ).toBe(2);
    expect(um.chamadas).toHaveLength(0);
    const dois = ambiente();
    expect(
      await executarComandoComparador(
        [
          '--tarefa=pecas',
          '--modelos=m/sem-zdr,~m/apelido,m/candidato:free',
          '--executar',
          '--saida=/dados/cmp',
        ],
        dois.amb,
      ),
    ).toBe(0);
    expect(new Set(dois.chamadas.map((c) => c.modelo))).toEqual(new Set([PRODUCAO]));
    expect(dois.avisos.join('\n')).toContain('"m/sem-zdr" não tem endpoint com ZDR');
    expect(dois.avisos.join('\n')).toContain('apelido');
    const tres = ambiente({
      buscarEndpointsZdr: async () => {
        throw new Error('rede fora');
      },
    });
    expect(
      await executarComandoComparador(['--tarefa=pecas', '--executar'], tres.amb),
    ).toBe(2);
    expect(tres.chamadas).toHaveLength(0);
  });

  it('sem chave, valor de exemplo e saída dentro do repositório são recusados antes de qualquer rede', async () => {
    for (const env of [
      { PROCESSOVIVO_IA_MODELO: PRODUCAO },
      { OPENROUTER_API_KEY: 'COLE_AQUI_A_CHAVE', PROCESSOVIVO_IA_MODELO: PRODUCAO },
    ]) {
      let pediuLista = false;
      const { amb, chamadas } = ambiente({
        env,
        buscarEndpointsZdr: async () => {
          pediuLista = true;
          return LISTA;
        },
      });
      expect(await executarComandoComparador(['--tarefa=pecas', '--executar'], amb)).toBe(
        2,
      );
      expect(chamadas).toHaveLength(0);
      expect(pediuLista).toBe(false);
    }
    const { amb, chamadas } = ambiente();
    expect(
      await executarComandoComparador(
        ['--tarefa=pecas', '--executar', '--saida=/repo/relatorios'],
        amb,
      ),
    ).toBe(2);
    expect(chamadas).toHaveLength(0);
  });

  it('--tarefa desconhecida é recusada e --julgar-revisao não precisa de chave nem chama modelo', async () => {
    const a = ambiente();
    expect(await executarComandoComparador(['--tarefa=sentencas'], a.amb)).toBe(1);
    const b = ambiente({ env: {} });
    expect(
      await executarComandoComparador(['--julgar-revisao=/dados/revisao.csv'], b.amb),
    ).toBe(0);
    expect(b.saida.join('\n')).toContain('NÃO cumpre');
    expect(b.chamadas).toHaveLength(0);
  });

  it('a tarefa do ato continua a mesma (padrão)', async () => {
    const { amb, saida } = ambiente({
      lerArquivo: async (c) => {
        if (c.endsWith('ia-avaliacao/casos.json'))
          return readFileSync(
            resolve(import.meta.dirname, '../fixtures/ia-avaliacao/casos.json'),
            'utf8',
          );
        throw new Error('arquivo inexistente');
      },
    });
    expect(await executarComandoComparador(['--modelos=m/candidato'], amb)).toBe(0);
    expect(saida.join('\n')).toContain('casos sintéticos');
    expect(lerRespostaDePeca({})).toBeUndefined();
  });
});
