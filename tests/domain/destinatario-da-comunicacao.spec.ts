import { describe, expect, it } from 'vitest';
import {
  calcularParaOUsuario,
  chaveDeOab,
} from '../../src/domain/entities/destinatarioDaComunicacao.js';
import { PENDENCIA_INTIMACAO_JANELA_DIAS, lerProvidencia, estadoDaPasta } from '../../src/domain/entities/estadoDaPasta.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { triar } from '../../src/domain/entities/triagem.js';
import { NUMERO_TJSP_A } from '../helpers/fabricas.js';

/* Dados SINTÉTICOS: inscrições inventadas. Relógio fixo. */
const AGORA = new Date('2026-10-09T15:00:00Z');
const dia = (n: number): Date => new Date(AGORA.getTime() - n * 86_400_000);
const MINHAS = new Set(['100/GO', '200/SP']);

describe('chaveDeOab', () => {
  it('normaliza zeros, letra, pontuação e caixa; sem número ou UF legível devolve vazio', () => {
    expect(chaveDeOab('047383', 'go')).toBe('47383/GO');
    expect(chaveDeOab('12.345-A', 'SP')).toBe('12345/SP');
    expect(chaveDeOab('', 'GO')).toBe('');
    expect(chaveDeOab(null, 'GO')).toBe('');
    expect(chaveDeOab('100', undefined)).toBe('');
    expect(chaveDeOab('abc', 'GO')).toBe('');
    expect(chaveDeOab('100', 'GOIAS')).toBe('');
  });
});

describe('calcularParaOUsuario', () => {
  it('sim quando qualquer advogado da comunicação é do workspace', () => {
    expect(calcularParaOUsuario(['999/GO', '100/GO'], MINHAS)).toBe('sim');
  });

  it('nao quando há inscrições legíveis e nenhuma é do workspace', () => {
    expect(calcularParaOUsuario(['999/GO'], MINHAS)).toBe('nao');
  });

  it('desconhecido sem OAB cadastrada no workspace (nunca "de outro")', () => {
    expect(calcularParaOUsuario(['999/GO'], new Set())).toBe('desconhecido');
  });

  it('desconhecido quando a comunicação não traz advogado legível (parte sem advogado)', () => {
    expect(calcularParaOUsuario([], MINHAS)).toBe('desconhecido');
    expect(calcularParaOUsuario(undefined, MINHAS)).toBe('desconhecido');
  });

  it('a mesma inscrição em outra UF é outra pessoa', () => {
    expect(calcularParaOUsuario(['100/SP'], MINHAS)).toBe('nao');
  });
});

const intimacao = (dias: number, paraOUsuario?: Movimentacao['paraOUsuario'], titulo = 'Ato ordinatório'): Movimentacao => ({
  data: dia(dias),
  titulo,
  idExterno: `djen:${dias}`,
  tipoComunicacao: 'Intimação',
  ...(paraOUsuario ? { paraOUsuario } : {}),
});

function movs(lista: Movimentacao[]): readonly Movimentacao[] {
  return new Processo({
    numero: NumeroCNJ.criar(NUMERO_TJSP_A),
    tribunal: 'TJSP',
    movimentacoes: lista,
    procedencia: { provider: 'djen', consultadoEm: AGORA, deCache: false },
  }).movimentacoes;
}

describe('intimação a outro destinatário — triagem', () => {
  it('"sim" e "desconhecido" mantêm o comportamento atual: pede providência', () => {
    expect(triar(intimacao(3, 'sim')).exigeAcao).toBe(true);
    expect(triar(intimacao(3, 'desconhecido')).exigeAcao).toBe(true);
    expect(triar(intimacao(3)).exigeAcao).toBe(true);
  });

  it('"nao" volta à regra comum do ato: "Ato ordinatório" sozinho não pede', () => {
    expect(triar(intimacao(3, 'nao')).exigeAcao).toBe(false);
  });

  it('"nao" com uma determinação no texto continua pedindo, pela regra comum', () => {
    const m = { ...intimacao(3, 'nao'), conteudo: 'Intime-se a parte para se manifestar.' };
    expect(triar(m).exigeAcao).toBe(true);
  });
});

describe('intimação a outro destinatário — leitura da providência', () => {
  it('não pede providência por ser intimação, mas fica registrada e visível', () => {
    const l = lerProvidencia(movs([intimacao(12, 'nao')]), AGORA);
    expect(l.pendente).toBeUndefined();
    expect(l.outroDestinatario).toMatchObject({ tipo: 'outro', paraOUsuario: 'nao', rotulo: 'Ato ordinatório' });
  });

  it('o mesmo ato dirigido ao usuário pede providência por 30 dias (a regra da 0.37.5 não mudou)', () => {
    const l = lerProvidencia(movs([intimacao(25, 'sim')]), AGORA);
    expect(l.pendente).toMatchObject({ tipo: 'intimacao', paraOUsuario: 'sim' });
    expect(l.outroDestinatario).toBeUndefined();
  });

  it('um exigeAcao gravado ANTES de se saber o destinatário não vale para "nao"', () => {
    // O retrato antigo carrega exigeAcao: true; o recálculo ignora o gravado.
    const gravado = { ...intimacao(12, 'nao'), exigeAcao: true };
    expect(lerProvidencia([gravado], AGORA).pendente).toBeUndefined();
  });

  it('"nao" cuja regra comum pede (Decisão) entra pela janela comum de 10 dias, com tipo "outro"', () => {
    const l = lerProvidencia(movs([intimacao(5, 'nao', 'Decisão')]), AGORA);
    expect(l.pendente).toMatchObject({ tipo: 'outro', paraOUsuario: 'nao' });
    const velha = lerProvidencia(movs([intimacao(15, 'nao', 'Decisão')]), AGORA);
    expect(velha.pendente).toBeUndefined();
    expect(velha.venceuPorTempo).toBeUndefined();
  });

  it('fora da janela de 30 dias ou coberta pela marca de cumprido, não é aviso', () => {
    expect(lerProvidencia(movs([intimacao(PENDENCIA_INTIMACAO_JANELA_DIAS + 1, 'nao')]), AGORA).outroDestinatario).toBeUndefined();
    const marca = { chave: 'k', ate: dia(5), em: dia(4) };
    expect(lerProvidencia(movs([intimacao(12, 'nao')]), AGORA, 10, 30, marca).outroDestinatario).toBeUndefined();
  });

  it('o processo só com intimação a outro destinatário não é "PROVIDENCIA" na carteira', () => {
    const e = estadoDaPasta({ movimentacoes: movs([intimacao(12, 'nao')]), sincronizadoEm: AGORA }, AGORA);
    expect(e.rotulo).toBe('EM_CURSO');
    expect(e.providencia.outroDestinatario).toBeDefined();
  });
});

describe('inscrição de terceiro não vai para a API', () => {
  it('Processo.toJSON não leva destinatariosOab, mas leva paraOUsuario', () => {
    const p = new Processo({
      numero: NumeroCNJ.criar(NUMERO_TJSP_A),
      tribunal: 'TJSP',
      movimentacoes: [{ ...intimacao(3, 'nao'), destinatariosOab: ['999/GO'] }],
      procedencia: { provider: 'djen', consultadoEm: AGORA, deCache: false },
    });
    const json = JSON.stringify(p.toJSON());
    expect(json).not.toContain('999/GO');
    expect(json).not.toContain('destinatariosOab');
    expect(json).toContain('"paraOUsuario":"nao"');
  });
});
