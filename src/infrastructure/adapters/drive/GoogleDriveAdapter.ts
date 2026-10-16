import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type {
  ArquivoNoDestino,
  AutorizacaoDoDestino,
  ConteudoParaEnvio,
  ResultadoDaPasta,
} from '../../../domain/entities/DestinoDePecas.js';
import {
  ArquivoRemovidoNoDestinoError,
  AutorizacaoDoDestinoRevogadaError,
  AutorizacaoDoDestinoVencidaError,
  DestinoIndisponivelError,
  DestinoLimitouError,
  DestinoRecusouError,
  DestinoSemEspacoError,
  DomainError,
  PastaRemovidaNoDestinoError,
  RespostaInvalidaError,
} from '../../../domain/errors/index.js';
import type { Clock } from '../../../domain/ports/Clock.js';
import { clockDoSistema } from '../../../domain/ports/Clock.js';
import type { DestinoExternoDePecas } from '../../../domain/ports/DestinoExternoDePecas.js';
import type { RespostaDoTransporte, TransporteDoDrive } from './TransporteDoDrive.js';

/**
 * O ÚNICO escopo que o sistema pede ao Google: `drive.file` — acesso só aos arquivos e
 * pastas que o próprio sistema criou. Nunca `drive`, nunca `drive.readonly`, nunca
 * `drive.metadata`: pedir mais não é configuração, é outro produto (decisão do dono).
 * Há teste que falha se esta constante mudar.
 */
export const ESCOPO_DO_DRIVE = 'https://www.googleapis.com/auth/drive.file';

const URL_DE_AUTORIZACAO = 'https://accounts.google.com/o/oauth2/v2/auth';
const URL_DO_TOKEN = 'https://oauth2.googleapis.com/token';
const URL_DA_REVOGACAO = 'https://oauth2.googleapis.com/revoke';
const URL_DOS_ARQUIVOS = 'https://www.googleapis.com/drive/v3/files';
const URL_DO_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const URL_DA_SAUDE = 'https://accounts.google.com/.well-known/openid-configuration';
const TIPO_DE_PASTA = 'application/vnd.google-apps.folder';

/**
 * Até aqui o arquivo vai num único pedido multipart (cabe na memória sem esforço); acima
 * disso, upload RESUMÍVEL, em pedaços — o Google recomenda o resumível a partir de ~5 MB, e
 * uma peça pode ter centenas de MB (o teto de um PDF na guarda é 300 MB).
 */
export const LIMITE_DO_UPLOAD_SIMPLES_BYTES = 5 * 1024 * 1024;
/** Múltiplo de 256 KiB, como o Google exige para os pedaços do resumível. */
export const TAMANHO_DO_PEDACO_BYTES = 8 * 1024 * 1024;

const CAMPOS_DO_ARQUIVO = 'id,webViewLink';

const esquemaDoArquivo = z.object({
  id: z.string().min(1),
  webViewLink: z.string().optional(),
  trashed: z.boolean().optional(),
});
const esquemaDoToken = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

export interface OpcoesGoogleDriveAdapter {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly transporte: TransporteDoDrive;
  readonly clock?: Clock;
  /** Só para teste: o padrão são as constantes acima. */
  readonly limiteSimplesBytes?: number;
  readonly tamanhoDoPedacoBytes?: number;
}

/**
 * Google Drive v3 por REST, sem o SDK (`googleapis` é uma dependência enorme para o que
 * o sistema usa: criar pasta, enviar e conferir arquivo).
 *
 * Nada aqui escreve token, segredo, nome de arquivo ou texto do Google em erro ou log: os
 * erros carregam só código e status HTTP. A única leitura é "o que EU criei ainda existe?",
 * pelo id guardado.
 */
export class GoogleDriveAdapter implements DestinoExternoDePecas {
  readonly nome = 'google-drive';
  private readonly clock: Clock;
  private readonly limiteSimples: number;
  private readonly pedaco: number;

  constructor(private readonly opcoes: OpcoesGoogleDriveAdapter) {
    this.clock = opcoes.clock ?? clockDoSistema;
    this.limiteSimples = opcoes.limiteSimplesBytes ?? LIMITE_DO_UPLOAD_SIMPLES_BYTES;
    this.pedaco = opcoes.tamanhoDoPedacoBytes ?? TAMANHO_DO_PEDACO_BYTES;
  }

