import { describe, expect, it } from 'vitest';
import {
  LIMITE_DO_NOME_DO_ARQUIVO,
  nomeDoArquivoNoDrive,
  sanearParteDoNome,
} from '../../src/domain/entities/nomeDoArquivoNoDrive.js';

// Dados SINTÉTICOS: o repositório é público.
const DATA = new Date('2026-10-14T15:00:00.000Z');

describe('nome do arquivo no Drive', () => {
  it('segue o formato "NNNN - Rótulo - dd-mm-aaaa.pdf", com o número do ato em 4 dígitos', () => {
    expect(
      nomeDoArquivoNoDrive({
        numeroDoAto: 123,
        rotulo: 'Decisão',
        data: DATA,
        pecaId: 'p1',
      }),
    ).toBe('0123 - Decisão - 14-10-2026.pdf');
  });

  it('usa o fuso de São Paulo: 01h UTC ainda é o dia anterior no Brasil', () => {
    const noite = new Date('2026-10-15T01:30:00.000Z');
    expect(
      nomeDoArquivoNoDrive({
        numeroDoAto: 7,
        rotulo: 'Despacho',
        data: noite,
        pecaId: 'p',
      }),
    ).toBe('0007 - Despacho - 14-10-2026.pdf');
  });

  it('não inventa número nem data que a Pasta não mostra', () => {
    expect(nomeDoArquivoNoDrive({ rotulo: 'Laudo pericial', pecaId: 'p' })).toBe(
      'Laudo pericial.pdf',
    );
    expect(nomeDoArquivoNoDrive({ numeroDoAto: 0, rotulo: 'Laudo', pecaId: 'p' })).toBe(
      'Laudo.pdf',
    );
    expect(
      nomeDoArquivoNoDrive({
        numeroDoAto: 5,
        rotulo: 'Laudo',
        data: new Date('lixo'),
        pecaId: 'p',
      }),
    ).toBe('0005 - Laudo.pdf');
  });

  it('número acima de 9999 aparece inteiro, sem cortar', () => {
    expect(
      nomeDoArquivoNoDrive({ numeroDoAto: 12345, rotulo: 'Outros', pecaId: 'p' }),
    ).toBe('12345 - Outros.pdf');
  });

  it('peça convertida leva o marcador da conversão, como a Pasta diz que é conversão', () => {
    expect(
      nomeDoArquivoNoDrive({
        numeroDoAto: 9,
        rotulo: 'Decisão',
        data: DATA,
        conversao: 'html',
        pecaId: 'p',
      }),
    ).toBe('0009 - Decisão - 14-10-2026 (conversão de HTML).pdf');
    expect(
      nomeDoArquivoNoDrive({ rotulo: 'Foto', conversao: 'imagem', pecaId: 'p' }),
    ).toBe('Foto (conversão de imagem).pdf');
  });

  it('peças de nome igual ganham (2), (3) na ordem em que aparecem', () => {
    const base = { numeroDoAto: 3, rotulo: 'Outros', data: DATA, pecaId: 'p' };
    expect(nomeDoArquivoNoDrive({ ...base, ocorrencia: 1 })).toBe(
      '0003 - Outros - 14-10-2026.pdf',
    );
    expect(nomeDoArquivoNoDrive({ ...base, ocorrencia: 2 })).toBe(
      '0003 - Outros - 14-10-2026 (2).pdf',
    );
  });

  it('sanitiza: sem barra, sem controle, sem os caracteres que o Windows proíbe', () => {
    const sujo =
      'Petição/inicial\\final: "urgente"?*<>|\u0000\u0007\u001f\u007f\u0085 fim';
    const nome = nomeDoArquivoNoDrive({ numeroDoAto: 1, rotulo: sujo, pecaId: 'p' });
    expect(nome).not.toMatch(/[/\\:*?"<>|]/);
    // eslint-disable-next-line no-control-regex
    expect(nome).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(nome).toBe('0001 - Petição inicial final urgente fim.pdf');
  });

  it('colapsa espaços e tira pontos e espaços das pontas', () => {
    expect(sanearParteDoNome('  ..  Petição   -   inicial ..  ')).toBe(
      'Petição - inicial',
    );
  });

  it('o tamanho tem teto, e o rótulo é o que cede (prefixo, data e marcador ficam)', () => {
    const longo = 'Palavra '.repeat(80);
    const nome = nomeDoArquivoNoDrive({
      numeroDoAto: 42,
      rotulo: longo,
      data: DATA,
      conversao: 'html',
      pecaId: 'p',
    });
    expect(nome.length).toBeLessThanOrEqual(LIMITE_DO_NOME_DO_ARQUIVO);
    expect(nome.startsWith('0042 - Palavra')).toBe(true);
    expect(nome.endsWith(' - 14-10-2026 (conversão de HTML).pdf')).toBe(true);
    expect(nome).toContain('…');
  });

  it('rótulo vazio depois da limpeza cai num nome a partir do id da peça', () => {
    expect(
      nomeDoArquivoNoDrive({ numeroDoAto: 2, rotulo: '///', pecaId: 'abc123' }),
    ).toBe('0002 - peça abc123.pdf');
  });
});
