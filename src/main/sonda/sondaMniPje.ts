import { percentil } from '../../application/politicas/estatistica.js';
import { redigirParaIA } from '../../application/politicas/redigirParaIA.js';
import {
  CredencialTribunalInvalidaError,
  MniBloqueadoError,
  ProcessoNaoEncontradoError,
  ProviderIndisponivelError,
  RespostaInvalidaError,
  SemHabilitacaoNosAutosError,
} from '../../domain/errors/index.js';
import type { ExtratorDeTextoDePdf } from '../../domain/ports/ExtratorDeTextoDePdf.js';
import type { CredencialTribunal } from '../../domain/ports/ProvedorDePecas.js';
import type { ConsultaBrutaDoMni } from '../../infrastructure/adapters/mni/MniAdapter.js';
import {
  contarPartes,
  extrairConteudosDoLote,
  extrairMovimentos,
  extrairNivelSigiloDoProcesso,
  idsDeTodosOsDocumentos,
  tribunalEntregouOConteudo,
} from '../../infrastructure/adapters/mni/mni.mapper.js';

/**
 * Sonda SOMENTE LEITURA do MNI de um tribunal PJe (v0.59.0; usada para o TRT18).
 *
 * Responde a uma pergunta de viabilidade — "o MNI deste tribunal aceita a credencial do advogado e devolve a
 * consulta do processo e dos documentos?" — com UM teste, sem tocar em banco, cofre, tela, plano ou IA, e
 * SEM nada além de contagens e categorias na saída: nenhum número de processo, nome, CPF, id de documento,
 * trecho de texto, URL ou mensagem do tribunal sem máscara.
 *
 * Regras que a tornam segura para a conta do advogado:
 * - **só consulta.** `OPERACOES_PERMITIDAS` tem UMA operação, `consultarProcesso`, e há teste que falha se
 *   a lista crescer. Esta sonda não importa o montador de envelopes: tudo passa por
 *   `MniAdapter.consultarProcessoBruto`, que só sabe montar essa consulta;
 * - **nunca gera ciência nem prazo.** `consultarAvisosPendentes` e `consultarTeorComunicacao` NÃO são
 *   chamadas: a documentação pública não prova qual delas registra ciência (fonte secundária diz que é a do
 *   teor), então a etapa de avisos sai como "não testado por risco de ciência";
 * - **uma tentativa por operação, sem repetição**, e **para no primeiro sinal de autenticação**: recusa de
 *   credencial, exigência de certificado, segundo fator ou cadastro prévio encerram a sonda na hora.
 *   Tentativa errada conta para o bloqueio da conta do advogado no tribunal;
 * - **não testa outro número, não varre, não contorna bloqueio.**
 */
export const OPERACOES_PERMITIDAS: readonly string[] = Object.freeze([
  'consultarProcesso',
]);

export const VERSAO_DA_SONDA_MNI_PJE = '1.0.0';

// --- categorias (vocabulário FECHADO da saída) -----------------------------------------------------

export type CategoriaDeConexao =
  | 'ok'
  | 'dns_nao_resolve'
  | 'conexao_recusada'
  | 'conexao_reiniciada'
  | 'tempo_esgotado'
  | 'certificado_do_servidor_nao_confiavel'
  | 'exige_certificado_de_cliente'
  | 'erro_de_rede_outro'
  | 'url_nao_encontrada_http_404'
  | 'http_5xx'
  | 'http_outro';

export type CategoriaDeAutenticacao =
  | 'aceita'
  | 'recusada'
  | 'exige_certificado'
  | 'exige_segundo_fator'
  | 'exige_cadastro_ou_perfil'
  | 'acesso_negado_http_403'
  | 'http_401'
  | 'nao_determinada'
  | 'nao_testada';

export type CategoriaDeConsulta =
  | 'ok'
  | 'processo_nao_encontrado'
  | 'sem_habilitacao_nos_autos'
  | 'resposta_malformada'
  | 'recusa_nao_classificada'
  | 'tempo_esgotado'
  | 'falha_de_rede'
  | 'http_5xx'
  | 'http_4xx'
  | 'nao_executada';

export type Veredito = 'viavel' | 'viavel_com_ressalvas' | 'inviavel';

