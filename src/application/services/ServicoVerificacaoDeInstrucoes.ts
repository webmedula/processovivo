import { ehFuncaoDeIa, type FuncaoDeIa } from '../../domain/entities/ControleDaIa.js';
import {
  normalizarInstrucao,
  problemaDoTexto,
} from '../../domain/entities/InstrucoesDeIa.js';
import { REGRAS_DE_PUBLICACAO } from '../../domain/entities/ModelosDeIa.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { ExecutorDaVerificacaoDeInstrucoes } from '../../domain/ports/InstrucoesDeIa.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type {
  EstimativaDoTeste,
  PrecoPorTokenDoModelo,
  RepositorioDeTestesDeModelo,
  TesteDeModelo,
} from '../../domain/ports/ModelosDeIa.js';
import { recusarInstrucao, type ServicoInstrucoesDeIa } from './ServicoInstrucoesDeIa.js';
import type { ServicoModelosDeIa } from './ServicoModelosDeIa.js';

export interface OpcoesDoServicoVerificacaoDeInstrucoes {
  /** `undefined` = sem chave do provedor: a verificação não está disponível (o resto do painel segue). */
  readonly executor: ExecutorDaVerificacaoDeInstrucoes | undefined;
  readonly instrucoes: ServicoInstrucoesDeIa;
  readonly modelos: Pick<ServicoModelosDeIa, 'efetivo' | 'catalogo'>;
  /** A MESMA tabela e o MESMO "um por vez" do teste de modelo da Fase B. */
  readonly testes: RepositorioDeTestesDeModelo;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly novoId: () => string;
  /** Padrão: o teto das regras (US$ 1,00 por rodada). */
  readonly tetoUsd?: number;
}

export interface EstimativaDaVerificacao extends EstimativaDoTeste {
  readonly funcao: FuncaoDeIa;
  readonly modelo: string;
  readonly tetoUsd: number;
  readonly acimaDoTeto: boolean;
}

/**
 * O "Rodar conjunto de verificação" das instruções (Fase C, v0.61.0): OPCIONAL e **sem bloquear** a
 * publicação. Roda o conjunto SINTÉTICO da função (o mesmo da Fase B) duas vezes no modelo em uso — com a
 * instrução publicada e com o rascunho — e guarda só números. É um job em segundo plano, com o estado no
 * banco (reaproveita `ia_testes_modelo`, então vale o "um por vez" e o `falhou/reiniciado` da Fase B), com
 * estimativa e confirmação antes de enviar e o teto de gasto da rodada. A ZDR é a de toda chamada: sem
 * confirmação na lista oficial, nada é enviado. Nunca é chamado por rota pública.
 */
export class ServicoVerificacaoDeInstrucoes {
  private readonly log: Logger;
  private readonly tetoUsd: number;
  private rodando:
    { readonly id: string; readonly controle: AbortController } | undefined;
  private ultimaTarefa: Promise<void> = Promise.resolve();

  constructor(private readonly o: OpcoesDoServicoVerificacaoDeInstrucoes) {
    this.log = o.logger.child({ servico: 'verificacao-de-instrucoes' });
    this.tetoUsd = o.tetoUsd ?? REGRAS_DE_PUBLICACAO.tetoDaRodadaUsd;
  }

  get disponivel(): boolean {
    return this.o.executor !== undefined;
  }

  get teto(): number {
    return this.tetoUsd;
  }

  estimar(funcao: string, texto?: string): EstimativaDaVerificacao {
    const { f, modelo } = this.validar(funcao, texto);
    const executor = this.exigirExecutor();
    const est = executor.estimarInstrucoes(f, modelo, this.precos(modelo));
    return {
      ...est,
      funcao: f,
      modelo,
      tetoUsd: this.tetoUsd,
      acimaDoTeto: est.custoEstimadoUsd !== null && est.custoEstimadoUsd > this.tetoUsd,
    };
  }

  iniciar(
    autor: string,
    funcao: string,
    texto: string | undefined,
    confirmado: boolean,
  ): TesteDeModelo {
    const { f, modelo } = this.validar(funcao, texto);
    const executor = this.exigirExecutor();
    if (!confirmado) throw recusarInstrucao('confirmacao_necessaria');
    if (this.rodando || this.o.testes.emAndamento()) {
      throw recusarInstrucao('verificacao_em_andamento');
    }
    const precos = this.precos(modelo);
    const est = executor.estimarInstrucoes(f, modelo, precos);
    if (est.custoEstimadoUsd !== null && est.custoEstimadoUsd > this.tetoUsd) {
      throw recusarInstrucao('estimativa_acima_do_teto');
    }
    const estado = this.o.instrucoes.estado(f);
    const publicada = this.o.instrucoes.efetiva(f);
    const rascunho = normalizarInstrucao(texto ?? estado.rascunho?.texto ?? '');
    const agora = this.o.clock.agora();
    const teste: TesteDeModelo = {
      id: this.o.novoId(),
      tipo: 'instrucoes',
      instrucaoVersao: estado.rascunho?.versao ?? 0,
      funcao: f,
      // Mesmo modelo nos dois lados: o que muda entre eles é a instrução.
      candidato: modelo,
      referencia: modelo,
      estado: 'na_fila',
      autor,
      criadoEm: agora,
      chamadasPrevistas: est.chamadas,
      chamadasFeitas: 0,
      estimativaUsd: est.custoEstimadoUsd,
      gastoUsd: null,
      bloqueios: [],
      ressalvas: [],
    };
    this.o.testes.criar(teste);
    const controle = new AbortController();
    this.rodando = { id: teste.id, controle };
    this.ultimaTarefa = this.executar(
      executor,
      teste,
      { publicada: publicada.texto, rascunho },
      precos,
      controle,
    ).catch(() => undefined);
    return teste;
  }

