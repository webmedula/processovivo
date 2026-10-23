import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import type {
  DocumentoConsolidadoDePrestacao,
  DocumentoDePrestacao,
  GeradorDePrestacaoDeContas,
  SecaoDeProcessoNaPrestacao,
} from '../../domain/ports/GeradorDePrestacaoDeContas.js';

/**
 * A prestação de contas em PDF (v0.47.0), desenhada com pdf-lib — que o projeto já usa no leitor
 * de peças; nenhuma dependência nova. Tudo em memória: os bytes saem na resposta e nada vai a disco.
 *
 * O que sustenta o desenho:
 * - A4, margens de 42 pt, Helvetica (WinAnsi cobre o português). Caractere fora do conjunto da
 *   fonte vira "?" em vez de derrubar a geração — o texto é do advogado e pode trazer qualquer coisa;
 * - o cabeçalho da tabela se REPETE em toda página, e uma linha nunca é cortada ao meio;
 * - os TOTAIS ficam sempre na última página: se não cabem no que sobrou, vão para uma página nova
 *   com o cabeçalho corrente, e nada vem depois deles;
 * - "Página N de M" e o rodapé fixo são carimbados no fim, quando M já se sabe.
 */

const LARGURA = 595.28;
const ALTURA = 841.89;
const MARGEM = 42;
const LARGURA_UTIL = LARGURA - 2 * MARGEM;
const RODAPE = 40;
const TOPO_DAS_PAGINAS = ALTURA - MARGEM;
const LIMITE_INFERIOR = MARGEM + RODAPE;

const TAMANHO = 8.5;
const ENTRELINHA = 11;
const FOLGA_DA_LINHA = 4;

// data | descrição | categoria | valor (à direita) | situação — somam LARGURA_UTIL (511,28).
// A data tem de caber em UMA linha: "30/12/2026" em Helvetica 8,5 pt mede ~42,5 pt e a célula tem 4 pt de
// recuo de cada lado, então 50 pt (a largura até a 0.56.1) estourava por meio ponto e o último dígito caía
// na linha de baixo. 56 pt dá folga; os 6 pt saíram da descrição, que já quebra em palavras.
const COLUNAS = [56, 144, 120, 70, 121.28] as const;
const X = COLUNAS.map((_, i) =>
  COLUNAS.slice(0, i).reduce((soma, largura) => soma + largura, MARGEM),
);

const ROTULOS_DAS_DESPESAS = ['Data', 'Descrição', 'Categoria', 'Valor', 'Situação'];
const ROTULOS_DOS_RECEBIMENTOS = ['Data', 'Observação', '', 'Valor', ''];

const TINTA = rgb(0.09, 0.13, 0.2);
const TINTA_SUAVE = rgb(0.38, 0.42, 0.5);
const LINHA = rgb(0.82, 0.85, 0.89);
const FUNDO_CABECALHO = rgb(0.93, 0.95, 0.97);

/** O que a capa e o cabeçalho corrente precisam, igual para o PDF de um processo e o consolidado. */
interface Meta {
  readonly titulo: string;
  readonly fatos: Array<[string, string]>;
  readonly filtros: readonly string[];
  readonly versao: string;
  readonly cabecalhoCorrente: string;
}

type Secao = Pick<
  DocumentoDePrestacao,
  'linhas' | 'depositos' | 'recebimentos' | 'subtotais' | 'totais'
>;

function fatosComuns(d: {
  advogado?: { nome: string; oab?: string } | undefined;
  geradoEm: string;
}): Array<[string, string]> {
  const fatos: Array<[string, string]> = [];
  if (d.advogado) {
    fatos.push([
      'Advogado(a)',
      d.advogado.oab ? `${d.advogado.nome} · OAB ${d.advogado.oab}` : d.advogado.nome,
    ]);
  }
  fatos.push(['Gerado em', d.geradoEm]);
  return fatos;
}

