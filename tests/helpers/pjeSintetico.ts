import { HttpTimeoutError } from '../../src/infrastructure/http/HttpClient.js';
import type {
  RespostaHttpBinaria,
  RespostaHttpCompleta,
} from '../../src/infrastructure/http/HttpClient.js';
import { HttpClientObservado } from '../../src/main/sonda/comandoSondaMniPje.js';

/*
 * Servidor MNI do PJe FALSO, SINTÉTICO. A forma é a do MNI 2.2.2 como o PJe a serve (SOAP comum, SEM MTOM:
 * o teor vem em base64 dentro de `<conteudo>`; `polo > parte` no cabeçalho; `documentoVinculado` recursivo).
 * Tudo é inventado — nenhum nome, número ou texto real. Os "sentinelas" abaixo existem para os testes
 * provarem que NADA disso chega à saída da sonda.
 */

export const NUMERO_SINTETICO = '9999001-34.2026.5.18.0099';
export const DIGITOS_SINTETICOS = '99990013420265180099';
export const CPF_SINTETICO = '000.000.001-91';
export const CPF_SO_DIGITOS = '00000000191';
export const SENHA_SINTETICA = 'Senha-Sintetica#9&x';
export const NOME_SENTINELA = 'Fulano Sentinela Exemplo';
export const TEXTO_SENTINELA = 'TEXTO-SENTINELA-DENTRO-DO-PDF-SINTETICO';
export const ID_SENTINELA = 'ID-DOC-SENTINELA-777';
export const URL_SINTETICA = 'https://pje.exemplo-sintetico.test/pje/intercomunicacao';

export interface DocumentoPje {
  readonly id: string;
  readonly mimetype?: string;
  /** Ausente = o documento vem SEM `<conteudo>` (só a ficha). */
  readonly bytes?: Uint8Array;
  readonly vinculados?: readonly DocumentoPje[];
}

export interface OpcoesDaConsultaPje {
  readonly movimentos?: number;
  readonly partes?: number;
  readonly nivelSigilo?: number;
  readonly documentos?: readonly DocumentoPje[];
}

const NS =
  'xmlns:ns2="http://www.cnj.jus.br/intercomunicacao-2.2.2" ' +
  'xmlns:ns5="http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/"';

function xmlDoc(d: DocumentoPje, tag = 'documento'): string {
  const conteudo = d.bytes
    ? `<ns2:conteudo>${Buffer.from(d.bytes).toString('base64')}</ns2:conteudo>`
    : '';
  const vinc = (d.vinculados ?? []).map((v) => xmlDoc(v, 'documentoVinculado')).join('');
  return (
    `<ns2:${tag} idDocumento="${d.id}" tipoDocumento="57" descricao="Documento ${NOME_SENTINELA}" ` +
    `mimetype="${d.mimetype ?? 'application/pdf'}" dataHora="20260828145504" nivelSigilo="0" movimento="1">` +
    conteudo +
    vinc +
    `</ns2:${tag}>`
  );
}

