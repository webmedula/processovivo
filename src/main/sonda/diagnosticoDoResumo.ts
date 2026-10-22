import type { DatabaseSync } from 'node:sqlite';
import { atosQuePedemProvidencia } from '../../domain/entities/estadoDaPasta.js';
import { chaveDaMovimentacao } from '../../domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import { triar } from '../../domain/entities/triagem.js';
import { MINIMO_DE_CARACTERES_DO_TEXTO } from '../../application/politicas/entradaDoModelo.js';
import {
  ORCAMENTO_DO_RESUMO,
  atoTemTextoUtilizavel,
  selecionarAtosParaResumo,
} from '../../application/politicas/selecionarAtosParaResumo.js';
import {
  abrirSomenteLeitura,
  listarWorkspaces,
  resolverWorkspace,
} from '../../infrastructure/persistencia/diagnosticoDeProvidencia.js';
import { reidratarProcesso } from '../../infrastructure/persistencia/processoSerializacao.js';
import type { ProcessoSerializado } from '../../infrastructure/persistencia/processoSerializacao.js';

/**
 * Diagnóstico do resumo por IA (v0.54.0): por que um processo ficou com o ato mais recente
 * sem texto no "Resumir este processo com IA". SOMENTE LEITURA e SEM REDE, no molde de
 * `diagnostico-providencia.mjs`: o banco abre com `readOnly` e `query_only` (nunca por
 * `abrirBanco`) e a SAÍDA É SÓ NÚMERO E CATEGORIA FECHADA — nenhum trecho de texto, nome,
 * título, número de processo, identificador de ato, workspace ou e-mail chega ao terminal, e
 * nada é gravado. O número do processo entra só como argumento, em tempo de execução.
 *
 * As regras NÃO são reescritas: `atoTemTextoUtilizavel`, `selecionarAtosParaResumo` e
 * `atosQuePedemProvidencia` são as MESMAS do serviço do resumo.
 */

export const VERSAO_DO_DIAGNOSTICO_DO_RESUMO = '1.0.0';
const DIA_MS = 86_400_000;

type Linha = Record<string, unknown>;

export interface AmbienteDoDiagnosticoDoResumo {
  readonly caminhoBanco: string;
  readonly existeArquivo: (caminho: string) => boolean;
  readonly agora: () => Date;
  readonly janelaDePendenciaDias: number;
  readonly saida: (linha: string) => void;
  readonly aviso: (linha: string) => void;
}

export type MotivoSemTexto =
  'teor_indisponivel' | 'sem_conteudo_nem_complementos' | 'texto_curto';

export type OrigemDoCorpo = 'conteudo' | 'complementos' | 'vazio';

const CLASSES_DO_TITULO: ReadonlyArray<readonly [string, RegExp]> = [
  ['despacho', /^\s*despacho/i],
  ['decisão', /^\s*decis[ãa]o/i],
  ['sentença', /^\s*senten[çc]a/i],
  ['intimação', /intima[çc][ãa]o/i],
  ['citação', /cita[çc][ãa]o/i],
  ['ato ordinatório', /ato ordinat[óo]rio/i],
  ['juntada', /juntada/i],
  ['conclusão', /conclus/i],
];

/** Classe do título por lista FECHADA; o título em si nunca sai. */
export function classeDoTitulo(titulo: string): string {
  return CLASSES_DO_TITULO.find(([, r]) => r.test(titulo))?.[0] ?? 'outro';
}

/** Só o prefixo da fonte, e só se for um dos conhecidos. */
export function fonteDoAto(m: Movimentacao): string {
  const prefixo = m.idExterno?.split(':')[0]?.toLowerCase();
  if (prefixo === 'djen' || prefixo === 'datajud' || prefixo === 'mni') return prefixo;
  const fonte = m.fonte?.toLowerCase();
  if (fonte === 'djen' || fonte === 'datajud' || fonte === 'tribunal') return fonte;
  return m.idExterno ? 'outra' : 'sem identificador';
}

