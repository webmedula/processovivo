import { ComprovanteInvalidoError } from '../errors/index.js';

/**
 * Comprovante de um lançamento de custo (v0.49.0): guia, recibo ou comprovante de pagamento que o
 * advogado anexa ao lançamento. **O arquivo mora no Google Drive DO ADVOGADO**, nunca no nosso
 * servidor: aqui só ficam o identificador do arquivo no Drive, o link, o nome, o tamanho e a data
 * em que foi anexado. Remover é só desfazer o vínculo — o arquivo continua no Drive.
 */
export const LIMITE_COMPROVANTES_POR_LANCAMENTO = 5;
export const TAMANHO_MAXIMO_DO_COMPROVANTE = 5 * 1024 * 1024;
export const LIMITE_NOME_DO_COMPROVANTE = 100;

export type TipoDeComprovante = 'application/pdf' | 'image/jpeg' | 'image/png';

const EXTENSAO: Readonly<Record<TipoDeComprovante, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export interface Comprovante {
  readonly id: string;
  readonly workspace: string;
  readonly custoId: string;
  readonly numeroProcesso: string;
  /** O id do arquivo no Drive do advogado. */
  readonly arquivoId: string;
  /** Endereço para abrir no Drive (sempre do domínio do Google). */
  readonly link: string;
  readonly nome: string;
  readonly tipo: TipoDeComprovante;
  readonly tamanho: number;
  readonly anexadoEm: Date;
}

/**
 * O tipo REAL do arquivo, pelos primeiros bytes (a "assinatura" do formato). A extensão e o
 * `Content-Type` que o navegador manda são palpite do cliente: um `.pdf` que é outra coisa, ou um
 * executável renomeado, não passa por aqui.
 */
export function detectarTipoDoComprovante(b: Uint8Array): TipoDeComprovante | undefined {
  if (
    b.length >= 5 &&
    b[0] === 0x25 &&
    b[1] === 0x50 &&
    b[2] === 0x44 &&
    b[3] === 0x46 &&
    b[4] === 0x2d
  ) {
    return 'application/pdf';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return 'image/png';
  return undefined;
}

/**
 * Nome seguro para mostrar e para o Drive: sem caminho, sem caractere de controle nem os que o
 * sistema de arquivos proíbe, no máximo 100 caracteres, e SEMPRE com a extensão do tipo REAL
 * (um PNG nunca fica com nome `.pdf`). Nome vazio vira `comprovante`.
 */
export function sanearNomeDoComprovante(nome: unknown, tipo: TipoDeComprovante): string {
  const bruto = typeof nome === 'string' ? nome : '';
  const semCaminho = bruto.split(/[\\/]/).pop() ?? '';
  // Sem caractere de controle (código < 32 e 127) nem os que o sistema de arquivos proíbe.
  const limpo = [...semCaminho]
    .map((c) => {
      const cp = c.codePointAt(0) ?? 0;
      return cp < 32 || cp === 127 || '<>:"|?*'.includes(c) ? ' ' : c;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const ponto = limpo.lastIndexOf('.');
  // Nome que começa pelo ponto (".pdf") não tem base: a extensão sozinha não é um nome.
  const base = (ponto > 0 ? limpo.slice(0, ponto) : ponto === 0 ? '' : limpo)
    .replace(/^\.+/, '')
    .trim();
  const cortado = base.slice(0, LIMITE_NOME_DO_COMPROVANTE - 5).trim();
  return `${cortado || 'comprovante'}.${EXTENSAO[tipo]}`;
}

export interface ComprovanteValidado {
  readonly nome: string;
  readonly tipo: TipoDeComprovante;
  readonly tamanho: number;
}

/**
 * Confere o arquivo recebido. As mensagens são do sistema, curtas, e NUNCA repetem o nome nem o
 * conteúdo enviados.
 */
export function validarComprovante(
  conteudo: unknown,
  nomeInformado: unknown,
  tipoDeclarado: unknown,
): ComprovanteValidado {
  if (!(conteudo instanceof Uint8Array) || conteudo.length === 0) {
    throw new ComprovanteInvalidoError(
      'arquivo_vazio',
      'Escolha um arquivo para anexar.',
    );
  }
  if (conteudo.length > TAMANHO_MAXIMO_DO_COMPROVANTE) {
    throw new ComprovanteInvalidoError(
      'arquivo_grande',
      'O comprovante pode ter até 5 MB.',
    );
  }
  const tipo = detectarTipoDoComprovante(conteudo);
  if (!tipo) {
    throw new ComprovanteInvalidoError(
      'tipo_nao_aceito',
      'Anexe um PDF, uma imagem JPEG ou uma imagem PNG.',
    );
  }
  // O que o navegador declarou tem de bater com o conteúdo: arquivo que diz ser uma coisa e é outra
  // é recusado, não "corrigido".
  if (typeof tipoDeclarado === 'string' && tipoDeclarado) {
    const declarado = tipoDeclarado.split(';')[0]?.trim().toLowerCase();
    const equivalente = declarado === 'image/jpg' ? 'image/jpeg' : declarado;
    if (equivalente !== tipo && equivalente !== 'application/octet-stream') {
      throw new ComprovanteInvalidoError(
        'tipo_nao_aceito',
        'O conteúdo do arquivo não é do tipo informado. Anexe um PDF, JPEG ou PNG de verdade.',
      );
    }
  }
  return {
    nome: sanearNomeDoComprovante(nomeInformado, tipo),
    tipo,
    tamanho: conteudo.length,
  };
}
