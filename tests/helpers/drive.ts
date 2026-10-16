import { createHash, randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import type {
  ArquivoNoDestino,
  AutorizacaoDoDestino,
  ConteudoParaEnvio,
  ResultadoDaPasta,
} from '../../src/domain/entities/DestinoDePecas.js';
import {
  ArquivoRemovidoNoDestinoError,
  AutorizacaoDoDestinoRevogadaError,
  AutorizacaoDoDestinoVencidaError,
} from '../../src/domain/errors/index.js';
import type { Clock } from '../../src/domain/ports/Clock.js';
import type { DestinoExternoDePecas } from '../../src/domain/ports/DestinoExternoDePecas.js';
import type { Logger } from '../../src/domain/ports/Logger.js';
import { EstadosDeConexao } from '../../src/application/politicas/estadosDeConexao.js';
import {
  ServicoDrive,
  type FonteDePecasParaODrive,
  type PecaEmGuardaParaODrive,
  type PecaParaODrive,
} from '../../src/application/services/ServicoDrive.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioDoDriveSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioDoDriveSqlite.js';
import { Cofre } from '../../src/infrastructure/seguranca/cofre.js';
import {
  CODIGO_DO_GOOGLE,
  TOKEN_DE_ACESSO,
  TOKEN_DE_RENOVACAO,
} from './transporteDoDrive.js';

/** Número CNJ com dígito verificador válido (sintético). */
export const NUMERO = '99999019620268099999';
export const NUMERO_FORMATADO = '9999901-96.2026.8.09.9999';

export class RelogioDeTeste implements Clock {
  constructor(private t = new Date('2026-10-14T12:00:00.000Z').getTime()) {}
  agora(): Date {
    return new Date(this.t);
  }
  monotonico(): number {
    return this.t;
  }
  avancar(ms: number): void {
    this.t += ms;
  }
}

export interface ChamadaAoDestino {
  readonly op:
    | 'iniciarConexao'
    | 'concluirConexao'
    | 'renovar'
    | 'garantirPasta'
    | 'conferirArquivo'
    | 'enviarArquivo'
    | 'desconectar';
  readonly detalhe?: Record<string, unknown>;
}

interface ArquivoDoDrive {
  id: string;
  nome: string;
  paiId: string;
  hash: string;
  trashed: boolean;
  descricao: string | undefined;
}

async function lerTudo(c: ConteudoParaEnvio): Promise<Buffer> {
  const partes: Uint8Array[] = [];
  if (c.tamanho > 0) for await (const p of c.ler(0, c.tamanho - 1)) partes.push(p);
  return Buffer.concat(partes);
}

/**
 * Um Drive EM MEMÓRIA que cumpre a porta, com estado de verdade (pastas, arquivos, lixeira) e
 * falhas programáveis. Nada de rede. Guarda cada chamada para o teste conferir o que foi (e o que
 * NÃO foi) ao Google.
 */
export class DestinoFalso implements DestinoExternoDePecas {
  readonly nome = 'drive-falso';
  readonly chamadas: ChamadaAoDestino[] = [];
  readonly pastas = new Map<
    string,
    { id: string; nome: string; paiId?: string; trashed: boolean }
  >();
  readonly arquivos = new Map<string, ArquivoDoDrive>();
  /** Falhas a lançar no PRÓXIMO envio (em ordem); `undefined` = deixa passar. */
  falhasDeEnvio: Array<Error | undefined> = [];
  falhaNaRenovacao: Error | undefined;
  /** Faz o envio de um nome específico falhar sempre. */
  falhaPorNome = new Map<string, Error>();
  /** O primeiro `garantirPasta` depois disto responde "removida" (para simular o meio do lote). */
  vencerAutorizacaoAntes = 0;
  atrasoDaRenovacao: Promise<void> | undefined;
  /** Segura o PRÓXIMO envio até a promessa resolver (teste de navegador: cancelar no meio). */
  segurarEnvio: Promise<void> | undefined;
  escopoConcedido = true;
  /** O relógio do cenário: o token novo vale 1 h a partir DELE. */
  agora: () => Date = () => new Date('2026-10-14T12:00:00.000Z');
  private seq = 0;

  contar(op: ChamadaAoDestino['op']): number {
    return this.chamadas.filter((c) => c.op === op).length;
  }

  get envios(): ArquivoDoDrive[] {
    return [...this.arquivos.values()];
  }

  apagarArquivo(id: string): void {
    const a = this.arquivos.get(id);
    if (a) a.trashed = true;
  }
  restaurarArquivo(id: string): void {
    const a = this.arquivos.get(id);
    if (a) a.trashed = false;
  }
  apagarPasta(id: string): void {
    const p = this.pastas.get(id);
    if (p) p.trashed = true;
  }

  iniciarConexao(e: { estado: string; desafio: string; uriDeRetorno: string }): {
    url: string;
  } {
    this.chamadas.push({ op: 'iniciarConexao' });
    return {
      url: `https://accounts.google.com/falso?state=${encodeURIComponent(e.estado)}&cc=${e.desafio}`,
    };
  }

  async concluirConexao(e: {
    codigo: string;
    verificador: string;
  }): Promise<AutorizacaoDoDestino> {
    this.chamadas.push({ op: 'concluirConexao', detalhe: { codigo: e.codigo } });
    if (!this.escopoConcedido) {
      throw new AutorizacaoDoDestinoRevogadaError('escopo_negado', 'sem escopo');
    }
    return {
      tokenDeAcesso: TOKEN_DE_ACESSO,
      tokenDeRenovacao: TOKEN_DE_RENOVACAO,
      expiraEm: new Date(this.agora().getTime() + 3_600_000),
    };
  }

  async renovarAutorizacao(a: AutorizacaoDoDestino): Promise<AutorizacaoDoDestino> {
    this.chamadas.push({ op: 'renovar' });
    if (this.atrasoDaRenovacao) await this.atrasoDaRenovacao;
    if (this.falhaNaRenovacao) throw this.falhaNaRenovacao;
    return {
      tokenDeAcesso: `${TOKEN_DE_ACESSO}-RENOVADO-${this.contar('renovar')}`,
      tokenDeRenovacao: a.tokenDeRenovacao,
      expiraEm: new Date(this.agora().getTime() + 3_600_000),
    };
  }

  async garantirPasta(
    _a: AutorizacaoDoDestino,
    p: { nome: string; paiId?: string; idConhecido?: string },
  ): Promise<ResultadoDaPasta> {
    this.chamadas.push({
      op: 'garantirPasta',
      detalhe: { nome: p.nome, paiId: p.paiId, idConhecido: p.idConhecido },
    });
    if (p.idConhecido) {
      const existente = this.pastas.get(p.idConhecido);
      if (existente && !existente.trashed) {
        return { pasta: { id: existente.id, link: link(existente.id) }, recriada: false };
      }
    }
    this.seq += 1;
    const id = `pasta-${this.seq}`;
    this.pastas.set(id, {
      id,
      nome: p.nome,
      ...(p.paiId ? { paiId: p.paiId } : {}),
      trashed: false,
    });
    return { pasta: { id, link: link(id) }, recriada: p.idConhecido !== undefined };
  }

  async conferirArquivo(
    _a: AutorizacaoDoDestino,
    id: string,
  ): Promise<'existe' | 'removido'> {
    this.chamadas.push({ op: 'conferirArquivo', detalhe: { id } });
    const a = this.arquivos.get(id);
    return a && !a.trashed ? 'existe' : 'removido';
  }

  async enviarArquivo(
    a: AutorizacaoDoDestino,
    p: {
      nome: string;
      paiId: string;
      mimetype: string;
      conteudo: ConteudoParaEnvio;
      descricao?: string;
      arquivoId?: string;
    },
  ): Promise<ArquivoNoDestino> {
    this.chamadas.push({
      op: 'enviarArquivo',
      detalhe: {
        nome: p.nome,
        paiId: p.paiId,
        arquivoId: p.arquivoId,
        token: a.tokenDeAcesso,
      },
    });
    if (this.segurarEnvio) {
      const espera = this.segurarEnvio;
      this.segurarEnvio = undefined;
      await espera;
    }
    if (this.vencerAutorizacaoAntes > 0) {
      this.vencerAutorizacaoAntes -= 1;
      throw new AutorizacaoDoDestinoVencidaError();
    }
    const porNome = this.falhaPorNome.get(p.nome);
    if (porNome) throw porNome;
    if (this.falhasDeEnvio.length > 0) {
      const f = this.falhasDeEnvio.shift();
      if (f) throw f;
    }
    const bytes = await lerTudo(p.conteudo);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (p.arquivoId) {
      const existente = this.arquivos.get(p.arquivoId);
      if (!existente || existente.trashed) throw new ArquivoRemovidoNoDestinoError();
      existente.nome = p.nome;
      existente.hash = hash;
      existente.descricao = p.descricao;
      return { id: existente.id, link: link(existente.id) };
    }
    this.seq += 1;
    const id = `arq-${this.seq}`;
    this.arquivos.set(id, {
      id,
      nome: p.nome,
      paiId: p.paiId,
      hash,
      trashed: false,
      descricao: p.descricao,
    });
    return { id, link: link(id) };
  }

  async desconectar(): Promise<void> {
    this.chamadas.push({ op: 'desconectar' });
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function link(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`;
}

export interface PecaDeTeste extends PecaParaODrive {
  /** Conteúdo na guarda; ausente = a peça só existe no "tribunal" (ou venceu). */
  readonly bytes?: Uint8Array;
  readonly conversao?: 'nenhuma' | 'imagem' | 'html';
  readonly observacao?: string;
}

/** A Pasta digital de mentira: lista, guarda e um "tribunal" que entrega ao ser pedido. */
export class FonteFalsa implements FonteDePecasParaODrive {
  processoSigiloso = false;
  readonly guarda = new Map<
    string,
    { bytes: Uint8Array; conversao: 'nenhuma' | 'imagem' | 'html'; observacao?: string }
  >();
  /** O que o "tribunal" entrega quando a peça é pedida. */
  readonly noTribunal = new Map<string, Uint8Array>();
  readonly pedidas: string[] = [];
  /** Falha programada de `solicitar`. */
  erroAoSolicitar: Error | undefined;
  /** Estado que `estado()` responde para a peça pedida que não chegou. */
  estadoDasQueNaoChegam: 'na_fila' | 'nao_obtida' | 'nao_baixada' = 'nao_obtida';
  retomarEm: Date | undefined;

  constructor(public pecas: PecaDeTeste[]) {
    for (const p of pecas) {
      if (p.bytes) {
        this.guarda.set(p.pecaId, {
          bytes: p.bytes,
          conversao: p.conversao ?? 'nenhuma',
          ...(p.observacao ? { observacao: p.observacao } : {}),
        });
      }
    }
  }

  async listar(): Promise<{
    processoSigiloso: boolean;
    pecas: readonly PecaParaODrive[];
  }> {
    return {
      processoSigiloso: this.processoSigiloso,
      pecas: this.pecas.map(({ pecaId, ordem, rotulo, data, numeroDoAto, sigilosa }) => ({
        pecaId,
        ordem,
        rotulo,
        data,
        numeroDoAto,
        sigilosa,
      })),
    };
  }

  async emGuarda(
    _ws: string,
    _n: string,
    pecaId: string,
  ): Promise<PecaEmGuardaParaODrive | undefined> {
    const g = this.guarda.get(pecaId);
    if (!g) return undefined;
    return {
      tamanho: g.bytes.length,
      conversao: g.conversao,
      observacao: g.observacao,
      ler: async function* (inicio, fim) {
        yield g.bytes.slice(inicio, fim + 1);
      },
    };
  }

  async solicitar(_ws: string, _n: string, pecaId: string): Promise<void> {
    this.pedidas.push(pecaId);
    if (this.erroAoSolicitar) throw this.erroAoSolicitar;
    const b = this.noTribunal.get(pecaId);
    if (b) this.guarda.set(pecaId, { bytes: b, conversao: 'nenhuma' });
  }

  async estado(): Promise<{
    estado: 'na_fila' | 'nao_obtida' | 'nao_baixada';
    retomarEm: Date | undefined;
  }> {
    return { estado: this.estadoDasQueNaoChegam, retomarEm: this.retomarEm };
  }
}

export function peca(
  ordem: number,
  extra: Partial<PecaDeTeste> & { conteudo?: string } = {},
): PecaDeTeste {
  const { conteudo, ...resto } = extra;
  return {
    pecaId: `p${ordem}`,
    ordem,
    rotulo: `Petição ${ordem}`,
    data: new Date(`2026-09-${String(10 + ordem).padStart(2, '0')}T15:00:00.000Z`),
    numeroDoAto: ordem,
    sigilosa: false,
    bytes: new TextEncoder().encode(conteudo ?? `%PDF-1.4 peça sintética ${ordem}`),
    ...resto,
  };
}

/** Logger que guarda TUDO, para o teste varrer por token e segredo. */
export class LoggerEspiao implements Logger {
  readonly linhas: string[] = [];
  private registrar(nivel: string, m: string, c?: Record<string, unknown>): void {
    this.linhas.push(`${nivel} ${m} ${JSON.stringify(c ?? {})}`);
  }
  debug(m: string, c?: Record<string, unknown>): void {
    this.registrar('debug', m, c);
  }
  info(m: string, c?: Record<string, unknown>): void {
    this.registrar('info', m, c);
  }
  warn(m: string, c?: Record<string, unknown>): void {
    this.registrar('warn', m, c);
  }
  error(m: string, c?: Record<string, unknown>): void {
    this.registrar('error', m, c);
  }
  child(): Logger {
    return this;
  }
}

export interface CenarioDrive {
  readonly servico: ServicoDrive;
  readonly destino: DestinoFalso;
  readonly fonte: FonteFalsa;
  readonly repo: RepositorioDoDriveSqlite;
  readonly relogio: RelogioDeTeste;
  readonly logger: LoggerEspiao;
  readonly esperas: number[];
  /** Chamado a cada espera do serviço (para cancelar no meio de uma espera). */
  aoEsperar: ((ms: number) => void) | undefined;
  readonly estados: EstadosDeConexao;
  plano: boolean;
  /** Fluxo real: inicia, "volta do Google" e conclui. */
  conectar(workspace?: string): Promise<void>;
}

export function montarCenario(
  pecas: PecaDeTeste[],
  opcoes: { maxSimultaneos?: number; pausaEntrePecasMs?: number } = {},
): CenarioDrive {
  const relogio = new RelogioDeTeste();
  const destino = new DestinoFalso();
  const fonte = new FonteFalsa(pecas);
  destino.agora = () => relogio.agora();
  const logger = new LoggerEspiao();
  const db = abrirBanco(':memory:');
  const repo = new RepositorioDoDriveSqlite(
    db,
    Cofre.comChaveBase64(Cofre.gerarChaveBase64()),
    logger,
  );
  const estados = new EstadosDeConexao({ segredo: randomBytes(32), clock: relogio });
  const esperas: number[] = [];
  let seq = 0;
  const cenario: CenarioDrive = {
    destino,
    fonte,
    repo,
    relogio,
    logger,
    esperas,
    aoEsperar: undefined,
    estados,
    plano: true,
    servico: new ServicoDrive({
      destino,
      repositorio: repo,
      fonte,
      estados,
      conferirPlano: async () => cenario.plano,
      logger,
      uriDeRetorno: 'https://app.exemplo.test/v1/drive/retorno',
      maxSimultaneos: opcoes.maxSimultaneos ?? 2,
      pausaEntrePecasMs: opcoes.pausaEntrePecasMs ?? 0,
      clock: relogio,
      esperar: async (ms) => {
        esperas.push(ms);
        cenario.aoEsperar?.(ms);
      },
      gerarId: () => `envio-${(seq += 1)}`,
    }),
    async conectar(workspace = 'ws-a') {
      const { url } = await cenario.servico.iniciarConexao(workspace);
      const estado = new URL(url).searchParams.get('state') as string;
      const r = await cenario.servico.concluirConexao({
        codigo: CODIGO_DO_GOOGLE,
        estado,
      });
      if (!r.ok) throw new Error(`conexão de teste falhou: ${r.motivo}`);
    },
  };
  return cenario;
}

/** Espia: o `vi` fica aqui para os testes não importarem em dois lugares. */
export { vi };
