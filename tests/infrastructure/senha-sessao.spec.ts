import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SenhaFracaError } from '../../src/domain/errors/index.js';
import {
  conferirSenha,
  guardarSenha,
  TAMANHO_MINIMO_SENHA,
} from '../../src/infrastructure/seguranca/senha.js';
import {
  cookieDeSaida,
  cookieDeSessao,
  gerarToken,
  hashDoToken,
  NOME_COOKIE,
  tokenDoCabecalho,
} from '../../src/infrastructure/seguranca/sessao.js';

const SENHA = 'uma-senha-de-verdade-2026';

describe('senha — scrypt', () => {
  it('aceita a senha correta e recusa a errada', () => {
    const guardada = guardarSenha(SENHA);

    expect(conferirSenha(SENHA, guardada)).toBe(true);
    expect(conferirSenha(SENHA + 'x', guardada)).toBe(false);
  });

  it('nunca guarda a senha em claro', () => {
    expect(guardarSenha(SENHA)).not.toContain(SENHA);
  });

  it('produz hashes diferentes para a mesma senha', () => {
    // Sal aleatório por gravação. Sem isso o banco vira um oráculo de "estes
    // dois assinantes usam a mesma senha".
    expect(guardarSenha(SENHA)).not.toBe(guardarSenha(SENHA));
  });

  it('carrega os parâmetros junto do hash', () => {
    // É o que permite encarecer o scrypt daqui a dois anos sem invalidar a
    // senha de quem já é assinante: cada hash sabe como foi feito.
    const [algoritmo, n, r, p] = guardarSenha(SENHA).split('$');

    expect(algoritmo).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(16_384);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
  });

  it('confere contra um hash gravado com parâmetros mais baixos', () => {
    // Simula uma senha antiga, de antes de um aumento de custo. Se a
    // verificação usasse os parâmetros de HOJE em vez dos do hash, todo mundo
    // seria deslogado no dia em que o N subisse.
    const antigo = ['scrypt', 1024, 8, 1].join('$');
    const partes = guardarSenha(SENHA).split('$');
    // Regravação manual com N baixo, usando o mesmo formato.
    const sal = Buffer.from(partes[4] ?? '', 'base64url');
    const derivada = scryptSync(SENHA.normalize('NFKC'), sal, 64, {
      N: 1024,
      r: 8,
      p: 1,
    });
    const gravado = `${antigo}$${sal.toString('base64url')}$${derivada.toString('base64url')}`;

    expect(conferirSenha(SENHA, gravado)).toBe(true);
  });

  it('recusa senha curta em vez de guardar algo fraco', () => {
    expect(() => guardarSenha('123')).toThrow(SenhaFracaError);
    expect(() => guardarSenha('a'.repeat(TAMANHO_MINIMO_SENHA))).not.toThrow();
  });

  it('devolve false em hash corrompido, sem lançar', () => {
    // Uma linha estragada no banco não pode virar 500 na tela de login — que é
    // indistinguível de "o sistema caiu" para quem está tentando entrar.
    expect(conferirSenha(SENHA, 'lixo')).toBe(false);
    expect(conferirSenha(SENHA, 'scrypt$x$y$z$a$b')).toBe(false);
    expect(conferirSenha(SENHA, '')).toBe(false);
  });

  it('recusa hash que pede memória absurda, em vez de derrubar o processo', () => {
    // Defesa contra quem conseguisse escrever no banco: N gigante travaria o
    // contêiner inteiro na primeira tentativa de login.
    expect(conferirSenha(SENHA, 'scrypt$1073741824$8$1$c2Fs$aGFzaA')).toBe(false);
  });
});

describe('sessão — token e cookie', () => {
  it('gera tokens diferentes a cada chamada', () => {
    expect(gerarToken()).not.toBe(gerarToken());
  });

  it('o hash não devolve o token', () => {
    // O banco guarda só o hash: vazamento da tabela não vira sessão aberta.
    const token = gerarToken();
    expect(hashDoToken(token)).not.toContain(token);
    expect(hashDoToken(token)).toBe(hashDoToken(token));
  });

  it('marca HttpOnly, SameSite e Path', () => {
    const cookie = cookieDeSessao('abc', { seguro: true });

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
  });

  it('omite Secure quando o servidor não está em HTTPS', () => {
    // Em http://localhost o navegador DESCARTA cookie `Secure`, e o sintoma é
    // "entrei e voltei para o login" — que não parece problema de configuração.
    expect(cookieDeSessao('abc', { seguro: false })).not.toContain('Secure');
  });

  it('o cookie de saída expira na hora', () => {
    expect(cookieDeSaida({ seguro: true })).toContain('Max-Age=0');
  });

  it('lê o token entre outros cookies', () => {
    const cabecalho = `outro=1; ${NOME_COOKIE}=meu-token; mais=2`;
    expect(tokenDoCabecalho(cabecalho)).toBe('meu-token');
  });

  it('não confunde um cookie de nome parecido', () => {
    // `processovivo_sessao_antiga` contém o nome inteiro como prefixo; casar por
    // "começa com" pegaria o cookie errado e a sessão nunca resolveria.
    expect(tokenDoCabecalho('processovivo_sessao_antiga=x')).toBeUndefined();
  });

  it('devolve undefined quando não há cookie nenhum', () => {
    expect(tokenDoCabecalho(undefined)).toBeUndefined();
    expect(tokenDoCabecalho('')).toBeUndefined();
    expect(tokenDoCabecalho(`${NOME_COOKIE}=`)).toBeUndefined();
  });
});
