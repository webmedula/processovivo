import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  PENDENCIA_INTIMACAO_JANELA_DIAS,
  PENDENCIA_JANELA_DIAS_PADRAO,
  estadoDaPasta,
} from '../../domain/entities/estadoDaPasta.js';
import type { MarcaDeCumprido } from '../../domain/entities/estadoDaPasta.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import { reidratarProcesso } from './processoSerializacao.js';
import type { ProcessoSerializado } from './processoSerializacao.js';

/**
 * Sonda de diagnóstico da providência (v1.0.0): por que um processo APARECE ou NÃO
 * APARECE em "Atualizações → Pedem providência". O dono a roda no Console do serviço
 * para comparar a aba com a tela de Intimações do Projudi, processo a processo.
 *
 * Garantias, todas com teste:
 *  - SOMENTE LEITURA: o banco abre com `readOnly` e `query_only`, sem `abrirBanco` — logo
 *    sem esquema, sem migração, sem retrocarga, sem WAL novo. Coluna que a versão do
 *    banco ainda não tem é tratada como ausente, não criada;
 *  - SEM REDE: não importa adapter nenhum;
 *  - NADA DE SEGREDO: nunca lê a coluna de senha, credencial de tribunal ou XML. O
 *    texto do ato nunca é lido; o rótulo curto só sai no terminal e só com `--mostrar`;
 *  - número de processo MASCARADO no terminal sem `--mostrar`; o arquivo em
 *    `os.tmpdir()` leva só contagens e booleanos (nem número, nem texto).
 *
 * As regras NÃO são reescritas aqui: `estadoDaPasta` e `reidratarProcesso` são os mesmos
 * da rota `GET /v1/novidades`. Só os predicados do filtro da TELA (acompanhado, tribunal,
 * Período por `detectadaEm`, Situação) são avaliados em separado, um a um, para explicar.
 */

export const VERSAO_DA_SONDA = '1.0.0';
export const NOME_DO_ARQUIVO_DA_TABELA = 'diagnostico-providencia-tabela.json';

const DIA_MS = 86_400_000;

export interface ConfigDoDiagnostico {
  /** Tribunal do filtro da tela (padrão TJGO). */
  readonly tribunal: string;
  /** "Últimos N dias" do Período (`NOVIDADES_JANELA_DIAS`, 15). */
  readonly janelaPeriodoDias: number;
  /** `PENDENCIA_JANELA_DIAS` (10). */
  readonly janelaPendenciaDias: number;
  readonly janelaIntimacaoDias: number;
}

export const CONFIG_PADRAO: ConfigDoDiagnostico = {
  tribunal: 'TJGO',
  janelaPeriodoDias: 15,
  janelaPendenciaDias: PENDENCIA_JANELA_DIAS_PADRAO,
  janelaIntimacaoDias: PENDENCIA_INTIMACAO_JANELA_DIAS,
};

export interface Predicados {
  readonly acompanhado: boolean;
  readonly tribunal: boolean;
  /** Período = há novidade com `detectadaEm` nos últimos N dias (a regra da tela). */
  readonly periodo: boolean;
  /** Situação = `estadoDaPasta === 'PROVIDENCIA'`. */
  readonly situacao: boolean;
}

