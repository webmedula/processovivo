import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ArmazemDoLeitor } from '../../domain/ports/ArmazemDoLeitor.js';

/**
 * Guarda temporária do leitor, em disco.
 *
 * Layout: `<raiz>/<hash do workspace>/<jobId>/...`. Três decisões:
 *
 * - **Pasta do workspace pelo HASH**, não pelo nome: o workspace nunca vira
 *   caminho, então nenhum valor dele (vindo de chave, sessão ou banco) pode
 *   carregar `..` ou `/` para dentro de um `join`.
 * - **Nome do arquivo combinado aleatório** (128 bits). Ninguém chega a ele por
 *   URL: a rota resolve o job no banco, confere o dono e só então lê. O nome
 *   aleatório é a segunda trava, para o dia em que alguém apontar um servidor
 *   estático para esta pasta por engano.
 * - **Fora do backup.** A raiz padrão é `<pasta do banco>/leitor`, e o backup
 *   copia o BANCO (`VACUUM INTO`), não a pasta. Quem copiar o volume inteiro à
 *   mão deve excluir `leitor/` — está no DEPLOY.md.
 *
 * O localizador devolvido é RELATIVO à raiz do workspace, e toda leitura
 * confere que ele resolve para dentro dela. Um localizador adulterado no banco
 * não abre arquivo de outro assinante.
 */
export class ArmazemEmDisco implements ArmazemDoLeitor {
  private readonly raiz: string;

  constructor(raiz: string) {
    this.raiz = resolve(raiz);
  }

  async gravarPeca(
    workspace: string,
    jobId: string,
    ordem: number,
    bytes: Uint8Array,
    extensao = 'bin',
  ): Promise<string> {
    // A extensão segue o tipo declarado (v0.66.1). No Ubuntu 26.04 o perfil
    // AppArmor do qpdf só deixa abrir `*.pdf`: com `.bin`, o `--show-npages`
    // dava "Permission denied" e TODA peça virava "PDF ilegível". Na imagem
    // Alpine não há AppArmor, mas o nome certo não custa nada e não depende
    // de onde o servidor roda.
    const ext = extensao.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'bin';
    const localizador = join(this.idJob(jobId), 'pecas', `${Math.trunc(ordem)}.${ext}`);
    const caminho = this.caminho(workspace, localizador);
    await mkdir(join(caminho, '..'), { recursive: true, mode: 0o700 });
    // 0600: são autos de processo. Ninguém além do processo do servidor lê.
    await writeFile(caminho, bytes, { mode: 0o600 });
    return localizador;
  }

  async gravarArquivo(
    workspace: string,
    pastaId: string,
    bytes: Uint8Array,
    extensao: string,
  ): Promise<string> {
    const localizador = this.novoArquivo(workspace, pastaId, extensao);
    const caminho = this.caminho(workspace, localizador);
    await mkdir(join(caminho, '..'), { recursive: true, mode: 0o700 });
    // 0600, como toda peça: ninguém além do processo do servidor lê.
    await writeFile(caminho, bytes, { mode: 0o600 });
    return localizador;
  }

  async apagarArquivo(workspace: string, localizador: string): Promise<number> {
    const caminho = this.caminho(workspace, localizador);
    let bytes = 0;
    try {
      bytes = (await stat(caminho)).size;
    } catch {
      return 0;
    }
    await unlink(caminho).catch(() => undefined);
    return bytes;
  }

  async removerTemporarios(idadeMinimaMs: number): Promise<number> {
    let removidos = 0;
    const limite = Date.now() - idadeMinimaMs;
    for (const caminho of await listarArquivos(this.raiz)) {
      if (!caminho.endsWith('.tmp')) continue;
      try {
        if ((await stat(caminho)).mtimeMs > limite) continue;
        await unlink(caminho);
        removidos += 1;
      } catch {
        // Sumiu entre a listagem e o apagar: o objetivo já foi atingido.
      }
    }
    return removidos;
  }

  novoArquivo(_workspace: string, jobId: string, extensao: string): string {
    const ext = extensao.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    return join(this.idJob(jobId), `${randomBytes(16).toString('hex')}.${ext}`);
  }