export class PrestacaoDeContasPdf implements GeradorDePrestacaoDeContas {
  async gerar(d: DocumentoDePrestacao): Promise<Uint8Array> {
    const fatos: Array<[string, string]> = [
      ['Processo', d.numeroProcesso],
      ['Tribunal', d.tribunal],
    ];
    if (d.cliente) fatos.push(['Cliente', d.cliente]);
    fatos.push(...fatosComuns(d));
    const desenho = await this.preparar({
      titulo: 'Prestação de contas',
      fatos,
      filtros: d.filtros,
      versao: d.versao,
      cabecalhoCorrente: `Prestação de contas · Processo ${d.numeroProcesso}`,
    });
    desenho.tudo(d);
    return desenho.salvar();
  }

  /** O consolidado de um cliente: uma seção por processo e, no fim, os totais gerais. */
  async gerarConsolidado(d: DocumentoConsolidadoDePrestacao): Promise<Uint8Array> {
    const desenho = await this.preparar({
      titulo: `Prestação de contas — ${d.cliente}`,
      fatos: [['Cliente', d.cliente], ...fatosComuns(d)],
      filtros: d.filtros,
      versao: d.versao,
      cabecalhoCorrente: `Prestação de contas · ${d.cliente}`,
    });
    desenho.tudoConsolidado(d);
    return desenho.salvar();
  }

  private async preparar(meta: Meta): Promise<Desenho> {
    const doc = await PDFDocument.create();
    doc.setTitle('Prestação de contas');
    doc.setProducer('Processo Vivo');
    doc.setCreator('Processo Vivo');
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
    return new Desenho(doc, regular, negrito, meta);
  }
}

