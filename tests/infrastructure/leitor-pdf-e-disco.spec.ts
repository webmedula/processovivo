import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PdfInvalidoError } from '../../src/domain/errors/index.js';
import { ArmazemEmDisco } from '../../src/infrastructure/arquivos/ArmazemEmDisco.js';
import { QpdfMontador, paraWinAnsi } from '../../src/infrastructure/pdf/QpdfMontador.js';
import {
  PNG_1X1,
  marcasDasPaginas,
  pastaTemporaria,
  pdfSintetico,
} from '../helpers/leitor.js';

let pasta: ReturnType<typeof pastaTemporaria>;
beforeEach(() => {
  pasta = pastaTemporaria();
});
afterEach(() => {
  pasta.apagar();
});

function gravar(nome: string, bytes: Uint8Array): string {
  const caminho = join(pasta.caminho, nome);
  writeFileSync(caminho, bytes);
  return caminho;
}

describe('QpdfMontador', () => {
  const montador = new QpdfMontador();

  it('o qpdf está instalado — sem ele o leitor não sobe (Dockerfile: apk add qpdf)', () => {
    expect(QpdfMontador.disponivelSync()).toBe(true);
  });

  it('conta páginas e reconhece arquivo que não é PDF', async () => {
    const bom = gravar('bom.pdf', await pdfSintetico(4, 'B'));
    const ruim = gravar('ruim.pdf', new Uint8Array(Buffer.from('não sou pdf')));
    expect(await montador.inspecionarPdf(bom)).toEqual({ valido: true, paginas: 4 });
    expect(await montador.inspecionarPdf(ruim)).toEqual({
      valido: false,
      motivo: 'pdf_invalido',
    });
  });

  it('reconhece PDF protegido por senha', async () => {
    const aberto = gravar('aberto.pdf', await pdfSintetico(1, 'P'));
    const fechado = join(pasta.caminho, 'fechado.pdf');
    execFileSync('qpdf', ['--encrypt', 'usuario', 'dono', '256', '--', aberto, fechado]);
    expect(await montador.inspecionarPdf(fechado)).toEqual({
      valido: false,
      motivo: 'pdf_protegido',
    });
  });

  it('junta na ordem das partes, com intervalos de página, e confere o total', async () => {
    const a = gravar('a.pdf', await pdfSintetico(2, 'A'));
    const b = gravar('b.pdf', await pdfSintetico(3, 'B'));
    const saida = join(pasta.caminho, 'saida.pdf');
    const r = await montador.montar(
      [{ arquivo: b, paginas: [2, 3] }, { arquivo: a }],
      saida,
    );

    expect(r.paginasPorParte).toEqual([2, 2]);
    expect(r.paginas).toBe(4);
    expect(await marcasDasPaginas(readFileSync(saida))).toEqual([
      'B-p2',
      'B-p3',
      'A-p1',
      'A-p2',
    ]);
  });

  it('lineariza o arquivo, para o PDF.js abrir a primeira página sem baixar tudo', async () => {
    const a = gravar('a.pdf', await pdfSintetico(2, 'A'));
    const saida = join(pasta.caminho, 'lin.pdf');
    await montador.montar([{ arquivo: a }], saida);
    const r = execFileSync('qpdf', ['--check-linearization', saida]).toString();
    expect(r).toContain('no linearization errors');
  });

  it('caminho com aspas, espaço e $() é argumento, nunca comando de shell', async () => {
    const nome = 'peça "x" $(touch PWNED) ; rm -rf.pdf';
    const a = gravar(nome, await pdfSintetico(1, 'A'));
    const saida = join(pasta.caminho, 'saida.pdf');
    await montador.montar([{ arquivo: a }], saida);
    expect(() => readFileSync(join(pasta.caminho, 'PWNED'))).toThrow();
    expect(await marcasDasPaginas(readFileSync(saida))).toEqual(['A-p1']);
  });

  it('parte ilegível na hora de montar derruba a montagem em vez de gerar índice torto', async () => {
    const ruim = gravar('ruim.pdf', new Uint8Array(Buffer.from('%PDF-1.4 lixo')));
    await expect(
      montador.montar([{ arquivo: ruim }], join(pasta.caminho, 's.pdf')),
    ).rejects.toBeInstanceOf(PdfInvalidoError);
  });

  it('converte PNG em página A4 e recusa imagem corrompida sem lançar', async () => {
    const png = gravar('f.png', PNG_1X1);
    const lixo = gravar('l.png', new Uint8Array([1, 2, 3]));
    const destino = join(pasta.caminho, 'img.pdf');
    expect(await montador.converterImagem(png, 'image/png', destino)).toBe(true);
    expect(await montador.inspecionarPdf(destino)).toEqual({ valido: true, paginas: 1 });
    expect(
      await montador.converterImagem(lixo, 'image/png', join(pasta.caminho, 'x.pdf')),
    ).toBe(false);
  });

  it('página de aviso aguenta rótulo com caractere que a fonte padrão não desenha', async () => {
    const destino = join(pasta.caminho, 'avisos.pdf');
    await montador.gerarAvisos(
      [
        { titulo: 'Peça ≈ "Outros" 📎', linhas: ['ação, petição, ç, º, §, —'] },
        { titulo: 'Segunda', linhas: [] },
      ],
      destino,
    );
    expect(await montador.inspecionarPdf(destino)).toEqual({ valido: true, paginas: 2 });
    expect(paraWinAnsi('ação ≈ 📎 —')).toBe('ação ? ? —');
  });
});

