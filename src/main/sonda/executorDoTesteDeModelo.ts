import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSAO_PROMPT_DO_RESUMO } from '../../application/politicas/entradaDoResumo.js';
import { percentil, media } from '../../application/politicas/estatistica.js';
import type { FuncaoDeIa } from '../../domain/entities/ControleDaIa.js';
import type { MetricasDoModelo } from '../../domain/entities/ModelosDeIa.js';
import type {
  EstimativaDoTeste,
  ExecutorDoTesteDeModelo,
  PrecoPorTokenDoModelo,
  ResultadoDaExecucaoDoTeste,
} from '../../domain/ports/ModelosDeIa.js';
import {
  modeloTemZdr,
  parConfirmadoZdr,
  provedoresPermitidos,
  type EndpointZdr,
} from '../../infrastructure/adapters/modelo/endpointsZdr.js';
import type {
  PedidoAoModelo,
  RespostaDoTransporte,
  TransporteDeModelo,
} from '../../infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { lerCasosDeAvaliacao } from './casosDeAvaliacao.js';
import { lerCasosDePecas } from './casosDePecas.js';
import { lerCasosDeResumo } from './casosDeResumo.js';
import {
  TransporteComTeto,
  compararModelos,
  custoDoRegistro,
  estimarCusto,
} from './comparadorDeModelos.js';
import { compararPecas, estimarCustoDePecas } from './comparadorDePecas.js';
import { compararResumos, estimarCustoDeResumo } from './comparadorDeResumo.js';
import type { RegistroDaChamada } from './sondaIaAto.js';

/**
 * O executor do teste obrigatório de modelo do painel de IA (v0.60.0). NÃO tem lógica de comparação
 * própria: roda os comparadores que já existiam (`compararModelos`, `compararPecas`, `compararResumos`,
 * sobre `executarSonda`: ZDR por chamada, `provider.only`, par modelo + provedor conferido na resposta,
 * repetição única fora do esquema, parada por falhas seguidas) e só NORMALIZA o resultado das três
 * funções numa forma única de números (`MetricasDoModelo`). Os conjuntos são os SINTÉTICOS do repositório
 * (`tests/fixtures/ia-*`, copiados para a imagem). Nenhum texto de caso ou de resposta sai daqui.
 */

export const CAMINHOS_DOS_CONJUNTOS: Readonly<Record<FuncaoDeIa, string>> = Object.freeze(
  {
    ato: 'ia-avaliacao/casos.json',
    peca: 'ia-pecas/casos.json',
    resumo: 'ia-resumo/casos.json',
  },
);

export interface OpcoesDoExecutorDoTesteDeModelo {
  /** Pasta `tests/fixtures` (no contêiner, `/app/tests/fixtures`). */
  readonly pastaDosConjuntos: string;
  /** Lê a lista de endpoints ZDR do provedor. Lança se não alcançar (então nada é enviado). */
  readonly buscarListaZdr: () => Promise<readonly EndpointZdr[]>;
  /** O transporte real (ZDR em toda chamada). Em teste, um falso. */
  readonly criarTransporte: () => TransporteDeModelo;
  readonly agora: () => number;
  readonly dormir?: (ms: number) => Promise<void>;
  /** Para teste: lê o conjunto de outro lugar. */
  readonly lerArquivo?: (caminho: string) => string;
}

/** Conta cada chamada e honra o cancelamento: depois do abort nenhuma chamada nova sai. */
class TransporteDoTeste implements TransporteDeModelo {
  readonly nome: string;

  constructor(
    private readonly interno: TransporteDeModelo,
    private readonly sinal: AbortSignal,
    private readonly aoChamar: () => void,
  ) {
    this.nome = interno.nome;
  }

  async gerar(pedido: PedidoAoModelo): Promise<RespostaDoTransporte> {
    if (this.sinal.aborted) throw new Error('teste cancelado');
    this.aoChamar();
    const sinal = pedido.sinal ? AbortSignal.any([pedido.sinal, this.sinal]) : this.sinal;
    return this.interno.gerar({ ...pedido, sinal });
  }
}

const ESTADOS_DE_ERRO: ReadonlyArray<RegistroDaChamada['estado']> = [
  'erro',
  'sem_zdr',
  'sem_provedor',
  'provedor_nao_confirmado',
];

