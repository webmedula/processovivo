import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { reaisDeCentavos } from '../../src/domain/entities/valorEmReais.js';
import type { DocumentoDePrestacao } from '../../src/domain/ports/GeradorDePrestacaoDeContas.js';
import { PrestacaoDeContasPdf } from '../../src/infrastructure/pdf/PrestacaoDeContasPdf.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { NUMERO_TJSP_A, ProviderFalso, umProcesso } from '../helpers/fabricas.js';

/* Dados sintéticos. O texto do PDF é lido de volta com o pdftotext (poppler), como nos testes do leitor. */

let pasta: string;
beforeAll(() => {
  pasta = mkdtempSync(join(tmpdir(), 'pv-prestacao-'));
});
afterAll(() => {
  rmSync(pasta, { recursive: true, force: true });
});

let contador = 0;
function texto(pdf: Uint8Array, pagina?: number, bruto = false): string {
  const arquivo = join(pasta, `p${contador++}.pdf`);
  writeFileSync(arquivo, pdf);
  const args = pagina ? ['-f', String(pagina), '-l', String(pagina)] : [];
  return execFileSync('pdftotext', [bruto ? '-raw' : '-layout', ...args, arquivo, '-'], {
    encoding: 'utf8',
  });
}
const plano = (t: string): string => t.replace(/\s+/g, ' ');

const TOTAIS: DocumentoDePrestacao['totais'] = [
  { rotulo: 'Total de despesas', valor: 'R$ 150,00' },
  { rotulo: 'Pago pelo escritório', valor: 'R$ 130,00' },
  { rotulo: 'Pago diretamente pelo cliente', valor: 'R$ 20,00' },
  { rotulo: 'Total a cobrar do cliente (reembolsável)', valor: 'R$ 120,00' },
  { rotulo: 'Total recebido do cliente', valor: 'R$ 20,00' },
  { rotulo: 'Saldo a cobrar', valor: 'R$ 100,00', destaque: true },
];

function documento(
  n: number,
  extra: Partial<DocumentoDePrestacao> = {},
): DocumentoDePrestacao {
  const linhas = Array.from({ length: n }, (_, i) => ({
    data: `${String((i % 28) + 1).padStart(2, '0')}/09/2026`,
    descricao: `Despesa sintética número ${i + 1} do processo de teste, com texto para exercitar a quebra de linha`,
    categoria:
      i % 2
        ? 'Custas e taxas judiciais › Outras custas judiciais'
        : 'Despesas administrativas › Cópias e digitalizações',
    valor: reaisDeCentavos(100_000 + i),
    situacao:
      i % 3 === 0
        ? 'Pago pelo escritório · a cobrar do cliente'
        : i % 3 === 1
          ? 'Pago pelo cliente'
          : 'Pago pelo escritório · não cobrado',
  }));
  return {
    numeroProcesso: '1234567-47.2023.8.26.0100',
    tribunal: 'TJSP',
    geradoEm: '20/10/2026 12:00',
    filtros: [],
    versao: '9.9.9-teste',
    linhas,
    depositos: [],
    recebimentos: [],
    subtotais: [
      {
        categoria: 'Custas e taxas judiciais › Outras custas judiciais',
        quantidade: Math.floor(n / 2),
        valor: 'R$ 100,00',
      },
      {
        categoria: 'Despesas administrativas › Cópias e digitalizações',
        quantidade: Math.ceil(n / 2),
        valor: 'R$ 50,00',
      },
    ],
    totais: TOTAIS,
    ...extra,
  };
}