describe('ArmazemEmDisco', () => {
  const JOB = 'a'.repeat(32);

  it('o localizador de um workspace não abre arquivo de outro', async () => {
    const armazem = new ArmazemEmDisco(pasta.caminho);
    const loc = await armazem.gravarPeca('ws-a', JOB, 0, new Uint8Array([1, 2, 3]));
    expect(await armazem.tamanho('ws-a', loc)).toBe(3);
    expect(await armazem.tamanho('ws-b', loc)).toBeUndefined();
  });

  it('recusa localizador que escapa da pasta do workspace', async () => {
    const armazem = new ArmazemEmDisco(pasta.caminho);
    await expect(armazem.caminhoLocal('ws-a', '../outro/arquivo.pdf')).rejects.toThrow();
    await expect(armazem.caminhoLocal('ws-a', '/etc/passwd')).rejects.toThrow();
    expect(() => armazem.novoArquivo('ws-a', '../x', 'pdf')).toThrow();
  });

  it('a peça leva a extensão do tipo declarado: PDF termina em .pdf (perfil AppArmor do qpdf no Ubuntu 26.04)', async () => {
    const armazem = new ArmazemEmDisco(pasta.caminho);
    expect(await armazem.gravarPeca('ws', JOB, 0, new Uint8Array(1), 'pdf')).toMatch(/\/0\.pdf$/);
    expect(await armazem.gravarPeca('ws', JOB, 1, new Uint8Array(1))).toMatch(/\/1\.bin$/);
    // Extensão estranha não vira caminho: só letras e dígitos, até 8.
    expect(await armazem.gravarPeca('ws', JOB, 2, new Uint8Array(1), '../X.Y')).toMatch(
      /\/2\.xy$/,
    );
  });

  it('o nome do arquivo combinado é aleatório', () => {
    const armazem = new ArmazemEmDisco(pasta.caminho);
    const a = armazem.novoArquivo('ws', JOB, 'pdf');
    const b = armazem.novoArquivo('ws', JOB, 'pdf');
    expect(a).not.toBe(b);
    expect(a).toMatch(/[a-f0-9]{32}\.pdf$/);
  });

  it('lê só o trecho pedido', async () => {
    const armazem = new ArmazemEmDisco(pasta.caminho);
    const loc = await armazem.gravarPeca(
      'ws',
      JOB,
      1,
      new Uint8Array(Buffer.from('0123456789')),
    );
    const pedacos: Buffer[] = [];
    for await (const p of armazem.ler('ws', loc, 3, 6)) pedacos.push(Buffer.from(p));
    expect(Buffer.concat(pedacos).toString()).toBe('3456');
  });

  it('mede uso por workspace e no total, e apaga tudo do workspace', async () => {
    const armazem = new ArmazemEmDisco(pasta.caminho);
    await armazem.gravarPeca('ws-a', JOB, 0, new Uint8Array(10));
    await armazem.gravarPeca('ws-b', JOB, 0, new Uint8Array(5));
    expect(await armazem.usoDoWorkspace('ws-a')).toBe(10);
    expect(await armazem.usoTotal()).toEqual({ bytes: 15, workspaces: 2 });
    expect(await armazem.apagarWorkspace('ws-a')).toBe(10);
    expect(await armazem.usoTotal()).toEqual({ bytes: 5, workspaces: 1 });
  });
});
