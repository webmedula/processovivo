/**
 * Leitor de respostas MTOM/XOP — `multipart/related` com anexos binários.
 *
 * Existe porque o MNI do Projudi/TJGO **não responde XML puro**. A resposta real
 * capturada em `tests/fixtures/mni-tjgo-credencial-invalida-real.txt` vem assim:
 *
 *   Content-Type: multipart/related; type="application/xop+xml";
 *                 boundary="uuid:5551fcba-..."; start="<root.message@cxf.apache.org>"
 *
 * É o Apache CXF do outro lado. Consequência prática: quem tentar dar
 * `parser.parse(resposta.corpo)` recebe lixo, porque o corpo começa com o
 * delimitador do multipart e o XML está no meio.
 *
 * E a consequência que custa mais caro: o teor dos documentos NÃO vem em base64
 * dentro do XML, embora o WSDL declare `xs:base64Binary`. Vem como parte binária
 * separada, e o XML guarda só uma referência:
 *
 *   <conteudo><xop:Include href="cid:1a2b3c@apache.org"/></conteudo>
 *
 * Um mapper que lesse `conteudo` como base64 encontraria string vazia e
 * concluiria "o tribunal não liberou o arquivo" — quando o arquivo está ali, na
 * parte seguinte da mesma resposta. É por isso que este módulo existe antes do
 * mapper, e não como detalhe dele.
 */

