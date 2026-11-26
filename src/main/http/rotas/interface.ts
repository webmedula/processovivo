import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { VERSAO } from '../../../infrastructure/config/versao.js';
import { FAVICON_ICO, ICONE_DA_TELA_INICIAL_PNG } from '../ui/icones.js';
import {
  ICONES_DO_APLICATIVO,
  MANIFESTO,
  ROTA_MANIFESTO,
  ROTA_SERVICE_WORKER,
  serviceWorker,
} from '../ui/aplicativo.js';
import { paginaConsole } from '../ui/pagina.js';

export const ROTA_CONSOLE = '/';
export const ROTA_FONTES = '/ui/fontes/:arquivo';
/** Prefixo, para o rate limit deixar as fontes de fora como deixa o console. */
export const PREFIXO_FONTES = '/ui/fontes/';
export const ROTA_PDFJS = '/ui/pdfjs/:arquivo';
export const PREFIXO_PDFJS = '/ui/pdfjs/';
/** Os ícones que o navegador pede sozinho (Safari, iPhone): sem chave, sem dado, sem cota. */
export const ROTA_FAVICON = '/favicon.ico';
export const ROTA_ICONE_DA_TELA_INICIAL = '/apple-touch-icon.png';

/**
 * Os arquivos do PDF.js que o leitor carrega, servidos pelo PRÓPRIO servidor.
 *
 * Mesma regra das fontes: nada vem de CDN. O console abre atrás do firewall de
 * um fórum, e os autos do processo não podem depender de um terceiro saber que
 * alguém está lendo um PDF. É a ÚNICA dependência de front do console (CLAUDE.md
 * §8), e entra por `import()` dinâmico do painel — a página continua sem
 * nenhum `<script src>`.
 *
 * Lista FECHADA, montada no arranque a partir do pacote: o parâmetro da URL é
 * só uma chave num mapa, nunca um caminho. Além do motor e do worker, vão as
 * fontes padrão do PDF (para PDF sem fonte embutida — as páginas que o pdf-lib
 * gera usam Helvetica sem embutir), o decodificador de JBIG2 (comum em
 * digitalização) e o perfil de cor.
 */
const PASTAS_PDFJS: ReadonlyArray<readonly [pasta: string, filtro: RegExp]> = [
  // O build `legacy`, e não o padrão: o padrão do pdfjs-dist 6 usa
  // `Map.prototype.getOrInsertComputed`, recurso de 2025 que navegador de
  // escritório não atualizado (e o Chromium dos testes) não tem — a página
  // simplesmente não desenha, sem erro na tela. O legacy traz o polyfill.
  ['legacy/build', /^pdf(\.worker)?\.min\.mjs$/],
  ['standard_fonts', /\.(pfb|ttf)$/],
  ['wasm', /\.(wasm|js)$/],
  ['iccs', /\.icc$/],
  ['cmaps', /\.bcmap$/],
];

const TIPOS_PDFJS: Readonly<Record<string, string>> = {
  mjs: 'text/javascript; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  wasm: 'application/wasm',
  ttf: 'font/ttf',
};

function carregarPdfjs(): Map<string, { readonly bytes: Buffer; readonly tipo: string }> {
  const exigir = createRequire(import.meta.url);
  const raiz = dirname(exigir.resolve('pdfjs-dist/package.json'));
  const mapa = new Map<string, { readonly bytes: Buffer; readonly tipo: string }>();
  for (const [pasta, filtro] of PASTAS_PDFJS) {
    for (const nome of readdirSync(join(raiz, pasta))) {
      if (!filtro.test(nome)) continue;
      // Um nome repetido entre pastas faria a segunda versão sobrescrever a
      // primeira sem aviso. Melhor o deploy cair aqui.
      if (mapa.has(nome))
        throw new Error(`pdfjs-dist: arquivo repetido entre pastas: ${nome}`);
      const extensao = nome.slice(nome.lastIndexOf('.') + 1);
      mapa.set(nome, {
        bytes: readFileSync(join(raiz, pasta, nome)),
        tipo: TIPOS_PDFJS[extensao] ?? 'application/octet-stream',
      });
    }
  }
  if (!mapa.has('pdf.min.mjs') || !mapa.has('pdf.worker.min.mjs')) {
    throw new Error(
      'pdfjs-dist sem pdf.min.mjs/pdf.worker.min.mjs — o leitor não abriria',
    );
  }
  return mapa;
}

/**
 * As fontes do console, servidas pelo PRÓPRIO servidor.
 *
 * Não vêm do Google Fonts, e isso é regra antiga deste projeto: um recurso
 * externo quebra o console de quem está atrás do firewall de um fórum, e há
 * teste que falha se a página carregar qualquer coisa de fora. Os arquivos
 * vêm dos pacotes `@fontsource` (licença OFL), que são dependência de
 * produção — por isso existem dentro da imagem sem mudar o Dockerfile.
 *
 * Só o subconjunto "latin": cobre o português inteiro (á, ç, ã, õ, ê estão
 * todos em U+00C0–U+00FF) e pesa 27 KB na fonte variável.
 *
 * Lista FECHADA de nomes: o parâmetro da URL nunca vira caminho de arquivo, e
 * portanto não existe `../` que leia outra coisa do disco.
 */
