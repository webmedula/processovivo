/**
 * O cartão "Partes" da tela do processo (v0.73.0).
 *
 * Antes, as partes vinham só do retrato das fontes públicas. O DataJud não indexa partes, então
 * quem as dava era o DJEN — e o DJEN só conhece os DESTINATÁRIOS das intimações. Num cumprimento
 * de sentença com uma publicação, a tela mostrava só quem foi intimado (o exequente, que também
 * advoga) e o executado sumia, como se a lista fosse aquela.
 *
 * Agora há duas origens, e a tela diz qual está mostrando:
 *  - **os autos**: quando a consulta ao tribunal (a mesma que traz as peças, sem chamada a mais)
 *    devolve o cabeçalho com as partes, elas substituem as do Diário — é a lista do processo;
 *  - **o Diário**: sem o tribunal, as do retrato, com a frase de que podem não ser todas.
 *
 * Vive aqui e não em `script.ts` (que não cresce): o console chama `cartao(p)` no lugar do bloco
 * antigo e `pintar(numero, partes)` quando a resposta do tribunal chega. Toda frase é fixa; do
 * servidor só chegam nome, polo e advogados (nunca CPF/CNPJ nem endereço).
 */
export const SCRIPT_PARTES = String.raw`
(function(){
var pv=function(){return window.__pv};
/* Partes dos autos do processo aberto, guardadas na página (a régua também fica): o redesenho da
   tela volta por cartao() e não pode cair de novo na lista do Diário. */
var doTribunal={numero:'',partes:[]};

function dig(s){return String(s||'').replace(/\D/g,'')}

function linhas(lista){
  var esc=pv().esc, h='';
  lista.forEach(function(pt){
    h+='<div class="parte"><span class="selo">'+esc(pt.polo)+'</span> <strong>'+esc(pt.nome)+'</strong>';
    if(pt.advogados&&pt.advogados.length)
      h+='<div class="nota">'+pt.advogados.map(function(a){
        return esc(a.nome)+(a.oab?' — OAB '+esc(a.oab)+(a.ufOab?'/'+esc(a.ufOab):''):'')}).join(' · ')+'</div>';
    h+='</div>'});
  return h;
}

function miolo(p){
  var trib=(doTribunal.partes.length&&dig(doTribunal.numero)===dig(p&&p.numero))?doTribunal.partes:null;
  var h='<h3 class="sec">Partes</h3>';
  if(trib)return h+'<div class="partes-origem">Conforme os autos no tribunal.</div>'+linhas(trib);
  var lista=(p&&p.partes)||[];
  if(lista.length)return h+'<div class="partes-origem">Pelas publicações do Diário: aparecem só as '+
    'partes intimadas, e a lista pode estar incompleta. Com o acesso ao tribunal cadastrado, as '+
    'partes vêm dos autos.</div>'+linhas(lista);
  return h+'<div style="color:var(--tinta2)">Nenhuma parte informada. O DataJud publica só '+
    'metadados, e o DJEN só conhece quem foi intimado em alguma publicação — um '+
    'processo sem publicação recente no diário aparece sem partes.</div>';
}

function cartao(p){
  return '<div class="cartao" id="partes-cartao" data-numero="'+pv().esc(dig(p&&p.numero))+'">'+miolo(p)+'</div>';
}

/* A resposta do tribunal chegou. Lista vazia não apaga nada: o tribunal não trouxe o cabeçalho. */
function pintar(numero,partes){
  if(!partes||!partes.length)return;
  doTribunal={numero:numero,partes:partes};
  var el=document.getElementById('partes-cartao');
  if(el&&el.getAttribute('data-numero')===dig(numero))el.innerHTML=miolo({numero:numero,partes:[]});
}

window.__pvPartes={cartao:cartao,pintar:pintar};
})();
`;

export const ESTILOS_PARTES = `
.partes-origem{font-size:13px;color:var(--tinta2);margin:-2px 0 6px}
`;
