import { describe, expect, it } from 'vitest';
import { SCRIPT_ATUALIZACOES } from '../../src/main/http/ui/atualizacoes.js';
import {
  contarForaDosFiltros,
  filtrarPorNumero,
} from '../../src/main/http/ui/tabelaAtualizacoes.js';

/*
 * v0.41.0 — a busca pelo NÚMERO na aba Atualizações. Números sintéticos, de 20
 * dígitos (a máscara CNJ é só exibição). A função é a MESMA que o navegador
 * recebe por toString().
 */
const A = '51234567820248090051'; // 5123456-78.2024.8.09.0051
const B = '00076521220228260224';
const C = '99887761120258130999';
const linhas = [A, B, C].map((numero) => ({ numero }));
const numeros = (l: ReadonlyArray<{ numero: string }>): string[] =>
  l.map((x) => x.numero);

describe('filtrarPorNumero', () => {
  it('compara só dígitos: com máscara, sem máscara e com lixo no meio', () => {
    expect(numeros(filtrarPorNumero(linhas, '5123456-78.2024.8.09.0051'))).toEqual([A]);
    expect(numeros(filtrarPorNumero(linhas, '51234567820248090051'))).toEqual([A]);
    expect(numeros(filtrarPorNumero(linhas, ' 5123 456/78 '))).toEqual([A]);
  });

  it('o número da linha também pode vir com máscara', () => {
    const mascarado = [{ numero: '5123456-78.2024.8.09.0051' }];
    expect(filtrarPorNumero(mascarado, '2024809')).toHaveLength(1);
  });

  it('casa por trecho: começo, meio e fim', () => {
    expect(numeros(filtrarPorNumero(linhas, '5123456'))).toEqual([A]); // sequencial
    expect(numeros(filtrarPorNumero(linhas, '2024809'))).toEqual([A]); // meio
    expect(numeros(filtrarPorNumero(linhas, '0224'))).toEqual([B]); // origem, no fim
  });

  it('quando o trecho casa em várias linhas, devolve todas na ordem recebida', () => {
    const duas = [{ numero: '11112222333344445555' }, { numero: '99991222233339999999' }];
    expect(numeros(filtrarPorNumero(duas, '1222'))).toEqual([
      '11112222333344445555',
      '99991222233339999999',
    ]);
  });

  it('com menos de 4 dígitos não filtra: devolve a lista inteira', () => {
    for (const termo of ['5', '51', '512', '5-1.2'])
      expect(numeros(filtrarPorNumero(linhas, termo))).toEqual([A, B, C]);
  });

  it('com exatamente 4 dígitos já filtra', () => {
    expect(numeros(filtrarPorNumero(linhas, '5123'))).toEqual([A]);
  });

  it('termo vazio ou sem nenhum dígito devolve a lista inteira', () => {
    for (const termo of ['', '   ', 'abc', '-.-/'])
      expect(numeros(filtrarPorNumero(linhas, termo))).toEqual([A, B, C]);
  });

  it('termo válido que não casa devolve lista vazia', () => {
    expect(filtrarPorNumero(linhas, '1212121')).toEqual([]);
  });

  it('lista vazia continua vazia, com ou sem termo', () => {
    expect(filtrarPorNumero([], '5123456')).toEqual([]);
    expect(filtrarPorNumero([], '')).toEqual([]);
  });

  it('devolve cópia: nunca a mesma lista, nem sem filtrar', () => {
    expect(filtrarPorNumero(linhas, '')).not.toBe(linhas);
  });

  it('serve a linha com e sem novidade: só o campo numero importa', () => {
    const mista = [
      { numero: A, semNovidade: true as const },
      { numero: B, maisRecente: { data: null } },
    ];
    expect(filtrarPorNumero(mista, '0007652')).toEqual([mista[1]]);
    expect(filtrarPorNumero(mista, '5123456')).toEqual([mista[0]]);
  });

  it('não busca parte, classe, tribunal nem texto do ato', () => {
    const l = [
      {
        numero: A,
        processo: { tribunal: 'TJGO 7777', classe: 'Classe 7777' },
        texto: 'ato 7777',
      },
    ];
    expect(filtrarPorNumero(l, '7777')).toEqual([]);
  });
});

