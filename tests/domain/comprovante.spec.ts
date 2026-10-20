import { describe, expect, it } from 'vitest';
import {
  LIMITE_COMPROVANTES_POR_LANCAMENTO,
  TAMANHO_MAXIMO_DO_COMPROVANTE,
  detectarTipoDoComprovante,
  sanearNomeDoComprovante,
  validarComprovante,
} from '../../src/domain/entities/Comprovante.js';
import { ComprovanteInvalidoError } from '../../src/domain/errors/index.js';

/* Arquivos sintéticos: só o começo (a "assinatura" do formato) importa para o tipo real. */
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]);
const TEXTO = new TextEncoder().encode(
  'isto não é um PDF, mesmo que se chame recibo.pdf',
);
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');

describe('tipo REAL do comprovante, pelos primeiros bytes', () => {
  it('reconhece PDF, JPEG e PNG', () => {
    expect(detectarTipoDoComprovante(PDF)).toBe('application/pdf');
    expect(detectarTipoDoComprovante(JPEG)).toBe('image/jpeg');
    expect(detectarTipoDoComprovante(PNG)).toBe('image/png');
  });

  it('não reconhece o resto (executável, texto, HTML, GIF, arquivo curto demais)', () => {
    for (const x of [
      EXE,
      TEXTO,
      HTML,
      new Uint8Array(),
      new Uint8Array([0x25, 0x50]),
      new TextEncoder().encode('GIF89a'),
    ]) {
      expect(detectarTipoDoComprovante(x)).toBeUndefined();
    }
  });

  it('a extensão e o Content-Type NÃO decidem: um executável renomeado para .pdf é recusado', () => {
    expect(() => validarComprovante(EXE, 'recibo.pdf', 'application/pdf')).toThrow(
      ComprovanteInvalidoError,
    );
    expect(() => validarComprovante(TEXTO, 'guia.pdf', 'application/pdf')).toThrow(
      ComprovanteInvalidoError,
    );
    expect(() => validarComprovante(HTML, 'foto.png', 'image/png')).toThrow(
      ComprovanteInvalidoError,
    );
  });

  it('o conteúdo tem de bater com o tipo declarado (PNG dizendo ser PDF é recusado)', () => {
    expect(() => validarComprovante(PNG, 'recibo.pdf', 'application/pdf')).toThrowError(
      /não é do tipo informado/,
    );
    // Sem declarar nada (ou como binário genérico), vale o tipo real.
    expect(validarComprovante(PNG, 'foto', 'application/octet-stream').tipo).toBe(
      'image/png',
    );
    expect(validarComprovante(JPEG, 'foto.jpeg', 'image/jpg').tipo).toBe('image/jpeg');
    expect(
      validarComprovante(PDF, 'guia.PDF', 'application/pdf; charset=binary').tipo,
    ).toBe('application/pdf');
  });
});

describe('tamanho e quantidade', () => {
  it('aceita até 5 MB exatos e recusa 1 byte a mais', () => {
    const limite = new Uint8Array(TAMANHO_MAXIMO_DO_COMPROVANTE);
    limite.set(PDF);
    expect(validarComprovante(limite, 'g.pdf', undefined).tamanho).toBe(5 * 1024 * 1024);
    const acima = new Uint8Array(TAMANHO_MAXIMO_DO_COMPROVANTE + 1);
    acima.set(PDF);
    try {
      validarComprovante(acima, 'g.pdf', undefined);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ComprovanteInvalidoError);
      expect((e as ComprovanteInvalidoError).motivo).toBe('arquivo_grande');
    }
  });

  it('recusa arquivo vazio ou que não é bytes', () => {
    for (const ruim of [new Uint8Array(), undefined, null, 'texto', {}]) {
      expect(() => validarComprovante(ruim, 'g.pdf', undefined)).toThrow(
        ComprovanteInvalidoError,
      );
    }
  });

  it('o teto é de 5 comprovantes por lançamento', () => {
    expect(LIMITE_COMPROVANTES_POR_LANCAMENTO).toBe(5);
  });

  it('as mensagens não repetem o nome nem o conteúdo recebidos', () => {
    try {
      validarComprovante(EXE, 'segredo-do-cliente.pdf', 'application/pdf');
    } catch (e) {
      expect((e as Error).message).not.toContain('segredo');
    }
  });
});

describe('nome seguro do arquivo', () => {
  it('tira caminho, controle e caracteres proibidos, e põe a extensão do tipo REAL', () => {
    expect(sanearNomeDoComprovante('C:\\pasta\\..\\guia?*.pdf', 'application/pdf')).toBe(
      'guia.pdf',
    );
    expect(sanearNomeDoComprovante('../../etc/passwd', 'image/png')).toBe('passwd.png');
    expect(sanearNomeDoComprovante('recibo.pdf', 'image/png')).toBe('recibo.png');
    expect(sanearNomeDoComprovante('foto.jpeg', 'image/jpeg')).toBe('foto.jpg');
    expect(sanearNomeDoComprovante('a\u0000b\u001fc\td.pdf', 'application/pdf')).toBe(
      'a b c d.pdf',
    );
  });

  it('nome vazio, só ponto ou só símbolo vira "comprovante"; nome longo é cortado em 100', () => {
    for (const n of ['', '   ', '.pdf', '...', '<>:"|?*', undefined, 42]) {
      expect(sanearNomeDoComprovante(n, 'application/pdf')).toBe('comprovante.pdf');
    }
    const longo = sanearNomeDoComprovante('x'.repeat(500) + '.pdf', 'application/pdf');
    expect(longo.length).toBeLessThanOrEqual(100);
    expect(longo.endsWith('.pdf')).toBe(true);
  });
});
