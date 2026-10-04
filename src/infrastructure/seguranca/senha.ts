import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SenhaFracaError } from '../../domain/errors/index.js';
import type { HashDeSenha } from '../../domain/ports/Criptografia.js';

/**
 * Hash de senha com **scrypt do `node:crypto`**.
 *
 * bcrypt e argon2 são ótimos e estão fora: os dois exigem compilar módulo
 * nativo, e a imagem de produção é Alpine. É o mesmo motivo que escolheu
 * `node:sqlite` em vez de `better-sqlite3` — dependência nativa num runtime
 * musl transforma cada deploy numa aposta.
 *
 * scrypt é função de derivação com custo de MEMÓRIA, que é exatamente a defesa
 * contra ataque com GPU. Está no padrão RFC 7914 e vem na biblioteca padrão do
 * Node desde a v10; não é um remendo.
 */

/**
 * Custo de CPU/memória: N = 2^14, que com r=8 são **16 MB** por verificação
 * (128 · N · r), na ordem de 50ms numa vCPU modesta — o VPS onde isso roda.
 *
 * Subir para 2^16 (64 MB) endurece o ataque offline em 4×, e é tentador. Não
 * foi feito porque a rota de login é PÚBLICA: 50 tentativas simultâneas já
 * seriam 3,2 GB de RAM a 64 MB, contra 800 MB agora — negação de serviço no
 * contêiner é mais provável aqui do que vazamento da tabela `usuarios`.
 *
 * Se o dia do vazamento chegar e este número parecer baixo, subi-lo é seguro:
 * os parâmetros vão gravados em cada hash, então senha antiga continua
 * conferindo com os parâmetros dela.
 */
const N = 16_384;
const R = 8;
const P = 1;
const TAMANHO_CHAVE = 64;
const TAMANHO_SAL = 16;

/**
 * 10 caracteres.
 *
 * Abaixo disso o hash caro não salva ninguém: senha de 6 dígitos cai em
 * dicionário mesmo com scrypt, porque o espaço de busca é pequeno demais para
 * o custo por tentativa importar. Não impomos regra de maiúscula e símbolo —
 * comprovadamente produz `Senha@123` e anotação no monitor.
 */
export const TAMANHO_MINIMO_SENHA = 10;

/**
 * O limite de cima existe por segurança, não por economia: cada verificação
 * processa a senha inteira, e um campo sem teto deixa alguém mandar 10 MB de
 * texto e ocupar a CPU do contêiner.
 */
const TAMANHO_MAXIMO_SENHA = 200;

/**
 * Confere o tamanho e nada mais. Custo desprezível, de propósito.
 *
 * `guardarSenha` chama esta antes de gastar o scrypt, então a regra vive num
 * lugar só; e quem precisa recusar cedo — a redefinição de senha, antes de
 * consumir o link — chama esta sozinha.
 *
 * @throws {SenhaFracaError}
 */
export function validarSenha(senha: string): void {
  if (senha.length < TAMANHO_MINIMO_SENHA || senha.length > TAMANHO_MAXIMO_SENHA) {
    throw new SenhaFracaError(TAMANHO_MINIMO_SENHA);
  }
}

/** @throws {SenhaFracaError} */
export function guardarSenha(senha: string): string {
  validarSenha(senha);

  const sal = randomBytes(TAMANHO_SAL);
  const derivada = scryptSync(senha.normalize('NFKC'), sal, TAMANHO_CHAVE, {
    N,
    r: R,
    p: P,
    // Sem isso o Node recusa N alto com "memory limit exceeded" — o padrão
    // interno de maxmem é 32 MB, menos do que 2^16 precisa.
    maxmem: 128 * N * R * 2,
  });

  // Os parâmetros vão no texto para que a verificação use os DELE, e não os
  // atuais: é o que permite subir o custo no futuro sem derrubar o login de
  // quem já tem conta.
  return ['scrypt', N, R, P, sal.toString('base64url'), derivada.toString('base64url')].join(
    '$',
  );
}

/**
 * Confere a senha contra o hash guardado.
 *
 * **Nunca lança por hash malformado** — devolve `false`. Uma linha corrompida
 * no banco não pode virar erro 500 na tela de login, que é indistinguível de
 * "o sistema caiu" para quem está tentando entrar.
 */
export function conferirSenha(senha: string, guardada: string): boolean {
  const partes = guardada.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const n = Number(partes[1]);
  const r = Number(partes[2]);
  const p = Number(partes[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Teto contra hash adulterado pedindo memória absurda: sem isto, quem
  // conseguisse escrever no banco derrubaria o processo com um N gigante.
  if (n > 1 << 20 || r > 32 || p > 16) return false;

  const sal = Buffer.from(partes[4] ?? '', 'base64url');
  const esperada = Buffer.from(partes[5] ?? '', 'base64url');
  if (sal.length === 0 || esperada.length === 0) return false;

  try {
    const derivada = scryptSync(senha.normalize('NFKC'), sal, esperada.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });
    return timingSafeEqual(derivada, esperada);
  } catch {
    return false;
  }
}

/**
 * Hash descartável, usado quando o e-mail NÃO existe.
 *
 * Sem isto, login com e-mail desconhecido responde em 1ms e login com e-mail
 * real responde em 100ms — e a diferença, medida de fora, revela quem é
 * assinante. Gastar o mesmo tempo nos dois casos é o que torna
 * `CredenciaisInvalidasError` honestamente indistinguível.
 */
export const HASH_DE_COMPARACAO = guardarSenha('senha-que-nunca-sera-usada-por-ninguem');

/** A porta `HashDeSenha` implementada com o scrypt acima. */
export const hashScrypt: HashDeSenha = {
  validar: validarSenha,
  guardar: guardarSenha,
  conferir: conferirSenha,
  hashDeComparacao: HASH_DE_COMPARACAO,
};
