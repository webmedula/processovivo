import { XMLParser } from 'fast-xml-parser';
import { Peca } from '../../../domain/entities/Peca.js';
import type { PecaProps } from '../../../domain/entities/Peca.js';
import type { Movimentacao } from '../../../domain/entities/Movimentacao.js';
import type { AssinaturaDeMudanca } from '../../../domain/ports/ProvedorDePecas.js';
import { resolverReferencia } from './mtom.js';
import type { ParteMultipart } from './mtom.js';

export const NOME_MNI = 'mni';

/**
 * `removeNSPrefix` é o ajuste que sustenta este mapper.
 *
 * A resposta real do TJGO nomeia os elementos com prefixos gerados na hora —
 * `ns2:sucesso`, `ns5:consultarProcessoResposta` — e os números MUDAM conforme
 * a operação e a versão do CXF. Casar por `ns2:` funcionaria hoje e quebraria
 * na primeira atualização do tribunal, com o sintoma "o serviço parou de
 * encontrar peças" e nenhuma mudança do nosso lado para explicar.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

export interface RespostaMni {
  readonly sucesso: boolean;
  readonly mensagem: string;
  /** O corpo da operação, já sem envelope. */
  readonly conteudo: Registro;
}

type Registro = Record<string, unknown>;

export class XmlIlegivelError extends Error {
  constructor(motivo: string, options?: { cause?: unknown }) {
    super(`Envelope SOAP ilegível: ${motivo}`, options);
    this.name = 'XmlIlegivelError';
  }
}

/**
 * Abre o envelope e devolve o resultado da operação.
 *
 * O MNI responde **HTTP 200 mesmo quando recusa** — a captura real de credencial
 * inválida tem status 200 e `<sucesso>false</sucesso>`. Por isso o sucesso da
 * operação sai daqui, do corpo, e nunca do código HTTP: um adapter que confiasse
 * em `resposta.ok` trataria "Usuário ou Senha inválida." como consulta bem
 * sucedida e devolveria uma lista vazia de peças, que é indistinguível de
 * "processo sem documentos".
 */
export function abrirEnvelope(xml: string): RespostaMni {
  let arvore: unknown;
  try {
    arvore = parser.parse(xml);
  } catch (erro) {
    throw new XmlIlegivelError('o corpo não é XML válido', { cause: erro });
  }

  const envelope = registro(arvore)?.['Envelope'];
  const corpo = registro(envelope)?.['Body'];
  const corpoReg = registro(corpo);
  if (!corpoReg) throw new XmlIlegivelError('não há soap:Body na resposta');

  const falha = registro(corpoReg['Fault']);
  if (falha) {
    throw new XmlIlegivelError(
      `o serviço devolveu soap:Fault — ${texto(falha['faultstring']) ?? 'sem descrição'}`,
    );
  }

  // A resposta da operação é o único filho do Body, e o nome dele varia por
  // operação. Pegar "o que houver" evita repetir o nome em cada chamador.
  const primeiro = Object.values(corpoReg).find((v) => registro(v) !== undefined);
  const resultado = registro(primeiro);
  if (!resultado) throw new XmlIlegivelError('soap:Body veio sem corpo de operação');

  return {
    sucesso: texto(resultado['sucesso']) === 'true',
    mensagem: texto(resultado['mensagem']) ?? '',
    conteudo: resultado,
  };
}

/** Hashes de `consultarAlteracao` — a checagem barata de "mudou alguma coisa?". */
export function extrairAssinatura(conteudo: Registro): AssinaturaDeMudanca {
  const cabecalho = texto(conteudo['hashCabecalho']);
  const movimentacoes = texto(conteudo['hashMovimentacoes']);
  const documentos = texto(conteudo['hashDocumentos']);
  return {
    ...(cabecalho ? { cabecalho } : {}),
    ...(movimentacoes ? { movimentacoes } : {}),
    ...(documentos ? { documentos } : {}),
  };
}

/**
 * Extrai as peças de um `consultarProcessoResposta`.
 *
 * `anexos` vem do multipart: é com ele que se descobre se o `conteudo` de um
 * documento realmente veio, já que no MTOM ele é uma referência e não o dado.
 */
