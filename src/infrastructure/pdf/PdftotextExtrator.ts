import { execFile } from 'node:child_process';
import { ExtracaoDeTextoError } from '../../domain/errors/index.js';
import type {
  ExtratorDeTextoDePdf,
  OpcoesDeExtracao,
  TextoExtraido,
} from '../../domain/ports/ExtratorDeTextoDePdf.js';

/**
 * Extrai o texto de um PDF com o `pdftotext -layout` do poppler (já na imagem desde a 0.30.0).
 *
 * Decisões de segurança — o PDF vem de tribunal e é tratado como entrada hostil:
 *
 * - **Processo filho por `execFile`, argumentos em VETOR**, nunca por string de shell. O PDF
 *   entra pela entrada padrão (nada é gravado em disco) e o binário é o único que o lê.
 * - **Tamanho máximo ANTES de abrir** (`maxBytes`) e cabeçalho `%PDF-` conferido: arquivo que
 *   não é PDF nem chega ao binário.
 * - **Tempo limite curto** (30 s por peça) com `SIGKILL`, e **`maxBuffer`** na saída: PDF que
 *   trava ou explode em texto vira erro tipado, não processo pendurado nem memória sem fim.
 * - **Páginas lidas limitadas** (`-l`): lê no máximo `maxPaginas + 1` para saber que passou.
 * - **Erro em português e sem texto**: a mensagem nunca carrega a saída do binário (poderia
 *   ecoar trecho do PDF) nem nome de arquivo. `pdf_protegido` quando o binário pede senha.
 *
 * NÃO limita CPU nem memória do filho (exigiria `ulimit`/cgroup do contêiner): relatado no
 * documento da Fase 0 como risco residual — o teto de tempo e de saída é o que se garante aqui.
 */

export const TAMANHO_MAXIMO_PADRAO_BYTES = 20 * 1024 * 1024;
export const TEMPO_LIMITE_PADRAO_MS = 30_000;
export const PAGINAS_MAXIMAS_PADRAO = 40;
export const CARACTERES_MAXIMOS_PADRAO = 80_000;
const SAIDA_MAXIMA_PADRAO_BYTES = 8 * 1024 * 1024;
const CARACTERES_MINIMOS_PARA_TER_TEXTO = 50;