export interface RelatorioDaSonda {
  readonly versao: string;
  readonly conexao: {
    readonly categoria: CategoriaDeConexao;
    readonly statusHttp: number | null;
    /** A descrição do serviço (WSDL) pôde ser lida? `null` = não deu para saber. */
    readonly wsdl: {
      readonly lido: boolean;
      readonly oferece_consultarProcesso: boolean;
      readonly oferece_consultarAvisosPendentes: boolean;
      readonly oferece_consultarTeorComunicacao: boolean;
      readonly operacoes_de_escrita_presentes: boolean;
    } | null;
  };
  readonly autenticacao: { readonly categoria: CategoriaDeAutenticacao };
  readonly consultaSemDocumentos: {
    readonly categoria: CategoriaDeConsulta;
    readonly movimentos: number | null;
    readonly partes: number | null;
    readonly segredoDeJustica: boolean | null;
    readonly mensagemMascarada: string | null;
  };
  readonly consultaComDocumentos: {
    readonly categoria: CategoriaDeConsulta;
    readonly documentos: number | null;
    readonly porTipo: {
      readonly pdf: number;
      readonly html: number;
      readonly outro: number;
    } | null;
    readonly comConteudo: number | null;
    readonly somenteReferenciaSemConteudo: number | null;
    readonly tamanhoKb: {
      readonly minimo: number;
      readonly mediano: number;
      readonly maximo: number;
    } | null;
    readonly pdfs: {
      readonly examinados: number;
      readonly comTexto: number;
      readonly semTexto: number;
      readonly ilegiveis: number;
    } | null;
    readonly mensagemMascarada: string | null;
  };
  readonly avisosPendentes: 'nao_testado_por_risco_de_ciencia';
  readonly veredito: Veredito;
  readonly ressalvas: readonly string[];
  readonly motivoDaInviabilidade: string | null;
}

// --- dependências ---------------------------------------------------------------------------------

export interface RespostaDoWsdl {
  readonly status: number;
  readonly contentType: string;
  readonly corpo: string;
}

export interface DependenciasDaSondaMniPje {
  /** Endereço do SERVIÇO (sem `?wsdl`). Só é usado para decidir o que ler; nunca é impresso. */
  readonly url: string;
  /** Os 20 dígitos do CNJ. Nunca é impresso. */
  readonly numeroProcesso: string;
  readonly credencial: CredencialTribunal;
  readonly adaptador: {
    consultarProcessoBruto(
      numeroProcesso: string,
      credencial: CredencialTribunal,
      opcoes: { readonly incluirCabecalho: boolean; readonly incluirDocumentos: boolean },
    ): Promise<ConsultaBrutaDoMni>;
  };
  /** O status HTTP da última resposta de POST (um cliente HTTP "observado" o guarda). */
  readonly ultimoStatusHttp: () => number | undefined;
  /** GET da descrição do serviço, sem credencial. Pode lançar. */
  readonly lerWsdl: (url: string) => Promise<RespostaDoWsdl>;
  readonly extrator: ExtratorDeTextoDePdf;
  /** Quantos PDFs, no máximo, têm a camada de texto conferida (cada um é um processo filho). */
  readonly maxPdfsParaTexto: number;
}

// --- classificação --------------------------------------------------------------------------------

const normalizar = (t: string): string =>
  t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

type MarcaDeMensagem =
  | 'exige_certificado'
  | 'exige_segundo_fator'
  | 'recusada'
  | 'exige_cadastro_ou_perfil'
  | 'processo_nao_encontrado'
  | 'nao_classificada';

/**
 * Lê uma mensagem do tribunal por FRASES, na ordem do mais específico ao mais geral (certificado e segundo
 * fator antes de "senha inválida", senão uma exigência de certificado seria lida como senha errada e mandaria
 * mexer na senha certa). Sem evidência: `nao_classificada` — nunca um palpite.
 */
