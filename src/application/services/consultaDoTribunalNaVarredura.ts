import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import {
  CredencialTribunalInvalidaError,
  SemHabilitacaoNosAutosError,
} from '../../domain/errors/index.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type {
  AssinaturaDeMudanca,
  ProvedorDePecas,
} from '../../domain/ports/ProvedorDePecas.js';
import type { RepositorioCredenciais } from '../../domain/ports/RepositorioCredenciais.js';
import type { ServicoPecas } from './ServicoPecas.js';

/**
 * O que a varredura recebe do sistema do tribunal para UM processo de UMA conta (v0.72.0).
 *
 * - `sem_consulta`: não perguntou (tribunal sem fonte de peças, conta sem acesso cadastrado,
 *   credencial já recusada, tribunal em pausa por bloqueio, processo sob sigilo).
 * - `sem_mudanca`: perguntou só "mudou alguma coisa?" e a resposta foi não.
 * - `sem_atos`: o tribunal respondeu sem a linha do tempo (sem procuração nos autos); a assinatura
 *   é guardada para não repetir a consulta completa enquanto nada mudar lá.
 * - `atos`: a linha do tempo do tribunal, e a assinatura a guardar.
 */
export type ResultadoDoTribunalNaVarredura =
  | { readonly situacao: 'sem_consulta' }
  | { readonly situacao: 'sem_mudanca' }
  | { readonly situacao: 'sem_atos'; readonly assinatura?: string }
  | {
      readonly situacao: 'atos';
      readonly movimentos: readonly Movimentacao[];
      readonly assinatura?: string;
    };

/** A porta que o `ServicoAcompanhamento` conhece. Lançar aqui nunca derruba a verificação. */
export interface FonteDoTribunalNaVarredura {
  consultar(
    workspace: string,
    numero: string,
    assinaturaAnterior: string | undefined,
  ): Promise<ResultadoDoTribunalNaVarredura>;
}

export interface OpcoesConsultaDoTribunal {
  readonly pecas: Pick<ServicoPecas, 'listarDoProcesso'>;
  /** O MESMO provedor das peças (um adapter, um balde, um disjuntor) — só para o atalho e a pausa. */
  readonly provedor: Pick<
    ProvedorDePecas,
    'tribunais' | 'assinaturaDeMudanca' | 'pausadoAte'
  >;
  readonly credenciais: RepositorioCredenciais;
  readonly logger: Logger;
  readonly agora?: () => Date;
}

/**
 * Pergunta ao tribunal, na varredura agendada, o que mudou num processo (v0.72.0).
 *
 * Cada consulta leva a senha do advogado e sai do MESMO servidor para todos os assinantes, então
 * a ordem é a mais econômica possível:
 *
 * 1. **Nada sai** sem fonte de peças para o tribunal, sem credencial, com credencial já recusada
 *    (a recusa só se limpa quando a pessoa recadastra ou uma consulta dela dá certo) ou com o
 *    disjuntor de 403 aberto. Repetir senha recusada a cada 12 horas é como se bloqueia a conta do
 *    advogado no tribunal.
 * 2. **O atalho barato** (`consultarAlteracao`): se a assinatura das movimentações e dos documentos
 *    é a mesma da última leitura, nada mais sai.
 * 3. **A listagem completa** só quando mudou, pelo MESMO `ServicoPecas` da tela — que anota uso e
 *    recusa da credencial e atualiza a lista da Pasta digital de quebra.
 *
 * Uma consulta ao tribunal por vez, vinda da varredura (os trabalhadores do pool esperam a vez
 * aqui): o balde de 30 por minuto é de todos, e a tela de quem está usando não pode ficar atrás de
 * três listagens de 280 KB da varredura.
 */
export class ConsultaDoTribunalNaVarredura implements FonteDoTribunalNaVarredura {
  private readonly pecas: OpcoesConsultaDoTribunal['pecas'];
  private readonly provedor: OpcoesConsultaDoTribunal['provedor'];
  private readonly credenciais: RepositorioCredenciais;
  private readonly log: Logger;
  private readonly relogio: () => Date;
  private fila: Promise<unknown> = Promise.resolve();

  constructor(opcoes: OpcoesConsultaDoTribunal) {
    this.pecas = opcoes.pecas;
    this.provedor = opcoes.provedor;
    this.credenciais = opcoes.credenciais;
    this.log = opcoes.logger.child({ componente: 'tribunal-na-varredura' });
    this.relogio = opcoes.agora ?? (() => new Date());
  }

