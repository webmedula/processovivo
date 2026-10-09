import { describe, expect, it } from 'vitest';
import { SCRIPT_ATUALIZACOES } from '../../src/main/http/ui/atualizacoes.js';
import { descricaoDoAto } from '../../src/domain/entities/descricaoDoAto.js';
import { trechoDeTexto } from '../../src/main/http/ui/trechoDeTexto.js';
import {
  SITUACAO_PADRAO,
  atoExibido,
  detectadoDistanteDoAto,
  diaMesBrasilia,
  contarSaidasDaProvidencia,
  frasesDeSaidas,
  seloDoTipo,
  contarSemLeitura,
  contarSituacoes,
  filtrarPorSituacao,
  montarLinhas,
  ordenarGrupos,
  paginar,
  proximaOrdem,
  textoDePartes,
  textoDeProvidencia,
} from '../../src/main/http/ui/tabelaAtualizacoes.js';
import type {
  GrupoDaTabela,
  ProcessoSemNovidade,
} from '../../src/main/http/ui/tabelaAtualizacoes.js';

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

describe('base da tabela com processos sem novidade (v0.37.3)', () => {
  const info = (providencia = false): GrupoDaTabela['processo'] => ({
    tribunal: 'TJGO',
    pedeProvidencia: providencia,
  });
  const sem = (
    numero: string,
    data: string | null,
    opcoes: { segredo?: boolean; providencia?: boolean } = {},
  ): ProcessoSemNovidade => ({
    numero,
    processo: info(opcoes.providencia),
    segredoJustica: opcoes.segredo ?? false,
    ultimaMovimentacao: data ? { data, titulo: 'Juntada', conteudo: null } : null,
  });
  const com = [g('1', { naoVistas: 1 }), g('2')];

  it('primeiro quem tem atualização detectada (ordem de chegada); depois os demais pela data do ato, mais recente primeiro', () => {
    const linhas = montarLinhas(
      com,
      [
        sem('a', '2026-01-01T00:00:00.000Z'),
        sem('b', null),
        sem('c', '2026-09-01T00:00:00.000Z'),
      ],
      true,
    );
    expect(linhas.map((l) => l.numero)).toEqual(['1', '2', 'c', 'a', 'b']);
  });

  it('com o período ligado só entram os processos com atualização no período', () => {
    expect(montarLinhas(com, [sem('a', null)], false).map((l) => l.numero)).toEqual([
      '1',
      '2',
    ]);
  });

  it('a linha sem novidade não tem detecção, nunca é "não lida" e leva a movimentação do retrato', () => {
    const [l] = montarLinhas(
      [],
      [sem('a', '2026-09-01T00:00:00.000Z', { segredo: true })],
      true,
    );
    expect(l).toMatchObject({
      semNovidade: true,
      naoVistas: 0,
      quantidade: 0,
      segredoJustica: true,
      maisRecente: {
        detectadaEm: null,
        data: '2026-09-01T00:00:00.000Z',
        titulo: 'Juntada',
      },
    });
  });

  it('os contadores de situação contam processos, e "Todas" inclui os sem novidade', () => {
    const base = montarLinhas(
      com,
      [sem('a', '2026-09-01T00:00:00.000Z', { providencia: true }), sem('b', null)],
      true,
    );
    expect(contarSituacoes(base)).toEqual({ todas: 4, naoLidas: 1, pedemProvidencia: 1 });
    expect(filtrarPorSituacao(base, 'naoLidas').map((x) => x.numero)).toEqual(['1']);
    expect(filtrarPorSituacao(base, 'providencia').map((x) => x.numero)).toEqual(['a']);
  });

  it('ordenar por data do ato ou por detecção manda quem não tem o dado para o fim, nas duas direções', () => {
    const base = montarLinhas(
      [g('1', { data: '2026-10-01T00:00:00.000Z' })],
      [sem('a', '2026-09-01T00:00:00.000Z'), sem('b', null)],
      true,
    );
    for (const direcao of ['asc', 'desc'] as const) {
      const porData = ordenarGrupos(base, { chave: 'dataAto', direcao }).map(
        (x) => x.numero,
      );
      expect(porData[porData.length - 1]).toBe('b');
      const porDeteccao = ordenarGrupos(base, { chave: 'detectado', direcao }).map(
        (x) => x.numero,
      );
      expect(porDeteccao[0]).toBe('1');
    }
  });

  it('é autocontida: injetada por toString() no console, roda sem nada do módulo', () => {
    const injetada = new Function(
      `return ${montarLinhas.toString()}`,
    )() as typeof montarLinhas;
    expect(injetada([], [sem('a', null)], true)).toHaveLength(1);
  });
});

