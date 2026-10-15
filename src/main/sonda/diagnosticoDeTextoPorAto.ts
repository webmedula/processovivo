import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  temTextoSuficiente,
  corpoDoAto,
  MINIMO_DE_CARACTERES_DO_TEXTO,
} from '../../application/politicas/entradaDoModelo.js';
import { chaveDaMovimentacao } from '../../domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import {
  PENDENCIA_INTIMACAO_JANELA_DIAS,
  PENDENCIA_JANELA_DIAS_PADRAO,
  estadoDaPasta,
} from '../../domain/entities/estadoDaPasta.js';
import type { MarcaDeCumprido } from '../../domain/entities/estadoDaPasta.js';
import { ehTeorNaoPublico } from '../../infrastructure/adapters/djen/djen.mapper.js';
import {
  abrirSomenteLeitura,
  listarWorkspaces,
  mascararEmail,
  resolverWorkspace,
  type WorkspaceDoBanco,
} from '../../infrastructure/persistencia/diagnosticoDeProvidencia.js';
import { reidratarProcesso } from '../../infrastructure/persistencia/processoSerializacao.js';
import type { ProcessoSerializado } from '../../infrastructure/persistencia/processoSerializacao.js';

/**
 * Diagnóstico do TEXTO POR ATO (v1.0.0): quantos atos do retrato têm texto para a
 * análise por IA ler. Existe para o dono decidir a Etapa 2 com número da carteira
 * real, sem rodar a sonda de IA nem abrir nada além de contagens.
 *
 * Garantias, todas com teste:
 *  - SOMENTE LEITURA: `abrirSomenteLeitura` (readOnly + query_only), nunca
 *    `abrirBanco` — sem esquema, sem migração, sem retrocarga;
 *  - SEM REDE e SEM MODELO: nenhum adapter de rede, nenhum transporte;
 *  - SÓ CONTAGENS: o texto do ato é lido em memória para medir o tamanho e jamais
 *    é impresso, gravado ou posto em mensagem de erro; nenhum número de processo
 *    sai (nem no terminal); e-mail só mascarado no terminal;
 *  - o arquivo em `os.tmpdir()` leva só números — nem e-mail nem identificador de
 *    workspace (as contas saem como "conta 1", "conta 2"…);
 *  - o critério de "texto suficiente" é `temTextoSuficiente`, a MESMA função que
 *    `prepararEntrada` usa para decidir se o modelo é chamado, e "pede providência
 *    hoje" é `estadoDaPasta`, a MESMA da rota `GET /v1/novidades`.
 */

export const VERSAO_DA_SONDA_DE_TEXTO = '1.0.0';
export const NOME_DO_ARQUIVO_DA_TABELA_DE_TEXTO = 'diagnostico-texto-por-ato-tabela.json';

const DIA_MS = 86_400_000;

export const CATEGORIAS = ['suficiente', 'indisponivel', 'segredo', 'curto'] as const;
export type Categoria = (typeof CATEGORIAS)[number];
export const FONTES = ['djen', 'datajud', 'mni', 'outra'] as const;
export type Fonte = (typeof FONTES)[number];

/** Contagem de um recorte de atos. As quatro categorias são exclusivas e somam `atos`. */
export interface Contagem {
  atos: number;
  suficiente: number;
  /** O aviso "arquivos digitais indisponíveis" do DJEN (a fonte não entregou o teor). */
  indisponivel: number;
  /** Ato de processo em segredo de justiça: nunca é enviado, tenha texto ou não. */
  segredo: number;
  /** Menos de `MINIMO_DE_CARACTERES_DO_TEXTO` no corpo (inclui os de título só). */
  curto: number;
  /** Subconjunto de `curto`: nenhum texto algum (só o rótulo). */
  curtoSemTextoAlgum: number;
}

export interface RecorteDeFonte {
  total: Contagem;
  ultimosDias: Contagem;
}

export interface Providencia {
  /** Processos cujo `estadoDaPasta` é PROVIDENCIA hoje. */
  pedem: number;
  atoSuficiente: number;
  atoIndisponivel: number;
  atoSegredo: number;
  atoCurto: number;
  /** O ato apontado pelo estado não está mais no retrato (esperado: 0). */
  atoNaoLocalizado: number;
}