const FONTES: Readonly<Record<string, readonly [pacote: string, arquivo: string]>> = {
  'plus-jakarta-sans.woff2': [
    '@fontsource-variable/plus-jakarta-sans',
    'files/plus-jakarta-sans-latin-wght-normal.woff2',
  ],
  'jetbrains-mono-500.woff2': [
    '@fontsource/jetbrains-mono',
    'files/jetbrains-mono-latin-500-normal.woff2',
  ],
  'jetbrains-mono-600.woff2': [
    '@fontsource/jetbrains-mono',
    'files/jetbrains-mono-latin-600-normal.woff2',
  ],
};

/**
 * Lê as fontes no arranque. O `exports` desses pacotes não publica os
 * `.woff2` (só o CSS), então o caminho parte do CSS que ele publica — o
 * arquivo fica ao lado, em `files/`.
 */
function carregarFontes(): Map<string, Buffer> {
  const exigir = createRequire(import.meta.url);
  const carregadas = new Map<string, Buffer>();
  for (const [nome, [pacote, arquivo]] of Object.entries(FONTES)) {
    const raiz = dirname(exigir.resolve(pacote));
    carregadas.set(nome, readFileSync(join(raiz, arquivo)));
  }
  return carregadas;
}

/**
 * Serve o console web na raiz.
 *
 * A página é PÚBLICA (não pede chave) porque ela não carrega dado nenhum: é
 * HTML estático. Os dados continuam atrás da autenticação — o que a página faz
 * é mandar o header `x-api-key` no `fetch`, que é justamente o que um navegador
 * não consegue fazer digitando a URL.
 *
 * Servir da mesma origem da API elimina o CORS de vez: nada de configurar
 * origem liberada para o console funcionar.
 */
export function rotasDeInterface(): FastifyPluginAsync {
  return async (servidor) => {
    const html = paginaConsole(VERSAO);
    // No arranque, e não na primeira requisição: se um pacote de fonte
    // faltar na imagem, o deploy falha na hora em vez de o console aparecer
    // com a fonte do sistema sem ninguém perceber.
    const fontes = carregarFontes();
    // Também no arranque, pelo mesmo motivo: sem o PDF.js na imagem, o leitor
    // abriria um painel vazio. O deploy cai aqui, onde a causa é visível.
    const pdfjs = carregarPdfjs();

    servidor.get(ROTA_CONSOLE, async (_requisicao, resposta) => {
      resposta.header('content-type', 'text/html; charset=utf-8');
      // Console não deve ser indexado nem cacheado por proxy: muda a cada deploy.
      resposta.header('cache-control', 'no-store');
      resposta.header('x-robots-tag', 'noindex');
      return html;
    });

    servidor.get<{ Params: { arquivo: string } }>(ROTA_FONTES, async (req, resposta) => {
      const fonte = fontes.get(req.params.arquivo);
      if (!fonte) {
        void resposta.code(404);
        return { erro: 'NAO_ENCONTRADO', mensagem: 'Fonte desconhecida.' };
      }
      resposta.header('content-type', 'font/woff2');
      // Ao contrário do HTML, a fonte não muda entre deploys: 30 dias de
      // cache poupam 70 KB a cada abertura do console.
      resposta.header('cache-control', 'public, max-age=2592000');
      return fonte;
    });

    // Uma semana de cache: o ícone muda quase nunca, e o navegador o pede a cada aba.
    servidor.get(ROTA_FAVICON, async (_requisicao, resposta) => {
      resposta.header('content-type', 'image/x-icon');
      resposta.header('cache-control', 'public, max-age=604800');
      return FAVICON_ICO;
    });
    servidor.get(ROTA_ICONE_DA_TELA_INICIAL, async (_requisicao, resposta) => {
      resposta.header('content-type', 'image/png');
      resposta.header('cache-control', 'public, max-age=604800');
      return ICONE_DA_TELA_INICIAL_PNG;
    });

    // O aplicativo instalável (v0.70.0, `ui/aplicativo.ts`): manifesto, worker e ícones, sem dado.
    servidor.get(ROTA_MANIFESTO, async (_requisicao, resposta) => {
      resposta.header('content-type', 'application/manifest+json; charset=utf-8');
      resposta.header('cache-control', 'public, max-age=86400');
      return MANIFESTO;
    });
    const textoDoWorker = serviceWorker(VERSAO);
    servidor.get(ROTA_SERVICE_WORKER, async (_requisicao, resposta) => {
      resposta.header('content-type', 'text/javascript; charset=utf-8');
      // Sem cache: é por este arquivo que o navegador percebe um deploy novo do worker.
      resposta.header('cache-control', 'no-cache');
      resposta.header('x-content-type-options', 'nosniff');
      return textoDoWorker;
    });
    for (const [caminho, bytes] of ICONES_DO_APLICATIVO) {
      servidor.get(caminho, async (_requisicao, resposta) => {
        resposta.header('content-type', 'image/png');
        resposta.header('cache-control', 'public, max-age=604800');
        return bytes;
      });
    }

    servidor.get<{ Params: { arquivo: string } }>(ROTA_PDFJS, async (req, resposta) => {
      const arquivo = pdfjs.get(req.params.arquivo);
      if (!arquivo) {
        void resposta.code(404);
        return { erro: 'NAO_ENCONTRADO', mensagem: 'Arquivo do leitor desconhecido.' };
      }
      resposta.header('content-type', arquivo.tipo);
      resposta.header('x-content-type-options', 'nosniff');
      // Um dia, e não trinta como as fontes: a versão do PDF.js muda com o
      // package.json, e o nome do arquivo não carrega a versão.
      resposta.header('cache-control', 'public, max-age=86400');
      return arquivo.bytes;
    });
  };
}
