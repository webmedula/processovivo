/**
 * O menu lateral em três formas (v0.68.0, decisões do dono). Vive aqui e não em `script.ts` (que não cresce): o
 * console continua pintando o item ativo, a bolha e o cartão da conta; este módulo só decide a FORMA.
 *
 * - **completo** (256 px): como sempre foi. Padrão de 1280 px para cima.
 * - **ícones** (60 px): padrão abaixo de 1280 px. O rótulo de cada item continua no DOM (nome acessível) e aparece
 *   numa dica ao passar o mouse e ao receber foco. Um botão na própria barra expande e recolhe, e a escolha fica
 *   no navegador (`localStorage` com try/catch; se falhar, vale a escolha da sessão e depois o padrão da largura).
 * - **gaveta**: com a Pasta digital aberta (em QUALQUER largura) e de 900 px para baixo. O menu não ocupa espaço;
 *   um ☰ o abre por cima da tela, com fundo escurecido. Fecha com Esc, clique no fundo, botão de fechar e ao
 *   escolher um item; o foco vai para a gaveta e volta ao ☰; Tab não sai dela enquanto aberta.
 *
 * Como sabe que a Pasta abriu: observa `body.com-pasta`, a classe que `scriptPasta.ts` já põe e tira. Nenhum
 * gancho novo na Pasta — e o ☰ dela é inserido aqui, à esquerda de "Fechar a pasta".
 *
 * A dica da barra de ícones é própria e de posição FIXA: a lateral rola por dentro (`overflow-y:auto`) e cortaria
 * a dica única do console (`__pvProvidencia.comDica`), que é absoluta. Mesmo desenho, mesmo comportamento (mouse e
 * foco, Esc fecha sem fechar mais nada).
 *
 * Nada aqui fala com o servidor, e nada pessoal vai ao `localStorage`: só `icones` ou `completo`.
 */
