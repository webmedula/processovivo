/**
 * Avaliação por POLEGAR das três funções de IA (v0.56.0): resumo do processo, análise do ato e análise de peça.
 * Um módulo só, no fim de cada resultado, no lugar dos botões "Útil / Errado / Perigoso" e do "Reportar problema"
 * que cada tela tinha. `script.ts` não cresce (há teste que fixa o tamanho).
 *
 * O que sustenta a tela (CLAUDE.md §8, "Avaliação por polegar"):
 * - dois ícones discretos, com nome acessível próprio ("Resultado útil", "Resultado com problema"), foco visível
 *   e teclado (são `<button>` de verdade). Polegar para cima grava "util"; para baixo grava "errado" e abre, SEM
 *   sair da tela, a lista FECHADA de motivos, opcional: erro de fato, citação inventada, concluiu prazo, deixou
 *   de fora algo importante, pode causar prejuízo se seguido (o que antes era "perigoso": o servidor grava
 *   "perigoso" quando é este o motivo) e outro. Clicar de novo no motivo marcado o tira. Nenhum texto livre;
 * - o estado do voto vive na página (por tipo + id do resultado) e sobrevive ao redesenho da tela que o contém;
 * - o aviso "Obrigado pelo retorno." sai numa região `aria-live` única no <body>, que nunca é trocada;
 * - o módulo faz a própria chamada (`POST …/avaliacao`) e se redesenha no lugar: as três telas só pedem o HTML
 *   (`html(tipo, id, avaliacaoDoServidor)`) e não conhecem a rota.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc;
 * `tests/http/console-script.spec.ts` roda o ESLint aqui dentro.
 */