  async consultar(
    workspace: string,
    numero: string,
    assinaturaAnterior: string | undefined,
  ): Promise<ResultadoDoTribunalNaVarredura> {
    const sigla = NumeroCNJ.tentarCriar(numero)?.siglaTribunal;
    if (!sigla) return { situacao: 'sem_consulta' };
    const atende =
      this.provedor.tribunais.includes('*') || this.provedor.tribunais.includes(sigla);
    if (!atende) return { situacao: 'sem_consulta' };

    const cadastrada = (await this.credenciais.listar(workspace)).find(
      (c) => c.tribunal === sigla,
    );
    if (!cadastrada || cadastrada.recusadaEm) return { situacao: 'sem_consulta' };

    return this.naVez(async () => {
      // Conferida DENTRO da vez: a espera pode ter atravessado um 403 ou uma recusa de outra consulta.
      if (this.emPausa()) return { situacao: 'sem_consulta' } as const;
      const atual = (await this.credenciais.listar(workspace)).find(
        (c) => c.tribunal === sigla,
      );
      if (!atual || atual.recusadaEm) return { situacao: 'sem_consulta' } as const;

      const assinatura = await this.assinatura(workspace, numero, sigla);
      if (assinatura !== undefined && assinatura === assinaturaAnterior) {
        return { situacao: 'sem_mudanca' } as const;
      }
      const comAssinatura = assinatura !== undefined ? { assinatura } : {};

      try {
        const atos = await this.pecas.listarDoProcesso(workspace, numero);
        // Processo sob sigilo na origem: nada do tribunal vai ao retrato (nem a assinatura, para a
        // próxima rodada não tomar o sigilo por "nada mudou").
        if ((atos.nivelSigiloDoProcesso ?? 0) > 0)
          return { situacao: 'sem_consulta' } as const;
        if (atos.movimentos.length === 0) {
          return { situacao: 'sem_atos', ...comAssinatura } as const;
        }
        return {
          situacao: 'atos',
          movimentos: atos.movimentos,
          ...comAssinatura,
        } as const;
      } catch (erro) {
        if (erro instanceof SemHabilitacaoNosAutosError) {
          return { situacao: 'sem_atos', ...comAssinatura } as const;
        }
        throw erro;
      }
    });
  }

  private emPausa(): boolean {
    const ate = this.provedor.pausadoAte?.();
    return ate !== undefined && ate.getTime() > this.relogio().getTime();
  }

  /**
   * A assinatura de "mudou?" — ou `undefined` quando a fonte não a oferece ou não a preencheu.
   *
   * Esta chamada não passa pelo `ServicoPecas`, então a recusa da credencial é anotada AQUI: sem
   * isso a próxima rodada mandaria a mesma senha recusada de novo.
   */
  private async assinatura(
    workspace: string,
    numero: string,
    sigla: string,
  ): Promise<string | undefined> {
    const assinar = this.provedor.assinaturaDeMudanca?.bind(this.provedor);
    if (!assinar) return undefined;
    const credencial = await this.credenciais.obter(workspace, sigla);
    if (!credencial) return undefined;
    try {
      return chaveDaAssinatura(await assinar(numero, credencial));
    } catch (erro) {
      if (erro instanceof CredencialTribunalInvalidaError) {
        await this.credenciais.registrarRecusa(workspace, sigla);
        this.log.warn('credencial recusada pelo tribunal na varredura', {
          workspace,
          tribunal: sigla,
          acao: 'o assinante precisa atualizar usuário e senha',
        });
      }
      throw erro;
    }
  }

  private naVez<T>(tarefa: () => Promise<T>): Promise<T> {
    const vez = this.fila.then(tarefa, tarefa);
    // A fila nunca fica rejeitada: a falha de um processo é dele, não do próximo.
    this.fila = vez.catch(() => undefined);
    return vez;
  }
}

/**
 * Movimentações E documentos: peça juntada sem movimento novo também é mudança. Sem nenhum dos
 * dois, não há atalho e a listagem completa decide.
 */
export function chaveDaAssinatura(a: AssinaturaDeMudanca): string | undefined {
  if (a.movimentacoes === undefined && a.documentos === undefined) return undefined;
  return `m:${a.movimentacoes ?? ''}|d:${a.documentos ?? ''}`;
}
