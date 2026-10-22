import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import {
  diagnosticarResumo,
  executarDiagnosticoDoResumo,
  motivoDeNaoSerUtilizavel,
} from '../../src/main/sonda/diagnosticoDoResumo.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';

/* Dados SINTÉTICOS: número com DV válido e inventado, textos genéricos, relógio fixo. */
const AGORA = new Date('2026-10-09T15:00:00Z');
const dia = (n: number): Date => new Date(AGORA.getTime() - n * 86_400_000);
const MARCA = 'TEXTO-SINTETICO-QUE-NAO-PODE-SAIR';
const LONGO = `Determino a intimação da parte autora para se manifestar sobre o laudo. ${MARCA}`;
const NUMERO = numeroValido(21, '09', '0001');

const djen = (
  id: number,
  dias: number,
  extra: Partial<Movimentacao> = {},
): Movimentacao => ({
  data: dia(dias),
  titulo: 'Despacho',
  idExterno: `djen:${id}`,
  fonte: 'djen',
  ...extra,
});

describe('diagnóstico do resumo por IA', () => {
  describe('regra (as mesmas do serviço)', () => {
    it('explica por que o ato mais recente não conta como texto', () => {
      expect(
        motivoDeNaoSerUtilizavel(djen(1, 1, { teorIndisponivel: true, conteudo: LONGO })),
      ).toBe('teor_indisponivel');
      expect(motivoDeNaoSerUtilizavel(djen(2, 1))).toBe('sem_conteudo_nem_complementos');
      expect(motivoDeNaoSerUtilizavel(djen(3, 1, { conteudo: 'Ciência.' }))).toBe(
        'texto_curto',
      );
      expect(motivoDeNaoSerUtilizavel(djen(4, 1, { conteudo: LONGO }))).toBeUndefined();
    });

    it('conta o corpo pelos complementos quando não há conteúdo', () => {
      const d = diagnosticarResumo(
        [djen(1, 1, { complementos: ['tipo_de_documento: ' + 'x'.repeat(90)] })],
        AGORA,
        10,
      );
      expect(d.maisRecentes[0]?.campos.origemDoCorpo).toBe('complementos');
      expect(d.maisRecentes[0]?.textoUtilizavel).toBe(true);
    });

    it('mostra o ato mais recente sem texto mesmo com providência e texto antigo', () => {
      const d = diagnosticarResumo(
        [
          djen(1, 1, { teorIndisponivel: true }),
          djen(2, 400, { titulo: 'Decisão', conteudo: LONGO }),
        ],
        AGORA,
        10,
      );
      const topo = d.maisRecentes[0];
      expect(topo?.pedeProvidencia).toBe(true);
      expect(topo?.textoUtilizavel).toBe(false);
      expect(topo?.motivoSemTexto).toBe('teor_indisponivel');
      expect(d.pedemProvidenciaSemTexto).toBe(1);
      expect(d.selecao.comTexto).toBe(1);
    });
  });

  describe('comando', () => {
    let pasta: string;
    let caminho: string;
    const saida: string[] = [];
    const avisos: string[] = [];

    beforeEach(async () => {
      saida.length = 0;
      avisos.length = 0;
      pasta = mkdtempSync(join(tmpdir(), 'diag-resumo-'));
      caminho = join(pasta, 'p.db');
      const db = abrirBanco(caminho);
      const repo = new RepositorioAcompanhamentosSqlite(db);
      const n = NumeroCNJ.criar(NUMERO);
      await repo.acompanhar('ws-a', n.digitos);
      await repo.registrarSincronizacao(
        'ws-a',
        n.digitos,
        new Processo({
          numero: n,
          tribunal: 'TJGO',
          movimentacoes: [
            djen(1, 1, { teorIndisponivel: true, titulo: 'Despacho NOME-DO-TITULO' }),
            djen(2, 30, { conteudo: LONGO, titulo: 'Decisão' }),
          ],
          segredoJustica: false,
          procedencia: { provider: 'datajud+djen', consultadoEm: AGORA, deCache: false },
        }),
        [],
      );
      db.close();
    });
    afterEach(() => rmSync(pasta, { recursive: true, force: true }));

    const rodar = (args: string[]): number =>
      executarDiagnosticoDoResumo(args, {
        caminhoBanco: caminho,
        existeArquivo: () => true,
        agora: () => AGORA,
        janelaDePendenciaDias: 10,
        saida: (l) => saida.push(l),
        aviso: (l) => avisos.push(l),
      });

    it('imprime só números e categorias: nada de texto, título, número ou conta', () => {
      expect(rodar([NUMERO])).toBe(0);
      const tudo = [...saida, ...avisos].join('\n');
      expect(tudo).toContain('Os 5 atos mais recentes');
      expect(tudo).toContain('teor_indisponivel');
      expect(tudo).not.toContain(MARCA);
      expect(tudo).not.toContain('NOME-DO-TITULO');
      expect(tudo).not.toContain(NUMERO);
      expect(tudo).not.toContain('ws-a');
      expect(tudo).not.toContain('djen:');
    });

    it('não altera o banco', () => {
      const antes = readFileSync(caminho);
      rodar([NUMERO]);
      expect(readFileSync(caminho).equals(antes)).toBe(true);
    });

    it('recusa número inválido, processo não acompanhado e falta de argumento', () => {
      expect(rodar(['123'])).toBe(1);
      expect(rodar([numeroValido(22, '09', '0002')])).toBe(1);
      expect(rodar([])).toBe(1);
      expect(avisos.join('\n')).not.toContain(NUMERO);
    });

    it('não importa abrirBanco nem adapter de rede', () => {
      const fonte = readFileSync(
        join(import.meta.dirname, '../../src/main/sonda/diagnosticoDoResumo.ts'),
        'utf8',
      );
      const imports = [...fonte.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '');
      expect(
        imports.some(
          (i) => i.endsWith('/banco.js') || /Adapter|HttpClient|node:https?/.test(i),
        ),
      ).toBe(false);
    });
  });
});