export const SCRIPT_POLEGARES = String.raw`
(function(){
var pv=function(){return window.__pv};
function esc(s){return pv().esc(s)}
var ROTAS={resumo:'/v1/resumos/',ato:'/v1/analises/',peca:'/v1/analises-de-peca/',processo:'/v1/sinteses-do-processo/'};
var MOTIVOS=[['erro_de_fato','Erro de fato'],['citacao_inventada','Citação inventada'],['concluiu_prazo','Concluiu prazo'],
  ['deixou_de_fora','Deixou de fora algo importante'],['pode_causar_prejuizo','Pode causar prejuízo se seguido'],['outro','Outro']];
var OBRIGADO='Obrigado pelo retorno.';
var ERRO='Não foi possível registrar. Tente de novo.';
var ICONE_CIMA='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';
var ICONE_BAIXO='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';

/* Estado por resultado: {voto:'cima'|'baixo'|'', motivo:'', ocupado:false, erro:''}. */
var ESTADO={};
function chave(tipo,id){return String(tipo)+'-'+String(id).replace(/[^A-Za-z0-9_-]/g,'_')}
function estadoDe(tipo,id,doServidor){
  var k=chave(tipo,id);
  if(!ESTADO[k]){
    var voto='',motivo='';
    if(doServidor==='util')voto='cima';
    else if(doServidor==='errado')voto='baixo';
    else if(doServidor==='perigoso'){voto='baixo';motivo='pode_causar_prejuizo'}
    ESTADO[k]={voto:voto,motivo:motivo,ocupado:false,erro:''};
  }
  return ESTADO[k];
}

function anunciar(t){
  var el=document.getElementById('pvpol-live');
  if(!el){
    el=document.createElement('div');
    el.id='pvpol-live';el.className='pvpol-live';
    el.setAttribute('aria-live','polite');el.setAttribute('role','status');
    document.body.appendChild(el);
  }
  el.textContent='';
  setTimeout(function(){el.textContent=t||''},30);
}

/* O bloco inteiro, para ficar no fim do resultado. */
function html(tipo,id,doServidor){
  var s=estadoDe(tipo,id,doServidor),k=chave(tipo,id);
  var h='<div class="pvpol" id="pvpol-'+k+'" data-pvpol-raiz="1" data-pvpol-tipo="'+esc(tipo)+'" data-pvpol-id="'+esc(id)+'">'+
    '<div class="pvpol-linha">'+
    '<button type="button" class="pvpol-b" id="pvpol-'+k+'-cima" data-pvpol="cima" aria-label="Resultado útil" aria-pressed="'+(s.voto==='cima'?'true':'false')+'">'+ICONE_CIMA+'</button>'+
    '<button type="button" class="pvpol-b" id="pvpol-'+k+'-baixo" data-pvpol="baixo" aria-label="Resultado com problema" aria-pressed="'+(s.voto==='baixo'?'true':'false')+'">'+ICONE_BAIXO+'</button>'+
    '<span class="pvpol-ok">'+(s.erro?esc(s.erro):(s.voto?OBRIGADO:''))+'</span></div>';
  if(s.voto==='baixo'){
    h+='<div class="pvpol-motivos" role="group" aria-label="Qual foi o problema? (opcional)"><span class="pvpol-rot">Qual foi o problema? (opcional)</span>'+
      MOTIVOS.map(function(m){
        var on=s.motivo===m[0];
        return '<button type="button" class="pvpol-m'+(on?' on':'')+'" id="pvpol-'+k+'-m-'+m[0]+'" data-pvpol="motivo" data-motivo="'+m[0]+'" aria-pressed="'+(on?'true':'false')+'">'+m[1]+'</button>';
      }).join('')+'</div>';
  }
  return h+'</div>';
}

function cabecalhos(){
  var h={'content-type':'application/json'},c=pv().chave();
  if(c)h['x-api-key']=c;
  return h;
}

function redesenhar(raiz,tipo,id,foco){
  var novo=document.createElement('div');
  novo.innerHTML=html(tipo,id);
  var el=novo.firstChild;
  if(raiz.parentNode)raiz.parentNode.replaceChild(el,raiz);
  var alvo=foco?document.getElementById(foco):null;
  if(alvo)alvo.focus();
}

function enviar(raiz,corpo,quando,foco){
  var tipo=raiz.getAttribute('data-pvpol-tipo'),id=raiz.getAttribute('data-pvpol-id');
  var s=estadoDe(tipo,id),rota=ROTAS[tipo];
  if(!rota||s.ocupado)return;
  s.ocupado=true;s.erro='';
  fetch(rota+encodeURIComponent(id)+'/avaliacao',{method:'POST',headers:cabecalhos(),body:JSON.stringify(corpo)})
    .then(function(r){
      s.ocupado=false;
      if(r.ok){quando(s);anunciar(OBRIGADO)}
      else{s.erro=ERRO;anunciar(ERRO)}
      redesenhar(document.getElementById('pvpol-'+chave(tipo,id))||raiz,tipo,id,foco);
    },function(){
      s.ocupado=false;s.erro=ERRO;anunciar(ERRO);
      redesenhar(document.getElementById('pvpol-'+chave(tipo,id))||raiz,tipo,id,foco);
    });
}

document.addEventListener('click',function(ev){
  var el=ev.target&&ev.target.closest?ev.target.closest('[data-pvpol]'):null;
  if(!el)return;
  var raiz=el.closest('[data-pvpol-raiz]');
  if(!raiz)return;
  var tipo=raiz.getAttribute('data-pvpol-tipo'),id=raiz.getAttribute('data-pvpol-id');
  var k=chave(tipo,id),s=estadoDe(tipo,id),acao=el.getAttribute('data-pvpol');
  if(acao==='cima'){
    if(s.voto==='cima')return;
    enviar(raiz,{avaliacao:'util'},function(e){e.voto='cima';e.motivo=''},'pvpol-'+k+'-cima');
    return;
  }
  if(acao==='baixo'){
    if(s.voto==='baixo')return;
    enviar(raiz,{avaliacao:'errado'},function(e){e.voto='baixo';e.motivo=''},'pvpol-'+k+'-baixo');
    return;
  }
  if(acao==='motivo'){
    if(s.voto!=='baixo')return;
    var m=el.getAttribute('data-motivo'),novo=s.motivo===m?'':m;
    var corpo={avaliacao:'errado'};
    if(novo)corpo.motivo=novo;
    enviar(raiz,corpo,function(e){e.motivo=novo},'pvpol-'+k+'-m-'+m);
  }
});

window.__pvPolegares={html:html};
})();
`;

export const ESTILOS_POLEGARES = `
.pvpol{margin:12px 0 2px;min-width:0}
.pvpol-linha{display:flex;align-items:center;gap:6px}
.pvpol-b{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;cursor:pointer;
  color:var(--tinta2);background:transparent;border:1px solid var(--linha);border-radius:var(--r)}
.pvpol-b:hover{color:var(--tinta);background:var(--papel)}
.pvpol-b[aria-pressed="true"]{color:var(--acento);background:var(--acento-bg);border-color:var(--acento)}
.pvpol-b:focus-visible,.pvpol-m:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.pvpol-ok{font-size:12.5px;color:var(--tinta2)}
.pvpol-motivos{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:8px}
.pvpol-rot{flex:0 0 100%;font-size:12.5px;color:var(--tinta2)}
.pvpol-m{padding:3px 10px;font:inherit;font-size:12.5px;cursor:pointer;color:var(--tinta);background:var(--papel);
  border:1px solid var(--linha);border-radius:999px}
.pvpol-m:hover{border-color:var(--acento)}
.pvpol-m.on{color:var(--acento);background:var(--acento-bg);border-color:var(--acento)}
.pvpol-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (max-width:1023px){.pvpol-b{width:44px;height:44px}.pvpol-m{min-height:36px}}
`;