  // ---------------------------------------------------------------------------
  // OAuth

  iniciarConexao(entrada: {
    readonly estado: string;
    readonly desafio: string;
    readonly uriDeRetorno: string;
  }): { readonly url: string } {
    const q = new URLSearchParams({
      client_id: this.opcoes.clientId,
      redirect_uri: entrada.uriDeRetorno,
      response_type: 'code',
      scope: ESCOPO_DO_DRIVE,
      state: entrada.estado,
      // `offline` + `consent`: sem os dois o Google não devolve o token de renovação numa
      // reconexão, e a conexão morreria em uma hora.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      code_challenge: entrada.desafio,
      code_challenge_method: 'S256',
    });
    return { url: `${URL_DE_AUTORIZACAO}?${q.toString()}` };
  }

  async concluirConexao(entrada: {
    readonly codigo: string;
    readonly verificador: string;
    readonly uriDeRetorno: string;
  }): Promise<AutorizacaoDoDestino> {
    const r = await this.pedirToken({
      grant_type: 'authorization_code',
      code: entrada.codigo,
      code_verifier: entrada.verificador,
      redirect_uri: entrada.uriDeRetorno,
    });
    // O consentimento granular permite ao advogado DESMARCAR a permissão da pasta e ainda
    // assim concluir a tela. Sem ela, todo envio falharia com 403 depois: recusa-se aqui.
    if (!(r.scope ?? '').split(/\s+/).includes(ESCOPO_DO_DRIVE)) {
      throw new AutorizacaoDoDestinoRevogadaError(
        'escopo_negado',
        'A permissão para criar a pasta no Google Drive não foi concedida.',
      );
    }
    if (!r.refresh_token) {
      // Não devia acontecer com `prompt=consent`, mas conexão sem renovação cai em uma hora.
      throw new AutorizacaoDoDestinoRevogadaError(
        'revogada',
        'O Google não devolveu a autorização de longa duração.',
      );
    }
    return {
      tokenDeAcesso: r.access_token,
      tokenDeRenovacao: r.refresh_token,
      expiraEm: new Date(this.clock.agora().getTime() + r.expires_in * 1000),
    };
  }

  async renovarAutorizacao(
    autorizacao: AutorizacaoDoDestino,
  ): Promise<AutorizacaoDoDestino> {
    const r = await this.pedirToken({
      grant_type: 'refresh_token',
      refresh_token: autorizacao.tokenDeRenovacao,
    });
    return {
      tokenDeAcesso: r.access_token,
      // O Google só manda um token de renovação novo de vez em quando; o antigo segue valendo.
      tokenDeRenovacao: r.refresh_token ?? autorizacao.tokenDeRenovacao,
      expiraEm: new Date(this.clock.agora().getTime() + r.expires_in * 1000),
    };
  }