export function marcarMensagemDoTribunal(mensagem: string): MarcaDeMensagem {
  const m = normalizar(mensagem);
  const tem = (...frases: string[]): boolean => frases.some((f) => m.includes(f));
  if (
    tem(
      'certificado digital',
      'certificado de cliente',
      'client certificate',
      'icp-brasil',
      'icp brasil',
      'certificate required',
    )
  ) {
    return 'exige_certificado';
  }
  if (
    tem(
      'segundo fator',
      'duplo fator',
      'dois fatores',
      'two-factor',
      '2fa',
      'codigo de verificacao',
      'codigo de seguranca',
      'token de acesso',
      'autenticacao em duas',
    )
  ) {
    return 'exige_segundo_fator';
  }
  if (
    tem(
      'processo nao encontrado',
      'processo inexistente',
      'nao localizado',
      'nenhum processo',
      'processo nao localizado',
    )
  ) {
    return 'processo_nao_encontrado';
  }
  if (
    tem(
      'usuario ou senha',
      'senha invalida',
      'senha incorreta',
      'login invalido',
      'usuario invalido',
      'cpf ou senha',
      'credencial',
      'falha na autenticacao',
      'erro de autenticacao',
      'nao autenticado',
      'authentication',
    )
  ) {
    return 'recusada';
  }
  if (
    tem(
      'perfil',
      'habilita',
      'permissao',
      'sem acesso',
      'nao possui acesso',
      'nao autorizado',
      'acesso negado',
      'cadastr',
      'autorizacao',
    )
  ) {
    return 'exige_cadastro_ou_perfil';
  }
  return 'nao_classificada';
}

/**
 * Máscara da mensagem do tribunal antes de ela chegar a qualquer saída: tira a credencial e o número do
 * processo literais, passa pela redação que já protege o texto de IA (CPF/CNPJ, e-mail, telefone, OAB, número
 * de processo), troca sequências de dígitos, endereços e pares de nomes próprios, e corta em 100 caracteres.
 * Na dúvida, apaga: a categoria já diz o que importa.
 */
export function mascararMensagemDoTribunal(
  mensagem: string,
  segredos: readonly string[],
): string {
  let t = mensagem;
  for (const s of segredos) {
    if (s.length >= 3) t = t.split(s).join('[oculto]');
  }
  t = redigirParaIA(t, {}).texto;
  t = t
    .replace(/https?:\/\/\S+/gi, '[endereço]')
    .replace(/\d{3,}/g, '[nº]')
    .replace(/\b\p{Lu}\p{Ll}+(?:\s+(?:d[aeo]s?\s+)?\p{Lu}\p{Ll}+)+\b/gu, '[nome]')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > 100 ? `${t.slice(0, 100)}…` : t;
}

function cadeiaDeCausas(erro: unknown): string {
  const partes: string[] = [];
  let atual: unknown = erro;
  for (let i = 0; i < 6 && atual !== undefined && atual !== null; i++) {
    if (atual instanceof Error) {
      const codigo = (atual as Error & { code?: unknown }).code;
      partes.push(String(codigo ?? ''), atual.name, atual.message);
      atual = (atual as Error & { cause?: unknown }).cause;
    } else {
      partes.push(String(atual));
      break;
    }
  }
  return normalizar(partes.join(' '));
}

/** Falha de rede/TLS → categoria. Casa por código e por FRASE da biblioteca, nunca por palavra solta. */
export function classificarFalhaDeRede(erro: unknown): CategoriaDeConexao {
  const c = cadeiaDeCausas(erro);
  const tem = (...frases: string[]): boolean => frases.some((f) => c.includes(f));
  if (tem('timeouterror', 'timeout de', 'aborterror')) return 'tempo_esgotado';
  if (tem('enotfound', 'eai_again', 'getaddrinfo')) return 'dns_nao_resolve';
  if (tem('econnrefused')) return 'conexao_recusada';
  if (tem('econnreset', 'socket hang up', 'other side closed', 'epipe'))
    return 'conexao_reiniciada';
  if (
    tem(
      'certificate_required',
      'certificate required',
      'tlsv13_alert_certificate_required',
      'sslv3_alert_handshake_failure',
      'alert handshake failure',
      'bad_certificate',
      'bad certificate',
      'handshake_failure',
    )
  ) {
    return 'exige_certificado_de_cliente';
  }
  if (
    tem(
      'cert_has_expired',
      'depth_zero_self_signed_cert',
      'self-signed',
      'self signed',
      'unable_to_verify_leaf_signature',
      'unable to verify the first certificate',
      'err_tls_cert_altname_invalid',
      'hostname/ip does not match',
      'unable_to_get_issuer_cert',
    )
  ) {
    return 'certificado_do_servidor_nao_confiavel';
  }
  return 'erro_de_rede_outro';
}

