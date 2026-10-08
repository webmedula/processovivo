import { describe, expect, it } from 'vitest';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import {
  PENDENCIA_INTIMACAO_JANELA_DIAS,
  PENDENCIA_JANELA_DIAS_PADRAO,
  estadoDaPasta,
  lerProvidencia,
} from '../../src/domain/entities/estadoDaPasta.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';

/* Relógio fixo: nenhum teste depende de tempo real. */
const AGORA = new Date('2026-10-08T15:00:00Z');
const diasAtras = (n: number): Date => new Date(AGORA.getTime() - n * 86_400_000);

const intimacao = (
  dias: number,
  titulo = 'Ato ordinatório',
  id = dias,
): Movimentacao => ({
  data: diasAtras(dias),
  titulo,
  idExterno: `djen:${id}`,
  tipoComunicacao: 'Intimação',
});
const despacho = (dias: number): Movimentacao => ({
  data: diasAtras(dias),
  titulo: 'Despacho',
});

// Os atos passam pelo `Processo` como no sistema real (a triagem marca `exigeAcao`).
function movs(lista: Movimentacao[]): readonly Movimentacao[] {
  return new Processo({
    numero: NumeroCNJ.criar(NUMERO_TJSP_A),
    tribunal: 'TJSP',
    movimentacoes: lista,
    procedencia: { provider: 'djen', consultadoEm: AGORA, deCache: false },
  }).movimentacoes;
}

describe('janela da intimação/citação do Diário (PENDENCIA_INTIMACAO_JANELA_DIAS)', () => {
  it('é 30 dias, e a dos demais atos segue em 10', () => {
    expect(PENDENCIA_INTIMACAO_JANELA_DIAS).toBe(30);
    expect(PENDENCIA_JANELA_DIAS_PADRAO).toBe(10);
  });

  it('intimação de 25 dias atrás ainda pede providência; despacho da mesma idade não', () => {
    expect(lerProvidencia(movs([intimacao(25)]), AGORA).pendente?.tipo).toBe('intimacao');
    expect(lerProvidencia(movs([despacho(25)]), AGORA).pendente).toBeUndefined();
  });

  it('despacho de 9 dias pede (janela de 10) e de 11 dias não', () => {
    expect(lerProvidencia(movs([despacho(9)]), AGORA).pendente).toBeDefined();
    expect(lerProvidencia(movs([despacho(11)]), AGORA).pendente).toBeUndefined();
  });

  it('passados 30 dias sem marca, sai do filtro e fica registrada como "venceu por tempo"', () => {
    const l = lerProvidencia(movs([intimacao(31)]), AGORA);
    expect(l.pendente).toBeUndefined();
    expect(l.venceuPorTempo?.rotulo).toBe('Ato ordinatório');
  });

  it('o limite é de 30 dias cravados com o relógio fake: 30 ainda pede, 31 não', () => {
    expect(lerProvidencia(movs([intimacao(30)]), AGORA).pendente).toBeDefined();
    expect(lerProvidencia(movs([intimacao(31)]), AGORA).pendente).toBeUndefined();
  });

  it('citação conta como intimação', () => {
    const citacao: Movimentacao = {
      data: diasAtras(20),
      titulo: 'Citação',
      idExterno: 'djen:9',
      tipoComunicacao: 'Citação',
    };
    expect(lerProvidencia(movs([citacao]), AGORA).pendente?.tipo).toBe('citacao');
  });
});

describe('marca de cumprido', () => {
  const ato = intimacao(5, 'Ato ordinatório', 1);
  const marca = (m: Movimentacao) => ({
    chave: chaveDaMovimentacao(m),
    ate: m.data,
    em: AGORA,
  });

  it('tira o selo daquele ato', () => {
    const lista = movs([ato]);
    const l = lerProvidencia(lista, AGORA, 10, 30, marca(ato));
    expect(l.pendente).toBeUndefined();
    expect(l.coberto?.rotulo).toBe('Ato ordinatório');
  });

  it('cobre os atos ATÉ aquele: um ato anterior que exigia ação também fica coberto', () => {
    const anterior = intimacao(8, 'Intimação anterior', 2);
    const l = lerProvidencia(movs([ato, anterior]), AGORA, 10, 30, marca(ato));
    expect(l.pendente).toBeUndefined();
  });

  it('um ato NOVO que exija ação volta a pedir providência sozinho', () => {
    const novo = intimacao(1, 'Intimação nova', 3);
    const l = lerProvidencia(movs([ato, novo]), AGORA, 10, 30, marca(ato));
    expect(l.pendente?.rotulo).toBe('Intimação nova');
  });

  it('ato novo que NÃO exige ação não reabre', () => {
    const juntada: Movimentacao = { data: diasAtras(1), titulo: 'Juntada de petição' };
    const l = lerProvidencia(movs([ato, juntada]), AGORA, 10, 30, marca(ato));
    expect(l.pendente).toBeUndefined();
  });

  it('intimação marcada que passou dos 30 dias não conta como "sem marca"', () => {
    const velha = intimacao(40, 'Velha', 7);
    const l = lerProvidencia(movs([velha]), AGORA, 10, 30, marca(velha));
    expect(l.venceuPorTempo).toBeUndefined();
  });

  it('estadoDaPasta devolve PROVIDENCIA sem marca e EM_CURSO com ela', () => {
    const lista = movs([ato]);
    const entrada = { movimentacoes: lista, sincronizadoEm: AGORA };
    expect(estadoDaPasta(entrada, AGORA).rotulo).toBe('PROVIDENCIA');
    const com = estadoDaPasta({ ...entrada, cumprido: marca(ato) }, AGORA);
    expect(com.rotulo).toBe('EM_CURSO');
    expect(com.providencia.coberto).toBeDefined();
  });

  it('o ato que gera a providência é o MAIS RECENTE entre os que pedem', () => {
    const l = lerProvidencia(
      movs([intimacao(20, 'Mais velha', 1), intimacao(3, 'Mais nova', 2)]),
      AGORA,
    );
    expect(l.pendente?.rotulo).toBe('Mais nova');
  });
});
