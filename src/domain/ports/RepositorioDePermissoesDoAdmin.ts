/**
 * Permissões por aba dos administradores restritos do /admin (v0.62.0).
 *
 * Os métodos são síncronos (como os demais repositórios do painel) e PODEM LANÇAR: quem pergunta trata a
 * falha como "sem acesso" — falha fechada. Nada aqui guarda senha: as credenciais moram só em variável de
 * ambiente.
 */
export interface PermissaoDoAdmin {
  readonly usuario: string;
  readonly aba: string;
  /** Autor da liberação (o dono). */
  readonly liberadoPor: string;
  readonly liberadoEm: Date;
}

export type AcaoDePermissao = 'liberou' | 'tirou';

/** Uma linha do histórico de permissões (SÓ DE ACRÉSCIMO). */
export interface MudancaDePermissao {
  readonly em: Date;
  readonly por: string;
  readonly usuario: string;
  readonly aba: string;
  readonly acao: AcaoDePermissao;
}

export interface RepositorioDePermissoesDoAdmin {
  /** As abas gravadas para o usuário (sem filtrar o que a lista do código não conhece). */
  abasDe(usuario: string): string[];
  todas(): PermissaoDoAdmin[];
  /**
   * Deixa o usuário com EXATAMENTE estas abas, e grava no histórico o que mudou, na mesma transação.
   * Devolve as mudanças (vazio = nada mudou, nada foi gravado).
   */
  substituir(
    usuario: string,
    abas: readonly string[],
    por: string,
    em: Date,
  ): MudancaDePermissao[];
  historico(limite: number): MudancaDePermissao[];
  registrarAcesso(usuario: string, em: Date): void;
  ultimosAcessos(): Map<string, Date>;
}
