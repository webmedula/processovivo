import { ESTILOS } from './estilos.js';
import { FAVICON_DATA_URI, LOGO_FUNDO_ESCURO } from './marca.js';
import { ESTILOS_PASTA } from './estilosPasta.js';
import { SCRIPT } from './script.js';
import { SCRIPT_PASTA } from './scriptPasta.js';
import { SCRIPT_PASTA_CALIBRACAO } from './scriptPastaCalibracao.js';
import { ESTILOS_CALENDARIO, SCRIPT_CALENDARIO } from './calendario.js';
import { ESTILOS_ATUALIZACOES, SCRIPT_ATUALIZACOES } from './atualizacoes.js';

/**
 * Ícones da navegação: traço, sem preenchimento, na cor do texto
 * (`currentColor`), para herdarem o estado ativo sem CSS a mais. Inline pelo
 * mesmo motivo do resto da página — nada vem de fora.
 */
function icone(caminhos: string): string {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${caminhos}</svg>`
  );
}

/**
 * Aplica o tema escolhido ANTES de o corpo ser pintado. No fim do <body>
 * (onde fica o resto do script) seria tarde: a página abriria no tema do
 * sistema e piscaria para o escolhido. Inline, não arquivo: nada vem de fora.
 */
export const SCRIPT_TEMA =
  "try{var t=localStorage.getItem('processovivo.tema');" +
  "if(t==='claro'||t==='escuro')document.documentElement.setAttribute('data-tema',t)}catch(e){}";

export const ICONES = {
  sino: icone('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  pasta: icone(
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  ),
  calendario: icone(
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  ),
  lupa: icone('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  olho: icone('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  chave: icone('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>'),
  pessoa: icone('<circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/>'),
  tema: icone('<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  sair: icone('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
} as const;

/**
 * Console web do Processo Vivo — servido pela própria API, na raiz.
 *
 * Sendo da MESMA ORIGEM da API, o `fetch` daqui manda `x-api-key` sozinho: sem
 * CORS, sem PowerShell, sem curl. Foi o que resolveu o problema de "abro a URL
 * e recebo NAO_AUTENTICADO" — navegador não manda header customizado, e do lado
 * de quem usa isso é indistinguível de "o sistema não funciona".
 *
 * Sem build, sem framework, sem recurso externo: três strings que o servidor
 * concatena. Nada para compilar e nada que quebre em deploy.
 *
 * ESCOPO: a chave de API identifica o assinante enquanto não existem contas de
 * usuário — cada chave é um espaço isolado, com seus próprios processos
 * acompanhados. Quando houver cadastro e login, a coluna `workspace` do banco
 * passa a apontar para o usuário e nada mais muda.
 */
export function paginaConsole(versao: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Processo Vivo</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
<meta name="theme-color" content="#0b192c">
<script>${SCRIPT_TEMA}</script>
<style>${ESTILOS}${ESTILOS_PASTA}${ESTILOS_CALENDARIO}${ESTILOS_ATUALIZACOES}</style>
</head>
<body>

<div class="app">
  <!--
    A lateral é o elemento escondido quando não há sessão, e o conteúdo fica
    FORA dela de propósito: a tela de entrada usa o mesmo #conteudo. Se os dois
    estivessem no mesmo bloco, esconder a navegação esconderia o login junto.
    A grade some para uma coluna sozinha quando a lateral não está lá.
  -->
  <aside class="lateral oculto" id="lateral">
    <div class="marca" id="marca">${LOGO_FUNDO_ESCURO}</div>
    <nav class="nav">
      <button id="nav-novidades">${ICONES.sino}<span>Atualizações</span> <span class="bolha oculto" id="bolha"></span></button>
      <button id="nav-processos">${ICONES.pasta}<span>Meus processos</span> <span class="cont" id="cont-processos"></span></button>
      <button id="nav-calendario">${ICONES.calendario}<span>Calendário</span></button>
      <button id="nav-buscar">${ICONES.lupa}<span>Buscar</span></button>
      <button id="nav-vigilancia">${ICONES.olho}<span>Vigilância</span></button>
      <button id="nav-credenciais">${ICONES.chave}<span>Meus acessos</span></button>
      <button id="nav-conta" class="oculto">${ICONES.pessoa}<span>Minha conta</span></button>
    </nav>
    <div class="lateral-pe">
      <button id="tema" class="tema" type="button">${ICONES.tema}<span>Tema: automático</span></button>
      <div class="usuario">
        <span class="av" id="usuario-iniciais"></span>
        <span class="quem"><span class="nome" id="usuario-nome"></span><span class="plano" id="usuario-plano"></span></span>
        <button id="sair" title="Encerrar a sessão" aria-label="Sair">${ICONES.sair}</button>
      </div>
      <div class="versao">v${versao} &middot; <a href="/ready">estado das fontes</a></div>
    </div>
  </aside>

  <main class="env" id="conteudo"></main>
</div>

<script>${SCRIPT}</script>
<script>${SCRIPT_PASTA_CALIBRACAO}</script>
<script>${SCRIPT_PASTA}</script>
<script>${SCRIPT_CALENDARIO}</script>
<script>${SCRIPT_ATUALIZACOES}</script>
</body>
</html>`;
}
