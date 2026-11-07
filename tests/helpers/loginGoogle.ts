import type {
  IdentidadeExterna,
  ProvedorDeIdentidade,
} from '../../src/domain/ports/ProvedorDeIdentidade.js';
import {
  CodigoDeAutorizacaoRecusadoError,
  ProviderIndisponivelError,
  RespostaInvalidaError,
} from '../../src/domain/errors/index.js';
import type { MotivoDoProvedorOauth } from '../../src/domain/errors/index.js';

/**
 * Provedor de identidade de MENTIRA (v0.67.0): valores sintéticos, nenhuma rede. O teste escreve
 * quem o "Google" vai dizer que a pessoa é; o código que chega é só um marcador.
 */
export const CODIGO = 'CODIGO-DE-AUTORIZACAO-SINTETICO';

/** `recusa:<motivo>` reproduz o 4xx do Google com `error` (v0.67.1). */
type RespostaDoProvedorFalso =
  | IdentidadeExterna
  | 'indisponivel'
  | 'recusa'
  | `recusa:${MotivoDoProvedorOauth}`;

export class ProvedorFalso implements ProvedorDeIdentidade {
  readonly nome = 'google';
  readonly pedidos: Array<{ codigo: string; verificador: string; uriDeRetorno: string }> =
    [];
  private readonly respostas = new Map<string, RespostaDoProvedorFalso>();

  /** O que `identidadePeloCodigo` devolve para este código. */
  quandoCodigo(codigo: string, r: RespostaDoProvedorFalso): this {
    this.respostas.set(codigo, r);
    return this;
  }

  urlDeAutorizacao(e: { estado: string; desafio: string; uriDeRetorno: string }): string {
    const q = new URLSearchParams({
      state: e.estado,
      code_challenge: e.desafio,
      redirect_uri: e.uriDeRetorno,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
  }

  async identidadePeloCodigo(e: {
    codigo: string;
    verificador: string;
    uriDeRetorno: string;
  }): Promise<IdentidadeExterna> {
    this.pedidos.push(e);
    const r = this.respostas.get(e.codigo);
    if (r === undefined || r === 'recusa') {
      throw new RespostaInvalidaError(this.nome, 'código recusado');
    }
    if (r === 'indisponivel')
      throw new ProviderIndisponivelError(this.nome, 'fora do ar');
    if (typeof r === 'string') {
      // O que o adapter de verdade lança quando o Google responde 4xx com `error` (v0.67.1).
      throw new CodigoDeAutorizacaoRecusadoError(
        this.nome,
        r.slice('recusa:'.length) as MotivoDoProvedorOauth,
      );
    }
    return r;
  }
}

export function identidade(
  sobrescreve: Partial<IdentidadeExterna> = {},
): IdentidadeExterna {
  return {
    sujeito: 'sub-sintetico-0001',
    email: 'ana@exemplo.test',
    emailVerificado: true,
    nome: 'Ana Exemplo',
    ...sobrescreve,
  };
}

/** O `state` que a URL do provedor falso carrega. */
export function estadoDaUrl(url: string): string {
  return new URL(url).searchParams.get('state') ?? '';
}