export const SCRIPT_MENU = String.raw`
(function(){
var CHAVE='processovivo.menu';
var LIMITE_ICONES=1280;
var LIMITE_GAVETA=900;
var raiz=document.documentElement;
function $(id){return document.getElementById(id)}
var lat=$('lateral');
if(!lat)return;
var ICONE_MENU='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>';
var ICONE_RECOLHER='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>';
var ICONE_X='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>';

var memoria='';
var aberto=false;
var gatilho=null;

function pref(){
  try{var v=localStorage.getItem(CHAVE);if(v==='icones'||v==='completo')return v}catch(e){}
  return memoria;
}
function naPasta(){return document.body.classList.contains('com-pasta')}
function modo(){
  if(naPasta()||window.innerWidth<=LIMITE_GAVETA)return 'gaveta';
  return pref()||(window.innerWidth<LIMITE_ICONES?'icones':'completo');
}

/* ---------- as peças que este módulo acrescenta à página ---------- */
function botaoMenu(id,classe){
  return '<button type="button" class="'+classe+' menu-hamb" id="'+id+'" aria-label="Menu" aria-expanded="false" '+
    'aria-controls="lateral">'+ICONE_MENU+'<span class="menu-ponto" hidden></span></button>';
}
var alt=document.createElement('button');
alt.type='button';alt.id='menu-alternar';alt.className='menu-alt';alt.innerHTML=ICONE_RECOLHER;
alt.setAttribute('aria-controls','lateral');
lat.insertBefore(alt,lat.children[1]||null);
var xis=document.createElement('button');
xis.type='button';xis.id='menu-fechar';xis.className='menu-x';xis.innerHTML=ICONE_X;
xis.setAttribute('aria-label','Fechar menu');
lat.insertBefore(xis,lat.firstChild);
var fundo=document.createElement('div');
fundo.id='menu-fundo';
document.body.appendChild(fundo);
var dica=document.createElement('div');
dica.id='menu-dica';dica.setAttribute('role','tooltip');dica.hidden=true;
document.body.appendChild(dica);
/* A barra de cima do celular: só o ☰ e o logo. O logo é uma cópia do da lateral (sem ids, pode repetir). */
var topo=document.createElement('header');
topo.id='menu-topo';topo.className='menu-topo';topo.hidden=true;
topo.innerHTML=botaoMenu('menu-abrir','')+'<span class="menu-topo-marca" aria-hidden="true"></span>';
var app=lat.parentNode;
app.insertBefore(topo,lat);
var logo=lat.querySelector('.marca .logo-svg');
if(logo){var copia=logo.cloneNode(true);copia.removeAttribute('role');copia.removeAttribute('aria-label');
  topo.querySelector('.menu-topo-marca').appendChild(copia)}

function botoesMenu(){return document.querySelectorAll('.menu-hamb')}

/* ---------- a bolha de novidades também no ☰ ---------- */
function espelharBolha(){
  var b=$('bolha'), tem=!!b&&!b.classList.contains('oculto')&&!!b.textContent;
  Array.prototype.forEach.call(botoesMenu(),function(h){
    var p=h.querySelector('.menu-ponto');
    p.textContent=tem?b.textContent:'';p.hidden=!tem;
    h.setAttribute('title',tem?'Menu · '+b.textContent+' atualizações não lidas':'Menu');
  });
}

/* ---------- a forma do menu ---------- */
function aplicar(){
  var m=modo();
  raiz.classList.toggle('menu-gaveta',m==='gaveta');
  raiz.classList.toggle('menu-icones',m==='icones');
  if(m!=='gaveta'&&aberto)fechar(false);
  if(m!=='icones')esconderDica();
  if(m==='gaveta'){lat.setAttribute('role','dialog');lat.setAttribute('aria-modal','true');lat.setAttribute('aria-label','Menu')}
  else{lat.setAttribute('role','complementary');lat.removeAttribute('aria-modal');lat.removeAttribute('aria-label')}
  alt.setAttribute('aria-expanded',m==='icones'?'false':'true');
  alt.setAttribute('aria-label',m==='icones'?'Expandir menu':'Recolher menu');
  topo.hidden=!(m==='gaveta'&&!naPasta()&&!lat.classList.contains('oculto'));
  /* O ☰ da Pasta: à esquerda de "Fechar a pasta", que continua igual. */
  var f=$('pasta-fechar');
  if(f&&!$('pasta-menu')){
    f.insertAdjacentHTML('beforebegin',botaoMenu('pasta-menu','bt bt2'));
    $('pasta-menu').addEventListener('click',function(){alternarGaveta(this)});
  }
  espelharBolha();
}

/* ---------- a gaveta ---------- */
function focaveis(){
  return Array.prototype.filter.call(lat.querySelectorAll('button,a[href]'),function(el){
    return !el.disabled&&el.getClientRects().length>0;
  });
}
function abrir(quem){
  if(aberto||!raiz.classList.contains('menu-gaveta'))return;
  aberto=true;gatilho=quem||null;
  raiz.classList.add('menu-aberto');
  Array.prototype.forEach.call(botoesMenu(),function(h){h.setAttribute('aria-expanded','true')});
  xis.focus();
}
function fechar(devolver){
  if(!aberto)return;
  aberto=false;
  raiz.classList.remove('menu-aberto');
  Array.prototype.forEach.call(botoesMenu(),function(h){h.setAttribute('aria-expanded','false')});
  var g=gatilho;gatilho=null;
  if(devolver&&g&&document.body.contains(g)){try{g.focus()}catch(e){}}
}
function alternarGaveta(quem){if(aberto)fechar(true);else abrir(quem)}

$('menu-abrir').addEventListener('click',function(){alternarGaveta(this)});
xis.addEventListener('click',function(){fechar(true)});
fundo.addEventListener('click',function(){fechar(true)});
/* Escolher um item fecha a gaveta; a navegação (e a saída da Pasta) é a do console, que já ouviu o clique. */
lat.addEventListener('click',function(ev){
  if(!aberto)return;
  var b=ev.target.closest?ev.target.closest('.nav button,#sair,.versao a'):null;
  if(b)fechar(false);
});
/* Na captura: o Esc que fecha a gaveta não chega a quem está por baixo (a Pasta, um painel). */
document.addEventListener('keydown',function(ev){
  if(ev.key==='Escape'&&!dica.hidden){esconderDica();if(!aberto)return}
  if(!aberto)return;
  if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();fechar(true);return}
  if(ev.key!=='Tab')return;
  var fs=focaveis(); if(!fs.length)return;
  var primeiro=fs[0], ultimo=fs[fs.length-1], a=document.activeElement;
  if(!lat.contains(a)){ev.preventDefault();primeiro.focus();return}
  if(ev.shiftKey&&a===primeiro){ev.preventDefault();ultimo.focus()}
  else if(!ev.shiftKey&&a===ultimo){ev.preventDefault();primeiro.focus()}
},true);

/* ---------- expandir e recolher (fora da Pasta, acima de 900 px) ---------- */
alt.addEventListener('click',function(){
  memoria=raiz.classList.contains('menu-icones')?'completo':'icones';
  try{localStorage.setItem(CHAVE,memoria)}catch(e){}
  aplicar();
  alt.focus();
});

/* ---------- a dica da barra de ícones ---------- */
function textoDaDica(el){
  if(el===alt)return alt.getAttribute('aria-label');
  if(el.id==='sair')return 'Sair';
  if(el.classList.contains('av')){
    var n=$('usuario-nome'), p=$('usuario-plano');
    return [n&&n.textContent,p&&p.textContent].filter(function(x){return x}).join(' · ');
  }
  if(el.tagName==='A'){var v=el.parentNode;return v?v.textContent.replace(/\s+/g,' ').trim():''}
  var rot=el.querySelector('span:not(.bolha):not(.cont)');
  var t=rot?rot.textContent:'';
  var c=el.querySelector('.cont'), b=el.querySelector('.bolha');
  if(c&&c.textContent)t+=' · '+c.textContent;
  if(b&&!b.classList.contains('oculto')&&b.textContent)t+=' · '+b.textContent+' não lidas';
  return t;
}
var alvoDaDica=null;
function esconderDica(){
  if(alvoDaDica&&alvoDaDica.getAttribute('aria-describedby')==='menu-dica')alvoDaDica.removeAttribute('aria-describedby');
  alvoDaDica=null;dica.hidden=true;
}
function mostrarDica(el){
  if(!raiz.classList.contains('menu-icones'))return;
  var t=textoDaDica(el); if(!t)return;
  esconderDica();
  alvoDaDica=el;dica.textContent=t;dica.hidden=false;
  if(el.tagName==='BUTTON'||el.tagName==='A')el.setAttribute('aria-describedby','menu-dica');
  var r=el.getBoundingClientRect(), h=dica.offsetHeight;
  dica.style.left=Math.round(r.right+10)+'px';
  dica.style.top=Math.round(Math.max(4,Math.min(window.innerHeight-h-4,r.top+r.height/2-h/2)))+'px';
}
function alvoDe(no){return no&&no.closest?no.closest('.lateral button,.lateral .versao a,.lateral .av'):null}
lat.addEventListener('mouseover',function(ev){var a=alvoDe(ev.target);if(a&&a!==alvoDaDica)mostrarDica(a)});
lat.addEventListener('mouseout',function(ev){
  var a=alvoDe(ev.target);
  if(a&&a===alvoDaDica&&!a.contains(ev.relatedTarget)&&document.activeElement!==a)esconderDica();
});
lat.addEventListener('focusin',function(ev){var a=alvoDe(ev.target);if(a)mostrarDica(a)});
lat.addEventListener('focusout',function(){esconderDica()});
lat.addEventListener('scroll',esconderDica);

/* ---------- quando reavaliar ---------- */
var espera=0;
window.addEventListener('resize',function(){
  if(espera)clearTimeout(espera);
  espera=setTimeout(function(){espera=0;aplicar()},80);
});
if(window.MutationObserver){
  new MutationObserver(aplicar).observe(document.body,{attributes:true,attributeFilter:['class']});
  new MutationObserver(aplicar).observe(lat,{attributes:true,attributeFilter:['class']});
  var bolha=$('bolha');
  if(bolha)new MutationObserver(espelharBolha).observe(bolha,
    {attributes:true,attributeFilter:['class'],childList:true,characterData:true,subtree:true});
}
aplicar();

window.__pvMenu={modo:modo,abrir:abrir,fechar:fechar,aplicar:aplicar};
})();
`;