describe('padrão "Pedem providência" (v0.37.4)', () => {
  const base = [
    g('1', { naoVistas: 1, providencia: true }),
    g('2'),
    g('3', { providencia: true, naoVistas: 2 }),
  ];

  it('a aba abre no filtro de providência e ele devolve exatamente o que o contador anunciou', () => {
    expect(SITUACAO_PADRAO).toBe('providencia');
    const c = contarSituacoes(base);
    const lista = filtrarPorSituacao(base, SITUACAO_PADRAO);
    expect(c).toEqual({ todas: 3, naoLidas: 2, pedemProvidencia: 2 });
    expect(lista).toHaveLength(c.pedemProvidencia);
  });

  it('"Ver todos" (situação "todas") devolve a base inteira e a paginação conta processos do filtro', () => {
    expect(filtrarPorSituacao(base, 'todas')).toHaveLength(3);
    const filtrados = filtrarPorSituacao(base, 'providencia');
    expect(paginar(filtrados.length, 1, 25)).toMatchObject({ de: 1, ate: 2, total: 2 });
  });

  it('m < N: diz "Mostrando m de N" e oferece "Ver todos"', () => {
    expect(textoDeProvidencia(1, 2, '')).toEqual({
      modo: 'parcial',
      frase: 'Mostrando 1 de 2 processos acompanhados: só os que pedem providência',
      verTodos: true,
    });
    expect(textoDeProvidencia(1, 2, ' em TJGO').frase).toContain('acompanhados em TJGO:');
  });

  it('m = N: só a contagem, sem "Ver todos"', () => {
    const t = textoDeProvidencia(2, 2, '');
    expect(t.modo).toBe('todos');
    expect(t.verTodos).toBe(false);
    expect(t.frase).toBe(
      'Mostrando 2 de 2 processos acompanhados: todos pedem providência.',
    );
    expect(textoDeProvidencia(1, 1, '').frase).toBe(
      'Mostrando 1 de 1 processo acompanhado: pede providência.',
    );
  });

  it('m = 0: estado vazio com "Ver todos" se há processos; nada se não há', () => {
    expect(textoDeProvidencia(0, 5, '')).toEqual({
      modo: 'vazio',
      frase: '',
      verTodos: true,
    });
    expect(textoDeProvidencia(0, 0, '').verTodos).toBe(false);
  });

  it('nenhuma frase fala em prazo', () => {
    for (const [m, n] of [
      [1, 2],
      [2, 2],
      [1, 1],
    ] as const) {
      expect(textoDeProvidencia(m, n, ' em TJGO').frase.toLowerCase()).not.toContain(
        'prazo',
      );
    }
  });

  it('processo sem nenhuma movimentação conhecida é contado à parte, nunca como providência', () => {
    const sem = montarLinhas(
      [g('1', { providencia: true })],
      [
        { numero: '8', processo: null, segredoJustica: false, ultimaMovimentacao: null },
        {
          numero: '9',
          processo: null,
          segredoJustica: false,
          ultimaMovimentacao: {
            data: '2026-09-01T00:00:00.000Z',
            titulo: 'x',
            conteudo: null,
          },
        },
      ],
      true,
    );
    expect(contarSemLeitura(sem)).toBe(1);
    expect(filtrarPorSituacao(sem, 'providencia').map((x) => x.numero)).toEqual(['1']);
  });
});

/* ------------------------------------------------------------------ v0.37.5 */
const ATO = {
  rotulo: 'Ato ordinatório',
  data: '2026-09-25T03:00:00.000Z',
  chave: 'k',
  tipo: 'intimacao' as const,
};
const comProv = (situacao: 'pede' | 'cumprida' | 'venceu'): GrupoDaTabela => ({
  ...g('1'),
  processo: {
    tribunal: 'TJGO',
    pedeProvidencia: situacao === 'pede',
    providencia: { situacao, motivo: ATO, cumpridoEm: null },
  },
});

describe('cumprido: contagens e frases da tela', () => {
  it('"Ver" lista só os processos marcados como cumpridos', () => {
    const grupos = [comProv('pede'), comProv('cumprida'), comProv('venceu'), g('9')];
    expect(filtrarPorSituacao(grupos, 'cumpridos')).toHaveLength(1);
    expect(filtrarPorSituacao(grupos, 'providencia')).toHaveLength(1);
  });

  it('o chip de providência conta só os que AINDA pedem', () => {
    const grupos = [comProv('pede'), comProv('cumprida'), comProv('venceu')];
    expect(contarSituacoes(grupos).pedemProvidencia).toBe(1);
  });

  it('conta quantos saíram por marca e quantos por tempo', () => {
    const grupos = [comProv('pede'), comProv('cumprida'), comProv('cumprida'), comProv('venceu')];
    expect(contarSaidasDaProvidencia(grupos)).toEqual({ cumpridos: 2, vencidos: 1, outros: 0 });
  });

  it('as frases dizem o número e a janela, sem a palavra "prazo"', () => {
    expect(frasesDeSaidas(2, 1, 30)).toEqual({
      cumpridos: '2 marcados como cumpridos',
      vencidos: '1 sem marca há mais de 30 dias',
      outros: '',
    });
    expect(frasesDeSaidas(1, 0, 30)).toEqual({
      cumpridos: '1 marcado como cumprido',
      vencidos: '',
      outros: '',
    });
    expect(frasesDeSaidas(0, 0, 30)).toEqual({ cumpridos: '', vencidos: '', outros: '' });
    const todas = Object.values(frasesDeSaidas(3, 4, 30)).join(' ');
    expect(todas).not.toMatch(/prazo/i);
  });
});

