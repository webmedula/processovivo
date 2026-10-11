import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepararEntrada } from '../../src/application/politicas/entradaDoModelo.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import {
  categoriaDoAto,
  executarDiagnosticoDeTexto,
  fonteDoAto,
  NOME_DO_ARQUIVO_DA_TABELA_DE_TEXTO,
  type ResultadoDoWorkspace,
} from '../../src/main/sonda/diagnosticoDeTextoPorAto.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';

/* Dados SINTÉTICOS: números com DV válido e inventados, textos genéricos, relógio fixo. */
const AGORA = new Date('2026-10-09T15:00:00Z');
const dia = (n: number): Date => new Date(AGORA.getTime() - n * 86_400_000);
const WS_A = 'ws-a';
const WS_B = 'ws-b';
const MARCA_NO_TEXTO = 'TEXTO-SINTETICO-QUE-NAO-PODE-SAIR';
const LONGO = `Intime-se a parte autora para se manifestar sobre o laudo juntado aos autos. ${MARCA_NO_TEXTO}`;

const N = {
  a: numeroValido(11, '09', '0001'),
  b: numeroValido(12, '09', '0002'),
  segredo: numeroValido(13, '09', '0003'),
  semRetrato: numeroValido(14, '09', '0004'),
  outraConta: numeroValido(15, '09', '0005'),
};

const djen = (
  id: number,
  dias: number,
  extra: Partial<Movimentacao> = {},
): Movimentacao => ({
  data: dia(dias),
  titulo: 'Intimação',
  idExterno: `djen:${id}`,
  fonte: 'djen',
  tipoComunicacao: 'Intimação',
  ...extra,
});

function processo(
  numero: string,
  movs: Movimentacao[],
  segredoJustica = false,
  provider = 'datajud+djen',
): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal: 'TJGO',
    movimentacoes: movs,
    segredoJustica,
    procedencia: { provider, consultadoEm: AGORA, deCache: false },
  });
}