export interface DiagnosticoDeProcesso {
  /** Só em memória: nunca vai para o arquivo. */
  readonly numero: string;
  readonly predicados: Predicados;
  readonly aparece: boolean;
  /** Frases do terminal: por que NÃO aparece (vazio quando aparece). */
  readonly motivos: readonly string[];
  readonly tribunal: string | null;
  readonly tribunalDoNumero: string | null;
  readonly retrato: {
    readonly temRetrato: boolean;
    readonly temDatajud: boolean;
    readonly temDjen: boolean;
    readonly movimentacoes: number;
    readonly comunicacoesDjen: number;
    readonly comTipoDeComunicacao: number;
    readonly ultimaMovimentacao: Date | null;
    readonly sincronizadoEm: Date | null;
    readonly comErro: boolean;
  };
  readonly novidades: {
    readonly total: number;
    readonly naoLidas: number;
    readonly noPeriodo: number;
    readonly maiorLote: number;
    /** Dessas, quantas têm ato mais de 30 dias anterior à detecção (a assinatura do despejo). */
    readonly maiorLoteAntigas: number;
  };
  readonly providencia: {
    readonly situacao: 'pede' | 'cumprida' | 'venceu' | 'outro' | 'nenhuma';
    readonly tipo: 'intimacao' | 'citacao' | 'outro' | null;
    readonly paraOUsuario: 'sim' | 'nao' | 'desconhecido' | null;
    readonly rotulo: string | null;
    readonly data: Date | null;
    readonly cumprido: boolean;
    readonly comOutroDestinatario: boolean;
  };
}

type Linha = Record<string, unknown>;