interface DaFuncao {
  readonly citacaoVerificada: number | null;
  readonly pontosCobertos: number;
  readonly pontosTotais: number;
  readonly violacoes: number;
  readonly interrompido: boolean;
}

/** As partes comuns (chamadas, formato, latência, custo) saem dos registros, iguais nas três funções. */
function normalizar(
  modelo: string,
  registros: readonly RegistroDaChamada[],
  precos: ReadonlyMap<string, PrecoPorTokenDoModelo>,
  d: DaFuncao,
): MetricasDoModelo {
  const regs = registros.filter((r) => r.modelo === modelo);
  const feitas = regs.filter((r) => r.estado !== 'sem_texto');
  const respondidas = feitas.filter(
    (r) => r.estado === 'verificada' || r.estado === 'nao_verificada',
  );
  const custos = respondidas.flatMap((r) => {
    const c = custoDoRegistro(r, precos);
    return c ? [c] : [];
  });
  const valores = custos.map((c) => c.valor);
  const latencias = respondidas.flatMap((r) =>
    r.latenciaMs !== undefined ? [r.latenciaMs] : [],
  );
  const ou = (v: number | undefined): number | null => (v === undefined ? null : v);
  return {
    modelo,
    chamadas: feitas.length,
    respondidas: respondidas.length,
    citacaoVerificada: d.citacaoVerificada,
    pontosCobertos: d.pontosCobertos,
    pontosTotais: d.pontosTotais,
    violacoes: d.violacoes,
    falhasDeFormato: feitas.filter((r) => r.estado === 'resposta_invalida').length,
    naoVerificadas: feitas.filter((r) => r.estado === 'nao_verificada').length,
    chamadasComErro: feitas.filter((r) => ESTADOS_DE_ERRO.includes(r.estado)).length,
    interrompido: d.interrompido,
    latenciaP50Ms: ou(percentil(latencias, 0.5)),
    latenciaP95Ms: ou(percentil(latencias, 0.95)),
    custoMedioUsd: ou(media(valores)),
    custoP95Usd: ou(percentil(valores, 0.95)),
    custoMaximoUsd: valores.length > 0 ? Math.max(...valores) : null,
    custoTotalUsd: valores.length > 0 ? valores.reduce((a, b) => a + b, 0) : null,
    fonteDoCusto: custos.some((c) => c.fonte === 'openrouter')
      ? 'openrouter'
      : custos.length > 0
        ? 'estimativa'
        : 'nao-medido',
  };
}

export class ExecutorDoTesteDeModeloComSonda implements ExecutorDoTesteDeModelo {
  constructor(private readonly o: OpcoesDoExecutorDoTesteDeModelo) {}

  private conjunto(funcao: FuncaoDeIa): string {
    const ler = this.o.lerArquivo ?? ((c: string) => readFileSync(c, 'utf8'));
    return ler(join(this.o.pastaDosConjuntos, CAMINHOS_DOS_CONJUNTOS[funcao]));
  }

  estimar(
    funcao: FuncaoDeIa,
    modelos: readonly string[],
    precos: ReadonlyMap<string, PrecoPorTokenDoModelo>,
  ): EstimativaDoTeste {
    const json = this.conjunto(funcao);
    const porModelo =
      funcao === 'ato'
        ? estimarCusto(lerCasosDeAvaliacao(json), modelos, precos)
        : funcao === 'peca'
          ? estimarCustoDePecas(lerCasosDePecas(json), modelos, precos, true)
          : estimarCustoDeResumo(
              lerCasosDeResumo(json),
              [VERSAO_PROMPT_DO_RESUMO],
              modelos,
              precos,
            );
    const semPreco = porModelo.some((e) => e.custoEstimadoUsd === undefined);
    return {
      chamadas: porModelo.reduce((a, e) => a + e.chamadas, 0),
      custoEstimadoUsd: semPreco
        ? null
        : porModelo.reduce((a, e) => a + (e.custoEstimadoUsd ?? 0), 0),
    };
  }