export function extrairPecas(
  conteudo: Registro,
  anexos: ReadonlyMap<string, ParteMultipart>,
): Peca[] {
  const processo = registro(conteudo['processo']);
  if (!processo) return [];
  return lista(processo['documento']).map((d) => montarPeca(d, anexos));
}

/**
 * Extrai os MOVIMENTOS de um `consultarProcessoResposta`.
 *
 * Eles já vinham na resposta desde a primeira versão do adapter — `movimentos:
 * true` é obrigatório para as peças aparecerem — e eram descartados. Descartar
 * era o que obrigava a lista de documentos a viver num rodapé apartado: sem o
 * movimento, o documento não tem a que evento pertencer.
 *
 * `identificadorMovimento` é a outra ponta do atributo `movimento` que cada
 * `<documento>` carrega. É a ÚNICA junção peça↔andamento afirmada por uma
 * fonte: as outras duas linhas do tempo (DataJud e DJEN) numeram movimento de
 * outro jeito e não têm campo em comum com o MNI. Por isso a espinha da tela,
 * quando esta resposta existe, é esta lista — e não a montada das fontes
 * públicas.
 *
 * Movimento sem data é descartado: a linha do tempo o colocaria em algum lugar,
 * e qualquer lugar escolhido seria mentira sobre quando o ato aconteceu.
 */
export function extrairMovimentos(conteudo: Registro): Movimentacao[] {
  const processo = registro(conteudo['processo']);
  if (!processo) return [];

  const saida: Movimentacao[] = [];
  for (const bruto of lista(processo['movimento'])) {
    const data = interpretarDataHora(atributo(bruto, 'dataHora'));
    if (!data) continue;

    const reg = registro(bruto) ?? {};
    const local = registro(reg['movimentoLocal']);
    const nacional = registro(reg['movimentoNacional']);

    const complementos = [
      ...lista(reg['complemento']),
      ...lista(nacional?.['complemento']),
      ...lista(local?.['complemento']),
    ]
      .map((c) => texto(c))
      .filter((c): c is string => Boolean(c));

    const codigoTpu =
      inteiro(atributo(nacional, 'codigoNacional')) ??
      inteiro(atributo(local, 'codigoPaiNacional'));

    // O título sai do que o tribunal escreveu COMO NOME DO ATO, e de mais nada.
    //
    // O complemento chega perto e não serve: "tipo_de_decisao: liminar" é
    // qualificador, não nome — viraria o título da linha, e ainda impediria a
    // troca pelo nome da TPU, porque `batizarPeloCodigo` só mexe em título que
    // ainda é o código. O último recurso nomeia pelo código de propósito:
    // linha sem título nenhum seria pior, e esse texto é justamente o que a
    // TPU do DataJud substitui depois.
    const identificador = atributo(bruto, 'identificadorMovimento');
    const titulo =
      atributo(local, 'descricao') ??
      texto(reg['descricao']) ??
      (codigoTpu !== undefined ? `Movimento ${codigoTpu}` : 'Movimento sem descrição');

    saida.push({
      data,
      titulo,
      ...(codigoTpu !== undefined ? { codigoTpu } : {}),
      ...(complementos.length > 0 ? { complementos } : {}),
      ...(identificador ? { idExterno: `${NOME_MNI}:${identificador}` } : {}),
      fonte: NOME_MNI,
    });
  }
  return saida;
}

/**
 * O tribunal entregou a linha do tempo, ou só o cabeçalho?
 *
 * É a única pergunta que separa "processo sem peças" de "você não tem acesso
 * ao conteúdo deste processo", e ela se responde pelos MOVIMENTOS — não pelos
 * documentos.
 *
 * O porquê de ser pelos movimentos: `movimentos: true` é sempre pedido. Se o
 * tribunal devolve zero, ele não está dizendo "não há" — processo nenhum tem
 * zero movimentos —, está omitindo. Medido no TJGO: a mesma consulta devolve
 * 3 KB e zero movimentos para quem não é representante, e 273 KB com 381
 * movimentos para quem tem procuração. Nos dois casos, `sucesso: true`.
 *
 * A condição é OU, e as duas metades existem por motivos diferentes:
 *
 * - **movimento > 0** é o sinal principal. Nenhum processo real tem zero
 *   movimentos, então zero com `movimentos: true` pedido é omissão, não
 *   ausência.
 * - **documento > 0** cobre o caso em que veio documento e não veio a linha do
 *   tempo. Se o arquivo chegou, discutir acesso é absurdo — e sem esta metade
 *   a regra reprovava respostas legítimas.
 *
 * Contar SÓ documentos não serviria: um processo recém-distribuído tem
 * movimento e ainda não tem documento, e o sistema acusaria falta de
 * habilitação onde não há.
 */
