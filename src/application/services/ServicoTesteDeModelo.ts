import { ehFuncaoDeIa, type FuncaoDeIa } from '../../domain/entities/ControleDaIa.js';
import {
  REGRAS_DE_PUBLICACAO,
  julgarTeste,
  podeSerCandidato,
} from '../../domain/entities/ModelosDeIa.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type {
  EstimativaDoTeste,
  ExecutorDoTesteDeModelo,
  MotivoDeFalhaDoTeste,
  PrecoPorTokenDoModelo,
  RepositorioDeModelosDeIa,
  RepositorioDeTestesDeModelo,
  TesteDeModelo,
} from '../../domain/ports/ModelosDeIa.js';
import { recusar, type ServicoModelosDeIa } from './ServicoModelosDeIa.js';

/** Frases FIXAS do motivo de um teste que falhou (a tela nunca mostra texto do servidor ou do provedor). */
export const FRASE_DA_FALHA_DO_TESTE: Readonly<Record<MotivoDeFalhaDoTeste, string>> =
  Object.freeze({
    teto_de_gasto:
      'O teste passou do teto de gasto da rodada e foi interrompido. Nenhum veredito foi dado.',
    reiniciado: 'O servidor reiniciou durante o teste. Refaça o teste.',
    zdr_indisponivel:
      'Não foi possível conferir a lista de provedores com retenção zero (ZDR). Nada foi enviado.',
    erro_interno: 'O teste falhou por um erro interno. Nada foi publicado.',
  });

export interface OpcoesDoServicoTesteDeModelo {
  /** `undefined` = sem chave do provedor: o teste não está disponível (publicar e reverter seguem). */
  readonly executor: ExecutorDoTesteDeModelo | undefined;
  readonly modelos: ServicoModelosDeIa;
  readonly testes: RepositorioDeTestesDeModelo;
  /** Só para o registro "teste iniciado" em `ia_alteracoes`. */
  readonly registro: Pick<RepositorioDeModelosDeIa, 'registrar'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly novoId: () => string;
  /** Padrão: o teto das regras (US$ 1,00 por rodada). */
  readonly tetoUsd?: number;
}

export interface EstimativaParaATela extends EstimativaDoTeste {
  readonly funcao: FuncaoDeIa;
  readonly candidato: string;
  readonly referencia: string;
  readonly tetoUsd: number;
  readonly acimaDoTeto: boolean;
}

/**
 * O teste obrigatório antes de trocar o modelo de uma função (v0.60.0, Fase B): um job em segundo
 * plano com o estado gravado no banco e consulta por polling. UM por vez no sistema inteiro; o botão
 * cancelar aborta as chamadas em voo; o reinício do servidor marca o que estava rodando como `falhou`
 * (nunca retoma sozinho). Roda o conjunto SINTÉTICO da função no candidato e no modelo atual, na mesma
 * rodada, pelo comparador (a lógica não é copiada). Só métricas são guardadas: nenhum texto de fixture
 * nem resposta do modelo. Nunca é chamado por rota pública: só pelo /admin.
 */
export class ServicoTesteDeModelo {
  private readonly log: Logger;
  private readonly tetoUsd: number;
  private rodando:
    { readonly id: string; readonly controle: AbortController } | undefined;
  /** A tarefa em segundo plano da última rodada (os testes esperam por ela; produção ignora). */
  private ultimaTarefa: Promise<void> = Promise.resolve();

  constructor(private readonly o: OpcoesDoServicoTesteDeModelo) {
    this.log = o.logger.child({ servico: 'teste-de-modelo' });
    this.tetoUsd = o.tetoUsd ?? REGRAS_DE_PUBLICACAO.tetoDaRodadaUsd;
  }

  get disponivel(): boolean {
    return this.o.executor !== undefined;
  }

  get teto(): number {
    return this.tetoUsd;
  }

  /** No arranque: o teste que estava rodando não retoma. Nunca lança. */
  recuperarNoArranque(): number {
    try {
      const n = this.o.testes.marcarInterrompidos(this.o.clock.agora());
      if (n > 0)
        this.log.warn(
          'testes de modelo interrompidos pelo reinício marcados como falhos',
          { n },
        );
      return n;
    } catch {
      this.log.warn('não foi possível marcar os testes de modelo interrompidos');
      return 0;
    }
  }

  /** Estimativa de chamadas e de custo, ANTES de enviar qualquer coisa (sem rede). */
  estimar(funcao: string, candidato: string): EstimativaParaATela {
    const { f, referencia } = this.validar(funcao, candidato);
    const executor = this.exigirExecutor();
    const est = executor.estimar(
      f,
      [referencia, candidato],
      this.precos(referencia, candidato),
    );
    return {
      ...est,
      funcao: f,
      candidato,
      referencia,
      tetoUsd: this.tetoUsd,
      acimaDoTeto: est.custoEstimadoUsd !== null && est.custoEstimadoUsd > this.tetoUsd,
    };
  }