describe('contarForaDosFiltros', () => {
  // Base (Período + Tribunal já aplicados): A, B, C. A Situação deixa só A visível.
  const base = [A, B, C].map((numero) => ({ numero }));
  const visiveis = [{ numero: A }];
  const FORA_PERIODO = '12345670000000000001';
  const FORA_TRIBUNAL = '12345670000000000002';

  it('termo com menos de 4 dígitos não conta nada e não é válido', () => {
    expect(
      contarForaDosFiltros('123', base, visiveis, [FORA_PERIODO], [FORA_TRIBUNAL]),
    ).toEqual({
      valido: false,
      situacao: 0,
      periodo: 0,
      tribunal: 0,
    });
    expect(contarForaDosFiltros('', base, visiveis, [], []).valido).toBe(false);
  });

  it('fora da Situação: casa na base e o filtro de Situação esconde', () => {
    const r = contarForaDosFiltros('0007652', base, visiveis, [], []);
    expect(r).toEqual({ valido: true, situacao: 1, periodo: 0, tribunal: 0 });
  });

  it('o que está visível não conta como fora', () => {
    const r = contarForaDosFiltros('5123456', base, visiveis, [], []);
    expect(r).toEqual({ valido: true, situacao: 0, periodo: 0, tribunal: 0 });
  });

  it('fora do Período: casa entre os números que o servidor deixou fora da janela', () => {
    const r = contarForaDosFiltros('4567000000', base, base, [FORA_PERIODO], []);
    expect(r).toEqual({ valido: true, situacao: 0, periodo: 1, tribunal: 0 });
  });

  it('fora do Tribunal: casa entre os números de outro tribunal', () => {
    const r = contarForaDosFiltros('4567000000', base, base, [], [FORA_TRIBUNAL]);
    expect(r).toEqual({ valido: true, situacao: 0, periodo: 0, tribunal: 1 });
  });

  it('listas ausentes (servidor antigo) não dão erro: a tela só não conta o que não sabe', () => {
    const r = contarForaDosFiltros('4567000000', base, base, undefined, null);
    expect(r).toEqual({ valido: true, situacao: 0, periodo: 0, tribunal: 0 });
  });

  it('processo fora por dois motivos conta UMA vez, no primeiro da ordem Situação, Período, Tribunal', () => {
    // Período + Tribunal: conta em Período.
    const dois = contarForaDosFiltros(
      '4567000000',
      base,
      base,
      [FORA_PERIODO],
      [FORA_PERIODO],
    );
    expect(dois).toEqual({ valido: true, situacao: 0, periodo: 1, tribunal: 0 });
    // Presente na base e também nas listas do servidor (não deveria, mas não pode contar duas vezes).
    const repetido = contarForaDosFiltros('0007652', base, visiveis, [B], [B]);
    expect(repetido).toEqual({ valido: true, situacao: 1, periodo: 0, tribunal: 0 });
  });

  it('o mesmo número repetido na lista conta uma vez; máscara não cria casamento duplo', () => {
    const r = contarForaDosFiltros(
      '4567000000',
      base,
      base,
      [FORA_PERIODO, '1234567-00.0000.0.00.0001'],
      [],
    );
    expect(r.periodo).toBe(1);
  });

  it('os três motivos juntos somam sem repetir', () => {
    const b = [{ numero: '11110000000000000001' }, { numero: '11110000000000000002' }];
    const r = contarForaDosFiltros(
      '1111000',
      b,
      [b[0] as { numero: string }],
      ['11110000000000000003', '11110000000000000004'],
      ['11110000000000000004', '11110000000000000005'],
    );
    expect(r).toEqual({ valido: true, situacao: 1, periodo: 2, tribunal: 1 });
  });

  it('só conta o que casa com o termo', () => {
    const r = contarForaDosFiltros(
      '9999999',
      base,
      visiveis,
      [FORA_PERIODO],
      [FORA_TRIBUNAL],
    );
    expect(r).toEqual({ valido: true, situacao: 0, periodo: 0, tribunal: 0 });
  });
});

describe('a busca no script da página', () => {
  it('injeta as duas funções puras (a mesma que o teste exercita)', () => {
    expect(SCRIPT_ATUALIZACOES).toContain('var filtrarPorNumero=');
    expect(SCRIPT_ATUALIZACOES).toContain('var contarForaDosFiltros=');
  });

  it('o termo nunca vai para localStorage', () => {
    expect(SCRIPT_ATUALIZACOES).not.toMatch(/localStorage|sessionStorage/);
  });

  it('o número do período no aviso vem do servidor, não escrito no código', () => {
    expect(SCRIPT_ATUALIZACOES).toContain(
      "' fora dos últimos '+R.janelaPadraoDias+' dias'",
    );
  });
});
