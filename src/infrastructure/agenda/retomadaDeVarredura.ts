import type { DatabaseSync } from 'node:sqlite';

/**
 * Início e fim da varredura AGENDADA, gravados onde sobrevivem ao reinício (v0.67.3).
 *
 * Duas chaves na tabela `estado`, que já existe (chave/valor): nenhuma coluna
 * nova. Só instantes — nada de processo, conta ou resultado.
 *
 * `chaveLegada` é a marca que o aviso de silêncio já gravava ao fim de cada
 * varredura de processos (`ultima_varredura_ok`): no primeiro deploy desta
 * versão ainda não existe a chave nova, e sem a legada a subida varreria tudo
 * de novo uma última vez.
 */
export class MarcasDeVarredura {
  private readonly chaveInicio: string;
  private readonly chaveFim: string;

  constructor(
    private readonly db: DatabaseSync,
    nome: string,
    private readonly chaveLegada?: string,
  ) {
    this.chaveInicio = `varredura:${nome}:iniciada_em`;
    this.chaveFim = `varredura:${nome}:concluida_em`;
  }

  iniciadaEm(): Date | undefined {
    return this.ler(this.chaveInicio);
  }

  concluidaEm(): Date | undefined {
    return (
      this.ler(this.chaveFim) ??
      (this.chaveLegada ? this.ler(this.chaveLegada) : undefined)
    );
  }

  marcarInicio(quando: Date): void {
    this.gravar(this.chaveInicio, quando);
  }

  marcarFim(quando: Date): void {
    this.gravar(this.chaveFim, quando);
  }

  private ler(chave: string): Date | undefined {
    const linha = this.db
      .prepare('SELECT valor FROM estado WHERE chave = ?')
      .get(chave) as unknown as { valor: string } | undefined;
    if (!linha) return undefined;
    const quando = new Date(linha.valor);
    return Number.isNaN(quando.getTime()) ? undefined : quando;
  }

  private gravar(chave: string, quando: Date): void {
    this.db
      .prepare(
        `INSERT INTO estado (chave, valor) VALUES (?, ?)
         ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor`,
      )
      .run(chave, quando.toISOString());
  }
}

/** O que a retomada precisa das marcas; a classe acima é a de produção. */
export interface MarcasDaVarredura {
  iniciadaEm(): Date | undefined;
  concluidaEm(): Date | undefined;
  marcarInicio(quando: Date): void;
  marcarFim(quando: Date): void;
}

export interface OpcoesVarreduraRetomavel {
  readonly marcas: MarcasDaVarredura;
  readonly intervaloHoras: number;
  /**
   * A varredura. `pularVerificadosDesde` só vem na RETOMADA de uma varredura
   * interrompida: o que foi verificado com sucesso depois desse instante não
   * precisa ser consultado de novo.
   */
  readonly executar: (pularVerificadosDesde?: Date) => Promise<unknown>;
  readonly agora?: () => Date;
}

/**
 * Faz a varredura agendada não se repetir a cada reinício (v0.67.3).
 *
 * - **Concluída há menos que o intervalo:** `ultimaExecucaoEm` devolve o fim
 *   dela, e o `Agendador` espera o tempo que falta.
 * - **Interrompida** (começou e o processo morreu antes do fim — SIGTERM de
 *   deploy): `ultimaExecucaoEm` devolve `undefined`, a varredura recomeça no
 *   atraso de sempre e a PRIMEIRA execução pula o que já foi verificado com
 *   sucesso dentro do intervalo. Só a primeira: numa execução normal, tudo foi
 *   verificado "dentro do intervalo" pela anterior, e pular seria nunca varrer.
 * - **Sem registro:** o comportamento de sempre.
 *
 * Falha de leitura ou de gravação das marcas nunca impede a varredura: a marca
 * existe para poupar consulta, não para decidir se o advogado é avisado.
 */
export function varreduraRetomavel(opcoes: OpcoesVarreduraRetomavel): {
  readonly ultimaExecucaoEm: () => Date | undefined;
  readonly tarefa: () => Promise<unknown>;
} {
  const agora = opcoes.agora ?? ((): Date => new Date());
  const intervaloMs = opcoes.intervaloHoras * 3_600_000;
  let primeira = true;

  const interrompida = (): boolean => {
    const inicio = opcoes.marcas.iniciadaEm();
    if (!inicio) return false;
    const fim = opcoes.marcas.concluidaEm();
    return !fim || inicio.getTime() > fim.getTime();
  };
  const seguro = <T>(f: () => T, padrao: T): T => {
    try {
      return f();
    } catch {
      return padrao;
    }
  };

  return {
    ultimaExecucaoEm: () =>
      seguro(() => (interrompida() ? undefined : opcoes.marcas.concluidaEm()), undefined),
    tarefa: async () => {
      const retomar = primeira && seguro(interrompida, false);
      primeira = false;
      const corte = retomar ? new Date(agora().getTime() - intervaloMs) : undefined;
      seguro(() => opcoes.marcas.marcarInicio(agora()), undefined);
      const r = await opcoes.executar(corte);
      seguro(() => opcoes.marcas.marcarFim(agora()), undefined);
      return r;
    },
  };
}