  async desconectar(autorizacao: AutorizacaoDoDestino): Promise<void> {
    try {
      // Revogar o de renovação invalida também o de acesso.
      await this.chamar({
        metodo: 'POST',
        url: URL_DA_REVOGACAO,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        corpo: new URLSearchParams({ token: autorizacao.tokenDeRenovacao }).toString(),
        timeoutMs: 15_000,
      });
    } catch {
      // Melhor esforço: o advogado também revoga em myaccount.google.com. O que importa é
      // que o sistema APAGUE a autorização do cofre — isso é quem chama.
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const r = await this.chamar({
        metodo: 'GET',
        url: URL_DA_SAUDE,
        timeoutMs: 10_000,
      });
      return r.status >= 200 && r.status < 300;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Pastas e arquivos

  async garantirPasta(
    autorizacao: AutorizacaoDoDestino,
    pedido: {
      readonly nome: string;
      readonly paiId?: string;
      readonly idConhecido?: string;
    },
  ): Promise<ResultadoDaPasta> {
    if (pedido.idConhecido) {
      const existente = await this.ler(autorizacao, pedido.idConhecido);
      if (existente && existente.trashed !== true) {
        return {
          pasta: { id: existente.id, link: existente.webViewLink ?? '' },
          recriada: false,
        };
      }
    }
    const r = await this.chamarAutenticado(
      autorizacao,
      {
        metodo: 'POST',
        url: `${URL_DOS_ARQUIVOS}?fields=${CAMPOS_DO_ARQUIVO}`,
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        corpo: JSON.stringify({
          name: pedido.nome,
          mimeType: TIPO_DE_PASTA,
          ...(pedido.paiId ? { parents: [pedido.paiId] } : {}),
        }),
      },
      'pasta_pai',
    );
    const arquivo = this.arquivoDe(r);
    return {
      pasta: { id: arquivo.id, link: arquivo.link ?? '' },
      recriada: pedido.idConhecido !== undefined,
    };
  }

  async conferirArquivo(
    autorizacao: AutorizacaoDoDestino,
    arquivoId: string,
  ): Promise<'existe' | 'removido'> {
    const a = await this.ler(autorizacao, arquivoId);
    return a && a.trashed !== true ? 'existe' : 'removido';
  }

  async enviarArquivo(
    autorizacao: AutorizacaoDoDestino,
    pedido: {
      readonly nome: string;
      readonly paiId: string;
      readonly mimetype: string;
      readonly conteudo: ConteudoParaEnvio;
      readonly descricao?: string;
      readonly arquivoId?: string;
    },
  ): Promise<ArquivoNoDestino> {
    const atualizando = pedido.arquivoId !== undefined;
    const contexto = atualizando ? 'arquivo' : 'pasta_pai';
    const metadados = JSON.stringify({
      name: pedido.nome,
      ...(pedido.descricao ? { description: pedido.descricao } : {}),
      // `parents` só na criação: numa atualização o arquivo fica onde o advogado o deixou.
      ...(atualizando ? {} : { parents: [pedido.paiId] }),
    });
    const base = atualizando
      ? `${URL_DO_UPLOAD}/${encodeURIComponent(pedido.arquivoId as string)}`
      : URL_DO_UPLOAD;
    const metodo = atualizando ? 'PATCH' : 'POST';

    if (pedido.conteudo.tamanho <= this.limiteSimples) {
      const boundary = `pv-${randomBytes(12).toString('hex')}`;
      const corpo = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadados}\r\n` +
            `--${boundary}\r\ncontent-type: ${pedido.mimetype}\r\n\r\n`,
          'utf8',
        ),
        await juntar(pedido.conteudo, 0, pedido.conteudo.tamanho - 1),
        Buffer.from(`\r\n--${boundary}--`, 'utf8'),
      ]);
      const r = await this.chamarAutenticado(
        autorizacao,
        {
          metodo,
          url: `${base}?uploadType=multipart&fields=${CAMPOS_DO_ARQUIVO}`,
          headers: { 'content-type': `multipart/related; boundary=${boundary}` },
          corpo,
        },
        contexto,
      );
      const a = this.arquivoDe(r);
      return { id: a.id, link: a.link };
    }

    // Resumível: abre a sessão com os metadados, depois envia em pedaços.
    const abertura = await this.chamarAutenticado(
      autorizacao,
      {
        metodo,
        url: `${base}?uploadType=resumable&fields=${CAMPOS_DO_ARQUIVO}`,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': pedido.mimetype,
          'x-upload-content-length': String(pedido.conteudo.tamanho),
        },
        corpo: metadados,
      },
      contexto,
    );
    const sessao = abertura.headers['location'];
    if (!sessao)
      throw new RespostaInvalidaError(this.nome, 'sessão de upload sem endereço');
    return this.enviarEmPedacos(sessao, pedido.conteudo);
  }

  // ---------------------------------------------------------------------------
  // Internos

  private async enviarEmPedacos(
    sessao: string,
    conteudo: ConteudoParaEnvio,
  ): Promise<ArquivoNoDestino> {
    const total = conteudo.tamanho;
    let inicio = 0;
    let recuperou = false;
    while (inicio < total) {
      const fim = Math.min(inicio + this.pedaco, total) - 1;
      const bytes = await juntar(conteudo, inicio, fim);
      let r: RespostaDoTransporte;
      try {
        // A URL da sessão já carrega a identificação do upload: não leva o token de acesso.
        r = await this.chamar({
          metodo: 'PUT',
          url: sessao,
          headers: {
            'content-range': `bytes ${inicio}-${fim}/${total}`,
          },
          corpo: bytes,
          timeoutMs: 120_000,
        });
        if (r.status >= 500) throw new DestinoIndisponivelError(r.status);
      } catch (erro) {
        // Uma recuperação POR pedaço: pergunta ao Google quanto ele recebeu e continua dali.
        // Sem laço: a segunda falha sobe, e o serviço repete a peça com espera.
        if (!(erro instanceof DestinoIndisponivelError) || recuperou) throw erro;
        recuperou = true;
        const estado = await this.chamar({
          metodo: 'PUT',
          url: sessao,
          headers: { 'content-range': `bytes */${total}` },
          timeoutMs: 30_000,
        });
        if (estado.status === 200 || estado.status === 201)
          return this.finalDoUpload(estado);
        if (estado.status !== 308) throw this.classificar(estado, 'arquivo');
        inicio = recebidoAte(estado.headers['range']);
        continue;
      }
      recuperou = false;
      if (r.status === 200 || r.status === 201) return this.finalDoUpload(r);
      if (r.status === 308) {
        inicio = recebidoAte(r.headers['range']);
        continue;
      }
      throw this.classificar(r, 'arquivo');
    }
    throw new RespostaInvalidaError(this.nome, 'upload terminou sem confirmação');
  }

  private finalDoUpload(r: RespostaDoTransporte): ArquivoNoDestino {
    const a = this.arquivoDe(r);
    return { id: a.id, link: a.link };
  }

  /** `undefined` = não existe (404); lança nos demais erros. */
  private async ler(
    autorizacao: AutorizacaoDoDestino,
    id: string,
  ): Promise<{ id: string; webViewLink?: string; trashed?: boolean } | undefined> {
    const r = await this.chamar({
      metodo: 'GET',
      url: `${URL_DOS_ARQUIVOS}/${encodeURIComponent(id)}?fields=id,trashed,webViewLink`,
      headers: { authorization: `Bearer ${autorizacao.tokenDeAcesso}` },
      timeoutMs: 20_000,
    });
    if (r.status === 404) return undefined;
    if (r.status < 200 || r.status >= 300) throw this.classificar(r, 'consulta');
    const j = esquemaDoArquivo.safeParse(corpoJson(r));
    if (!j.success)
      throw new RespostaInvalidaError(this.nome, 'arquivo fora do contrato');
    return {
      id: j.data.id,
      ...(j.data.webViewLink !== undefined ? { webViewLink: j.data.webViewLink } : {}),
      ...(j.data.trashed !== undefined ? { trashed: j.data.trashed } : {}),
    };
  }

  private arquivoDe(r: RespostaDoTransporte): { id: string; link: string | undefined } {
    const j = esquemaDoArquivo.safeParse(corpoJson(r));
    if (!j.success)
      throw new RespostaInvalidaError(this.nome, 'arquivo fora do contrato');
    return { id: j.data.id, link: j.data.webViewLink };
  }

  private async pedirToken(
    parametros: Record<string, string>,
  ): Promise<z.infer<typeof esquemaDoToken>> {
    const r = await this.chamar({
      metodo: 'POST',
      url: URL_DO_TOKEN,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      corpo: new URLSearchParams({
        client_id: this.opcoes.clientId,
        client_secret: this.opcoes.clientSecret,
        ...parametros,
      }).toString(),
      timeoutMs: 20_000,
    });
    if (r.status >= 200 && r.status < 300) {
      const j = esquemaDoToken.safeParse(corpoJson(r));
      if (!j.success)
        throw new RespostaInvalidaError(this.nome, 'resposta de token fora do contrato');
      return j.data;
    }
    const erro = (corpoJson(r) as { error?: unknown } | null)?.error;
    if (r.status === 400 && erro === 'invalid_grant') {
      throw new AutorizacaoDoDestinoRevogadaError(
        'revogada',
        'A autorização do Google Drive foi revogada ou expirou.',
      );
    }
    throw this.classificar(r, 'consulta');
  }

  /** Chamada com o token de acesso; o 401 vira `AutorizacaoDoDestinoVencidaError`. */
  private async chamarAutenticado(
    autorizacao: AutorizacaoDoDestino,
    pedido: Parameters<GoogleDriveAdapter['chamar']>[0],
    contexto: ContextoDoErro,
  ): Promise<RespostaDoTransporte> {
    const r = await this.chamar({
      ...pedido,
      headers: {
        ...pedido.headers,
        authorization: `Bearer ${autorizacao.tokenDeAcesso}`,
      },
    });
    if (r.status >= 200 && r.status < 300) return r;
    throw this.classificar(r, contexto);
  }

  /** Toda falha do transporte vira erro do domínio, sem a mensagem original. */
  private async chamar(
    pedido: Parameters<TransporteDoDrive['requisitar']>[0],
  ): Promise<RespostaDoTransporte> {
    try {
      return await this.opcoes.transporte.requisitar(pedido);
    } catch (erro) {
      if (erro instanceof DomainError) throw erro;
      throw new DestinoIndisponivelError(undefined);
    }
  }

  /**
   * Status + MOTIVO do erro do Google → erro do domínio. Só o campo `reason` é lido: a
   * mensagem do Google pode ecoar e-mail, nome de arquivo ou id interno.
   */
  private classificar(r: RespostaDoTransporte, contexto: ContextoDoErro): DomainError {
    const motivo = motivoDoErro(r);
    if (r.status === 401) return new AutorizacaoDoDestinoVencidaError();
    if (r.status === 429)
      return new DestinoLimitouError(esperaDe(r.headers['retry-after'], this.clock));
    if (r.status >= 500) return new DestinoIndisponivelError(r.status);
    if (r.status === 403) {
      if (motivo === 'storageQuotaExceeded') return new DestinoSemEspacoError();
      if (
        motivo === 'rateLimitExceeded' ||
        motivo === 'userRateLimitExceeded' ||
        motivo === 'sharingRateLimitExceeded' ||
        motivo === 'dailyLimitExceeded'
      ) {
        return new DestinoLimitouError(esperaDe(r.headers['retry-after'], this.clock));
      }
      if (
        motivo === 'insufficientPermissions' ||
        motivo === 'insufficientScopes' ||
        motivo === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'
      ) {
        return new AutorizacaoDoDestinoRevogadaError(
          'escopo_negado',
          'A permissão para a pasta no Google Drive não vale mais.',
        );
      }
      return new DestinoRecusouError(403);
    }
    if (r.status === 404) {
      if (contexto === 'arquivo') return new ArquivoRemovidoNoDestinoError();
      if (contexto === 'pasta_pai') return new PastaRemovidaNoDestinoError();
    }
    return new DestinoRecusouError(r.status);
  }
}

type ContextoDoErro = 'pasta_pai' | 'arquivo' | 'consulta';

function corpoJson(r: RespostaDoTransporte): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(r.bytes));
  } catch {
    return null;
  }
}

function motivoDoErro(r: RespostaDoTransporte): string | undefined {
  const j = corpoJson(r) as {
    error?: { errors?: Array<{ reason?: unknown }>; status?: unknown };
  } | null;
  const reason = j?.error?.errors?.[0]?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** `Retry-After` em segundos ou em data HTTP → milissegundos. `undefined` se ilegível. */
function esperaDe(valor: string | undefined, clock: Clock): number | undefined {
  if (!valor) return undefined;
  const segundos = Number(valor);
  if (Number.isFinite(segundos) && segundos >= 0) return Math.round(segundos * 1000);
  const data = Date.parse(valor);
  if (Number.isNaN(data)) return undefined;
  return Math.max(0, data - clock.agora().getTime());
}

/** `Range: bytes=0-8388607` → quantos bytes o Google já tem (o próximo a enviar). */
function recebidoAte(range: string | undefined): number {
  const m = /bytes=0-(\d+)/i.exec(range ?? '');
  return m && m[1] ? Number(m[1]) + 1 : 0;
}

async function juntar(
  conteudo: ConteudoParaEnvio,
  inicio: number,
  fim: number,
): Promise<Buffer> {
  const partes: Uint8Array[] = [];
  for await (const p of conteudo.ler(inicio, fim)) partes.push(p);
  return Buffer.concat(partes);
}