export interface ResultadoDoProcesso {
  readonly codigo: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type FalhaDoProcesso =
  'tempo_esgotado' | 'saida_grande_demais' | 'ferramenta_ausente';

/** Roda o binário com o PDF na entrada padrão. Injetável: o teste do tempo limite não espera 30 s. */
export type ExecutorDeProcesso = (
  binario: string,
  argumentos: readonly string[],
  entrada: Uint8Array,
  limites: { readonly timeoutMs: number; readonly maxBuffer: number },
) => Promise<ResultadoDoProcesso | { readonly falha: FalhaDoProcesso }>;

export const executarProcesso: ExecutorDeProcesso = (
  binario,
  argumentos,
  entrada,
  limites,
) =>
  new Promise((resolver) => {
    const filho = execFile(
      binario,
      [...argumentos],
      {
        encoding: 'utf8',
        timeout: limites.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: limites.maxBuffer,
        windowsHide: true,
      },
      (erro, stdout, stderr) => {
        if (!erro) return resolver({ codigo: 0, stdout, stderr });
        const e = erro as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        if (e.code === 'ENOENT') return resolver({ falha: 'ferramenta_ausente' });
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          return resolver({ falha: 'saida_grande_demais' });
        if (e.killed === true) return resolver({ falha: 'tempo_esgotado' });
        resolver({
          codigo: typeof e.code === 'number' ? e.code : 1,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
    // Filho que morre antes de ler a entrada (arquivo inválido) derruba o `write` com EPIPE.
    filho.stdin?.on('error', () => undefined);
    filho.stdin?.end(Buffer.from(entrada));
  });

export interface OpcoesDoExtrator {
  readonly binario?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxSaidaBytes?: number;
  readonly executar?: ExecutorDeProcesso;
  readonly agora?: () => number;
}

const MENSAGENS = {
  arquivo_vazio: 'O arquivo da peça está vazio.',
  arquivo_grande: 'O arquivo da peça passa do tamanho máximo para leitura de texto.',
  pdf_invalido: 'O arquivo da peça não é um PDF legível.',
  pdf_protegido: 'O PDF da peça está protegido por senha e não pode ser lido.',
  tempo_esgotado: 'A leitura do texto da peça passou do tempo limite.',
  saida_grande_demais: 'O texto da peça é grande demais para leitura.',
  ferramenta_ausente: 'A ferramenta de leitura de PDF (pdftotext) não está instalada.',
} as const;

function recusa(motivo: keyof typeof MENSAGENS): ExtracaoDeTextoError {
  return new ExtracaoDeTextoError(motivo, MENSAGENS[motivo]);
}

const compactar = (texto: string): string => texto.replace(/\s+/g, ' ').trim();

export class PdftotextExtrator implements ExtratorDeTextoDePdf {
  private readonly binario: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxSaidaBytes: number;
  private readonly executar: ExecutorDeProcesso;
  private readonly agora: () => number;

  constructor(opcoes: OpcoesDoExtrator = {}) {
    this.binario = opcoes.binario ?? 'pdftotext';
    this.timeoutMs = opcoes.timeoutMs ?? TEMPO_LIMITE_PADRAO_MS;
    this.maxBytes = opcoes.maxBytes ?? TAMANHO_MAXIMO_PADRAO_BYTES;
    this.maxSaidaBytes = opcoes.maxSaidaBytes ?? SAIDA_MAXIMA_PADRAO_BYTES;
    this.executar = opcoes.executar ?? executarProcesso;
    this.agora = opcoes.agora ?? (() => performance.now());
  }

  async extrair(
    bytes: Uint8Array,
    opcoes: OpcoesDeExtracao = {},
  ): Promise<TextoExtraido> {
    const maxPaginas = opcoes.maxPaginas ?? PAGINAS_MAXIMAS_PADRAO;
    const maxCaracteres = opcoes.maxCaracteres ?? CARACTERES_MAXIMOS_PADRAO;
    if (bytes.length === 0) throw recusa('arquivo_vazio');
    if (bytes.length > this.maxBytes) throw recusa('arquivo_grande');
    // PDF válido começa com %PDF- nos primeiros KB (o padrão tolera lixo antes do cabeçalho).
    const cabeca = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
    if (!cabeca.includes('%PDF-')) throw recusa('pdf_invalido');

    const inicio = this.agora();
    const r = await this.executar(
      this.binario,
      // -l maxPaginas + 1: lê uma a mais só para saber que o PDF passou do limite.
      [
        '-layout',
        '-enc',
        'UTF-8',
        '-eol',
        'unix',
        '-f',
        '1',
        '-l',
        String(maxPaginas + 1),
        '-',
        '-',
      ],
      bytes,
      { timeoutMs: this.timeoutMs, maxBuffer: this.maxSaidaBytes },
    );
    if ('falha' in r) throw recusa(r.falha);
    if (r.codigo !== 0) {
      // Só o texto de ERRO do binário decide o motivo, e ele nunca é repetido.
      throw recusa(/password/i.test(r.stderr) ? 'pdf_protegido' : 'pdf_invalido');
    }

    const partes = r.stdout.split('\f');
    // `pdftotext` termina cada página com \f: o último pedaço, vazio, não é página.
    if (partes.length > 0 && partes[partes.length - 1] === '') partes.pop();
    const truncado = partes.length > maxPaginas;
    const paginas = partes.slice(0, maxPaginas);
    const caracteres = paginas.reduce((a, p) => a + compactar(p).length, 0);
    const comTexto = paginas.filter(
      (p) => p.replace(/\s+/g, '').length >= CARACTERES_MINIMOS_PARA_TER_TEXTO,
    ).length;
    return {
      paginas,
      contagens: {
        paginasLidas: paginas.length,
        truncadoPorPaginas: truncado,
        caracteres,
        paginasComTexto: comTexto,
        temTextoPesquisavel: paginas.length > 0 && comTexto / paginas.length >= 0.5,
        excedeLimiteDeCaracteres: caracteres > maxCaracteres,
        duracaoMs: Math.max(0, this.agora() - inicio),
      },
    };
  }
}
