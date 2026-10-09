import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import {
  NOME_DO_ARQUIVO_DA_TABELA,
  abrirSomenteLeitura,
  executarDiagnostico,
  mascararNumero,
} from '../../src/infrastructure/persistencia/diagnosticoDeProvidencia.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';

/*
 * Sonda de diagnóstico (v1.0.0). Banco em arquivo temporário, dados SINTÉTICOS
 * (números com DV válido e inventados, rótulos genéricos), relógio fixo.
 */
const AGORA = new Date('2026-10-09T15:00:00Z');
const dia = (n: number): Date => new Date(AGORA.getTime() - n * 86_400_000);
const WS = 'ws-sonda';

const GO_1 = numeroValido(1, '09', '0001'); // aparece
const GO_SEM_DETECCAO = numeroValido(2, '09', '0002'); // pede, mas nunca teve novidade (Período)
const GO_SEM_PROV = numeroValido(3, '09', '0003'); // novidade recente, nada pede providência
const GO_CUMPRIDO = numeroValido(4, '09', '0004'); // pediria; marca cobre
const SP = numeroValido(5, '26', '0100'); // outro tribunal
const NAO_ACOMPANHADO = numeroValido(6, '09', '0006');

const intimacao = (dias: number, id: number, paraOUsuario?: 'sim' | 'nao'): Movimentacao => ({
  data: dia(dias),
  titulo: 'Ato ordinatório',
  idExterno: `djen:${id}`,
  tipoComunicacao: 'Intimação',
  ...(paraOUsuario ? { paraOUsuario } : {}),
});

function processo(numero: string, tribunal: string, movs: Movimentacao[], provider = 'datajud+djen'): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal,
    classe: 'Procedimento Comum Cível',
    movimentacoes: movs,
    procedencia: { provider, consultadoEm: AGORA, deCache: false },
  });
}

