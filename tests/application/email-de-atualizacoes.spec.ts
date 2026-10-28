import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  CORES_DO_EMAIL,
  LIMITE_DE_PROCESSOS_NO_EMAIL,
  assuntoDoAviso,
  montarAvisoDeAtualizacoes,
} from '../../src/application/politicas/emailDeAtualizacoes.js';
import { ServicoNotificacao } from '../../src/application/services/ServicoNotificacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioNotificacaoSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioNotificacaoSqlite.js';
import { NotificadorEspiao } from '../helpers/aplicacao.js';

const URL_BASE = 'https://app.exemplo.test';
const WS_A = 'workspace-a';
const WS_B = 'workspace-b';

// Tudo abaixo é inventado. Os "proibidos" existem só para provar que NÃO saem.
const PARTE = 'MARIA FICTICIA DA SILVA';
const CLASSE = 'Procedimento Comum Cível';
const TRIBUNAL_VARA = '9ª Vara Fictícia de Teste';
const TRECHO = 'manifeste-se sobre o laudo pericial no prazo de quinze dias';
const PROIBIDOS = [PARTE, CLASSE, TRIBUNAL_VARA, TRECHO, 'detectado há', 'Resumo', 'prazo', 'TJSP'];

function cnj(seq: number): string {
  const base = BigInt(`${String(seq).padStart(7, '0')}20268260100` + '00');
  const dv = String(98n - (base % 97n)).padStart(2, '0');
  return `${String(seq).padStart(7, '0')}${dv}20268260100`;
}

