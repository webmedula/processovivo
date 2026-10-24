import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type { ExtratorDeTextoDePdf } from '../../domain/ports/ExtratorDeTextoDePdf.js';
import { MniAdapter } from '../../infrastructure/adapters/mni/MniAdapter.js';
import type { ModoDoSoapAction } from '../../infrastructure/adapters/mni/mni.envelope.js';
import { HttpClient } from '../../infrastructure/http/HttpClient.js';
import { PdftotextExtrator } from '../../infrastructure/pdf/PdftotextExtrator.js';
import {
  executarSondaMniPje,
  linhasDoRelatorio,
  type DependenciasDaSondaMniPje,
  type RespostaDoWsdl,
} from './sondaMniPje.js';

/**
 * O comando da sonda do MNI do PJe (`scripts/sonda-mni-pje.mjs`, v0.59.0). A lógica mora aqui, testada; o
 * script só liga o terminal (a leitura da senha sem eco).
 *
 * A credencial NUNCA vem por argumento de linha de comando (iria para o histórico do shell e para a lista de
 * processos): só por variável de ambiente do próprio Console ou por prompt sem eco. Depois de lida, as
 * variáveis são APAGADAS do ambiente do processo — o `pdftotext` que a sonda dispara herdaria o ambiente.
 * Nada é gravado em disco, nada vai a log.
 */
export const USO_DA_SONDA_MNI_PJE = `Uso: node scripts/sonda-mni-pje.mjs --url=<endereço do serviço MNI> --processo=<número CNJ>
  [--timeout=<segundos, padrão 60>] [--soap-action=cnj|vazio] [--max-pdfs=<padrão 40>]

Sonda SOMENTE LEITURA: uma consulta sem documentos e uma com documentos, no máximo, e para na primeira
recusa de autenticação. Não consulta avisos pendentes (risco de ciência). Saída: só contagens e categorias.

Credencial (nunca por argumento): variáveis SONDA_MNI_CPF e SONDA_MNI_SENHA, ou digitada quando o
programa perguntar (sem eco). Também aceitam variável: SONDA_MNI_URL e SONDA_MNI_PROCESSO.`;

const ARGUMENTOS_DE_CREDENCIAL = [
  'cpf',
  'senha',
  'password',
  'usuario',
  'login',
  'token',
  'credencial',
];
const TIMEOUT_PADRAO_S = 60;
const TIMEOUT_MAXIMO_S = 300;
const MAX_PDFS_PADRAO = 40;

/** Cliente HTTP que lembra o status da última resposta de POST (a sonda usa para separar 401/404/415…). */
export class HttpClientObservado extends HttpClient {
  ultimoStatus: number | undefined;

  override async postXml(
    ...args: Parameters<HttpClient['postXml']>
  ): ReturnType<HttpClient['postXml']> {
    this.ultimoStatus = undefined;
    const r = await super.postXml(...args);
    this.ultimoStatus = r.status;
    return r;
  }
}

export interface EntradasDoComandoMniPje {
  readonly argv: readonly string[];
  /** O ambiente do processo. As variáveis da sonda são APAGADAS daqui depois de lidas. */
  readonly env: Record<string, string | undefined>;
  /** Pergunta ao terminal SEM eco. `undefined` quando não há terminal interativo. */
  readonly perguntarSemEco: (rotulo: string) => Promise<string | undefined>;
  readonly saida: (linha: string) => void;
  readonly aviso: (linha: string) => void;
  /** Só os testes trocam: cria o cliente HTTP (dublê) e o extrator. */
  readonly criarHttp?: (timeoutMs: number) => HttpClientObservado;
  readonly criarExtrator?: () => ExtratorDeTextoDePdf;
}

interface Argumentos {
  url?: string;
  processo?: string;
  timeout?: string;
  soapAction?: string;
  maxPdfs?: string;
  ajuda: boolean;
}