  /** Cria o teste e o entrega ao segundo plano. Devolve na hora; a tela consulta o andamento. */
  iniciar(
    autor: string,
    funcao: string,
    candidato: string,
    confirmado: boolean,
  ): TesteDeModelo {
    const { f, referencia } = this.validar(funcao, candidato);
    const executor = this.exigirExecutor();
    if (!confirmado) throw recusar('confirmacao_necessaria');
    if (this.rodando || this.o.testes.emAndamento()) throw recusar('teste_em_andamento');
    const precos = this.precos(referencia, candidato);
    const est = executor.estimar(f, [referencia, candidato], precos);
    if (est.custoEstimadoUsd !== null && est.custoEstimadoUsd > this.tetoUsd) {
      throw recusar('estimativa_acima_do_teto');
    }
    const agora = this.o.clock.agora();
    const teste: TesteDeModelo = {
      id: this.o.novoId(),
      funcao: f,
      candidato,
      referencia,
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
    try {
      this.o.registro.registrar({
        em: agora,
        autor,
        funcao: f,
        tipo: 'teste_modelo_iniciado',
        anterior: referencia,
        novo: candidato,
        testeId: teste.id,
      });
    } catch {
      this.log.warn('registro do início do teste de modelo não gravado');
    }
    const controle = new AbortController();
    this.rodando = { id: teste.id, controle };
    this.ultimaTarefa = this.executar(executor, teste, precos, controle).catch(
      () => undefined,
    );
    return teste;
  }

  consultar(id: string): TesteDeModelo {
    const t = this.o.testes.buscar(id);
    if (!t) throw recusar('teste_nao_encontrado');
    return t;
  }

  ultimoDaFuncao(funcao: FuncaoDeIa): TesteDeModelo | undefined {
    try {
      return this.o.testes.ultimoDaFuncao(funcao);
    } catch {
      return undefined;
    }
  }

  emAndamento(): TesteDeModelo | undefined {
    try {
      const t = this.o.testes.emAndamento();
      // O conjunto de verificação das instruções (Fase C) divide a tabela e o "um por vez", mas é mostrado
      // na tela dele; aqui só aparece o teste de MODELO.
      return t?.tipo === 'instrucoes' ? undefined : t;
    } catch {
      return undefined;
    }
  }

  /** Cancela o teste em andamento. Quem executa marca `cancelado` ao parar. */
  cancelar(id: string): TesteDeModelo {
    const t = this.consultar(id);
    if (this.rodando?.id === id) this.rodando.controle.abort();
    return t;
  }

  /** Só para os testes: espera o segundo plano terminar. */
  async aguardarFim(): Promise<void> {
    await this.ultimaTarefa;
  }

  // --- internos ------------------------------------------------------------------------------------------

  private validar(
    funcao: string,
    candidato: string,
  ): { f: FuncaoDeIa; referencia: string } {
    if (!ehFuncaoDeIa(funcao)) throw recusar('funcao_desconhecida');
    // Id forjado, fora da lista, pendente, descontinuado ou de outra função: a MESMA recusa.
    if (!podeSerCandidato(this.o.modelos.catalogo.buscar(candidato), funcao)) {
      throw recusar('modelo_fora_da_lista');
    }
    const referencia = this.o.modelos.efetivo(funcao).modelo;
    if (candidato === referencia) throw recusar('modelo_igual_ao_atual');
    return { f: funcao, referencia };
  }

  private exigirExecutor(): ExecutorDoTesteDeModelo {
    if (!this.o.executor) throw recusar('teste_indisponivel');
    return this.o.executor;
  }

  /** US$ por token, a partir dos preços da lista (por milhão). O modelo atual pode ser item pendente. */
  private precos(...ids: string[]): Map<string, PrecoPorTokenDoModelo> {
    const m = new Map<string, PrecoPorTokenDoModelo>();
    for (const id of ids) {
      const i = this.o.modelos.catalogo.buscar(id);
      if (i && i.precoEntradaPorMTokens !== null && i.precoSaidaPorMTokens !== null) {
        m.set(id, {
          entrada: i.precoEntradaPorMTokens / 1_000_000,
          saida: i.precoSaidaPorMTokens / 1_000_000,
        });
      }
    }
    return m;
  }

  private async executar(
    executor: ExecutorDoTesteDeModelo,
    teste: TesteDeModelo,
    precos: ReadonlyMap<string, PrecoPorTokenDoModelo>,
    controle: AbortController,
  ): Promise<void> {
    const agora = (): Date => this.o.clock.agora();
    let feitas = 0;
    try {
      this.o.testes.atualizar(teste.id, { estado: 'executando', iniciadoEm: agora() });
      const r = await executor.executar({
        funcao: teste.funcao,
        candidato: teste.candidato,
        referencia: teste.referencia,
        tetoUsd: this.tetoUsd,
        precos,
        sinal: controle.signal,
        aoChamar: () => {
          feitas += 1;
          try {
            this.o.testes.atualizar(teste.id, { chamadasFeitas: feitas });
          } catch {
            /* o progresso é um favor; perder uma contagem não derruba o teste */
          }
        },
      });
      if (controle.signal.aborted) {
        this.o.testes.atualizar(teste.id, { estado: 'cancelado', terminadoEm: agora() });
        return;
      }
      if (r.tipo === 'sem_zdr') {
        // Nada foi enviado. É um bloqueio duro, não uma falha do teste: o veredito fica registrado.
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
      const v = julgarTeste(r.candidato, r.referencia);
      this.o.testes.atualizar(teste.id, {
        estado: 'concluido',
        terminadoEm: agora(),
        gastoUsd: r.gastoUsd,
        metricasDoCandidato: r.candidato,
        metricasDaReferencia: r.referencia,
        veredito: v.veredito,
        bloqueios: v.bloqueios,
        ressalvas: v.ressalvas,
      });
    } catch {
      // Sem a mensagem do erro: ela pode trazer URL ou trecho de resposta. O fato basta.
      this.log.warn('teste de modelo falhou', { funcao: teste.funcao });
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
