import { ehFuncaoDeIa, type FuncaoDeIa } from '../../domain/entities/ControleDaIa.js';
import {
  MOTIVOS_DE_APROVACAO,
  PALAVRA_DE_CONFIRMACAO,
  REGRAS_DE_PUBLICACAO,
  julgarTeste,
  observacaoValida,
  podeSerCandidato,
  resolverModelo,
  type CatalogoDeModelos,
  type ItemDoCatalogo,
  type ModeloEfetivo,
  type MotivoDeAprovacao,
  type Veredito,
} from '../../domain/entities/ModelosDeIa.js';
import {
  ModeloDeIaRecusadoError,
  type MotivoDeModeloDeIaRecusado,
} from '../../domain/errors/index.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Logger } from '../../domain/ports/Logger.js';
import {
  type ModelosGravados,
  type RepositorioDeModelosDeIa,
  type RepositorioDeTestesDeModelo,
  type TesteDeModelo,
} from '../../domain/ports/ModelosDeIa.js';
import {
  SEM_REGISTRO_DE_OCORRENCIAS,
  type LeitorDeUsoDeIa,
  type RegistroDeOcorrenciasDeIa,
} from '../../domain/ports/PainelDeIa.js';

/** As frases são NOSSAS e fixas: nunca repetem o que o operador enviou (nem um id forjado). */
export const MENSAGEM_DO_MODELO_RECUSADO: Readonly<
  Record<MotivoDeModeloDeIaRecusado, string>
> = Object.freeze({
  funcao_desconhecida: 'Função de IA desconhecida.',
  modelo_fora_da_lista:
    'Este modelo não está na lista de modelos permitidos para esta função.',
  modelo_igual_ao_atual: 'Este já é o modelo em uso nesta função.',
  teste_em_andamento: 'Já existe um teste em andamento. Espere terminar ou cancele.',
  teste_indisponivel: 'O teste de modelo não está disponível neste servidor.',
  estimativa_acima_do_teto:
    'A estimativa de custo passa do teto da rodada. Nada foi enviado.',
  confirmacao_necessaria: 'Esta ação pede confirmação.',
  teste_nao_encontrado: 'Teste não encontrado.',
  teste_nao_concluido: 'O teste não terminou.',
  teste_de_outro_modelo: 'Este teste é de outra função ou de outro modelo.',
  teste_antigo: 'O teste tem mais de 24 horas. Faça um teste novo.',
  modelo_atual_mudou: 'O modelo em uso mudou depois do teste. Faça um teste novo.',
  veredito_bloqueado: 'O teste foi bloqueado. Este modelo não pode ser publicado.',
  ressalva_exige_aprovacao:
    'Este teste tem ressalvas: digite a confirmação e escolha um motivo para publicar.',
  aprovacao_invalida: 'A confirmação digitada, o motivo ou a observação não são válidos.',
  sem_modelo_anterior: 'Não há modelo anterior para voltar.',
  modelo_anterior_indisponivel:
    'O modelo anterior não está mais na lista de modelos permitidos.',
});

export function recusar(motivo: MotivoDeModeloDeIaRecusado): ModeloDeIaRecusadoError {
  return new ModeloDeIaRecusadoError(motivo, MENSAGEM_DO_MODELO_RECUSADO[motivo]);
}

export interface PedidoDePublicacao {
  readonly testeId: string;
  readonly confirmado: boolean;
  /** A palavra digitada (só exigida quando o teste tem ressalvas). */
  readonly palavra?: string;
  readonly motivo?: string;
  readonly observacao?: string;
}

export interface OpcoesDoServicoModelosDeIa {
  readonly repositorio: RepositorioDeModelosDeIa;
  readonly testes: RepositorioDeTestesDeModelo;
  readonly catalogo: CatalogoDeModelos;
  /** O modelo que o AMBIENTE (variáveis, com o padrão do código) manda usar em cada função. */
  readonly doAmbiente: Readonly<Record<FuncaoDeIa, string>>;
  readonly leitor: Pick<LeitorDeUsoDeIa, 'linhas'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ocorrencias?: RegistroDeOcorrenciasDeIa;
  readonly validadeDoCacheMs?: number;
}

const VALIDADE_PADRAO_MS = 5_000;
const AVISO_DE_FALHA_A_CADA_MS = 60_000;
const SEM_MODELO_GRAVADO: ModelosGravados = Object.freeze({
  ato: Object.freeze({ modelo: null, anterior: null, desde: null }),
  resumo: Object.freeze({ modelo: null, anterior: null, desde: null }),
  peca: Object.freeze({ modelo: null, anterior: null, desde: null }),
});

export type SituacaoDaPublicacao =
  | { readonly pode: true; readonly veredito: Veredito; readonly exigeAprovacao: boolean }
  | { readonly pode: false; readonly motivo: MotivoDeModeloDeIaRecusado };

