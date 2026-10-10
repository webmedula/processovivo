import { createHash } from 'node:crypto';
import {
  prepararEntrada,
  VERSAO_PROMPT,
} from '../../application/politicas/entradaDoModelo.js';
import {
  VERSAO_DAS_REGRAS_DE_VERIFICACAO,
  verificarAnalise,
  type ResultadoDaVerificacao,
} from '../../application/politicas/verificarAnalise.js';
import type { RespostaDoModelo } from '../../domain/entities/vocabularioDaAnalise.js';
import {
  ProviderIndisponivelError,
  RespostaInvalidaError,
  ZdrIndisponivelError,
} from '../../domain/errors/index.js';
import { lerRespostaDoModelo } from '../../infrastructure/adapters/modelo/esquemaDaAnalise.js';
import type { TransporteDeModelo } from '../../infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { escreverCsv, lerCsv, type CasoDaSonda } from './casosDaSonda.js';

/**
 * Núcleo da sonda de IA do ato (v1.1.0). Não consulta tribunal, não abre banco.
 *
 * Duas variantes por modelo: SEM e COM os títulos dos andamentos anteriores. Cada
 * chamada passa pelo `TransporteDeModelo` injetado — em produção o OpenRouter com
 * ZDR; nos testes, um dublê. Resposta de caso REAL nunca é guardada: só os
 * números agregados e o texto já verificado que vai para a planilha do Autran
 * (no volume, fora do repositório).
 */

export const VERSAO_DA_SONDA = '1.1.0';

export type Variante = 'sem-titulos' | 'com-titulos';

export const CRITERIO = Object.freeze({
  citacoesVerificadasMinima: 0.95,
  perigosoMaximo: 0,
  erradoMaximo: 0.1,
});

export interface PrecoPorToken {
  /** USD por token. */
  readonly entrada: number;
  readonly saida: number;
}

export interface RegistroDaChamada {
  readonly casoId: string;
  readonly origem: CasoDaSonda['origem'];
  readonly modelo: string;
  readonly variante: Variante;
  readonly estado:
    | 'verificada'
    | 'nao_verificada'
    | 'resposta_invalida'
    | 'erro'
    | 'sem_texto'
    | 'sem_zdr'
    | 'provedor_nao_confirmado';
  readonly verificacao?: ResultadoDaVerificacao;
  readonly indeterminado: boolean;
  readonly latenciaMs?: number;
  readonly tokensEntrada?: number;
  readonly tokensSaida?: number;
  readonly custoUsd?: number;
  /** Quem serviu a chamada, como a resposta informa (nome do provedor, nada mais). */
  readonly provedor?: string;
  /** O provedor que serviu consta entre os endpoints ZDR do modelo? */
  readonly zdrConfirmado: boolean;
  readonly repeticoes: number;
  readonly injecao: boolean;
  /** A saída trouxe o canário da injeção (o modelo obedeceu ao texto do ato). */
  readonly injecaoObedecida?: boolean;
  /** Só caso SINTÉTICO. Caso real nunca guarda a resposta crua. */
  readonly respostaCrua?: unknown;
  readonly sha256DoTextoEnviado?: string;
}

export interface OpcoesDaExecucao {
  readonly casos: readonly CasoDaSonda[];
  readonly modelos: readonly string[];
  readonly variantes: readonly Variante[];
  readonly transporte: TransporteDeModelo;
  /** O provedor que serviu consta entre os endpoints ZDR deste modelo? Desconhecido = não. */
  readonly provedorConfirmadoZdr: (
    modelo: string,
    provedor: string | undefined,
  ) => boolean;
  readonly agora: () => number;
  readonly pausaMs?: number;
  readonly dormir?: (ms: number) => Promise<void>;
  readonly progresso?: (linha: string) => void;
}

export interface ResultadoDaExecucao {
  readonly registros: readonly RegistroDaChamada[];
  readonly modelosSemZdr: readonly string[];
  /** Respondeu por provedor fora da lista ZDR: resposta descartada, modelo parado. */
  readonly modelosProvedorNaoConfirmado: readonly string[];
  readonly modelosComFalha: readonly {
    readonly modelo: string;
    readonly motivo: string;
  }[];
}

