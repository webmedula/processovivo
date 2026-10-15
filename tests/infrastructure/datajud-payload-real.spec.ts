import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapearProcesso } from '../../src/infrastructure/adapters/datajud/datajud.mapper.js';
import { respostaDataJudSchema } from '../../src/infrastructure/adapters/datajud/datajud.types.js';
import type { processoDataJudSchema } from '../../src/infrastructure/adapters/datajud/datajud.types.js';
import { RespostaInvalidaError } from '../../src/domain/errors/index.js';

/**
 * Testes ancorados numa CAPTURA REAL da API do CNJ.
 *
 * Todo o resto da suíte do DataJud usa dados que eu escrevi. Este arquivo usa
 * uma resposta que o CNJ devolveu de fato — e foi ele que revelou o bug das
 * datas, que 161 testes verdes não pegaram porque validavam a minha suposição
 * contra ela mesma.
 *
 * Regra: quando o comportamento do CNJ estiver em jogo, o teste vale aqui.
 */

const caminho = fileURLToPath(
  new URL('../fixtures/datajud-tjgo-real.json', import.meta.url),
);
const RESPOSTA_REAL: unknown = JSON.parse(readFileSync(caminho, 'utf8'));

const CONSULTADO_EM = new Date('2026-09-04T12:00:00.000Z');

function fonteReal(): ReturnType<typeof processoDataJudSchema.parse> {
  const parsed = respostaDataJudSchema.parse(RESPOSTA_REAL);
  const primeiro = parsed.hits.hits[0];
  if (!primeiro) throw new Error('fixture real sem hits');
  return primeiro._source;
}

describe('payload real do DataJud (TJGO)', () => {
  it('o schema aceita a resposta real sem precisar de ajuste', () => {
    expect(() => respostaDataJudSchema.parse(RESPOSTA_REAL)).not.toThrow();
  });

  it('a data de distribuição é preenchida — o bug que passou despercebido', () => {
    // dataAjuizamento vem "20150826000000". Antes: new Date() -> Invalid Date
    // -> undefined -> processo "mapeado com sucesso" sem data de distribuição.
    const processo = mapearProcesso(fonteReal(), CONSULTADO_EM);

    expect(processo.dataDistribuicao).toBeInstanceOf(Date);
    // Meia-noite em Brasília = 03:00 UTC. Interpretar como UTC fazia a tela
    // exibir 25/08 em vez de 26/08 — um dia a menos, na primeira consulta real.
    expect(processo.dataDistribuicao?.toISOString()).toBe('2015-08-26T03:00:00.000Z');
  });

  it('a data exibida em horário de Brasília é o dia correto', () => {
    // O teste que faltava: não basta a data existir, ela tem que aparecer certa.
    const processo = mapearProcesso(fonteReal(), CONSULTADO_EM);
    const exibida = processo.dataDistribuicao?.toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
    });

    expect(exibida).toBe('26/08/2015');
  });

  it('lida com os DOIS formatos de data que vêm no mesmo documento', () => {
    // dataAjuizamento é compacto; movimentos[].dataHora é ISO.
    const processo = mapearProcesso(fonteReal(), CONSULTADO_EM);

    expect(processo.dataDistribuicao?.getUTCFullYear()).toBe(2015);
    expect(processo.dataDistribuicao?.toISOString()).toContain('2015-08-26');
    expect(processo.ultimaMovimentacao?.data.toISOString()).toBe(
      '2026-07-15T15:20:55.000Z',
    );
  });

  it('mapeia os metadados do processo', () => {
    const processo = mapearProcesso(fonteReal(), CONSULTADO_EM);

    expect(processo.numero.formatado).toBe('0311517-22.2015.8.09.0051');
    expect(processo.tribunal).toBe('TJGO');
    expect(processo.grau).toBe('G1');
    expect(processo.classe).toBe('Cumprimento de sentença');
    expect(processo.assunto).toBe('Contratos Bancários');
    expect(processo.vara).toContain('Cumprimento de Sentença Cível');
    expect(processo.segredoJustica).toBe(false);
  });

  it('não perde nenhuma movimentação da captura', () => {
    // Descartar movimentação em silêncio é como se perde prazo.
    const processo = mapearProcesso(fonteReal(), CONSULTADO_EM);
    expect(processo.movimentacoes).toHaveLength(8);
  });

  it('preserva código TPU e complementos como vieram', () => {
    const processo = mapearProcesso(fonteReal(), CONSULTADO_EM);
    const distribuicao = processo.movimentacoes.at(-1);

    expect(distribuicao?.titulo).toBe('Distribuição');
    expect(distribuicao?.codigoTpu).toBe(26);
    expect(distribuicao?.complementos).toEqual(['sorteio']);
  });

  it('confirma na prática o limite que define a arquitetura', () => {
    // O DataJud é base de METADADOS. Sem partes, sem advogados, sem inteiro
    // teor — é por isso que busca por OAB não sai daqui, e é por isso que o
    // crawler próprio existe no desenho.
    const processo = mapearProcesso(fonteReal(), CONSULTADO_EM);

    expect(processo.partes).toEqual([]);
    expect(processo.temDetalhamento).toBe(false);
    expect(processo.movimentacoes.every((m) => m.conteudo === undefined)).toBe(true);
  });

  it('a resposta real registra o quanto o CNJ demora', () => {
    // 20,5s. É o número que justifica o timeout de 60s e, mais adiante, a
    // decisão de nunca deixar o usuário esperando pela fonte.
    const bruto = RESPOSTA_REAL as { took: number };
    expect(bruto.took).toBeGreaterThan(20_000);
  });
});

describe('formatos de data desconhecidos', () => {
  const base = {
    numeroProcesso: '03115172220158090051',
    tribunal: 'TJGO',
  };

  it('falha ALTO em vez de devolver o campo vazio', () => {
    expect(() =>
      mapearProcesso({ ...base, dataAjuizamento: '26/08/2015' }, CONSULTADO_EM),
    ).toThrow(RespostaInvalidaError);
  });

  it('a mensagem diz qual campo e qual valor', () => {
    const erro = (() => {
      try {
        mapearProcesso({ ...base, dataAjuizamento: 'ontem' }, CONSULTADO_EM);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(erro?.message).toContain('dataAjuizamento');
    expect(erro?.message).toContain('ontem');
  });

  it('campo ausente continua sendo ausência, não erro', () => {
    const processo = mapearProcesso(base, CONSULTADO_EM);
    expect(processo.dataDistribuicao).toBeUndefined();
  });
});
