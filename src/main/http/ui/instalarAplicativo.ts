/**
 * "Instalar aplicativo" (v0.70.1, decisão do dono: o convite do navegador quase não se via). Vive aqui e não em
 * `script.ts` (que não cresce). Duas peças, as duas só existem com a sessão aberta e só enquanto o sistema NÃO
 * está instalado:
 *
 * - **No menu lateral**, um item fixo no pé, ao lado do "Tema", com o mesmo desenho (então herda as três formas do
 *   menu: por extenso, só o ícone com dica, e dentro da gaveta).
 * - **No celular** (até 900 px), um aviso discreto preso embaixo, que some ao fechar ("Agora não") e não volta
 *   neste navegador. Não toma o foco, não aparece com a Pasta digital aberta e não cobre o conteúdo (a página
 *   ganha espaço embaixo enquanto ele está lá).
 *
 * O que o clique faz depende do navegador, porque cada um instala de um jeito:
 * - **Chrome, Edge, Samsung Internet** (Android e computador): o navegador avisa que dá para instalar
 *   (`beforeinstallprompt`); guardamos o aviso e o clique abre a janela de instalação DELE. Sem esse aviso, o item
 *   não aparece: oferecer um botão que não faz nada é pior que nenhum.
 * - **iPhone e iPad**: não existe janela de instalação. O clique abre um passo a passo curto (Compartilhar >
 *   Adicionar à Tela de Início).
 * - **Firefox no computador e outros**: não instalam; nada aparece.
 *
 * Instalado (`display-mode: standalone`, ou `navigator.standalone` no iPhone) ou recém-instalado (`appinstalled`):
 * nada aparece. Nada aqui fala com o servidor. No `localStorage` vai só `dispensado` (o aviso do celular foi
 * fechado), com try/catch: falhou, o aviso só não lembra a escolha depois de recarregar.
 */
export const SCRIPT_INSTALAR = String.raw`
(function(){
'use strict';
var CHAVE='processovivo.instalar';
var LIMITE_CELULAR=900;
function $(id){return document.getElementById(id)}
var lat=$('lateral'), botao=$('instalar-app');
if(!lat||!botao)return;

var ua=navigator.userAgent||'';
var ios=/iPhone|iPad|iPod/i.test(ua)||(/Macintosh/.test(ua)&&(navigator.maxTouchPoints||0)>1);
var pedido=null;
var dispensadoNaSessao=false;

function instalado(){
  var m=false;
  try{m=window.matchMedia('(display-mode: standalone)').matches}catch(e){}
  return m||navigator.standalone===true;
}
function disponivel(){return !instalado()&&(!!pedido||ios)}
function logado(){return !lat.classList.contains('oculto')}
function dispensado(){
  if(dispensadoNaSessao)return true;
  try{return localStorage.getItem(CHAVE)==='dispensado'}catch(e){return false}
}
function dispensar(){
  dispensadoNaSessao=true;
  try{localStorage.setItem(CHAVE,'dispensado')}catch(e){}
}

/* ---------- o aviso do celular ---------- */
var ICONE_X='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>';
var aviso=document.createElement('div');
aviso.id='instalar-aviso';aviso.setAttribute('role','region');aviso.setAttribute('aria-label','Instalar o aplicativo');
aviso.hidden=true;
aviso.innerHTML='<div class="inst-texto"><strong>Use o Processo Vivo como aplicativo</strong>'+
  '<span>Abra direto da tela inicial do celular, sem procurar o site.</span></div>'+
  '<div class="inst-acoes"><button type="button" class="bt" id="instalar-aviso-sim"></button>'+
  '<button type="button" class="inst-x" id="instalar-aviso-nao" aria-label="Agora não">'+ICONE_X+'</button></div>';
document.body.appendChild(aviso);

/* ---------- o passo a passo do iPhone ---------- */
var ICONE_COMPARTILHAR='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
var ICONE_MAIS='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>';
var janela=document.createElement('dialog');
janela.id='instalar-ios';janela.setAttribute('aria-labelledby','instalar-ios-titulo');
janela.innerHTML='<h2 id="instalar-ios-titulo">Instalar no iPhone</h2>'+
  '<ol><li>Toque em <strong>Compartilhar</strong> <span class="inst-ic">'+ICONE_COMPARTILHAR+'</span>, na barra do navegador.</li>'+
  '<li>Role a lista e toque em <strong>Adicionar à Tela de Início</strong> <span class="inst-ic">'+ICONE_MAIS+'</span>.</li>'+
  '<li>Toque em <strong>Adicionar</strong>. O ícone do Processo Vivo aparece na tela inicial.</li></ol>'+
  '<p class="inst-nota">No aplicativo você entra uma vez com seu e-mail e senha (ou com o Google).</p>'+
  '<div class="inst-pe"><button type="button" class="bt" id="instalar-ios-ok">Entendi</button></div>';
document.body.appendChild(janela);
var antesDaJanela=null;
function abrirPassoAPasso(){
  antesDaJanela=document.activeElement;
  if(window.__pvMenu)window.__pvMenu.fechar(false);
  if(typeof janela.showModal==='function'){try{janela.showModal()}catch(e){janela.setAttribute('open','')}}
  else janela.setAttribute('open','');
  var ok=$('instalar-ios-ok');if(ok)ok.focus();
}
function fecharPassoAPasso(){
  if(typeof janela.close==='function'&&janela.open)janela.close();else janela.removeAttribute('open');
}
janela.addEventListener('close',function(){
  var a=antesDaJanela;antesDaJanela=null;
  if(a&&document.body.contains(a)&&a.getClientRects().length){try{a.focus()}catch(e){}}
});
$('instalar-ios-ok').addEventListener('click',fecharPassoAPasso);
/* Clique no fundo escurecido fecha (o dialog recebe o clique quando ele cai fora da caixa). */
janela.addEventListener('click',function(ev){if(ev.target===janela)fecharPassoAPasso()});

/* ---------- instalar ---------- */
function instalar(){
  if(pedido){
    var p=pedido;
    /* A janela do navegador só pode ser aberta uma vez por aviso: depois dela, esperamos um aviso novo. */
    pedido=null;
    try{
      p.prompt();
      if(p.userChoice&&p.userChoice.then)p.userChoice.then(atualizar,atualizar);
    }catch(e){}
    atualizar();
    return;
  }
  if(ios)abrirPassoAPasso();
}
botao.addEventListener('click',instalar);
$('instalar-aviso-sim').addEventListener('click',function(){dispensar();instalar();atualizar()});
$('instalar-aviso-nao').addEventListener('click',function(){dispensar();atualizar()});

/* ---------- o que aparece ---------- */
function atualizar(){
  var pode=disponivel()&&logado();
  botao.classList.toggle('oculto',!pode);
  var sim=$('instalar-aviso-sim');
  if(sim)sim.textContent=pedido?'Instalar':'Como instalar';
  var celular=window.innerWidth<=LIMITE_CELULAR;
  var mostrar=pode&&celular&&!dispensado()&&!document.body.classList.contains('com-pasta');
  if(!mostrar&&aviso.contains(document.activeElement)){try{botao.focus()}catch(e){}}
  aviso.hidden=!mostrar;
  document.body.classList.toggle('com-aviso-instalar',mostrar);
}

window.addEventListener('beforeinstallprompt',function(ev){
  /* Sem o preventDefault o Chrome mostra a barrinha dele por cima do nosso aviso: dois convites para a mesma coisa. */
  ev.preventDefault();
  pedido=ev;
  atualizar();
});
window.addEventListener('appinstalled',function(){pedido=null;atualizar()});
var espera=0;
window.addEventListener('resize',function(){
  if(espera)clearTimeout(espera);
  espera=setTimeout(function(){espera=0;atualizar()},80);
});
if(window.MutationObserver){
  new MutationObserver(atualizar).observe(lat,{attributes:true,attributeFilter:['class']});
  new MutationObserver(atualizar).observe(document.body,{attributes:true,attributeFilter:['class']});
}
try{window.matchMedia('(display-mode: standalone)').addEventListener('change',atualizar)}catch(e){}
atualizar();

window.__pvInstalar={disponivel:disponivel,atualizar:atualizar,instalar:instalar};
})();
`;

