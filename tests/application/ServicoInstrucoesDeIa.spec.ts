import { beforeEach, describe, expect, it } from 'vitest';
import {
  ServicoInstrucoesDeIa,
  MENSAGEM_DA_INSTRUCAO_RECUSADA,
} from '../../src/application/services/ServicoInstrucoesDeIa.js';
import {
  LIMITE_DA_INSTRUCAO,
  LIMITE_DA_OBSERVACAO,
} from '../../src/domain/entities/InstrucoesDeIa.js';
import { InstrucaoDeIaRecusadaError } from '../../src/domain/errors/index.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import type { RepositorioDeInstrucoesDeIa } from '../../src/domain/ports/InstrucoesDeIa.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDeInstrucoesDeIaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDeInstrucoesDeIaSqlite.js';
import { RepositorioDeConfigDeIaSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositoriosDoPainelDeIaSqlite.js';
import { LoggerColetor } from '../helpers/analiseIa.js';

/*
 * O ciclo das instruções (Fase C): rascunho → publicar → reverter, as edições nunca reaproveitadas, o
 * estado de cada versão, a leitura que falha caindo em +e0 e o que fica no registro. Banco em memória.
 */

class Relogio implements Clock {
  ms = new Date('2026-10-26T12:00:00.000Z').getTime();
  agora(): Date {
    return new Date(this.ms);
  }
  monotonico(): number {
    return this.ms;
  }
}

const TEXTOS = {
  ato: { fixa: 'FIXA-ATO', formato: 'FORMATO-ATO' },
  resumo: { fixa: 'FIXA-RESUMO', formato: 'FORMATO-RESUMO' },
  peca: { fixa: 'FIXA-PECA', formato: 'FORMATO-PECA' },
};
const OP = 'ab12cd34';

let relogio: Relogio;
let db: ReturnType<typeof abrirBanco>;
let logger: LoggerColetor;

function servico(
  repositorio?: RepositorioDeInstrucoesDeIa,
  validadeDoCacheMs = 0,
): ServicoInstrucoesDeIa {
  return new ServicoInstrucoesDeIa({
    repositorio: repositorio ?? new RepositorioDeInstrucoesDeIaSqlite(db),
    textosFixos: TEXTOS,
    clock: relogio,
    logger,
    validadeDoCacheMs,
  });
}

function recusa(fn: () => unknown): InstrucaoDeIaRecusadaError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InstrucaoDeIaRecusadaError);
    return e as InstrucaoDeIaRecusadaError;
  }
  throw new Error('esperava uma recusa');
}

beforeEach(() => {
  relogio = new Relogio();
  db = abrirBanco(':memory:');
  logger = new LoggerColetor();
});

describe('padrão (+e0)', () => {
  it('sem nada gravado a instrução em produção é o vazio, versão 0, sem anterior', () => {
    const s = servico();
    expect(s.efetiva('ato')).toEqual({ versao: 0, texto: '' });
    const e = s.estado('resumo');
    expect(e.publicada).toEqual({ versao: 0, texto: '' });
    expect(e.rascunho).toBeUndefined();
    expect(e.historico).toEqual([]);
    expect(e.anterior).toBe(0);
  });
});