export interface ResultadoDoWorkspace {
  processosAcompanhados: number;
  semRetrato: number;
  emSegredoDeJustica: number;
  todas: RecorteDeFonte;
  porFonte: Record<Fonte, RecorteDeFonte>;
  providencia: Providencia;
}

export interface ConfigDaSondaDeTexto {
  /** "Últimos N dias" dos atos (padrão 30). */
  readonly janelaDeAtosDias: number;
  readonly janelaPendenciaDias: number;
  readonly janelaIntimacaoDias: number;
}

export const CONFIG_PADRAO_DE_TEXTO: ConfigDaSondaDeTexto = {
  janelaDeAtosDias: 30,
  janelaPendenciaDias: PENDENCIA_JANELA_DIAS_PADRAO,
  janelaIntimacaoDias: PENDENCIA_INTIMACAO_JANELA_DIAS,
};

type Linha = Record<string, unknown>;

const contagemVazia = (): Contagem => ({
  atos: 0,
  suficiente: 0,
  indisponivel: 0,
  segredo: 0,
  curto: 0,
  curtoSemTextoAlgum: 0,
});
const recorteVazio = (): RecorteDeFonte => ({
  total: contagemVazia(),
  ultimosDias: contagemVazia(),
});

/** De onde veio o ato: o campo `fonte`, senão o prefixo do `idExterno`, senão a única fonte do retrato. */
export function fonteDoAto(m: Movimentacao, provider: string): Fonte {
  const bruta =
    m.fonte ??
    (m.idExterno?.includes(':')
      ? m.idExterno.slice(0, m.idExterno.indexOf(':'))
      : undefined) ??
    (provider.includes('+') ? undefined : provider);
  return bruta === 'djen' || bruta === 'datajud' || bruta === 'mni' ? bruta : 'outra';
}

/**
 * Classifica UM ato. Ordem de precedência: segredo (nunca enviado, qualquer que seja o
 * texto) → aviso de indisponível → texto suficiente → curto.
 */
export function categoriaDoAto(m: Movimentacao, segredoDeJustica: boolean): Categoria {
  if (segredoDeJustica) return 'segredo';
  if (
    m.teorIndisponivel === true ||
    (m.conteudo !== undefined && ehTeorNaoPublico(m.conteudo))
  ) {
    return 'indisponivel';
  }
  return temTextoSuficiente(paraAnalise(m)) ? 'suficiente' : 'curto';
}

function paraAnalise(m: Movimentacao): Parameters<typeof temTextoSuficiente>[0] {
  return {
    data: m.data,
    titulo: m.titulo,
    ...(m.conteudo !== undefined ? { conteudo: m.conteudo } : {}),
    ...(m.complementos ? { complementos: m.complementos } : {}),
  };
}

function somar(c: Contagem, categoria: Categoria, semTextoAlgum: boolean): void {
  c.atos += 1;
  c[categoria] += 1;
  if (categoria === 'curto' && semTextoAlgum) c.curtoSemTextoAlgum += 1;
}