export const ESTILOS_INSTALAR = `
/* ---------- instalar aplicativo (v0.70.1) ---------- */
#instalar-aviso{position:fixed;left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:60;
  display:flex;align-items:center;gap:12px;padding:12px 10px 12px 16px;border-radius:14px;
  background:var(--lateral);color:#fff;border:1px solid var(--lateral-linha);
  box-shadow:0 10px 30px rgba(6,14,26,.35);max-width:560px;margin:0 auto}
#instalar-aviso[hidden]{display:none}
#instalar-aviso .inst-texto{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
#instalar-aviso strong{font-size:14.5px;line-height:1.3}
#instalar-aviso .inst-texto span{font-size:13px;line-height:1.35;color:var(--lateral-tinta)}
#instalar-aviso .inst-acoes{display:flex;align-items:center;gap:4px;flex:none}
#instalar-aviso .bt{min-height:44px;white-space:nowrap;background:var(--verde);color:#062414;border-color:var(--verde)}
#instalar-aviso .inst-x{background:transparent;border:0;color:var(--lateral-tinta);width:44px;height:44px;
  border-radius:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
#instalar-aviso .inst-x:hover{background:rgba(255,255,255,.08);color:#fff}
#instalar-aviso button:focus-visible{outline:2px solid #fff;outline-offset:2px}
body.com-aviso-instalar .env{padding-bottom:150px}
#instalar-ios{border:1px solid var(--linha);border-radius:14px;background:var(--papel);color:var(--tinta);
  padding:22px 22px 18px;width:min(420px,calc(100vw - 32px));box-sizing:border-box;
  box-shadow:0 18px 50px rgba(6,14,26,.35)}
#instalar-ios::backdrop{background:rgba(6,14,26,.55)}
#instalar-ios h2{font-size:18px;margin:0 0 12px}
#instalar-ios ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:10px;font-size:14.5px;line-height:1.45}
#instalar-ios .inst-ic{display:inline-flex;vertical-align:-3px;color:var(--tinta2)}
#instalar-ios .inst-nota{font-size:13px;color:var(--tinta2);margin:14px 0 0;line-height:1.4}
#instalar-ios .inst-pe{display:flex;justify-content:flex-end;margin-top:16px}
#instalar-ios .bt{min-height:44px}
`;