describe('o ato que a linha mostra (v0.37.6): o que gera a providência, e o último andamento à parte', () => {
  const linha = (data: string | null, titulo: string, situacao: 'pede' | 'cumprida' = 'pede') => ({
    maisRecente: { data, titulo },
    processo: {
      tribunal: null,
      pedeProvidencia: situacao === 'pede',
      providencia: { situacao, motivo: ATO, cumpridoEm: null },
    },
  });

  it('com providência, a linha é sobre o ato que a gera; o último andamento vai à parte', () => {
    expect(atoExibido(linha('2026-10-01T12:00:00.000Z', 'Juntada de petição'))).toMatchObject({
      rotulo: 'Ato ordinatório',
      data: ATO.data,
      tipo: 'intimacao',
      daProvidencia: true,
      igualAAtualizacao: false,
      ultimoAndamento: { rotulo: 'Juntada de petição', data: '2026-10-01T12:00:00.000Z' },
    });
  });

  it('é o mesmo ato (rótulo e data iguais): sem segunda linha, e o trecho da atualização é dele', () => {
    const a = atoExibido(linha(ATO.data, ATO.rotulo));
    expect(a.ultimoAndamento).toBeNull();
    expect(a.igualAAtualizacao).toBe(true);
    expect(a.daProvidencia).toBe(true);
  });

  it('mesmo rótulo em outra data é outro ato', () => {
    const a = atoExibido(linha('2026-10-01T12:00:00.000Z', ATO.rotulo));
    expect(a.igualAAtualizacao).toBe(false);
    expect(a.ultimoAndamento).not.toBeNull();
  });

  it('sem providência pendente, a linha é a de antes: a atualização, sem segunda linha', () => {
    for (const l of [
      linha('2026-10-01T12:00:00.000Z', 'x', 'cumprida'),
      { maisRecente: { data: '2026-10-01T12:00:00.000Z', titulo: 'x' }, processo: null },
    ]) {
      expect(atoExibido(l)).toMatchObject({
        rotulo: 'x',
        data: '2026-10-01T12:00:00.000Z',
        daProvidencia: false,
        ultimoAndamento: null,
      });
    }
  });

  it('a data do ato da linha é a do ato da providência (o caso 11/09 × "Decisão 29/09")', () => {
    const l = {
      maisRecente: { data: '2026-09-11T15:00:00.000Z', titulo: 'Despacho' },
      processo: {
        tribunal: null,
        pedeProvidencia: true,
        providencia: {
          situacao: 'pede' as const,
          motivo: { ...ATO, rotulo: 'Decisão', data: '2026-09-29T15:00:00.000Z', tipo: 'outro' as const },
          cumpridoEm: null,
        },
      },
    };
    expect(atoExibido(l).data).toBe('2026-09-29T15:00:00.000Z');
    expect(atoExibido(l).ultimoAndamento?.data).toBe('2026-09-11T15:00:00.000Z');
  });

  it('o destinatário do ato vai junto, e é desconhecido quando o servidor não o disse', () => {
    expect(atoExibido(linha('2026-10-01T12:00:00.000Z', 'x')).paraOUsuario).toBe('desconhecido');
  });

  it('o selo do tipo é Intimação ou Citação, e só isso', () => {
    expect(seloDoTipo('intimacao')).toBe('Intimação');
    expect(seloDoTipo('citacao')).toBe('Citação');
    expect(seloDoTipo('outro')).toBe('');
    expect(seloDoTipo(null)).toBe('');
  });
});

