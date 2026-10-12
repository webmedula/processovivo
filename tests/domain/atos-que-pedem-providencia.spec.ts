import { describe, expect, it } from 'vitest';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import {
  atosQuePedemProvidencia,
  lerProvidencia,
} from '../../src/domain/entities/estadoDaPasta.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';

/* Datas e textos SINTÉTICOS. Hoje = 06/10/2026. */
const AGORA = new Date('2026-10-06T15:00:00.000Z');
const dia = (d: string): Date => new Date(`${d}T12:00:00.000Z`);

const mov = (
  d: string,
  titulo: string,
  extra: Partial<Movimentacao> = {},
): Movimentacao => ({
  data: dia(d),
  titulo,
  ...extra,
});

describe('atosQuePedemProvidencia (v0.40.0)', () => {
  const INTIMACAO = mov('2026-10-05', 'Intimação', {
    idExterno: 'djen:1',
    tipoComunicacao: 'Intimação',
    conteudo: 'Intime-se a parte para se manifestar.',
  });
  const DESPACHO_RECENTE = mov('2026-10-01', 'Despacho', {
    conteudo: 'Cite-se a parte ré para contestar.',
  });
  const DESPACHO_VELHO = mov('2026-08-01', 'Despacho', {
    conteudo: 'Intime-se a parte para se manifestar.',
  });
  const CARTORIO = mov('2026-10-04', 'Juntada de petição');

  it('lista TODOS os atos que pedem providência, do mais recente ao mais antigo', () => {
    const atos = atosQuePedemProvidencia(
      [DESPACHO_VELHO, DESPACHO_RECENTE, CARTORIO, INTIMACAO],
      AGORA,
    );
    expect(atos.map((a) => a.rotulo)).toEqual(['Intimação', 'Despacho']);
    expect(atos.map((a) => a.chave)).toEqual([
      chaveDaMovimentacao(INTIMACAO),
      chaveDaMovimentacao(DESPACHO_RECENTE),
    ]);
  });

  it('o primeiro da lista é sempre o pendente de lerProvidencia (mesma regra, mesma janela)', () => {
    const casos: Movimentacao[][] = [
      [INTIMACAO, DESPACHO_RECENTE, DESPACHO_VELHO, CARTORIO],
      [DESPACHO_RECENTE, DESPACHO_VELHO],
      [DESPACHO_VELHO, CARTORIO],
      [],
      [
        mov('2026-09-20', 'Intimação', {
          idExterno: 'djen:9',
          tipoComunicacao: 'Citação',
        }),
      ],
    ];
    for (const movs of casos) {
      const lista = atosQuePedemProvidencia(movs, AGORA);
      const lida = lerProvidencia(movs, AGORA).pendente;
      expect(lista[0]?.chave).toBe(lida?.chave);
    }
  });

  it('a marca de cumprido cobre os atos até a data dela, inclusive', () => {
    const marca = {
      chave: chaveDaMovimentacao(DESPACHO_RECENTE),
      ate: dia('2026-10-01'),
      em: AGORA,
    };
    const atos = atosQuePedemProvidencia(
      [INTIMACAO, DESPACHO_RECENTE],
      AGORA,
      10,
      30,
      marca,
    );
    expect(atos.map((a) => a.rotulo)).toEqual(['Intimação']);
  });

  it('intimação do Diário vale 30 dias; ato comum, a janela configurada', () => {
    const intimacao25 = mov('2026-09-11', 'Intimação', {
      idExterno: 'djen:7',
      tipoComunicacao: 'Intimação',
    });
    const despacho25 = mov('2026-09-11', 'Despacho', { conteudo: 'Intime-se a parte.' });
    expect(atosQuePedemProvidencia([intimacao25, despacho25], AGORA)).toHaveLength(1);
    expect(atosQuePedemProvidencia([intimacao25, despacho25], AGORA, 30)).toHaveLength(2);
  });

  it('intimação dirigida a outro destinatário volta à regra comum do ato', () => {
    const aOutro = mov('2026-10-05', 'Ato ordinatório', {
      idExterno: 'djen:8',
      tipoComunicacao: 'Intimação',
      paraOUsuario: 'nao',
      conteudo: 'Fica a parte ré ciente do ocorrido nos autos.',
    });
    const paraOUsuario = { ...aOutro, paraOUsuario: 'sim' as const };
    expect(atosQuePedemProvidencia([aOutro], AGORA)).toEqual([]);
    expect(atosQuePedemProvidencia([paraOUsuario], AGORA)).toHaveLength(1);
  });
});
