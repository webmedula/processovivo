import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import type {
  DocumentoDePrestacao,
  GeradorDePrestacaoDeContas,
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
const COLUNAS = [50, 150, 120, 70, 121.28] as const;
const X = COLUNAS.map((_, i) =>
  COLUNAS.slice(0, i).reduce((soma, largura) => soma + largura, MARGEM),
);

const ROTULOS_DAS_DESPESAS = ['Data', 'Descrição', 'Categoria', 'Valor', 'Situação'];
const ROTULOS_DOS_RECEBIMENTOS = ['Data', 'Observação', '', 'Valor', ''];

const TINTA = rgb(0.09, 0.13, 0.2);
const TINTA_SUAVE = rgb(0.38, 0.42, 0.5);
const LINHA = rgb(0.82, 0.85, 0.89);
const FUNDO_CABECALHO = rgb(0.93, 0.95, 0.97);

export class PrestacaoDeContasPdf implements GeradorDePrestacaoDeContas {
  async gerar(d: DocumentoDePrestacao): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setTitle('Prestação de contas');
    doc.setProducer('Processo Vivo');
    doc.setCreator('Processo Vivo');
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
    const desenho = new Desenho(doc, regular, negrito, d);
    desenho.tudo();

    return doc.save();
  }
}

class Desenho {
  private pagina!: PDFPage;
  private y = 0;
  /** Cabeçalho da tabela corrente: repetido a cada página enquanto a tabela continua. */
  private rotulos: readonly string[] = ROTULOS_DAS_DESPESAS;
  private readonly paginas: PDFPage[] = [];
  private readonly aceitos: Set<number>;

  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly negrito: PDFFont,
    private readonly d: DocumentoDePrestacao,
  ) {
    this.aceitos = new Set(regular.getCharacterSet());
  }

  tudo(): void {
    this.novaPagina(true);
    this.capa();
    this.cabecalhoDaTabela(ROTULOS_DAS_DESPESAS);
    if (this.d.linhas.length === 0) {
      this.linhaSimples('Nenhuma despesa neste filtro.', this.regular);
    }
    for (const l of this.d.linhas) {
      this.linhaDaTabela([l.data, l.descricao, l.categoria, l.valor, l.situacao]);
    }
    // Depósitos e garantias: bloco à parte, que NÃO entra no total de despesas.
    if (this.d.depositos.length > 0) {
      this.tituloDeBloco(
        'Depósitos e garantias',
        'Não entram no total de despesas.',
        ROTULOS_DAS_DESPESAS,
      );
      for (const l of this.d.depositos) {
        this.linhaDaTabela([l.data, l.descricao, l.categoria, l.valor, l.situacao]);
      }
    }
    if (this.d.recebimentos.length > 0) {
      this.tituloDeBloco('Recebimentos do cliente', undefined, ROTULOS_DOS_RECEBIMENTOS);
      for (const r of this.d.recebimentos) {
        this.linhaDaTabela([r.data, r.observacao, '', r.valor, '']);
      }
    }
    this.fechamento();
    this.carimbarRodapes();
  }

  // ---------- páginas ----------

  private novaPagina(primeira: boolean): void {
    this.pagina = this.doc.addPage([LARGURA, ALTURA]);
    this.paginas.push(this.pagina);
    this.y = TOPO_DAS_PAGINAS;
    if (!primeira) {
      // Cabeçalho corrente: quem recebe só a página 4 sabe de que processo é.
      this.texto(
        `Prestação de contas · Processo ${this.d.numeroProcesso}`,
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
    const d = this.d;
    this.texto('Prestação de contas', MARGEM, this.y - 18, 18, this.negrito, TINTA);
    this.y -= 34;
    const fatos: Array<[string, string]> = [
      ['Processo', d.numeroProcesso],
      ['Tribunal', d.tribunal],
    ];
    if (d.cliente) fatos.push(['Cliente', d.cliente]);
    if (d.advogado) {
      fatos.push([
        'Advogado(a)',
        d.advogado.oab ? `${d.advogado.nome} · OAB ${d.advogado.oab}` : d.advogado.nome,
      ]);
    }
    fatos.push(['Gerado em', d.geradoEm]);
    for (const [rotulo, valor] of fatos) {
      this.texto(rotulo, MARGEM, this.y - 9, TAMANHO, this.negrito, TINTA_SUAVE);
      const linhas = this.quebrar(valor, this.regular, 10, LARGURA_UTIL - 78);
      for (const [i, l] of linhas.entries()) {
        this.texto(l, MARGEM + 78, this.y - 9 - i * 12, 10, this.regular, TINTA);
      }
      this.y -= 14 + (linhas.length - 1) * 12;
    }
    for (const f of d.filtros) {
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
    const d = this.d;
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
      this.texto(q, MARGEM + 250, this.y - 10, TAMANHO, this.regular, TINTA_SUAVE);
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

    // O bloco de totais é INTEIRO ou não é: se não cabe, a página nova só tem os totais.
    const alturaDosTotais = 18 + d.totais.length * 20 + 14;
    this.y -= 14;
    this.garantir(alturaDosTotais, false);
    this.texto('Totais', MARGEM, this.y - 10, 11, this.negrito, TINTA);
    this.y -= 22;
    for (const t of d.totais) {
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
    const fixo = `Valores informados pelo advogado. Gerado pelo Processo Vivo, versão ${this.d.versao}.`;
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