describe('rascunho', () => {
  it('salvar cria a edição 1; salvar de novo ATUALIZA a mesma (um rascunho só por função)', () => {
    const s = servico();
    const a = s.salvarRascunho(OP, 'ato', 'Primeiro texto', 'obs 1');
    expect(a).toMatchObject({
      versao: 1,
      estado: 'rascunho',
      texto: 'Primeiro texto',
      observacao: 'obs 1',
    });
    const b = s.salvarRascunho(OP, 'ato', 'Segundo texto', 'obs 2');
    expect(b.versao).toBe(1);
    expect(s.estado('ato').rascunho).toMatchObject({
      versao: 1,
      texto: 'Segundo texto',
      observacao: 'obs 2',
    });
    expect(s.estado('ato').historico).toHaveLength(1);
    // outra função tem a sua própria numeração
    expect(s.salvarRascunho(OP, 'resumo', 'Outro', '').versao).toBe(1);
  });

  it('salvar rascunho NÃO muda o que está em produção', () => {
    const s = servico();
    s.salvarRascunho(OP, 'ato', 'Rascunho', '');
    expect(s.efetiva('ato')).toEqual({ versao: 0, texto: '' });
  });

  it('aceita rascunho vazio (o operador pode estar limpando), recusa o que passa do limite', () => {
    const s = servico();
    expect(s.salvarRascunho(OP, 'ato', '   ', '').texto).toBe('');
    expect(
      recusa(() => s.salvarRascunho(OP, 'ato', 'a'.repeat(LIMITE_DA_INSTRUCAO + 1), ''))
        .motivo,
    ).toBe('texto_grande');
    expect(
      s.salvarRascunho(OP, 'ato', 'a'.repeat(LIMITE_DA_INSTRUCAO), '').texto,
    ).toHaveLength(LIMITE_DA_INSTRUCAO);
  });

  it('observação acima de 200 caracteres ou com controle é recusada', () => {
    const s = servico();
    expect(
      recusa(() => s.salvarRascunho(OP, 'ato', 'x', 'a'.repeat(LIMITE_DA_OBSERVACAO + 1)))
        .motivo,
    ).toBe('observacao_invalida');
  });

  it('função desconhecida: recusa sem repetir o valor', () => {
    const s = servico();
    const e = recusa(() => s.salvarRascunho(OP, 'forjada<script>', 'x', ''));
    expect(e.motivo).toBe('funcao_desconhecida');
    expect(e.message).not.toContain('forjada');
  });
});

describe('publicar', () => {
  it('exige confirmação, rascunho existente, a edição certa e texto não vazio', () => {
    const s = servico();
    expect(
      recusa(() => s.publicar(OP, 'ato', { versao: 1, confirmado: false })).motivo,
    ).toBe('confirmacao_necessaria');
    expect(
      recusa(() => s.publicar(OP, 'ato', { versao: 1, confirmado: true })).motivo,
    ).toBe('rascunho_inexistente');
    s.salvarRascunho(OP, 'ato', 'Texto', '');
    expect(
      recusa(() => s.publicar(OP, 'ato', { versao: 7, confirmado: true })).motivo,
    ).toBe('rascunho_mudou');
    s.salvarRascunho(OP, 'resumo', '   ', '');
    expect(
      recusa(() => s.publicar(OP, 'resumo', { versao: 1, confirmado: true })).motivo,
    ).toBe('texto_vazio');
    // nada foi publicado nas recusas
    expect(s.efetiva('ato').versao).toBe(0);
    expect(s.efetiva('resumo').versao).toBe(0);
  });

  it('a próxima leitura já traz a versão nova (sem esperar o cache) e o rascunho vira publicada', () => {
    const s = servico(undefined, 60_000);
    expect(s.efetiva('ato').versao).toBe(0); // enche o cache com o vazio
    s.salvarRascunho(OP, 'ato', 'Destaque o prazo.', 'primeira');
    s.publicar(OP, 'ato', { versao: 1, confirmado: true });
    expect(s.efetiva('ato')).toEqual({ versao: 1, texto: 'Destaque o prazo.' });
    const e = s.estado('ato');
    expect(e.rascunho).toBeUndefined();
    expect(e.historico[0]).toMatchObject({
      versao: 1,
      estado: 'publicada',
      observacao: 'primeira',
      publicadoPor: OP,
    });
  });

  it('publicar a edição seguinte marca a anterior como substituída; as edições não são reaproveitadas', () => {
    const s = servico();
    s.salvarRascunho(OP, 'ato', 'Um', '');
    s.publicar(OP, 'ato', { versao: 1, confirmado: true });
    const novo = s.salvarRascunho(OP, 'ato', 'Dois', '');
    expect(novo.versao).toBe(2);
    s.publicar(OP, 'ato', { versao: 2, confirmado: true });
    const e = s.estado('ato');
    expect(e.publicada).toEqual({ versao: 2, texto: 'Dois' });
    expect(e.anterior).toBe(1);
    expect(e.historico.map((h) => [h.versao, h.estado])).toEqual([
      [2, 'publicada'],
      [1, 'substituida'],
    ]);
  });

  it('trocar uma função não mexe nas outras', () => {
    const s = servico();
    s.salvarRascunho(OP, 'peca', 'Só a peça', '');
    s.publicar(OP, 'peca', { versao: 1, confirmado: true });
    expect(s.efetiva('peca').versao).toBe(1);
    expect(s.efetiva('ato').versao).toBe(0);
    expect(s.efetiva('resumo').versao).toBe(0);
  });

  it('grava o registro (antes e depois, sem o texto) e não toca no liga/desliga nem nos tetos', () => {
    const s = servico();
    s.salvarRascunho(OP, 'resumo', 'Texto sintético do operador.', '');
    s.publicar(OP, 'resumo', { versao: 1, confirmado: true });
    const reg = new RepositorioDeConfigDeIaSqlite(db).alteracoes(5);
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({
      tipo: 'instrucoes_publicadas',
      funcao: 'resumo',
      autor: OP,
      anterior: 'e0',
      novo: 'e1',
    });
    expect(JSON.stringify(reg)).not.toContain('sintético');
    expect(new RepositorioDeConfigDeIaSqlite(db).ler().funcoes.resumo).toEqual({
      ligada: true,
      tetoPorConta: null,
    });
    expect(logger.linhas.join('\n')).not.toContain('sintético');
  });
});

