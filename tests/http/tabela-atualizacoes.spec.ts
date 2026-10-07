import { describe, expect, it } from 'vitest';
import { SCRIPT_ATUALIZACOES } from '../../src/main/http/ui/atualizacoes.js';
import { descricaoDoAto } from '../../src/domain/entities/descricaoDoAto.js';
import { trechoDeTexto } from '../../src/main/http/ui/trechoDeTexto.js';
import {
  contarSituacoes,
  filtrarPorSituacao,
  ordenarGrupos,
  paginar,
  proximaOrdem,
  textoDePartes,
} from '../../src/main/http/ui/tabelaAtualizacoes.js';
import type { GrupoDaTabela } from '../../src/main/http/ui/tabelaAtualizacoes.js';

function g(
  numero: string,
  opcoes: {
    naoVistas?: number;
    providencia?: boolean;
    tribunal?: string | null;
    data?: string;
    detectada?: string;
    semProcesso?: boolean;
  } = {},
): GrupoDaTabela {
  return {
    numero,
    maisRecente: {
      data: opcoes.data ?? '2026-10-01T12:00:00.000Z',
      detectadaEm: opcoes.detectada ?? '2026-10-02T12:00:00.000Z',
    },
    quantidade: 1,
    naoVistas: opcoes.naoVistas ?? 0,
    processo: opcoes.semProcesso
      ? null
      : {
          tribunal: opcoes.tribunal === undefined ? 'TJGO' : opcoes.tribunal,
          pedeProvidencia: opcoes.providencia ?? false,
        },
  };
}

describe('filtros de situação e contadores (processos, não atualizações)', () => {
  const base = [
    g('1', { naoVistas: 3, providencia: true }),
    g('2', { naoVistas: 1 }),
    g('3', { providencia: true }),
    g('4'),
    g('5', { semProcesso: true, naoVistas: 2 }),
  ];

  it('conta PROCESSOS: um processo com três não lidas conta uma vez', () => {
    expect(contarSituacoes(base)).toEqual({ todas: 5, naoLidas: 3, pedemProvidencia: 2 });
  });

  it('o filtro devolve exatamente quantos o contador anunciou', () => {
    const c = contarSituacoes(base);
    expect(filtrarPorSituacao(base, 'todas')).toHaveLength(c.todas);
    expect(filtrarPorSituacao(base, 'naoLidas').map((x) => x.numero)).toEqual([
      '1',
      '2',
      '5',
    ]);
    expect(filtrarPorSituacao(base, 'providencia').map((x) => x.numero)).toEqual([
      '1',
      '3',
    ]);
    expect(filtrarPorSituacao(base, 'naoLidas')).toHaveLength(c.naoLidas);
    expect(filtrarPorSituacao(base, 'providencia')).toHaveLength(c.pedemProvidencia);
  });

  it('processo sem retrato guardado não "pede providência" por palpite', () => {
    expect(filtrarPorSituacao([g('9', { semProcesso: true })], 'providencia')).toEqual(
      [],
    );
  });

  it('filtrar nunca altera a lista de entrada nem a ordem de chegada', () => {
    const copia = base.map((x) => x.numero);
    filtrarPorSituacao(base, 'naoLidas');
    expect(base.map((x) => x.numero)).toEqual(copia);
    expect(filtrarPorSituacao(base, 'todas').map((x) => x.numero)).toEqual(copia);
  });

  it('lista vazia conta zero em tudo', () => {
    expect(contarSituacoes([])).toEqual({ todas: 0, naoLidas: 0, pedemProvidencia: 0 });
  });
});

describe('ordenação por cabeçalho', () => {
  const lista = [
    g('0000002-00.2026.8.09.0011', {
      tribunal: 'TJSP',
      data: '2026-10-03T00:00:00Z',
      detectada: '2026-10-05T00:00:00Z',
    }),
    g('0000001-00.2026.8.09.0011', {
      tribunal: 'TJGO',
      data: '2026-10-05T00:00:00Z',
      detectada: '2026-10-04T00:00:00Z',
    }),
    g('0000003-00.2026.8.09.0011', {
      tribunal: null,
      data: '2026-10-04T00:00:00Z',
      detectada: '2026-10-06T00:00:00Z',
    }),
    g('0000004-00.2026.8.09.0011', {
      tribunal: 'TJGO',
      data: '2026-10-05T00:00:00Z',
      detectada: '2026-10-01T00:00:00Z',
    }),
  ];
  const numeros = (o: Parameters<typeof ordenarGrupos>[1]): string[] =>
    ordenarGrupos(lista, o).map((x) => x.numero.slice(6, 7));

  it('sem ordem escolhida devolve a ordem de chegada (não inventa uma nova)', () => {
    expect(numeros(null)).toEqual(['2', '1', '3', '4']);
  });

  it('data do ato e detectado ordenam em direções opostas, sem se confundir', () => {
    expect(numeros({ chave: 'dataAto', direcao: 'desc' })).toEqual(['1', '4', '3', '2']);
    expect(numeros({ chave: 'detectado', direcao: 'desc' })).toEqual([
      '3',
      '2',
      '1',
      '4',
    ]);
    expect(numeros({ chave: 'detectado', direcao: 'asc' })).toEqual(['4', '1', '2', '3']);
  });

  it('empate é estável: segue a ordem de chegada', () => {
    // Os processos 1 e 4 têm a mesma data do ato e o mesmo tribunal.
    expect(numeros({ chave: 'dataAto', direcao: 'desc' }).slice(0, 2)).toEqual([
      '1',
      '4',
    ]);
    expect(numeros({ chave: 'tribunal', direcao: 'asc' }).slice(0, 2)).toEqual([
      '1',
      '4',
    ]);
  });

  it('tribunal sem dado vai para o fim nas duas direções — ordenar não esconde nem destaca a falta', () => {
    expect(numeros({ chave: 'tribunal', direcao: 'asc' })).toEqual(['1', '4', '2', '3']);
    expect(numeros({ chave: 'tribunal', direcao: 'desc' })).toEqual(['2', '1', '4', '3']);
  });

  it('processo ordena pelos dígitos do número', () => {
    expect(numeros({ chave: 'processo', direcao: 'asc' })).toEqual(['1', '2', '3', '4']);
    expect(numeros({ chave: 'processo', direcao: 'desc' })).toEqual(['4', '3', '2', '1']);
  });

  it('ordenar nunca perde nem duplica linha', () => {
    for (const chave of ['processo', 'tribunal', 'dataAto', 'detectado'] as const) {
      expect(ordenarGrupos(lista, { chave, direcao: 'asc' })).toHaveLength(lista.length);
    }
  });

  it('o ciclo do clique: primeira direção, inversa, volta ao padrão', () => {
    const data1 = proximaOrdem(null, 'dataAto');
    expect(data1).toEqual({ chave: 'dataAto', direcao: 'desc' });
    const data2 = proximaOrdem(data1, 'dataAto');
    expect(data2).toEqual({ chave: 'dataAto', direcao: 'asc' });
    expect(proximaOrdem(data2, 'dataAto')).toBeNull();
    expect(proximaOrdem(null, 'tribunal')).toEqual({ chave: 'tribunal', direcao: 'asc' });
    // Trocar de coluna recomeça pelo primeiro estado da nova.
    expect(proximaOrdem(data2, 'processo')).toEqual({
      chave: 'processo',
      direcao: 'asc',
    });
  });
});

