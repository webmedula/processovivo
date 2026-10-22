import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PecaEmCache } from '../../src/domain/entities/PastaDigital.js';
import { ArmazemEmDisco } from '../../src/infrastructure/arquivos/ArmazemEmDisco.js';
import { PdftotextExtrator } from '../../src/infrastructure/pdf/PdftotextExtrator.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDaPastaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDaPastaSqlite.js';
import {
  caminhoDaPeca,
  executarMedicaoDeTexto,
} from '../../src/main/sonda/medicaoDeTextoDePecas.js';
import { pdfComPaginas, pdfSoComImagem } from '../helpers/pdfDePecas.js';

/* Banco e disco temporários; peças e identificadores inventados. */
const WORKSPACE = 'ws-identificador-secreto-0001';
const NUMERO = '99999019620268099999';
const SEGREDO = 'SEGREDO-NA-PECA-QUE-NAO-PODE-SAIR';
const TEXTO =
  `${SEGREDO}. A parte autora pede a condenação da ré ao pagamento de indenização e juntou documentos ` +
  'para comprovar os fatos narrados na petição inventada para este teste de medição.';

let pasta: string;
let caminhoBanco: string;
let raiz: string;
const agora = new Date('2026-10-22T12:00:00Z');

beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), 'pv-medir-'));
  caminhoBanco = join(pasta, 'p.db');
  raiz = join(pasta, 'leitor');
});
afterEach(() => rmSync(pasta, { recursive: true, force: true }));

async function guardar(
  id: string,
  bytes: Uint8Array,
  paginas: number,
  opcoes: {
    conversao?: 'nenhuma' | 'imagem';
    expiraEm?: Date;
    semArquivo?: boolean;
  } = {},
): Promise<void> {
  const db = abrirBanco(caminhoBanco);
  const armazem = new ArmazemEmDisco(raiz);
  const localizador = opcoes.semArquivo
    ? armazem.novoArquivo(WORKSPACE, 'a'.repeat(32), 'pdf')
    : await armazem.gravarArquivo(WORKSPACE, 'a'.repeat(32), bytes, 'pdf');
  const peca: PecaEmCache = {
    workspace: WORKSPACE,
    numeroProcesso: NUMERO,
    pecaId: id,
    localizador,
    mimetypeOriginal: 'application/pdf',
    conversao: opcoes.conversao ?? 'nenhuma',
    bytes: bytes.length,
    paginas,
    obtidaEm: agora,
    expiraEm: opcoes.expiraEm ?? new Date(agora.getTime() + 3_600_000),
  };
  await new RepositorioDaPastaSqlite(db).guardarPeca(peca);
  db.close();
}

async function medir(): Promise<{ codigo: number; saida: string; aviso: string }> {
  const saida: string[] = [];
  const aviso: string[] = [];
  const codigo = await executarMedicaoDeTexto([], {
    caminhoBanco,
    pastaDasPecas: raiz,
    extrator: new PdftotextExtrator(),
    lerArquivo: (c) => readFile(c).catch(() => undefined),
    existeArquivo: (c) => existsSync(c),
    agora: () => agora,
    saida: (l) => saida.push(l),
    aviso: (l) => aviso.push(l),
  });
  return { codigo, saida: saida.join('\n'), aviso: aviso.join('\n') };
}

describe('medição da camada de texto das peças (somente leitura)', () => {
  it('o caminho calculado é o MESMO do armazém em disco', async () => {
    const armazem = new ArmazemEmDisco(raiz);
    const localizador = await armazem.gravarArquivo(
      WORKSPACE,
      'b'.repeat(32),
      new Uint8Array([1]),
      'pdf',
    );
    expect(caminhoDaPeca(raiz, WORKSPACE, localizador)).toBe(
      await armazem.caminhoLocal(WORKSPACE, localizador),
    );
    expect(() => caminhoDaPeca(raiz, WORKSPACE, '../fora.pdf')).toThrow();
    expect(() => caminhoDaPeca(raiz, WORKSPACE, '/etc/passwd')).toThrow();
  });

  it('agrega: % com texto, escaneadas, distribuição, limites, falhas e tempo — só números', async () => {
    await guardar('p1', await pdfComPaginas([TEXTO, TEXTO]), 2);
    await guardar('p2', await pdfComPaginas([TEXTO]), 1);
    await guardar('p3', await pdfSoComImagem(3), 3, { conversao: 'imagem' });
    await guardar('p4', new Uint8Array(Buffer.from('%PDF-1.4 lixo sem fim')), 2); // corrompido
    await guardar('p5', await pdfComPaginas([TEXTO]), 55); // diz 55 páginas no banco: acima do limite
    await guardar('p6', new Uint8Array(), 1, { semArquivo: true }); // arquivo sumiu do disco
    await guardar('p7', await pdfComPaginas([TEXTO]), 1, {
      expiraEm: new Date(agora.getTime() - 1),
    }); // vencida: fora

    const r = await medir();
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('Peças na guarda: 6 · lidas: 4 · arquivo ausente: 1');
    expect(r.saida).toContain('Com texto pesquisável: 75.0% (3 de 4)');
    expect(r.saida).toContain('Sem texto (escaneadas, sem OCR): 25.0% (1 de 4)');
    expect(r.saida).toContain('Acima de 40 páginas: 16.7% (1 de 6)');
    expect(r.saida).toMatch(/Falhas de extração: 20\.0% \(1 de 5\) · pdf_invalido: 1/);
    expect(r.saida).toContain(
      'Elegíveis para análise (texto pesquisável e dentro dos dois limites): 50.0% (2 de 4)',
    );
    expect(r.saida).toMatch(
      /Páginas \(de todas as peças\): p50 \d+ · p95 55 · máximo 55/,
    );
    expect(r.saida).toMatch(/Tempo de extração por peça: p50 \d+ ms · p95 \d+ ms/);
    expect(r.saida).toContain('PDF do tribunal: 5');
    expect(r.saida).toContain('convertido de imagem: 1');
    expect(r.saida).toContain('ATENÇÃO: amostra pequena');
  });

  it('nunca imprime texto de peça, número de processo, workspace nem localizador', async () => {
    await guardar('peca-id-sensivel', await pdfComPaginas([TEXTO]), 1);
    const r = await medir();
    const tudo = `${r.saida}\n${r.aviso}`;
    expect(tudo).not.toContain('SEGREDO');
    expect(tudo).not.toContain(NUMERO);
    expect(tudo).not.toContain(WORKSPACE);
    expect(tudo).not.toContain('peca-id-sensivel');
    expect(tudo).not.toMatch(/[0-9a-f]{32}/);
  });

  it('é somente leitura: banco idêntico antes e depois, e banco inexistente não é criado', async () => {
    await guardar('p1', await pdfComPaginas([TEXTO]), 1);
    const antes = readFileSync(caminhoBanco);
    const mtime = statSync(caminhoBanco).mtimeMs;
    await medir();
    expect(readFileSync(caminhoBanco).equals(antes)).toBe(true);
    expect(statSync(caminhoBanco).mtimeMs).toBe(mtime);

    caminhoBanco = join(pasta, 'nao-existe.db');
    const r = await medir();
    expect(r.codigo).toBe(1);
    expect(existsSync(caminhoBanco)).toBe(false);
  });

  it('sem peças na guarda: diz isso, sem erro', async () => {
    abrirBanco(caminhoBanco).close();
    const r = await medir();
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('Nenhuma peça na guarda agora');
  });
});
