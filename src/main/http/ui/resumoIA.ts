/**
 * "Resumir este processo com IA" na capa da página do processo (v0.40.1): o botão ao
 * lado de "Deixar de acompanhar", o painel logo abaixo da capa e as duas chamadas à API
 * da 0.40.0, num arquivo só. `script.ts` não cresce (há teste que fixa o tamanho): ele
 * chama `window.__pvResumoIA.aposDesenhar(numero, acompanhado)` ao ligar os botões do
 * detalhe e `sair()` quando a tela deixa de ser a de um processo.
 *
 * O que sustenta a tela (CLAUDE.md §8, "Resumo do processo por IA"):
 * - é APOIO À LEITURA: nada aqui altera "pede providência", "não lida", ordem, contagem,
 *   calendário ou a marcação "providência" do sistema, e NADA é criado (nenhum aviso,
 *   nenhum evento). O aviso fixo diz isso;
 * - o botão só existe para processo ACOMPANHADO e só quando a IA está disponível para a
 *   página (a mesma rota de disponibilidade da análise de ato);
 * - o pedido não leva corpo nenhum: o servidor lê os atos do retrato da conta;
 * - as pendências "segundo a IA" ficam em bloco SEPARADO da marcação "providência" do sistema, e a
 *   tela diz quantos atos o sistema marca como pedem providência e a IA não citou;
 * - a tela diz o que ficou de fora: atos fora do resumo e itens descartados na verificação
 *   (só a contagem, nunca o texto descartado);
 * - toda frase de recusa é FIXA aqui — nunca texto do modelo nem do servidor;
 * - NÃO há "reabrir o último resumo": o estado vive na página, só enquanto a pessoa fica
 *   neste processo; sair da tela do processo o apaga;
 * - o rodapé não mostra o modelo (continua gravado em `resumos_ia`);
 * - avaliação sem texto livre: Útil / Errado / Perigoso.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc;
 * `tests/http/console-script.spec.ts` roda o ESLint aqui dentro. Todo texto vindo do
 * servidor passa por `esc()`.
 */