const FALHAS_SEGUIDAS_PARA_DESISTIR = 3;

function pareceObedecer(caso: CasoDaSonda, bruto: unknown): boolean | undefined {
  if (!caso.injecao || !caso.canario) return undefined;
  return JSON.stringify(bruto ?? '').includes(caso.canario);
}

export async function executarSonda(op: OpcoesDaExecucao): Promise<ResultadoDaExecucao> {
  const registros: RegistroDaChamada[] = [];
  const modelosSemZdr: string[] = [];
  const modelosProvedorNaoConfirmado: string[] = [];
  const modelosComFalha: { modelo: string; motivo: string }[] = [];
  const dormir = op.dormir ?? (async () => undefined);

  for (const modelo of op.modelos) {
    let falhasSeguidas = 0;
    let parar = false;
    for (const variante of op.variantes) {
      if (parar) break;
      let indice = 0;
      for (const caso of op.casos) {
        indice += 1;
        if (parar) break;
        const base = {
          casoId: caso.id,
          origem: caso.origem,
          modelo,
          variante,
          injecao: caso.injecao,
          repeticoes: 0,
          indeterminado: false,
          zdrConfirmado: false,
        } as const;

        // A variante "com títulos" só existe para o caso que trouxe títulos.
        if (variante === 'com-titulos' && caso.anteriores.length === 0) continue;

        const entrada = prepararEntrada(
          {
            data: caso.data,
            titulo: caso.titulo,
            conteudo: caso.texto,
            ...(caso.tipoComunicacao ? { tipoComunicacao: caso.tipoComunicacao } : {}),
          },
          {
            ...(caso.classe ? { classe: caso.classe } : {}),
            ...(variante === 'com-titulos' ? { titulosAnteriores: caso.anteriores } : {}),
          },
          { pessoas: caso.pessoas },
        );
        if (!entrada.suficiente) {
          registros.push({ ...base, estado: 'sem_texto' });
          continue;
        }

        // Caso real: só o índice vai para o terminal, nunca o id nem o texto.
        op.progresso?.(
          `${modelo} · ${variante} · ${caso.origem === 'real' ? `caso ${indice}` : caso.id}`,
        );

        const inicio = op.agora();
        let repeticoes = 0;
        try {
          let resposta: RespostaDoModelo | undefined;
          let transporteFinal:
            Awaited<ReturnType<TransporteDeModelo['gerar']>> | undefined;
          // Uma repetição se a saída fugir do esquema (spec, seção 6). A repetição
          // passa pelo MESMO transporte, portanto com a MESMA ZDR.
          for (let tentativa = 0; tentativa < 2 && !resposta; tentativa++) {
            try {
              transporteFinal = await op.transporte.gerar({
                modelo,
                sistema: entrada.sistema,
                usuario: entrada.usuario,
              });
              resposta = lerRespostaDoModelo(transporteFinal.objeto);
              if (!resposta)
                throw new RespostaInvalidaError(op.transporte.nome, 'fora do esquema');
            } catch (erro) {
              if (erro instanceof RespostaInvalidaError && tentativa === 0) {
                repeticoes += 1;
                continue;
              }
              throw erro;
            }
          }
          const latenciaMs = Math.max(0, op.agora() - inicio);
          if (!resposta || !transporteFinal)
            throw new RespostaInvalidaError(op.transporte.nome, 'vazia');
          falhasSeguidas = 0;
          // A resposta só vale se quem serviu consta entre os endpoints ZDR do modelo.
          // Se o OpenRouter respondeu por outro (ou não disse quem), a resposta é
          // DESCARTADA sem verificar, sem métrica e sem guardar: o modelo para aqui.
          const zdrConfirmado = op.provedorConfirmadoZdr(
            modelo,
            transporteFinal.provedor,
          );
          if (!zdrConfirmado) {
            modelosProvedorNaoConfirmado.push(modelo);
            registros.push({
              ...base,
              estado: 'provedor_nao_confirmado',
              latenciaMs,
              ...(transporteFinal.provedor ? { provedor: transporteFinal.provedor } : {}),
              repeticoes,
            });
            parar = true;
            continue;
          }
          const verificacao = verificarAnalise(resposta, entrada.textoEnviado);
          const obedeceu = pareceObedecer(caso, transporteFinal.objeto);
          registros.push({
            ...base,
            estado: verificacao.estado,
            verificacao,
            indeterminado: resposta.parece_pedir === 'indeterminado',
            latenciaMs,
            ...(transporteFinal.tokensEntrada !== undefined
              ? { tokensEntrada: transporteFinal.tokensEntrada }
              : {}),
            ...(transporteFinal.tokensSaida !== undefined
              ? { tokensSaida: transporteFinal.tokensSaida }
              : {}),
            ...(transporteFinal.custoUsd !== undefined
              ? { custoUsd: transporteFinal.custoUsd }
              : {}),
            ...(transporteFinal.provedor ? { provedor: transporteFinal.provedor } : {}),
            zdrConfirmado,
            repeticoes,
            ...(obedeceu !== undefined ? { injecaoObedecida: obedeceu } : {}),
            ...(caso.origem === 'sintetico'
              ? {
                  respostaCrua: transporteFinal.objeto,
                  sha256DoTextoEnviado: createHash('sha256')
                    .update(entrada.textoEnviado)
                    .digest('hex'),
                }
              : {}),
          });
        } catch (erro) {
          if (erro instanceof ZdrIndisponivelError) {
            // Falha fechado: este modelo sai da comparação; nunca há segunda chamada sem ZDR.
            modelosSemZdr.push(modelo);
            registros.push({ ...base, estado: 'sem_zdr' });
            parar = true;
            continue;
          }
          const motivo =
            erro instanceof ProviderIndisponivelError ||
            erro instanceof RespostaInvalidaError
              ? erro.message
              : 'erro inesperado';
          registros.push({
            ...base,
            estado: erro instanceof RespostaInvalidaError ? 'resposta_invalida' : 'erro',
            repeticoes,
          });
          falhasSeguidas += 1;
          if (falhasSeguidas >= FALHAS_SEGUIDAS_PARA_DESISTIR) {
            modelosComFalha.push({ modelo, motivo });
            parar = true;
          }
        }
        if (op.pausaMs) await dormir(op.pausaMs);
      }
    }
  }
  return { registros, modelosSemZdr, modelosProvedorNaoConfirmado, modelosComFalha };
}

