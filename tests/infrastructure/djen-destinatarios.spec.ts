import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  inscricoesDosDestinatarios,
  mapearMovimentacao,
} from '../../src/infrastructure/adapters/djen/djen.mapper.js';
import { respostaDjenSchema } from '../../src/infrastructure/adapters/djen/djen.types.js';
import type { ComunicacaoDjen } from '../../src/infrastructure/adapters/djen/djen.types.js';
import { serializarProcesso } from '../../src/infrastructure/persistencia/processoSerializacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';

/*
 * O DJEN informa os advogados de cada comunicação com número e UF da OAB. A
 * captura REAL (não editada) prova o formato; os demais casos derivam dela.
 */
const REAL = respostaDjenSchema.parse(
  JSON.parse(
    readFileSync(new URL('../fixtures/djen-comunica-real.json', import.meta.url), 'utf8'),
  ),
).items[0] as ComunicacaoDjen;

const variante = (
  advogados: ComunicacaoDjen['destinatarioadvogados'],
): ComunicacaoDjen => ({
  ...REAL,
  destinatarioadvogados: advogados,
});
const adv = (nome: string, numero: string | null, uf: string | null) => ({
  advogado: { nome, numero_oab: numero, uf_oab: uf },
});

describe('inscrições dos advogados da comunicação do DJEN', () => {
  it('a captura real traz o advogado com número e UF da OAB', () => {
    const a = REAL.destinatarioadvogados?.[0]?.advogado;
    expect(a?.numero_oab).toBeTruthy();
    expect(a?.uf_oab).toBeTruthy();
    expect(inscricoesDosDestinatarios(REAL)).toEqual([
      `${Number(a?.numero_oab)}/${a?.uf_oab?.toUpperCase()}`,
    ]);
  });

  it('a movimentação leva as inscrições (transitórias) e o tipo, nunca o nome do advogado', () => {
    const m = mapearMovimentacao(REAL);
    expect(m.destinatariosOab).toEqual(inscricoesDosDestinatarios(REAL));
    expect(m.tipoComunicacao).toBe('Intimação');
    expect(JSON.stringify(m)).not.toContain(
      REAL.destinatarioadvogados?.[0]?.advogado.nome as string,
    );
  });

  it('sem advogado (parte sem advogado) ou sem inscrição legível, o campo não existe', () => {
    expect(mapearMovimentacao(variante([])).destinatariosOab).toBeUndefined();
    expect(mapearMovimentacao(variante(null)).destinatariosOab).toBeUndefined();
    expect(
      mapearMovimentacao(
        variante([adv('Fulano', null, 'GO'), adv('Beltrano', '123', null)]),
      ).destinatariosOab,
    ).toBeUndefined();
  });

  it('vários advogados: todas as inscrições legíveis, sem repetir', () => {
    const c = variante([
      adv('A', '0123', 'go'),
      adv('B', '456', 'SP'),
      adv('A2', '123', 'GO'),
      adv('C', null, 'SP'),
    ]);
    expect(inscricoesDosDestinatarios(c)).toEqual(['123/GO', '456/SP']);
  });
});

describe('a serialização do banco nunca leva inscrição de terceiro', () => {
  const processo = new Processo({
    numero: NumeroCNJ.criar('1234567-47.2023.8.26.0100'),
    tribunal: 'TJSP',
    movimentacoes: [{ ...mapearMovimentacao(REAL), destinatariosOab: ['777/GO'] }],
    procedencia: {
      provider: 'djen',
      consultadoEm: new Date('2026-10-01T00:00:00Z'),
      deCache: false,
    },
  });

  it('por padrão (banco) as inscrições são removidas', () => {
    expect(JSON.stringify(serializarProcesso(processo))).not.toContain('777/GO');
  });

  it('o cache em memória as preserva, para a sincronização que lê dele', () => {
    expect(
      JSON.stringify(serializarProcesso(processo, { preservarDestinatarios: true })),
    ).toContain('777/GO');
  });
});