/**
 * O modelo de cada função (v0.60.0, Fase B). **Precedência: painel (se válido, na lista e ativo) →
 * ambiente → padrão do código** (o ambiente já traz o padrão). Falha segura: leitura do banco que
 * falha devolve o ambiente, sem lançar; modelo do painel que saiu da lista cai no ambiente e conta uma
 * ocorrência. Publicar exige um teste válido do MESMO par função + candidato; reverter volta ao modelo
 * anterior, sem novo teste. Nada aqui toca em ZDR: ele é aplicado pelo adaptador em toda chamada.
 */
export class ServicoModelosDeIa {
  private cache: { readonly gravados: ModelosGravados; readonly ate: number } | undefined;
  private ultimoAvisoDeFalhaEm = Number.NEGATIVE_INFINITY;
  private readonly log: Logger;
  private readonly ocorrencias: RegistroDeOcorrenciasDeIa;

  constructor(private readonly o: OpcoesDoServicoModelosDeIa) {
    this.log = o.logger.child({ servico: 'modelos-de-ia' });
    this.ocorrencias = o.ocorrencias ?? SEM_REGISTRO_DE_OCORRENCIAS;
  }

  get catalogo(): CatalogoDeModelos {
    return this.o.catalogo;
  }

  /** O que o painel guarda (cache curto; falha = nada guardado = vale o ambiente). Nunca lança. */
  gravados(): ModelosGravados {
    const agora = this.o.clock.monotonico();
    if (this.cache && agora < this.cache.ate) return this.cache.gravados;
    let gravados: ModelosGravados;
    try {
      gravados = this.o.repositorio.ler();
    } catch {
      if (agora - this.ultimoAvisoDeFalhaEm >= AVISO_DE_FALHA_A_CADA_MS) {
        this.ultimoAvisoDeFalhaEm = agora;
        this.log.warn('modelos do painel de IA indisponíveis: vale o modelo do ambiente');
      }
      gravados = SEM_MODELO_GRAVADO;
    }
    this.cache = {
      gravados,
      ate: agora + (this.o.validadeDoCacheMs ?? VALIDADE_PADRAO_MS),
    };
    return gravados;
  }

  /** O modelo efetivo para mostrar na tela (não conta ocorrência). */
  efetivo(funcao: FuncaoDeIa): ModeloEfetivo {
    return resolverModelo(
      funcao,
      this.gravados()[funcao].modelo,
      this.o.doAmbiente[funcao],
      this.o.catalogo,
    );
  }

  /**
   * O modelo de uma CHAMADA: o mesmo `efetivo`, e, se o painel guarda um modelo que deixou de valer,
   * conta uma ocorrência (a chamada segue pelo ambiente, sem erro).
   */
  modeloParaChamada(funcao: FuncaoDeIa): string {
    const e = this.efetivo(funcao);
    if (e.painelInvalido) this.ocorrencias.registrar(funcao, 'modelo_do_painel_invalido');
    return e.modelo;
  }

  // --- leitura para a tela -----------------------------------------------------------------------------

  /** Análises da função nos últimos 30 dias (base do impacto estimado por dia). */
  volumeRecente(funcao: FuncaoDeIa): number {
    try {
      const desde = new Date(
        this.o.clock.agora().getTime() - REGRAS_DE_PUBLICACAO.diasDeVolume * 86_400_000,
      );
      return this.o.leitor.linhas(funcao, desde).length;
    } catch {
      return 0;
    }
  }

  candidatos(funcao: FuncaoDeIa): readonly ItemDoCatalogo[] {
    const atual = this.efetivo(funcao).modelo;
    return this.o.catalogo
      .todos()
      .filter((i) => podeSerCandidato(i, funcao) && i.id !== atual);
  }

  /** O teste está em condições de publicar? É a MESMA conferência que `publicar` faz. */
  situacaoDaPublicacao(
    funcao: FuncaoDeIa,
    teste: TesteDeModelo | undefined,
  ): SituacaoDaPublicacao {
    if (!teste) return { pode: false, motivo: 'teste_nao_encontrado' };
    if (teste.funcao !== funcao) return { pode: false, motivo: 'teste_de_outro_modelo' };
    if (teste.estado !== 'concluido')
      return { pode: false, motivo: 'teste_nao_concluido' };
    if (!podeSerCandidato(this.o.catalogo.buscar(teste.candidato), funcao)) {
      return { pode: false, motivo: 'modelo_fora_da_lista' };
    }
    const atual = this.efetivo(funcao).modelo;
    if (teste.candidato === atual)
      return { pode: false, motivo: 'modelo_igual_ao_atual' };
    const fim = teste.terminadoEm;
    const idade = fim
      ? this.o.clock.agora().getTime() - fim.getTime()
      : Number.POSITIVE_INFINITY;
    if (idade > REGRAS_DE_PUBLICACAO.validadeDoTesteHoras * 3_600_000) {
      return { pode: false, motivo: 'teste_antigo' };
    }
    if (teste.referencia !== atual) return { pode: false, motivo: 'modelo_atual_mudou' };
    // O veredito é recalculado das métricas guardadas: um valor gravado a mais nunca afrouxa a regra.
    const mc = teste.metricasDoCandidato;
    const mr = teste.metricasDaReferencia;
    const veredito: Veredito =
      mc && mr ? julgarTeste(mc, mr).veredito : (teste.veredito ?? 'bloqueado');
    if (veredito === 'bloqueado') return { pode: false, motivo: 'veredito_bloqueado' };
    return { pode: true, veredito, exigeAprovacao: veredito === 'aprovado_com_ressalva' };
  }