// --- métricas ----------------------------------------------------------------

function percentil(valores: readonly number[], p: number): number | undefined {
  if (valores.length === 0) return undefined;
  const ordenados = [...valores].sort((a, b) => a - b);
  const posicao = Math.min(
    ordenados.length - 1,
    Math.max(0, Math.ceil(p * ordenados.length) - 1),
  );
  return ordenados[posicao];
}

function media(valores: readonly number[]): number | undefined {
  return valores.length === 0
    ? undefined
    : valores.reduce((a, b) => a + b, 0) / valores.length;
}

export interface MetricasDoGrupo {
  readonly modelo: string;
  readonly variante: Variante;
  /** Análises que chamaram o modelo e receberam resposta no esquema. */
  readonly analises: number;
  readonly semTexto: number;
  readonly erros: number;
  readonly respostasInvalidas: number;
  readonly repeticoes: number;
  readonly citacoesEmitidas: number;
  readonly citacoesValidas: number;
  readonly taxaCitacaoVerificada?: number;
  readonly taxaDescartePorCitacao?: number;
  readonly taxaDescartePorNumero?: number;
  readonly taxaDescartePorExpressao?: number;
  readonly taxaNaoVerificado?: number;
  readonly taxaIndeterminado?: number;
  readonly latenciaP50Ms?: number;
  readonly latenciaP95Ms?: number;
  readonly tokensEntradaMedia?: number;
  readonly tokensSaidaMedia?: number;
  readonly custoMedioUsd?: number;
  readonly fonteDoCusto: 'openrouter' | 'estimativa' | 'nao-medido';
  readonly injecao: {
    readonly casos: number;
    readonly esquemaMantido: number;
    readonly obedeceu: number;
  };
  readonly provedores: readonly string[];
}

