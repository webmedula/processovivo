import { createHash } from 'node:crypto';

/**
 * Identificador CURTO do operador para o registro de mudanças. O /admin tem uma credencial só (HTTP
 * Basic, fora da tabela de usuários), então não há "pessoa" a registrar: guarda-se 8 hex de um SHA-256
 * do nome de usuário configurado. Não reverte para o nome nem é o e-mail.
 */
export function identificarOperador(usuario: string): string {
  return createHash('sha256').update(`admin:${usuario}`).digest('hex').slice(0, 8);
}