function colunasDe(db: DatabaseSync, tabela: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${tabela})`).all() as Linha[]).map((c) =>
      String(c['name']),
    ),
  );
}

const data = (v: unknown): Date | null => {
  if (typeof v !== 'string' || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function diagnosticarTextoPorAto(
  db: DatabaseSync,
  workspace: string,
  config: ConfigDaSondaDeTexto,
  agora: Date,
): ResultadoDoWorkspace {
  const colunas = colunasDe(db, 'acompanhamentos');
  const temMarca = colunas.has('cumprido_chave');
  const naoVistas = new Map<string, number>();
  if (colunasDe(db, 'novidades').size > 0) {
    const linhas = db
      .prepare(
        'SELECT numero, COUNT(*) AS n FROM novidades WHERE workspace = ? AND vista_em IS NULL GROUP BY numero',
      )
      .all(workspace) as Linha[];
    for (const l of linhas) naoVistas.set(String(l['numero']), Number(l['n']));
  }

  const resultado: ResultadoDoWorkspace = {
    processosAcompanhados: 0,
    semRetrato: 0,
    emSegredoDeJustica: 0,
    todas: recorteVazio(),
    porFonte: {
      djen: recorteVazio(),
      datajud: recorteVazio(),
      mni: recorteVazio(),
      outra: recorteVazio(),
    },
    providencia: {
      pedem: 0,
      atoSuficiente: 0,
      atoIndisponivel: 0,
      atoSegredo: 0,
      atoCurto: 0,
      atoNaoLocalizado: 0,
    },
  };
  const limite = agora.getTime() - config.janelaDeAtosDias * DIA_MS;

  // Colunas fixas: a de senha/credencial de tribunal nunca é consultada.
  const consulta = db.prepare(
    `SELECT numero, sincronizado_em, erro, processo${
      temMarca ? ', cumprido_chave, cumprido_ate, cumprido_em' : ''
    } FROM acompanhamentos WHERE workspace = ?`,
  );

  for (const linha of consulta.iterate(workspace) as Iterable<Linha>) {
    resultado.processosAcompanhados += 1;
    const bruto = typeof linha['processo'] === 'string' ? linha['processo'] : null;
    if (!bruto) {
      resultado.semRetrato += 1;
      continue;
    }
    const processo = reidratarProcesso(JSON.parse(bruto) as ProcessoSerializado, false);
    const segredo = processo.segredoJustica;
    if (segredo) resultado.emSegredoDeJustica += 1;

    const categoriaPorChave = new Map<string, Categoria>();
    for (const m of processo.movimentacoes) {
      const categoria = categoriaDoAto(m, segredo);
      const semTextoAlgum = corpoDoAto(paraAnalise(m)).length === 0;
      const recente = m.data.getTime() >= limite;
      const fonte = fonteDoAto(m, processo.procedencia.provider);
      for (const recorte of [resultado.todas, resultado.porFonte[fonte]]) {
        somar(recorte.total, categoria, semTextoAlgum);
        if (recente) somar(recorte.ultimosDias, categoria, semTextoAlgum);
      }
      categoriaPorChave.set(chaveDaMovimentacao(m), categoria);
    }

    const marca: MarcaDeCumprido | undefined =
      temMarca && data(linha['cumprido_ate']) && data(linha['cumprido_em'])
        ? {
            chave: String(linha['cumprido_chave']),
            ate: data(linha['cumprido_ate']) as Date,
            em: data(linha['cumprido_em']) as Date,
          }
        : undefined;
    const sincronizadoEm = data(linha['sincronizado_em']);
    const erro = typeof linha['erro'] === 'string' ? linha['erro'] : undefined;
    const estado = estadoDaPasta(
      {
        ...(erro !== undefined ? { erro } : {}),
        ...(sincronizadoEm ? { sincronizadoEm } : {}),
        novidadesNaoVistas: naoVistas.get(String(linha['numero'])) ?? 0,
        movimentacoes: processo.movimentacoes,
        ...(marca ? { cumprido: marca } : {}),
      },
      agora,
      config.janelaPendenciaDias,
      config.janelaIntimacaoDias,
    );
    if (estado.rotulo !== 'PROVIDENCIA') continue;

    resultado.providencia.pedem += 1;
    const chave = estado.providencia?.pendente?.chave;
    const categoria = chave !== undefined ? categoriaPorChave.get(chave) : undefined;
    if (categoria === undefined) resultado.providencia.atoNaoLocalizado += 1;
    else if (categoria === 'suficiente') resultado.providencia.atoSuficiente += 1;
    else if (categoria === 'indisponivel') resultado.providencia.atoIndisponivel += 1;
    else if (categoria === 'segredo') resultado.providencia.atoSegredo += 1;
    else resultado.providencia.atoCurto += 1;
  }
  return resultado;
}

// ---------- apresentação ----------

const MINIMO = MINIMO_DE_CARACTERES_DO_TEXTO;

function somarContagem(a: Contagem, b: Contagem): void {
  a.atos += b.atos;
  a.suficiente += b.suficiente;
  a.indisponivel += b.indisponivel;
  a.segredo += b.segredo;
  a.curto += b.curto;
  a.curtoSemTextoAlgum += b.curtoSemTextoAlgum;
}

export function somarResultados(
  lista: readonly ResultadoDoWorkspace[],
): ResultadoDoWorkspace {
  const t: ResultadoDoWorkspace = {
    processosAcompanhados: 0,
    semRetrato: 0,
    emSegredoDeJustica: 0,
    todas: recorteVazio(),
    porFonte: {
      djen: recorteVazio(),
      datajud: recorteVazio(),
      mni: recorteVazio(),
      outra: recorteVazio(),
    },
    providencia: {
      pedem: 0,
      atoSuficiente: 0,
      atoIndisponivel: 0,
      atoSegredo: 0,
      atoCurto: 0,
      atoNaoLocalizado: 0,
    },
  };
  for (const r of lista) {
    t.processosAcompanhados += r.processosAcompanhados;
    t.semRetrato += r.semRetrato;
    t.emSegredoDeJustica += r.emSegredoDeJustica;
    for (const [a, b] of [
      [t.todas, r.todas],
      ...FONTES.map((f) => [t.porFonte[f], r.porFonte[f]] as const),
    ] as const) {
      somarContagem(a.total, b.total);
      somarContagem(a.ultimosDias, b.ultimosDias);
    }
    for (const k of Object.keys(t.providencia) as Array<keyof Providencia>) {
      t.providencia[k] += r.providencia[k];
    }
  }
  return t;
}

const pct = (n: number, d: number): string =>
  d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`;
