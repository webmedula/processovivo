import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../../../domain/ports/Logger.js';
import type {
  Acesso,
  FiltroDeAcessos,
  RegistroDeAcessos,
} from '../../../domain/ports/RegistroDeAcessos.js';

interface Linha {
  instante: string;
  ip: string;
  porta: number | null;
  workspace: string | null;
}

const LIMITE_PADRAO = 1_000;
const LIMITE_MAXIMO = 10_000;
/** Um aviso por minuto, no máximo: com o banco travado, cada requisição falharia e o log viraria ruído. */
const INTERVALO_ENTRE_AVISOS_MS = 60_000;

export class RegistroDeAcessosSqlite implements RegistroDeAcessos {
  private ultimoAviso = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly logger: Logger,
  ) {}

  registrar(acesso: Acesso): void {
    try {
      this.db
        .prepare(
          'INSERT INTO registros_de_acesso (instante, ip, porta, workspace) VALUES (?, ?, ?, ?)',
        )
        .run(
          acesso.instante.toISOString(),
          acesso.ip,
          acesso.porta ?? null,
          acesso.workspace ?? null,
        );
    } catch (erro) {
      // O aviso não leva IP nem conta: o log do contêiner não é o lugar desse dado.
      const agora = Date.now();
      if (agora - this.ultimoAviso < INTERVALO_ENTRE_AVISOS_MS) return;
      this.ultimoAviso = agora;
      this.logger.warn('registro de acesso não gravado', {
        erro: erro instanceof Error ? erro.name : 'desconhecido',
      });
    }
  }

  async listar(filtro: FiltroDeAcessos, limite = LIMITE_PADRAO): Promise<Acesso[]> {
    const teto = Math.min(Math.max(limite, 1), LIMITE_MAXIMO);
    const cond = ['instante >= ?', 'instante <= ?'];
    const args: Array<string | number> = [
      filtro.desde.toISOString(),
      filtro.ate.toISOString(),
    ];
    if (filtro.ip) {
      cond.push('ip = ?');
      args.push(filtro.ip);
    }
    if (filtro.workspace) {
      cond.push('workspace = ?');
      args.push(filtro.workspace);
    }
    args.push(teto);
    const linhas = this.db
      .prepare(
        `SELECT instante, ip, porta, workspace FROM registros_de_acesso
          WHERE ${cond.join(' AND ')}
          ORDER BY instante DESC
          LIMIT ?`,
      )
      .all(...args) as unknown as Linha[];
    return linhas.map((l) => ({
      instante: new Date(l.instante),
      ip: l.ip,
      ...(l.porta === null ? {} : { porta: Number(l.porta) }),
      ...(l.workspace === null ? {} : { workspace: l.workspace }),
    }));
  }

  async apagarAnterioresA(limite: Date): Promise<number> {
    const r = this.db
      .prepare('DELETE FROM registros_de_acesso WHERE instante < ?')
      .run(limite.toISOString());
    return Number(r.changes);
  }
}