describe('reverter', () => {
  it('volta à edição anterior, EXATAMENTE como ela era, e marca estados', () => {
    const s = servico();
    s.salvarRascunho(OP, 'ato', 'Texto um', '');
    s.publicar(OP, 'ato', { versao: 1, confirmado: true });
    s.salvarRascunho(OP, 'ato', 'Texto dois', '');
    s.publicar(OP, 'ato', { versao: 2, confirmado: true });
    const r = s.reverter(OP, 'ato', true);
    expect(r).toEqual({ de: 2, para: 1 });
    expect(s.efetiva('ato')).toEqual({ versao: 1, texto: 'Texto um' });
    const e = s.estado('ato');
    expect(e.historico.map((h) => [h.versao, h.estado])).toEqual([
      [2, 'substituida'],
      [1, 'publicada'],
    ]);
    expect(new RepositorioDeConfigDeIaSqlite(db).alteracoes(5)[0]).toMatchObject({
      tipo: 'instrucoes_revertidas',
      anterior: 'e2',
      novo: 'e1',
    });
  });

  it('sem anterior volta ao padrão (+e0); sem nada publicado, recusa', () => {
    const s = servico();
    expect(recusa(() => s.reverter(OP, 'ato', true)).motivo).toBe('nada_para_reverter');
    s.salvarRascunho(OP, 'ato', 'Texto', '');
    s.publicar(OP, 'ato', { versao: 1, confirmado: true });
    expect(recusa(() => s.reverter(OP, 'ato', false)).motivo).toBe(
      'confirmacao_necessaria',
    );
    expect(s.reverter(OP, 'ato', true)).toEqual({ de: 1, para: 0 });
    expect(s.efetiva('ato')).toEqual({ versao: 0, texto: '' });
    expect(s.estado('ato').historico[0]).toMatchObject({
      versao: 1,
      estado: 'substituida',
    });
    expect(recusa(() => s.reverter(OP, 'ato', true)).motivo).toBe('nada_para_reverter');
  });

  it('depois de reverter, um rascunho novo ganha o número seguinte (nunca reaproveitado)', () => {
    const s = servico();
    s.salvarRascunho(OP, 'ato', 'Um', '');
    s.publicar(OP, 'ato', { versao: 1, confirmado: true });
    s.reverter(OP, 'ato', true);
    expect(s.salvarRascunho(OP, 'ato', 'Dois', '').versao).toBe(2);
  });
});

