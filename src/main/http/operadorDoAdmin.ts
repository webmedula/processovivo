import { createHash } from 'node:crypto';

/**
 * Quem fez a ação no /admin, como vai para as tabelas de auditoria (`ia_alteracoes`, `ia_instrucoes`,
 * `ia_testes_modelo`, `admin_permissoes*`).
 *
 * - O DONO continua sendo 8 hex de um SHA-256 do usuário configurado (o valor que as tabelas já tinham antes da
 *   v0.62.0): registro antigo e novo do dono são IGUAIS, e o nome do dono não vai ao banco.
 * - O restrito é `u:<usuario>` (o nome já é só `[a-z0-9_-]`, nunca e-mail nem senha). O prefixo garante que um
 *   nome parecido com 8 hex nunca se confunda com o dono.
 *
 * Na tela, `rotuloDoAutor` devolve "dono" para tudo o que não é `u:` — inclusive os registros anteriores à v0.62.0.
 */
export function identificarOperador(usuario: string): string {
  return createHash('sha256').update(`admin:${usuario}`).digest('hex').slice(0, 8);
}

export function autorDoRestrito(usuario: string): string {
  return `u:${usuario}`;
}

export const ROTULO_DO_DONO = 'dono';

export function rotuloDoAutor(autor: string): string {
  return autor.startsWith('u:') ? autor.slice(2) : ROTULO_DO_DONO;
}