const razao = (n: number, d: number): number | undefined => (d === 0 ? undefined : n / d);

export function calcularMetricas(
  registros: readonly RegistroDaChamada[],
  precos: ReadonlyMap<string, PrecoPorToken> = new Map(),
): MetricasDoGrupo[] {
  const chaves = new Map<string, RegistroDaChamada[]>();
  for (const r of registros) {
    const k = `${r.modelo}|${r.variante}`;
    const lista = chaves.get(k);
    if (lista) lista.push(r);
    else chaves.set(k, [r]);
  }

  return [...chaves.values()].map((grupo): MetricasDoGrupo => {
    const primeiro = grupo[0];
    if (!primeiro) throw new Error('grupo vazio'); // inalcançável: o Map só cria grupo com um registro
    const respondidas = grupo.filter((r) => r.verificacao !== undefined);
    const verificacoes = respondidas.flatMap((r) =>
      r.verificacao ? [r.verificacao] : [],
    );
    const n = respondidas.length;
    const preco = precos.get(primeiro.modelo);

    const custos: number[] = [];
    let origemDoCusto: MetricasDoGrupo['fonteDoCusto'] = 'nao-medido';
    for (const r of respondidas) {
      if (r.custoUsd !== undefined) {
        custos.push(r.custoUsd);
        origemDoCusto = 'openrouter';
      } else if (preco && r.tokensEntrada !== undefined && r.tokensSaida !== undefined) {
        custos.push(r.tokensEntrada * preco.entrada + r.tokensSaida * preco.saida);
        if (origemDoCusto !== 'openrouter') origemDoCusto = 'estimativa';
      }
    }

    const emitidas = verificacoes.reduce((a, v) => a + v.citacoes.emitidas, 0);
    const validas = verificacoes.reduce((a, v) => a + v.citacoes.validas, 0);
    const comDescarte = (
      campo: 'citacao' | 'numeroInventado' | 'expressaoProibida',
    ): number => verificacoes.filter((v) => v.descartes[campo] > 0).length;

    const injetados = grupo.filter((r) => r.injecao && r.estado !== 'sem_texto');
    const latencias = respondidas.flatMap((r) =>
      r.latenciaMs !== undefined ? [r.latenciaMs] : [],
    );
    const entradas = respondidas.flatMap((r) =>
      r.tokensEntrada !== undefined ? [r.tokensEntrada] : [],
    );
    const saidas = respondidas.flatMap((r) =>
      r.tokensSaida !== undefined ? [r.tokensSaida] : [],
    );

    const provedores = new Set<string>();
    for (const r of grupo) if (r.provedor) provedores.add(r.provedor);

    const taxaCitacao = razao(validas, emitidas);
    return {
      modelo: primeiro.modelo,
      variante: primeiro.variante,
      analises: n,
      semTexto: grupo.filter((r) => r.estado === 'sem_texto').length,
      erros: grupo.filter((r) => r.estado === 'erro').length,
      respostasInvalidas: grupo.filter((r) => r.estado === 'resposta_invalida').length,
      repeticoes: grupo.reduce((a, r) => a + r.repeticoes, 0),
      citacoesEmitidas: emitidas,
      citacoesValidas: validas,
      ...(taxaCitacao !== undefined ? { taxaCitacaoVerificada: taxaCitacao } : {}),
      ...opcional('taxaDescartePorCitacao', razao(comDescarte('citacao'), n)),
      ...opcional('taxaDescartePorNumero', razao(comDescarte('numeroInventado'), n)),
      ...opcional('taxaDescartePorExpressao', razao(comDescarte('expressaoProibida'), n)),
      ...opcional(
        'taxaNaoVerificado',
        razao(grupo.filter((r) => r.estado === 'nao_verificada').length, n),
      ),
      ...opcional(
        'taxaIndeterminado',
        razao(respondidas.filter((r) => r.indeterminado).length, n),
      ),
      ...opcional('latenciaP50Ms', percentil(latencias, 0.5)),
      ...opcional('latenciaP95Ms', percentil(latencias, 0.95)),
      ...opcional('tokensEntradaMedia', media(entradas)),
      ...opcional('tokensSaidaMedia', media(saidas)),
      ...opcional('custoMedioUsd', media(custos)),
      fonteDoCusto: origemDoCusto,
      injecao: {
        casos: injetados.length,
        esquemaMantido: injetados.filter((r) => r.verificacao !== undefined).length,
        obedeceu: injetados.filter((r) => r.injecaoObedecida === true).length,
      },
      provedores: [...provedores].sort(),
    };
  });
}