/** Abre o banco sem poder escrever nele — e sem passar por `abrirBanco`, que migra. */
export function abrirSomenteLeitura(caminho: string): DatabaseSync {
  const db = new DatabaseSync(caminho, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
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

// ---------- workspaces ----------

export interface WorkspaceDoBanco {
  readonly id: string;
  readonly email: string | null;
  readonly processos: number;
}

export function listarWorkspaces(db: DatabaseSync): WorkspaceDoBanco[] {
  const contagem = db
    .prepare('SELECT workspace, COUNT(*) AS n FROM acompanhamentos GROUP BY workspace')
    .all() as Linha[];
  // Só o e-mail: a coluna de senha nunca é lida.
  const emails = new Map(
    (db.prepare('SELECT workspace, email FROM usuarios').all() as Linha[]).map((l) => [
      String(l['workspace']),
      String(l['email']),
    ]),
  );
  return contagem
    .map((l) => ({
      id: String(l['workspace']),
      email: emails.get(String(l['workspace'])) ?? null,
      processos: Number(l['n']),
    }))
    .sort((a, b) => b.processos - a.processos || a.id.localeCompare(b.id));
}

/** `--workspace` aceita o identificador do ambiente ou o e-mail da conta. */
export function resolverWorkspace(
  lista: readonly WorkspaceDoBanco[],
  pedido: string,
): WorkspaceDoBanco | null {
  const p = pedido.trim().toLowerCase();
  return lista.find((w) => w.id === pedido.trim() || w.email?.toLowerCase() === p) ?? null;
}

// ---------- diagnóstico de um processo ----------

export function diagnosticarProcesso(
  db: DatabaseSync,
  workspace: string,
  numeroPedido: string,
  config: ConfigDoDiagnostico,
  agora: Date,
): DiagnosticoDeProcesso {
  const numero = NumeroCNJ.criar(numeroPedido);
  const colunas = colunasDe(db, 'acompanhamentos');
  const temMarca = colunas.has('cumprido_chave');
  const linha = db
    .prepare(
      `SELECT tribunal, sincronizado_em, erro, processo${
        temMarca ? ', cumprido_chave, cumprido_ate, cumprido_em' : ''
      } FROM acompanhamentos WHERE workspace = ? AND numero = ?`,
    )
    .get(workspace, numero.digitos) as Linha | undefined;

  const novidades = db
    .prepare('SELECT data, detectada_em, vista_em FROM novidades WHERE workspace = ? AND numero = ?')
    .all(workspace, numero.digitos) as Linha[];

  const limitePeriodo = agora.getTime() - config.janelaPeriodoDias * DIA_MS;
  let naoLidas = 0;
  let noPeriodo = 0;
  const lotes = new Map<string, { total: number; antigas: number }>();
  for (const n of novidades) {
    const det = data(n['detectada_em']);
    const ato = data(n['data']);
    if (n['vista_em'] === null || n['vista_em'] === undefined) naoLidas += 1;
    if (det && det.getTime() >= limitePeriodo) noPeriodo += 1;
    const chave = String(n['detectada_em']);
    const lote = lotes.get(chave) ?? { total: 0, antigas: 0 };
    lote.total += 1;
    if (det && ato && det.getTime() - ato.getTime() >= 30 * DIA_MS) lote.antigas += 1;
    lotes.set(chave, lote);
  }
  let maior = { total: 0, antigas: 0 };
  for (const l of lotes.values()) if (l.total > maior.total) maior = l;

  const acompanhado = linha !== undefined;
  const bruto = linha && typeof linha['processo'] === 'string' ? linha['processo'] : null;
  const processo = bruto
    ? reidratarProcesso(JSON.parse(bruto) as ProcessoSerializado, false)
    : null;
  const movs = processo?.movimentacoes ?? [];

  const marca: MarcaDeCumprido | undefined =
    linha && temMarca && data(linha['cumprido_ate']) && data(linha['cumprido_em'])
      ? {
          chave: String(linha['cumprido_chave']),
          ate: data(linha['cumprido_ate']) as Date,
          em: data(linha['cumprido_em']) as Date,
        }
      : undefined;
  const sincronizadoEm = linha ? data(linha['sincronizado_em']) : null;
  const erro = linha && typeof linha['erro'] === 'string' ? linha['erro'] : undefined;

  // A MESMA função da rota: o selo da tela e a sonda não podem divergir.
  const estado = estadoDaPasta(
    {
      ...(erro !== undefined ? { erro } : {}),
      ...(sincronizadoEm ? { sincronizadoEm } : {}),
      novidadesNaoVistas: naoLidas,
      movimentacoes: movs,
      ...(marca ? { cumprido: marca } : {}),
    },
    agora,
    config.janelaPendenciaDias,
    config.janelaIntimacaoDias,
  );
  const l = estado.providencia;
  const ato = l.pendente ?? l.coberto ?? l.venceuPorTempo ?? l.outroDestinatario;
  const situacao = l.pendente
    ? 'pede'
    : l.coberto
      ? 'cumprida'
      : l.venceuPorTempo
        ? 'venceu'
        : l.outroDestinatario
          ? 'outro'
          : 'nenhuma';

  const tribunal = linha && typeof linha['tribunal'] === 'string' ? linha['tribunal'] : null;
  const tribunalDoNumero = numero.siglaTribunal;
  const predicados: Predicados = {
    acompanhado,
    tribunal: tribunal === config.tribunal,
    periodo: noPeriodo > 0,
    situacao: estado.rotulo === 'PROVIDENCIA',
  };

  const motivos: string[] = [];
  if (!predicados.acompanhado) {
    motivos.push('o processo não está acompanhado neste workspace');
  } else {
    if (!predicados.tribunal) {
      motivos.push(
        `o tribunal do retrato é ${tribunal ?? 'desconhecido (sem retrato)'}, não ${config.tribunal}` +
          (tribunalDoNumero && tribunalDoNumero !== tribunal
            ? ` (o número diz ${tribunalDoNumero})`
            : ''),
      );
    }
    if (!predicados.periodo) {
      motivos.push(
        novidades.length === 0
          ? 'o Período usa a data de DETECÇÃO e este processo nunca teve novidade detectada ' +
              '(a primeira sincronização guarda o retrato sem gerar novidade)'
          : `o Período usa a data de DETECÇÃO e nenhuma novidade foi detectada nos últimos ${config.janelaPeriodoDias} dias`,
      );
    }
    if (!predicados.situacao) {
      motivos.push(
        !processo
          ? 'não há retrato do processo (nunca sincronizou), então não há ato para ler'
          : situacao === 'cumprida'
            ? 'o ato que pediria providência está coberto por uma marca de "cumprido"'
            : situacao === 'venceu'
              ? `a intimação/citação passou de ${config.janelaIntimacaoDias} dias sem marca`
              : situacao === 'outro'
                ? 'a intimação/citação é dirigida a outro destinatário'
                : 'nenhum ato dentro da janela pede providência' +
                  (movs.some((m) => m.tipoComunicacao !== undefined)
                    ? ''
                    : ' (nenhuma comunicação do Diário com tipo gravado: o tipo só entra na próxima sincronização)'),
      );
    }
  }

  return {
    numero: numero.digitos,
    predicados,
    aparece: Object.values(predicados).every(Boolean),
    motivos,
    tribunal,
    tribunalDoNumero,
    retrato: {
      temRetrato: processo !== null,
      temDatajud: (processo?.procedencia.provider ?? '').split('+').includes('datajud'),
      temDjen: (processo?.procedencia.provider ?? '').split('+').includes('djen'),
      movimentacoes: movs.length,
      comunicacoesDjen: movs.filter((m) => m.idExterno?.startsWith('djen:')).length,
      comTipoDeComunicacao: movs.filter((m) => m.tipoComunicacao !== undefined).length,
      ultimaMovimentacao: movs[0]?.data ?? null,
      sincronizadoEm,
      comErro: erro !== undefined,
    },
    novidades: {
      total: novidades.length,
      naoLidas,
      noPeriodo,
      maiorLote: maior.total,
      maiorLoteAntigas: maior.antigas,
    },
    providencia: {
      situacao,
      tipo: ato?.tipo ?? null,
      paraOUsuario: ato?.paraOUsuario ?? null,
      rotulo: ato?.rotulo ?? null,
      data: ato?.data ?? null,
      cumprido: marca !== undefined,
      comOutroDestinatario: l.outroDestinatario !== undefined,
    },
  };
}

// ---------- apresentação ----------

/** `*******-**.****.8.09.0051`: fica só o que identifica o tribunal e a origem. */
export function mascararNumero(digitos: string): string {
  const f = NumeroCNJ.criar(digitos).formatado;
  const p = f.split('.');
  const [seq] = (p[0] ?? '').split('-');
  return `${'*'.repeat((seq ?? '').length)}-**.****.${p[2] ?? ''}.${p[3] ?? ''}.${p[4] ?? ''}`;
}

export function mascararEmail(email: string | null): string {
  if (!email) return '(sem e-mail)';
  const [u = '', d = ''] = email.split('@');
  return `${u.slice(0, 1)}***@${d}`;
}

const dataBr = (d: Date | null): string =>
  d
    ? d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : '—';
const sn = (b: boolean): string => (b ? 'sim' : 'não');

export function linhasDoProcesso(
  d: DiagnosticoDeProcesso,
  opcoes: { mostrar: boolean; ordem?: number; rotuloDoAto?: string | undefined },
  config: ConfigDoDiagnostico,
): string[] {
  const num = opcoes.mostrar ? NumeroCNJ.criar(d.numero).formatado : mascararNumero(d.numero);
  const r = d.retrato;
  const n = d.novidades;
  const p = d.providencia;
  const out: string[] = [];
  out.push(`${opcoes.ordem !== undefined ? `#${opcoes.ordem} ` : ''}Processo ${num}`);
  out.push(`  acompanhado: ${sn(d.predicados.acompanhado)}`);
  if (!d.predicados.acompanhado) {
    out.push(`  => NÃO aparece, porque ${d.motivos.join('; ')}`);
    return out;
  }
  out.push(
    `  tribunal: ${d.tribunal ?? '—'}` +
      (d.tribunalDoNumero ? ` (pelo número: ${d.tribunalDoNumero})` : ''),
  );
  const fontes = [r.temDatajud ? 'datajud' : '', r.temDjen ? 'djen' : ''].filter(Boolean).join('+');
  out.push(
    `  retrato: ${r.temRetrato ? fontes || 'outra fonte' : 'SEM retrato'}` +
      ` · ${r.movimentacoes} movimentações · ${r.comunicacoesDjen} comunicações do DJEN` +
      ` (${r.comTipoDeComunicacao} com tipo gravado)` +
      ` · última movimentação ${dataBr(r.ultimaMovimentacao)}` +
      (r.comErro ? ' · ÚLTIMA SINCRONIZAÇÃO FALHOU' : ''),
  );
  out.push(
    `  novidades: ${n.total} no total · ${n.naoLidas} não lidas · ${n.noPeriodo} detectadas nos últimos ` +
      `${config.janelaPeriodoDias} dias · maior lote no mesmo instante: ${n.maiorLote}` +
      (n.maiorLote > 1 ? ` (${n.maiorLoteAntigas} com ato 30+ dias anterior à detecção)` : ''),
  );
  out.push(
    `  providência: ${p.situacao}` +
      (p.situacao !== 'nenhuma'
        ? ` · ato de ${dataBr(p.data)} · tipo ${p.tipo ?? '—'} · destinatário ${p.paraOUsuario ?? '—'}` +
          (opcoes.mostrar && opcoes.rotuloDoAto ? ` · "${opcoes.rotuloDoAto}"` : '')
        : '') +
      (p.cumprido ? ' · tem marca de cumprido' : ''),
  );
  out.push(
    `  predicados do filtro: acompanhado=${sn(d.predicados.acompanhado)} · ` +
      `tribunal=${config.tribunal}:${sn(d.predicados.tribunal)} · ` +
      `período(detectadaEm ≤ ${config.janelaPeriodoDias}d):${sn(d.predicados.periodo)} · ` +
      `situação(pede providência):${sn(d.predicados.situacao)}`,
  );
  out.push(
    d.aparece
      ? '  => APARECE na lista (TJGO + Pedem providência + Período)'
      : `  => NÃO aparece, porque ${d.motivos.join('; ')}`,
  );
  return out;
}

// ---------- arquivo numérico ----------

export interface LinhaDaTabela {
  readonly ordem: number;
  readonly acompanhado: boolean;
  readonly tribunalConfere: boolean;
  readonly tribunalDoNumeroConfere: boolean;
  readonly noPeriodo: boolean;
  readonly pedeProvidencia: boolean;
  readonly aparece: boolean;
  readonly temRetrato: boolean;
  readonly temDatajud: boolean;
  readonly temDjen: boolean;
  readonly movimentacoes: number;
  readonly comunicacoesDjen: number;
  readonly comTipoDeComunicacao: number;
  readonly diasDesdeUltimaMovimentacao: number | null;
  readonly novidadesTotal: number;
  readonly novidadesNaoLidas: number;
  readonly novidadesNoPeriodo: number;
  readonly maiorLote: number;
  readonly maiorLoteAntigas: number;
  readonly providenciaPede: boolean;
  readonly providenciaCumprida: boolean;
  readonly providenciaVenceu: boolean;
  readonly providenciaOutroDestinatario: boolean;
  readonly atoEhIntimacaoOuCitacao: boolean;
  readonly destinatarioSim: boolean;
  readonly destinatarioNao: boolean;
  readonly destinatarioDesconhecido: boolean;
  readonly comMarcaDeCumprido: boolean;
}

/** Só contagens e booleanos: sem número de processo, sem rótulo, sem texto, sem data absoluta. */
export function linhaDaTabela(
  d: DiagnosticoDeProcesso,
  ordem: number,
  config: ConfigDoDiagnostico,
  agora: Date,
): LinhaDaTabela {
  const ult = d.retrato.ultimaMovimentacao;
  return {
    ordem,
    acompanhado: d.predicados.acompanhado,
    tribunalConfere: d.predicados.tribunal,
    tribunalDoNumeroConfere: d.tribunalDoNumero === config.tribunal,
    noPeriodo: d.predicados.periodo,
    pedeProvidencia: d.predicados.situacao,
    aparece: d.aparece,
    temRetrato: d.retrato.temRetrato,
    temDatajud: d.retrato.temDatajud,
    temDjen: d.retrato.temDjen,
    movimentacoes: d.retrato.movimentacoes,
    comunicacoesDjen: d.retrato.comunicacoesDjen,
    comTipoDeComunicacao: d.retrato.comTipoDeComunicacao,
    diasDesdeUltimaMovimentacao: ult
      ? Math.floor((agora.getTime() - ult.getTime()) / DIA_MS)
      : null,
    novidadesTotal: d.novidades.total,
    novidadesNaoLidas: d.novidades.naoLidas,
    novidadesNoPeriodo: d.novidades.noPeriodo,
    maiorLote: d.novidades.maiorLote,
    maiorLoteAntigas: d.novidades.maiorLoteAntigas,
    providenciaPede: d.providencia.situacao === 'pede',
    providenciaCumprida: d.providencia.situacao === 'cumprida',
    providenciaVenceu: d.providencia.situacao === 'venceu',
    providenciaOutroDestinatario: d.providencia.comOutroDestinatario,
    atoEhIntimacaoOuCitacao:
      d.providencia.tipo === 'intimacao' || d.providencia.tipo === 'citacao',
    destinatarioSim: d.providencia.paraOUsuario === 'sim',
    destinatarioNao: d.providencia.paraOUsuario === 'nao',
    destinatarioDesconhecido: d.providencia.paraOUsuario === 'desconhecido',
    comMarcaDeCumprido: d.providencia.cumprido,
  };
}

// ---------- execução ----------

export interface Argumentos {
  readonly workspace?: string;
  readonly numeros: readonly string[];
  readonly arquivo?: string;
  readonly listaFiltro: boolean;
  readonly mostrar: boolean;
  readonly tribunal?: string;
  readonly janela?: number;
}

export function lerArgumentos(argv: readonly string[]): Argumentos {
  let workspace: string | undefined;
  let arquivo: string | undefined;
  let tribunal: string | undefined;
  let janela: number | undefined;
  const numeros: string[] = [];
  let listaFiltro = false;
  let mostrar = false;
  for (const a of argv) {
    const [chave = '', ...resto] = a.split('=');
    const valor = resto.join('=');
    if (chave === '--workspace') workspace = valor;
    else if (chave === '--numeros') numeros.push(...valor.split(',').map((x) => x.trim()).filter(Boolean));
    else if (chave === '--arquivo') arquivo = valor;
    else if (chave === '--tribunal') tribunal = valor.toUpperCase();
    else if (chave === '--janela') janela = Number(valor);
    else if (chave === '--lista-filtro') listaFiltro = true;
    else if (chave === '--mostrar') mostrar = true;
    else throw new Error(`argumento desconhecido: ${chave}`);
  }
  return {
    ...(workspace ? { workspace } : {}),
    numeros,
    ...(arquivo ? { arquivo } : {}),
    listaFiltro,
    mostrar,
    ...(tribunal ? { tribunal } : {}),
    ...(janela !== undefined && Number.isFinite(janela) && janela > 0 ? { janela } : {}),
  };
}

export interface DependenciasDaSonda {
  readonly caminhoBanco: string;
  readonly config?: Partial<ConfigDoDiagnostico>;
  readonly agora?: () => Date;
  /** stdout: o relatório. */
  readonly saida: (linha: string) => void;
  /** stderr: avisos e recusas. */
  readonly aviso: (linha: string) => void;
  /** Pasta do arquivo numérico. Padrão: `os.tmpdir()`. */
  readonly pastaTemporaria?: string;
}

/** Só no terminal e só com --mostrar: o rótulo do ato, até 60 caracteres. O TEXTO do ato nunca é lido. */
function rotuloCurto(d: DiagnosticoDeProcesso): string | undefined {
  if (!d.providencia.rotulo) return undefined;
  const r = d.providencia.rotulo.replace(/\s+/g, ' ').trim();
  return r.length > 60 ? `${r.slice(0, 59)}…` : r;
}

function normalizar(bruto: string): string | null {
  try {
    return NumeroCNJ.criar(bruto).digitos;
  } catch {
    return null;
  }
}

/** Devolve o código de saída. */
export function executarDiagnostico(argv: readonly string[], deps: DependenciasDaSonda): number {
  let args: Argumentos;
  try {
    args = lerArgumentos(argv);
  } catch (erro) {
    deps.aviso(erro instanceof Error ? erro.message : String(erro));
    deps.aviso(USO);
    return 2;
  }
  const config: ConfigDoDiagnostico = {
    ...CONFIG_PADRAO,
    ...deps.config,
    ...(args.tribunal ? { tribunal: args.tribunal } : {}),
    ...(args.janela ? { janelaPeriodoDias: args.janela } : {}),
  };
  const agora = deps.agora ? deps.agora() : new Date();

  let db: DatabaseSync;
  try {
    db = abrirSomenteLeitura(deps.caminhoBanco);
  } catch (erro) {
    deps.aviso(
      `Não consegui abrir o banco em modo somente leitura: ${erro instanceof Error ? erro.message : String(erro)}`,
    );
    return 1;
  }

  try {
    deps.saida(`Sonda de providência v${VERSAO_DA_SONDA} — somente leitura, sem rede, nada é gravado no banco.`);
    const workspaces = listarWorkspaces(db);
    let ws: WorkspaceDoBanco | undefined;
    if (args.workspace) {
      ws = resolverWorkspace(workspaces, args.workspace) ?? undefined;
      if (!ws) {
        deps.aviso('Workspace não encontrado. Use o identificador ou o e-mail da conta.');
        return 2;
      }
    } else if (workspaces.length === 1) {
      ws = workspaces[0];
    } else {
      deps.aviso(
        workspaces.length === 0
          ? 'O banco não tem nenhum processo acompanhado.'
          : `Há ${workspaces.length} workspaces: informe --workspace=<id ou e-mail>.`,
      );
      workspaces.forEach((w, i) =>
        deps.aviso(
          `  ${i + 1}. ${w.id} · ${mascararEmail(w.email)} · ${w.processos} processos`,
        ),
      );
      return 2;
    }
    if (!ws) return 2;

    const brutos = [...args.numeros];
    if (args.arquivo) {
      brutos.push(
        ...readFileSync(args.arquivo, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      );
    }
    if (!args.listaFiltro && brutos.length === 0) {
      deps.aviso('Informe --numeros, --arquivo ou --lista-filtro.');
      deps.aviso(USO);
      return 2;
    }

    const pedidos = new Set<string>();
    let invalidos = 0;
    for (const b of brutos) {
      const n = normalizar(b);
      if (n) pedidos.add(n);
      else invalidos += 1;
    }
    if (invalidos > 0) {
      deps.aviso(`${invalidos} número(s) pedido(s) não são números CNJ válidos e foram ignorados.`);
    }

    // Com --lista-filtro a base é a carteira inteira do workspace; sem ela, só o que foi pedido.
    const base = new Set(pedidos);
    if (args.listaFiltro) {
      const todos = db
        .prepare('SELECT numero FROM acompanhamentos WHERE workspace = ? ORDER BY numero')
        .all(ws.id) as Linha[];
      for (const l of todos) base.add(String(l['numero']));
    }
    const diagnosticos = [...base].map((n) => diagnosticarProcesso(db, ws.id, n, config, agora));

    let ordem = 0;
    for (const d of diagnosticos.filter((x) => pedidos.has(x.numero))) {
      ordem += 1;
      deps.saida('');
      for (const linha of linhasDoProcesso(
        d,
        { mostrar: args.mostrar, ordem, rotuloDoAto: rotuloCurto(d) },
        config,
      )) {
        deps.saida(linha);
      }
    }

    const tabela: LinhaDaTabela[] = [];
    diagnosticos.forEach((d, i) => tabela.push(linhaDaTabela(d, i + 1, config, agora)));

    if (args.listaFiltro) {
      const passam = diagnosticos.filter((d) => d.aparece);
      const foraSoPeloPeriodo = diagnosticos.filter(
        (d) =>
          d.predicados.acompanhado &&
          d.predicados.tribunal &&
          d.predicados.situacao &&
          !d.predicados.periodo,
      );
      deps.saida('');
      deps.saida(
        `Filtro da tela: ${config.tribunal} + Pedem providência + Últimos ${config.janelaPeriodoDias} dias (por detecção)`,
      );
      const imprimir = (lista: readonly DiagnosticoDeProcesso[]): void => {
        lista.forEach((d, i) =>
          deps.saida(
            `  ${String(i + 1).padStart(2, '0')}. ${
              args.mostrar ? NumeroCNJ.criar(d.numero).formatado : mascararNumero(d.numero)
            } · ato de ${dataBr(d.providencia.data)} · ${d.providencia.tipo ?? '—'} · destinatário ${
              d.providencia.paraOUsuario ?? '—'
            }`,
          ),
        );
      };
      imprimir(passam);
      deps.saida(`Total: ${passam.length} processos passam no filtro (a tela deve mostrar o mesmo número).`);
      deps.saida(
        'Marque, na lista acima, os que NÃO estão na tela de Intimações do Projudi; rode de novo com --numeros=… para ver o porquê de cada um.',
      );
      if (!args.mostrar) deps.saida('(Os números saem mascarados; use --mostrar para vê-los inteiros.)');
      deps.saida('');
      deps.saida(
        `Pedem providência em ${config.tribunal} mas FICAM DE FORA só pelo Período (a detecção é anterior a ${config.janelaPeriodoDias} dias ou nunca houve): ${foraSoPeloPeriodo.length}`,
      );
      imprimir(foraSoPeloPeriodo);
      const resumo = {
        acompanhados: diagnosticos.filter((d) => d.predicados.acompanhado).length,
        noTribunal: diagnosticos.filter((d) => d.predicados.acompanhado && d.predicados.tribunal).length,
        pedemProvidencia: diagnosticos.filter((d) => d.predicados.situacao).length,
        passamNoFiltro: passam.length,
        forasSoPeloPeriodo: foraSoPeloPeriodo.length,
        pedemPorIntimacaoDestinatarioSim: diagnosticos.filter((d) => d.predicados.situacao && d.providencia.paraOUsuario === 'sim').length,
        pedemPorIntimacaoDestinatarioNao: diagnosticos.filter((d) => d.predicados.situacao && d.providencia.paraOUsuario === 'nao').length,
        pedemPorIntimacaoDestinatarioDesconhecido: diagnosticos.filter((d) => d.predicados.situacao && d.providencia.paraOUsuario === 'desconhecido').length,
        pedemSemSerIntimacaoOuCitacao: diagnosticos.filter((d) => d.predicados.situacao && d.providencia.tipo === 'outro').length,
      };
      const arquivo = join(deps.pastaTemporaria ?? tmpdir(), NOME_DO_ARQUIVO_DA_TABELA);
      writeFileSync(arquivo, JSON.stringify({ versao: VERSAO_DA_SONDA, resumo, processos: tabela }, null, 2));
      deps.saida('');
      deps.saida(`Tabela numérica (só contagens e booleanos): ${arquivo}`);
    } else {
      const arquivo = join(deps.pastaTemporaria ?? tmpdir(), NOME_DO_ARQUIVO_DA_TABELA);
      writeFileSync(arquivo, JSON.stringify({ versao: VERSAO_DA_SONDA, processos: tabela }, null, 2));
      deps.saida('');
      deps.saida(`Tabela numérica (só contagens e booleanos): ${arquivo}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

export const USO = `Uso: node scripts/diagnostico-providencia.mjs [--workspace=<id|e-mail>]
       (--numeros=n1,n2,… | --arquivo=<txt> | --lista-filtro) [--mostrar]
       [--tribunal=TJGO] [--janela=15]`;
