import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../domain/ports/Clock.js';

/**
 * O parâmetro `state` do OAuth e o PKCE da conexão com o Google Drive (v0.42.0).
 *
 * O `state` é a defesa contra CSRF no retorno: sem ele, um atacante convenceria o navegador do
 * advogado a "concluir" uma conexão com a conta Google DO ATACANTE, e as peças dele iriam
 * parar no Drive de outra pessoa. Por isso o `state`:
 *
 * - é ASSINADO (HMAC-SHA-256 com chave própria do servidor): não se fabrica nem se adultera;
 * - é de USO ÚNICO: o nonce sai da memória no primeiro uso, e repetir o mesmo retorno é recusado;
 * - tem VALIDADE curta (10 minutos): a pessoa que abandonou a tela do Google não deixa um
 *   convite eterno rondando;
 * - CARREGA o workspace que o pediu, dentro da parte assinada (v0.42.1): o retorno do Google é
 *   uma navegação sem cookie nem chave de API, e é do `state` que sai o dono da conexão. Se a
 *   navegação trouxer uma sessão por cookie de OUTRO workspace, o retorno é recusado (e o `state`
 *   não é gasto, para não permitir que alguém sabote a conexão alheia).
 *
 * O PKCE soma uma segunda trava: o `code_verifier` nasce aqui, fica só na memória do servidor
 * e é o que o Google exige junto do código — um código interceptado sozinho não serve.
 *
 * Tudo em MEMÓRIA, de propósito: um redeploy no meio da autorização só obriga a pessoa a clicar
 * "Conectar" de novo. Persistir um verificador PKCE seria guardar um segredo a mais sem ganho.
 */

export const VALIDADE_DO_ESTADO_MS = 10 * 60_000;
/** Teto de conexões iniciadas e não concluídas por workspace: abandono não acumula memória. */
const MAXIMO_PENDENTES_POR_WORKSPACE = 5;

export type MotivoDoEstadoRecusado = 'invalido' | 'expirado' | 'usado' | 'de_outra_conta';

export class EstadoDeConexaoRecusado extends Error {
  constructor(readonly motivo: MotivoDoEstadoRecusado) {
    super(`state do OAuth recusado: ${motivo}`);
    this.name = 'EstadoDeConexaoRecusado';
  }
}

interface Pendente {
  readonly workspace: string;
  readonly verificador: string;
  readonly expiraEm: number;
  readonly criadoEm: number;
}

export interface OpcoesEstadosDeConexao {
  /** Segredo do HMAC. Derivado da chave do cofre pelo composition root. */
  readonly segredo: Buffer;
  readonly clock: Clock;
  readonly validadeMs?: number;
  /** Só para teste: bytes aleatórios determinísticos. */
  readonly aleatorio?: (n: number) => Buffer;
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export class EstadosDeConexao {
  private readonly pendentes = new Map<string, Pendente>();
  private readonly validadeMs: number;
  private readonly aleatorio: (n: number) => Buffer;

  constructor(private readonly opcoes: OpcoesEstadosDeConexao) {
    this.validadeMs = opcoes.validadeMs ?? VALIDADE_DO_ESTADO_MS;
    this.aleatorio = opcoes.aleatorio ?? randomBytes;
    if (opcoes.segredo.length < 16) {
      throw new Error('segredo do state do OAuth curto demais');
    }
  }

  /** Um `state` novo, o verificador PKCE (que fica aqui) e o desafio (que vai ao Google). */
  emitir(workspace: string): { readonly estado: string; readonly desafio: string } {
    const agora = this.opcoes.clock.agora().getTime();
    this.podar(agora);
    this.limitar(workspace);

    const nonce = b64(this.aleatorio(18));
    const verificador = b64(this.aleatorio(32));
    const expiraEm = agora + this.validadeMs;
    this.pendentes.set(nonce, { workspace, verificador, expiraEm, criadoEm: agora });

    const corpo = b64(JSON.stringify({ n: nonce, w: workspace, e: expiraEm }));
    return {
      estado: `${corpo}.${this.assinar(corpo)}`,
      desafio: createHash('sha256').update(verificador).digest('base64url'),
    };
  }

  /**
   * Confere e GASTA o `state`. Devolve o workspace dele e o verificador PKCE da conexão.
   * `workspaceEsperado`, se vier (a sessão por cookie que fez a navegação), tem de ser o mesmo:
   * recusa SEM gastar o nonce, para ninguém sabotar a conexão alheia mandando um `state` errado.
   * @throws {EstadoDeConexaoRecusado} assinatura ruim, expirado, já usado ou de outro workspace.
   */
  consumir(
    estado: string,
    workspaceEsperado?: string,
  ): { readonly workspace: string; readonly verificador: string } {
    const dados = this.ler(estado);
    if (workspaceEsperado !== undefined && dados.w !== workspaceEsperado) {
      throw new EstadoDeConexaoRecusado('de_outra_conta');
    }
    const pendente = this.pendentes.get(dados.n);
    if (!pendente) throw new EstadoDeConexaoRecusado('usado');
    // Gasta antes de conferir a validade: expirado ou não, este `state` não volta.
    this.pendentes.delete(dados.n);
    if (pendente.workspace !== dados.w) throw new EstadoDeConexaoRecusado('invalido');
    if (this.opcoes.clock.agora().getTime() > dados.e) {
      throw new EstadoDeConexaoRecusado('expirado');
    }
    return { workspace: dados.w, verificador: pendente.verificador };
  }

  private ler(estado: string): { n: string; w: string; e: number } {
    const partes = estado.split('.');
    const corpo = partes[0];
    const mac = partes[1];
    if (partes.length !== 2 || !corpo || !mac || !this.macConfere(corpo, mac)) {
      throw new EstadoDeConexaoRecusado('invalido');
    }
    let dados: { n?: unknown; w?: unknown; e?: unknown };
    try {
      dados = JSON.parse(
        Buffer.from(corpo, 'base64url').toString('utf8'),
      ) as typeof dados;
    } catch {
      throw new EstadoDeConexaoRecusado('invalido');
    }
    if (
      typeof dados.n !== 'string' ||
      typeof dados.w !== 'string' ||
      typeof dados.e !== 'number'
    ) {
      throw new EstadoDeConexaoRecusado('invalido');
    }
    return { n: dados.n, w: dados.w, e: dados.e };
  }

  /** Quantos estão pendentes (diagnóstico e teste). */
  get quantidadePendente(): number {
    return this.pendentes.size;
  }

  private assinar(corpo: string): string {
    return createHmac('sha256', this.opcoes.segredo)
      .update(`drive-state\0${corpo}`)
      .digest('base64url');
  }

  private macConfere(corpo: string, mac: string): boolean {
    const esperado = Buffer.from(this.assinar(corpo));
    const recebido = Buffer.from(mac);
    return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
  }

  private podar(agora: number): void {
    for (const [nonce, p] of this.pendentes) {
      if (p.expiraEm < agora) this.pendentes.delete(nonce);
    }
  }

  private limitar(workspace: string): void {
    const doWorkspace = [...this.pendentes.entries()]
      .filter(([, p]) => p.workspace === workspace)
      .sort((a, b) => a[1].criadoEm - b[1].criadoEm);
    while (doWorkspace.length >= MAXIMO_PENDENTES_POR_WORKSPACE) {
      const maisAntigo = doWorkspace.shift();
      if (maisAntigo) this.pendentes.delete(maisAntigo[0]);
    }
  }
}
