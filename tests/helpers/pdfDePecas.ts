import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PNG_1X1 } from './leitor.js';

/**
 * PDFs SINTÉTICOS de peça, gerados por biblioteca (pdf-lib, que já é dependência): um texto
 * por página, quebrado em linhas. Texto inventado, sempre — o repositório é público.
 */

const LARGURA_DA_LINHA = 88;

function quebrar(texto: string): string[] {
  const linhas: string[] = [];
  for (const paragrafo of texto.split('\n')) {
    let atual = '';
    for (const palavra of paragrafo.split(/\s+/).filter(Boolean)) {
      if ((atual + ' ' + palavra).trim().length > LARGURA_DA_LINHA) {
        linhas.push(atual);
        atual = palavra;
      } else {
        atual = (atual + ' ' + palavra).trim();
      }
    }
    linhas.push(atual);
  }
  return linhas;
}

/** Uma página de PDF por entrada de `paginas`, com texto pesquisável. */
export async function pdfComPaginas(paginas: readonly string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonte = await doc.embedFont(StandardFonts.Helvetica);
  for (const texto of paginas) {
    const pagina = doc.addPage([595, 842]);
    let y = 800;
    for (const linha of quebrar(texto)) {
      if (y < 40) break;
      pagina.drawText(linha, { x: 40, y, font: fonte, size: 9 });
      y -= 12;
    }
  }
  return doc.save();
}

/** Página só com imagem: o que um PDF escaneado é, para quem não faz OCR (sem camada de texto). */
export async function pdfSoComImagem(paginas: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const imagem = await doc.embedPng(PNG_1X1);
  for (let i = 0; i < paginas; i++) {
    const p = doc.addPage([595, 842]);
    p.drawImage(imagem, { x: 0, y: 0, width: 595, height: 842 });
  }
  return doc.save();
}

/** PDF com senha de abertura, pelo `qpdf` (a mesma ferramenta que o leitor exige). */
export function pdfComSenha(bytes: Uint8Array): Uint8Array {
  const pasta = mkdtempSync(join(tmpdir(), 'pv-pdf-senha-'));
  try {
    const entrada = join(pasta, 'a.pdf');
    const saida = join(pasta, 'b.pdf');
    writeFileSync(entrada, bytes);
    execFileSync('qpdf', [
      '--encrypt',
      'senha-de-teste',
      'dono-de-teste',
      '256',
      '--',
      entrada,
      saida,
    ]);
    return readFileSync(saida);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}