describe('sonda de diagnóstico da providência', () => {
  let pasta: string;
  let caminho: string;
  const saida: string[] = [];
  const avisos: string[] = [];

  async function semear(): Promise<void> {
    const db = abrirBanco(caminho);
    const repo = new RepositorioAcompanhamentosSqlite(db);
    const gravar = async (n: string, t: string, movs: Movimentacao[], novidades: Movimentacao[] = []): Promise<void> => {
      await repo.acompanhar(WS, NumeroCNJ.criar(n).digitos);
      await repo.registrarSincronizacao(WS, NumeroCNJ.criar(n).digitos, processo(n, t, movs), novidades);
    };
    const nova = intimacao(3, 10, 'sim');
    await gravar(GO_1, 'TJGO', [nova], [nova]);
    await gravar(GO_SEM_DETECCAO, 'TJGO', [intimacao(4, 20)]);
    await gravar(GO_SEM_PROV, 'TJGO', [{ data: dia(1), titulo: 'Juntada de petição' }], [
      { data: dia(1), titulo: 'Juntada de petição' },
    ]);
    const velha = intimacao(6, 30);
    await gravar(GO_CUMPRIDO, 'TJGO', [velha]);
    await repo.marcarCumprido(WS, NumeroCNJ.criar(GO_CUMPRIDO).digitos, {
      chave: chaveDaMovimentacao(velha),
      ate: velha.data,
      em: AGORA,
      por: 'u:1',
    });
    await gravar(SP, 'TJSP', [intimacao(2, 40, 'sim')], [intimacao(2, 40, 'sim')]);
    db.prepare(
      `INSERT INTO usuarios (id, email, nome, senha, workspace, criado_em)
       VALUES ('u1', 'ana@exemplo.com.br', 'Ana', 'SEGREDO-DE-SENHA', ?, ?)`,
    ).run(WS, AGORA.toISOString());
    db.close();
  }

  const rodar = (args: string[], extra: Partial<Parameters<typeof executarDiagnostico>[1]> = {}): number =>
    executarDiagnostico(args, {
      caminhoBanco: caminho,
      agora: () => AGORA,
      saida: (l) => saida.push(l),
      aviso: (l) => avisos.push(l),
      pastaTemporaria: pasta,
      ...extra,
    });
  const texto = (): string => saida.join('\n');
  const hash = (): string => createHash('sha256').update(readFileSync(caminho)).digest('hex');

  beforeEach(async () => {
    pasta = mkdtempSync(join(tmpdir(), 'sonda-'));
    caminho = join(pasta, 'processovivo.db');
    saida.length = 0;
    avisos.length = 0;
    await semear();
  });
  afterEach(() => rmSync(pasta, { recursive: true, force: true }));

  describe('cada predicado do filtro', () => {
    it('aparece: acompanhado, TJGO, detectado no período e pede providência', () => {
      expect(rodar([`--numeros=${GO_1}`, '--mostrar'])).toBe(0);
      expect(texto()).toContain('acompanhado: sim');
      expect(texto()).toContain('=> APARECE');
      expect(texto()).toContain('destinatário sim');
    });

    it('não acompanhado', () => {
      rodar([`--numeros=${NAO_ACOMPANHADO}`]);
      expect(texto()).toContain('acompanhado: não');
      expect(texto()).toContain('NÃO aparece, porque o processo não está acompanhado');
    });

    it('outro tribunal: diz o do retrato e o do número', () => {
      rodar([`--numeros=${SP}`]);
      expect(texto()).toMatch(/NÃO aparece, porque o tribunal do retrato é TJSP, não TJGO/);
      expect(texto()).toContain('tribunal=TJGO:não');
    });

    it('Período usa a DETECÇÃO: pede providência, mas nunca teve novidade → fora', () => {
      rodar([`--numeros=${GO_SEM_DETECCAO}`]);
      const t = texto();
      expect(t).toContain('situação(pede providência):sim');
      expect(t).toContain('período(detectadaEm ≤ 15d):não');
      expect(t).toMatch(/NÃO aparece, porque o Período usa a data de DETECÇÃO e este processo nunca teve novidade/);
      expect(t).toContain('novidades: 0 no total');
    });

    it('Situação: novidade recente mas nada pede providência', () => {
      rodar([`--numeros=${GO_SEM_PROV}`]);
      expect(texto()).toContain('período(detectadaEm ≤ 15d):sim');
      expect(texto()).toMatch(/NÃO aparece, porque nenhum ato dentro da janela pede providência/);
    });

    it('retrato antigo, sem o tipo da comunicação gravado: diz que o tipo só entra na próxima sincronização', async () => {
      const antigo = numeroValido(8, '09', '0008');
      const db = abrirBanco(caminho);
      const repo = new RepositorioAcompanhamentosSqlite(db);
      const semTipo: Movimentacao = { data: dia(4), titulo: 'Ato ordinatório', idExterno: 'djen:80' };
      await repo.acompanhar(WS, NumeroCNJ.criar(antigo).digitos);
      await repo.registrarSincronizacao(WS, NumeroCNJ.criar(antigo).digitos, processo(antigo, 'TJGO', [semTipo]), [
        { ...semTipo, data: dia(4) },
      ]);
      db.close();
      rodar([`--numeros=${antigo}`]);
      expect(texto()).toContain('0 com tipo gravado');
      expect(texto()).toMatch(/nenhuma comunicação do Diário com tipo gravado/);
    });

    it('marca de cumprido: diz que o ato está coberto', () => {
      rodar([`--numeros=${GO_CUMPRIDO}`]);
      expect(texto()).toContain('providência: cumprida');
      expect(texto()).toContain('tem marca de cumprido');
      expect(texto()).toMatch(/coberto por uma marca de "cumprido"/);
    });
  });

  describe('--lista-filtro', () => {
    it('lista exatamente os que passam, com a contagem e a instrução para conferir com o Projudi', () => {
      expect(rodar(['--lista-filtro'])).toBe(0);
      const t = texto();
      expect(t).toContain('Total: 1 processos passam no filtro');
      expect(t).toContain('Marque, na lista acima');
    });

    it('conta à parte os que ficam de fora SÓ pelo Período', () => {
      rodar(['--lista-filtro']);
      expect(texto()).toMatch(/FICAM DE FORA só pelo Período[^\n]*: 1\n/);
    });

    it('a janela e o tribunal são argumentos', () => {
      rodar(['--lista-filtro', '--tribunal=TJSP', '--janela=60']);
      expect(texto()).toContain('TJSP + Pedem providência + Últimos 60 dias');
      expect(texto()).toContain('Total: 1 processos passam no filtro');
    });
  });

  describe('mascaramento', () => {
    it('sem --mostrar nenhum número aparece inteiro, nem na lista nem no relatório', () => {
      rodar([`--numeros=${GO_1},${SP}`]);
      rodar(['--lista-filtro']);
      const t = texto();
      for (const n of [GO_1, GO_SEM_DETECCAO, GO_SEM_PROV, GO_CUMPRIDO, SP]) {
        expect(t).not.toContain(NumeroCNJ.criar(n).formatado);
        expect(t).not.toContain(n);
        expect(t).not.toContain(NumeroCNJ.criar(n).sequencial);
      }
      expect(t).toContain(mascararNumero(GO_1));
    });

    it('com --mostrar mostra o número formatado e o rótulo curto do ato', () => {
      rodar([`--numeros=${GO_1}`, '--mostrar']);
      expect(texto()).toContain(NumeroCNJ.criar(GO_1).formatado);
      expect(texto()).toContain('"Ato ordinatório"');
    });

    it('sem --mostrar o rótulo do ato não sai', () => {
      rodar([`--numeros=${GO_1}`]);
      expect(texto()).not.toContain('Ato ordinatório');
    });

    it('o rótulo é cortado em 60 caracteres', async () => {
      const longo = numeroValido(7, '09', '0007');
      const db = abrirBanco(caminho);
      const repo = new RepositorioAcompanhamentosSqlite(db);
      await repo.acompanhar(WS, NumeroCNJ.criar(longo).digitos);
      await repo.registrarSincronizacao(
        WS,
        NumeroCNJ.criar(longo).digitos,
        processo(longo, 'TJGO', [{ data: dia(2), titulo: `Despacho ${'x'.repeat(100)}` }]),
        [{ data: dia(2), titulo: 'x' }],
      );
      db.close();
      rodar([`--numeros=${longo}`, '--mostrar']);
      const linha = texto().split('\n').find((l) => l.includes('providência: pede')) ?? '';
      const rotulo = /"(.*)"/.exec(linha)?.[1] ?? '';
      expect(rotulo).toHaveLength(60);
      expect(rotulo.endsWith('…')).toBe(true);
    });
  });

  describe('somente leitura', () => {
    it('o banco não muda um byte nem a data de modificação, em nenhum modo', () => {
      const antes = { h: hash(), m: statSync(caminho).mtimeMs };
      rodar(['--lista-filtro', '--mostrar']);
      rodar([`--numeros=${GO_1},${SP},${NAO_ACOMPANHADO}`]);
      expect(hash()).toBe(antes.h);
      expect(statSync(caminho).mtimeMs).toBe(antes.m);
    });

    it('a conexão recusa escrita', () => {
      const db = abrirSomenteLeitura(caminho);
      expect(() => db.exec('DELETE FROM novidades')).toThrow(/readonly|read-only|query_only/i);
      expect(() => db.exec('CREATE TABLE intruso (x)')).toThrow(/readonly|read-only|query_only/i);
      db.close();
    });

    it('sem migração: num banco de esquema ANTIGO (sem as colunas de cumprido) roda e não cria coluna', () => {
      const antigo = join(pasta, 'antigo.db');
      const db = new DatabaseSync(antigo);
      db.exec(`CREATE TABLE acompanhamentos (workspace TEXT, numero TEXT, tribunal TEXT,
                 sincronizado_em TEXT, erro TEXT, processo TEXT, PRIMARY KEY (workspace, numero));
               CREATE TABLE novidades (id INTEGER PRIMARY KEY, workspace TEXT, numero TEXT, data TEXT,
                 titulo TEXT, detectada_em TEXT, vista_em TEXT);
               CREATE TABLE usuarios (id TEXT, email TEXT, workspace TEXT);`);
      db.prepare('INSERT INTO acompanhamentos (workspace, numero, tribunal) VALUES (?, ?, ?)').run(
        'w',
        NumeroCNJ.criar(GO_1).digitos,
        'TJGO',
      );
      db.close();
      const h = createHash('sha256').update(readFileSync(antigo)).digest('hex');
      const codigo = executarDiagnostico([`--numeros=${GO_1}`], {
        caminhoBanco: antigo,
        agora: () => AGORA,
        saida: (l) => saida.push(l),
        aviso: (l) => avisos.push(l),
        pastaTemporaria: pasta,
      });
      expect(codigo).toBe(0);
      expect(texto()).toContain('SEM retrato');
      expect(createHash('sha256').update(readFileSync(antigo)).digest('hex')).toBe(h);
      const conferir = new DatabaseSync(antigo, { readOnly: true });
      const cols = (conferir.prepare('PRAGMA table_info(acompanhamentos)').all() as Array<{ name: string }>).map((c) => c.name);
      conferir.close();
      expect(cols).not.toContain('cumprido_chave');
    });

    it('banco inexistente: recusa sem criar arquivo', () => {
      const inexistente = join(pasta, 'nao-existe.db');
      expect(rodar(['--lista-filtro'], { caminhoBanco: inexistente })).toBe(1);
      expect(() => statSync(inexistente)).toThrow();
    });

    it('nunca lê a senha: o valor gravado não aparece em lugar nenhum', () => {
      rodar(['--lista-filtro', '--mostrar']);
      expect(texto() + avisos.join('\n')).not.toContain('SEGREDO-DE-SENHA');
    });
  });

  describe('workspace', () => {
    function segundoWorkspace(): void {
      const db = new DatabaseSync(caminho);
      db.prepare(
        `INSERT INTO acompanhamentos (workspace, numero, criado_em) VALUES ('outro-ws', ?, ?)`,
      ).run(NumeroCNJ.criar(NAO_ACOMPANHADO).digitos, AGORA.toISOString());
      db.close();
    }

    it('com um workspace só, dispensa --workspace', () => {
      expect(rodar(['--lista-filtro'])).toBe(0);
    });

    it('com mais de um, recusa sem --workspace e lista as opções (e-mail mascarado)', () => {
      segundoWorkspace();
      expect(rodar(['--lista-filtro'])).toBe(2);
      expect(avisos.join('\n')).toContain('informe --workspace');
      expect(avisos.join('\n')).toContain('a***@exemplo.com.br');
      expect(avisos.join('\n')).not.toContain('ana@exemplo.com.br');
      expect(texto()).not.toContain('processos passam');
    });

    it('aceita o identificador ou o e-mail da conta, e recusa o que não existe', () => {
      segundoWorkspace();
      expect(rodar(['--lista-filtro', `--workspace=${WS}`])).toBe(0);
      saida.length = 0;
      expect(rodar(['--lista-filtro', '--workspace=ANA@exemplo.com.br'])).toBe(0);
      expect(rodar(['--lista-filtro', '--workspace=inexistente'])).toBe(2);
    });

    it('um processo de OUTRO workspace não é visto: aparece como não acompanhado', () => {
      segundoWorkspace();
      saida.length = 0;
      rodar([`--numeros=${NAO_ACOMPANHADO}`, `--workspace=${WS}`]);
      expect(texto()).toContain('acompanhado: não');
    });
  });

  describe('entradas', () => {
    it('lê números de um arquivo, um por linha, ignorando linhas vazias e números inválidos', () => {
      const arq = join(pasta, 'numeros.txt');
      writeFileSync(arq, `${NumeroCNJ.criar(GO_1).formatado}\n\n123\n${SP}\n`);
      expect(rodar([`--arquivo=${arq}`])).toBe(0);
      expect(texto()).toContain('#1 ');
      expect(texto()).toContain('#2 ');
      expect(avisos.join('\n')).toContain('1 número(s) pedido(s) não são números CNJ válidos');
    });

    it('sem nada para fazer, mostra o uso', () => {
      expect(rodar([])).toBe(2);
      expect(avisos.join('\n')).toContain('Informe --numeros');
    });

    it('argumento desconhecido é recusado', () => {
      expect(rodar(['--apagar'])).toBe(2);
    });
  });

  describe('arquivo numérico em os.tmpdir()', () => {
    it('só contagens e booleanos: nem número de processo, nem rótulo, nem data', () => {
      rodar(['--lista-filtro', '--mostrar']);
      const bruto = readFileSync(join(pasta, NOME_DO_ARQUIVO_DA_TABELA), 'utf8');
      for (const n of [GO_1, GO_SEM_DETECCAO, GO_SEM_PROV, GO_CUMPRIDO, SP]) {
        expect(bruto).not.toContain(n);
        expect(bruto).not.toContain(NumeroCNJ.criar(n).formatado);
      }
      expect(bruto).not.toContain('Ato ordinatório');
      expect(bruto).not.toContain('Juntada');
      expect(bruto).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      const json = JSON.parse(bruto) as { processos: Array<Record<string, unknown>> };
      expect(json.processos).toHaveLength(5);
      for (const p of json.processos) {
        for (const v of Object.values(p)) {
          expect(['number', 'boolean']).toContain(v === null ? 'number' : typeof v);
        }
      }
    });

    it('o resumo separa os pedidos por destinatário', () => {
      rodar(['--lista-filtro']);
      const { resumo } = JSON.parse(readFileSync(join(pasta, NOME_DO_ARQUIVO_DA_TABELA), 'utf8')) as {
        resumo: Record<string, number>;
      };
      expect(resumo['passamNoFiltro']).toBe(1);
      expect(resumo['forasSoPeloPeriodo']).toBe(1);
      expect(resumo['pedemPorIntimacaoDestinatarioSim']).toBe(2);
      expect(resumo['pedemPorIntimacaoDestinatarioDesconhecido']).toBe(1);
    });
  });
});