/** `{ ok }` ou o motivo de recusa — a mensagem NUNCA repete o valor recebido. */
function lerArgumentos(
  argv: readonly string[],
): { readonly a: Argumentos } | { readonly erro: string } {
  const a: Argumentos = { ajuda: false };
  for (const bruto of argv) {
    if (bruto === '--ajuda') {
      a.ajuda = true;
      continue;
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(bruto);
    const nome = m?.[1] ?? '';
    if (ARGUMENTOS_DE_CREDENCIAL.includes(nome)) {
      return {
        erro:
          'A credencial não é aceita como argumento (ficaria no histórico do shell). ' +
          'Use as variáveis SONDA_MNI_CPF e SONDA_MNI_SENHA ou digite quando o programa perguntar.',
      };
    }
    const valor = m?.[2];
    if (nome === 'url' && valor !== undefined) a.url = valor;
    else if (nome === 'processo' && valor !== undefined) a.processo = valor;
    else if (nome === 'timeout' && valor !== undefined) a.timeout = valor;
    else if (nome === 'soap-action' && valor !== undefined) a.soapAction = valor;
    else if (nome === 'max-pdfs' && valor !== undefined) a.maxPdfs = valor;
    else
      return { erro: `Argumento desconhecido: ${nome === '' ? '(vazio)' : `--${nome}`}` };
  }
  return { a };
}

/** CPF digitado com máscara vira só dígitos; qualquer outra identificação segue como veio. */
function normalizarIdentificacao(texto: string): string {
  const t = texto.trim();
  return /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(t) ? t.replace(/\D/g, '') : t;
}

/** Devolve o código de saída: 0 viável ou com ressalvas, 1 inviável, 2 uso incorreto. */
export async function executarComandoSondaMniPje(
  e: EntradasDoComandoMniPje,
): Promise<number> {
  const lidos = lerArgumentos(e.argv);
  if ('erro' in lidos) {
    e.aviso(lidos.erro);
    e.aviso(USO_DA_SONDA_MNI_PJE);
    return 2;
  }
  const a = lidos.a;
  if (a.ajuda) {
    e.saida(USO_DA_SONDA_MNI_PJE);
    return 0;
  }

  // As variáveis da sonda saem do ambiente ANTES de qualquer outra coisa (filhos herdam o ambiente).
  const url = (a.url ?? e.env['SONDA_MNI_URL'] ?? '').trim();
  const processoBruto = (a.processo ?? e.env['SONDA_MNI_PROCESSO'] ?? '').trim();
  let cpf = e.env['SONDA_MNI_CPF'] ?? '';
  let senha = e.env['SONDA_MNI_SENHA'] ?? '';
  for (const v of [
    'SONDA_MNI_URL',
    'SONDA_MNI_PROCESSO',
    'SONDA_MNI_CPF',
    'SONDA_MNI_SENHA',
  ]) {
    delete e.env[v];
  }

  if (!/^https:\/\/[^\s/]+/i.test(url)) {
    e.aviso(
      'Informe --url=https://… (o endereço do serviço MNI do tribunal; só https, a senha vai no pedido).',
    );
    return 2;
  }
  let numero: NumeroCNJ;
  try {
    numero = NumeroCNJ.criar(processoBruto);
  } catch {
    e.aviso(
      'Informe --processo= com um número CNJ válido (20 dígitos, com dígito verificador).',
    );
    return 2;
  }
  const timeoutS = a.timeout === undefined ? TIMEOUT_PADRAO_S : Number(a.timeout);
  if (!Number.isInteger(timeoutS) || timeoutS < 5 || timeoutS > TIMEOUT_MAXIMO_S) {
    e.aviso(
      `--timeout deve ser um número inteiro de 5 a ${TIMEOUT_MAXIMO_S} (segundos).`,
    );
    return 2;
  }
  const soapAction = (a.soapAction ?? 'cnj') as ModoDoSoapAction;
  if (soapAction !== 'cnj' && soapAction !== 'vazio') {
    e.aviso('--soap-action deve ser "cnj" ou "vazio".');
    return 2;
  }
  const maxPdfs = a.maxPdfs === undefined ? MAX_PDFS_PADRAO : Number(a.maxPdfs);
  if (!Number.isInteger(maxPdfs) || maxPdfs < 0 || maxPdfs > 500) {
    e.aviso('--max-pdfs deve ser um número inteiro de 0 a 500.');
    return 2;
  }

  if (!cpf) cpf = (await e.perguntarSemEco('CPF do consultante (sem eco): ')) ?? '';
  if (!senha) senha = (await e.perguntarSemEco('Senha do consultante (sem eco): ')) ?? '';
  cpf = normalizarIdentificacao(cpf);
  if (!cpf || !senha) {
    e.aviso(
      'Faltou a credencial. Sem terminal interativo, defina SONDA_MNI_CPF e SONDA_MNI_SENHA só para este comando.',
    );
    return 2;
  }
  if (numero.siglaTribunal !== 'TRT18') {
    e.aviso(
      'Atenção: o número informado não parece ser de um processo do TRT18. A sonda segue.',
    );
  }

  const timeoutMs = timeoutS * 1000;
  const http =
    e.criarHttp?.(timeoutMs) ?? new HttpClientObservado({ timeoutMs, tentativas: 1 });
  const endpoint = url.replace(/\?wsdl$/i, '');
  const adaptador = new MniAdapter({
    endpoint,
    tribunais: ['TRT18'],
    httpClient: http,
    soapAction,
    // Duas chamadas no máximo; o balde só existe para nunca virar rajada.
    limitePorMinuto: 5,
  });
  const lerWsdl = async (u: string): Promise<RespostaDoWsdl> => {
    const r = await http.requisitar(
      { metodo: 'GET', url: u, headers: { accept: 'text/xml, application/xml, */*' } },
      { tentativas: 1, timeoutMs },
    );
    return {
      status: r.status,
      contentType: r.headers['content-type'] ?? '',
      corpo: new TextDecoder().decode(r.bytes.subarray(0, 2_000_000)),
    };
  };
  const deps: DependenciasDaSondaMniPje = {
    url: endpoint,
    numeroProcesso: numero.digitos,
    credencial: { tribunal: 'TRT18', identificacao: cpf, senha },
    adaptador,
    ultimoStatusHttp: () => http.ultimoStatus,
    lerWsdl,
    extrator: e.criarExtrator?.() ?? new PdftotextExtrator(),
    maxPdfsParaTexto: maxPdfs,
  };

  const relatorio = await executarSondaMniPje(deps);
  for (const linha of linhasDoRelatorio(relatorio)) e.saida(linha);
  return relatorio.veredito === 'inviavel' ? 1 : 0;
}