export const ESTILOS_MENU = `
/* ---------- menu lateral: completo, ícones e gaveta (v0.68.0) ---------- */
.menu-alt,.menu-x{background:transparent;border:0;color:var(--lateral-tinta);width:32px;height:32px;
  border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex:none}
.menu-alt:hover,.menu-x:hover{background:rgba(255,255,255,.08);color:#fff}
.lateral .menu-alt,.lateral .menu-x{position:absolute;top:22px;right:10px}
.lateral .menu-x{display:none}
.lateral button:focus-visible,.lateral a:focus-visible,.menu-hamb:focus-visible{outline:2px solid var(--verde);
  outline-offset:2px}
/* O texto apagado da lateral media 4,2:1 no tema escuro (axe): versão e contagem usam o tom legível. */
.lateral .versao,.lateral .cont{color:var(--lateral-tinta)}
button.menu-hamb{position:relative;display:inline-flex;align-items:center;justify-content:center;
  width:36px;min-width:36px;padding:0;cursor:pointer}
button.menu-hamb svg{flex:none}
.menu-ponto{position:absolute;top:-5px;right:-7px;background:var(--verde);color:#062414;font-size:10px;
  font-weight:800;line-height:1;min-width:16px;height:16px;border-radius:8px;padding:0 4px;
  display:inline-flex;align-items:center;justify-content:center;pointer-events:none}
.menu-ponto[hidden]{display:none}
.menu-topo{display:none}
#menu-fundo{position:fixed;inset:0;z-index:69;background:rgba(6,14,26,.55);opacity:0;visibility:hidden;
  transition:opacity .18s ease,visibility 0s linear .18s}
#menu-dica{position:fixed;z-index:80;max-width:240px;padding:6px 10px;border-radius:8px;background:var(--tinta);
  color:var(--papel);font-size:12.5px;font-weight:600;line-height:1.3;pointer-events:none;
  box-shadow:0 6px 18px rgba(11,25,44,.25)}
#menu-dica[hidden]{display:none}

/* ---------- só ícones (60 px) ---------- */
html.menu-icones .lateral{width:60px;padding:14px 8px 12px;gap:12px;align-items:center}
html.menu-icones .marca{padding:0;width:44px;overflow:hidden;flex:none}
/* O logo é um desenho só: mostrar os 38% da esquerda é mostrar o ícone (a folha com o visto). */
html.menu-icones .marca .logo-svg{width:116px;max-width:none}
html.menu-icones .marca .sub{display:none}
html.menu-icones .lateral .menu-alt{position:static}
html.menu-icones .nav{width:100%}
html.menu-icones .nav button{position:relative;justify-content:center;padding:0;gap:0}
html.menu-icones .nav button>span:not(.bolha):not(.cont),html.menu-icones .lateral-pe button.tema span{
  position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
html.menu-icones .cont{display:none}
html.menu-icones .bolha{position:absolute;top:1px;right:-2px;min-width:18px;height:16px;border-radius:8px;
  font-size:10px;padding:0 4px;margin:0;line-height:1}
html.menu-icones .lateral-pe{align-items:center;width:100%;gap:6px}
html.menu-icones .lateral-pe button.tema{width:40px;height:40px;padding:0;justify-content:center;
  align-self:center;gap:0}
html.menu-icones .usuario{flex-direction:column;border:0;padding:0;gap:6px}
html.menu-icones .usuario .quem{display:none}
html.menu-icones .versao{font-size:0;padding:0;text-align:center}
html.menu-icones .versao a{font-size:10px;line-height:1.2;display:block}

/* ---------- gaveta: na Pasta digital e de 900 px para baixo ---------- */
html.menu-gaveta .app{grid-template-columns:minmax(0,1fr)}
html.menu-gaveta .lateral{position:fixed;top:0;left:0;bottom:0;height:100vh;height:100dvh;
  width:min(288px,86vw);z-index:70;transform:translateX(-102%);visibility:hidden;
  box-shadow:8px 0 28px rgba(6,14,26,.35);transition:transform .18s ease,visibility 0s linear .18s}
html.menu-gaveta.menu-aberto .lateral{transform:none;visibility:visible;transition:transform .18s ease}
html.menu-gaveta.menu-aberto #menu-fundo{opacity:1;visibility:visible;transition:opacity .18s ease}
html.menu-gaveta .lateral .menu-alt{display:none}
html.menu-gaveta .lateral .menu-x{display:flex}
html.menu-gaveta .menu-topo{display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:20;
  background:var(--lateral);border-bottom:1px solid var(--lateral-linha);padding:8px 12px;color:#fff}
html.menu-gaveta .menu-topo[hidden]{display:none}
.menu-topo .menu-hamb{background:transparent;border:0;color:#fff;height:40px;width:40px;border-radius:8px}
.menu-topo .menu-hamb:hover{background:rgba(255,255,255,.08)}
.menu-topo .menu-ponto{top:1px;right:-3px}
.menu-topo-marca .logo-svg{width:118px;height:auto;display:block}
/* A Pasta ocupa a largura toda: o menu não está no layout enquanto ela está aberta. */
#pasta .topo .menu-hamb{min-height:32px}
@media (prefers-reduced-motion:reduce){
  html.menu-gaveta .lateral,html.menu-gaveta.menu-aberto .lateral,#menu-fundo,
  html.menu-gaveta.menu-aberto #menu-fundo{transition:none}
}
`;