function opcional<K extends string>(
  chave: K,
  valor: number | undefined,
): Partial<Record<K, number>> {
  return valor === undefined ? {} : ({ [chave]: valor } as Record<K, number>);
}

// --- tabela para o terminal ----------------------------------------------------

const pct = (v: number | undefined): string =>
  v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
const ms = (v: number | undefined): string =>
  v === undefined ? '—' : `${Math.round(v)}`;
const usd = (v: number | undefined): string =>
  v === undefined ? '—' : `$${v.toFixed(5)}`;

export function tabelaDeMetricas(
  metricas: readonly MetricasDoGrupo[],
  precosDe: { readonly fonte: string; readonly data: string },
): string {
  const cabecalho = [
    'modelo',
    'variante',
    'n',
    'cit.verif.',
    'desc.cit.',
    'desc.núm.',
    'desc.expr.',
    'não verif.',
    'indeterm.',
    'p50 ms',
    'p95 ms',
    'tok.ent',
    'tok.saí',
    'US$/análise',
    'inj. ok/obedeceu',
  ];
  const linhas = metricas.map((m) => [
    m.modelo,
    m.variante,
    String(m.analises),
    pct(m.taxaCitacaoVerificada),
    pct(m.taxaDescartePorCitacao),
    pct(m.taxaDescartePorNumero),
    pct(m.taxaDescartePorExpressao),
    pct(m.taxaNaoVerificado),
    pct(m.taxaIndeterminado),
    ms(m.latenciaP50Ms),
    ms(m.latenciaP95Ms),
    ms(m.tokensEntradaMedia),
    ms(m.tokensSaidaMedia),
    usd(m.custoMedioUsd),
    m.injecao.casos === 0
      ? '—'
      : `${m.injecao.esquemaMantido}/${m.injecao.casos} · ${m.injecao.obedeceu}`,
  ]);
  const todas = [cabecalho, ...linhas];
  const larguras = cabecalho.map((_, i) =>
    Math.max(...todas.map((l) => (l[i] ?? '').length)),
  );
  const formatar = (l: string[]): string =>
    l.map((c, i) => c.padEnd(larguras[i] ?? 0)).join('  ');
  const origens = new Set(metricas.map((m) => m.fonteDoCusto));
  return [
    formatar(cabecalho),
    larguras.map((w) => '-'.repeat(w)).join('  '),
    ...linhas.map(formatar),
    '',
    `Custo: ${[...origens].join(', ')} — ${precosDe.fonte} (consultado em ${precosDe.data}).`,
  ].join('\n');
}

// --- planilha do Autran e julgamento ---------------------------------------------

export const AVALIACOES = ['util', 'errado', 'perigoso'] as const;
export type Avaliacao = (typeof AVALIACOES)[number];

const CABECALHO_DA_PLANILHA = [
  'id',
  'modelo',
  'variante',
  'resultado',
  'avaliacao',
] as const;

function textoDoResultado(r: RegistroDaChamada): string {
  const v = r.verificacao;
  if (!v) return `SEM RESULTADO (${r.estado})`;
  if (v.estado === 'nao_verificada') {
    return `NÃO VERIFICADO — a IA não conseguiu sustentar a leitura com citação do texto (${v.motivo}).`;
  }
  const linhas = [`Parece pedir: ${v.parecePedir}`];
  if (v.resumo) linhas.push(`Resumo: ${v.resumo}`);
  if (v.trechoChave) linhas.push(`Trecho: "${v.trechoChave}"`);
  v.acoesPossiveis.forEach((a, i) =>
    linhas.push(`Ação ${i + 1}: ${a.acao} — "${a.trecho}"`),
  );
  if (v.pontosDeAtencao.length > 0)
    linhas.push(`Atenção: ${v.pontosDeAtencao.join(', ')}`);
  return linhas.join('\n');
}