  consultar(id: string): TesteDeModelo {
    const t = this.o.testes.buscar(id);
    if (!t || t.tipo !== 'instrucoes')
      throw recusarInstrucao('verificacao_nao_encontrada');
    return t;
  }

  ultimaDaFuncao(funcao: FuncaoDeIa): TesteDeModelo | undefined {
    try {
      return this.o.testes.ultimoDeInstrucoes(funcao);
    } catch {
      return undefined;
    }
  }

  emAndamento(): TesteDeModelo | undefined {
    try {
      const t = this.o.testes.emAndamento();
      return t?.tipo === 'instrucoes' ? t : undefined;
    } catch {
      return undefined;
    }
  }

  cancelar(id: string): TesteDeModelo {
    const t = this.consultar(id);
    if (this.rodando?.id === id) this.rodando.controle.abort();
    return t;
  }

  /** Só para os testes: espera o segundo plano terminar. */
  async aguardarFim(): Promise<void> {
    await this.ultimaTarefa;
  }

  // --- internos ------------------------------------------------------------------------------------------------

  private validar(funcao: string, texto?: string): { f: FuncaoDeIa; modelo: string } {
    if (!ehFuncaoDeIa(funcao)) throw recusarInstrucao('funcao_desconhecida');
    if (
      texto !== undefined &&
      problemaDoTexto(texto, { exigirTexto: false }) === 'grande'
    ) {
      throw recusarInstrucao('texto_grande');
    }
    return { f: funcao, modelo: this.o.modelos.efetivo(funcao).modelo };
  }

  private exigirExecutor(): ExecutorDaVerificacaoDeInstrucoes {
    if (!this.o.executor) throw recusarInstrucao('verificacao_indisponivel');
    return this.o.executor;
  }

  private precos(modelo: string): Map<string, PrecoPorTokenDoModelo> {
    const m = new Map<string, PrecoPorTokenDoModelo>();
    const i = this.o.modelos.catalogo.buscar(modelo);
    if (i && i.precoEntradaPorMTokens !== null && i.precoSaidaPorMTokens !== null) {
      m.set(modelo, {
        entrada: i.precoEntradaPorMTokens / 1_000_000,
        saida: i.precoSaidaPorMTokens / 1_000_000,
      });
    }
    return m;
  }

  private async executar(
    executor: ExecutorDaVerificacaoDeInstrucoes,
    teste: TesteDeModelo,
    textos: { readonly publicada: string; readonly rascunho: string },
    precos: ReadonlyMap<string, PrecoPorTokenDoModelo>,
    controle: AbortController,
  ): Promise<void> {
    const agora = (): Date => this.o.clock.agora();
    let feitas = 0;
    try {
      this.o.testes.atualizar(teste.id, { estado: 'executando', iniciadoEm: agora() });
      const r = await executor.executarInstrucoes({
        funcao: teste.funcao,
        modelo: teste.candidato,
        publicada: textos.publicada,
        rascunho: textos.rascunho,
        tetoUsd: this.tetoUsd,
        precos,
        sinal: controle.signal,
        aoChamar: () => {
          feitas += 1;
          try {
            this.o.testes.atualizar(teste.id, { chamadasFeitas: feitas });
          } catch {
            /* o progresso é um favor; perder uma contagem não derruba a verificação */
          }
        },
      });
      if (controle.signal.aborted) {
        this.o.testes.atualizar(teste.id, { estado: 'cancelado', terminadoEm: agora() });
        return;
      }
      if (r.tipo === 'sem_zdr') {
        this.o.testes.atualizar(teste.id, {
          estado: 'concluido',
          terminadoEm: agora(),
          veredito: 'bloqueado',
          bloqueios: ['sem_zdr'],
        });
        return;
      }
      if (r.tipo === 'zdr_indisponivel') {
        this.o.testes.atualizar(teste.id, {
          estado: 'falhou',
          terminadoEm: agora(),
          falha: 'zdr_indisponivel',
        });
        return;
      }
      if (r.tetoAtingido) {
        this.o.testes.atualizar(teste.id, {
          estado: 'falhou',
          terminadoEm: agora(),
          falha: 'teto_de_gasto',
          gastoUsd: r.gastoUsd,
        });
        return;
      }
      // Só as métricas: o veredito de troca de modelo NÃO é gravado aqui — os avisos são calculados na hora
      // de mostrar (`avisosDePiora`) e nunca bloqueiam nada.
      this.o.testes.atualizar(teste.id, {
        estado: 'concluido',
        terminadoEm: agora(),
        gastoUsd: r.gastoUsd,
        metricasDoCandidato: r.candidato,
        metricasDaReferencia: r.referencia,
      });
    } catch {
      // Sem a mensagem do erro: ela pode trazer URL ou trecho de resposta. O fato basta.
      this.log.warn('verificação de instruções falhou', { funcao: teste.funcao });
      try {
        this.o.testes.atualizar(teste.id, {
          estado: controle.signal.aborted ? 'cancelado' : 'falhou',
          terminadoEm: agora(),
          ...(controle.signal.aborted ? {} : { falha: 'erro_interno' as const }),
        });
      } catch {
        /* nada mais a fazer */
      }
    } finally {
      this.rodando = undefined;
    }
  }
}