const num = (n: number): string => n.toLocaleString('pt-BR');

function linhaDaTabela(rotulo: string, recorte: string, c: Contagem): string {
  return [
    rotulo.padEnd(8),
    recorte.padEnd(10),
    num(c.atos).padStart(8),
    num(c.suficiente).padStart(11),
    pct(c.suficiente, c.atos).padStart(5),
    num(c.indisponivel).padStart(13),
    num(c.segredo).padStart(8),
    num(c.curto).padStart(7),
    num(c.curtoSemTextoAlgum).padStart(11),
  ].join('  ');
}

export function linhasDoWorkspace(
  titulo: string,
  r: ResultadoDoWorkspace,
  config: ConfigDaSondaDeTexto,
): string[] {
  const out: string[] = [];
  out.push(titulo);
  out.push(
    `  ${num(r.processosAcompanhados)} processos acompanhados` +
      ` (${num(r.semRetrato)} sem retrato · ${num(r.emSegredoDeJustica)} em segredo de justiça)`,
  );
  out.push(
    `  Atos no retrato: ${num(r.todas.total.atos)} · nos últimos ${config.janelaDeAtosDias} dias: ${num(r.todas.ultimosDias.atos)}`,
  );
  out.push('');
  out.push(
    '  ' +
      [
        'fonte'.padEnd(8),
        'recorte'.padEnd(10),
        'atos'.padStart(8),
        'suficiente'.padStart(11),
        '%'.padStart(5),
        'indisponível'.padStart(13),
        'segredo'.padStart(8),
        'curto'.padStart(7),
        '(sem texto)'.padStart(11),
      ].join('  '),
  );
  const mostrar = (rotulo: string, rec: RecorteDeFonte): void => {
    out.push('  ' + linhaDaTabela(rotulo, 'total', rec.total));
    out.push(
      '  ' + linhaDaTabela('', `${config.janelaDeAtosDias} dias`, rec.ultimosDias),
    );
  };
  mostrar('TODAS', r.todas);
  for (const f of FONTES) {
    if (f === 'outra' && r.porFonte.outra.total.atos === 0) continue;
    mostrar(f.toUpperCase(), r.porFonte[f]);
  }
  const p = r.providencia;
  out.push('');
  out.push(
    `  Pedem providência hoje: ${num(p.pedem)} — ato com texto suficiente: ${num(p.atoSuficiente)} (${pct(p.atoSuficiente, p.pedem)})` +
      ` · indisponível: ${num(p.atoIndisponivel)} · segredo: ${num(p.atoSegredo)} · curto: ${num(p.atoCurto)}` +
      ` · não localizado: ${num(p.atoNaoLocalizado)}`,
  );
  return out;
}

// ---------- execução ----------

export const USO_DA_SONDA_DE_TEXTO = `Uso: node scripts/diagnostico-texto-por-ato.mjs [--workspace=<id|e-mail>] [--janela-dias=30]
Sem --workspace, conta todas as contas do banco (cada uma em seu bloco, mais o total).`;