export const SCRIPT_RESUMO_IA = String.raw`
(function(){
var pv=function(){return window.__pv};
function esc(s){return pv().esc(s)}
function digitos(n){return String(n||'').replace(/\D/g,'')}

/* Estado do resumo DESTA página de processo; null = nenhum aberto. */
var S=null;

var ATENCAO={
  conferir_prazo_no_processo:'Conferir o prazo no processo.',
  ato_depende_de_outro_documento:'Um ato parece depender de outro documento.',
  texto_incompleto:'O texto de um ato pode estar incompleto.',
  possivel_outro_destinatario:'Uma comunicação pode ser dirigida a outro destinatário.'
};
var RECUSAS={
  sem_plano:'O resumo por IA faz parte do plano IA. Faça upgrade do plano para usar.',
  segredo_de_justica:'Processo em segredo de justiça: o resumo por IA não é feito. Leia os atos.',
  texto_insuficiente:'Este processo não tem atos com texto suficiente para resumir. Leia os atos.',
  limite_de_uso:'Há muitos resumos em andamento ou o limite por hora foi atingido. Tente novamente em instantes.',
  nao_acompanhado:'Este processo não está entre os que você acompanha.'
};
var ANALISANDO='Resumindo o processo… isso pode levar até 2 minutos.';
var NAO_VERIFICADO='Não foi possível resumir com segurança. Leia os atos.';
var ERRO='Não foi possível resumir agora. Tente de novo em alguns minutos.';
var AVISO_FIXO='Apoio à leitura, não substitui a leitura dos atos nem a contagem de prazo.';
var AVALIACOES=[['util','Útil'],['errado','Errado'],['perigoso','Perigoso']];

function pl(n,um,varios){return n+' '+(n===1?um:varios)}

function cabecalhosSemCorpo(){
  var h={},k=pv().chave();
  if(k)h['x-api-key']=k;
  return h;
}
function cabecalhosJson(){
  var h=cabecalhosSemCorpo();
  h['content-type']='application/json';
  return h;
}

/* A região ao vivo mora no <body> e nunca é trocada: sobrevive ao redesenho da tela do processo
   e ao fechamento do painel, então o "Resumo cancelado." chega ao leitor de tela. */
function anunciar(t){
  var el=document.getElementById('pvres-live');
  if(!el){
    el=document.createElement('div');
    el.id='pvres-live';el.className='pvres-live';
    el.setAttribute('aria-live','polite');el.setAttribute('role','status');
    document.body.appendChild(el);
  }
  el.textContent='';
  setTimeout(function(){el.textContent=t||''},30);
}

/* ---------- desenho ---------- */
function atoDoItem(a){
  var rotulo=a.rotulo||'Ato';
  var t=rotulo+' · '+pv().dt(a.data);
  if(a.tipoDaComunicacao&&String(a.tipoDaComunicacao).toLowerCase()!==rotulo.toLowerCase())t+=' · '+a.tipoDaComunicacao;
  return '<p class="pvres-ato">Ato: <button type="button" class="link" data-pvres="ato" data-quando="'+esc(a.data)+
    '" data-rotulo="'+esc(rotulo)+'" title="Ir a este ato na linha do tempo">'+esc(t)+'</button></p>';
}
function itemHtml(i){
  return '<li><p class="pvres-texto">'+esc(i.texto)+'</p>'+atoDoItem(i.ato)+
    '<blockquote class="pvres-cit"><mark>'+esc(i.trecho)+'</mark></blockquote></li>';
}

function contagensHtml(c){
  var h='<ul class="pvres-contagens">';
  if(c.providenciasDoSistema>0){
    h+=c.providenciasNaoCitadas>0
      ?'<li>O sistema marca '+pl(c.providenciasDoSistema,'ato','atos')+' como pedem providência; '+
        '<strong>'+pl(c.providenciasNaoCitadas,'não foi citado','não foram citados')+'</strong> neste resumo. '+
        'Confira a linha do tempo, onde o sistema marca esses atos.</li>'
      :'<li>O sistema marca '+pl(c.providenciasDoSistema,'ato','atos')+' como pedem providência, e '+
        (c.providenciasDoSistema===1?'ele foi citado':'todos foram citados')+' neste resumo.</li>';
  }else h+='<li>O sistema não marca nenhum ato como pede providência neste momento.</li>';
  h+='<li>O processo tem '+pl(c.atosNoProcesso,'ato','atos')+'. Lidos com texto: '+c.atosComTexto+
    '. Só pelo título: '+c.atosSoTitulo+'. <strong>Ficaram de fora do resumo: '+c.foraDoResumo+'.</strong></li>';
  h+='<li>Itens descartados na verificação: '+c.itensDescartados+' (o texto deles não é mostrado).</li>';
  return h+'</ul>';
}

function resultadoHtml(d){
  var h='';
  h+='<section class="pvres-sec"><h4 class="pvres-rot">Situação do processo</h4><ul class="pvres-itens">'+
    d.situacao.map(itemHtml).join('')+'</ul></section>';
  h+='<section class="pvres-sec pvres-pend"><h4 class="pvres-rot">Pendências segundo a IA</h4>'+
    '<p class="pvres-nota">Leitura automática dos atos. É outra coisa que a marcação “providência” do sistema na linha do tempo, que não muda.</p>';
  if(d.pendencias.length)h+='<ul class="pvres-itens">'+d.pendencias.map(itemHtml).join('')+'</ul>';
  else h+='<p class="pvres-vazio">A IA não indicou pendências nos atos lidos.</p>';
  h+='</section>';
  h+='<section class="pvres-sec"><h4 class="pvres-rot">O que entrou e o que ficou de fora</h4>'+contagensHtml(d.contagens)+'</section>';
  if(d.pontosDeAtencao&&d.pontosDeAtencao.length){
    h+='<section class="pvres-sec"><h4 class="pvres-rot">Pontos de atenção</h4><ul class="pvres-itens-simples">'+
      d.pontosDeAtencao.map(function(p){return '<li>'+esc(ATENCAO[p]||'')+'</li>'}).join('')+'</ul></section>';
  }
  h+='<p class="pvres-nota" id="pvres-nota-ato" role="status"></p>';
  h+='<div class="pvres-proc"><span class="pvres-selo" aria-hidden="true">IA</span>'+
    '<span>Gerado por IA em '+esc(pv().dth(d.criadaEm))+'. Confira nos atos.</span></div>';
  h+='<div class="pvres-aval" role="group" aria-label="Como foi este resumo?"><span class="pvres-rot">Como foi este resumo?</span>'+
    AVALIACOES.map(function(a){
      var on=S.aval===a[0];
      return '<button type="button" class="nov-btn pvres-av'+(on?' on':'')+'" data-pvres="aval" data-aval="'+a[0]+
        '" id="pvres-av-'+a[0]+'" aria-pressed="'+(on?'true':'false')+'">'+a[1]+'</button>';
    }).join('')+
    '<span class="pvres-ok" role="status">'+(S.aval?'✓ Avaliação registrada.':'')+(S.avalErro?esc(S.avalErro):'')+'</span></div>';
  return h;
}

function corpo(){
  var h='<div class="pvres-topo"><h3 class="pvres-tit">Resumo do processo por IA</h3>'+
    (S.fase==='analisando'?'':'<button type="button" class="nov-btn" data-pvres="fechar" id="pvres-fechar">Fechar</button>')+'</div>';
  if(S.fase==='analisando'){
    h+='<p class="pvres-estado"><span class="gira" aria-hidden="true"></span>'+ANALISANDO+'</p>'+
      '<p><button type="button" class="nov-btn" data-pvres="cancelar" id="pvres-cancelar">Cancelar</button></p>';
  }else if(S.fase==='resultado'){
    h+=resultadoHtml(S.dados);
  }else if(S.fase==='nao_verificado'){
    h+='<p class="pvres-estado">'+esc(NAO_VERIFICADO)+'</p>';
  }else if(S.fase==='recusa'){
    h+='<p class="pvres-estado">'+esc(RECUSAS[S.motivo]||ERRO)+'</p>';
  }else{
    h+='<p class="pvres-estado">'+esc(ERRO)+'</p>'+
      '<p><button type="button" class="nov-btn" data-pvres="repetir" id="pvres-repetir">Tentar de novo</button></p>';
  }
  return h+'<p class="pvres-aviso">'+esc(AVISO_FIXO)+'</p>';
}

function painelInterno(){
  return '<div class="pvres" id="pvres-painel" role="region" aria-label="Resumo do processo por IA" tabindex="-1" aria-busy="'+
    (S.fase==='analisando'?'true':'false')+'">'+corpo()+'</div>';
}

function marcarBotao(){
  var b=document.getElementById('pvres-abrir');
  if(b)b.setAttribute('aria-expanded',S?'true':'false');
}

/* O painel mora numa raiz logo depois da capa; a raiz só é trocada quando a tela é redesenhada. */
function montarRaiz(){
  var capa=document.querySelector('#conteudo .capa');
  if(!capa||!S)return false;
  var raiz=document.getElementById('pvres-raiz');
  if(!raiz){
    raiz=document.createElement('div');
    raiz.id='pvres-raiz';
    raiz.innerHTML='<div id="pvres-corpo"></div>';
    capa.insertAdjacentElement('afterend',raiz);
  }
  document.getElementById('pvres-corpo').innerHTML=painelInterno();
  marcarBotao();
  return true;
}

function refrescar(anuncio,foco){
  var corpoEl=document.getElementById('pvres-corpo');
  if(!corpoEl){marcarBotao();return}
  var painel=document.getElementById('pvres-painel');
  var tinhaFoco=painel&&painel.contains(document.activeElement);
  corpoEl.innerHTML=painelInterno();
  var alvo=foco?document.getElementById(foco):null;
  if(!alvo&&tinhaFoco)alvo=document.getElementById('pvres-painel');
  if(alvo)alvo.focus();
  if(anuncio)anunciar(anuncio);
}

function remover(){
  var raiz=document.getElementById('pvres-raiz');
  if(raiz&&raiz.parentNode)raiz.parentNode.removeChild(raiz);
}

/* ---------- chamadas ---------- */
function iniciar(){
  var e=S;
  var ctrl=typeof AbortController!=='undefined'?new AbortController():null;
  e.ctrl=ctrl;e.fase='analisando';e.dados=null;e.aval='';e.avalErro='';e.motivo='';
  fetch('/v1/acompanhamentos/'+encodeURIComponent(e.numero)+'/resumo',{method:'POST',headers:cabecalhosSemCorpo(),
    signal:ctrl?ctrl.signal:undefined})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(b){return {ok:r.ok,status:r.status,b:b}})})
    .then(function(x){
      if(S!==e)return;
      e.ctrl=null;
      if(x.ok&&x.b.estado==='verificado'){e.fase='resultado';e.dados=x.b;refrescar('Resumo concluído. Confira nos atos.');return}
      if(x.ok&&x.b.estado==='nao_verificado'){e.fase='nao_verificado';refrescar(NAO_VERIFICADO);return}
      var motivo=x.b&&x.b.detalhes?x.b.detalhes.motivo:'';
      if(!x.ok&&motivo&&RECUSAS[motivo]){e.fase='recusa';e.motivo=motivo;refrescar(RECUSAS[motivo]);return}
      if(!x.ok&&x.status===404){e.fase='recusa';e.motivo='nao_acompanhado';refrescar(RECUSAS.nao_acompanhado);return}
      e.fase='erro';refrescar(ERRO);
    })
    .catch(function(err){
      if(S!==e)return;
      if(err&&err.name==='AbortError')return;
      e.ctrl=null;e.fase='erro';refrescar(ERRO);
    });
}

function avaliar(valor){
  var e=S;
  if(!e||!e.dados||e.ocupadoAval)return;
  e.ocupadoAval=true;e.avalErro='';
  fetch('/v1/resumos/'+encodeURIComponent(e.dados.id)+'/avaliacao',{method:'POST',headers:cabecalhosJson(),
    body:JSON.stringify({avaliacao:valor})})
    .then(function(r){
      e.ocupadoAval=false;
      if(S!==e)return;
      if(r.ok){e.aval=valor;refrescar('Avaliação registrada.','pvres-av-'+valor)}
      else{e.avalErro='Não foi possível registrar. Tente de novo.';refrescar(e.avalErro,'pvres-av-'+valor)}
    },function(){
      e.ocupadoAval=false;
      if(S!==e)return;
      e.avalErro='Não foi possível registrar. Tente de novo.';refrescar(e.avalErro,'pvres-av-'+valor);
    });
}

/* ---------- abrir, fechar, sair ---------- */
function descartar(){
  if(S&&S.ctrl){try{S.ctrl.abort()}catch(x){}}
  S=null;
  remover();
  marcarBotao();
}

function fechar(anuncio){
  descartar();
  var b=document.getElementById('pvres-abrir');
  if(b)b.focus();
  if(anuncio)anunciar(anuncio);
}

function abrirResumo(numero){
  if(S){fechar('');return}
  S={numero:digitos(numero),fase:'analisando',ctrl:null,dados:null,aval:'',avalErro:'',motivo:'',ocupadoAval:false};
  montarRaiz();
  iniciar();
  refrescar('Resumindo o processo. Isso pode levar até 2 minutos.','pvres-painel');
}

/* Leva à linha do tempo: o andamento com a mesma data e o mesmo rótulo. Se ele não estiver na
   tela (recolhido entre os internos ou num filtro), a tela diz isso em vez de rolar para lugar nenhum. */
function irAoAto(quando,rotulo){
  var alvo=null,candidatos=document.querySelectorAll('#conteudo .ev[data-quando]');
  var t=new Date(quando).getTime();
  for(var i=0;i<candidatos.length;i++){
    var c=candidatos[i];
    if(new Date(c.getAttribute('data-quando')).getTime()!==t)continue;
    var tt=c.querySelector('.tt');
    if(!alvo)alvo=c;
    if(tt&&tt.textContent.trim().indexOf(rotulo)===0){alvo=c;break}
  }
  var nota=document.getElementById('pvres-nota-ato');
  if(!alvo){
    var msg='O ato “'+rotulo+'” de '+pv().dt(quando)+' não está visível na linha do tempo — pode estar recolhido entre os internos ou num filtro.';
    if(nota)nota.textContent=msg;
    return;
  }
  if(nota)nota.textContent='';
  alvo.classList.add('pvres-alvo');alvo.setAttribute('tabindex','-1');
  alvo.scrollIntoView({block:'center'});alvo.focus();
  alvo.addEventListener('blur',function(){alvo.classList.remove('pvres-alvo')},{once:true});
}

/* ---------- ganchos do console ---------- */
function aposDesenhar(numero,acompanhado){
  var n=digitos(numero);
  /* Outro processo: o resumo do anterior não acompanha (e não há "reabrir"). */
  if(S&&S.numero!==n)descartar();
  if(!acompanhado)return;
  var ia=window.__pvAnaliseIA;
  if(!ia)return;
  ia.carregar().then(function(ligada){
    if(!ligada)return;
    var capa=document.querySelector('#conteudo .capa'),parar=document.getElementById('parar');
    var num=capa?capa.querySelector('.num'):null;
    if(!capa||!parar||!num||digitos(num.textContent)!==n)return;
    if(document.getElementById('pvres-abrir'))return;
    var b=document.createElement('button');
    b.type='button';b.className='bt bt2 pvres-btn';b.id='pvres-abrir';
    b.setAttribute('aria-controls','pvres-painel');b.setAttribute('aria-expanded','false');
    b.title='Gera um resumo do processo por IA. Apoio à leitura: confira sempre nos atos.';
    b.textContent='Resumir este processo com IA';
    parar.insertAdjacentElement('afterend',b);
    b.addEventListener('click',function(){abrirResumo(n)});
    /* A tela foi redesenhada (régua carregada) com o resumo já em curso: devolve o painel. */
    if(S&&S.numero===n){montarRaiz()}
  });
}
function sair(){if(S||document.getElementById('pvres-raiz'))descartar()}

document.addEventListener('click',function(ev){
  var el=ev.target&&ev.target.closest?ev.target.closest('[data-pvres]'):null;
  if(!el||!S)return;
  var acao=el.getAttribute('data-pvres');
  if(acao==='fechar'){fechar('');return}
  if(acao==='cancelar'){fechar('Resumo cancelado.');return}
  if(acao==='repetir'){iniciar();refrescar('Resumindo o processo. Isso pode levar até 2 minutos.','pvres-painel');return}
  if(acao==='aval'){avaliar(el.getAttribute('data-aval'));return}
  if(acao==='ato'){irAoAto(el.getAttribute('data-quando'),el.getAttribute('data-rotulo'));return}
});

/* Esc fecha o painel em que o foco está (e cancela, se estiver resumindo). */
document.addEventListener('keydown',function(ev){
  if(ev.key!=='Escape'||!S)return;
  var p=ev.target&&ev.target.closest?ev.target.closest('#pvres-painel'):null;
  if(!p)return;
  ev.preventDefault();
  fechar(S.fase==='analisando'?'Resumo cancelado.':'');
});

window.__pvResumoIA={aposDesenhar:aposDesenhar,sair:sair};
})();
`;

