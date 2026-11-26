import {
  ICONE_DO_APLICATIVO_192_PNG,
  ICONE_DO_APLICATIVO_512_PNG,
  ICONE_RECORTAVEL_DO_APLICATIVO_512_PNG,
} from './icones.js';

/**
 * O console como aplicativo instalável (PWA, v0.70.0): manifesto, ícones e um service worker
 * MÍNIMO.
 *
 * O que ele NÃO faz, de propósito: guardar qualquer coisa. Nenhuma `Cache Storage`, nenhuma
 * resposta da API, nenhuma página com dado. O sistema depende de consulta ao vivo e mostrar um
 * retrato velho como se fosse o de agora é a mentira que a `procedencia` existe para impedir; e
 * dado de processo guardado no aparelho seria dado pessoal fora do nosso controle. Sem internet, o
 * que aparece é uma página que diz isso, montada a partir de uma string dentro do próprio worker.
 *
 * O worker só intercepta a NAVEGAÇÃO para `/` (o console). Todo o resto — `/v1/*`, `/admin`
 * (Basic Auth: a janela de senha do navegador não aparece para resposta vinda de worker), os
 * retornos do Google e do Mercado Pago, o feed do calendário, o PDF.js — segue direto para a rede,
 * sem passar por ele.
 *
 * Os arquivos são públicos e sem dado, como o favicon: o navegador os pede sozinho, sem chave.
 */
export const ROTA_MANIFESTO = '/manifest.webmanifest';
export const ROTA_SERVICE_WORKER = '/sw.js';

/** Ícones do manifesto: caminho → bytes. Lista FECHADA; o caminho nunca vira arquivo de disco. */
export const ICONES_DO_APLICATIVO: ReadonlyMap<string, Buffer> = new Map([
  ['/icones/app-192.png', ICONE_DO_APLICATIVO_192_PNG],
  ['/icones/app-512.png', ICONE_DO_APLICATIVO_512_PNG],
  ['/icones/app-512-recortavel.png', ICONE_RECORTAVEL_DO_APLICATIVO_512_PNG],
]);

/** Todo caminho do aplicativo, para as listas de rota pública, de cota e de registro de acesso. */
export const ROTAS_DO_APLICATIVO: readonly string[] = [
  ROTA_MANIFESTO,
  ROTA_SERVICE_WORKER,
  ...ICONES_DO_APLICATIVO.keys(),
];

/** A cor da barra e da tela de abertura: o azul-marinho da lateral (o mesmo `theme-color` da página). */
const COR_DO_APLICATIVO = '#0b192c';

export const MANIFESTO: string = JSON.stringify({
  id: '/',
  name: 'Processo Vivo',
  short_name: 'Processo Vivo',
  description: 'Acompanhamento de processos judiciais.',
  lang: 'pt-BR',
  dir: 'ltr',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: COR_DO_APLICATIVO,
  theme_color: COR_DO_APLICATIVO,
  icons: [
    { src: '/icones/app-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icones/app-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    {
      src: '/icones/app-512-recortavel.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
});

/**
 * A página "sem internet". Autocontida (o aparelho está sem rede: nada de fonte, imagem ou CSS
 * de fora), nos dois temas, com contraste acima de 4,5:1, e sem nenhum dado.
 */
export const PAGINA_SEM_INTERNET = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${COR_DO_APLICATIVO}">
<title>Sem conexão · Processo Vivo</title>
<style>
:root{color-scheme:light dark;--fundo:#f4f6f9;--papel:#fff;--tinta:#0f172a;--tinta2:#475569;--borda:#d7dde5;--botao:#0b192c;--botao-tinta:#fff}
@media (prefers-color-scheme:dark){:root{--fundo:#0b1220;--papel:#111b2e;--tinta:#e5ecf5;--tinta2:#a9b6c8;--borda:#26344f;--botao:#e5ecf5;--botao-tinta:#0b1220}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--fundo);color:var(--tinta);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:420px;width:100%;background:var(--papel);border:1px solid var(--borda);border-radius:12px;padding:24px;box-sizing:border-box}
h1{font-size:20px;margin:0 0 8px}
p{margin:0 0 20px;color:var(--tinta2)}
button{font:inherit;font-weight:700;background:var(--botao);color:var(--botao-tinta);border:0;border-radius:8px;padding:10px 18px;min-height:44px;cursor:pointer}
button:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
</style>
</head>
<body>
<main>
<h1>Sem conexão com a internet</h1>
<p>O Processo Vivo consulta os processos ao vivo e precisa de internet. Confira a conexão e tente de novo.</p>
<button type="button" id="tentar">Tentar de novo</button>
</main>
<script>document.getElementById('tentar').addEventListener('click',function(){location.reload()});</script>
</body>
</html>`;

/**
 * O service worker. A versão vai no texto para os bytes mudarem a cada deploy (é assim que o
 * navegador decide atualizar o worker), mesmo sem cache nenhum para invalidar.
 */
export function serviceWorker(versao: string): string {
  return `'use strict';
// Processo Vivo ${versao}. Não guarda nada: só troca a página de erro do navegador, sem internet.
var PAGINA_SEM_INTERNET = ${JSON.stringify(PAGINA_SEM_INTERNET)};
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.mode !== 'navigate' || r.method !== 'GET') return;
  var u = new URL(r.url);
  if (u.origin !== self.location.origin || u.pathname !== '/') return;
  e.respondWith(fetch(r).catch(function () {
    return new Response(PAGINA_SEM_INTERNET, {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }));
});
`;
}

/**
 * O registro do worker, no console. Falhar é silencioso de propósito: sem worker o console
 * funciona igual, só não oferece "Instalar". Fora de contexto seguro (HTTP que não é localhost) o
 * navegador nem expõe o recurso.
 */
export const SCRIPT_APLICATIVO = String.raw`
(function(){
  'use strict';
  if(!('serviceWorker' in navigator)||!window.isSecureContext)return;
  window.addEventListener('load',function(){
    try{navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){})}catch(e){}
  });
})();
`;