  async executar(p: {
    readonly funcao: FuncaoDeIa;
    readonly candidato: string;
    readonly referencia: string;
    readonly tetoUsd: number;
    readonly precos: ReadonlyMap<string, PrecoPorTokenDoModelo>;
    readonly sinal: AbortSignal;
    readonly aoChamar: () => void;
  }): Promise<ResultadoDaExecucaoDoTeste> {
    // ZDR primeiro e sem exceção: sem a lista, ou sem ZDR em qualquer dos dois, NADA é enviado.
    let lista: readonly EndpointZdr[];
    try {
      lista = await this.o.buscarListaZdr();
    } catch {
      return { tipo: 'zdr_indisponivel' };
    }
    if (!modeloTemZdr(lista, p.candidato) || !modeloTemZdr(lista, p.referencia)) {
      return { tipo: 'sem_zdr' };
    }

    const json = this.conjunto(p.funcao);
    const modelos = [p.referencia, p.candidato];
    const transporte = new TransporteComTeto(
      new TransporteDoTeste(this.o.criarTransporte(), p.sinal, p.aoChamar),
      p.tetoUsd,
      p.precos,
    );
    const comum = {
      modeloDeReferencia: p.referencia,
      modelos,
      transporte,
      teto: transporte,
      provedoresPermitidos: (m: string) => provedoresPermitidos(lista, m),
      parConfirmadoZdr: (r: string | undefined, prov: string | undefined) =>
        parConfirmadoZdr(lista, r, prov),
      precos: p.precos,
      agora: this.o.agora,
      ...(this.o.dormir ? { dormir: this.o.dormir } : {}),
    };

    const daLinha = (
      registros: readonly RegistroDaChamada[],
      modelo: string,
      f: DaFuncao,
    ): MetricasDoModelo => normalizar(modelo, registros, p.precos, f);

    if (p.funcao === 'ato') {
      const r = await compararModelos({ ...comum, casos: lerCasosDeAvaliacao(json) });
      const dele = (m: string): MetricasDoModelo => {
        const l = r.linhas.find((x) => x.modelo === m);
        return daLinha(r.registros, m, {
          citacaoVerificada: l?.citacaoVerificada ?? null,
          pontosCobertos: l?.pontosCobertos ?? 0,
          pontosTotais: l?.pontosTotais ?? 0,
          violacoes: l?.totalViolacoes ?? 0,
          interrompido: l?.interrompido ?? true,
        });
      };
      return {
        tipo: 'ok',
        candidato: dele(p.candidato),
        referencia: dele(p.referencia),
        gastoUsd: r.gastoUsd,
        tetoAtingido: r.tetoAtingido,
      };
    }

    if (p.funcao === 'peca') {
      const r = await compararPecas({
        ...comum,
        casos: lerCasosDePecas(json),
        entradaDeProducao: true,
      });
      const dele = (m: string): MetricasDoModelo => {
        const l = r.linhas.find((x) => x.modelo === m);
        return daLinha(r.registros, m, {
          citacaoVerificada: l?.citacaoVerificada ?? null,
          pontosCobertos: l?.pontosAchados ?? 0,
          pontosTotais: l?.pontosTotais ?? 0,
          violacoes: l?.totalViolacoes ?? 0,
          interrompido: l?.interrompido ?? true,
        });
      };
      return {
        tipo: 'ok',
        candidato: dele(p.candidato),
        referencia: dele(p.referencia),
        gastoUsd: r.gastoUsd,
        tetoAtingido: r.tetoAtingido,
      };
    }

    // Resumo: a versão do prompt de PRODUÇÃO. Não há "citação" por si só: a taxa é a dos itens que
    // passaram na verificação (situação + pendências mantidas ÷ mantidas + descartadas).
    const r = await compararResumos({
      ...comum,
      casos: lerCasosDeResumo(json),
      versoes: [VERSAO_PROMPT_DO_RESUMO],
    });
    const dele = (m: string): MetricasDoModelo => {
      const l = r.linhas.find((x) => x.modelo === m);
      const detalhes = r.detalhes.filter((x) => x.modelo === m);
      const mantidos = detalhes.reduce(
        (a, x) => a + x.situacao.length + x.pendencias.length,
        0,
      );
      const descartados = l?.descartes ?? 0;
      return daLinha(r.registros, m, {
        citacaoVerificada:
          mantidos + descartados > 0 ? mantidos / (mantidos + descartados) : null,
        pontosCobertos: l?.pontosCobertos ?? 0,
        pontosTotais: l?.pontosTotais ?? 0,
        violacoes: l?.violacoes ?? 0,
        interrompido: l?.interrompido ?? true,
      });
    };
    return {
      tipo: 'ok',
      candidato: dele(p.candidato),
      referencia: dele(p.referencia),
      gastoUsd: r.gastoUsd,
      tetoAtingido: r.tetoAtingido,
    };
  }
}
