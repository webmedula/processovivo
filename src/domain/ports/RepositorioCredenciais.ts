import type { CredencialTribunal } from './ProvedorDePecas.js';

/** O que se pode mostrar de uma credencial sem mostrar a credencial. */
export interface CredencialCadastrada {
  readonly tribunal: string;
  readonly identificacao: string;
  readonly criadaEm: Date;
  readonly usadaEm?: Date;
  /**
   * Última vez que o tribunal recusou esta credencial.
   *
   * Existe para a interface poder dizer "sua senha do Projudi mudou?" em vez de
   * deixar a vigilância falhando em silêncio até alguém perceber.
   */
  readonly recusadaEm?: Date;
}

/**
 * PORTA de saída para a guarda das credenciais de tribunal.
 *
 * A senha do advogado no tribunal é o dado mais sensível que este sistema
 * guarda — mais do que a chave de API, que só dá acesso ao Processo Vivo. Ela abre o
 * processo, permite peticionar em nome dele e, se vazar, o prejuízo é dele, não
 * nosso. Três consequências que a porta impõe a qualquer implementação:
 *
 * - `obter` é o ÚNICO caminho que devolve a senha, e existe para ser chamado no
 *   momento da consulta. Nenhuma listagem devolve segredo: `listar` entrega
 *   `CredencialCadastrada`, sem o campo.
 * - A senha nunca vai para log, resposta HTTP ou mensagem de erro.
 * - Guardar em claro seria transformar um vazamento de banco em acesso ao
 *   processo de terceiros. A implementação cifra; a porta não descreve como,
 *   mas exige que o repositório receba a senha em claro e devolva em claro,
 *   deixando a criptografia inteiramente do lado de fora do domínio.
 */
export interface RepositorioCredenciais {
  /** @returns `undefined` quando este workspace não cadastrou o tribunal. */
  obter(workspace: string, tribunal: string): Promise<CredencialTribunal | undefined>;

  listar(workspace: string): Promise<CredencialCadastrada[]>;

  salvar(workspace: string, credencial: CredencialTribunal): Promise<CredencialCadastrada>;

  remover(workspace: string, tribunal: string): Promise<boolean>;

  /** Marca uso bem-sucedido, para a interface mostrar que o acesso está vivo. */
  registrarUso(workspace: string, tribunal: string): Promise<void>;

  /** Marca recusa pelo tribunal, para parar de insistir e avisar a pessoa. */
  registrarRecusa(workspace: string, tribunal: string): Promise<void>;
}