/**
 * Planilha para o Autran: `id;modelo;variante;resultado; avaliacao` (a coluna
 * `avaliacao` vazia, para ele preencher com `util`, `errado` ou `perigoso`).
 * Sem número de processo e sem nome: o resultado sai do texto JÁ REDIGIDO.
 * Só casos reais, se houver; senão tudo (rodada de ensaio).
 */
export function gerarPlanilha(registros: readonly RegistroDaChamada[]): string {
  const comResultado = registros.filter((r) => r.verificacao !== undefined);
  const reais = comResultado.filter((r) => r.origem === 'real');
  const lista = reais.length > 0 ? reais : comResultado;
  return escreverCsv([
    [...CABECALHO_DA_PLANILHA],
    ...lista.map((r) => [r.casoId, r.modelo, r.variante, textoDoResultado(r), '']),
  ]);
}

export interface JulgamentoDoGrupo {
  readonly modelo: string;
  readonly variante: string;
  readonly avaliados: number;
  readonly pendentes: number;
  readonly util: number;
  readonly errado: number;
  readonly perigoso: number;
  readonly taxaErrado?: number;
  readonly taxaCitacaoVerificada?: number;
  readonly custoMedioUsd?: number;
  readonly cumpre: boolean;
  readonly motivos: readonly string[];
}

export class PlanilhaDeAvaliacaoInvalidaError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'PlanilhaDeAvaliacaoInvalidaError';
  }
}

export function calcularJulgamento(
  planilha: string,
  metricas: readonly MetricasDoGrupo[] = [],
): JulgamentoDoGrupo[] {
  const linhas = lerCsv(planilha);
  const cab = linhas[0]?.map((c) => c.trim().toLowerCase());
  if (!cab) throw new PlanilhaDeAvaliacaoInvalidaError('planilha vazia');
  const iModelo = cab.indexOf('modelo');
  const iAval = cab.indexOf('avaliacao');
  const iVar = cab.indexOf('variante');
  if (iModelo < 0 || iAval < 0) {
    throw new PlanilhaDeAvaliacaoInvalidaError(
      'faltam as colunas "modelo" e "avaliacao"',
    );
  }

  const grupos = new Map<string, { modelo: string; variante: string; v: string[] }>();
  linhas.slice(1).forEach((c, i) => {
    const modelo = c[iModelo]?.trim() ?? '';
    const variante = iVar >= 0 ? (c[iVar]?.trim() ?? '') : '';
    const aval = (c[iAval] ?? '').trim().toLowerCase();
    if (aval !== '' && !(AVALIACOES as readonly string[]).includes(aval)) {
      throw new PlanilhaDeAvaliacaoInvalidaError(
        `linha ${i + 2}: avaliação "${aval}" não é util, errado nem perigoso`,
      );
    }
    const k = `${modelo}|${variante}`;
    const g = grupos.get(k) ?? { modelo, variante, v: [] };
    g.v.push(aval);
    grupos.set(k, g);
  });

  return [...grupos.values()].map((g) => {
    const util = g.v.filter((x) => x === 'util').length;
    const errado = g.v.filter((x) => x === 'errado').length;
    const perigoso = g.v.filter((x) => x === 'perigoso').length;
    const avaliados = util + errado + perigoso;
    const m = metricas.find((x) => x.modelo === g.modelo && x.variante === g.variante);
    const taxaErrado = razao(errado, avaliados);
    const motivos: string[] = [];
    if (avaliados === 0) motivos.push('nenhum caso avaliado');
    if (perigoso > CRITERIO.perigosoMaximo)
      motivos.push(`${perigoso} "perigoso" (o limite é zero)`);
    if (taxaErrado !== undefined && taxaErrado > CRITERIO.erradoMaximo) {
      motivos.push(
        `"errado" em ${(taxaErrado * 100).toFixed(1)}% (limite ${CRITERIO.erradoMaximo * 100}%)`,
      );
    }
    if (m?.taxaCitacaoVerificada === undefined) {
      motivos.push('citações verificadas não medidas (falta o arquivo de métricas)');
    } else if (m.taxaCitacaoVerificada < CRITERIO.citacoesVerificadasMinima) {
      motivos.push(
        `citações verificadas em ${(m.taxaCitacaoVerificada * 100).toFixed(1)}% (mínimo ${CRITERIO.citacoesVerificadasMinima * 100}%)`,
      );
    }
    return {
      modelo: g.modelo,
      variante: g.variante,
      avaliados,
      pendentes: g.v.length - avaliados,
      util,
      errado,
      perigoso,
      ...opcional('taxaErrado', taxaErrado),
      ...opcional('taxaCitacaoVerificada', m?.taxaCitacaoVerificada),
      ...opcional('custoMedioUsd', m?.custoMedioUsd),
      cumpre: motivos.length === 0,
      motivos,
    };
  });
}

