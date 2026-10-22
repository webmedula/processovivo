import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtracaoDeTextoError } from '../../src/domain/errors/index.js';
import {
  PdftotextExtrator,
  type ExecutorDeProcesso,
} from '../../src/infrastructure/pdf/PdftotextExtrator.js';
import { pdfComPaginas, pdfComSenha, pdfSoComImagem } from '../helpers/pdfDePecas.js';

const PAGINA_1 =
  'PETICAO INICIAL. A parte autora, pessoa fisica inventada, vem propor a presente acao em face da ré, ' +
  'empresa inventada, pelos fatos e fundamentos a seguir expostos com todo o detalhe necessário.';
const PAGINA_2 =
  'DOS PEDIDOS. Requer a condenação da ré ao pagamento de indenização por danos morais, conforme ' +
  'valor a ser arbitrado, bem como a condenação ao pagamento das custas e dos honorários.';

const extrator = (o: ConstructorParameters<typeof PdftotextExtrator>[0] = {}) =>
  new PdftotextExtrator(o);

async function erroDe(p: Promise<unknown>): Promise<ExtracaoDeTextoError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExtracaoDeTextoError) return e;
    throw e;
  }
  throw new Error('deveria ter recusado');
}

afterEach(() => vi.restoreAllMocks());

describe('o poppler está na máquina', () => {
  it('pdftotext instalado (CI: apt-get install poppler-utils; imagem: apk add poppler-utils)', () => {
    const r = spawnSync('pdftotext', ['-v']);
    if (r.error) {
      throw new Error(
        'pdftotext não encontrado. Instale o poppler-utils (Alpine: apk add poppler-utils; Debian/Ubuntu: apt-get install poppler-utils).',
      );
    }
    expect(r.status === 0 || r.status === 99).toBe(true);
  });
});

describe('extração de texto por página (pdftotext de verdade)', () => {
  it('devolve o texto de cada página, na ordem, preservando o número da página', async () => {
    const pdf = await pdfComPaginas([
      PAGINA_1,
      PAGINA_2,
      'Terceira página com texto bastante para contar como página lida pela medição.',
    ]);
    const r = await extrator().extrair(pdf);
    expect(r.paginas).toHaveLength(3);
    expect(r.paginas[0]).toContain('PETICAO INICIAL');
    expect(r.paginas[1]).toContain('DOS PEDIDOS');
    expect(r.paginas[0]).not.toContain('DOS PEDIDOS');
    expect(r.contagens).toMatchObject({
      paginasLidas: 3,
      truncadoPorPaginas: false,
      paginasComTexto: 3,
      temTextoPesquisavel: true,
      excedeLimiteDeCaracteres: false,
    });
    expect(r.contagens.caracteres).toBeGreaterThan(150);
  });

  it('PDF escaneado (só imagem) volta sem texto pesquisável e é contado, não lido', async () => {
    const r = await extrator().extrair(await pdfSoComImagem(3));
    expect(r.contagens.paginasLidas).toBe(3);
    expect(r.contagens.paginasComTexto).toBe(0);
    expect(r.contagens.temTextoPesquisavel).toBe(false);
    expect(r.contagens.caracteres).toBe(0);
  });

  it('lê só as primeiras páginas e diz que truncou quando o PDF passa do limite', async () => {
    const pdf = await pdfComPaginas(
      Array.from({ length: 6 }, (_, i) => `Pagina ${i + 1}. ${PAGINA_1}`),
    );
    const r = await extrator().extrair(pdf, { maxPaginas: 4 });
    expect(r.contagens.paginasLidas).toBe(4);
    expect(r.contagens.truncadoPorPaginas).toBe(true);
    expect(r.paginas[3]).toContain('Pagina 4');
  });

  it('sinaliza (sem cortar) quando os caracteres passam do limite por peça', async () => {
    const r = await extrator().extrair(await pdfComPaginas([PAGINA_1, PAGINA_2]), {
      maxCaracteres: 100,
    });
    expect(r.contagens.excedeLimiteDeCaracteres).toBe(true);
    expect(r.paginas[1]).toContain('DOS PEDIDOS');
  });

  it('PDF com senha vira erro tipado "pdf_protegido", em português', async () => {
    const e = await erroDe(
      extrator().extrair(pdfComSenha(await pdfComPaginas([PAGINA_1]))),
    );
    expect(e.motivo).toBe('pdf_protegido');
    expect(e.message).toMatch(/protegido por senha/);
  });

  it('PDF corrompido vira "pdf_invalido", sem repetir nada do arquivo na mensagem', async () => {
    const pdf = await pdfComPaginas([PAGINA_1]);
    const corrompido = pdf.slice(0, Math.floor(pdf.length / 2));
    const e = await erroDe(extrator().extrair(corrompido));
    expect(e.motivo).toBe('pdf_invalido');
    expect(e.message).not.toMatch(/PETICAO|Syntax|poppler|pdftotext\s+\S+\.pdf/);
  });

  it('o que não é PDF nem chega ao binário', async () => {
    let chamou = false;
    const executar: ExecutorDeProcesso = async () => {
      chamou = true;
      return { codigo: 0, stdout: '', stderr: '' };
    };
    const e = await erroDe(
      extrator({ executar }).extrair(
        new TextEncoder().encode('SEGREDO-NA-PECA isto é texto puro'),
      ),
    );
    expect(e.motivo).toBe('pdf_invalido');
    expect(e.message).not.toContain('SEGREDO-NA-PECA');
    expect(chamou).toBe(false);
  });

  it('arquivo vazio e arquivo acima do tamanho máximo são recusados antes de abrir', async () => {
    let chamadas = 0;
    const executar: ExecutorDeProcesso = async () => {
      chamadas += 1;
      return { codigo: 0, stdout: '', stderr: '' };
    };
    const ext = extrator({ executar, maxBytes: 1024 });
    expect((await erroDe(ext.extrair(new Uint8Array()))).motivo).toBe('arquivo_vazio');
    const grande = new Uint8Array(2048);
    grande.set(new TextEncoder().encode('%PDF-1.7'));
    expect((await erroDe(ext.extrair(grande))).motivo).toBe('arquivo_grande');
    expect(chamadas).toBe(0);
  });
});