export interface ParteMultipart {
  /** Content-ID sem os sinais de menor/maior. */
  readonly id: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface RespostaMtom {
  /** O envelope SOAP, como texto. */
  readonly xml: string;
  /** Anexos binários, indexados pelo Content-ID (sem `cid:`). */
  readonly anexos: ReadonlyMap<string, ParteMultipart>;
}

const CRLF = '\r\n';
const SEPARADOR_CABECALHOS = Buffer.from(CRLF + CRLF, 'ascii');

export class MultipartInvalidoError extends Error {
  constructor(motivo: string) {
    super(`Resposta multipart ilegível: ${motivo}`);
    this.name = 'MultipartInvalidoError';
  }
}

/**
 * Interpreta a resposta conforme o `content-type`.
 *
 * Aceita os dois formatos de propósito: o serviço responde multipart quando há
 * anexo e pode responder `text/xml` puro quando não há. Exigir multipart sempre
 * quebraria justamente a consulta mais simples — a de metadado.
 */
export function lerRespostaSoap(contentType: string, corpo: Uint8Array): RespostaMtom {
  const tipo = contentType.toLowerCase();

  if (!tipo.includes('multipart/')) {
    return { xml: Buffer.from(corpo).toString('utf8'), anexos: new Map() };
  }

  const boundary = extrairParametro(contentType, 'boundary');
  if (!boundary) {
    throw new MultipartInvalidoError('o content-type multipart não trouxe boundary');
  }

  // Vista sobre os mesmos bytes, sem cópia. `Buffer.from(corpo)` copiaria a
  // resposta inteira — e a resposta de um lote do leitor tem megabytes.
  const partes = separarPartes(
    Buffer.from(corpo.buffer, corpo.byteOffset, corpo.byteLength),
    boundary,
  );
  if (partes.length === 0) {
    throw new MultipartInvalidoError('nenhuma parte encontrada entre os delimitadores');
  }

  const inicio = normalizarId(extrairParametro(contentType, 'start') ?? '');
  // Sem `start`, a raiz é a primeira parte — é o que o RFC 2387 manda, e é o
  // caso de servidores que omitem o parâmetro.
  const raiz = (inicio && partes.find((p) => p.id === inicio)) ?? partes[0];
  if (!raiz) {
    throw new MultipartInvalidoError(`a parte raiz "${inicio}" não está na resposta`);
  }

  const anexos = new Map<string, ParteMultipart>();
  for (const parte of partes) {
    if (parte !== raiz && parte.id) anexos.set(parte.id, parte);
  }

  return { xml: Buffer.from(raiz.bytes).toString('utf8'), anexos };
}

/**
 * Resolve `<xop:Include href="cid:...">` contra os anexos.
 *
 * @returns os bytes do anexo, ou `undefined` quando a referência não aponta para
 *          nenhuma parte — o que é dado corrompido, não arquivo vazio, e por
 *          isso os dois casos não podem colapsar num só valor.
 */
export function resolverReferencia(
  href: string,
  anexos: ReadonlyMap<string, ParteMultipart>,
): Uint8Array | undefined {
  const id = normalizarId(href.replace(/^cid:/i, ''));
  const direto = anexos.get(id);
  if (direto) return direto.bytes;

  // O CXF percent-encoda o Content-ID no href e não no cabeçalho da parte
  // (ou o contrário, conforme a versão). Decodificar é mais barato do que
  // descobrir isso em produção, com o download vindo vazio.
  try {
    const decodificado = decodeURIComponent(id);
    return anexos.get(decodificado)?.bytes;
  } catch {
    return undefined;
  }
}

function separarPartes(corpo: Buffer, boundary: string): ParteMultipart[] {
  const delimitador = Buffer.from(`--${boundary}`, 'ascii');
  const partes: ParteMultipart[] = [];

  let posicao = corpo.indexOf(delimitador);
  if (posicao < 0) return partes;

  while (posicao >= 0) {
    const inicioBloco = posicao + delimitador.length;

    // `--boundary--` marca o fim do multipart; nada depois disso interessa.
    if (corpo.subarray(inicioBloco, inicioBloco + 2).toString('ascii') === '--') break;

    const proximo = corpo.indexOf(delimitador, inicioBloco);
    const fimBloco = proximo < 0 ? corpo.length : proximo;

    const bloco = corpo.subarray(inicioBloco, fimBloco);
    const parte = interpretarParte(bloco);
    if (parte) partes.push(parte);

    if (proximo < 0) break;
    posicao = proximo;
  }

  return partes;
}

function interpretarParte(bloco: Buffer): ParteMultipart | undefined {
  const corte = bloco.indexOf(SEPARADOR_CABECALHOS);
  if (corte < 0) return undefined;

  const cabecalhos = bloco.subarray(0, corte).toString('ascii');
  let bytes = bloco.subarray(corte + SEPARADOR_CABECALHOS.length);

  // O CRLF que antecede o próximo delimitador pertence ao delimitador, não ao
  // conteúdo. Sem tirar, todo PDF sai com dois bytes a mais no fim — o que não
  // impede de abrir, mas quebra qualquer conferência de hash com a origem.
  if (bytes.length >= 2 && bytes.subarray(bytes.length - 2).toString('ascii') === CRLF) {
    bytes = bytes.subarray(0, bytes.length - 2);
  }

  const id = normalizarId(valorDoCabecalho(cabecalhos, 'content-id') ?? '');
  const contentType = valorDoCabecalho(cabecalhos, 'content-type') ?? '';
  const codificacao = (
    valorDoCabecalho(cabecalhos, 'content-transfer-encoding') ?? ''
  ).toLowerCase();

  // `binary` é o normal no MTOM, mas `base64` aparece em implementações mais
  // antigas. Ignorar essa linha entregaria ao usuário um "PDF" que é o base64
  // do PDF, e o erro só apareceria na hora de abrir o arquivo.
  //
  // `binary` devolve uma VISTA sobre a resposta, não uma cópia: medido com
  // respostas sintéticas de 3 a 48 MB, a cópia por anexo era a maior parcela
  // do pico de memória de um lote (ver `docs/leitor-medicoes-v0.30.0.md`). A
  // vista segura a resposta inteira viva enquanto algum anexo estiver em uso;
  // quem guarda o arquivo (o leitor) grava em disco e solta logo em seguida.
  const conteudo =
    codificacao === 'base64' ? Buffer.from(bytes.toString('ascii'), 'base64') : bytes;

  return { id, contentType, bytes: conteudo };
}

function valorDoCabecalho(cabecalhos: string, nome: string): string | undefined {
  for (const linha of cabecalhos.split(CRLF)) {
    const corte = linha.indexOf(':');
    if (corte < 0) continue;
    if (linha.slice(0, corte).trim().toLowerCase() === nome) {
      return linha.slice(corte + 1).trim();
    }
  }
  return undefined;
}

function extrairParametro(cabecalho: string, nome: string): string | undefined {
  const regex = new RegExp(`${nome}\\s*=\\s*("([^"]*)"|([^;]+))`, 'i');
  const achado = regex.exec(cabecalho);
  const valor = achado?.[2] ?? achado?.[3];
  return valor?.trim();
}

/** Content-ID circula ora como `<id>`, ora como `id`. Aqui é sempre sem. */
function normalizarId(bruto: string): string {
  return bruto.trim().replace(/^</, '').replace(/>$/, '');
}
