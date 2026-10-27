import type { Clock } from '../../domain/ports/Clock.js';
import { clockDoSistema } from '../../domain/ports/Clock.js';
import { TokenBucketRateLimiter } from '../../infrastructure/ratelimit/TokenBucketRateLimiter.js';

/**
 * Freio de TENTATIVAS ERRADAS no login do /admin, por IP (v0.62.0). Reaproveita o `TokenBucketRateLimiter` do
 * projeto: cada senha errada gasta uma ficha; sem ficha, o IP fica barrado até a reposição (e, barrado, nem a
 * senha certa passa — é isso que torna inútil chutar sem parar). Em memória: reiniciar zera, como os outros freios.
 *
 * Só conta tentativa com credencial ERRADA. O pedido sem cabeçalho (o primeiro que todo navegador faz, para
 * descobrir que a página pede senha) não gasta ficha.
 */
export class LimiteDeTentativasDoAdmin {
  private readonly baldes = new Map<string, TokenBucketRateLimiter>();
  private readonly capacidade: number;
  private readonly janelaMs: number;
  private readonly clock: Clock;
  private readonly maximoDeIps: number;

  constructor(
    opcoes: {
      readonly erradasPorJanela?: number;
      readonly janelaMs?: number;
      readonly clock?: Clock;
      readonly maximoDeIps?: number;
    } = {},
  ) {
    this.capacidade = opcoes.erradasPorJanela ?? 10;
    this.janelaMs = opcoes.janelaMs ?? 15 * 60_000;
    this.clock = opcoes.clock ?? clockDoSistema;
    this.maximoDeIps = opcoes.maximoDeIps ?? 5000;
  }

  bloqueado(ip: string): boolean {
    const balde = this.baldes.get(ip);
    return balde !== undefined && balde.disponiveis < 1;
  }

  registrarErro(ip: string): void {
    let balde = this.baldes.get(ip);
    if (!balde) {
      this.podar();
      balde = new TokenBucketRateLimiter({
        capacidade: this.capacidade,
        janelaMs: this.janelaMs,
        clock: this.clock,
      });
      this.baldes.set(ip, balde);
    }
    balde.tentarAdquirir();
  }

  /** Baldes cheios (quem já se recuperou) saem, para a memória não crescer com IP que passou uma vez. */
  private podar(): void {
    if (this.baldes.size < this.maximoDeIps) return;
    for (const [ip, balde] of this.baldes) {
      if (balde.disponiveis >= this.capacidade) this.baldes.delete(ip);
    }
    if (this.baldes.size >= this.maximoDeIps) this.baldes.clear();
  }
}