  podeReverter(funcao: FuncaoDeIa): boolean {
    try {
      return this.verificarReversao(funcao) !== undefined;
    } catch {
      return false;
    }
  }

  // --- mudanças (só pelo /admin) ------------------------------------------------------------------------

  publicar(autor: string, funcao: string, pedido: PedidoDePublicacao): void {
    const f = this.funcao(funcao);
    if (!pedido.confirmado) throw recusar('confirmacao_necessaria');
    this.cache = undefined;
    const teste = this.o.testes.buscar(pedido.testeId);
    const s = this.situacaoDaPublicacao(f, teste);
    if (!s.pode) throw recusar(s.motivo);
    if (!teste) throw recusar('teste_nao_encontrado');

    let aprovacao: string | undefined;
    if (s.exigeAprovacao) {
      if (pedido.palavra === undefined && pedido.motivo === undefined) {
        throw recusar('ressalva_exige_aprovacao');
      }
      const motivo = pedido.motivo;
      const observacao = (pedido.observacao ?? '').trim();
      if (
        pedido.palavra?.trim() !== PALAVRA_DE_CONFIRMACAO ||
        motivo === undefined ||
        !(MOTIVOS_DE_APROVACAO as readonly string[]).includes(motivo) ||
        !observacaoValida(observacao)
      ) {
        throw recusar('aprovacao_invalida');
      }
      aprovacao = observacao ? `${motivo as MotivoDeAprovacao}: ${observacao}` : motivo;
    }

    const anterior = this.efetivo(f).modelo;
    const agora = this.o.clock.agora();
    this.o.repositorio.publicar(f, teste.candidato, anterior, agora, {
      em: agora,
      autor,
      funcao: f,
      tipo: 'modelo_publicado',
      anterior,
      novo: teste.candidato,
      testeId: teste.id,
      ...(aprovacao ? { aprovacao } : {}),
    });
    this.cache = undefined;
    this.log.info('modelo de IA publicado', { autor, funcao: f, novo: teste.candidato });
  }

  reverter(autor: string, funcao: string, confirmado: boolean): void {
    const f = this.funcao(funcao);
    if (!confirmado) throw recusar('confirmacao_necessaria');
    this.cache = undefined;
    const alvo = this.verificarReversao(f);
    if (!alvo) throw recusar('sem_modelo_anterior');
    const atual = this.efetivo(f).modelo;
    const agora = this.o.clock.agora();
    this.o.repositorio.publicar(f, alvo.gravar, null, agora, {
      em: agora,
      autor,
      funcao: f,
      tipo: 'modelo_revertido',
      anterior: atual,
      novo: alvo.modelo,
    });
    this.cache = undefined;
    this.log.info('modelo de IA revertido', { autor, funcao: f, novo: alvo.modelo });
  }

  // --- internos -------------------------------------------------------------------------------------------

  private funcao(v: string): FuncaoDeIa {
    if (!ehFuncaoDeIa(v)) throw recusar('funcao_desconhecida');
    return v;
  }

  /**
   * Para onde a reversão vai: o modelo anterior gravado. Se ele é o do ambiente, a função volta a seguir
   * o ambiente (`gravar: null`); se é da lista, fica explícito; fora disso, a reversão é recusada.
   */
  private verificarReversao(
    f: FuncaoDeIa,
  ): { readonly modelo: string; readonly gravar: string | null } | undefined {
    const g = this.leituraFresca()[f];
    if (g.modelo === null || g.anterior === null) return undefined;
    if (g.anterior === this.o.doAmbiente[f]) return { modelo: g.anterior, gravar: null };
    if (podeSerCandidato(this.o.catalogo.buscar(g.anterior), f)) {
      return { modelo: g.anterior, gravar: g.anterior };
    }
    throw recusar('modelo_anterior_indisponivel');
  }

  private leituraFresca(): ModelosGravados {
    try {
      return this.o.repositorio.ler();
    } catch {
      return SEM_MODELO_GRAVADO;
    }
  }
}