export function tribunalEntregouOConteudo(conteudo: Registro): boolean {
  const processo = registro(conteudo['processo']);
  if (!processo) return false;
  return (
    lista(processo['movimento']).length > 0 || lista(processo['documento']).length > 0
  );
}

/** Bytes de um documento específico, quando ele veio na resposta. */
export function extrairConteudoDoDocumento(
  conteudo: Registro,
  idPeca: string,
  anexos: ReadonlyMap<string, ParteMultipart>,
): ConteudoBruto | undefined {
  const processo = registro(conteudo['processo']);
  if (!processo) return undefined;

  for (const bruto of achatarDocumentos(lista(processo['documento']))) {
    if (atributo(bruto, 'idDocumento') !== idPeca) continue;
    const bytes = bytesDoConteudo(bruto, anexos);
    if (!bytes) return undefined;
    const nomeArquivo = parametroExtra(bruto, 'NomeArquivo');
    return {
      bytes,
      mimetype: atributo(bruto, 'mimetype') ?? 'application/octet-stream',
      ...(nomeArquivo ? { nomeArquivo } : {}),
    };
  }
  return undefined;
}

/**
 * O que cada id pedido em lote virou na resposta.
 *
 * Três destinos, e eles não podem colapsar: `semTeor` (o documento veio, o
 * arquivo não — falta de procuração, em geral) e `ausentes` (o documento nem
 * apareceu) pedem reações diferentes. A peça ausente merece uma segunda
 * chance sozinha; a sem teor, não — pedir de novo não muda o perfil de acesso.
 */
export function extrairConteudosDoLote(
  conteudo: Registro,
  ids: readonly string[],
  anexos: ReadonlyMap<string, ParteMultipart>,
): {
  readonly obtidos: ReadonlyArray<ConteudoBruto & { readonly id: string }>;
  readonly semTeor: readonly string[];
  readonly ausentes: readonly string[];
} {
  const processo = registro(conteudo['processo']);
  const porId = new Map<string, unknown>();
  for (const bruto of achatarDocumentos(lista(processo?.['documento']))) {
    const id = atributo(bruto, 'idDocumento');
    // Primeiro que aparecer vence: o mesmo id repetido seria anomalia da
    // fonte, e trocar o arquivo pelo segundo esconderia isso.
    if (id && !porId.has(id)) porId.set(id, bruto);
  }

  const obtidos: Array<ConteudoBruto & { readonly id: string }> = [];
  const semTeor: string[] = [];
  const ausentes: string[] = [];
  for (const id of ids) {
    const bruto = porId.get(id);
    if (bruto === undefined) {
      ausentes.push(id);
      continue;
    }
    const bytes = bytesOuVazio(bruto, anexos);
    if (!bytes) {
      semTeor.push(id);
      continue;
    }
    const nomeArquivo = parametroExtra(bruto, 'NomeArquivo');
    obtidos.push({
      id,
      bytes,
      mimetype: atributo(bruto, 'mimetype') ?? 'application/octet-stream',
      ...(nomeArquivo ? { nomeArquivo } : {}),
    });
  }
  return { obtidos, semTeor, ausentes };
}

/**
 * Quantas PARTES o cabeçalho traz (v0.59.0, só a sonda do PJe usa). `polo > parte`, como no MNI 2.2.2; nunca
 * devolve nome nem documento — só a contagem. Cabeçalho ausente = 0.
 */
export function contarPartes(conteudo: Registro): number {
  const processo = registro(conteudo['processo']);
  const dados = registro(processo?.['dadosBasicos']);
  let total = 0;
  for (const polo of lista(dados?.['polo'])) {
    total += lista(registro(polo)?.['parte']).length;
  }
  return total;
}

/** Todos os ids de documento da resposta, anexos (`documentoVinculado`) incluídos, na ordem em que vieram. */
export function idsDeTodosOsDocumentos(conteudo: Registro): string[] {
  const processo = registro(conteudo['processo']);
  return achatarDocumentos(lista(processo?.['documento']))
    .map((d) => atributo(d, 'idDocumento'))
    .filter((id): id is string => id !== undefined);
}

