import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type { ProcessoSerializado } from '../persistencia/processoSerializacao.js';
import {
  reidratarProcesso,
  serializarProcesso,
} from '../persistencia/processoSerializacao.js';
import type { Processo } from '../../domain/entities/Processo.js';
import type { Cache } from '../../domain/ports/Cache.js';
import type {
  CapacidadesProvider,
  ProcessoProvider,
} from '../../domain/ports/ProcessoProvider.js';

export interface OpcoesCachedProcessoProvider {
  readonly provider: ProcessoProvider;
  readonly cache: Cache;
  /** TTL da consulta por número. Padrão: 900s (15 min). */
  readonly ttlNumeroSegundos?: number;
  /**
   * TTL da busca por OAB. Bem menor por padrão (300s): a carteira do advogado é
   * a tela que ele fica atualizando, e servir carteira velha é o pior tipo de
   * erro deste produto — ele acha que não há novidade quando há.
   */
  readonly ttlOabSegundos?: number;
}

/**
 * Decorator de cache sobre QUALQUER `ProcessoProvider` — inclusive sobre o
 * orquestrador inteiro.
 *
 * Decorator e não um `if (cache)` dentro de cada adapter: assim a política de
 * cache existe em um lugar só, e ligar ou desligar cache é montar (ou não
 * montar) um objeto no composition root. Nenhum adapter sabe que cache existe.
 *
 * A entidade é reidratada em vez de devolvida direto do JSON, e a `procedencia`
 * volta com `deCache: true` — quem consome consegue distinguir dado fresco de
 * dado servido da memória, o que importa quando a resposta vira base de prazo.
 */
export class CachedProcessoProvider implements ProcessoProvider {
  readonly nome: string;
  readonly capacidades: CapacidadesProvider;

  private readonly provider: ProcessoProvider;
  private readonly cache: Cache;
  private readonly ttlNumero: number;
  private readonly ttlOab: number;

  constructor(opcoes: OpcoesCachedProcessoProvider) {
    this.provider = opcoes.provider;
    this.cache = opcoes.cache;
    this.nome = opcoes.provider.nome;
    this.capacidades = opcoes.provider.capacidades;
    this.ttlNumero = opcoes.ttlNumeroSegundos ?? 900;
    this.ttlOab = opcoes.ttlOabSegundos ?? 300;
  }

  async buscarPorNumero(numeroProcesso: string): Promise<Processo> {
    const numero = NumeroCNJ.criar(numeroProcesso);
    const chave = `processo:numero:${numero.digitos}`;

    const emCache = await this.cache.get<ProcessoSerializado>(chave);
    if (emCache) return reidratarProcesso(emCache, true);

    const processo = await this.provider.buscarPorNumero(numero.digitos);
    await this.cache.set(chave, serializarProcesso(processo), this.ttlNumero);
    return processo;
  }

  async buscarPorOab(oab: string, uf: string): Promise<Processo[]> {
    const chave = `processo:oab:${oab}:${uf.toUpperCase()}`;

    const emCache = await this.cache.get<ProcessoSerializado[]>(chave);
    if (emCache) return emCache.map((p) => reidratarProcesso(p, true));

    const processos = await this.provider.buscarPorOab(oab, uf);
    await this.cache.set(chave, processos.map(serializarProcesso), this.ttlOab);
    return processos;
  }

  /** Nunca cacheado: healthCheck em cache é healthCheck inútil. */
  async healthCheck(): Promise<boolean> {
    return this.provider.healthCheck();
  }

  /** Invalida a entrada de um processo — use após um webhook de atualização. */
  async invalidar(numeroProcesso: string): Promise<void> {
    const numero = NumeroCNJ.criar(numeroProcesso);
    await this.cache.delete(`processo:numero:${numero.digitos}`);
  }
}