/** A marcação de "pede providência" por CATEGORIA — o motivo cru da triagem pode levar o título. */
export function categoriaDaMarcacao(m: Movimentacao): string {
  const motivo = triar(m).motivo ?? '';
  if (motivo.startsWith('intimação ou citação'))
    return 'intimação/citação publicada no Diário';
  if (motivo.startsWith('o ato menciona prazo')) return 'o texto menciona prazo em dias';
  if (motivo.startsWith('o ato contém determinação')) return 'o texto traz determinação';
  if (motivo.startsWith('é ')) return 'só pelo tipo do ato (título)';
  return motivo === '' ? 'sem motivo' : 'outro';
}

export interface ContagemDosCampos {
  readonly titulo: number;
  readonly conteudo: number;
  readonly complementosItens: number;
  readonly complementosCaracteres: number;
  /** Tamanho do corpo que o contador do resumo usa (conteúdo; senão, complementos). */
  readonly corpoDoContador: number;
  readonly origemDoCorpo: OrigemDoCorpo;
}

export function contarCampos(m: Movimentacao): ContagemDosCampos {
  const conteudo = m.conteudo?.trim() ?? '';
  const complementos = (m.complementos ?? []).map((c) => c.trim()).filter(Boolean);
  const complementosCaracteres = complementos.join('\n').length;
  const origem: OrigemDoCorpo =
    conteudo !== '' ? 'conteudo' : complementos.length > 0 ? 'complementos' : 'vazio';
  return {
    titulo: m.titulo.length,
    conteudo: conteudo.length,
    complementosItens: complementos.length,
    complementosCaracteres,
    corpoDoContador:
      origem === 'conteudo'
        ? conteudo.length
        : origem === 'complementos'
          ? complementosCaracteres
          : 0,
    origemDoCorpo: origem,
  };
}

export function motivoDeNaoSerUtilizavel(m: Movimentacao): MotivoSemTexto | undefined {
  if (atoTemTextoUtilizavel(m)) return undefined;
  if (m.teorIndisponivel === true) return 'teor_indisponivel';
  return contarCampos(m).corpoDoContador === 0
    ? 'sem_conteudo_nem_complementos'
    : 'texto_curto';
}

export interface AtoDiagnosticado {
  readonly posicao: number;
  readonly idadeEmDias: number;
  readonly classeDoTitulo: string;
  readonly fonte: string;
  readonly campos: ContagemDosCampos;
  readonly teorIndisponivel: boolean;
  readonly tipoDaComunicacao: string;
  readonly pedeProvidencia: boolean;
  readonly marcacao?: string;
  readonly textoUtilizavel: boolean;
  readonly motivoSemTexto?: MotivoSemTexto;
  readonly noResumoComo:
    'providência (com texto)' | 'recente (com texto)' | 'só título' | 'fora do resumo';
}

export interface DiagnosticoDoResumo {
  readonly totalDeAtos: number;
  readonly comTextoUtilizavel: number;
  readonly pedemProvidencia: number;
  readonly pedemProvidenciaSemTexto: number;
  readonly porFonte: Readonly<
    Record<string, { total: number; comConteudo: number; comTexto: number }>
  >;
  readonly mesmoDiaDoMaisRecente: { total: number; comTexto: number };
  readonly maisRecentes: readonly AtoDiagnosticado[];
  readonly selecao: {
    readonly comTexto: number;
    readonly soTitulo: number;
    readonly foraDoResumo: number;
    readonly porProvidencia: number;
    readonly porRecencia: number;
    /** v0.54.0: só-título absorvidos por ato com texto do mesmo dia e tipo. */
    readonly mesclados: number;
    readonly maisRecenteLido: boolean | null;
    readonly providenciasNaoLidas: number;
    readonly naoLidosPorMotivo: {
      readonly teorIndisponivel: number;
      readonly semTexto: number;
      readonly abaixoDoMinimo: number;
      readonly foraDoLimite: number;
    };
  };
  readonly retrato: {
    readonly idadeDaSincronizacaoEmDias: number | null;
    readonly idadeDaConsultaEmDias: number | null;
    readonly fontes: string;
  };
}

const dias = (de: Date, ate: Date): number =>
  Math.max(0, Math.floor((ate.getTime() - de.getTime()) / DIA_MS));

