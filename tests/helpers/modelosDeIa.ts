import {
  criarCatalogo,
  type CatalogoDeModelos,
  type ItemDoCatalogo,
  type MetricasDoModelo,
} from '../../src/domain/entities/ModelosDeIa.js';
import type {
  EstimativaDoTeste,
  ExecutorDoTesteDeModelo,
  PrecoPorTokenDoModelo,
  ResultadoDaExecucaoDoTeste,
} from '../../src/domain/ports/ModelosDeIa.js';
import type { FuncaoDeIa } from '../../src/domain/entities/ControleDaIa.js';

/** Ids SINTÉTICOS: nenhum modelo real entra nos testes da Fase B. */
export const ATUAL = 'fabrica-a/modelo-atual';
export const NOVO = 'fabrica-b/modelo-novo';
export const DESCONTINUADO = 'fabrica-c/modelo-velho';
export const SO_RESUMO = 'fabrica-d/so-resumo';
export const PENDENTE = 'fabrica-e/sem-confirmacao';

export function item(id: string, sobre: Partial<ItemDoCatalogo> = {}): ItemDoCatalogo {
  return {
    id,
    provedor: 'Provedor de Teste',
    apelido: `Apelido ${id.split('/')[1] ?? id}`,
    confirmacao: 'confirmada',
    zdrConfirmadoEm: '2026-10-20',
    zdrFonte: 'lista ZDR sintética de teste',
    precoEntradaPorMTokens: 0.2,
    precoSaidaPorMTokens: 0.4,
    janelaContexto: 128_000,
    funcoesPermitidas: ['ato', 'resumo', 'peca'],
    status: 'ativo',
    ...sobre,
  };
}

export function catalogoDeTeste(): CatalogoDeModelos {
  return criarCatalogo([
    item(ATUAL),
    item(NOVO),
    item(DESCONTINUADO, { status: 'descontinuado' }),
    item(SO_RESUMO, { funcoesPermitidas: ['resumo'] }),
    item(PENDENTE, {
      confirmacao: 'pendente',
      zdrConfirmadoEm: null,
      zdrFonte: null,
      precoEntradaPorMTokens: null,
      precoSaidaPorMTokens: null,
    }),
  ]);
}

/** Métricas "boas" de referência; cada teste muda só o que quer provar. */
export function metricas(sobre: Partial<MetricasDoModelo> = {}): MetricasDoModelo {
  return {
    modelo: ATUAL,
    chamadas: 50,
    respondidas: 50,
    citacaoVerificada: 0.98,
    pontosCobertos: 90,
    pontosTotais: 100,
    violacoes: 0,
    falhasDeFormato: 0,
    naoVerificadas: 0,
    chamadasComErro: 0,
    interrompido: false,
    latenciaP50Ms: 5_000,
    latenciaP95Ms: 10_000,
    custoMedioUsd: 0.001,
    custoP95Usd: 0.002,
    custoMaximoUsd: 0.003,
    custoTotalUsd: 0.05,
    fonteDoCusto: 'openrouter',
    ...sobre,
  };
}

/**
 * Executor dublê: nenhuma rede. `portao` segura a execução até o teste liberar (para provar "um por vez",
 * cancelamento e progresso); `chamar(n)` simula n chamadas ao modelo durante a execução.
 */
export class ExecutorFalso implements ExecutorDoTesteDeModelo {
  readonly estimativas: Array<{ funcao: FuncaoDeIa; modelos: readonly string[] }> = [];
  readonly execucoes: Array<{
    funcao: FuncaoDeIa;
    candidato: string;
    referencia: string;
    tetoUsd: number;
  }> = [];
  chamadas = 20;
  custoEstimadoUsd: number | null = 0.05;
  resultado: ResultadoDaExecucaoDoTeste = {
    tipo: 'ok',
    candidato: metricas({ modelo: NOVO }),
    referencia: metricas(),
    gastoUsd: 0.05,
    tetoAtingido: false,
  };
  portao: Promise<void> | undefined;
  chamarAntes = 0;
  falhar = false;

  estimar(
    funcao: FuncaoDeIa,
    modelos: readonly string[],
    _precos: ReadonlyMap<string, PrecoPorTokenDoModelo>,
  ): EstimativaDoTeste {
    this.estimativas.push({ funcao, modelos });
    return { chamadas: this.chamadas, custoEstimadoUsd: this.custoEstimadoUsd };
  }

  async executar(p: {
    funcao: FuncaoDeIa;
    candidato: string;
    referencia: string;
    tetoUsd: number;
    sinal: AbortSignal;
    aoChamar: () => void;
  }): Promise<ResultadoDaExecucaoDoTeste> {
    this.execucoes.push({
      funcao: p.funcao,
      candidato: p.candidato,
      referencia: p.referencia,
      tetoUsd: p.tetoUsd,
    });
    for (let i = 0; i < this.chamarAntes; i++) p.aoChamar();
    if (this.portao) await this.portao;
    if (this.falhar) throw new Error('falha interna com texto SEGREDO-NAO-VAZAR');
    return this.resultado;
  }
}
