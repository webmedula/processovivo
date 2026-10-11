import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  lerRespostaSoap,
  resolverReferencia,
} from '../../src/infrastructure/adapters/mni/mtom.js';
import { abrirEnvelope } from '../../src/infrastructure/adapters/mni/mni.mapper.js';

/**
 * Estes testes rodam contra a resposta REAL do TJGO, byte a byte como o
 * servidor mandou — `tests/fixtures/mni-tjgo-credencial-invalida-real.txt`,
 * capturada em 10/09/2026 contra
 * https://projudi.tjgo.jus.br/IntercomunicacaoService.
 *
 * Foi essa captura que revelou as duas armadilhas do serviço, e nenhuma das
 * duas apareceria num fixture escrito por quem implementa: a resposta vem em
 * `multipart/related` (Apache CXF, com XOP/MTOM) em vez de XML puro, e a recusa
 * vem com **HTTP 200**.
 */

const CONTENT_TYPE_REAL =
  'multipart/related; type="application/xop+xml"; ' +
  'boundary="uuid:5551fcba-b61b-4556-b676-8f6a8785c53f"; ' +
  'start="<root.message@cxf.apache.org>"; start-info="text/xml"';

function capturaReal(): Uint8Array {
  return new Uint8Array(
    readFileSync(join(__dirname, '../fixtures/mni-tjgo-credencial-invalida-real.txt')),
  );
}

describe('MTOM — resposta real do MNI/TJGO', () => {
  it('extrai o envelope SOAP de dentro do multipart', () => {
    const { xml } = lerRespostaSoap(CONTENT_TYPE_REAL, capturaReal());

    expect(xml.startsWith('<soap:Envelope')).toBe(true);
    expect(xml).toContain('consultarProcessoResposta');
    // O delimitador do multipart não pode sobrar no XML: é o que quebraria
    // qualquer parser chamado direto sobre o corpo.
    expect(xml).not.toContain('--uuid:');
  });

  it('lê a recusa mesmo com o serviço respondendo HTTP 200', () => {
    const { xml } = lerRespostaSoap(CONTENT_TYPE_REAL, capturaReal());
    const resposta = abrirEnvelope(xml);

    expect(resposta.sucesso).toBe(false);
    expect(resposta.mensagem).toBe('Usuário ou Senha inválida.');
  });

  it('não confunde a parte raiz com anexo', () => {
    const { anexos } = lerRespostaSoap(CONTENT_TYPE_REAL, capturaReal());
    expect(anexos.size).toBe(0);
  });

  it('aceita resposta em XML puro, sem multipart', () => {
    const xml =
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns:r xmlns:ns="x"><sucesso>true</sucesso></ns:r></soap:Body></soap:Envelope>';
    const lida = lerRespostaSoap('text/xml;charset=UTF-8', Buffer.from(xml));

    expect(abrirEnvelope(lida.xml).sucesso).toBe(true);
  });
});

describe('MTOM — anexos binários', () => {
  const BOUNDARY = 'limite-de-teste';
  const CONTENT_TYPE = `multipart/related; boundary="${BOUNDARY}"; start="<raiz@processovivo>"`;

  /**
   * PDF mínimo com bytes que NÃO são UTF-8 válido (0xFF, 0xFE, 0x00). São eles
   * que provam a razão de o cliente HTTP ler bytes e não texto: por `text()`,
   * viram U+FFFD e o arquivo sai corrompido sem erro nenhum.
   */
  const BINARIO = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x0a, 0x25]);

  function montarMultipart(): Uint8Array {
    const partes = [
      `--${BOUNDARY}\r\n`,
      'Content-Type: application/xop+xml\r\n',
      'Content-ID: <raiz@processovivo>\r\n\r\n',
      '<xml/>\r\n',
      `--${BOUNDARY}\r\n`,
      'Content-Type: application/pdf\r\n',
      'Content-Transfer-Encoding: binary\r\n',
      'Content-ID: <peca-1@processovivo>\r\n\r\n',
    ].join('');

    return new Uint8Array(
      Buffer.concat([
        Buffer.from(partes, 'ascii'),
        BINARIO,
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'ascii'),
      ]),
    );
  }

  it('devolve os bytes do anexo sem alterar um único byte', () => {
    const { anexos } = lerRespostaSoap(CONTENT_TYPE, montarMultipart());
    const bytes = resolverReferencia('cid:peca-1@processovivo', anexos);

    expect(bytes).toBeDefined();
    expect(Buffer.from(bytes as Uint8Array).equals(BINARIO)).toBe(true);
  });

  it('não deixa o CRLF do delimitador colado no fim do arquivo', () => {
    const { anexos } = lerRespostaSoap(CONTENT_TYPE, montarMultipart());
    const bytes = resolverReferencia('cid:peca-1@processovivo', anexos) as Uint8Array;

    expect(bytes.length).toBe(BINARIO.length);
  });

  it('decodifica anexo enviado em base64', () => {
    const corpo = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-ID: <raiz@processovivo>\r\n\r\n<xml/>\r\n` +
          `--${BOUNDARY}\r\nContent-Transfer-Encoding: base64\r\n` +
          `Content-ID: <b64@processovivo>\r\n\r\n`,
        'ascii',
      ),
      Buffer.from(BINARIO.toString('base64'), 'ascii'),
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'ascii'),
    ]);

    const { anexos } = lerRespostaSoap(CONTENT_TYPE, new Uint8Array(corpo));
    const bytes = resolverReferencia('cid:b64@processovivo', anexos) as Uint8Array;

    expect(Buffer.from(bytes).equals(BINARIO)).toBe(true);
  });

  it('devolve indefinido quando a referência não aponta para parte alguma', () => {
    const { anexos } = lerRespostaSoap(CONTENT_TYPE, montarMultipart());
    // Referência quebrada é dado corrompido, não arquivo vazio — e os dois
    // casos não podem virar o mesmo valor.
    expect(resolverReferencia('cid:nao-existe@processovivo', anexos)).toBeUndefined();
  });
});