interface FalhaClassificada {
  readonly autenticacao: CategoriaDeAutenticacao | null;
  readonly consulta: CategoriaDeConsulta;
  readonly conexao: CategoriaDeConexao | null;
  readonly mensagemMascarada: string | null;
  /** Há que PARAR já: qualquer coisa que se pareça com autenticação, bloqueio ou URL errada. */
  readonly parar: boolean;
}

/** Erro de domínio (ou de rede) → o que a sonda diz e se ela continua. */
function classificarFalha(
  erro: unknown,
  status: number | undefined,
  segredos: readonly string[],
): FalhaClassificada {
  const mascarar = (t: string): string | null => {
    const m = mascararMensagemDoTribunal(t, segredos);
    return m === '' ? null : m;
  };
  const doTexto = (texto: string): FalhaClassificada => {
    const marca = marcarMensagemDoTribunal(texto);
    const mensagemMascarada = marca === 'nao_classificada' ? mascarar(texto) : null;
    switch (marca) {
      case 'exige_certificado':
      case 'exige_segundo_fator':
      case 'exige_cadastro_ou_perfil':
        return {
          autenticacao: marca,
          consulta: 'recusa_nao_classificada',
          conexao: null,
          mensagemMascarada,
          parar: true,
        };
      case 'recusada':
        return {
          autenticacao: 'recusada',
          consulta: 'recusa_nao_classificada',
          conexao: null,
          mensagemMascarada,
          parar: true,
        };
      case 'processo_nao_encontrado':
        return {
          autenticacao: 'aceita',
          consulta: 'processo_nao_encontrado',
          conexao: null,
          mensagemMascarada,
          parar: true,
        };
      default:
        return {
          autenticacao: 'nao_determinada',
          consulta: 'recusa_nao_classificada',
          conexao: null,
          mensagemMascarada,
          parar: true,
        };
    }
  };

  if (erro instanceof MniBloqueadoError) {
    return {
      autenticacao: 'acesso_negado_http_403',
      consulta: 'nao_executada',
      conexao: null,
      mensagemMascarada: null,
      parar: true,
    };
  }
  if (erro instanceof CredencialTribunalInvalidaError) {
    // O adaptador reconheceu uma recusa de credencial; a mensagem ainda pode dizer que é certificado ou 2FA.
    const marca = marcarMensagemDoTribunal(erro.message);
    const aut: CategoriaDeAutenticacao =
      marca === 'exige_certificado' ||
      marca === 'exige_segundo_fator' ||
      marca === 'exige_cadastro_ou_perfil'
        ? marca
        : 'recusada';
    return {
      autenticacao: aut,
      consulta: 'recusa_nao_classificada',
      conexao: null,
      mensagemMascarada: null,
      parar: true,
    };
  }
  if (erro instanceof SemHabilitacaoNosAutosError) {
    return {
      autenticacao: 'aceita',
      consulta: 'sem_habilitacao_nos_autos',
      conexao: null,
      mensagemMascarada: null,
      parar: true,
    };
  }
  if (erro instanceof ProcessoNaoEncontradoError) {
    return {
      autenticacao: 'aceita',
      consulta: 'processo_nao_encontrado',
      conexao: null,
      mensagemMascarada: null,
      parar: true,
    };
  }
  if (erro instanceof RespostaInvalidaError) {
    if (status === 401) {
      return {
        autenticacao: 'http_401',
        consulta: 'nao_executada',
        conexao: null,
        mensagemMascarada: null,
        parar: true,
      };
    }
    if (status === 404) {
      return {
        autenticacao: null,
        consulta: 'nao_executada',
        conexao: 'url_nao_encontrada_http_404',
        mensagemMascarada: null,
        parar: true,
      };
    }
    if (status !== undefined && status >= 400) {
      return {
        autenticacao: null,
        consulta: 'http_4xx',
        conexao: 'http_outro',
        mensagemMascarada: null,
        parar: true,
      };
    }
    // soap:Fault de serviço de autenticação costuma ter a frase na `faultstring`.
    const marca = marcarMensagemDoTribunal(erro.message);
    if (marca !== 'nao_classificada' && marca !== 'processo_nao_encontrado')
      return doTexto(erro.message);
    return {
      autenticacao: 'nao_determinada',
      consulta: 'resposta_malformada',
      conexao: null,
      mensagemMascarada: null,
      parar: true,
    };
  }
  if (erro instanceof ProviderIndisponivelError) {
    const m = erro.message;
    if (/: timeout$/i.test(m) || m.includes('timeout')) {
      return {
        autenticacao: null,
        consulta: 'tempo_esgotado',
        conexao: 'tempo_esgotado',
        mensagemMascarada: null,
        parar: true,
      };
    }
    if (m.includes('falha de rede')) {
      const conexao = classificarFalhaDeRede(erro);
      return {
        autenticacao: null,
        consulta: 'falha_de_rede',
        conexao,
        mensagemMascarada: null,
        parar: true,
      };
    }
    const http = /HTTP (\d{3})/.exec(m);
    if (http) {
      return {
        autenticacao: null,
        consulta: 'http_5xx',
        conexao: 'http_5xx',
        mensagemMascarada: null,
        parar: true,
      };
    }
    const recusa = /o tribunal recusou a consulta: (.*)$/s.exec(m);
    if (recusa) return doTexto(recusa[1] ?? '');
  }
  return {
    autenticacao: 'nao_determinada',
    consulta: 'recusa_nao_classificada',
    conexao: null,
    mensagemMascarada: null,
    parar: true,
  };
}