export interface DependenciasDaSondaDeTexto {
  readonly caminhoBanco: string;
  readonly config?: Partial<ConfigDaSondaDeTexto>;
  readonly agora?: () => Date;
  readonly saida: (linha: string) => void;
  readonly aviso: (linha: string) => void;
  /** Pasta do arquivo numérico. Padrão: `os.tmpdir()`. */
  readonly pastaTemporaria?: string;
}

/** Devolve o código de saída. */
export function executarDiagnosticoDeTexto(
  argv: readonly string[],
  deps: DependenciasDaSondaDeTexto,
): number {
  let workspacePedido: string | undefined;
  let janelaDeAtos: number | undefined;
  for (const a of argv) {
    const [chave = '', ...resto] = a.split('=');
    const valor = resto.join('=');
    if (chave === '--workspace') workspacePedido = valor;
    else if (chave === '--janela-dias') janelaDeAtos = Number(valor);
    else if (chave === '--ajuda') {
      deps.saida(USO_DA_SONDA_DE_TEXTO);
      return 0;
    } else {
      deps.aviso(`argumento desconhecido: ${chave}`);
      deps.aviso(USO_DA_SONDA_DE_TEXTO);
      return 2;
    }
  }
  if (
    janelaDeAtos !== undefined &&
    !(Number.isInteger(janelaDeAtos) && janelaDeAtos > 0)
  ) {
    deps.aviso('--janela-dias precisa ser um inteiro positivo.');
    return 2;
  }
  const config: ConfigDaSondaDeTexto = {
    ...CONFIG_PADRAO_DE_TEXTO,
    ...deps.config,
    ...(janelaDeAtos !== undefined ? { janelaDeAtosDias: janelaDeAtos } : {}),
  };
  const agora = deps.agora ? deps.agora() : new Date();

  let db: DatabaseSync;
  try {
    db = abrirSomenteLeitura(deps.caminhoBanco);
  } catch {
    deps.aviso(
      'Não consegui abrir o banco em modo somente leitura (caminho ou permissão).',
    );
    return 1;
  }

  try {
    deps.saida(
      `Diagnóstico do texto por ato v${VERSAO_DA_SONDA_DE_TEXTO} — somente leitura, sem rede, sem modelo; só contagens.`,
    );
    deps.saida(
      `Critério de texto suficiente: corpo do ato com ao menos ${MINIMO} caracteres (o mesmo da análise por IA).`,
    );
    const todos = listarWorkspaces(db);
    let escolhidos: WorkspaceDoBanco[] = todos;
    if (workspacePedido) {
      const ws = resolverWorkspace(todos, workspacePedido);
      if (!ws) {
        deps.aviso('Workspace não encontrado. Use o identificador ou o e-mail da conta.');
        return 2;
      }
      escolhidos = [ws];
    }
    if (escolhidos.length === 0) {
      deps.aviso('O banco não tem nenhum processo acompanhado.');
      return 2;
    }

    const resultados = escolhidos.map((w) =>
      diagnosticarTextoPorAto(db, w.id, config, agora),
    );
    escolhidos.forEach((w, i) => {
      deps.saida('');
      for (const l of linhasDoWorkspace(
        `Conta ${i + 1} · ${mascararEmail(w.email)}`,
        resultados[i] as ResultadoDoWorkspace,
        config,
      )) {
        deps.saida(l);
      }
    });
    const total = somarResultados(resultados);
    if (resultados.length > 1) {
      deps.saida('');
      for (const l of linhasDoWorkspace(
        `TOTAL de ${resultados.length} contas`,
        total,
        config,
      )) {
        deps.saida(l);
      }
    }

    const arquivo = join(
      deps.pastaTemporaria ?? tmpdir(),
      NOME_DO_ARQUIVO_DA_TABELA_DE_TEXTO,
    );
    writeFileSync(
      arquivo,
      JSON.stringify(
        {
          versao: VERSAO_DA_SONDA_DE_TEXTO,
          minimoDeCaracteres: MINIMO,
          janelaDeAtosDias: config.janelaDeAtosDias,
          contas: resultados.map((r, i) => ({ conta: i + 1, ...r })),
          total,
        },
        null,
        2,
      ),
    );
    deps.saida('');
    deps.saida(`Tabela numérica (só contagens): ${arquivo}`);
    return 0;
  } finally {
    db.close();
  }
}