/**
 * Nível de sigilo do PROCESSO, do `dadosBasicos`. `undefined` sem cabeçalho.
 *
 * Só existe na resposta que pede o cabeçalho (`incluirCabecalho: true`), que é
 * a da listagem — e é na listagem que o leitor decide se pode guardar.
 */
export function extrairNivelSigiloDoProcesso(conteudo: Registro): number | undefined {
  const processo = registro(conteudo['processo']);
  return inteiro(atributo(processo?.['dadosBasicos'], 'nivelSigilo'));
}

interface ConteudoBruto {
  readonly bytes: Uint8Array;
  readonly mimetype: string;
  /** Nome do arquivo na origem, quando o tribunal informa. */
  readonly nomeArquivo?: string;
}

/**
 * Lê um `<outroParametro nome="X" valor="Y"/>`.
 *
 * É o saco de gatos do MNI, e no Projudi é onde moram dois campos que a
 * especificação não tem lugar fixo para guardar: `NomeArquivo`
 * (`certidaosistemadigital.pdf`) e `ArquivoTipo` (`Despacho`, `Petição`).
 * Verificado na resposta real do TJGO.
 */
function parametroExtra(bruto: unknown, nome: string): string | undefined {
  const reg = registro(bruto);
  if (!reg) return undefined;
  for (const p of lista(reg['outroParametro'])) {
    if (atributo(p, 'nome') === nome) return atributo(p, 'valor');
  }
  return undefined;
}

function montarPeca(bruto: unknown, anexos: ReadonlyMap<string, ParteMultipart>): Peca {
  const reg = registro(bruto) ?? {};
  const vinculadas = lista(reg['documentoVinculado']).map((v) => montarPeca(v, anexos));

  const props: PecaProps = {
    id: atributo(bruto, 'idDocumento') ?? '',
    tipo: atributo(bruto, 'tipoDocumento') ?? '',
    conteudoDisponivel: bytesDoConteudo(bruto, anexos) !== undefined,
    ...(vinculadas.length > 0 ? { vinculadas } : {}),
    ...opcional('tipoLocal', atributo(bruto, 'tipoDocumentoLocal')),
    ...opcional('descricao', atributo(bruto, 'descricao')),
    ...opcional('mimetype', atributo(bruto, 'mimetype')),
    ...opcional('hash', atributo(bruto, 'hash')),
  };

  const dataHora = interpretarDataHora(atributo(bruto, 'dataHora'));
  const nivelSigilo = inteiro(atributo(bruto, 'nivelSigilo'));
  const movimento = inteiro(atributo(bruto, 'movimento'));
  const signatarios = lista(reg['assinatura'])
    .map((a) => atributo(a, 'nomeSignatario') ?? nomeDoSignatario(a))
    .filter((n): n is string => Boolean(n));

  return new Peca({
    ...props,
    ...(dataHora ? { dataHora } : {}),
    ...(nivelSigilo !== undefined ? { nivelSigilo } : {}),
    ...(movimento !== undefined ? { movimento } : {}),
    ...(signatarios.length > 0 ? { signatarios } : {}),
  });
}

/**
 * Como `bytesDoConteudo`, mas distingue arquivo VAZIO de arquivo ausente.
 *
 * No download avulso as duas coisas viram "não liberado", porque não há o que
 * entregar. No lote, o leitor precisa saber a diferença: o tribunal que manda
 * zero bytes respondeu (`vazia`, página de aviso dizendo isso), e o que não
 * manda conteúdo nenhum negou (`sem_teor`).
 */
function bytesOuVazio(
  bruto: unknown,
  anexos: ReadonlyMap<string, ParteMultipart>,
): Uint8Array | undefined {
  const conteudo = registro(bruto)?.['conteudo'];
  if (conteudo === undefined || conteudo === null) return undefined;
  const inclusao = registro(registro(conteudo)?.['Include']);
  if (inclusao) {
    const href = texto(inclusao['@_href']);
    return href ? resolverReferencia(href, anexos) : undefined;
  }
  // `<conteudo/>` sem texto fica como NÃO entregue, igual ao download avulso:
  // não se sabe (não foi capturado) se é assim que o tribunal nega o arquivo,
  // e errar para "vazia" diria ao advogado que a peça não tem nada quando o
  // que houve foi negativa. Vazia é só o anexo MTOM que chegou com 0 bytes.
  const base64 = texto(conteudo);
  return base64 ? new Uint8Array(Buffer.from(base64, 'base64')) : undefined;
}