export function consultaPje(
  o: OpcoesDaConsultaPje = {},
  comDocumentos = true,
): RespostaHttpBinaria {
  const movimentos = Array.from(
    { length: o.movimentos ?? 5 },
    (_, i) =>
      `<ns2:movimento identificadorMovimento="${i + 1}" dataHora="2026082${i % 10}101010">` +
      `<ns2:movimentoLocal codigoMovimento="1" descricao="Movimento ${NOME_SENTINELA}"/></ns2:movimento>`,
  ).join('');
  const nPartes = o.partes ?? 3;
  const partes = (polo: string, n: number): string =>
    `<ns2:polo polo="${polo}">` +
    Array.from(
      { length: n },
      () =>
        `<ns2:parte><ns2:pessoa nome="${NOME_SENTINELA}" numeroDocumentoPrincipal="${CPF_SO_DIGITOS}"/></ns2:parte>`,
    ).join('') +
    `</ns2:polo>`;
  const docs = comDocumentos ? (o.documentos ?? []).map((d) => xmlDoc(d)).join('') : '';
  const xml =
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<ns5:consultarProcessoResposta ${NS}><ns2:sucesso>true</ns2:sucesso><ns2:mensagem>Sucesso</ns2:mensagem>` +
    `<ns2:processo><ns2:dadosBasicos numero="${DIGITOS_SINTETICOS}" nivelSigilo="${o.nivelSigilo ?? 0}">` +
    partes('AT', Math.ceil(nPartes / 2)) +
    partes('PA', Math.floor(nPartes / 2)) +
    `</ns2:dadosBasicos>${movimentos}${docs}</ns2:processo></ns5:consultarProcessoResposta></soap:Body></soap:Envelope>`;
  return texto(200, xml);
}

export function recusaPje(mensagem: string): RespostaHttpBinaria {
  return texto(
    200,
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
      `<ns5:consultarProcessoResposta ${NS}><ns2:sucesso>false</ns2:sucesso>` +
      `<ns2:mensagem>${mensagem}</ns2:mensagem></ns5:consultarProcessoResposta></soap:Body></soap:Envelope>`,
  );
}

export function texto(
  status: number,
  corpo: string,
  contentType = 'text/xml',
): RespostaHttpBinaria {
  return {
    status,
    ok: status >= 200 && status < 300,
    contentType,
    bytes: new Uint8Array(Buffer.from(corpo)),
  };
}

export const WSDL_COMPLETO =
  `<definitions><operation name="consultarProcesso"/><operation name="consultarAvisosPendentes"/>` +
  `<operation name="consultarTeorComunicacao"/><operation name="entregarManifestacaoProcessual"/></definitions>`;

type RespostaDoPost = RespostaHttpBinaria | Error;

/** O cliente HTTP falso: registra tudo o que a sonda envia e responde o que o teste mandar. */
export class HttpFalsoDoPje extends HttpClientObservado {
  readonly posts: Array<{ acao: string; envelope: string }> = [];
  readonly gets: string[] = [];
  /** Uma resposta por POST, em ordem; depois delas, o último se repete (para provar "sem retry"). */
  respostasDePost: RespostaDoPost[] = [];
  wsdl: { status: number; corpo: string } | Error = { status: 200, corpo: WSDL_COMPLETO };

  constructor() {
    super({ timeoutMs: 1000, tentativas: 1 });
  }

  override async postXml(
    _url: string,
    xml: string,
    headers: Record<string, string> = {},
  ): Promise<RespostaHttpBinaria> {
    this.ultimoStatus = undefined;
    this.posts.push({ acao: headers['SOAPAction'] ?? '', envelope: xml });
    const r =
      this.respostasDePost[
        Math.min(this.posts.length - 1, this.respostasDePost.length - 1)
      ];
    if (r === undefined) throw new Error('teste sem resposta de POST');
    if (r instanceof Error) throw r;
    this.ultimoStatus = r.status;
    return r;
  }

  override async requisitar(pedido: { url: string }): Promise<RespostaHttpCompleta> {
    this.gets.push(pedido.url);
    if (this.wsdl instanceof Error) throw this.wsdl;
    return {
      status: this.wsdl.status,
      ok: this.wsdl.status < 300,
      headers: { 'content-type': 'text/xml' },
      bytes: new Uint8Array(Buffer.from(this.wsdl.corpo)),
    };
  }
}

export const erroDeTempo = (): Error => new HttpTimeoutError(URL_SINTETICA, 1000);

/** Erro de rede como o `fetch` do Node o entrega: TypeError("fetch failed") com `cause.code`. */
export function erroDeRede(codigo: string, mensagem = 'erro'): Error {
  const causa = Object.assign(new Error(mensagem), { code: codigo });
  return new TypeError('fetch failed', { cause: causa });
}