  async caminhoLocal(workspace: string, localizador: string): Promise<string> {
    const caminho = this.caminho(workspace, localizador);
    await mkdir(join(caminho, '..'), { recursive: true, mode: 0o700 });
    return caminho;
  }

  private caminho(workspace: string, localizador: string): string {
    const base = this.pastaDoWorkspace(workspace);
    if (isAbsolute(localizador))
      throw new Error('localizador do leitor não pode ser absoluto');
    const alvo = resolve(base, localizador);
    const rel = relative(base, alvo);
    if (
      rel === '' ||
      rel.startsWith('..') ||
      isAbsolute(rel) ||
      rel.split(sep).includes('..')
    ) {
      throw new Error('localizador do leitor fora da pasta do workspace');
    }
    return alvo;
  }

  async tamanho(workspace: string, localizador: string): Promise<number | undefined> {
    try {
      const s = await stat(this.caminho(workspace, localizador));
      return s.isFile() ? s.size : undefined;
    } catch {
      return undefined;
    }
  }

  async *ler(
    workspace: string,
    localizador: string,
    inicio: number,
    fim: number,
  ): AsyncIterable<Uint8Array> {
    const fluxo = createReadStream(this.caminho(workspace, localizador), {
      start: inicio,
      end: fim,
      highWaterMark: 256 * 1024,
    });
    for await (const pedaco of fluxo) yield pedaco as Buffer;
  }

  async limparTrabalho(
    workspace: string,
    jobId: string,
    manter: readonly string[],
  ): Promise<void> {
    const pasta = this.caminho(workspace, this.idJob(jobId));
    const preservar = new Set(manter.map((m) => this.caminho(workspace, m)));
    for (const caminho of await listarArquivos(pasta)) {
      if (!preservar.has(caminho)) await unlink(caminho).catch(() => undefined);
    }
    await rm(join(pasta, 'pecas'), { recursive: true, force: true });
  }

  async apagarJob(workspace: string, jobId: string): Promise<number> {
    const pasta = this.caminho(workspace, this.idJob(jobId));
    const bytes = await somarBytes(pasta);
    await rm(pasta, { recursive: true, force: true });
    return bytes;
  }

  async apagarWorkspace(workspace: string): Promise<number> {
    const pasta = this.pastaDoWorkspace(workspace);
    const bytes = await somarBytes(pasta);
    await rm(pasta, { recursive: true, force: true });
    return bytes;
  }

  async usoDoWorkspace(workspace: string): Promise<number> {
    return somarBytes(this.pastaDoWorkspace(workspace));
  }

  async usoTotal(): Promise<{ readonly bytes: number; readonly workspaces: number }> {
    let entradas: string[] = [];
    try {
      entradas = await readdir(this.raiz);
    } catch {
      return { bytes: 0, workspaces: 0 };
    }
    let bytes = 0;
    let workspaces = 0;
    for (const e of entradas) {
      const b = await somarBytes(join(this.raiz, e));
      if (b > 0) workspaces += 1;
      bytes += b;
    }
    return { bytes, workspaces };
  }

  private pastaDoWorkspace(workspace: string): string {
    const hash = createHash('sha256')
      .update(`leitor:${workspace}`)
      .digest('hex')
      .slice(0, 32);
    return join(this.raiz, hash);
  }

  /** Job id vira nome de pasta: só hexadecimal passa. */
  private idJob(jobId: string): string {
    if (!/^[a-f0-9]{16,64}$/.test(jobId))
      throw new Error('id de job do leitor malformado');
    return jobId;
  }
}

async function listarArquivos(pasta: string): Promise<string[]> {
  let entradas;
  try {
    entradas = await readdir(pasta, { withFileTypes: true });
  } catch {
    return [];
  }
  const saida: string[] = [];
  for (const e of entradas) {
    const caminho = join(pasta, e.name);
    if (e.isDirectory()) saida.push(...(await listarArquivos(caminho)));
    else if (e.isFile()) saida.push(caminho);
  }
  return saida;
}

async function somarBytes(pasta: string): Promise<number> {
  let total = 0;
  for (const caminho of await listarArquivos(pasta)) {
    try {
      total += (await stat(caminho)).size;
    } catch {
      // Apagado entre a listagem e o stat: não ocupa mais nada.
    }
  }
  return total;
}