export const ESTILOS_RESUMO_IA = `
.pvres-btn[aria-expanded="true"]{background:var(--acento-bg);border-color:var(--acento)}
.pvres-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
#pvres-raiz{margin:0 0 14px}
.pvres{min-width:0;max-width:100%;background:var(--papel2);border:1px solid var(--linha);border-left:4px solid var(--acento);
  border-radius:var(--r);padding:14px 16px;color:var(--tinta);overflow-wrap:anywhere;font-size:13.5px;line-height:1.5}
.pvres:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.pvres-topo{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.pvres-tit{margin:0;font-size:15px;font-weight:700}
.pvres-estado{margin:6px 0;display:flex;align-items:flex-start;gap:8px}
.pvres-sec{margin:12px 0}
.pvres-rot{display:block;margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--tinta2)}
.pvres-itens{margin:0;padding:0;list-style:none}
.pvres-itens>li{margin:0 0 12px;padding:0 0 10px;border-bottom:1px solid var(--linha)}
.pvres-itens>li:last-child{border-bottom:0;margin-bottom:0}
.pvres-itens-simples{margin:0;padding-left:18px}
.pvres-texto{margin:0 0 4px;font-weight:600}
.pvres-ato{margin:0 0 4px;color:var(--tinta2);font-size:12.5px}
.pvres-ato .link{font-size:12.5px;text-align:left;overflow-wrap:anywhere}
.pvres-cit{margin:4px 0 0;padding:6px 10px;border-left:3px solid var(--linha);background:var(--papel);color:var(--tinta2);font-style:italic}
.pvres-cit mark{background:var(--atencao-bg);color:var(--tinta);padding:0 2px;border-radius:3px;font-style:normal}
.pvres-nota{margin:0 0 6px;font-size:12.5px;color:var(--tinta2)}
.pvres-vazio{margin:0;color:var(--tinta2)}
.pvres-contagens{margin:0;padding-left:18px}
.pvres-contagens li{margin:0 0 4px}
.pvres-proc{display:flex;align-items:flex-start;gap:8px;margin:10px 0 6px;font-size:12.5px;color:var(--tinta2)}
.pvres-selo{flex:none;display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;
  background:var(--acento-bg);color:var(--acento);border:1px solid var(--acento)}
.pvres-aval{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:8px}
.pvres-aval .pvres-rot{margin:0 4px 0 0}
.pvres-av.on{background:var(--acento-bg);color:var(--acento);border-color:var(--acento);box-shadow:inset 0 0 0 1px var(--acento)}
.pvres-ok{font-size:12.5px;color:var(--verde-tinta);font-weight:700}
.pvres-aviso{margin:10px 0 0;font-size:12.5px;color:var(--tinta2)}
.pvres button:focus-visible,.pvres-btn:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.ev.pvres-alvo{outline:2px solid var(--acento);outline-offset:3px;border-radius:var(--r)}
@media (max-width:1023px){
  .pvres-btn,.pvres .nov-btn{min-height:44px}
}
`;