describe('script da tela: o texto novo não fala em prazo', () => {
  it('fora de comentário, a palavra só aparece no aviso de honestidade já existente', () => {
    const semComentarios = SCRIPT_ATUALIZACOES.replace(/\/\*[\s\S]*?\*\//g, '');
    const semAviso = semComentarios.replace(
      'Leitura automática do andamento, não é contagem de prazo. Confira no processo.',
      '',
    );
    expect(semAviso).not.toMatch(/prazo/i);
  });
});

describe('"Detectado" legível (v0.37.6)', () => {
  it('só passa a data absoluta quando a diferença para o ato é maior que 7 dias', () => {
    const ato = '2026-09-21T15:00:00.000Z';
    expect(detectadoDistanteDoAto(ato, '2026-09-28T14:00:00.000Z')).toBe(false); // 6d23h
    expect(detectadoDistanteDoAto(ato, '2026-09-28T15:00:00.000Z')).toBe(false); // 7d exatos
    expect(detectadoDistanteDoAto(ato, '2026-09-28T15:00:01.000Z')).toBe(true);
    expect(detectadoDistanteDoAto(ato, '2026-10-07T12:00:00.000Z')).toBe(true); // o caso 21/09 × "há 2 dias"
  });

  it('não decide sem as duas datas', () => {
    expect(detectadoDistanteDoAto(null, '2026-10-07T12:00:00.000Z')).toBe(false);
    expect(detectadoDistanteDoAto('2026-09-21T15:00:00.000Z', null)).toBe(false);
    expect(detectadoDistanteDoAto('lixo', '2026-10-07T12:00:00.000Z')).toBe(false);
  });

  it('dd/mm no fuso de Brasília, não em UTC', () => {
    expect(diaMesBrasilia('2026-10-07T12:00:00.000Z')).toBe('07/10');
    // 01:00 UTC de 08/10 ainda é 22h de 07/10 em Brasília.
    expect(diaMesBrasilia('2026-10-08T01:00:00.000Z')).toBe('07/10');
    expect(diaMesBrasilia(null)).toBe('');
    expect(diaMesBrasilia('lixo')).toBe('');
  });
});

describe('intimação a outro destinatário (v0.37.6): contagem, frase e filtro', () => {
  const outro = { rotulo: 'Intimação', data: '2026-10-01T12:00:00.000Z', chave: 'k', tipo: 'intimacao', paraOUsuario: 'nao' };
  const g = (pede: boolean, prov: object | null) => ({
    numero: '1',
    maisRecente: { data: null, detectadaEm: null },
    quantidade: 0,
    naoVistas: 0,
    processo: { tribunal: 'TJGO', pedeProvidencia: pede, providencia: prov as never },
  });

  it('conta só quem o filtro deixou de fora por causa dela', () => {
    const grupos = [
      g(false, { situacao: 'outro', motivo: outro, cumpridoEm: null, outroDestinatario: outro }),
      g(true, { situacao: 'pede', motivo: outro, cumpridoEm: null, outroDestinatario: outro }),
      g(false, null),
    ];
    expect(contarSaidasDaProvidencia(grupos).outros).toBe(1);
  });

  it('a frase diz "N com intimação a outro destinatário" e some em zero', () => {
    expect(frasesDeSaidas(0, 0, 30, 3).outros).toBe('3 com intimação a outro destinatário');
    expect(frasesDeSaidas(0, 0, 30, 0).outros).toBe('');
    expect(Object.values(frasesDeSaidas(1, 2, 30, 3)).join(' ')).not.toMatch(/prazo/i);
  });

  it('o filtro "outros" lista esses processos; o de providência não os inclui', () => {
    const a = g(false, { situacao: 'outro', motivo: outro, cumpridoEm: null, outroDestinatario: outro });
    const b = g(true, { situacao: 'pede', motivo: outro, cumpridoEm: null, outroDestinatario: outro });
    expect(filtrarPorSituacao([a, b], 'outros')).toEqual([a]);
    expect(filtrarPorSituacao([a, b], 'providencia')).toEqual([b]);
    expect(filtrarPorSituacao([a, b], 'todas')).toHaveLength(2);
  });
});

describe('ordenar por "Data do ato" usa a data que a linha mostra (v0.37.6)', () => {
  const l = (numero: string, dataUltima: string, providenciaEm: string | null) => ({
    numero,
    maisRecente: { data: dataUltima, detectadaEm: dataUltima },
    quantidade: 1,
    naoVistas: 0,
    processo: {
      tribunal: 'TJGO',
      pedeProvidencia: providenciaEm !== null,
      providencia:
        providenciaEm === null
          ? null
          : {
              situacao: 'pede' as const,
              motivo: { rotulo: 'Decisão', data: providenciaEm, chave: 'k', tipo: 'outro' as const },
              cumpridoEm: null,
            },
    },
  });

  it('a linha com providência ordena pela data do ato da providência', () => {
    // A: último andamento em 10/10, mas a providência é de 01/09. B: 20/09, sem providência.
    const a = l('A', '2026-10-10T12:00:00.000Z', '2026-09-01T12:00:00.000Z');
    const b = l('B', '2026-09-20T12:00:00.000Z', null);
    const ordem = ordenarGrupos([a, b], { chave: 'dataAto', direcao: 'desc' }).map((x) => x.numero);
    expect(ordem).toEqual(['B', 'A']);
  });
});
