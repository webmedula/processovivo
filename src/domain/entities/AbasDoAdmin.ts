/**
 * As abas do /admin (v0.62.0) — a lista é CÓDIGO, nunca dado.
 *
 * O dono do /admin vê todas, sempre. Um administrador restrito vê só as que o dono liberou na tela
 * "Administradores", e a liberação é por aba inteira (sem permissão mais fina dentro dela). Como a lista
 * mora aqui, uma aba criada no futuro NASCE FECHADA para todo restrito: ninguém a tem até o dono marcar.
 * O banco só guarda "quem tem qual aba" e nunca decide quais abas existem.
 */
export const ABAS_DO_ADMIN = ['assinaturas', 'planos', 'chaves', 'ia'] as const;

export type AbaDoAdmin = (typeof ABAS_DO_ADMIN)[number];

/** A tela de permissões. Só o dono a vê, e não existe como permissão: nenhum restrito a recebe. */
export const ABA_ADMINISTRADORES = 'administradores' as const;

export type AbaDaTela = AbaDoAdmin | typeof ABA_ADMINISTRADORES;

export const ROTULO_DA_ABA: Readonly<Record<AbaDaTela, string>> = {
  assinaturas: 'Assinaturas',
  planos: 'Planos',
  chaves: 'Chaves de API',
  ia: 'IA',
  administradores: 'Administradores',
};

export function ehAbaDoAdmin(valor: unknown): valor is AbaDoAdmin {
  return (
    typeof valor === 'string' && (ABAS_DO_ADMIN as readonly string[]).includes(valor)
  );
}

/** Na ordem do menu, sem repetição, descartando o que não é aba (linha torta no banco não abre nada). */
export function abasEmOrdem(abas: Iterable<string>): AbaDoAdmin[] {
  const conjunto = new Set(abas);
  return ABAS_DO_ADMIN.filter((a) => conjunto.has(a));
}
