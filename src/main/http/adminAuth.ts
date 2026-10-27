import { pareceValorDeExemplo } from '../../infrastructure/config/placeholder.js';

/**
 * Comprimento mínimo aceito para a senha administrativa.
 *
 * Maior que `TAMANHO_MINIMO_CHAVE` (24) de propósito: uma chave de API vazada
 * expõe o workspace isolado dela; esta senha abre liberar assinatura de
 * QUALQUER assinante e emitir chave de API nova. É a porta mais sensível deste
 * sistema, e o mínimo reflete isso.
 */
export const TAMANHO_MINIMO_SENHA_ADMIN = 16;

/** Senha de administrador restrito: mais exigente que a do dono (que continua em 16 por compatibilidade). */
export const TAMANHO_MINIMO_SENHA_RESTRITO = 24;

/** Nome de usuário de administrador restrito: minúsculas, números, hífen e sublinhado. */
export const PADRAO_DO_USUARIO_RESTRITO = /^[a-z0-9_-]{2,32}$/;

export interface CredencialDoAdmin {
  readonly usuario: string;
  readonly senha: string;
}

export class ConfiguracaoDeAdminInvalidaError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ConfiguracaoDeAdminInvalidaError';
  }
}

/**
 * Se a área administrativa está ligada.
 *
 * As duas variáveis vazias — o padrão — significa desligada: o sistema sobe
 * igual a antes desta entrega, sem exigir nada de novo. `validarConfiguracaoAdmin`
 * é quem impede o estado intermediário (só uma definida).
 */
export function adminHabilitado(usuario: string, senha: string): boolean {
  return usuario.length > 0 && senha.length > 0;
}

/**
 * Valida a configuração da área administrativa ANTES de o servidor abrir a
 * porta — mesma disciplina de `validarChavesDeApi`, e pelo mesmo motivo:
 * falhar aqui é barulhento e aparece no log de deploy; a alternativa é uma
 * área administrativa aberta, ou fechada por um jeito que ninguém percebeu.
 *
 * @throws {ConfiguracaoDeAdminInvalidaError}
 */
export function validarConfiguracaoAdmin(
  usuario: string,
  senha: string,
  restritos = '',
): void {
  if (!adminHabilitado(usuario, senha)) {
    if (usuario.length > 0 || senha.length > 0) {
      throw new ConfiguracaoDeAdminInvalidaError(
        'PROCESSOVIVO_ADMIN_USUARIO e PROCESSOVIVO_ADMIN_SENHA precisam ser ' +
          'definidas as duas juntas, ou nenhuma das duas. Configurar só uma ' +
          'deixa a área administrativa num estado que não é nem ligado nem ' +
          'desligado.',
      );
    }
    return;
  }

  if (pareceValorDeExemplo(usuario) || pareceValorDeExemplo(senha)) {
    throw new ConfiguracaoDeAdminInvalidaError(
      'PROCESSOVIVO_ADMIN_USUARIO ou PROCESSOVIVO_ADMIN_SENHA ainda contém o ' +
        'texto de exemplo. Escolha um usuário e uma senha de verdade.',
    );
  }

  if (senha.length < TAMANHO_MINIMO_SENHA_ADMIN) {
    throw new ConfiguracaoDeAdminInvalidaError(
      `PROCESSOVIVO_ADMIN_SENHA tem menos de ${TAMANHO_MINIMO_SENHA_ADMIN} ` +
        'caracteres. Esta senha libera assinatura e emite chave de API de ' +
        'qualquer workspace — não pode ser fraca. (A senha não é exibida ' +
        'nesta mensagem de propósito.)',
    );
  }

  lerRestritosDoAdmin(restritos, usuario);
}

/**
 * Lê `PROCESSOVIVO_ADMIN_RESTRITOS` (v0.62.0): `usuario:senha,usuario2:senha2`. A senha vai depois do PRIMEIRO
 * `:` e não pode ter vírgula nem espaço (a vírgula separa as entradas).
 *
 * Falha fechada e SEM ecoar nada do que foi lido: uma entrada torta pode ser uma senha colada sozinha, então as
 * mensagens falam só do NÚMERO da entrada e da regra violada — nunca do conteúdo.
 *
 * @throws {ConfiguracaoDeAdminInvalidaError}
 */
export function lerRestritosDoAdmin(
  texto: string,
  donoUsuario: string,
): CredencialDoAdmin[] {
  const entradas = texto
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (entradas.length === 0) return [];

  if (donoUsuario.length === 0) {
    throw new ConfiguracaoDeAdminInvalidaError(
      'PROCESSOVIVO_ADMIN_RESTRITOS está definida, mas PROCESSOVIVO_ADMIN_USUARIO e ' +
        'PROCESSOVIVO_ADMIN_SENHA (o dono) não. Defina o dono primeiro.',
    );
  }

  const lidas: CredencialDoAdmin[] = [];
  const vistos = new Map<string, number>();
  vistos.set(donoUsuario.toLowerCase(), 0);

  entradas.forEach((entrada, i) => {
    const n = i + 1;
    const corte = entrada.indexOf(':');
    if (corte <= 0 || corte === entrada.length - 1) {
      throw new ConfiguracaoDeAdminInvalidaError(
        `PROCESSOVIVO_ADMIN_RESTRITOS: a entrada ${n} não está no formato usuario:senha. ` +
          '(O conteúdo não é exibido nesta mensagem de propósito.)',
      );
    }
    const usuario = entrada.slice(0, corte);
    const senha = entrada.slice(corte + 1);

    if (!PADRAO_DO_USUARIO_RESTRITO.test(usuario)) {
      throw new ConfiguracaoDeAdminInvalidaError(
        `PROCESSOVIVO_ADMIN_RESTRITOS: o usuário da entrada ${n} fora do padrão. Use de 2 a 32 ` +
          'caracteres entre letras minúsculas, números, hífen e sublinhado.',
      );
    }
    if (/\s/.test(senha)) {
      throw new ConfiguracaoDeAdminInvalidaError(
        `PROCESSOVIVO_ADMIN_RESTRITOS: a senha da entrada ${n} tem espaço. Gere uma senha sem ` +
          'espaços (veja o DEPLOY.md). (A senha não é exibida nesta mensagem de propósito.)',
      );
    }
    if (pareceValorDeExemplo(usuario) || pareceValorDeExemplo(senha)) {
      throw new ConfiguracaoDeAdminInvalidaError(
        `PROCESSOVIVO_ADMIN_RESTRITOS: a entrada ${n} ainda contém o texto de exemplo. ` +
          'Escolha um usuário e uma senha de verdade.',
      );
    }
    if (senha.length < TAMANHO_MINIMO_SENHA_RESTRITO) {
      throw new ConfiguracaoDeAdminInvalidaError(
        `PROCESSOVIVO_ADMIN_RESTRITOS: a senha da entrada ${n} tem menos de ` +
          `${TAMANHO_MINIMO_SENHA_RESTRITO} caracteres. (A senha não é exibida nesta mensagem de propósito.)`,
      );
    }
    const anterior = vistos.get(usuario.toLowerCase());
    if (anterior !== undefined) {
      throw new ConfiguracaoDeAdminInvalidaError(
        anterior === 0
          ? `PROCESSOVIVO_ADMIN_RESTRITOS: o usuário da entrada ${n} é igual ao do dono.`
          : `PROCESSOVIVO_ADMIN_RESTRITOS: o usuário da entrada ${n} repete o da entrada ${anterior}.`,
      );
    }
    vistos.set(usuario.toLowerCase(), n);
    lidas.push({ usuario, senha });
  });

  return lidas;
}