// --- as etapas ------------------------------------------------------------------------------------

function lerOWsdl(
  r: RespostaDoWsdl,
): NonNullable<RelatorioDaSonda['conexao']['wsdl']> | null {
  if (r.status < 200 || r.status >= 300) return null;
  const corpo = r.corpo;
  if (!/definitions|wsdl/i.test(corpo)) return null;
  const tem = (op: string): boolean => new RegExp(`name=["']${op}["']`).test(corpo);
  return {
    lido: true,
    oferece_consultarProcesso: tem('consultarProcesso'),
    oferece_consultarAvisosPendentes: tem('consultarAvisosPendentes'),
    oferece_consultarTeorComunicacao: tem('consultarTeorComunicacao'),
    // Só para dizer ao dono que o tribunal tem; a sonda não chama nenhuma.
    operacoes_de_escrita_presentes:
      /name=["'](entregarManifestacaoProcessual|entregarManifestacao)["']/.test(corpo),
  };
}

const tipoDoArquivo = (mimetype: string): 'pdf' | 'html' | 'outro' => {
  const t = mimetype.toLowerCase();
  if (t.includes('pdf')) return 'pdf';
  if (t.includes('html')) return 'html';
  return 'outro';
};

const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;

function relatorioInicial(): RelatorioDaSonda {
  return {
    versao: VERSAO_DA_SONDA_MNI_PJE,
    conexao: { categoria: 'ok', statusHttp: null, wsdl: null },
    autenticacao: { categoria: 'nao_testada' },
    consultaSemDocumentos: {
      categoria: 'nao_executada',
      movimentos: null,
      partes: null,
      segredoDeJustica: null,
      mensagemMascarada: null,
    },
    consultaComDocumentos: {
      categoria: 'nao_executada',
      documentos: null,
      porTipo: null,
      comConteudo: null,
      somenteReferenciaSemConteudo: null,
      tamanhoKb: null,
      pdfs: null,
      mensagemMascarada: null,
    },
    avisosPendentes: 'nao_testado_por_risco_de_ciencia',
    veredito: 'inviavel',
    ressalvas: [],
    motivoDaInviabilidade: null,
  };
}

/** Roda a sonda. Nunca lança por causa do tribunal: tudo vira categoria no relatório. */
export async function executarSondaMniPje(
  d: DependenciasDaSondaMniPje,
): Promise<RelatorioDaSonda> {
  const segredos = [
    d.credencial.identificacao,
    d.credencial.senha,
    d.numeroProcesso,
    d.url,
  ];
  let r = relatorioInicial();
  const encerrar = (motivo: string): RelatorioDaSonda => ({
    ...r,
    veredito: 'inviavel',
    motivoDaInviabilidade: motivo,
  });

  // 1. Conexão e TLS: GET da descrição do serviço, SEM credencial.
  const base = d.url.replace(/\?wsdl$/i, '');
  const urlDoWsdl = base.includes('?') ? base : `${base}?wsdl`;
  try {
    const w = await d.lerWsdl(urlDoWsdl);
    const wsdl = lerOWsdl(w);
    let conexao: CategoriaDeConexao = 'ok';
    if (w.status === 404) conexao = 'url_nao_encontrada_http_404';
    else if (w.status >= 500) conexao = 'http_5xx';
    else if (w.status >= 300 && w.status !== 401 && w.status !== 403)
      conexao = 'http_outro';
    r = { ...r, conexao: { categoria: conexao, statusHttp: w.status, wsdl } };
    if (conexao === 'url_nao_encontrada_http_404') {
      return encerrar('o endereço informado não existe no tribunal (HTTP 404)');
    }
    if (wsdl && !wsdl.oferece_consultarProcesso) {
      return encerrar('o serviço não oferece a operação de consulta de processo');
    }
  } catch (erro) {
    const categoria = classificarFalhaDeRede(erro);
    r = { ...r, conexao: { categoria, statusHttp: null, wsdl: null } };
    // Falha de conexão no WSDL já diz tudo: não se tenta a consulta (tentativa única, sem insistir).
    return encerrar(`não foi possível conectar ao serviço (${categoria})`);
  }

  // 2 e 3. Consulta SEM documentos (a primeira chamada autenticada).
  try {
    const c = await d.adaptador.consultarProcessoBruto(d.numeroProcesso, d.credencial, {
      incluirCabecalho: true,
      incluirDocumentos: false,
    });
    const conteudo = c.resposta.conteudo;
    if (!tribunalEntregouOConteudo(conteudo)) {
      r = {
        ...r,
        autenticacao: { categoria: 'aceita' },
        consultaSemDocumentos: {
          ...r.consultaSemDocumentos,
          categoria: 'sem_habilitacao_nos_autos',
        },
      };
      return encerrar(
        'o tribunal aceitou a credencial mas não entregou a linha do tempo (sem habilitação nos autos)',
      );
    }
    r = {
      ...r,
      autenticacao: { categoria: 'aceita' },
      consultaSemDocumentos: {
        categoria: 'ok',
        movimentos: extrairMovimentos(conteudo).length,
        partes: contarPartes(conteudo),
        segredoDeJustica: (extrairNivelSigiloDoProcesso(conteudo) ?? 0) > 0,
        mensagemMascarada: null,
      },
    };
  } catch (erro) {
    const f = classificarFalha(erro, d.ultimoStatusHttp(), segredos);
    r = {
      ...r,
      conexao: f.conexao
        ? {
            ...r.conexao,
            categoria: f.conexao,
            statusHttp: d.ultimoStatusHttp() ?? r.conexao.statusHttp,
          }
        : r.conexao,
      autenticacao: { categoria: f.autenticacao ?? 'nao_determinada' },
      consultaSemDocumentos: {
        ...r.consultaSemDocumentos,
        categoria: f.consulta,
        mensagemMascarada: f.mensagemMascarada,
      },
    };
    return encerrar(motivoDaFalha(r));
  }

  // 4. Consulta COM documentos. Só chega aqui com a credencial aceita.
  const ressalvas: string[] = [];
  try {
    const c = await d.adaptador.consultarProcessoBruto(d.numeroProcesso, d.credencial, {
      incluirCabecalho: true,
      incluirDocumentos: true,
    });
    const conteudo = c.resposta.conteudo;
    const ids = idsDeTodosOsDocumentos(conteudo);
    const { obtidos, semTeor, ausentes } = extrairConteudosDoLote(
      conteudo,
      ids,
      c.anexos,
    );
    const porTipo = { pdf: 0, html: 0, outro: 0 };
    for (const o of obtidos) porTipo[tipoDoArquivo(o.mimetype)] += 1;
    // Documento que veio só como ficha (sem arquivo) não tem tipo confiável de conteúdo: conta por mimetype
    // declarado na ficha seria outra leitura; aqui fica só em `somenteReferenciaSemConteudo`.
    const tamanhos = obtidos.map((o) => o.bytes.length);
    const pdfs = obtidos.filter((o) => tipoDoArquivo(o.mimetype) === 'pdf');
    let comTexto = 0;
    let semTexto = 0;
    let ilegiveis = 0;
    const amostra = pdfs.slice(0, Math.max(0, d.maxPdfsParaTexto));
    for (const p of amostra) {
      try {
        const t = await d.extrator.extrair(p.bytes);
        if (t.contagens.temTextoPesquisavel) comTexto += 1;
        else semTexto += 1;
      } catch {
        ilegiveis += 1;
      }
    }
    r = {
      ...r,
      consultaComDocumentos: {
        categoria: 'ok',
        documentos: ids.length,
        porTipo,
        comConteudo: obtidos.length,
        somenteReferenciaSemConteudo: semTeor.length + ausentes.length,
        tamanhoKb:
          tamanhos.length === 0
            ? null
            : {
                minimo: kb(Math.min(...tamanhos)),
                mediano: kb(percentil(tamanhos, 0.5) ?? 0),
                maximo: kb(Math.max(...tamanhos)),
              },
        pdfs: { examinados: amostra.length, comTexto, semTexto, ilegiveis },
        mensagemMascarada: null,
      },
    };
    if (ids.length === 0) ressalvas.push('o processo não tem documentos para testar');
    else if (obtidos.length === 0) ressalvas.push('nenhum documento veio com conteúdo');
    else if (semTeor.length + ausentes.length > 0) {
      ressalvas.push(
        `${semTeor.length + ausentes.length} documento(s) vieram só como referência, sem conteúdo`,
      );
    }
    if (pdfs.length > amostra.length) {
      ressalvas.push(
        `a camada de texto foi conferida em ${amostra.length} de ${pdfs.length} PDFs`,
      );
    }
    if (semTexto + ilegiveis > 0) {
      ressalvas.push(
        `${semTexto + ilegiveis} PDF(s) sem texto pesquisável ou ilegíveis (sem OCR não são lidos)`,
      );
    }
    if (porTipo.html > 0) ressalvas.push(`${porTipo.html} documento(s) em HTML`);
    if (porTipo.outro > 0)
      ressalvas.push(`${porTipo.outro} documento(s) de tipo que não é PDF nem HTML`);
  } catch (erro) {
    const f = classificarFalha(erro, d.ultimoStatusHttp(), segredos);
    r = {
      ...r,
      consultaComDocumentos: {
        ...r.consultaComDocumentos,
        categoria: f.consulta,
        mensagemMascarada: f.mensagemMascarada,
      },
    };
    ressalvas.push(
      `a consulta com documentos falhou depois de a sem documentos funcionar (${f.consulta})`,
    );
    return {
      ...r,
      veredito: 'viavel_com_ressalvas',
      ressalvas,
      motivoDaInviabilidade: null,
    };
  }

  if (r.consultaSemDocumentos.segredoDeJustica === true) {
    ressalvas.push('o processo testado está em segredo de justiça');
  }
  if (r.conexao.wsdl === null) {
    ressalvas.push('a descrição do serviço (WSDL) não pôde ser lida');
  }
  const comConteudo = r.consultaComDocumentos.comConteudo ?? 0;
  const veredito: Veredito =
    ressalvas.length === 0 && comConteudo > 0 ? 'viavel' : 'viavel_com_ressalvas';
  return { ...r, veredito, ressalvas, motivoDaInviabilidade: null };
}

function motivoDaFalha(r: RelatorioDaSonda): string {
  const a = r.autenticacao.categoria;
  const mapa: Partial<Record<CategoriaDeAutenticacao, string>> = {
    recusada: 'o tribunal recusou a credencial',
    exige_certificado: 'o tribunal exige certificado digital',
    exige_segundo_fator: 'o tribunal exige segundo fator de autenticação',
    exige_cadastro_ou_perfil: 'o tribunal exige cadastro ou perfil prévio para o MNI',
    acesso_negado_http_403: 'o tribunal respondeu HTTP 403 (bloqueio ou acesso negado)',
    http_401: 'o serviço pede autenticação HTTP (401)',
  };
  const m = mapa[a];
  if (m) return m;
  const c = r.consultaSemDocumentos.categoria;
  const mapaC: Partial<Record<CategoriaDeConsulta, string>> = {
    processo_nao_encontrado:
      'o tribunal respondeu que o processo não existe para este consultante',
    resposta_malformada: 'a resposta do serviço não é um envelope MNI legível',
    tempo_esgotado: 'o serviço não respondeu a tempo',
    falha_de_rede: 'falha de rede ao consultar',
    http_5xx: 'o serviço respondeu erro de servidor (5xx)',
    http_4xx: 'o serviço recusou o pedido (HTTP 4xx)',
    recusa_nao_classificada:
      'o tribunal recusou a consulta por um motivo que a sonda não reconhece',
  };
  return mapaC[c] ?? `a consulta falhou (${c})`;
}

// --- saída ----------------------------------------------------------------------------------------

const numero = (v: number | null): string => (v === null ? '—' : String(v));
const sim = (v: boolean | null): string => (v === null ? '—' : v ? 'sim' : 'não');

/** A tabela de contagens e categorias. Nada além do que está em `RelatorioDaSonda`. */
export function linhasDoRelatorio(r: RelatorioDaSonda): string[] {
  const c = r.consultaSemDocumentos;
  const k = r.consultaComDocumentos;
  const w = r.conexao.wsdl;
  const linhas = [
    `Sonda MNI do PJe v${r.versao} — somente leitura; só contagens e categorias, nenhum dado do processo.`,
    '',
    '1. Conexão e TLS',
    `   categoria: ${r.conexao.categoria}${r.conexao.statusHttp === null ? '' : ` (HTTP ${r.conexao.statusHttp})`}`,
    w
      ? `   descrição do serviço lida: sim · oferece consultarProcesso: ${sim(w.oferece_consultarProcesso)} · consultarAvisosPendentes: ${sim(w.oferece_consultarAvisosPendentes)} · consultarTeorComunicacao: ${sim(w.oferece_consultarTeorComunicacao)} · tem operação de escrita: ${sim(w.operacoes_de_escrita_presentes)} (a sonda não chama nenhuma)`
      : '   descrição do serviço lida: não',
    '2. Autenticação',
    `   categoria: ${r.autenticacao.categoria}`,
    '3. Consulta do processo (sem documentos)',
    `   categoria: ${c.categoria} · movimentos: ${numero(c.movimentos)} · partes: ${numero(c.partes)} · segredo de justiça: ${sim(c.segredoDeJustica)}`,
  ];
  if (c.mensagemMascarada)
    linhas.push(`   mensagem do tribunal (mascarada): ${c.mensagemMascarada}`);
  linhas.push(
    '4. Consulta com documentos',
    `   categoria: ${k.categoria} · documentos: ${numero(k.documentos)} · com conteúdo: ${numero(k.comConteudo)} · só referência, sem conteúdo: ${numero(k.somenteReferenciaSemConteudo)}`,
  );
  if (k.porTipo) {
    linhas.push(
      `   por tipo de arquivo: pdf ${k.porTipo.pdf} · html ${k.porTipo.html} · outro ${k.porTipo.outro}`,
    );
  }
  if (k.tamanhoKb) {
    linhas.push(
      `   tamanho (KB): mínimo ${k.tamanhoKb.minimo} · mediano ${k.tamanhoKb.mediano} · máximo ${k.tamanhoKb.maximo}`,
    );
  }
  if (k.pdfs) {
    linhas.push(
      `   PDFs com camada de texto: ${k.pdfs.comTexto} de ${k.pdfs.examinados} examinados (sem texto ${k.pdfs.semTexto} · ilegíveis ${k.pdfs.ilegiveis})`,
    );
  }
  if (k.mensagemMascarada)
    linhas.push(`   mensagem do tribunal (mascarada): ${k.mensagemMascarada}`);
  linhas.push(
    '5. Avisos pendentes',
    '   não testado por risco de ciência',
    '',
    `VEREDITO: ${rotuloDoVeredito(r.veredito)}`,
  );
  if (r.motivoDaInviabilidade) linhas.push(`   motivo: ${r.motivoDaInviabilidade}`);
  for (const x of r.ressalvas) linhas.push(`   ressalva: ${x}`);
  return linhas;
}

export function rotuloDoVeredito(v: Veredito): string {
  return v === 'viavel'
    ? 'viável'
    : v === 'viavel_com_ressalvas'
      ? 'viável com ressalvas'
      : 'inviável';
}
