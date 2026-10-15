/**
 * Workspace na lista de teste fechado da análise por IA (v0.38.1).
 *
 * O id do workspace de uma chave de API são os 16 primeiros hex do SHA-256 dela
 * (`workspaceDaChave`). Não é a chave e não a revela, mas identifica de quem é
 * a carteira — por isso log e tela só mostram a forma mascarada.
 */
export const FORMATO_DE_WORKSPACE = /^[0-9a-f]{16}$/;

/** `1ed3b9b0ba131867` → `1ed3…1867`. Valor fora do formato nunca é ecoado. */
export function mascararWorkspace(workspace: string): string {
  return FORMATO_DE_WORKSPACE.test(workspace)
    ? `${workspace.slice(0, 4)}…${workspace.slice(-4)}`
    : '(id inválido)';
}