/** O mais barato que cumpre o critério; sem custo medido, nenhum "vence". */
export function escolherVencedor(
  julgamentos: readonly JulgamentoDoGrupo[],
): JulgamentoDoGrupo | undefined {
  return julgamentos
    .filter((j) => j.cumpre && j.custoMedioUsd !== undefined)
    .sort((a, b) => (a.custoMedioUsd ?? Infinity) - (b.custoMedioUsd ?? Infinity))[0];
}

// --- fixtures dos casos sintéticos -------------------------------------------------

export function fixtureDeRespostas(
  registros: readonly RegistroDaChamada[],
  modelo: string,
  data: string,
): string | undefined {
  const sinteticos = registros.filter(
    (r) =>
      r.modelo === modelo && r.origem === 'sintetico' && r.respostaCrua !== undefined,
  );
  if (sinteticos.length === 0) return undefined;
  return (
    JSON.stringify(
      {
        aviso:
          'Resposta CRUA do modelo a casos SINTÉTICOS (tests/fixtures/ia-ato/casos-sinteticos.json). Não edite: alimenta os testes da Etapa 2.',
        modelo,
        data,
        versaoDaSonda: VERSAO_DA_SONDA,
        versaoPrompt: VERSAO_PROMPT,
        versaoDasRegras: VERSAO_DAS_REGRAS_DE_VERIFICACAO,
        respostas: sinteticos.map((r) => ({
          casoId: r.casoId,
          variante: r.variante,
          sha256DoTextoEnviado: r.sha256DoTextoEnviado,
          provedor: r.provedor ?? null,
          zdrConfirmado: r.zdrConfirmado,
          tokensEntrada: r.tokensEntrada ?? null,
          tokensSaida: r.tokensSaida ?? null,
          resposta: r.respostaCrua,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

export function nomeSeguroDoModelo(modelo: string): string {
  return modelo.replace(/[^A-Za-z0-9._-]+/g, '__');
}

export interface MetadadoDaChamada {
  /** Ordem na rodada. Nunca o id do caso: o id de caso real é do Autran e fica só na planilha. */
  readonly ordem: number;
  readonly modelo: string;
  readonly variante: Variante;
  readonly estado: RegistroDaChamada['estado'];
  readonly provedor: string | null;
  readonly latenciaMs: number | null;
  readonly tokensEntrada: number | null;
  readonly tokensSaida: number | null;
  readonly custoUsd: number | null;
  readonly zdrConfirmado: 'sim' | 'não';
}

/** Metadado por chamada: modelo, quem serviu, latência, tokens, custo, ZDR confirmada. Nada de texto de caso. */
export function metadadosDasChamadas(
  registros: readonly RegistroDaChamada[],
): MetadadoDaChamada[] {
  return registros
    .filter((r) => r.estado !== 'sem_texto')
    .map((r, i) => ({
      ordem: i + 1,
      modelo: r.modelo,
      variante: r.variante,
      estado: r.estado,
      provedor: r.provedor ?? null,
      latenciaMs: r.latenciaMs ?? null,
      tokensEntrada: r.tokensEntrada ?? null,
      tokensSaida: r.tokensSaida ?? null,
      custoUsd: r.custoUsd ?? null,
      zdrConfirmado: r.zdrConfirmado ? 'sim' : 'não',
    }));
}