describe('paginação "X–Y de Z"', () => {
  it('25 por página: 48 processos em duas páginas (1–25 e 26–48)', () => {
    const p1 = paginar(48, 1, 25);
    expect([p1.de, p1.ate, p1.total, p1.paginas]).toEqual([1, 25, 48, 2]);
    const p2 = paginar(48, 2, 25);
    expect([p2.de, p2.ate, p2.inicio, p2.fim]).toEqual([26, 48, 25, 48]);
  });

  it('10, 25 e 50 por página', () => {
    expect(paginar(120, 1, 10).paginas).toBe(12);
    expect(paginar(120, 1, 25).paginas).toBe(5);
    expect(paginar(120, 1, 50).paginas).toBe(3);
  });

  it('página fora do intervalo é ajustada, nunca vira tela vazia', () => {
    expect(paginar(30, 99, 25).pagina).toBe(2);
    expect(paginar(30, 0, 25).pagina).toBe(1);
    expect(paginar(30, -4, 25).pagina).toBe(1);
  });

  it('sem itens: 0–0 de 0, uma página só', () => {
    const p = paginar(0, 1, 25);
    expect([p.de, p.ate, p.total, p.paginas, p.pagina]).toEqual([0, 0, 0, 1, 1]);
  });

  it('cobre todos os itens uma vez só', () => {
    const vistos: number[] = [];
    for (let pag = 1; pag <= paginar(53, 1, 10).paginas; pag++) {
      const p = paginar(53, pag, 10);
      for (let i = p.inicio; i < p.fim; i++) vistos.push(i);
    }
    expect(vistos).toEqual(Array.from({ length: 53 }, (_, i) => i));
  });
});

describe('texto das partes', () => {
  const polo = (nomes: string[], total = nomes.length) => ({ nomes, total });

  it('"Autor × Réu" quando a fonte trouxe os dois polos', () => {
    expect(
      textoDePartes({
        ativo: polo(['Autora Sintética']),
        passivo: polo(['Empresa Fictícia Ltda']),
      }),
    ).toBe('Autora Sintética × Empresa Fictícia Ltda');
  });

  it('vários nomes no mesmo polo, e "+N" quando o servidor cortou a lista', () => {
    expect(textoDePartes({ ativo: polo(['A', 'B'], 5), passivo: polo(['C']) })).toBe(
      'A; B +3 × C',
    );
  });

  it('um polo só: o traço diz que o outro não veio', () => {
    expect(textoDePartes({ ativo: polo(['A']), passivo: polo([]) })).toBe('A × —');
    expect(textoDePartes({ ativo: polo([]), passivo: polo(['C']) })).toBe('— × C');
  });

  it('sem partes devolve vazio (a tela põe "—"); nada é deduzido', () => {
    expect(textoDePartes({ ativo: polo([]), passivo: polo([]) })).toBe('');
    expect(textoDePartes(null)).toBe('');
  });
});

describe('o módulo da tela usa as MESMAS funções testadas aqui', () => {
  it('injeta o trecho curto de 0.35.1 e as regras puras por toString()', () => {
    for (const f of [
      trechoDeTexto,
      descricaoDoAto,
      contarSituacoes,
      filtrarPorSituacao,
      proximaOrdem,
      ordenarGrupos,
      paginar,
      textoDePartes,
    ]) {
      expect(SCRIPT_ATUALIZACOES).toContain(f.toString());
    }
  });

  it('as funções puras são autocontidas: avaliadas sozinhas, sem o módulo, ainda funcionam', () => {
    const solta = new Function(
      `return (${contarSituacoes.toString()})([{naoVistas:1,processo:{pedeProvidencia:true}}])`,
    )() as { todas: number; naoLidas: number; pedemProvidencia: number };
    expect(solta).toEqual({ todas: 1, naoLidas: 1, pedemProvidencia: 1 });
    const pag = new Function(`return (${paginar.toString()})(48,2,25)`)() as {
      de: number;
      ate: number;
    };
    expect([pag.de, pag.ate]).toEqual([26, 48]);
  });
});
