import type { VigilanciaOab } from '../entities/VigilanciaOab.js';

/**
 * Porta de persistência das inscrições sob vigilância.
 *
 * Separada de `RepositorioAcompanhamentos` de propósito: são dois ciclos de vida
 * diferentes. Um acompanhamento é um processo específico que alguém escolheu
 * seguir; uma vigilância é um critério que vai gerando acompanhamentos sozinho.
 * Misturar as duas coisas numa interface só faria a varredura de OAB e a de
 * processos disputarem o mesmo método.
 */
export interface RepositorioVigilancias {
  /** Idempotente: cadastrar a mesma OAB duas vezes não cria duas vigilâncias. */
  vigiar(
    workspace: string,
    oab: string,
    uf: string,
    apelido?: string,
  ): Promise<VigilanciaOab>;

  parar(workspace: string, oab: string, uf: string): Promise<boolean>;

  listar(workspace: string): Promise<VigilanciaOab[]>;

  /**
   * Vigilâncias ativas para a varredura.
   *
   * @param workspace quando informado, só as dele. Sem ele, todas — que é o
   *   que a varredura agendada precisa, e o que a rota HTTP NÃO pode fazer:
   *   senão uma conta manda o servidor varrer a inscrição de todos os outros.
   */
  listarParaVarrer(limite: number, workspace?: string): Promise<VigilanciaOab[]>;

  /**
   * Fecha uma varredura bem-sucedida.
   *
   * `varridaEm` é gravado pelo repositório com o momento que o serviço passar,
   * e não com `CURRENT_TIMESTAMP`: a próxima janela é calculada a partir dele, e
   * relógio de banco divergindo do relógio da aplicação abriria um buraco entre
   * uma varredura e outra.
   */
  registrarVarredura(
    workspace: string,
    oab: string,
    uf: string,
    varridaEm: Date,
    processosEncontrados: number,
  ): Promise<void>;

  registrarFalha(
    workspace: string,
    oab: string,
    uf: string,
    erro: string,
  ): Promise<void>;
}