describe('limites do processo filho (executor falso, sem esperar tempo real)', () => {
  const pdfMinimo = new TextEncoder().encode('%PDF-1.4\n%%EOF');

  it.each([
    ['tempo_esgotado', /tempo limite/],
    ['saida_grande_demais', /grande demais/],
    ['ferramenta_ausente', /não está instalada/],
  ] as const)(
    'falha "%s" do processo vira erro tipado em português',
    async (falha, mensagem) => {
      const executar: ExecutorDeProcesso = async () => ({ falha });
      const e = await erroDe(extrator({ executar }).extrair(pdfMinimo));
      expect(e.motivo).toBe(falha);
      expect(e.message).toMatch(mensagem);
    },
  );

  it('chama o pdftotext com argumentos em vetor, tempo limite e maxBuffer, e o PDF pela entrada padrão', async () => {
    let visto:
      | {
          binario: string;
          args: readonly string[];
          entrada: number;
          timeoutMs: number;
          maxBuffer: number;
        }
      | undefined;
    const executar: ExecutorDeProcesso = async (binario, args, entrada, limites) => {
      visto = { binario, args, entrada: entrada.length, ...limites };
      return { codigo: 0, stdout: 'a\fb\f', stderr: '' };
    };
    const r = await extrator({
      executar,
      timeoutMs: 30_000,
      maxSaidaBytes: 1_000_000,
    }).extrair(pdfMinimo, {
      maxPaginas: 40,
    });
    expect(visto?.binario).toBe('pdftotext');
    expect(visto?.args).toEqual([
      '-layout',
      '-enc',
      'UTF-8',
      '-eol',
      'unix',
      '-f',
      '1',
      '-l',
      '41',
      '-',
      '-',
    ]);
    expect(visto?.timeoutMs).toBe(30_000);
    expect(visto?.maxBuffer).toBe(1_000_000);
    expect(visto?.entrada).toBe(pdfMinimo.length);
    expect(r.paginas).toEqual(['a', 'b']);
  });

  it('mede a duração pelo relógio injetado', async () => {
    let t = 1000;
    const executar: ExecutorDeProcesso = async () => {
      t += 250;
      return { codigo: 0, stdout: 'texto\f', stderr: '' };
    };
    const r = await extrator({ executar, agora: () => t }).extrair(pdfMinimo);
    expect(r.contagens.duracaoMs).toBe(250);
  });

  it('o módulo não escreve em console nem em log', async () => {
    const espioes = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await erroDe(
      extrator().extrair(new TextEncoder().encode('%PDF-1.4 lixo SEGREDO-NA-PECA')),
    );
    await extrator().extrair(await pdfComPaginas([PAGINA_1]));
    for (const e of espioes) expect(e).not.toHaveBeenCalled();
  });
});
