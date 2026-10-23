import {
  CONFIG_PADRAO_DO_PAINEL,
  alertaValido,
  ehFuncaoDeIa,
  estadoDaFuncao,
  tetoValido,
  type AmbienteDaIa,
  type ConfigDoPainel,
  type ControleDaIa,
  type EstadoDaFuncao,
  type FuncaoDeIa,
  type LimitesDoPainel,
} from '../../domain/entities/ControleDaIa.js';
import { ConfiguracaoDeIaRecusadaError } from '../../domain/errors/index.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type {
  AlteracaoDeConfigDeIa,
  RepositorioDeConfigDeIa,
} from '../../domain/ports/PainelDeIa.js';

export interface OpcoesDoControleDaIa {
  readonly repositorio: RepositorioDeConfigDeIa;
  readonly ambiente: AmbienteDaIa;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Quanto a leitura do banco vale antes de ser refeita. Padrão 5 s. */
  readonly validadeDoCacheMs?: number;
}

const VALIDADE_PADRAO_MS = 5_000;
/** Falha repetida do banco vira UMA linha de aviso por minuto, não uma por análise. */
const AVISO_DE_FALHA_A_CADA_MS = 60_000;

/**
 * O controle da IA pelo painel do /admin (v0.58.0, Fase A).
 *
 * Precedência: **o ambiente é a trava mestra**. A função só funciona se o ambiente permite E o painel
 * está ligado; o teto efetivo é o menor entre a variável e o painel. O painel nunca liga o que o
 * ambiente desligou.
 *
 * Falha segura: qualquer erro ao ler a configuração (banco travado, linha torta) devolve o padrão do
 * código — "o painel não restringe nada", ou seja, vale só o ambiente — e NUNCA lança para quem
 * está analisando. A leitura tem cache curto para não ir ao banco a cada clique.
 */
export class ServicoControleDaIa implements ControleDaIa {
  private cache: { readonly config: ConfigDoPainel; readonly ate: number } | undefined;
  private ultimoAvisoDeFalhaEm = Number.NEGATIVE_INFINITY;
  private readonly log: Logger;

  constructor(private readonly o: OpcoesDoControleDaIa) {
    this.log = o.logger.child({ servico: 'controle-da-ia' });
  }

  /** O que o painel guarda agora (com cache curto; falha = padrão do código). */
  config(): ConfigDoPainel {
    const agora = this.o.clock.monotonico();
    if (this.cache && agora < this.cache.ate) return this.cache.config;
    let config: ConfigDoPainel;
    try {
      config = this.o.repositorio.ler();
    } catch {
      // Sem a mensagem do erro: ela pode trazer caminho de arquivo. O fato basta.
      if (agora - this.ultimoAvisoDeFalhaEm >= AVISO_DE_FALHA_A_CADA_MS) {
        this.ultimoAvisoDeFalhaEm = agora;
        this.log.warn('painel de IA indisponível: vale a configuração do ambiente');
      }
      config = CONFIG_PADRAO_DO_PAINEL;
    }
    // Falha também fica no cache curto: martelar um banco travado a cada análise não ajuda.
    this.cache = {
      config,
      ate: agora + (this.o.validadeDoCacheMs ?? VALIDADE_PADRAO_MS),
    };
    return config;
  }

  ligada(funcao: FuncaoDeIa): boolean {
    return estadoDaFuncao(funcao, this.o.ambiente, this.config()).efetivamenteLigada;
  }

  /** Só os tetos do PAINEL (o do ambiente continua com o `TetoDiario`); o efetivo é o menor dos dois. */
  limites(): LimitesDoPainel {
    const c = this.config();
    return {
      porFuncao: {
        ato: c.funcoes.ato.tetoPorConta ?? undefined,
        resumo: c.funcoes.resumo.tetoPorConta ?? undefined,
        peca: c.funcoes.peca.tetoPorConta ?? undefined,
      },
      global: c.tetoGlobal ?? undefined,
    };
  }

  estados(): EstadoDaFuncao[] {
    const c = this.config();
    return (['ato', 'resumo', 'peca'] as const).map((f) =>
      estadoDaFuncao(f, this.o.ambiente, c),
    );
  }

  alertaDeCustoUsd(): number {
    return this.config().alertaCustoDiaUsd;
  }

  alteracoes(limite = 50): AlteracaoDeConfigDeIa[] {
    try {
      return this.o.repositorio.alteracoes(limite);
    } catch {
      return [];
    }
  }