describe('PrestacaoDeContasPdf', () => {
  const gerador = new PrestacaoDeContasPdf();

  it('com 1 lançamento: uma página A4 com cabeçalho, tabela, subtotais, totais e rodapé', async () => {
    const bytes = await gerador.gerar(
      documento(1, {
        cliente: 'Cliente Sintético Ltda.',
        advogado: { nome: 'Advogada Sintética', oab: '123456/SP' },
        filtros: [
          'Período: de 01/09/2026 até 30/09/2026',
          'Somente o que está a cobrar do cliente',
        ],
      }),
    );
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect(Math.round(w)).toBe(595);
    expect(Math.round(h)).toBe(842);

    const t = plano(texto(bytes));
    for (const esperado of [
      'Prestação de contas',
      '1234567-47.2023.8.26.0100',
      'TJSP',
      'Cliente Sintético Ltda.',
      'Advogada Sintética · OAB 123456/SP',
      'Gerado em 20/10/2026 12:00',
      'Período: de 01/09/2026 até 30/09/2026',
      'Somente o que está a cobrar do cliente',
      'Data Descrição Categoria Valor Situação',
      '01/09/2026',
      'R$ 1.000,00',
      'Pago pelo escritório',
      'Cópias e digitalizações',
      'Subtotais das despesas por categoria',
      '1 lançamento',
      'Total de despesas R$ 150,00',
      'Pago pelo escritório R$ 130,00',
      'Pago diretamente pelo cliente R$ 20,00',
      'Total a cobrar do cliente (reembolsável) R$ 120,00',
      'Total recebido do cliente R$ 20,00',
      'Saldo a cobrar R$ 100,00',
      'Valores informados pelo advogado. Gerado pelo Processo Vivo, versão 9.9.9-teste.',
      'Página 1 de 1',
    ]) {
      expect(t, esperado).toContain(esperado);
    }
  });

  it('com 200 lançamentos: várias páginas, cabeçalho da tabela em todas, totais só na última', async () => {
    const bytes = await gerador.gerar(documento(200));
    const doc = await PDFDocument.load(bytes);
    const paginas = doc.getPageCount();
    expect(paginas).toBeGreaterThan(3);

    let linhasLidas = 0;
    for (let p = 1; p <= paginas; p++) {
      const t = plano(texto(bytes, p));
      expect(t, `cabeçalho da tabela na página ${p}`).toContain(
        'Data Descrição Categoria Valor Situação',
      );
      expect(t).toContain(`Página ${p} de ${paginas}`);
      expect(t).toContain('Valores informados pelo advogado.');
      // Cabeçalho corrente nas páginas seguintes: quem recebe a página solta sabe de que processo é.
      if (p > 1) expect(t).toContain('Processo 1234567-47.2023.8.26.0100');
      linhasLidas += (t.match(/Despesa sintética número \d+/g) ?? []).length;
      if (p < paginas) {
        expect(t, `sem totais na página ${p}`).not.toContain('Saldo a cobrar');
      }
    }
    const ultima = plano(texto(bytes, paginas));
    expect(ultima).toContain('Saldo a cobrar R$ 100,00');
    expect(ultima).toContain('Total de despesas R$ 150,00');
    expect(linhasLidas).toBe(200);
    // Nenhuma linha se perdeu nem se repetiu.
    const todo = plano(texto(bytes));
    for (const i of [1, 100, 200])
      expect(todo).toContain(`Despesa sintética número ${i} `);
  });

  it('se os totais não cabem no fim da tabela, vão INTEIROS para uma página nova — e nada vem depois', async () => {
    // Varre tamanhos até achar um em que a última página é só de totais; em qualquer tamanho,
    // os totais estão todos na última página.
    let viuPaginaSoDeTotais = false;
    for (let n = 30; n <= 60; n++) {
      const bytes = await gerador.gerar(documento(n));
      const paginas = (await PDFDocument.load(bytes)).getPageCount();
      const ultima = plano(texto(bytes, paginas));
      expect(ultima, `n=${n}`).toContain('Saldo a cobrar R$ 100,00');
      expect(ultima, `n=${n}`).toContain('Total de despesas');
      expect(ultima, `n=${n}`).toContain('Total recebido do cliente');
      if (!/Despesa sintética/.test(ultima)) viuPaginaSoDeTotais = true;
    }
    expect(viuPaginaSoDeTotais).toBe(true);
  }, 60_000);

  it('sem despesas, diz que não há e mantém os totais', async () => {
    const t = plano(
      texto(
        await gerador.gerar(
          documento(0, {
            subtotais: [],
            totais: [
              { rotulo: 'Total de despesas', valor: 'R$ 0,00' },
              { rotulo: 'Saldo a cobrar', valor: 'R$ 0,00', destaque: true },
            ],
          }),
        ),
      ),
    );
    expect(t).toContain('Nenhuma despesa neste filtro.');
    expect(t).toContain('Saldo a cobrar R$ 0,00');
  });

  it('acentuação correta; caractere que a fonte não desenha vira "?" e não derruba a geração', async () => {
    const d = documento(1);
    const bytes = await gerador.gerar({
      ...d,
      linhas: [
        {
          data: '01/09/2026',
          descricao:
            'Locação de veículo — diligência à comarca de São José do Rio Preto 😀 ✓',
          categoria: 'Diligências e comunicações › Outras diligências',
          valor: 'R$ 1,00',
          situacao: 'Pago pelo escritório · a cobrar do cliente',
        },
      ],
    });
    const t = plano(texto(bytes, undefined, true));
    expect(t).toContain('Locação de veículo');
    expect(t).toContain('diligência à comarca de São José do Rio Preto');
    expect(t).toContain('?');
  });

  it('palavra sem espaço maior que a coluna é quebrada e não estoura a página', async () => {
    const bytes = await gerador.gerar({
      ...documento(1),
      linhas: [
        {
          data: '01/09/2026',
          descricao: 'W'.repeat(200),
          categoria: 'Outras despesas › Despesa processual não classificada',
          valor: 'R$ 1,00',
          situacao: 'Pago pelo escritório · a cobrar do cliente',
        },
      ],
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect(texto(bytes, undefined, true).replace(/\s+/g, '')).toContain('W'.repeat(200));
  });

  it('depósitos e garantias saem em bloco à parte; recebimentos e crédito aparecem; saldo à vista', async () => {
    const d = documento(2);
    const bytes = await gerador.gerar({
      ...d,
      depositos: [
        {
          data: '03/10/2026',
          descricao: 'Depósito judicial sintético',
          categoria: 'Depósitos e garantias › Depósito judicial',
          valor: 'R$ 500,00',
          situacao: 'Pago pelo escritório · a cobrar do cliente',
        },
      ],
      recebimentos: [
        { data: '10/10/2026', observacao: 'Pix parcial sintético', valor: 'R$ 30,00' },
      ],
      totais: [
        ...TOTAIS.slice(0, 4),
        { rotulo: 'dos quais depósitos e garantias', valor: 'R$ 500,00', recuado: true },
        { rotulo: 'Total recebido do cliente', valor: 'R$ 30,00' },
        { rotulo: 'Saldo a cobrar', valor: 'R$ 0,00', destaque: true },
        { rotulo: 'Crédito do cliente', valor: 'R$ 12,00', destaque: true },
        {
          rotulo: 'Depósitos e garantias (fora do total de despesas)',
          valor: 'R$ 500,00',
        },
      ],
    });
    const t = plano(texto(bytes));
    const iDeposito = t.indexOf('Depósito judicial sintético');
    expect(t).toContain('Depósitos e garantias Não entram no total de despesas.');
    // O depósito vem DEPOIS de todas as despesas, e nunca entre elas.
    expect(iDeposito).toBeGreaterThan(t.lastIndexOf('Despesa sintética número 2'));
    expect(t).toContain('Recebimentos do cliente');
    expect(t).toContain('Pix parcial sintético');
    expect(t).toContain('dos quais depósitos e garantias R$ 500,00');
    expect(t).toContain('Crédito do cliente R$ 12,00');
    expect(t).toContain('Saldo a cobrar R$ 0,00');
    expect(t).toContain('Depósitos e garantias (fora do total de despesas) R$ 500,00');
  });

  it('o gerador e o serviço não escrevem em disco', () => {
    for (const f of [
      '../../src/infrastructure/pdf/PrestacaoDeContasPdf.ts',
      '../../src/application/services/ServicoCustos.ts',
      '../../src/main/http/rotas/custos.ts',
    ]) {
      const fonte = readFileSync(resolve(__dirname, f), 'utf8');
      expect(fonte, f).not.toMatch(
        /from 'node:(fs|os|child_process|path)'|writeFile|createWriteStream|tmpdir/,
      );
    }
  });
});

describe('Prestação de contas — pelo serviço e pela API', () => {
  const CHAVE = 'chave-da-advogada-a-1234567890';
  const H = { 'x-api-key': CHAVE };
  const WS = workspaceDaChave(CHAVE);
  const SENTINELAS = [
    'NOME-DE-PARTE-SINTETICO',
    'TEXTO-DE-ATO-SINTETICO',
    'ADVERSARIO-SINTETICO',
  ];

  function montar(): { app: Aplicacao; servidor: ReturnType<typeof construirServidor> } {
    const app = aplicacaoDeTeste(
      [
        new ProviderFalso({
          nome: 'falso',
          porNumero: async () =>
            umProcesso({
              segredoJustica: true,
              partes: [
                {
                  polo: 'ATIVO',
                  tipoPessoa: 'FISICA',
                  nome: SENTINELAS[0]!,
                  advogados: [],
                },
                {
                  polo: 'PASSIVO',
                  tipoPessoa: 'FISICA',
                  nome: SENTINELAS[2]!,
                  advogados: [],
                },
              ],
              movimentacoes: [
                {
                  data: new Date('2026-09-01T12:00:00Z'),
                  titulo: 'Despacho',
                  conteudo: SENTINELAS[1]!,
                },
              ],
            }),
        }),
      ],
      { agora: () => new Date('2026-10-20T15:30:00.000Z') },
    );
    const servidor = construirServidor(
      app,
      carregarConfig({
        PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
        LOG_LEVEL: 'silent',
        CACHE_ENABLED: 'false',
        COOKIE_SECURE: 'false',
        PROCESSOVIVO_API_KEYS: CHAVE,
        RATE_LIMIT_MAX: '10000',
      } as NodeJS.ProcessEnv),
    );
    return { app, servidor };
  }

  const dados = (
    extra: Record<string, unknown>,
  ): Parameters<Aplicacao['custos']['criar']>[2] =>
    ({
      data: '2026-09-10',
      descricao: 'Despesa',
      categoria: 'CUS-020',
      valorCentavos: 10_000,
      reembolsavel: true,
      ...extra,
    }) as Parameters<Aplicacao['custos']['criar']>[2];

  it('não traz parte, texto de ato nem dado de segredo de justiça: só número, tribunal e rótulo de cliente', async () => {
    const { app, servidor } = montar();
    await app.acompanhamento.acompanhar(WS, NUMERO_TJSP_A);
    await app.acompanhamento.rotular(WS, NUMERO_TJSP_A, 'Cliente Rotulado');
    await app.custos.criar(WS, NUMERO_TJSP_A, dados({ descricao: 'Guia de custas' }));

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${NUMERO_TJSP_A}/custos/prestacao.pdf`,
      headers: H,
    });
    expect(r.statusCode).toBe(200);
    const t = plano(texto(new Uint8Array(r.rawPayload)));
    expect(t).toContain('Cliente Rotulado');
    expect(t).toContain('TJSP');
    expect(t).toContain('Guia de custas');
    // Segredo de justiça: o processo é sigiloso e o PDF segue sem NADA do processo além do trio.
    for (const s of SENTINELAS) expect(t).not.toContain(s);
    expect(t).not.toContain('12ª Vara');
    expect(t).not.toContain('Procedimento Comum');
    await servidor.close();
  });

  it('entrega o PDF na resposta, com nome sem dado pessoal e sem cache', async () => {
    const { app, servidor } = montar();
    await app.custos.criar(WS, NUMERO_TJSP_A, dados({}));
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${NUMERO_TJSP_A}/custos/prestacao.pdf`,
      headers: H,
    });
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="prestacao-de-contas-1234567-47.2023.8.26.0100-2026-10-20.pdf"',
    );
    expect(r.headers['cache-control']).toBe('no-store');
    expect(Buffer.from(r.rawPayload).subarray(0, 5).toString()).toBe('%PDF-');
    // Conta de chave de API não tem pessoa: sem linha de advogado, e sem inventar.
    expect(plano(texto(new Uint8Array(r.rawPayload)))).not.toContain('Advogado(a)');
    await servidor.close();
  });

  it('com sessão, leva o nome e a OAB do advogado da conta', async () => {
    const { servidor } = montar();
    const c = await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: {
        nome: 'Advogada Sessão Sintética',
        email: 'sessao@escritorio.com.br',
        senha: 'uma-senha-boa-o-bastante',
      },
    });
    const bruto = c.headers['set-cookie'];
    const cookie = String(Array.isArray(bruto) ? bruto[0] : bruto).split(';')[0]!;
    // A OAB entra depois, no perfil (cadastro progressivo).
    await servidor.inject({
      method: 'PATCH',
      url: '/v1/eu',
      headers: { cookie },
      payload: { oab: '654321', ufOab: 'SP' },
    });
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${NUMERO_TJSP_A}/custos/prestacao.pdf`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(plano(texto(new Uint8Array(r.rawPayload)))).toContain(
      'Advogada Sessão Sintética · OAB 654321/SP',
    );
    await servidor.close();
  });

  it('filtra por período e por "somente o que está a cobrar"; recebimentos abatem o saldo', async () => {
    const { app, servidor } = montar();
    await app.custos.criar(
      WS,
      NUMERO_TJSP_A,
      dados({ data: '2026-08-01', descricao: 'Agosto cobrado', valorCentavos: 1_000 }),
    );
    await app.custos.criar(
      WS,
      NUMERO_TJSP_A,
      dados({
        data: '2026-09-10',
        descricao: 'Setembro pago pelo cliente',
        valorCentavos: 2_000,
        pagoPor: 'cliente',
      }),
    );
    await app.custos.criar(
      WS,
      NUMERO_TJSP_A,
      dados({ data: '2026-09-15', descricao: 'Setembro cobrar', valorCentavos: 4_000 }),
    );
    await app.custos.criar(
      WS,
      NUMERO_TJSP_A,
      dados({
        data: '2026-09-16',
        descricao: 'Setembro interno',
        valorCentavos: 8_000,
        reembolsavel: false,
      }),
    );
    await app.custos.registrarRecebimento(WS, NUMERO_TJSP_A, {
      data: '2026-09-20',
      valorCentavos: 1_500,
      observacao: 'Recebimento de setembro',
    });

    const pegar = async (q: string): Promise<string> => {
      const r = await servidor.inject({
        method: 'GET',
        url: `/v1/processos/${NUMERO_TJSP_A}/custos/prestacao.pdf?${q}`,
        headers: H,
      });
      expect(r.statusCode).toBe(200);
      return plano(texto(new Uint8Array(r.rawPayload)));
    };

    const tudo = await pegar('');
    expect(tudo).toContain('Total de despesas R$ 150,00');
    expect(tudo).toContain('Pago diretamente pelo cliente R$ 20,00');
    expect(tudo).toContain('Total a cobrar do cliente (reembolsável) R$ 50,00');
    expect(tudo).toContain('Total recebido do cliente R$ 15,00');
    expect(tudo).toContain('Saldo a cobrar R$ 35,00');
    expect(tudo).toContain('Recebimento de setembro');
    expect(tudo).toContain('Pago pelo cliente');
    // Do mais antigo para o mais novo.
    expect(tudo.indexOf('Agosto cobrado')).toBeLessThan(tudo.indexOf('Setembro cobrar'));

    const setembro = await pegar('de=2026-09-01&ate=2026-09-30');
    expect(setembro).toContain('Período: de 01/09/2026 até 30/09/2026');
    expect(setembro).not.toContain('Agosto cobrado');
    expect(setembro).toContain('Total de despesas R$ 140,00');

    const aCobrar = await pegar('somenteACobrar=true');
    expect(aCobrar).toContain('Somente o que está a cobrar do cliente');
    expect(aCobrar).toContain('Agosto cobrado');
    expect(aCobrar).toContain('Setembro cobrar');
    expect(aCobrar).not.toContain('Setembro pago pelo cliente');
    expect(aCobrar).not.toContain('Setembro interno');
    expect(aCobrar).toContain('Total de despesas R$ 50,00');

    for (const ruim of [
      'de=2026-02-30',
      'ate=abc',
      'de=2026-10-01&ate=2026-09-01',
      'x=1',
    ]) {
      const r = await servidor.inject({
        method: 'GET',
        url: `/v1/processos/${NUMERO_TJSP_A}/custos/prestacao.pdf?${ruim}`,
        headers: H,
      });
      expect(r.statusCode, ruim).toBe(400);
    }
    await servidor.close();
  });

  it('cancelados ficam fora; depósito vai em bloco à parte; excedente aparece como crédito', async () => {
    const { app, servidor } = montar();
    const cancelado = await app.custos.criar(
      WS,
      NUMERO_TJSP_A,
      dados({ descricao: 'Lançamento cancelado SUMIDO', valorCentavos: 9_999 }),
    );
    await app.custos.cancelar(WS, cancelado.id, 'engano');
    const recCancelado = await app.custos.registrarRecebimento(WS, NUMERO_TJSP_A, {
      data: '2026-09-20',
      valorCentavos: 8_888,
      observacao: 'Recebimento cancelado SUMIDO',
    });
    await app.custos.cancelarRecebimento(WS, recCancelado.id);
    await app.custos.criar(
      WS,
      NUMERO_TJSP_A,
      dados({ descricao: 'Despesa comum', valorCentavos: 1_000 }),
    );
    await app.custos.criar(
      WS,
      NUMERO_TJSP_A,
      dados({
        descricao: 'Depósito sintético',
        categoria: 'DEP-001',
        valorCentavos: 20_000,
      }),
    );
    await app.custos.registrarRecebimento(WS, NUMERO_TJSP_A, {
      data: '2026-09-21',
      valorCentavos: 25_000,
    });
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${NUMERO_TJSP_A}/custos/prestacao.pdf`,
      headers: H,
    });
    const t = plano(texto(new Uint8Array(r.rawPayload)));
    expect(t).not.toContain('SUMIDO');
    expect(t).not.toContain('99,99');
    expect(t).not.toContain('88,88');
    expect(t).toContain('Total de despesas R$ 10,00');
    expect(t).toContain('Depósitos e garantias Não entram no total de despesas.');
    expect(t).toContain('dos quais depósitos e garantias R$ 200,00');
    expect(t).toContain('Total a cobrar do cliente (reembolsável) R$ 210,00');
    expect(t).toContain('Saldo a cobrar R$ 0,00');
    expect(t).toContain('Crédito do cliente R$ 40,00');
    expect(t.indexOf('Depósito sintético')).toBeGreaterThan(t.indexOf('Despesa comum'));
    await servidor.close();
  });

  it('dois PDFs com 200 lançamentos saem em sequência sem estourar (sem disco, sem cache)', async () => {
    const { app, servidor } = montar();
    for (let i = 0; i < 200; i++) {
      await app.custos.criar(
        WS,
        NUMERO_TJSP_A,
        dados({ descricao: `Item ${i}`, valorCentavos: 100 + i }),
      );
    }
    for (let k = 0; k < 2; k++) {
      const r = await servidor.inject({
        method: 'GET',
        url: `/v1/processos/${NUMERO_TJSP_A}/custos/prestacao.pdf`,
        headers: H,
      });
      expect(r.statusCode).toBe(200);
      const t = plano(texto(new Uint8Array(r.rawPayload)));
      // 200 × R$ 1,00 + (0+…+199) centavos = 20.000 + 19.900 centavos = R$ 399,00.
      expect(t).toContain('Total de despesas R$ 399,00');
    }
    await servidor.close();
  }, 60_000);

  it('o limite de PDFs por minuto barra o laço', async () => {
    const { servidor } = montar();
    let ultimo = 200;
    for (let i = 0; i < 12; i++) {
      ultimo = (
        await servidor.inject({
          method: 'GET',
          url: `/v1/processos/${NUMERO_TJSP_A}/custos/prestacao.pdf`,
          headers: H,
        })
      ).statusCode;
    }
    expect(ultimo).toBe(429);
    await servidor.close();
  }, 30_000);
});