class Desenho {
  private pagina!: PDFPage;
  private y = 0;
  /** Cabeçalho da tabela corrente: repetido a cada página enquanto a tabela continua. */
  private rotulos: readonly string[] = ROTULOS_DAS_DESPESAS;
  private readonly paginas: PDFPage[] = [];
  private readonly aceitos: Set<number>;
  /** A seção que está sendo desenhada (o processo único, ou um dos do consolidado). */
  private sec!: Secao;

  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly negrito: PDFFont,
    private readonly meta: Meta,
  ) {
    this.aceitos = new Set(regular.getCharacterSet());
  }

  async salvar(): Promise<Uint8Array> {
    this.carimbarRodapes();
    return this.doc.save();
  }

  tudo(d: DocumentoDePrestacao): void {
    this.novaPagina(true);
    this.capa();
    this.sec = d;
    this.corpo();
    this.fechamento();
  }

  tudoConsolidado(d: DocumentoConsolidadoDePrestacao): void {
    this.novaPagina(true);
    this.capa();
    if (d.secoes.length === 0) {
      this.cabecalhoDaTabela(ROTULOS_DAS_DESPESAS);
      this.linhaSimples('Nenhum processo neste filtro.', this.regular);
    }
    for (const s of d.secoes) this.secaoDoProcesso(s);
    this.totaisGerais(d);
  }

  private secaoDoProcesso(s: SecaoDeProcessoNaPrestacao): void {
    this.y -= 18;
    // Título do processo + cabeçalho + uma linha: nunca um título sozinho no pé da página.
    this.garantir(22 + 18 + 30, false);
    this.pagina.drawRectangle({
      x: MARGEM,
      y: this.y - 20,
      width: LARGURA_UTIL,
      height: 22,
      color: FUNDO_CABECALHO,
    });
    this.texto(
      `Processo ${s.numeroProcesso} · ${s.tribunal}`,
      MARGEM + 6,
      this.y - 14,
      10.5,
      this.negrito,
      TINTA,
    );
    this.y -= 26;
    this.sec = s;
    this.corpo();
    // Totais do PROCESSO, compactos, antes do próximo.
    this.quadroDeTotais('Totais do processo', s.totais);
  }

  private totaisGerais(d: DocumentoConsolidadoDePrestacao): void {
    this.y -= 18;
    this.quadroDeTotais('Totais gerais', d.totaisGerais);
  }

  /** Despesas, depósitos (bloco à parte) e recebimentos de `this.sec`. */
  private corpo(): void {
    this.cabecalhoDaTabela(ROTULOS_DAS_DESPESAS);
    if (this.sec.linhas.length === 0) {
      this.linhaSimples('Nenhuma despesa neste filtro.', this.regular);
    }
    for (const l of this.sec.linhas) {
      this.linhaDaTabela([l.data, l.descricao, l.categoria, l.valor, l.situacao]);
    }
    // Depósitos e garantias: bloco à parte, que NÃO entra no total de despesas.
    if (this.sec.depositos.length > 0) {
      this.tituloDeBloco(
        'Depósitos e garantias',
        'Não entram no total de despesas.',
        ROTULOS_DAS_DESPESAS,
      );
      for (const l of this.sec.depositos) {
        this.linhaDaTabela([l.data, l.descricao, l.categoria, l.valor, l.situacao]);
      }
    }
    if (this.sec.recebimentos.length > 0) {
      this.tituloDeBloco('Recebimentos do cliente', undefined, ROTULOS_DOS_RECEBIMENTOS);
      for (const r of this.sec.recebimentos) {
        this.linhaDaTabela([r.data, r.observacao, '', r.valor, '']);
      }
    }
  }

  // ---------- páginas ----------

  private novaPagina(primeira: boolean): void {
    this.pagina = this.doc.addPage([LARGURA, ALTURA]);
    this.paginas.push(this.pagina);
    this.y = TOPO_DAS_PAGINAS;
    if (!primeira) {
      // Cabeçalho corrente: quem recebe só a página 4 sabe de que processo é.
      this.texto(
        this.meta.cabecalhoCorrente,
        MARGEM,
        this.y - 8,
        8.5,
        this.negrito,
        TINTA_SUAVE,
      );
      this.y -= 22;
    }
  }

  private garantir(altura: number, comCabecalhoDaTabela: boolean): void {
    if (this.y - altura >= LIMITE_INFERIOR) return;
    this.novaPagina(false);
    if (comCabecalhoDaTabela) this.cabecalhoDaTabela(this.rotulos);
  }

  /** Título de uma seção com a própria tabela; nunca um título sozinho no pé da página. */
  private tituloDeBloco(
    titulo: string,
    nota: string | undefined,
    rotulos: readonly string[],
  ): void {
    this.y -= 14;
    this.garantir(18 + 18 + 30, false);
    this.texto(titulo, MARGEM, this.y - 10, 11, this.negrito, TINTA);
    this.y -= 18;
    if (nota) {
      this.texto(nota, MARGEM, this.y - 8, TAMANHO, this.regular, TINTA_SUAVE);
      this.y -= 14;
    }
    this.cabecalhoDaTabela(rotulos);
  }

  // ---------- blocos ----------

  private capa(): void {
    const m = this.meta;
    const titulo = this.quebrar(m.titulo, this.negrito, 18, LARGURA_UTIL);
    for (const [i, l] of titulo.entries()) {
      this.texto(l, MARGEM, this.y - 18 - i * 22, 18, this.negrito, TINTA);
    }
    this.y -= 34 + (titulo.length - 1) * 22;
    const fatos = m.fatos;
    for (const [rotulo, valor] of fatos) {
      this.texto(rotulo, MARGEM, this.y - 9, TAMANHO, this.negrito, TINTA_SUAVE);
      const linhas = this.quebrar(valor, this.regular, 10, LARGURA_UTIL - 78);
      for (const [i, l] of linhas.entries()) {
        this.texto(l, MARGEM + 78, this.y - 9 - i * 12, 10, this.regular, TINTA);
      }
      this.y -= 14 + (linhas.length - 1) * 12;
    }
    for (const f of m.filtros) {
      this.texto(f, MARGEM, this.y - 9, TAMANHO, this.regular, TINTA_SUAVE);
      this.y -= 13;
    }
    this.y -= 12;
  }

  private cabecalhoDaTabela(rotulos: readonly string[]): void {
    this.rotulos = rotulos;
    const alturaDoCabecalho = 18;
    this.pagina.drawRectangle({
      x: MARGEM,
      y: this.y - alturaDoCabecalho,
      width: LARGURA_UTIL,
      height: alturaDoCabecalho,
      color: FUNDO_CABECALHO,
    });
    rotulos.forEach((r, i) => {
      const x = X[i] ?? MARGEM;
      const w = COLUNAS[i] ?? 0;
      const tamanho = TAMANHO;
      const largura = this.negrito.widthOfTextAtSize(this.seguro(r), tamanho);
      this.texto(
        r,
        i === 3 ? x + w - 6 - largura : x + 4,
        this.y - 12,
        tamanho,
        this.negrito,
        TINTA,
      );
    });
    this.y -= alturaDoCabecalho;
  }

  private linhaSimples(t: string, fonte: PDFFont): void {
    this.garantir(ENTRELINHA + 2 * FOLGA_DA_LINHA, true);
    this.texto(
      t,
      X[0] ?? MARGEM,
      this.y - FOLGA_DA_LINHA - 8,
      TAMANHO,
      fonte,
      TINTA_SUAVE,
    );
    this.y -= ENTRELINHA + 2 * FOLGA_DA_LINHA;
  }

  private linhaDaTabela(celulas: readonly string[]): void {
    const quebradas = celulas.map((c, i) =>
      this.quebrar(
        c,
        i === 3 ? this.negrito : this.regular,
        TAMANHO,
        (COLUNAS[i] ?? 0) - 8,
      ),
    );
    const linhas = Math.max(1, ...quebradas.map((q) => q.length));
    const altura = linhas * ENTRELINHA + 2 * FOLGA_DA_LINHA;
    this.garantir(altura, true);
    quebradas.forEach((q, i) => {
      const x = X[i] ?? MARGEM;
      const w = COLUNAS[i] ?? 0;
      const fonte = i === 3 ? this.negrito : this.regular;
      q.forEach((l, k) => {
        const largura = fonte.widthOfTextAtSize(l, TAMANHO);
        this.texto(
          l,
          i === 3 ? x + w - 6 - largura : x + 4,
          this.y - FOLGA_DA_LINHA - 8 - k * ENTRELINHA,
          TAMANHO,
          fonte,
          TINTA,
        );
      });
    });
    this.y -= altura;
    this.pagina.drawLine({
      start: { x: MARGEM, y: this.y },
      end: { x: MARGEM + LARGURA_UTIL, y: this.y },
      thickness: 0.5,
      color: LINHA,
    });
  }

  /** Subtotais por categoria e, por último, os totais — sempre na última página. */
  private fechamento(): void {
    const d = this.sec;
    this.y -= 16;
    // Título + cabeçalho + a primeira linha: nunca um título sozinho no pé da página.
    this.garantir(18 + 18 + 16, false);
    this.texto(
      'Subtotais das despesas por categoria',
      MARGEM,
      this.y - 10,
      11,
      this.negrito,
      TINTA,
    );
    this.y -= 22;
    for (const s of d.subtotais) {
      this.garantir(16, false);
      this.texto(s.categoria, MARGEM + 4, this.y - 10, TAMANHO, this.regular, TINTA);
      const q = `${s.quantidade} ${s.quantidade === 1 ? 'lançamento' : 'lançamentos'}`;
      this.texto(q, MARGEM + 300, this.y - 10, TAMANHO, this.regular, TINTA_SUAVE);
      const w = this.negrito.widthOfTextAtSize(this.seguro(s.valor), TAMANHO);
      this.texto(
        s.valor,
        MARGEM + LARGURA_UTIL - 6 - w,
        this.y - 10,
        TAMANHO,
        this.negrito,
        TINTA,
      );
      this.y -= 16;
      this.pagina.drawLine({
        start: { x: MARGEM, y: this.y },
        end: { x: MARGEM + LARGURA_UTIL, y: this.y },
        thickness: 0.5,
        color: LINHA,
      });
    }
    this.y -= 14;
    this.quadroDeTotais('Totais', d.totais);
  }

  /** O quadro de totais é INTEIRO ou não é: se não cabe, a página nova só tem ele. */
  private quadroDeTotais(titulo: string, totais: Secao['totais']): void {
    const alturaDosTotais = 18 + totais.length * 20 + 14;
    this.garantir(alturaDosTotais, false);
    this.texto(titulo, MARGEM, this.y - 10, 11, this.negrito, TINTA);
    this.y -= 22;
    for (const t of totais) {
      if (t.destaque) {
        this.pagina.drawRectangle({
          x: MARGEM,
          y: this.y - 18,
          width: LARGURA_UTIL,
          height: 20,
          color: FUNDO_CABECALHO,
        });
      }
      const fonte = t.destaque ? this.negrito : this.regular;
      const tamanho = t.destaque ? 10.5 : 9.5;
      const cor = t.recuado ? TINTA_SUAVE : TINTA;
      this.texto(
        t.rotulo,
        MARGEM + (t.recuado ? 22 : 6),
        this.y - 13,
        tamanho,
        fonte,
        cor,
      );
      const w = this.negrito.widthOfTextAtSize(this.seguro(t.valor), tamanho);
      this.texto(
        t.valor,
        MARGEM + LARGURA_UTIL - 6 - w,
        this.y - 13,
        tamanho,
        this.negrito,
        cor,
      );
      this.y -= 20;
    }
  }

  private carimbarRodapes(): void {
    const total = this.paginas.length;
    const fixo = `Valores informados pelo advogado. Gerado pelo Processo Vivo, versão ${this.meta.versao}.`;
    this.paginas.forEach((p, i) => {
      p.drawLine({
        start: { x: MARGEM, y: MARGEM + 22 },
        end: { x: MARGEM + LARGURA_UTIL, y: MARGEM + 22 },
        thickness: 0.5,
        color: LINHA,
      });
      p.drawText(this.seguro(fixo), {
        x: MARGEM,
        y: MARGEM + 8,
        size: 8,
        font: this.regular,
        color: TINTA_SUAVE,
      });
      const numero = this.seguro(`Página ${i + 1} de ${total}`);
      const w = this.regular.widthOfTextAtSize(numero, 8);
      p.drawText(numero, {
        x: MARGEM + LARGURA_UTIL - w,
        y: MARGEM + 8,
        size: 8,
        font: this.regular,
        color: TINTA_SUAVE,
      });
    });
  }

  // ---------- texto ----------

  private texto(
    t: string,
    x: number,
    y: number,
    tamanho: number,
    fonte: PDFFont,
    cor: ReturnType<typeof rgb>,
  ): void {
    this.pagina.drawText(this.seguro(t), {
      x,
      y,
      size: tamanho,
      font: fonte,
      color: cor,
    });
  }

  /** Só caracteres que a fonte desenha; o resto vira "?". Quebra de linha e tabulação viram espaço. */
  private seguro(t: string): string {
    let saida = '';
    for (const c of t.replace(/[\r\n\t]+/g, ' ')) {
      const cp = c.codePointAt(0) ?? 63;
      saida += this.aceitos.has(cp) ? c : '?';
    }
    return saida;
  }

  /** Quebra por palavra; palavra maior que a coluna é cortada por caractere. */
  private quebrar(t: string, fonte: PDFFont, tamanho: number, largura: number): string[] {
    const palavras = this.seguro(t).split(' ').filter(Boolean);
    const linhas: string[] = [];
    let atual = '';
    const cabe = (s: string): boolean => fonte.widthOfTextAtSize(s, tamanho) <= largura;
    for (const palavra of palavras) {
      const tentativa = atual ? `${atual} ${palavra}` : palavra;
      if (cabe(tentativa)) {
        atual = tentativa;
        continue;
      }
      if (atual) linhas.push(atual);
      let resto = palavra;
      while (!cabe(resto)) {
        let n = resto.length - 1;
        while (n > 1 && !cabe(resto.slice(0, n))) n--;
        linhas.push(resto.slice(0, n));
        resto = resto.slice(n);
      }
      atual = resto;
    }
    if (atual) linhas.push(atual);
    return linhas.length ? linhas : [''];
  }
}