  // --- mudanças (só pelo /admin) -------------------------------------------------------------------

  ligarOuDesligar(
    autor: string,
    funcao: string,
    ligada: boolean,
    confirmado: boolean,
  ): void {
    const f = this.funcao(funcao);
    const atual = this.leituraFresca();
    if (!ligada && !confirmado) {
      throw new ConfiguracaoDeIaRecusadaError(
        'confirmacao_necessaria',
        'Desligar uma função da IA pede confirmação.',
      );
    }
    if (ligada && !this.o.ambiente.permite[f]) {
      // O painel nunca liga o que a variável de ambiente desligou.
      throw new ConfiguracaoDeIaRecusadaError(
        'ambiente_bloqueia',
        'O ambiente do servidor desligou esta função: o painel não a liga.',
      );
    }
    if (atual.funcoes[f].ligada === ligada) return;
    this.aplicar(
      autor,
      f,
      'ligada',
      { ...atual, funcoes: { ...atual.funcoes, [f]: { ...atual.funcoes[f], ligada } } },
      ligada ? 'desligada' : 'ligada',
      ligada ? 'ligada' : 'desligada',
    );
  }

  definirTetoDaFuncao(autor: string, funcao: string, teto: number | null): void {
    const f = this.funcao(funcao);
    if (teto !== null && !tetoValido(teto)) throw valorInvalido();
    const atual = this.leituraFresca();
    const anterior = atual.funcoes[f].tetoPorConta;
    if (anterior === teto) return;
    this.aplicar(
      autor,
      f,
      'teto_dia_conta',
      {
        ...atual,
        funcoes: { ...atual.funcoes, [f]: { ...atual.funcoes[f], tetoPorConta: teto } },
      },
      textoDoTeto(anterior),
      textoDoTeto(teto),
    );
  }

  definirTetoGlobal(autor: string, teto: number | null): void {
    if (teto !== null && !tetoValido(teto)) throw valorInvalido();
    const atual = this.leituraFresca();
    if (atual.tetoGlobal === teto) return;
    this.aplicar(
      autor,
      'global',
      'teto_dia_global',
      { ...atual, tetoGlobal: teto },
      textoDoTeto(atual.tetoGlobal),
      textoDoTeto(teto),
    );
  }

  definirAlertaDeCusto(autor: string, valorUsd: number): void {
    if (!alertaValido(valorUsd)) throw valorInvalido();
    const atual = this.leituraFresca();
    const novo = Math.round(valorUsd * 100) / 100;
    if (atual.alertaCustoDiaUsd === novo) return;
    this.aplicar(
      autor,
      'global',
      'alerta_custo',
      { ...atual, alertaCustoDiaUsd: novo },
      atual.alertaCustoDiaUsd.toFixed(2),
      novo.toFixed(2),
    );
  }

  // --- internos ------------------------------------------------------------------------------------

  private funcao(v: string): FuncaoDeIa {
    if (!ehFuncaoDeIa(v)) {
      throw new ConfiguracaoDeIaRecusadaError(
        'funcao_desconhecida',
        'Função de IA desconhecida.',
      );
    }
    return v;
  }

  /** Para mudar, lê do banco (sem cache): duas mudanças seguidas não podem partir de um retrato velho. */
  private leituraFresca(): ConfigDoPainel {
    try {
      return this.o.repositorio.ler();
    } catch {
      return CONFIG_PADRAO_DO_PAINEL;
    }
  }

  private aplicar(
    autor: string,
    funcao: FuncaoDeIa | 'global',
    tipo: AlteracaoDeConfigDeIa['tipo'],
    config: ConfigDoPainel,
    anterior: string,
    novo: string,
  ): void {
    const agora = this.o.clock.agora();
    this.o.repositorio.gravar(
      config,
      { em: agora, autor, funcao, tipo, anterior, novo },
      agora,
    );
    this.cache = undefined;
    // Log só do fato, sem valores de conta nem texto: quem mudou (id curto), o quê e para qual valor.
    this.log.info('configuração de IA alterada', { autor, funcao, tipo, novo });
  }
}

const textoDoTeto = (v: number | null): string => (v === null ? 'sem teto' : String(v));

function valorInvalido(): ConfiguracaoDeIaRecusadaError {
  return new ConfiguracaoDeIaRecusadaError(
    'valor_invalido',
    'Valor fora da faixa permitida.',
  );
}