/**
 * O `conteudo` de um documento chega de duas formas, e as duas precisam
 * funcionar: base64 inline (SOAP comum) ou `xop:Include href="cid:..."`
 * (MTOM, que é o que o TJGO usa quando há anexo).
 *
 * @returns `undefined` quando o documento veio SEM teor — o caso de quem não
 *          tem procuração nos autos. É a informação que separa "não liberado"
 *          de "arquivo vazio", e por isso não vira `new Uint8Array()`.
 */
function bytesDoConteudo(
  bruto: unknown,
  anexos: ReadonlyMap<string, ParteMultipart>,
): Uint8Array | undefined {
  const reg = registro(bruto);
  const conteudo = reg?.['conteudo'];
  if (conteudo === undefined || conteudo === null) return undefined;

  const inclusao = registro(registro(conteudo)?.['Include']);
  if (inclusao) {
    const href = texto(inclusao['@_href']);
    return href ? resolverReferencia(href, anexos) : undefined;
  }

  const base64 = texto(conteudo);
  if (!base64) return undefined;
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length > 0 ? new Uint8Array(bytes) : undefined;
}

function achatarDocumentos(documentos: readonly unknown[]): unknown[] {
  const saida: unknown[] = [];
  for (const d of documentos) {
    saida.push(d);
    const reg = registro(d);
    if (reg) saida.push(...achatarDocumentos(lista(reg['documentoVinculado'])));
  }
  return saida;
}

function nomeDoSignatario(assinatura: unknown): string | undefined {
  const reg = registro(assinatura);
  const signatario = registro(reg?.['signatario']);
  return atributo(signatario, 'nome') ?? texto(signatario?.['nome']);
}

/**
 * `tipoDataHora` do MNI é `yyyyMMddHHmmss` — não é ISO.
 *
 * O mesmo formato do `dataAjuizamento` do DataJud, e pela mesma razão está
 * comentado aqui: `new Date('20260828145504')` devolve Invalid Date sem lançar,
 * e a peça apareceria sem data em vez de dar erro.
 */
export function interpretarDataHora(valor: string | undefined): Date | undefined {
  if (!valor) return undefined;

  const compacto = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(valor.trim());
  if (compacto) {
    const [, ano, mes, dia, hora, minuto, segundo] = compacto;
    const data = new Date(
      Number(ano),
      Number(mes) - 1,
      Number(dia),
      Number(hora ?? '0'),
      Number(minuto ?? '0'),
      Number(segundo ?? '0'),
    );
    return Number.isNaN(data.getTime()) ? undefined : data;
  }

  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? undefined : data;
}

function opcional<C extends string>(
  campo: C,
  valor: string | undefined,
): Partial<Record<C, string>> {
  return valor ? ({ [campo]: valor } as Partial<Record<C, string>>) : {};
}

function registro(valor: unknown): Registro | undefined {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Registro)
    : undefined;
}

/**
 * XML não distingue "um elemento" de "lista com um elemento", e o parser
 * devolve objeto num caso e array no outro. Todo acesso a filho repetível passa
 * por aqui — sem isso, um processo com UMA peça devolve zero peças, e com duas
 * funciona, que é o tipo de bug que passa em teste feito com o payload maior.
 */
function lista(valor: unknown): unknown[] {
  if (valor === undefined || valor === null) return [];
  return Array.isArray(valor) ? valor : [valor];
}

function atributo(valor: unknown, nome: string): string | undefined {
  return texto(registro(valor)?.[`@_${nome}`]);
}

function texto(valor: unknown): string | undefined {
  if (typeof valor === 'string') return valor.trim() || undefined;
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  // `<sucesso>false</sucesso>` com atributos vira `{ '#text': 'false' }`.
  const reg = registro(valor);
  const interno = reg?.['#text'];
  return typeof interno === 'string' ? interno.trim() || undefined : undefined;
}

function inteiro(valor: string | undefined): number | undefined {
  if (valor === undefined) return undefined;
  const n = Number.parseInt(valor, 10);
  return Number.isNaN(n) ? undefined : n;
}