export function diagnosticarResumo(
  movimentacoes: readonly Movimentacao[],
  agora: Date,
  janelaDePendenciaDias: number,
  cumprido?: Parameters<typeof atosQuePedemProvidencia>[4],
): Omit<DiagnosticoDoResumo, 'retrato'> {
  const pendentes = atosQuePedemProvidencia(
    movimentacoes,
    agora,
    janelaDePendenciaDias,
    undefined,
    cumprido,
  );
  const chaves = new Set(pendentes.map((p) => p.chave));
  const selecao = selecionarAtosParaResumo(movimentacoes, chaves);
  const porChave = new Map(selecao.atos.map((a) => [a.chave, a]));

  const ordenados = [...movimentacoes].sort(
    (a, b) => b.data.getTime() - a.data.getTime(),
  );
  const porFonte: Record<
    string,
    { total: number; comConteudo: number; comTexto: number }
  > = {};
  for (const m of ordenados) {
    const f = fonteDoAto(m);
    const g = (porFonte[f] ??= { total: 0, comConteudo: 0, comTexto: 0 });
    g.total += 1;
    if (contarCampos(m).conteudo > 0) g.comConteudo += 1;
    if (atoTemTextoUtilizavel(m)) g.comTexto += 1;
  }

  const maisNovo = ordenados[0];
  const dia = maisNovo?.data.toISOString().slice(0, 10);
  const doMesmoDia = ordenados.filter((m) => m.data.toISOString().slice(0, 10) === dia);

  const maisRecentes = ordenados.slice(0, 5).map((m, i): AtoDiagnosticado => {
    const chave = chaveDaMovimentacao(m);
    const escolhido = porChave.get(chave);
    const pede = chaves.has(chave);
    const motivo = motivoDeNaoSerUtilizavel(m);
    return {
      posicao: i + 1,
      idadeEmDias: dias(m.data, agora),
      classeDoTitulo: classeDoTitulo(m.titulo),
      fonte: fonteDoAto(m),
      campos: contarCampos(m),
      teorIndisponivel: m.teorIndisponivel === true,
      tipoDaComunicacao: m.tipoComunicacao?.trim()
        ? classeDoTitulo(m.tipoComunicacao)
        : 'nenhum',
      pedeProvidencia: pede,
      ...(pede ? { marcacao: categoriaDaMarcacao(m) } : {}),
      textoUtilizavel: motivo === undefined,
      ...(motivo ? { motivoSemTexto: motivo } : {}),
      noResumoComo: !escolhido
        ? 'fora do resumo'
        : escolhido.motivo === 'providencia'
          ? 'providência (com texto)'
          : escolhido.motivo === 'recente'
            ? 'recente (com texto)'
            : 'só título',
    };
  });

  return {
    totalDeAtos: movimentacoes.length,
    comTextoUtilizavel: ordenados.filter(atoTemTextoUtilizavel).length,
    pedemProvidencia: pendentes.length,
    pedemProvidenciaSemTexto: ordenados.filter(
      (m) => chaves.has(chaveDaMovimentacao(m)) && !atoTemTextoUtilizavel(m),
    ).length,
    porFonte,
    mesmoDiaDoMaisRecente: {
      total: doMesmoDia.length,
      comTexto: doMesmoDia.filter(atoTemTextoUtilizavel).length,
    },
    maisRecentes,
    selecao: {
      comTexto: selecao.comTexto,
      soTitulo: selecao.soTitulo,
      foraDoResumo: selecao.foraDoResumo,
      porProvidencia: selecao.atos.filter((a) => a.motivo === 'providencia').length,
      porRecencia: selecao.atos.filter((a) => a.motivo === 'recente').length,
      mesclados: selecao.mesclados,
      maisRecenteLido: selecao.maisRecente?.lido ?? null,
      providenciasNaoLidas: selecao.providenciasNaoLidas.length,
      naoLidosPorMotivo: selecao.motivosDosNaoLidos,
    },
  };
}

const AJUDA = `Diagnóstico do resumo por IA (v${VERSAO_DO_DIAGNOSTICO_DO_RESUMO}) — SOMENTE LEITURA, SEM REDE, SÓ NÚMEROS.

  node scripts/diagnostico-resumo.mjs <número do processo>
  node scripts/diagnostico-resumo.mjs <número do processo> --workspace=<identificador ou e-mail da conta>

O número vale só neste comando e nunca é impresso. Com o mesmo processo acompanhado por mais de
uma conta, --workspace é obrigatório. Variáveis lidas: PROCESSOVIVO_DB_PATH e PENDENCIA_JANELA_DIAS.`;