describe('e-mail de atualizações: peça pura', () => {
  const linha = (i: number, extra: object = {}) => ({
    numero: cnj(100 + i),
    numeroFormatado: NumeroCNJ.criar(cnj(100 + i)).formatado,
    sigiloso: false,
    tipo: 'Decisão',
    data: new Date('2026-10-20T15:00:00Z'),
    ...extra,
  });

  it('assunto concorda no singular e no plural', () => {
    expect(assuntoDoAviso(1)).toBe('Processo Vivo: 1 atualização nos seus processos');
    expect(assuntoDoAviso(2)).toBe('Processo Vivo: 2 atualizações nos seus processos');
    expect(assuntoDoAviso(12)).toBe('Processo Vivo: 12 atualizações nos seus processos');
  });

  it.each([1, 5, 10])('com %i processos há uma linha por processo e nada de "e mais"', (n) => {
    const a = montarAvisoDeAtualizacoes({
      linhas: Array.from({ length: n }, (_, i) => linha(i)),
      totalDeProcessos: n,
      urlBase: URL_BASE,
    });
    const linhasDeProcesso = a.texto.split('\n').filter((l) => /^\d{7}-\d{2}\./.test(l));
    expect(linhasDeProcesso).toHaveLength(n);
    expect(linhasDeProcesso[0]).toBe(`${linha(0).numeroFormatado} · Decisão · 20/10/2026`);
    expect(a.texto).not.toContain('e mais');
    expect(a.html).not.toContain('e mais');
  });

  it('com 12 processos mostra 10 e diz "e mais 2 processos"', () => {
    const a = montarAvisoDeAtualizacoes({
      linhas: Array.from({ length: LIMITE_DE_PROCESSOS_NO_EMAIL }, (_, i) => linha(i)),
      totalDeProcessos: 12,
      urlBase: URL_BASE,
    });
    expect(a.assunto).toBe('Processo Vivo: 12 atualizações nos seus processos');
    expect(a.texto.split('\n').filter((l) => /^\d{7}-\d{2}\./.test(l))).toHaveLength(10);
    expect(a.texto).toContain('e mais 2 processos');
    expect(a.html).toContain('e mais 2 processos');
    expect(montarAvisoDeAtualizacoes({ linhas: [linha(0)], totalDeProcessos: 2 }).texto).toContain(
      'e mais 1 processo\n',
    );
  });

  it('botão e link de texto apontam para a aba Atualizações; o número abre o processo', () => {
    const a = montarAvisoDeAtualizacoes({ linhas: [linha(1)], totalDeProcessos: 1, urlBase: `${URL_BASE}/` });
    expect(a.texto).toContain(`Ver atualizações: ${URL_BASE}/#/atualizacoes`);
    expect(a.html).toMatch(new RegExp(`<a href="${URL_BASE}/#/atualizacoes"[^>]*>Ver atualizações</a>`));
    expect(a.html).toContain(`>${URL_BASE}/#/atualizacoes</a>`);
    expect(a.html).toContain(`href="${URL_BASE}/?processo=${cnj(101)}"`);
    expect(a.html).toContain(`href="${URL_BASE}/#/vigilancia"`);
  });

  it('sem endereço público não inventa link', () => {
    const a = montarAvisoDeAtualizacoes({ linhas: [linha(1)], totalDeProcessos: 1 });
    expect(a.html).not.toContain('<a ');
    expect(a.texto).not.toContain('http');
  });

  it('etiqueta aparece uma vez, e não repete a palavra que o título já traz', () => {
    const a = montarAvisoDeAtualizacoes({
      linhas: [linha(1, { etiqueta: 'Intimação' }), linha(2, { tipo: 'Intimação', etiqueta: 'Intimação' })],
      totalDeProcessos: 2,
    });
    expect(a.texto).toContain('· Decisão (Intimação) ·');
    expect(a.texto).toContain('· Intimação · 20/10/2026');
    expect(a.texto).not.toContain('Intimação (Intimação)');
  });

  it('segredo de justiça: sem número, sem tipo do ato e sem link que revele o número', () => {
    const a = montarAvisoDeAtualizacoes({
      linhas: [linha(7, { sigiloso: true, tipo: 'Sentença', etiqueta: 'Citação' })],
      totalDeProcessos: 1,
      urlBase: URL_BASE,
    });
    for (const saida of [a.texto, a.html]) {
      expect(saida).not.toContain(cnj(107));
      expect(saida).not.toContain(linha(7).numeroFormatado);
      expect(saida).not.toContain('Sentença');
      expect(saida).not.toContain('Citação');
      expect(saida).not.toContain('?processo=');
    }
    expect(a.texto).toContain('Processo sigiloso · nova movimentação · 20/10/2026');
  });

  it('texto do tribunal é escapado no HTML', () => {
    const a = montarAvisoDeAtualizacoes({
      linhas: [linha(1, { tipo: '<img src=x onerror=alert(1)> & "x"' })],
      totalDeProcessos: 1,
    });
    expect(a.html).not.toContain('<img');
    expect(a.html).toContain('&lt;img');
  });

  it('HTML leve: 600 px, fonte >= 14 px, sem imagem nem recurso externo, botão >= 44 px', () => {
    const a = montarAvisoDeAtualizacoes({
      linhas: Array.from({ length: 10 }, (_, i) => linha(i)),
      totalDeProcessos: 12,
      urlBase: URL_BASE,
    });
    expect(a.html).toContain('max-width:600px');
    expect(a.html).not.toMatch(/<img|<script|<link|@import|url\(/);
    const tamanhos = [...a.html.matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1]));
    expect(Math.min(...tamanhos)).toBeGreaterThanOrEqual(14);
    // altura do botão = linha de 20 px + 2 × 13 px de respiro
    expect(a.html).toMatch(/line-height:20px;padding:13px 24px/);
    expect(a.html).toContain('prefers-color-scheme: dark');
    expect(a.html.length).toBeLessThan(8_000);
  });

  it('contraste de texto >= 4,5:1 nos dois modos', () => {
    const luz = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const razao = (a: string, b: string): number => {
      const [x, y] = [luz(a), luz(b)].sort((p, q) => q - p) as [number, number];
      return (x + 0.05) / (y + 0.05);
    };
    for (const modo of [CORES_DO_EMAIL.claro, CORES_DO_EMAIL.escuro]) {
      expect(razao(modo.tinta, modo.papel)).toBeGreaterThanOrEqual(4.5);
      expect(razao(modo.tinta2, modo.papel)).toBeGreaterThanOrEqual(4.5);
      expect(razao(modo.link, modo.papel)).toBeGreaterThanOrEqual(4.5);
      expect(razao(modo.botaoTinta, modo.botao)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('e-mail de atualizações: pelo serviço, com retrato real no banco', () => {
  let db: DatabaseSync;
  let acomp: RepositorioAcompanhamentosSqlite;
  let prefs: RepositorioNotificacaoSqlite;
  let espiao: NotificadorEspiao;
  let servico: ServicoNotificacao;

  beforeEach(async () => {
    db = abrirBanco(':memory:');
    acomp = new RepositorioAcompanhamentosSqlite(db);
    prefs = new RepositorioNotificacaoSqlite(db);
    espiao = new NotificadorEspiao();
    servico = new ServicoNotificacao({
      preferencias: prefs,
      acompanhamentos: acomp,
      notificador: espiao,
      logger: loggerSilencioso,
      urlBase: URL_BASE,
    });
    await prefs.salvar(WS_A, 'a@exemplo.com', true);
    await prefs.salvar(WS_B, 'b@exemplo.com', true);
  });
  afterEach(() => db.close());

  async function semear(
    ws: string,
    seq: number,
    opcoes: { sigiloso?: boolean; tipoComunicacao?: string; dia?: string } = {},
  ): Promise<string> {
    const numero = cnj(seq);
    await acomp.acompanhar(ws, numero);
    const mov = {
      data: new Date(`${opcoes.dia ?? '2026-10-20'}T12:00:00-03:00`),
      titulo: 'Decisão',
      conteudo: TRECHO,
      ...(opcoes.tipoComunicacao ? { tipoComunicacao: opcoes.tipoComunicacao } : {}),
    };
    const processo = new Processo({
      numero: NumeroCNJ.criar(numero),
      tribunal: 'TJSP',
      vara: TRIBUNAL_VARA,
      classe: CLASSE,
      partes: [{ nome: PARTE, polo: 'ATIVO', tipoPessoa: 'DESCONHECIDO', advogados: [] }],
      movimentacoes: [mov],
      segredoJustica: opcoes.sigiloso ?? false,
      procedencia: { provider: 'djen', consultadoEm: new Date(), deCache: false },
    });
    await acomp.registrarSincronizacao(ws, numero, processo, [mov]);
    return numero;
  }

  it.each([1, 5, 10, 12])('com %i processos: limite de 10, "e mais N" e nenhum dado a mais', async (n) => {
    for (let i = 1; i <= n; i++) await semear(WS_A, 200 + i, { tipoComunicacao: 'Intimação' });
    await servico.despachar();

    const m = espiao.enviadas[0];
    expect(m?.assunto).toBe(assuntoDoAviso(n));
    const linhas = (m?.texto ?? '').split('\n').filter((l) => /^\d{7}-\d{2}\./.test(l));
    expect(linhas).toHaveLength(Math.min(n, 10));
    for (const l of linhas) expect(l).toMatch(/^\d{7}-\d{2}\.2026\.8\.26\.0100 · Decisão \(Intimação\) · 20\/10\/2026$/);
    expect(m?.texto.includes('e mais')).toBe(n > 10);
    for (const saida of [m?.texto ?? '', m?.html ?? '', m?.assunto ?? '']) {
      for (const proibido of PROIBIDOS) expect(saida.toLowerCase()).not.toContain(proibido.toLowerCase());
    }
  });

  it('vários atos do mesmo processo viram uma linha só, com o mais recente', async () => {
    const numero = await semear(WS_A, 300, { dia: '2026-10-10' });
    await acomp.registrarSincronizacao(
      WS_A,
      numero,
      (await acomp.buscar(WS_A, numero))!.processo!,
      [{ data: new Date('2026-10-22T12:00:00-03:00'), titulo: 'Despacho' }],
    );
    await servico.despachar();

    const m = espiao.enviadas[0];
    expect(m?.assunto).toBe('Processo Vivo: 1 atualização nos seus processos');
    expect((m?.texto.match(/\d{7}-\d{2}\./g) ?? [])).toHaveLength(1);
    expect(m?.texto).toContain('Despacho · 22/10/2026');
  });

  it('segredo de justiça: nem número nem tipo no texto, no HTML ou nos links', async () => {
    const aberto = await semear(WS_A, 401);
    const secreto = await semear(WS_A, 402, { sigiloso: true, tipoComunicacao: 'Citação' });
    await servico.despachar();

    const m = espiao.enviadas[0];
    const secretoFormatado = NumeroCNJ.criar(secreto).formatado;
    for (const saida of [m?.texto ?? '', m?.html ?? '']) {
      expect(saida).not.toContain(secreto);
      expect(saida).not.toContain(secretoFormatado);
      expect(saida).toContain('rocesso sigiloso');
    }
    expect(m?.html).toContain(`?processo=${aberto}`);
    expect(m?.html).not.toContain(`?processo=${secreto}`);
    expect(m?.texto).not.toContain('Citação');
  });

  it('sem retrato para conferir o sigilo, o número não sai (falha fechada)', async () => {
    const numero = await semear(WS_A, 410);
    db.prepare('UPDATE acompanhamentos SET processo = NULL WHERE workspace = ? AND numero = ?').run(WS_A, numero);
    await servico.despachar();

    expect(espiao.enviadas[0]?.texto).not.toContain(NumeroCNJ.criar(numero).formatado);
    expect(espiao.enviadas[0]?.html).not.toContain(numero);
  });

  it('isolamento: o e-mail de A nunca traz processo de B', async () => {
    const deA = await semear(WS_A, 501);
    const deB = await semear(WS_B, 502);
    await servico.despachar();

    const paraA = espiao.enviadas.find((e) => e.para === 'a@exemplo.com');
    const paraB = espiao.enviadas.find((e) => e.para === 'b@exemplo.com');
    expect(paraA?.html).toContain(deA);
    expect(paraA?.texto).not.toContain(NumeroCNJ.criar(deB).formatado);
    expect(paraA?.html).not.toContain(deB);
    expect(paraB?.html).toContain(deB);
    expect(paraB?.html).not.toContain(deA);
  });

  it('texto puro e HTML dizem a mesma coisa', async () => {
    await semear(WS_A, 601, { tipoComunicacao: 'Intimação' });
    await semear(WS_A, 602, { sigiloso: true });
    await servico.despachar();

    const { texto, html } = espiao.enviadas[0]!;
    const doHtml = html!.replace(/<style>.*?<\/style>|<title>.*?<\/title>/gs, '').replace(/<[^>]+>/g, ' ');
    for (const l of texto.split('\n').filter((x) => /^(\d{7}-|Processo sigiloso)/.test(x))) {
      const [quem, tipo, data] = l.split(' · ') as [string, string, string];
      for (const parte of [quem, tipo, data]) expect(doHtml).toContain(parte);
    }
  });
});