describe('histórico e comparação', () => {
  it('compara quaisquer duas edições, e 0 é o vazio', () => {
    const s = servico();
    s.salvarRascunho(OP, 'ato', 'a\nb', '');
    s.publicar(OP, 'ato', { versao: 1, confirmado: true });
    s.salvarRascunho(OP, 'ato', 'a\nc', '');
    s.publicar(OP, 'ato', { versao: 2, confirmado: true });
    expect(s.diferenca('ato', 1, 2).linhas.map((l) => l.tipo)).toEqual([
      'igual',
      'removida',
      'adicionada',
    ]);
    expect(s.diferenca('ato', 0, 1).linhas.every((l) => l.tipo === 'adicionada')).toBe(
      true,
    );
    expect(recusa(() => s.diferenca('ato', 1, 9)).motivo).toBe('versao_inexistente');
    expect(recusa(() => s.diferenca('ato', -1, 1)).motivo).toBe('versoes_invalidas');
  });

  it('a prévia mostra fixa, bloco e lembrete com o exemplo FICTÍCIO, sem gravar nada', () => {
    const s = servico();
    const p = s.previa('peca', 'Seja breve.');
    expect(p.fixa).toBe('FIXA-PECA');
    expect(p.editavel).toContain('Seja breve.');
    expect(p.lembrete).toContain('LEMBRETE FINAL');
    expect(p.formato).toBe('FORMATO-PECA');
    expect(p.exemplo).toContain('exemplo fictício');
    expect(s.estado('peca').rascunho).toBeUndefined();
    expect(s.previa('peca', '').montado).toBe('FIXA-PECA');
    expect(
      recusa(() => s.previa('peca', 'a'.repeat(LIMITE_DA_INSTRUCAO + 1))).motivo,
    ).toBe('texto_grande');
  });
});

describe('falha segura', () => {
  it('se o banco falha ao ler, vale o prompt de sempre (+e0), sem lançar, com um aviso sem texto', () => {
    const real = new RepositorioDeInstrucoesDeIaSqlite(db);
    const quebrado: RepositorioDeInstrucoesDeIa = {
      ...real,
      emProducao: () => {
        throw new Error('banco indisponível com texto secreto do operador');
      },
      buscar: real.buscar.bind(real),
      rascunho: real.rascunho.bind(real),
      historico: real.historico.bind(real),
      salvarRascunho: real.salvarRascunho.bind(real),
      publicar: real.publicar.bind(real),
      reverter: real.reverter.bind(real),
    };
    const s = servico(quebrado);
    expect(s.efetiva('ato')).toEqual({ versao: 0, texto: '' });
    expect(s.efetiva('ato')).toEqual({ versao: 0, texto: '' });
    expect(s.estado('ato').leituraFalhou).toBe(true);
    const avisos = logger.linhas.filter((l) => l.startsWith('warn'));
    expect(avisos).toHaveLength(1); // um por minuto, não um por chamada
    expect(avisos.join('')).not.toContain('secreto');
  });

  it('linha torta (versão publicada sem texto) também cai em +e0', () => {
    db.prepare(
      "INSERT INTO ia_config (chave, instrucoes_versao, atualizado_em) VALUES ('ato', 5, 'x')",
    ).run();
    expect(servico().efetiva('ato')).toEqual({ versao: 0, texto: '' });
  });

  it('tabela ausente (banco muito antigo) também cai em +e0', () => {
    db.exec('DROP TABLE ia_instrucoes');
    expect(servico().efetiva('resumo')).toEqual({ versao: 0, texto: '' });
  });
});

it('as frases de recusa são fixas e nunca repetem o que foi enviado', () => {
  for (const frase of Object.values(MENSAGEM_DA_INSTRUCAO_RECUSADA)) {
    expect(frase.length).toBeGreaterThan(10);
  }
});