export function executarDiagnosticoDoResumo(
  argv: readonly string[],
  amb: AmbienteDoDiagnosticoDoResumo,
): number {
  if (argv.includes('--ajuda') || argv.length === 0) {
    amb.saida(AJUDA);
    return argv.length === 0 ? 1 : 0;
  }
  const pedidoDeWorkspace = argv
    .find((a) => a.startsWith('--workspace='))
    ?.slice('--workspace='.length);
  const numeroPedido = argv.find((a) => !a.startsWith('--'));
  if (!numeroPedido) {
    amb.aviso('Informe o número do processo.');
    return 1;
  }
  let numero: string;
  try {
    numero = NumeroCNJ.criar(numeroPedido).digitos;
  } catch {
    amb.aviso('O número informado não é um número de processo válido.');
    return 1;
  }
  if (!amb.existeArquivo(amb.caminhoBanco)) {
    amb.aviso('Não encontrei o banco (PROCESSOVIVO_DB_PATH). Nada foi lido.');
    return 1;
  }

  let db: DatabaseSync;
  try {
    db = abrirSomenteLeitura(amb.caminhoBanco);
  } catch {
    amb.aviso('Não consegui abrir o banco em modo somente leitura.');
    return 1;
  }
  try {
    const donos = (
      db
        .prepare('SELECT workspace FROM acompanhamentos WHERE numero = ?')
        .all(numero) as Linha[]
    ).map((l) => String(l['workspace']));
    if (donos.length === 0) {
      amb.aviso('Nenhuma conta acompanha esse processo neste banco.');
      return 1;
    }
    let workspace = donos[0] ?? '';
    if (donos.length > 1) {
      if (!pedidoDeWorkspace) {
        amb.aviso(
          `Mais de uma conta acompanha esse processo (${donos.length}). Use --workspace=<identificador ou e-mail>.`,
        );
        return 1;
      }
      const w = resolverWorkspace(
        listarWorkspaces(db).filter((x) => donos.includes(x.id)),
        pedidoDeWorkspace,
      );
      if (!w) {
        amb.aviso('Esse workspace não acompanha o processo.');
        return 1;
      }
      workspace = w.id;
    }

    const colunas = new Set(
      (db.prepare('PRAGMA table_info(acompanhamentos)').all() as Linha[]).map((c) =>
        String(c['name']),
      ),
    );
    const temMarca = colunas.has('cumprido_chave');
    const linha = db
      .prepare(
        `SELECT sincronizado_em, processo${temMarca ? ', cumprido_chave, cumprido_ate, cumprido_em' : ''} FROM acompanhamentos WHERE workspace = ? AND numero = ?`,
      )
      .get(workspace, numero) as Linha | undefined;
    const bruto =
      linha && typeof linha['processo'] === 'string' ? linha['processo'] : null;
    if (!bruto) {
      amb.aviso(
        'O processo é acompanhado, mas ainda não tem retrato gravado (nenhuma sincronização).',
      );
      return 1;
    }
    const processo = reidratarProcesso(JSON.parse(bruto) as ProcessoSerializado, false);
    const data = (v: unknown): Date | null => {
      if (typeof v !== 'string' || v === '') return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const ate = temMarca ? data(linha?.['cumprido_ate']) : null;
    const em = temMarca ? data(linha?.['cumprido_em']) : null;
    const cumprido =
      ate && em && typeof linha?.['cumprido_chave'] === 'string'
        ? { chave: String(linha['cumprido_chave']), ate, em }
        : undefined;
    const agora = amb.agora();
    const sincronizadoEm = data(linha?.['sincronizado_em']);
    const d = diagnosticarResumo(
      processo.movimentacoes,
      agora,
      amb.janelaDePendenciaDias,
      cumprido,
    );
    const retrato = {
      idadeDaSincronizacaoEmDias: sincronizadoEm ? dias(sincronizadoEm, agora) : null,
      idadeDaConsultaEmDias: dias(processo.procedencia.consultadoEm, agora),
      fontes: processo.procedencia.provider,
    };

    const o = ORCAMENTO_DO_RESUMO;
    amb.saida(
      `Diagnóstico do resumo por IA (v${VERSAO_DO_DIAGNOSTICO_DO_RESUMO}) · ${agora.toISOString().slice(0, 10)} · só números`,
    );
    amb.saida(
      `Retrato da conta: sincronizado há ${retrato.idadeDaSincronizacaoEmDias ?? '—'} dia(s) · consulta às fontes há ${retrato.idadeDaConsultaEmDias} dia(s) · fontes: ${retrato.fontes}`,
    );
    amb.saida(
      `Atos no retrato: ${d.totalDeAtos} · com texto utilizável (contador do resumo, mínimo ${MINIMO_DE_CARACTERES_DO_TEXTO} caracteres): ${d.comTextoUtilizavel} · só título/sem texto: ${d.totalDeAtos - d.comTextoUtilizavel}`,
    );
    amb.saida(
      `Marcados "pede providência" (a regra do resumo, janela ${amb.janelaDePendenciaDias} dias): ${d.pedemProvidencia} · desses, sem texto utilizável: ${d.pedemProvidenciaSemTexto}`,
    );
    amb.saida(
      `Por fonte (total / com conteúdo / com texto utilizável): ${
        Object.entries(d.porFonte)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([f, g]) => `${f} ${g.total}/${g.comConteudo}/${g.comTexto}`)
          .join(' · ') || '—'
      }`,
    );
    amb.saida(
      `No mesmo dia do ato mais recente: ${d.mesmoDiaDoMaisRecente.total} ato(s), ${d.mesmoDiaDoMaisRecente.comTexto} com texto utilizável`,
    );
    amb.saida('');
    amb.saida('Os 5 atos mais recentes (posição 1 = o mais recente):');
    for (const a of d.maisRecentes) {
      amb.saida(
        `  #${a.posicao} · há ${a.idadeEmDias} dia(s) · tipo: ${a.classeDoTitulo} · fonte: ${a.fonte} · comunicação do Diário: ${a.tipoDaComunicacao}`,
      );
      amb.saida(
        `      campos (caracteres): título ${a.campos.titulo} · conteúdo ${a.campos.conteudo} · complementos ${a.campos.complementosItens} item(ns) / ${a.campos.complementosCaracteres} · corpo que o contador usa ${a.campos.corpoDoContador} (origem: ${a.campos.origemDoCorpo}) · teor indisponível: ${a.teorIndisponivel ? 'sim' : 'não'}`,
      );
      amb.saida(
        `      pede providência: ${a.pedeProvidencia ? `sim (${a.marcacao ?? '—'})` : 'não'} · texto utilizável: ${a.textoUtilizavel ? 'sim' : `não (${a.motivoSemTexto})`} · no resumo: ${a.noResumoComo}`,
      );
    }
    amb.saida('');
    amb.saida(
      `Seleção do resumo (limites: ${o.pendentesMax} providências, ${o.recentesMax} recentes com texto, ${o.titulosMax} títulos): ${d.selecao.comTexto} com texto (${d.selecao.porProvidencia} por providência, ${d.selecao.porRecencia} por recência) · ${d.selecao.soTitulo} só pelo título · ${d.selecao.foraDoResumo} fora`,
    );
    const q = d.selecao;
    amb.saida(
      `Ato mais recente (depois de juntar o só-título ao ato com texto do mesmo dia e tipo: ${q.mesclados} junção(ões)): ${q.maisRecenteLido === null ? '—' : q.maisRecenteLido ? 'texto LIDO' : 'texto NÃO lido'} · providências do sistema sem leitura: ${q.providenciasNaoLidas}`,
    );
    amb.saida(
      `Atos não lidos por motivo: teor indisponível ${q.naoLidosPorMotivo.teorIndisponivel} · sem texto ${q.naoLidosPorMotivo.semTexto} · abaixo de ${MINIMO_DE_CARACTERES_DO_TEXTO} caracteres ${q.naoLidosPorMotivo.abaixoDoMinimo} · fora do limite ${q.naoLidosPorMotivo.foraDoLimite}`,
    );
    return 0;
  } finally {
    db.close();
  }
}