describe('diagnóstico do texto por ato', () => {
  let pasta: string;
  let caminho: string;
  const saida: string[] = [];
  const avisos: string[] = [];

  async function semear(): Promise<void> {
    const db = abrirBanco(caminho);
    const repo = new RepositorioAcompanhamentosSqlite(db);
    const gravar = async (ws: string, n: string, p: Processo | null): Promise<void> => {
      await repo.acompanhar(ws, NumeroCNJ.criar(n).digitos);
      if (p) await repo.registrarSincronizacao(ws, NumeroCNJ.criar(n).digitos, p, []);
    };
    await gravar(
      WS_A,
      N.a,
      processo(N.a, [
        djen(1, 2, { conteudo: LONGO }), // suficiente, DJEN, pede providência (intimação recente)
        djen(2, 40, { conteudo: LONGO }), // suficiente, fora dos 30 dias
        djen(3, 3, { teorIndisponivel: true }), // aviso de indisponível
        djen(4, 5, { conteudo: 'Ciência.' }), // curto
        { data: dia(1), titulo: 'Juntada de petição', fonte: 'datajud', codigoTpu: 85 }, // DataJud, sem texto algum
        {
          data: dia(50),
          titulo: 'Expedição de documento',
          fonte: 'datajud',
          complementos: [
            'tipo_de_documento: mandado de citação, intimação e penhora para cumprimento pelo oficial',
          ],
        }, // DataJud com complemento longo: conta como suficiente (a regra é a da entrada)
        { data: dia(10), titulo: 'Citação', idExterno: 'mni:99', conteudo: LONGO }, // MNI pelo prefixo
      ]),
    );
    // Processo sob segredo: nada do texto vale, tenha ou não.
    await gravar(
      WS_A,
      N.segredo,
      processo(N.segredo, [djen(5, 2, { conteudo: LONGO })], true),
    );
    await gravar(
      WS_A,
      N.b,
      processo(N.b, [
        djen(6, 4, { conteudo: 'Ato sem providência', tipoComunicacao: 'Edital' }),
      ]),
    );
    await gravar(WS_A, N.semRetrato, null);
    // Outra conta: não pode entrar na contagem da A.
    await gravar(
      WS_B,
      N.outraConta,
      processo(N.outraConta, [djen(7, 2, { conteudo: LONGO })]),
    );
    db.prepare(
      `INSERT INTO usuarios (id, email, nome, senha, workspace, criado_em)
       VALUES ('u1', 'ana@exemplo.com.br', 'Ana', 'SEGREDO-DE-SENHA', ?, ?)`,
    ).run(WS_A, AGORA.toISOString());
    db.prepare(
      `INSERT INTO usuarios (id, email, nome, senha, workspace, criado_em)
       VALUES ('u2', 'bia@exemplo.com.br', 'Bia', 'OUTRA-SENHA', ?, ?)`,
    ).run(WS_B, AGORA.toISOString());
    db.close();
  }

  const rodar = (args: string[] = []): number =>
    executarDiagnosticoDeTexto(args, {
      caminhoBanco: caminho,
      agora: () => AGORA,
      saida: (l) => saida.push(l),
      aviso: (l) => avisos.push(l),
      pastaTemporaria: pasta,
    });
  const texto = (): string => saida.join('\n');
  const tabela = (): { contas: ResultadoDoWorkspace[]; total: ResultadoDoWorkspace } =>
    JSON.parse(readFileSync(join(pasta, NOME_DO_ARQUIVO_DA_TABELA_DE_TEXTO), 'utf8'));
  const hash = (): string =>
    createHash('sha256').update(readFileSync(caminho)).digest('hex');

  beforeEach(async () => {
    pasta = mkdtempSync(join(tmpdir(), 'sonda-texto-'));
    caminho = join(pasta, 'processovivo.db');
    saida.length = 0;
    avisos.length = 0;
    await semear();
  });
  afterEach(() => rmSync(pasta, { recursive: true, force: true }));

  describe('contagens', () => {
    it('conta processos, atos totais e dos últimos 30 dias, só da conta pedida', () => {
      expect(rodar(['--workspace=ana@exemplo.com.br'])).toBe(0);
      const [a] = tabela().contas;
      expect(a?.processosAcompanhados).toBe(4);
      expect(a?.semRetrato).toBe(1);
      expect(a?.emSegredoDeJustica).toBe(1);
      // 7 atos do N.a + 1 do segredo + 1 do N.b = 9; dos 7, os de 40 e 50 dias saem da janela.
      expect(a?.todas.total.atos).toBe(9);
      expect(a?.todas.ultimosDias.atos).toBe(7);
    });

    it('classifica em categorias exclusivas que somam o total', () => {
      rodar(['--workspace=ana@exemplo.com.br']);
      const c = tabela().contas[0]?.todas.total;
      expect(c).toMatchObject({
        atos: 9,
        suficiente: 4,
        indisponivel: 1,
        segredo: 1,
        curto: 3,
        curtoSemTextoAlgum: 1,
      });
      expect(
        (c?.suficiente ?? 0) +
          (c?.indisponivel ?? 0) +
          (c?.segredo ?? 0) +
          (c?.curto ?? 0),
      ).toBe(c?.atos);
    });

    it('separa por fonte: DJEN, DataJud, MNI (pelo campo ou pelo prefixo do identificador)', () => {
      rodar(['--workspace=ana@exemplo.com.br']);
      const f = tabela().contas[0]?.porFonte;
      expect(f?.djen.total.atos).toBe(6);
      expect(f?.datajud.total.atos).toBe(2);
      expect(f?.mni.total.atos).toBe(1);
      expect(f?.outra.total.atos).toBe(0);
      expect(f?.datajud.total).toMatchObject({
        suficiente: 1,
        curto: 1,
        curtoSemTextoAlgum: 1,
      });
      expect(f?.djen.ultimosDias.indisponivel).toBe(1);
    });

    it('segredo de justiça vale mais que o texto: ato com texto suficiente conta como segredo', () => {
      rodar(['--workspace=ana@exemplo.com.br']);
      const djenSegredo = tabela().contas[0]?.porFonte.djen.total;
      expect(djenSegredo?.segredo).toBe(1);
    });

    it('entre os que pedem providência hoje, conta os de ato com texto suficiente', () => {
      rodar(['--workspace=ana@exemplo.com.br']);
      const p = tabela().contas[0]?.providencia;
      // N.a (intimação com texto suficiente), N.segredo (o mesmo ato, mas sigiloso) e N.b
      // (o ato que pede é de 19 caracteres: curto) pedem providência.
      expect(p).toMatchObject({
        pedem: 3,
        atoSuficiente: 1,
        atoSegredo: 1,
        atoCurto: 1,
        atoNaoLocalizado: 0,
      });
      expect(p?.atoIndisponivel).toBe(0);
    });

    it('sem --workspace conta todas as contas, cada uma no seu bloco, mais o total', () => {
      rodar();
      const t = tabela();
      expect(t.contas).toHaveLength(2);
      expect(t.total.processosAcompanhados).toBe(5);
      expect(t.total.todas.total.atos).toBe(10);
      expect(texto()).toContain('TOTAL de 2 contas');
    });

    it('a janela de atos é argumento', () => {
      rodar(['--workspace=ana@exemplo.com.br', '--janela-dias=60']);
      expect(tabela().contas[0]?.todas.ultimosDias.atos).toBe(9);
    });
  });

  describe('o critério é o da entrada do modelo', () => {
    const casos: Array<[string, Movimentacao]> = [
      [
        'só título',
        {
          data: dia(1),
          titulo: 'Juntada de petição de contestação e documentos diversos do processo',
        },
      ],
      ['conteúdo curto', djen(1, 1, { conteudo: 'Ciência da decisão.' })],
      ['conteúdo longo', djen(2, 1, { conteudo: LONGO })],
      [
        'complemento longo',
        {
          data: dia(1),
          titulo: 'X',
          complementos: ['tipo_de_documento: ' + 'a'.repeat(80)],
        },
      ],
      ['79 caracteres', djen(3, 1, { conteudo: 'x'.repeat(79) })],
      ['80 caracteres', djen(4, 1, { conteudo: 'x'.repeat(80) })],
      [
        'espaços não contam',
        djen(5, 1, { conteudo: `${'x '.repeat(30)}${' '.repeat(100)}` }),
      ],
    ];
    it.each(casos)(
      '%s: a classificação "suficiente" coincide com prepararEntrada().suficiente',
      (_n, m) => {
        const esperado = prepararEntrada({
          data: m.data,
          titulo: m.titulo,
          ...(m.conteudo !== undefined ? { conteudo: m.conteudo } : {}),
          ...(m.complementos ? { complementos: m.complementos } : {}),
        }).suficiente;
        expect(categoriaDoAto(m, false) === 'suficiente').toBe(esperado);
      },
    );

    it('o aviso de indisponível é reconhecido pela marca e pelo texto do aviso', () => {
      expect(categoriaDoAto(djen(1, 1, { teorIndisponivel: true }), false)).toBe(
        'indisponivel',
      );
      expect(
        categoriaDoAto(
          djen(2, 1, {
            conteudo: 'ARQUIVOS DIGITAIS INDISPONÍVEIS (NÃO SÃO DO TIPO PÚBLICO)',
          }),
          false,
        ),
      ).toBe('indisponivel');
    });

    it('fonte: campo, depois prefixo do identificador, depois a única fonte do retrato', () => {
      expect(
        fonteDoAto({ data: dia(1), titulo: 'x', fonte: 'mni' }, 'datajud+djen'),
      ).toBe('mni');
      expect(
        fonteDoAto({ data: dia(1), titulo: 'x', idExterno: 'djen:1' }, 'datajud+djen'),
      ).toBe('djen');
      expect(fonteDoAto({ data: dia(1), titulo: 'x' }, 'datajud')).toBe('datajud');
      expect(fonteDoAto({ data: dia(1), titulo: 'x' }, 'datajud+djen')).toBe('outra');
    });
  });

  describe('só leitura e só contagens', () => {
    it('o banco não muda um byte nem a data de modificação', () => {
      const antes = { h: hash(), m: statSync(caminho).mtimeMs };
      rodar();
      rodar(['--workspace=ana@exemplo.com.br']);
      expect({ h: hash(), m: statSync(caminho).mtimeMs }).toEqual(antes);
    });

    it('banco inexistente: recusa sem criar arquivo', () => {
      const codigo = executarDiagnosticoDeTexto([], {
        caminhoBanco: join(pasta, 'nao-existe.db'),
        saida: () => undefined,
        aviso: (l) => avisos.push(l),
        pastaTemporaria: pasta,
      });
      expect(codigo).toBe(1);
      expect(() => statSync(join(pasta, 'nao-existe.db'))).toThrow();
    });

    it('nem o texto do ato, nem número de processo, nem senha, nem o e-mail inteiro saem no terminal', () => {
      rodar();
      const tudo = [...saida, ...avisos].join('\n');
      expect(tudo).not.toContain(MARCA_NO_TEXTO);
      expect(tudo).not.toContain('SEGREDO-DE-SENHA');
      expect(tudo).not.toContain('ana@exemplo.com.br');
      expect(tudo).toContain('a***@exemplo.com.br');
      for (const n of Object.values(N)) {
        expect(tudo).not.toContain(n);
        expect(tudo).not.toContain(NumeroCNJ.criar(n).formatado);
      }
    });

    it('o arquivo em os.tmpdir() leva só números: sem texto, sem número de processo, sem e-mail, sem id de conta', () => {
      rodar();
      const bruto = readFileSync(join(pasta, NOME_DO_ARQUIVO_DA_TABELA_DE_TEXTO), 'utf8');
      expect(bruto).not.toContain(MARCA_NO_TEXTO);
      expect(bruto).not.toContain('exemplo.com.br');
      expect(bruto).not.toContain(WS_A);
      expect(bruto).not.toContain(WS_B);
      for (const n of Object.values(N)) expect(bruto).not.toContain(n);
      const valores: unknown[] = [];
      const percorrer = (v: unknown): void => {
        if (v && typeof v === 'object') Object.values(v).forEach(percorrer);
        else valores.push(v);
      };
      percorrer(JSON.parse(bruto));
      expect(valores.filter((v) => typeof v === 'string').sort()).toEqual(['1.0.0']);
    });

    it('não importa adapter de rede nem transporte de modelo', () => {
      const fonte = readFileSync(
        join(import.meta.dirname, '../../src/main/sonda/diagnosticoDeTextoPorAto.ts'),
        'utf8',
      );
      const imports = [...fonte.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '');
      expect(
        imports.filter((i) =>
          /HttpClient|TransporteOpenRouter|Adapter(?!.*djen\.mapper)|fetch|node:https?/.test(
            i,
          ),
        ),
      ).toEqual([]);
      expect(
        imports.some((i) => i.includes('abrirBanco') || i.endsWith('/banco.js')),
      ).toBe(false);
    });
  });

  describe('uso', () => {
    it('workspace inexistente é recusado', () => {
      expect(rodar(['--workspace=nao-existe'])).toBe(2);
    });
    it('argumento desconhecido e janela inválida são recusados', () => {
      expect(rodar(['--x'])).toBe(2);
      expect(rodar(['--janela-dias=0'])).toBe(2);
    });
    it('mostra o critério no cabeçalho', () => {
      rodar();
      expect(texto()).toContain('ao menos 80 caracteres');
    });
  });
});
